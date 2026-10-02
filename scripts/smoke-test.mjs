/**
 * dsh-qoduck-pet 冒烟测试（无浏览器、无 DSH 运行时、不启动窗口进程）。
 *
 * 覆盖：
 *   1. 宿主半部：配置收敛/落盘、状态机全分支、作用域订阅形状、路由与进程托管。
 *   2. pet.ps1：UTF-8 BOM、DPI/坐标口径、注视静止回落/相位白名单/圆形范围。
 *   3. 帧表：manifest 完整性、引用文件存在、表尺寸自洽。
 *   4. 浏览器半部：插件契约、locale 字典齐备、**没有**任何页内浮层/DOM 直写。
 *
 * 用法：node scripts/smoke-test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + name + '\n       ' + (error && error.message))
  }
}

/**
 * 提取源码中的 ctx.on(...) 调用。这里不用脆弱的跨行正则：waterfall 处理器可能是
 * 多行箭头函数，options 也可能放在第三参数；按括号配对取完整调用后再检查即可。
 */
function findCtxOnCalls(source) {
  const calls = []
  const starts = source.matchAll(/ctx\.on\s*\(\s*(['"])([^'"]+)\1/g)
  for (const match of starts) {
    const open = source.indexOf('(', match.index)
    let depth = 0
    let quote = ''
    let escaped = false
    let lineComment = false
    let blockComment = false

    for (let i = open; i < source.length; i += 1) {
      const char = source[i]
      const next = source[i + 1]
      if (lineComment) {
        if (char === '\n') lineComment = false
        continue
      }
      if (blockComment) {
        if (char === '*' && next === '/') { blockComment = false; i += 1 }
        continue
      }
      if (quote) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = ''
        continue
      }
      if (char === '/' && next === '/') { lineComment = true; i += 1; continue }
      if (char === '/' && next === '*') { blockComment = true; i += 1; continue }
      if (char === "'" || char === '"' || char === '`') { quote = char; continue }
      if (char === '(') depth += 1
      if (char === ')' && --depth === 0) {
        calls.push({ event: match[2], source: source.slice(match.index, i + 1) })
        break
      }
    }
  }
  return calls
}

// ============================================================
// 1. 宿主半部
// ============================================================

console.log('\n宿主半部')

const host = await import(new URL('../lib/index.js', import.meta.url).href)
const sandbox = mkdtempSync(join(tmpdir(), 'qoduck-test-'))
const env = { DSH_HOME: sandbox }

function makeCtx(registered, events) {
  return {
    webServer: { register: (route) => { registered.push(route); return () => {} } },
    on: (eventName) => { events.push(eventName); return () => {} },
    effect: (fn) => fn(),
  }
}

test('插件契约：name / inject / apply', () => {
  assert.equal(host.name, 'qoduck-pet')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

test('默认配置形状正确', () => {
  const config = host.normalizeConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.size, 84)
  assert.equal(config.pin, 'bottom-right')
  assert.equal(config.mouseTracking, true)
})

test('非法字段被收敛而不是抛错', () => {
  const config = host.normalizeConfig({ enabled: 'yes', size: 99999, pin: 'middle', mouseTracking: 1 })
  assert.equal(config.enabled, true)
  assert.equal(config.size, 384)
  assert.equal(config.pin, 'bottom-right')
  assert.equal(config.mouseTracking, true)
})

test('尺寸被夹到 48–384', () => {
  assert.equal(host.normalizeConfig({ size: 1 }).size, 48)
  assert.equal(host.normalizeConfig({ size: 9999 }).size, 384)
})

test('配置落盘往返', () => {
  host.saveConfig(host.normalizeConfig({ size: 200, pin: 'top-left' }), env)
  assert.ok(existsSync(host.configPath(env)))
  const read = host.loadConfig(env)
  assert.equal(read.size, 200)
  assert.equal(read.pin, 'top-left')
})

test('损坏的 config.json 退回默认值', () => {
  writeFileSync(host.configPath(env), '{ 不是 json', 'utf8')
  assert.equal(host.loadConfig(env).size, 84)
})

test('状态机：无输入 → idle', () => {
  assert.equal(host.derivePhase(null), 'idle')
  assert.equal(host.derivePhase({}), 'idle')
})

test('状态机：failed 保持 6000ms，且优先于 interrupted / waiting / running', () => {
  const now = 100000
  assert.equal(host.derivePhase({
    failedAt: now - (host.FAILED_HOLD_MS - 1),
    interruptedAt: now - 100,
    waiting: 2,
    runningTools: 3,
    runningAgents: 1,
    lastActivityAt: now,
  }, now), 'failed')
  assert.equal(
    host.derivePhase({ failedAt: now - host.FAILED_HOLD_MS }, now),
    'idle',
    'failed 保持窗到期后应回落',
  )
})

test('状态机：等待用户优先于工具与 Agent 运行', () => {
  assert.equal(host.derivePhase({ waiting: 1, runningAgents: 1, runningTools: 1 }), 'waiting')
})

test('状态机：工具执行中 → running', () => {
  assert.equal(host.derivePhase({ runningTools: 1, runningAgents: 1 }), 'running')
})

test('状态机：Agent 运行且未静默 5000ms → running', () => {
  const now = 100000
  assert.equal(host.derivePhase({ runningAgents: 1, lastActivityAt: now - 4999 }, now), 'running')
})

test('状态机：Agent 运行但已静默超过 5000ms → 回落', () => {
  const now = 100000
  // 纯文本收尾那一轮常常没有 agent/status idle 把 runningAgents 摘掉，
  // 靠 lastActivityAt 的静默窗口把姿态收回来。
  assert.equal(host.derivePhase({ runningAgents: 1, lastActivityAt: now - 5001 }, now), 'idle')
  assert.equal(host.derivePhase({ runningAgents: 1 }, now), 'idle', '没有活动时间的老状态也应回落')
})

test('状态机：运行集合按 size 计数（回归：Set > 0 恒为 false）', () => {
  const now = 100000
  assert.equal(
    host.derivePhase({ runningTools: new Set(['tool-1']) }, now),
    'running',
    'runningTools 在运行时是 Set，必须读取 size',
  )
  assert.equal(
    host.derivePhase({ runningAgents: new Set(['agent-1']), lastActivityAt: now }, now),
    'running',
    'runningAgents 在运行时是 Set，必须读取 size',
  )
  assert.equal(
    host.derivePhase({ runningTools: new Set(), runningAgents: new Set(), lastActivityAt: now }, now),
    'idle',
    '空 Set 不应误判为 running',
  )
})

test('状态机：回合结束保持 review 4000ms', () => {
  const now = 100000
  assert.equal(host.derivePhase({ lastTurnEndAt: now - (host.REVIEW_HOLD_MS - 1) }, now), 'review')
  assert.equal(host.derivePhase({ lastTurnEndAt: now - host.REVIEW_HOLD_MS }, now), 'idle')
})

test('状态机：interrupted 有保持窗，且优先于 waiting / running', () => {
  const now = 100000
  assert.equal(host.derivePhase({ interruptedAt: now - 100 }, now), 'interrupted')
  assert.equal(host.derivePhase({ interruptedAt: now - host.FAILED_HOLD_MS }, now), 'idle')
  assert.equal(host.derivePhase({
    interruptedAt: now - 100,
    waiting: 1,
    runningAgents: 1,
    runningTools: 1,
    lastActivityAt: now,
  }, now), 'interrupted')
})

test('turn/end 解析：八种 reason 更新正确的时间戳', () => {
  const base = () => ({
    runningAgents: new Set(['agent-1']),
    runningTools: new Set(['tool-1']),
    waiting: 2,
    failedAt: 0,
    interruptedAt: 0,
    lastTurnEndAt: 0,
  })
  const now = 1000
  const end = (reason) => ({ type: 'turn/end', data: { turn: 1, reason } })
  const cases = [
    ['completed', { kind: 'completed' }, 'lastTurnEndAt'],
    ['error', { kind: 'error', error: { message: 'x' } }, 'failedAt'],
    ['aborted(user)', { kind: 'aborted', reason: { kind: 'user' } }, 'interruptedAt'],
    ['aborted(parent)', { kind: 'aborted', reason: { kind: 'parent' } }, 'lastTurnEndAt'],
    ['interrupted', { kind: 'interrupted' }, 'interruptedAt'],
    ['blocked', { kind: 'blocked' }, 'lastTurnEndAt'],
    ['max-tokens', { kind: 'max-tokens' }, 'lastTurnEndAt'],
    ['forked', { kind: 'forked' }, 'lastTurnEndAt'],
  ]

  for (const [label, reason, changedField] of cases) {
    const counters = base()
    assert.equal(host.applySessionEvent(counters, end(reason), now), true, label + ' 应返回 true')
    for (const field of ['failedAt', 'interruptedAt', 'lastTurnEndAt']) {
      assert.equal(counters[field], field === changedField ? now : 0, `${label} 不应误写 ${field}`)
    }
    assert.deepEqual([...counters.runningAgents], ['agent-1'], label + ' 不应改 Agent 集合')
    assert.deepEqual([...counters.runningTools], ['tool-1'], label + ' 不应改工具集合')
    assert.equal(counters.waiting, 2, label + ' 不应改等待计数')
  }
})

test('turn/end 解析：非 turn/end 事件返回 false 且完全不改状态', () => {
  const counters = {
    runningAgents: new Set(['agent-1']),
    runningTools: new Set(['tool-1']),
    waiting: 2,
    failedAt: 11,
    interruptedAt: 22,
    lastTurnEndAt: 33,
  }
  const before = {
    ...counters,
    runningAgents: new Set(counters.runningAgents),
    runningTools: new Set(counters.runningTools),
  }
  assert.equal(host.applySessionEvent(counters, { type: 'step/start', data: {} }, 1000), false)
  assert.deepEqual(counters, before, 'step/start 不应改任一状态字段')
  assert.equal(host.applySessionEvent(counters, null, 1000), false)
  assert.deepEqual(counters, before, 'null 不应改任一状态字段')
})

test('会话事件识别：认得出真事件，不误认 scoped 上下文或 payload', () => {
  assert.equal(host.isSessionEvent({ type: 'turn/end', seq: 3, time: 1, data: { turn: 1 } }), true)
  assert.equal(host.isSessionEvent({ type: 'turn/end' }), false, '缺 data 不算事件')
  assert.equal(host.isSessionEvent(null), false)
  assert.equal(host.isSessionEvent({ agent: {}, status: 'running' }), false, 'agent/status 的 payload 不该被误认')
})

test('窗口进程以无控制台方式启动（任务栏不应出现 Windows PowerShell）', () => {
  const source = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.ok(source.includes('windowsHide: true'), 'spawn 必须设 windowsHide（CREATE_NO_WINDOW）')
  assert.ok(source.includes("'-WindowStyle', 'Hidden'"), '应再带 -WindowStyle Hidden 兜底')
})

test('apply 注册三条路由并订阅状态机所需事件', () => {
  host.saveConfig(host.normalizeConfig({ enabled: false }), env)
  const registered = []
  const events = []
  host.apply(makeCtx(registered, events), { env })
  const paths = registered.map((route) => route.path).sort()
  assert.deepEqual(paths, ['/api/qoduck-pet/config', '/api/qoduck-pet/state', '/qoduck-pet/assets'])
  assert.equal(registered.find((r) => r.path === '/qoduck-pet/assets').kind, 'prefix')
  assert.equal(registered.find((r) => r.path === '/api/qoduck-pet/state').kind, 'exact')
  for (const required of ['agent/status', 'agent/error', 'tools/execute', 'approval/request', 'user-questions/request']) {
    assert.ok(events.includes(required), '缺少事件订阅 ' + required)
  }
})

test('作用域事件订阅全部显式启用 global', () => {
  const source = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const calls = findCtxOnCalls(source)
  const scopedEvents = [
    'agent/status',
    'tools/execute',
    'approval/request',
    'user-questions/request',
    'agent/error',
    'agent/disposed',
    'agent/turn-stopping',
    'agent/assistant-stream',
  ]
  const problems = []

  for (const event of scopedEvents) {
    const matches = calls.filter((call) => call.event === event)
    if (matches.length === 0) {
      problems.push(`${event}：找不到 ctx.on('${event}', ...) 调用`)
      continue
    }
    for (const call of matches) {
      if (!/\bglobal\s*:\s*true\b/.test(call.source)) {
        const excerpt = call.source.replace(/\s+/g, ' ').slice(0, 180)
        problems.push(`${event}：ctx.on 调用未传 { global: true }；片段：${excerpt}`)
      }
    }
  }

  if (problems.length > 0) {
    throw new Error('以下作用域事件订阅缺少显式 { global: true }：\n- ' + problems.join('\n- '))
  }
})

test('enabled=false 时状态接口报告窗口进程未运行', async () => {
  host.saveConfig(host.normalizeConfig({ enabled: false }), env)
  const registered = []
  host.apply(makeCtx(registered, []), { env })
  const state = registered.find((r) => r.path === '/api/qoduck-pet/state')
  const payload = await new Promise((resolve) => {
    const res = { writeHead() {}, end(chunk) { resolve(JSON.parse(chunk.toString())) } }
    state.handler({ method: 'GET', on() {} }, res)
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.running, false, '关闭时不应有窗口进程')
  assert.equal(payload.config.enabled, false)
})

test('素材路由：正常文件 200，路径穿越 404', async () => {
  const registered = []
  host.apply(makeCtx(registered, []), { env })
  const asset = registered.find((route) => route.path === '/qoduck-pet/assets')

  function call(url) {
    return new Promise((resolve) => {
      const chunks = []
      const res = {
        statusCode: 0,
        headers: null,
        writeHead(status, headers) { this.statusCode = status; this.headers = headers },
        end(chunk) {
          if (chunk) chunks.push(Buffer.from(chunk))
          resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) })
        },
        destroy() { resolve({ status: this.statusCode }) },
      }
      const req = { method: 'GET', url, on() {}, destroy() {} }
      Promise.resolve(asset.handler(req, res)).catch(() => resolve({ status: 500 }))
    })
  }

  const good = await call('/qoduck-pet/assets/idle.webp')
  assert.equal(good.status, 200, 'idle.webp 应可读')
  assert.equal(good.headers['content-type'], 'image/webp')

  for (const bad of ['/qoduck-pet/assets/..%2F..%2Fpackage.json', '/qoduck-pet/assets/nope.webp', '/qoduck-pet/assets/']) {
    const res = await call(bad)
    assert.equal(res.status, 404, bad + ' 应 404')
  }
})

test('配置路由：POST 合并而不是整体覆盖', async () => {
  host.saveConfig(host.normalizeConfig({ enabled: false, size: 160, mouseTracking: true }), env)
  const registered = []
  host.apply(makeCtx(registered, []), { env })
  const route = registered.find((r) => r.path === '/api/qoduck-pet/config')

  await new Promise((resolve) => {
    const handlers = {}
    const res = { writeHead() {}, end() { resolve() } }
    const req = { method: 'POST', on(event, cb) { handlers[event] = cb }, destroy() {} }
    route.handler(req, res)
    handlers.data(Buffer.from(JSON.stringify({ mouseTracking: false })))
    handlers.end()
  })

  const after = host.loadConfig(env)
  assert.equal(after.mouseTracking, false, '提交的字段应生效')
  assert.equal(after.size, 160, '未提交的字段应保留')
  assert.equal(after.enabled, false, '未提交的字段应保留')
})

// ============================================================
// 2. 活动卡片
// ============================================================

console.log('\n活动卡片')

const activity = await import(new URL('../lib/activity.js', import.meta.url).href)

test('describeTool：取参数里最像「在干什么」的字段', () => {
  assert.equal(activity.describeTool('WebSearch', '{"query":"今天的AI新闻"}'), 'WebSearch. 今天的AI新闻')
  assert.equal(activity.describeTool('Bash', '{"command":"pnpm test"}'), 'Bash. pnpm test')
  assert.equal(activity.describeTool('Read', '{"file_path":"C:/a/b.ts"}'), 'Read. C:/a/b.ts')
  assert.equal(activity.describeTool('Grep', '{"pattern":"TODO","path":"src"}'), 'Grep. TODO')
})

test('describeTool：参数不可解析时退回工具名，不抛错', () => {
  assert.equal(activity.describeTool('WebFetch', ''), 'WebFetch')
  assert.equal(activity.describeTool('WebFetch', '{"url":"htt'), 'WebFetch')
  assert.equal(activity.describeTool('WebFetch', '[1,2,3]'), 'WebFetch')
  assert.equal(activity.describeTool('', ''), '工具')
  assert.equal(activity.describeTool(undefined, undefined), '工具')
})

test('describeTool：长参数被截断且不超过上限', () => {
  const long = 'x'.repeat(500)
  const out = activity.describeTool('WebFetch', JSON.stringify({ prompt: long }))
  assert.ok(out.length <= activity.DETAIL_MAX_CHARS, '实际 ' + out.length)
  assert.ok(out.endsWith('…'), '应以省略号结尾')
})

// ---- 对话活动摘要（宿主侧移植 DSH 客户端的算法）----
const summary = await import(new URL('../lib/step-summary.js', import.meta.url).href)

test('toolKind：工具名到类别的映射与 DSH 客户端逐条一致', () => {
  const cases = {
    read: 'read',
    read_image: 'readImage',
    grep: 'search',
    glob: 'search',
    write: 'write',
    edit: 'edit',
    apply_patch: 'edit',
    bash: 'commands',
    pwsh: 'commands',
    exec_command: 'commands',
    write_stdin: 'commands',
    terminal_open: 'commands',
    run_code: 'code',
    web_search: 'webSearch',
    web_fetch: 'webFetch',
    subagent: 'subagents',
    subagent_fork: 'subagents',
    todo_write: 'plan',
    create_goal: 'plan',
    update_goal: 'plan',
    get_goal: 'plan',
    ask_user_question: 'questions',
    request_user_input: 'questions',
    cordis_inspect_query: 'tools',
    '': 'tools',
  }
  for (const [name, kind] of Object.entries(cases)) {
    assert.equal(summary.toolKind(name), kind, name)
  }
})

test('processTitle：没有工具时退回「已完成分析」', () => {
  assert.equal(summary.processTitle([]), '已完成分析')
})

test('processTitle：单一类别直出', () => {
  assert.equal(summary.processTitle([{ kind: 'read', count: 3 }]), '已读取文件')
  assert.equal(summary.processTitle([{ kind: 'thinking', count: 1 }]), '已完成分析')
})

test('processTitle：两类用「并」，两边都以「已」开头时省掉第二个的前缀', () => {
  // 原版实测文案
  assert.equal(
    summary.processTitle([{ kind: 'commands', count: 2 }, { kind: 'readImage', count: 1 }]),
    '执行了命令并已读取图片',
  )
  // 「已读取文件」和「已读取图片」都以「已」开头 → 第二个省掉前缀
  assert.equal(
    summary.processTitle([{ kind: 'read', count: 2 }, { kind: 'readImage', count: 1 }]),
    '已读取文件并读取图片',
  )
})

test('processTitle：三类用逗号连接，类别总数超过三时补「等」', () => {
  // 原版实测文案
  assert.equal(
    summary.processTitle([
      { kind: 'edit', count: 2 },
      { kind: 'read', count: 2 },
      { kind: 'commands', count: 1 },
      { kind: 'tools', count: 1 },
    ]),
    '修改了文件，已读取文件，执行了命令等',
  )
  // 正好三类 → 不加「等」
  assert.equal(
    summary.processTitle([
      { kind: 'edit', count: 2 },
      { kind: 'read', count: 1 },
      { kind: 'commands', count: 1 },
    ]),
    '修改了文件，已读取文件，执行了命令',
  )
})

test('rankCounts：次数降序，同次数先出现者在前', () => {
  const counts = new Map([['read', 1], ['edit', 2], ['commands', 2]])
  const firstSeen = new Map([['read', 0], ['edit', 1], ['commands', 2]])
  const ranked = summary.rankCounts(counts, firstSeen).map((entry) => entry.kind)
  assert.deepEqual(ranked, ['edit', 'commands', 'read'])
})

test('liveToolDetail：按固定优先级取参数，取不到退回工具名', () => {
  assert.equal(summary.liveToolDetail('read', '{"file_path":"C:/a/b.ts"}'), 'C:/a/b.ts')
  assert.equal(summary.liveToolDetail('grep', '{"pattern":"TODO","path":"src"}'), 'TODO')
  assert.equal(summary.liveToolDetail('bash', '{"command":"pnpm test"}'), 'pnpm test')
  assert.equal(summary.liveToolDetail('read', ''), 'read')
  assert.equal(summary.liveToolDetail('read', '{"file_path":"htt'), 'read')
})

test('normalizeDetail：折叠空白并按 160 字素截断', () => {
  assert.equal(summary.normalizeDetail('  a\n\n b  '), 'a b')
  const long = '字'.repeat(300)
  const out = summary.normalizeDetail(long)
  assert.equal(Array.from(out).length, summary.DETAIL_MAX_CHARS)
  assert.ok(out.endsWith('…'))
})

test('StepTracker：有工具在跑时第二行说清「在干什么」', () => {
  const tracker = new summary.StepTracker()
  tracker.noteToolCall('bash', '{"command":"pnpm test"}')
  const snap = tracker.snapshot()
  assert.equal(snap.detail, '运行 pnpm test')
  assert.equal(snap.icon, 'api')
  assert.equal(snap.running, true)
  assert.equal(snap.runningDetail, 'pnpm test')
})

test('StepTracker：各类别都给出动作词而不是聚合摘要', () => {
  const cases = [
    ['read', '{"file_path":"lib/pet.ps1"}', '读取 lib/pet.ps1'],
    ['grep', '{"pattern":"TODO","path":"src"}', '搜索 TODO'],
    ['edit', '{"file_path":"a.ts"}', '编辑 a.ts'],
    ['web_search', '{"query":"今天的AI新闻"}', '搜索网页 今天的AI新闻'],
    ['web_fetch', '{"url":"https://example.com"}', '访问网页 https://example.com'],
  ]
  for (const [name, args, expected] of cases) {
    const tracker = new summary.StepTracker()
    tracker.noteToolCall(name, args)
    assert.equal(tracker.snapshot().detail, expected, name)
  }
})

test('StepTracker：没有工具在跑时第二行是实时推理末段', () => {
  const tracker = new summary.StepTracker()
  tracker.appendReasoning('先查一下 asar 的偏移量。\n\n然后**写**解析器。')
  const snap = tracker.snapshot()
  assert.equal(snap.detail, '然后写解析器。', 'markdown 标记应被去掉')
  assert.equal(snap.icon, 'think')
  assert.equal(snap.running, false)
})

test('StepTracker：没有实时文本时退回聚合摘要', () => {
  const tracker = new summary.StepTracker()
  tracker.noteToolCall('edit', '{"file_path":"a.ts"}')
  tracker.noteToolCall('read', '{"file_path":"b.ts"}')
  tracker.clearRunning()
  const snap = tracker.snapshot()
  // 两类且首个不带「已」→ 不省前缀
  assert.equal(snap.detail, '修改了文件并已读取文件')
  assert.equal(snap.summary, '修改了文件并已读取文件')

  tracker.reset()
  assert.equal(tracker.snapshot().detail, '已完成分析')
})

test('StepTracker：工具一开跑就丢掉上一段推理（它不再是在发生的事）', () => {
  const tracker = new summary.StepTracker()
  tracker.appendReasoning('我要跑一下测试。')
  assert.equal(tracker.snapshot().detail, '我要跑一下测试。')
  tracker.noteToolCall('bash', '{"command":"pnpm test"}')
  assert.equal(tracker.snapshot().detail, '运行 pnpm test')
})

test('StepTracker：tool/result 清掉「正在跑」但保留计数', () => {
  const tracker = new summary.StepTracker()
  tracker.noteToolCall('web_search', '{"query":"今天的AI新闻"}')
  assert.equal(tracker.snapshot().running, true)
  tracker.clearRunning()
  assert.equal(tracker.snapshot().running, false)
  assert.equal(tracker.snapshot().detail, '已搜索网页')
})

test('StepTracker：推理缓冲有上限，长回合不会无限膨胀', () => {
  const tracker = new summary.StepTracker()
  for (let i = 0; i < 200; i += 1) tracker.appendReasoning('x'.repeat(100))
  assert.ok(Array.from(tracker.reasoning).length <= 4000, '实际 ' + Array.from(tracker.reasoning).length)
})

test('assistantTextOf：正文从 message.content 与流记录里都能取到', () => {
  assert.equal(
    summary.assistantTextOf({
      data: { message: { content: [{ type: 'text', text: '你好' }, { type: 'reasoning', text: '略' }] } },
    }),
    '你好',
  )
  assert.equal(
    summary.assistantTextOf({ data: { stream: [{ type: 'text-chunks', texts: ['甲', '乙'] }] } }),
    '甲乙',
  )
  assert.equal(summary.assistantTextOf({ data: {} }), '')
})

test('PROCESS_ICONS：14 个类别都有图标', () => {
  const kinds = ['thinking', 'read', 'readImage', 'write', 'search', 'edit', 'commands',
    'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']
  for (const kind of kinds) assert.ok(summary.PROCESS_ICONS[kind], kind)
})

test('statusFromTurnEnd：七种 reason 全部有明确归属', () => {
  assert.equal(activity.statusFromTurnEnd({ kind: 'completed' }), 'completed')
  assert.equal(activity.statusFromTurnEnd({ kind: 'error', error: {} }), 'failed')
  assert.equal(activity.statusFromTurnEnd({ kind: 'interrupted' }), 'interrupted')
  assert.equal(activity.statusFromTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), 'interrupted')
  // 会话生命周期不算失败
  for (const cause of ['parent', 'disposed', 'hook']) {
    assert.equal(activity.statusFromTurnEnd({ kind: 'aborted', reason: { kind: cause } }), 'completed', cause)
  }
  assert.equal(activity.statusFromTurnEnd({ kind: 'max-tokens' }), 'completed')
  assert.equal(activity.statusFromTurnEnd({ kind: 'blocked' }), 'completed')
  assert.equal(activity.statusFromTurnEnd({ kind: 'forked' }), 'completed')
  assert.equal(activity.statusFromTurnEnd({ kind: 'unknown-thing' }), null)
})

test('ActivityBoard：工具调用与回合结束驱动状态', () => {
  const board = new activity.ActivityBoard({ readTitle: () => ({ title: '总结今天的AI新闻' }) })
  board.touch('s1', { id: 's1' })
  board.setRunning('s1', true)

  board.noteEvent('s1', { type: 'tool/call', data: { name: 'WebSearch', arguments: '{"query":"今天的AI新闻"}' } })
  let snap = board.snapshot()
  assert.equal(snap.items.length, 1)
  assert.equal(snap.items[0].title, '总结今天的AI新闻')
  assert.equal(snap.items[0].status, 'running')
  assert.equal(snap.items[0].detail, 'WebSearch. 今天的AI新闻')
  assert.equal(snap.items[0].canStop, true)

  board.noteEvent('s1', { type: 'tool/result', data: {} })
  board.noteEvent('s1', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  board.setRunning('s1', false)
  snap = board.snapshot()
  assert.equal(snap.items[0].status, 'completed')
  assert.equal(snap.items[0].detail, '')
  assert.equal(snap.items[0].canStop, false)
})

test('ActivityBoard：等待审批显示 waiting，决定后回落', () => {
  const board = new activity.ActivityBoard()
  board.touch('s2', null)
  board.noteEvent('s2', { type: 'approval/asked', data: {} })
  assert.equal(board.snapshot().items[0].status, 'waiting')

  board.setRunning('s2', true)
  board.noteEvent('s2', { type: 'approval/decided', data: {} })
  assert.equal(board.snapshot().items[0].status, 'running')
})

test('ActivityBoard：快照按活跃度倒序，且不超过上限', () => {
  const board = new activity.ActivityBoard()
  for (let i = 0; i < 8; i += 1) {
    board.touch('s' + i, null)
    board.setRunning('s' + i, true)
    board.noteEvent('s' + i, { type: 'tool/call', data: { name: 'T' + i, arguments: '{}' } })
  }
  const snap = board.snapshot()
  assert.equal(snap.items.length, activity.MAX_CARDS, '应被截到上限')
  assert.equal(snap.total, 8, 'total 应报告真实条数')
  for (let i = 1; i < snap.items.length; i += 1) {
    assert.ok(snap.items[i - 1].updatedAt >= snap.items[i].updatedAt, '应按 updatedAt 倒序')
  }
})

test('ActivityBoard：过期的已结束条目不再占位置', () => {
  const board = new activity.ActivityBoard()
  board.touch('s3', null)
  board.setRunning('s3', true)
  board.noteEvent('s3', { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  board.setRunning('s3', false)
  const future = Date.now() + activity.SETTLE_HOLD_MS + 1000
  assert.equal(board.snapshot(future).items.length, 0, '超过保留时长应被过滤')
  assert.equal(board.snapshot().items.length, 1, '刚结束时仍应显示')
})

test('ActivityBoard：没有标题时退回会话短码，不出现空标题', () => {
  const board = new activity.ActivityBoard()
  board.touch('session-abcdef123456', null)
  board.setRunning('session-abcdef123456', true)
  const item = board.snapshot().items[0]
  assert.ok(item.title.length > 0, '标题不应为空')
  assert.ok(item.title.includes('abcdef12'), '应含短码：' + item.title)
})

test('ActivityBoard：drop 之后不再出现在卡片上', () => {
  const board = new activity.ActivityBoard()
  board.touch('s4', null)
  board.setRunning('s4', true)
  assert.equal(board.snapshot().items.length, 1)
  board.drop('s4')
  assert.equal(board.snapshot().items.length, 0)
})

// ============================================================
// 3. pet.ps1
// ============================================================

console.log('\npet.ps1')

const petScript = join(ROOT, 'lib', 'pet.ps1')

// 坑：C# 的 Add-Type 用 here-string @"..." 包着，PowerShell 5.1 要求 here-string
// 结束符 "`r`n 行首的 @" 才可靠识别。文件一旦被改成 LF-only，解析器就不认这个
// here-string，于是里面的 `using System;` 被当成脚本语句，报
// MissingUsingStatementDirective —— 整只宠物起不来。
test('pet.ps1 必须是 UTF-8 BOM + CRLF 行尾', () => {
  const bytes = readFileSync(petScript)
  assert.ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, 'pet.ps1 缺少 UTF-8 BOM')
  const text = bytes.toString('utf8')
  const crlf = (text.match(/\r\n/g) ?? []).length
  const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length
  assert.equal(bareLf, 0, `存在 ${bareLf} 个裸 LF 行尾（应为 CRLF），会让 Add-Type 的 here-string 解析失败`)
  assert.ok(crlf > 100, 'CRLF 行尾数量异常：' + crlf)
})

test('存在且带 UTF-8 BOM（无 BOM 时 PowerShell 5.1 会把中文注释读成乱码并解析失败）', () => {
  assert.ok(existsSync(petScript), 'pet.ps1 不存在')
  const head = readFileSync(petScript).subarray(0, 3)
  assert.deepEqual([...head], [0xef, 0xbb, 0xbf], 'pet.ps1 缺少 UTF-8 BOM')
})

test('声明了 DPI 感知（否则 150% 缩放下窗口被算到屏幕外）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('SetProcessDpiAwarenessContext'), '缺少 DPI 感知声明')
  assert.ok(text.includes('ConvertTo-Dip'), '缺少物理像素 → DIP 换算')
})

test('不混用 WinForms 物理像素与 WPF DIP 做窗口定位', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(!text.includes('Screen]::PrimaryScreen.WorkingArea'), '不应直接用 WinForms WorkingArea 定位')
  assert.ok(text.includes('SystemParameters]::WorkArea'), '应使用 DIP 的 SystemParameters.WorkArea')
})

test('窗口参数符合桌面宠物要求', () => {
  const text = readFileSync(petScript, 'utf8')
  for (const needle of ['AllowsTransparency', 'Topmost', 'ShowInTaskbar', 'WindowStyle']) {
    assert.ok(text.includes(needle), '缺少 ' + needle)
  }
})

test('窗口不进任务栏、开窗时不抢焦点', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(/\$window\.ShowInTaskbar\s*=\s*\$false/.test(text), 'ShowInTaskbar 必须为 false')
  assert.ok(/\$window\.ShowActivated\s*=\s*\$false/.test(text), 'ShowActivated 必须为 false（开窗不抢焦点）')
  // Activate 只允许出现在「点开回复框」这一处：那一刻用户就是要打字。
  const calls = [...text.matchAll(/\$window\.Activate\(\)/g)]
  assert.equal(calls.length, 1, 'Activate 应只出现一次')
  const toggleBlock = text.slice(text.indexOf('$cardToggle.Add_Click'), text.indexOf('function Send-CardReply'))
  assert.ok(toggleBlock.includes('$window.Activate()'), 'Activate 应落在展开回复框的分支里')
})

test('右键菜单只留「关闭宠物」一项', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('ClosePetItem'), '缺少关闭宠物项')
  assert.ok(text.includes('关闭宠物'), '文案应为「关闭宠物」')
  assert.ok(!text.includes('退出桌宠'), '不应保留旧的退出项')
  assert.ok(!text.includes('Add-MenuItem'), '旧的菜单构造应已移除')
  assert.ok(/Send-PetAction 'close'/.test(text), '点击应发 close 动作')
})

test('过期动作不执行（文件轮询不是消息队列）', () => {
  const text = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(text.includes('ACTION_MAX_AGE_MS'), '应有动作时效常量')
  assert.ok(/Date\.now\(\) - at > ACTION_MAX_AGE_MS/.test(text), '应比较动作时间戳')
  // 校验必须落在消费之前——先判过期再 handle
  const guard = text.indexOf('Date.now() - at > ACTION_MAX_AGE_MS')
  const handle = text.indexOf('handleCardAction(payload).catch')
  assert.ok(guard > 0 && handle > guard, '时效校验应在执行动作之前')
})

test('卡片两行的图标落在图标列并居中对齐', () => {
  const text = readFileSync(petScript, 'utf8')
  const from = text.indexOf('$CardXaml = @')
  const cardBlock = text.slice(from, text.indexOf("'@", from))
  assert.ok(
    /<Ellipse x:Name="StatusDot"[^>]*Grid\.Column="0"[^>]*HorizontalAlignment="Center"/s.test(cardBlock),
    '蓝点应在第 0 列且居中',
  )

  const iconGrid = cardBlock.match(
    /<Grid\b[^>]*Grid\.Row="1"[^>]*Grid\.Column="0"[^>]*HorizontalAlignment="Center"[^>]*>[\s\S]*?<\/Grid>/,
  )?.[0]
  assert.ok(iconGrid, '活动图标容器应在第 0 列且水平居中')
  assert.ok(/<Path x:Name="DetailIcon"(?:\s|>)/.test(iconGrid), '图标容器缺少描边层 DetailIcon')
  assert.ok(/<Path x:Name="DetailIconFill"(?:\s|>)/.test(iconGrid), '图标容器缺少填充层 DetailIconFill')

  // 两行文字同在第 1 列、同左边距 → 左对齐；放不下用省略号
  assert.ok(/x:Name="TitleText" Grid\.Row="0" Grid\.Column="1" Margin="9,/.test(cardBlock), '标题在第 1 列')
  assert.ok(/x:Name="DetailText" Grid\.Row="1" Grid\.Column="1" Margin="9,/.test(cardBlock), '明细在第 1 列且同左边距')
  assert.ok(/x:Name="TitleText"[^>]*TextTrimming="CharacterEllipsis"/s.test(cardBlock), '标题应省略号截断')
  assert.ok(/x:Name="DetailText"[^>]*TextTrimming="CharacterEllipsis"/s.test(cardBlock), '明细应省略号截断')
})

test('文字动效已移除（会与滚动/光标冲突，先不做）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(!/Step-TextAnim|New-TextAnim|Measure-TextWidth/.test(text), '不应残留动效实现')
  assert.ok(!/\$script:TitleAnim|\$script:DetailAnim/.test(text), '不应残留动效状态')
})

// 已读态的「暂停」不是状态告警，而是和旁边回复按钮同族的中性控件，
// 所以底色走主题的 btnBg、描边走 btnFg，不再用写死的灰。
test('右侧按钮三态：红停止 / 绿对号 / 暂停跟随按钮配色', () => {
  const text = readFileSync(petScript, 'utf8')
  for (const glyph of ['StopGlyph', 'DoneGlyph', 'ReadGlyph']) {
    assert.ok(text.includes(glyph), '缺少图形 ' + glyph)
  }
  assert.ok(/function Set-CardStateIcon/.test(text), '应有三态切换函数')
  assert.ok(text.includes("StateStopColor = '#E5534B'"), '停止为红')
  assert.ok(text.includes("StateDoneColor = '#3FB950'"), '完成为绿')
  assert.ok(!text.includes('StateReadColor'), '已读不应再用写死的灰')
  assert.ok(/\$script:Palette\.btnBg/.test(text), '已读底色应跟随按钮配色 btnBg')
  assert.ok(/\$cardReadGlyph\.Stroke = Resolve-Brush \$tint/.test(text), '已读描边应跟随按钮前景色')
  assert.ok(/\$script:Palette = \$p/.test(text), 'Apply-Theme 应缓存调色板供三态重刷')
  assert.ok(/\$cardStop\.IsEnabled = \(\$State -eq 'running'\)/.test(text), '非运行态应禁用停止按钮')
  // 主题切换不能把三态配色覆盖掉
  assert.ok(!/\$cardStop\.Background = Resolve-Brush '#E5534B'/.test(text), 'Apply-Theme 不应硬写停止色')
})

test('双击宠物标记已读（图标转灰）', () => {
  const text = readFileSync(petScript, 'utf8')
  const clickBlock = text.slice(text.indexOf('$root.Add_MouseLeftButtonUp'), text.indexOf('function Update-Look'))
  assert.ok(clickBlock.includes('Show-DshClient'), '双击应唤起客户端')
  assert.ok(/\$script:CardRead = \$true/.test(clickBlock), '双击应标记已读')
})

test('长时间没有会话运行时自动收起卡片', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(/\$script:CardAutoHideMs = 4 \* 60 \* 1000/.test(text), '阈值应为 4 分钟')
  const block = text.slice(text.indexOf('function Update-Card'), text.indexOf('function Write-PetAction'))
  assert.ok(/\$active = \(\$status -eq 'running' -or \$status -eq 'waiting'\)/.test(block), '运行与等待都算活跃')
  assert.ok(/\$script:CardLastActiveAt = \$now/.test(block), '活跃时应刷新时间戳')
  assert.ok(/TotalMilliseconds -gt \$script:CardAutoHideMs/.test(block), '超时应收起')
  // 新一轮开始要清掉已读，图标回到红色停止
  assert.ok(/\$script:CardRead = \$false/.test(block), '新一轮应清掉已读')
})

test('宿主接上流式帧（实时推理与正文）', () => {
  const text = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(text.includes("ctx.on('agent/assistant-stream'"), '应订阅流式帧')
  assert.ok(text.includes('pickStreamPayload'), '应兼容 this 占位的两种签名')
  assert.ok(/feedStream/.test(text), '应把帧喂给跟踪器')
  assert.ok(/STREAM_PUBLISH_MS/.test(text), '流式发布应限流')
  assert.ok(text.includes('reasoning-delta') && text.includes('text-delta'), '应处理推理与正文增量')
})

test('配色跟随桌面亮暗模式', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('AppsUseLightTheme'), '应从注册表读系统亮暗')
  assert.ok(text.includes('Get-Palette'), '应有明暗两套配色')
  assert.ok(/Apply-Theme/.test(text), '应有上色函数')
  assert.ok(/ThemeAccum -ge 5000/.test(text), '应定期复查亮暗变化')
  assert.ok(text.includes('menuBg'), '菜单配色应纳入调色板')
})

test('卡片与宠物水平居中，窗口锚定在宠物中心 + 底边', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(/\$image\.HorizontalAlignment = 'Center'/.test(text), '宠物应水平居中')
  assert.ok(/HorizontalAlignment="Center"/.test(text), '卡片应水平居中')
  assert.ok(/\$petCenterX = \(Get-PetLeft\) \+ \$script:WinW \/ 2/.test(text), '应以宠物水平中心为锚')
  assert.ok(/function Get-PetLeft \{ return \$window\.Left \+ \(\$script:WindowW - \$script:WinW\) \/ 2 \}/.test(text), 'Get-PetLeft 应反映居中')
  assert.ok(/\$script:WindowW = \$w/.test(text), '窗口尺寸应自己记账')
  // 回归：初值写 0 会让第一次 Set-WindowLayout 把 bottom 算成 window.Top + 0，
  // 卡片首次出现时宠物整体上跳一个自身高度。
  assert.ok(
    /\$script:WindowW = \[double\]\$script:WinW/.test(text) &&
      /\$script:WindowH = \[double\]\$script:WinH/.test(text),
    '窗口尺寸记账的初值必须是宠物尺寸',
  )
})

test('悬停判定用宠物矩形而不是整窗（窗口现在含卡片）', () => {
  const text = readFileSync(petScript, 'utf8')
  const start = text.indexOf('function Update-Look')
  const lookBlock = text.slice(start, text.indexOf('\nfunction ', start + 10))
  assert.ok(/\$petLeft = Get-PetLeft/.test(lookBlock), 'Update-Look 应取宠物矩形')
  assert.ok(/\$c\.x -ge \$petLeft/.test(lookBlock), '应按宠物左边界判定')
  assert.ok(!/\$c\.x -ge \$window\.Left/.test(lookBlock), '不应再用整窗边界判定')
})

test('按显示尺寸解码帧表（否则 12 张全解码约 143 MB）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('DecodePixelWidth'), '缺少 DecodePixelWidth 降采样')
})

test('interrupted 映到 failed 姿态（Qoduck 没有单独的中断动画）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(/AnimationAlias\s*=\s*@\{\s*interrupted\s*=\s*'failed'\s*\}/.test(text), '缺少 interrupted → failed 别名')
})

test('idle 待够两个周期后换眨眼变体（Qoder 原版行为）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('IdleEyeAfterMs'), '缺少 idle-eye 切换阈值')
  assert.ok(/2\.0 \* \[double\]\(Get-Animation 'idle'\)\.totalMs/.test(text), '阈值应为 idle 动画总时长的 2 倍')
  assert.ok(/IdleMs -ge \$script:IdleEyeAfterMs/.test(text), '缺少 idle 计时判断')
})

test('开窗时先挥手打招呼', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(/\$window\.Show\(\)[\s\S]{0,500}Start-OneShot 'waving'/.test(text), '开窗后应触发一次 waving')
})

// 回归护栏：待机招手已被移除。用户明确要求招手只在打开宠物时触发，
// 待机就是纯 idle / idleEye，不要再被自动接回任何待机单次动作。
test('待机不再自动招手（招手只属于开窗问候）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(!text.includes('NextIdleWaveAt'), '不应残留待机招手调度')
  assert.ok(!text.includes('$idleQuiet'), '不应残留待机动作触发条件')
  // 开窗问候那一次必须还在
  assert.ok(/Start-OneShot 'waving'/.test(text), '开窗问候的 waving 应保留')
  assert.ok(
    (text.match(/Start-OneShot 'waving'/g) ?? []).length === 1,
    'waving 只应出现一次（开窗问候），待机不再自动招手',
  )
})

test('动画切换时帧游标归零（回归：不归零会卡在末帧）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(/if \(\$animName -ne \$script:CurrentAnim\)/.test(text), '缺少动画切换检测')
  assert.ok(/CurrentAnim = \$animName[\s\S]{0,120}FrameIndex = 0/.test(text), '切换时应把 FrameIndex 归零')
  assert.ok(/CurrentAnim = ''/.test(text), 'Start-OneShot 应清空标记以强制重播')
})

test('悬停时反复播放跳跃（靠每帧的悬停态，不靠 MouseEnter）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('$script:Hovering'), '缺少悬停态')
  assert.ok(/Hovering -and -not \$script:DragDir/.test(text), '缺少悬停判定')
  assert.ok(/if \(\$script:OneShot -ne 'jumping'\) \{ Start-OneShot 'jumping' \}/.test(text), '悬停应持续重播跳跃')
  assert.ok(!text.includes('Add_MouseEnter'), '不应再用 MouseEnter（透明窗口上不可靠，且只在进入时触发一次）')
})

test('单击不触发招手（招手只属于开窗问候与待机随机）', () => {
  const text = readFileSync(petScript, 'utf8')
  const clickBlock = text.slice(text.indexOf('Add_MouseLeftButtonUp'), text.indexOf('function Update-Look'))
  assert.ok(!clickBlock.includes("Start-OneShot 'waving'"), '单击不应播放招手')
  assert.ok(clickBlock.includes('Show-DshClient'), '双击应唤起客户端')
})

test('待机随机张望已彻底移除，禁止重新接回抽搐动画', () => {
  const text = readFileSync(petScript, 'utf8')
  for (const state of ['NextGlanceAt', 'GlanceLook', 'GlanceUntil']) {
    assert.ok(!text.includes(state), '不应残留待机张望状态 ' + state)
  }

  const resolveStart = text.indexOf('function Resolve-Animation')
  const resolveBlock = text.slice(resolveStart, text.indexOf('\nfunction ', resolveStart + 10))
  assert.ok(resolveStart >= 0 && resolveBlock.length > 0, '找不到 Resolve-Animation 函数')
  assert.ok(
    !/return\s+['"]look(?:Left|Right)['"]/i.test(resolveBlock),
    'Resolve-Animation 不得重新返回 lookLeft / lookRight 循环动画',
  )
})

// lookLeft / lookRight 素材已删除（Qoder 原版也没接线，留着只会被误接成抽搐动画）。
test('转头动画素材已彻底移除', () => {
  const framesManifest = JSON.parse(readFileSync(join(ROOT, 'frames', 'manifest.json'), 'utf8'))
  assert.ok(!('lookLeft' in framesManifest), 'manifest 不应再有 lookLeft')
  assert.ok(!('lookRight' in framesManifest), 'manifest 不应再有 lookRight')
  for (const file of ['lookLeft.png', 'lookRight.png']) {
    assert.ok(!existsSync(join(ROOT, 'frames', file)), '素材应已删除: ' + file)
  }
  // 16 向静态注视帧必须还在，鼠标注视靠它
  assert.ok(
    Array.isArray(framesManifest._lookFrames) && framesManifest._lookFrames.length === 16,
    '16 向注视帧必须保留',
  )
})

// waiting 素材画的是闭眼睡觉 + ZZZ，语义是「长时间闲置」而不是「等你选择」。
// 蓝色等待态必须播 review。
test('等待选择播 review，waiting 只用于长时间闲置', () => {
  const text = readFileSync(petScript, 'utf8')
  const resolveStart = text.indexOf('function Resolve-Animation')
  const resolveBlock = text.slice(resolveStart, text.indexOf('\nfunction ', resolveStart + 10))
  assert.ok(resolveStart >= 0, '找不到 Resolve-Animation')
  assert.ok(
    /\$phase\s*-eq\s*'waiting'\s*\)\s*\{\s*return\s*'review'\s*\}/.test(resolveBlock),
    'waiting 相位必须改为播 review',
  )
  // 睡着是一显式状态（$script:Sleeping），不能只用 IdleMs 判定：
  // 睡着时 Phase 仍是 idle、IdleMs 继续累加，靠它判就永远醒不过来。
  assert.ok(text.includes('Sleeping'), '缺少显式睡眠状态 $script:Sleeping')
  assert.ok(/function Update-Sleep/.test(text), '缺少睡眠态维护函数 Update-Sleep')
  assert.ok(
    /if \(\$script:Sleeping\) \{ return 'waiting' \}/.test(resolveBlock),
    'Resolve-Animation 应在睡着时返回 waiting',
  )
  // 唤醒：鼠标一动就醒，并清零重新计时
  const sleepStart = text.indexOf('function Update-Sleep')
  const sleepBlock = text.slice(sleepStart, text.indexOf('\nfunction ', sleepStart + 10))
  assert.ok(/\$script:IdleMs = 0\.0/.test(sleepBlock), '唤醒时必须清零闲置计时')
  assert.ok(/\$awake[\s\S]{0,200}Hovering/.test(sleepBlock), '悬停应算唤醒')
  assert.ok(/\$awake[\s\S]{0,200}DragDir/.test(sleepBlock), '拖拽应算唤醒')
  assert.ok(/\$awake[\s\S]{0,200}LookIndex/.test(sleepBlock), '注视范围内移动应算唤醒')
  assert.ok(text.includes('IdleSleepAfterMs'), '缺少闲置入睡阈值 IdleSleepAfterMs')
  assert.ok(
    /\$script:IdleSleepAfterMs\s*=\s*10\.0\s*\*\s*60\.0\s*\*\s*1000\.0/.test(text),
    '闲置入睡阈值应为 10 分钟',
  )
  // 睡着时卡片淡出、醒来淡入
  assert.ok(/CardFadeTarget[\s\S]{0,80}Sleeping/.test(text), '睡眠应驱动卡片淡出')
})

test('注视：记录光标移动时间，静止后清除注视帧', () => {
  const text = readFileSync(petScript, 'utf8')
  const start = text.indexOf('function Update-Look')
  const lookBlock = text.slice(start, text.indexOf('\nfunction ', start + 10))
  assert.ok(start >= 0 && lookBlock.length > 0, '找不到 Update-Look 函数')
  assert.ok(
    /\$script:LastCursorMoveAt\s*=\s*\[DateTime\]::UtcNow/.test(lookBlock),
    '光标发生有效移动时必须刷新 LastCursorMoveAt',
  )
  assert.ok(
    /\(\[DateTime\]::UtcNow\s*-\s*\$script:LastCursorMoveAt\)\.TotalMilliseconds\s+-ge\s+\$script:LookIdleMs/.test(lookBlock),
    'Update-Look 必须按 LastCursorMoveAt 与 LookIdleMs 判断静止超时',
  )
  assert.ok(
    /if\s*\(\$lookExpired\)\s*\{\s*\$script:LookIndex\s*=\s*-1\s*\}/.test(lookBlock),
    '光标静止后应把 LookIndex 清为 -1',
  )
  assert.ok(/if\s*\(\$lookExpired\)\s*\{\s*return\s*\}/.test(lookBlock), '静止超时后不得在同一帧重新写入 LookIndex')
})

test('注视：渲染优先分支受 Phase 白名单约束', () => {
  const text = readFileSync(petScript, 'utf8')
  const branchMatch = /if\s*\(\$(?:script:LookIndex|lookIdx)\s+-ge\s+0/.exec(text)
  const branchAt = branchMatch?.index ?? -1
  assert.ok(branchAt >= 0, '找不到主循环中的注视帧渲染分支')
  const branch = text.slice(Math.max(0, branchAt - 500), text.indexOf('\n    $durations', branchAt))
  assert.ok(/\$script:Phase/.test(branch), '注视分支必须检查当前 Phase，不能压过所有相位动画')
  assert.ok(
    /(?:\$script:Phase\s+-eq\s+['"]idle['"]|-contains\s+\$script:Phase|\$script:Phase\s+-in\b|\.Contains\(\$script:Phase\))/i.test(branch),
    '注视分支应使用正向 Phase 白名单（单独允许 idle 或显式集合），不能只排除某一个相位',
  )
})

test('注视：只在宠物周围半径 200 DIP 的圆形内触发', () => {
  const text = readFileSync(petScript, 'utf8')
  const start = text.indexOf('function Update-Look')
  const lookBlock = text.slice(start, text.indexOf('\nfunction ', start + 10))
  assert.ok(/LookTrack(?:Half|Radius)\s*=\s*200\.0/.test(text), '注视半径应为 200 DIP')
  assert.ok(/\[Math\]::Sqrt\s*\(/.test(lookBlock), '注视距离必须用 Sqrt 计算圆形半径')
  assert.ok(
    !/\[Math\]::Abs\(\$dx\)[\s\S]{0,160}\[Math\]::Abs\(\$dy\)/.test(lookBlock),
    '不能分别比较 Abs($dx) / Abs($dy)，那会形成方框判定',
  )
})

test('双击唤起 DSH 客户端而不是网页', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('Show-DshClient'), '缺少客户端唤起函数')
  assert.ok(text.includes("Get-Process -Name 'DeepSeek Harness'"), '应按进程名定位客户端主窗口')
  assert.ok(text.includes('SetForegroundWindow'), '缺少前台唤起')
  assert.ok(text.includes('AttachThreadInput'), '应处理 Windows 前台锁')
  assert.ok(!/Start-Process[^\n]*http/i.test(text), '不应通过打开网页来"打开客户端"')
})

test('宠物自身范围内不触发注视（回归：贴身转头会在左右之间抽搐）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('指针落在宠物范围内'), '缺少「自身范围不触发注视」的判定')
  assert.ok(/\$c\.x -ge \$petLeft -and \$c\.x -le \(\$petLeft \+ \$script:WinW\)/.test(text), '缺少水平矩形判定')
  assert.ok(/\$c\.y -ge \$petTop -and \$c\.y -le \(\$petTop \+ \$script:WinH\)/.test(text), '缺少垂直矩形判定')
  assert.ok(!text.includes('HoverSide'), '贴身转头机制应已移除——它是抽搐的根因')
})

test('相位与交互动画均已接线，鼠标注视走静态帧', () => {
  const text = readFileSync(petScript, 'utf8')
  const framesManifest = JSON.parse(readFileSync(join(ROOT, 'frames', 'manifest.json'), 'utf8'))
  const names = Object.keys(framesManifest).filter((key) => !key.startsWith('_'))

  // 需要在脚本里以字面量出现的：交互态、idle 变体、别名目标。
  // 五个相位名（idle/running/waiting/review/failed）由 state.json 直接给出并当动画名用。
  const literals = ['idle', 'idleEye', 'failed', 'waving', 'jumping', 'runningLeft', 'runningRight']
  for (const name of literals) {
    assert.ok(text.includes(`'${name}'`), '动画 ' + name + ' 未在脚本中以字面量引用')
  }
  assert.ok(text.includes('Get-LookFrame'), '缺少 16 向注视帧入口')
  assert.ok(/interrupted = 'failed'/.test(text), 'interrupted 需要显式别名')

  // 相位名必须都在动画表里（否则 Get-Animation 会退回 idle）
  for (const phase of ['idle', 'running', 'waiting', 'review', 'failed', 'interrupted']) {
    const target = phase === 'interrupted' ? 'failed' : phase
    assert.ok(names.includes(target), '相位 ' + phase + ' 没有对应动画 ' + target)
  }
  // lookLeft / lookRight 已删除（原版未接线），剩 10 项
  assert.equal(names.length, 10, '动画表应保留完整 10 项素材：' + names.join(','))
})

test('单元格尺寸由解码后的表整除得出（回归：分别 round 会让最后一行越界）', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('Floor($sheet.PixelWidth / $cols)'), '列方向应按表宽整除')
  assert.ok(text.includes('Floor($sheet.PixelHeight / $rows)'), '行方向应按表高整除')
  assert.ok(!/\$scale\s*=\s*\$sheet\.PixelWidth/.test(text), '不应再按缩放比推算单元格')
})

test('整除口径在真实数值下确实不会越界（旧口径会）', () => {
  const manifestPath = join(ROOT, 'frames', 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const names = Object.keys(manifest).filter((key) => !key.startsWith('_'))
  let checkedOld = 0
  for (const name of names) {
    const anim = manifest[name]
    for (const displayWidth of [48, 84, 128, 192, 384]) {
      const decodedW = displayWidth * anim.cols
      const decodedH = Math.round(anim.frameHeight * anim.rows * (decodedW / (anim.frameWidth * anim.cols)))
      // 新口径：整除，必然放得下
      const cw = Math.floor(decodedW / anim.cols)
      const ch = Math.floor(decodedH / anim.rows)
      assert.ok(cw * anim.cols <= decodedW, `${name}@${displayWidth} 列越界`)
      assert.ok(ch * anim.rows <= decodedH, `${name}@${displayWidth} 行越界`)
      // 旧口径：分别 round，记录它确实会越界——这就是当初崩的原因
      const oldCh = Math.round(anim.frameHeight * (decodedW / (anim.frameWidth * anim.cols)))
      if (oldCh * anim.rows > decodedH) checkedOld += 1
    }
  }
  assert.ok(checkedOld > 0, '旧口径应当存在越界样本（用于说明回归的由来）')
})

test('单元格尺寸无效时返回 null 而不是构造非法矩形', () => {
  const text = readFileSync(petScript, 'utf8')
  assert.ok(text.includes('if ($cw -le 0 -or $ch -le 0) { return $null }'), '缺少尺寸守卫')
})

// ============================================================
// 3. 帧表
// ============================================================

console.log('\n帧表')

const framesDir = join(ROOT, 'frames')
const manifest = JSON.parse(readFileSync(join(framesDir, 'manifest.json'), 'utf8'))
const animationNames = Object.keys(manifest).filter((key) => !key.startsWith('_'))

test('manifest 覆盖全部 10 个动画', () => {
  assert.equal(animationNames.length, 10, '实际 ' + animationNames.length + '：' + animationNames.join(','))
  for (const required of ['idle', 'running', 'waiting', 'review', 'failed', 'waving', 'jumping']) {
    assert.ok(animationNames.includes(required), '缺少动画 ' + required)
  }
})

test('每个动画引用的 PNG 都存在且尺寸自洽', () => {
  for (const name of animationNames) {
    const anim = manifest[name]
    assert.ok(existsSync(join(framesDir, anim.file)), name + ' 缺 ' + anim.file)
    assert.equal(anim.durationsMs.length, anim.frames, name + ' 帧时长数量不匹配')
    assert.equal(anim.cols, 8, name + ' 列数应为 8')
    assert.equal(anim.rows, Math.ceil(anim.frames / anim.cols), name + ' 行数不自洽')
    assert.ok(anim.frameWidth > 0 && anim.frameHeight > 0, name + ' 单元格尺寸无效')
  }
})

test('16 向注视帧齐备', () => {
  assert.equal(manifest._lookFrames.length, 16)
  for (const file of manifest._lookFrames) {
    assert.ok(existsSync(join(framesDir, file)), '缺注视帧 ' + file)
  }
})

test('单次动作标记为非循环', () => {
  assert.equal(manifest.waving.loop, false)
  assert.equal(manifest.jumping.loop, false)
  assert.equal(manifest.idle.loop, true)
})

// ============================================================
// 4. 浏览器半部
// ============================================================

console.log('\n浏览器半部')

let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }
await import(new URL('../lib/client.js', import.meta.url).href)
assert.ok(captured, '客户端半部应调用 __ModuleLoader__.load')
assert.equal(captured.id, 'dsh-qoduck-pet')

const reactStub = {
  useRef: () => ({ current: null }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: () => undefined,
  createElement: () => null,
}
const client = captured.factory((id) => {
  if (id === 'react') return reactStub
  throw new Error('unexpected require: ' + id)
})
const t = client.__test

test('插件契约：apply / inject / name', () => {
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'locale'])
  assert.equal(client.name, 'qoduck-pet')
})

test('只挂设置页，不挂页内浮层（这是桌面宠物，不是页面宠物）', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(!source.includes('shell.overlay'), '不应注册 shell.overlay')
  assert.ok(source.includes('settings.section'), '应注册 settings.section')
})

test('不往 document.body / document.head 写 DOM', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  assert.ok(!source.includes('document.body'), '不得 append 到 document.body')
  assert.ok(!source.includes('document.head'), '不得往 document.head 塞样式')
  assert.ok(!source.includes('createPortal'), '不得用 portal')
})

test('样式只用主题 token，不用字面色值', () => {
  const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const cssBlock = source.slice(source.indexOf('const CSS = ['), source.indexOf('].join("")'))
  assert.ok(cssBlock.includes('var(--dsw-alias-'), '样式应使用主题 token')
  const literalColors = cssBlock.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || []
  assert.deepEqual(literalColors, [], '样式中出现字面色值：' + literalColors.join(', '))
})

test('locale 字典 zh / en 键集一致且非空', () => {
  const zh = Object.keys(t.DICT_ZH).sort()
  const en = Object.keys(t.DICT_EN).sort()
  assert.deepEqual(zh, en, 'zh 与 en 键集不一致')
  assert.ok(zh.length > 20, '字典条目过少：' + zh.length)
  for (const key of zh) {
    assert.ok(t.DICT_ZH[key].length > 0, 'zh 缺值 ' + key)
    assert.ok(t.DICT_EN[key].length > 0, 'en 缺值 ' + key)
  }
})

test('相位文案齐备（含 interrupted）', () => {
  for (const phase of ['idle', 'running', 'waiting', 'review', 'failed', 'interrupted']) {
    assert.ok(t.DICT_ZH['phase.' + phase], 'zh 缺相位 ' + phase)
    assert.ok(t.DICT_EN['phase.' + phase], 'en 缺相位 ' + phase)
  }
})

test('客户端默认尺寸与宿主一致（防止两处漂移）', () => {
  assert.equal(t.DEFAULT_SIZE, host.normalizeConfig(undefined).size)
})

rmSync(sandbox, { recursive: true, force: true })

console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
