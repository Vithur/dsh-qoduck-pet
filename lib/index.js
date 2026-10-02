/**
 * dsh-qoduck-pet — 宿主半部。
 *
 * 桌宠是一个**独立的桌面窗口**（Windows 透明置顶无边框），由本插件在宿主进程里
 * 拉起并托管。为什么窗口要自己带：
 *
 *   DSH 的 Electron 外壳（app.asar/lib/main.js）只当容器，它用
 *   `ELECTRON_RUN_AS_NODE=1` spawn 出真正跑 Cordis 的子进程（见
 *   desktopNodeEnvironment），插件就在那个子进程里——那里没有 BrowserWindow。
 *   DSH 也没有给插件暴露任何窗口/托盘服务（可加载包清单里没有这一类）。
 *   所以窗口走 PowerShell + WPF：Windows 自带、零依赖、原生支持逐像素 alpha。
 *
 * 这个半部负责四件事：
 *   1. 订阅 Cordis 事件，算出桌宠该摆什么姿态，写进 state.json；
 *   2. 拉起 / 守护 pet.ps1（异常退出按退避重启，插件卸载时关掉）；
 *   3. 提供 /api/qoduck-pet/* 给设置页读写配置；
 *   4. 把素材目录挂出去给设置页做预览。
 *
 * @module dsh-qoduck-pet
 */

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ActivityBoard } from './activity.js'
import { StepTracker, assistantTextOf } from './step-summary.js'

/** Cordis 插件名（与 cordis.patch.yml 的 insert id 对齐）。 */
export const name = 'qoduck-pet'

/** 素材路由与配置读写都要 web 服务器。 */
export const inject = ['webServer']

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const ASSET_DIR = join(PACKAGE_ROOT, 'assets')
const PET_SCRIPT = join(PACKAGE_ROOT, 'lib', 'pet.ps1')

export const ASSET_PREFIX = '/qoduck-pet/assets'
export const API_PREFIX = '/api/qoduck-pet'

const MIME_BY_EXT = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

/** 相位保持时长：错误与回合结束都是「闪一下再回去」的瞬时姿态。 */
const FAILED_HOLD_MS = 6000
const REVIEW_HOLD_MS = 4000
/**
 * 「工作中」的静默窗口：这么久没有工具派发、也没有 agent 重新进入 running，
 * 就不再算还在跑。纯文本收尾的那一轮靠它把姿态从敲键盘收回来。
 */
const RUNNING_QUIET_MS = 5000
/** 状态文件写入去抖：相位可能连续变化，不必每次都落盘。 */
const WRITE_DEBOUNCE_MS = 60
/** 进程异常退出后的重启退避。 */
const RESTART_BASE_MS = 2000
const RESTART_MAX_MS = 60000
/**
 * `action.json` 的最大可执行年龄。
 * 动作是文件轮询而非消息队列：宿主没在跑时窗口写下的动作会留在磁盘上，
 * 重启后不该被当成刚刚发生的操作执行（停止会话、关闭宠物尤其不能）。
 */
export const ACTION_MAX_AGE_MS = 60_000
/**
 * 流式帧驱动的最小发布间隔。
 * 推理/正文是按 token 推的，每帧都落盘会把磁盘打满；400ms 对桌宠足够跟手。
 */
const STREAM_PUBLISH_MS = 400

/** `${DSH_HOME:-~/.dsh}`。 */
export function dshHome(env = process.env) {
  const raw = env && env.DSH_HOME
  return raw && raw.trim() !== '' ? raw.trim() : join(homedir(), '.dsh')
}

export function stateDir(env = process.env) {
  return join(dshHome(env), 'qoduck-pet')
}

export function configPath(env = process.env) {
  return join(stateDir(env), 'config.json')
}

/** 桌宠窗口自己维护的位置/尺寸，宿主只读不算。 */
export function windowPath(env = process.env) {
  return join(stateDir(env), 'window.json')
}

/**
 * 默认配置。`size` 是像素边长（Qoduck 原始画面 256x277）。
 * 84 约为 Qoder 原版 sizePercent:100 的三分之二——原尺寸在 4K 桌面上偏大。
 */
const DEFAULT_CONFIG = {
  enabled: true,
  size: 84,
  pin: 'bottom-right',
  mouseTracking: true,
  greetOnFirstUse: true,
  showCard: true,
}

const PINS = ['bottom-right', 'bottom-left', 'top-right', 'top-left']
const MAX_BODY_BYTES = 64 * 1024

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

/** 把一份不可信配置收敛成可持久化的形状。坏字段退回默认值，不抛错。 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = { ...DEFAULT_CONFIG }
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled
  if (typeof src.mouseTracking === 'boolean') out.mouseTracking = src.mouseTracking
  if (typeof src.greetOnFirstUse === 'boolean') out.greetOnFirstUse = src.greetOnFirstUse
  out.size = clampInt(src.size, 48, 384, DEFAULT_CONFIG.size)
  out.pin = PINS.includes(src.pin) ? src.pin : DEFAULT_CONFIG.pin
  if (typeof src.showCard === 'boolean') out.showCard = src.showCard
  return out
}

export function loadConfig(env = process.env) {
  const file = configPath(env)
  if (!existsSync(file)) return { ...DEFAULT_CONFIG }
  try {
    return normalizeConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

export function saveConfig(config, env = process.env) {
  mkdirSync(stateDir(env), { recursive: true })
  writeJsonAtomic(configPath(env), config)
  return config
}

/**
 * 姿态状态机。
 *
 * 输入是宿主侧从 Cordis 事件攒出来的计数与时间戳；输出是 Qoduck 的姿态名。
 * 优先级与 Qoder 原版一致：错误 > 中断 > 等待用户 > 工作中 > 结果可查看 > 空闲。
 *
 * `interrupted` 与 `failed` 是两个相位（Qoder 也分开记），但 Qoduck 没有单独的中断
 * 动画，窗口侧把两者都映到 failed 姿态——差别体现在状态文案与状态灯的语义上。
 */
/**
 * 把一个「运行中」的计数收敛成数字。
 *
 * 调用方传进来的可能是 `Set`（运行中的 agent id / 工具 callId 要去重，所以用
 * 集合），也可能是数字（测试与快照）。`Set > 0` 恒为 `false`（对象转数字得
 * NaN，NaN 的比较一律 false），所以必须在这里显式取 `.size` —— 少了这一步，
 * 「有 agent 在跑 / 有工具在跑」这两个判据会永远不成立，姿态就恒为 idle。
 */
function countOf(value) {
  if (typeof value === 'number') return value
  if (value instanceof Set || value instanceof Map) return value.size
  if (Array.isArray(value)) return value.length
  return 0
}

/**
 * 从一次工具派发里取工具名。
 *
 * `ToolDispatchExecution` 各版本把名字放在不同字段，这里按最可能的几处依次取，
 * 取不到就返回空串——宁可漏判也不要因为字段不存在而抛错打断工具执行。
 */
function toolName(exec) {
  const candidates = [
    exec?.name, exec?.toolName, exec?.tool?.name,
    exec?.call?.name, exec?.call?.function?.name,
    exec?.execution?.name, exec?.request?.name,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

export function derivePhase(input, now = Date.now()) {
  if (!input) return 'idle'
  if (input.failedAt && now - input.failedAt < FAILED_HOLD_MS) return 'failed'
  if (input.interruptedAt && now - input.interruptedAt < FAILED_HOLD_MS) return 'interrupted'
  if (input.waiting > 0) return 'waiting'
  if (countOf(input.runningTools) > 0) return 'running'
  // 纯文本收尾那一轮常常不会有 agent/status idle 把它从 runningAgents 里摘掉，
  // 于是宠物会一直「敲键盘」。用「最近一次真的在跑」兜底：超过静默窗口还没有
  // 新动静，就不再算工作中。
  const quiet = input.lastActivityAt ? now - input.lastActivityAt > RUNNING_QUIET_MS : true
  if (!quiet && countOf(input.runningAgents) > 0) return 'running'
  if (input.lastTurnEndAt && now - input.lastTurnEndAt < REVIEW_HOLD_MS) return 'review'
  return 'idle'
}

/** 一个已提交的会话事件长这样：`{ type, seq, time, data }`。 */
export function isSessionEvent(value) {
  return !!value && typeof value === 'object' && typeof value.type === 'string' && 'data' in value
}

/**
 * 读一条已提交的会话事件，更新状态机的计数与时间戳。
 *
 * 关键在 `turn/end` 的 `reason`——这是 DSH 区分「用户中断」与「真失败」的唯一
 * 可靠来源（见 dsh-agent-loop 的 turn 收尾）：
 *
 *   { kind: 'completed' }                       正常收尾
 *   { kind: 'aborted', reason: { kind: 'user' } }    用户按了停止
 *   { kind: 'aborted', reason: { kind: 'parent' | 'disposed' | 'hook' } }
 *   { kind: 'error', error }                    真失败（同时也会发 agent/error）
 *   { kind: 'blocked' } / { kind: 'max-tokens' }      DSH 独有
 *
 * 注意 `agent/error` **不会**在用户中断时触发（agent-loop 走的是 `throw error`
 * 而不是 `this.throwError(error)`），所以只订阅 agent/error 会把中断误判成
 * 「回合正常结束 → review」。
 *
 * @returns true 当相位可能需要重新计算
 */
export function applySessionEvent(counters, event, now = Date.now()) {
  if (!event || event.type !== 'turn/end') return false
  const reason = event.data && event.data.reason
  const kind = reason && reason.kind
  if (kind === 'completed') {
    counters.lastTurnEndAt = now
    return true
  }
  if (kind === 'error') {
    counters.failedAt = now
    return true
  }
  if (kind === 'aborted') {
    const cause = reason.reason && reason.reason.kind
    // 只有用户主动中断才当成「执行受阻」；parent/disposed/hook 是会话生命周期，
    // 不该让桌宠哭。
    if (cause === 'user') counters.interruptedAt = now
    else counters.lastTurnEndAt = now
    return true
  }
  // TurnEndReasonMap 里除了 aborted 还有一个独立的 interrupted（用户中止）。
  if (kind === 'interrupted') {
    counters.interruptedAt = now
    return true
  }
  if (kind === 'blocked' || kind === 'max-tokens' || kind === 'forked') {
    counters.lastTurnEndAt = now
    return true
  }
  return false
}

/**
 * 桌宠进程的托管者：拉起、守护、随插件卸载关闭。
 * 只在 Windows 上工作（WPF）；其他平台静默不启动，插件其余部分照常可用。
 */
class PetProcess {
  constructor(options) {
    this.script = options.script
    this.packageRoot = options.packageRoot
    this.dir = options.stateDir
    this.enabled = false
    this.child = null
    this.restarts = 0
    this.restartTimer = null
    this.disposed = false
    this.logFile = join(this.dir, 'pet.log')
  }

  start() {
    if (this.disposed || this.child || process.platform !== 'win32') return
    if (!existsSync(this.script)) {
      this.log(`pet.ps1 不存在：${this.script}`)
      return
    }
    mkdirSync(this.dir, { recursive: true })
    let child
    try {
      child = spawn(
        'powershell.exe',
        // windowsHide 给的是 CREATE_NO_WINDOW，根本不建控制台；-WindowStyle Hidden
        // 再兜一层，保证任务栏里绝不会出现「Windows PowerShell」。
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
          '-File', this.script, '-PluginDir', this.packageRoot, '-StateDir', this.dir],
        { windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch (error) {
      this.log('spawn 失败：' + (error instanceof Error ? error.message : String(error)))
      this.scheduleRestart()
      return
    }
    this.child = child
    this.restarts = 0

    if (child.stderr) child.stderr.on('data', (chunk) => this.log(String(chunk).trim()))
    child.on('error', (error) => this.log('进程错误：' + error.message))
    child.on('exit', (code, signal) => {
      this.child = null
      if (this.disposed) return
      this.log(`进程退出 code=${code} signal=${signal}`)
      if (this.enabled) this.scheduleRestart()
    })
  }

  scheduleRestart() {
    if (this.disposed || this.restartTimer) return
    this.restarts += 1
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(this.restarts - 1, 5))
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.enabled) this.start()
    }, delay)
    this.restartTimer.unref?.()
  }

  setEnabled(enabled) {
    this.enabled = enabled
    if (enabled) this.start()
    else this.stop()
  }

  stop() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    if (!child) return
    try { child.kill() } catch { /* 已经没了 */ }
  }

  dispose() {
    this.disposed = true
    this.stop()
  }

  log(message) {
    if (!message) return
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.logFile, `[${new Date().toISOString()}] ${message}\n`, { flag: 'a' })
    } catch {
      /* 日志失败不该影响桌宠 */
    }
  }
}

/** 单层文件名的素材解析；任何路径穿越都拒掉。 */
function resolveAsset(assetName) {
  if (typeof assetName !== 'string' || assetName === '') return null
  if (assetName.includes('/') || assetName.includes('\\') || assetName.includes('\0')) return null
  if (assetName === '.' || assetName === '..') return null
  const file = resolve(ASSET_DIR, assetName)
  const root = resolve(ASSET_DIR)
  if (file !== root && !file.startsWith(root + sep)) return null
  return file
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'))
        queueMicrotask(() => req.destroy())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('invalid-json')) }
    })
    req.on('error', reject)
  })
}

function assetHandler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
  let pathname
  try { pathname = new URL(req.url ?? '/', 'http://qoduck-pet.local').pathname } catch { res.writeHead(400); res.end(); return }
  const assetName = decodeURIComponent(pathname.slice(ASSET_PREFIX.length).replace(/^\/+/, ''))
  const file = resolveAsset(assetName)
  if (file === null || !existsSync(file)) { res.writeHead(404); res.end(); return }
  let info
  try { info = statSync(file) } catch { res.writeHead(404); res.end(); return }
  if (!info.isFile()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, {
    'content-type': MIME_BY_EXT[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': 'public, max-age=86400',
  })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/**
 * 挂载宿主半部。
 *
 * `config.enabled` 为 false 时只挂路由、不启动窗口进程——用户可以在设置页里
 * 开关，不必改 profile 补丁。
 */
export function apply(ctx, config = {}) {
  const env = config.env ?? process.env
  const dir = stateDir(env)

  // ---- 事件 → 姿态 ----
  const counters = {
    runningAgents: new Set(),
    runningTools: new Set(),
    waiting: 0,
    failedAt: 0,
    interruptedAt: 0,
    /**
     * 最近一次「确认已经跑完」的时间。
     *
     * 不能只认 `turn/end`：若这一轮是纯文本收尾（没工具、也没有新的
     * agent/status idle 事件），runningTools 会归零，但 runningAgents 那条
     * 可能没人清，宠物就会一直「敲键盘」。所以凡是看到回合正常结束、或者
     * agent 明确回到 idle，都在这里记一次时间——只要不再有工具在跑，
     * 姿态就从「工作中」退到「结果可查看」。
     */
    lastTurnEndAt: 0,
    /** 最近一次明确「有东西在跑」的时间：工具派发或 agent running。 */
    lastActivityAt: 0,
  }

  let currentPhase = null
  let writeTimer = null

  const pet = new PetProcess({
    script: PET_SCRIPT,
    packageRoot: PACKAGE_ROOT,
    stateDir: dir,
  })

  // ---- 活动卡片 ----
  // 标题服务是可选依赖（不是所有 profile 都装），懒查并在拿不到时退回空串。
  const readTitle = (session) => {
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
      return service && typeof service.get === 'function' ? service.get(session) : undefined
    } catch {
      return undefined
    }
  }
  const board = new ActivityBoard({ readTitle })
  let activityTimer = null

  /**
   * 按 id 反查会话对象，只为了拿 `header`（看板靠它判断主/子会话）。
   *
   * 会话存储是可选依赖、也可能还没起来，所以全程 try 并允许查不到。
   * 查不到就返回 undefined：看板那边会把这条当作「身份未确认」先不显示，
   * 等 `session/created` / `session/event` 带来真正的 session 对象。
   */
  const findSession = (sessionId) => {
    try {
      const store = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (!store || typeof store.list !== 'function') return undefined
      for (const session of store.list()) {
        if (session && (session.id === sessionId || session.sessionId === sessionId)) return session
      }
    } catch {
      /* 会话存储还没起来 */
    }
    return undefined
  }

  // 每个会话一个步骤跟踪器：卡片第一行取助手正文，第二行取活动摘要 + 图标。
  // 摘要在 DSH 里是浏览器侧算的，宿主不提供，所以这里按同一套算法自己算。
  const trackers = new Map()
  const trackerFor = (sessionId) => {
    let tracker = trackers.get(sessionId)
    if (!tracker) {
      tracker = new StepTracker()
      trackers.set(sessionId, tracker)
    }
    return tracker
  }

  /** 把会话事件喂给跟踪器。只有这四种事件会影响卡片文案。 */
  function feedTracker(sessionId, event) {
    const tracker = trackerFor(sessionId)
    switch (event?.type) {
      case 'turn/start':
        tracker.reset()
        return true
      case 'tool/call':
        tracker.noteToolCall(event.data?.name, event.data?.arguments)
        return true
      case 'tool/result':
        tracker.clearRunning()
        return true
      case 'assistant/message':
        tracker.noteAssistantText(assistantTextOf(event))
        return true
      default:
        return false
    }
  }

  /**
   * 把流式帧喂给跟踪器。`agent/assistant-stream` 是最细的实时源：
   * 推理、正文、工具参数都按增量推，比 `session/event`（提交后才有）早一步。
   */
  function feedStream(sessionId, frame) {
    if (!frame || typeof frame !== 'object') return false
    const tracker = trackerFor(sessionId)
    if (frame.type === 'start') {
      tracker.beginStream()
      return true
    }
    if (frame.type !== 'chunk') return false
    const chunk = frame.chunk
    if (!chunk || typeof chunk !== 'object') return false
    switch (chunk.type) {
      case 'reasoning-delta':
        tracker.appendReasoning(chunk.text)
        return true
      case 'text-delta':
        tracker.appendText(chunk.text)
        return true
      default:
        return false
    }
  }

  // 签名是 `(this: Scoped<Agent>, payload)`；`this` 是否占实参位随 Cordis 版本而异。
  function pickStreamPayload(first, second) {
    for (const value of [first, second]) {
      if (value && typeof value === 'object' && value.frame && value.agent) return value
    }
    return null
  }

  let streamTimer = null
  function publishActivityThrottled() {
    if (streamTimer) return
    streamTimer = setTimeout(() => {
      streamTimer = null
      publishActivity()
    }, STREAM_PUBLISH_MS)
    streamTimer.unref?.()
  }

  function publishActivity() {
    if (activityTimer) return
    activityTimer = setTimeout(() => {
      activityTimer = null
      try {
        mkdirSync(dir, { recursive: true })
        const cfg = loadConfig(env)
        const snapshot = board.snapshot(Date.now(), counters.waiting)
        snapshot.showCard = cfg.showCard !== false
        // 把摘要挂到各自会话的条目上；窗口侧只用第一条（也就是最活跃那条）。
        // 第一行是会话标题（board 提供），第二行是这里的实时信息。
        for (const item of snapshot.items ?? []) {
          const tracker = trackers.get(item.sessionId)
          if (!tracker) continue
          const summary = tracker.snapshot()
          item.detail = summary.detail
          item.icon = summary.icon
          item.kind = summary.kind
          item.toolRunning = summary.running
          item.runningDetail = summary.runningDetail
          item.stepSummary = summary.summary
        }
        writeJsonAtomic(join(dir, 'activity.json'), snapshot)
      } catch {
        /* 写不进去也不该让插件崩 */
      }
    }, WRITE_DEBOUNCE_MS)
    activityTimer.unref?.()
  }

  function publish(force = false) {
    const phase = derivePhase(counters)
    if (!force && phase === currentPhase) return
    currentPhase = phase
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      try {
        mkdirSync(dir, { recursive: true })
        const cfg = loadConfig(env)
        writeJsonAtomic(join(dir, 'state.json'), {
          phase: currentPhase,
          enabled: cfg.enabled,
          size: cfg.size,
          pin: cfg.pin,
          mouseTracking: cfg.mouseTracking,
          updatedAt: new Date().toISOString(),
        })
      } catch {
        /* 写不进去也不该让插件崩 */
      }
    }, WRITE_DEBOUNCE_MS)
    writeTimer.unref?.()
  }

  /** 瞬时姿态（failed / review）到期后要主动回落，不能等下一个事件。 */
  const sweep = setInterval(() => publish(), 1000)
  sweep.unref?.()

  const offs = []

  /**
   * 作用域过滤事件的订阅一律带 `{ global: true }`。
   *
   * `agent/*`、`tools/*`、`approval/request`、`user-questions/request` 等在
   * dsh-scope 的 scoped-events 映射表里都有 resolver（`args[0]["agent"]`），
   * 宿主是拿 `scopeTarget(agent, agent)` 当 thisArg 派发的。按 dsh-scope 的
   * 准入规则，未打标签的监听器确实会被放行，但带上 `global: true` 可以显式
   * 绕过任何过滤（包括将来宿主给 Agent 加上 base filter 的情况），与宿主内
   * 其它订阅者（dsh-agent 的 invariant、api-session 桥接）保持一致。
   *
   * `session/created`、`session/disposed`、`session/event` 在映射表里
   * resolver 为 `null`，不是作用域过滤事件，不需要加。
   */
  offs.push(ctx.on('agent/status', (payload) => {
    const id = payload?.agent?.id ?? payload?.agent?.sessionId ?? 'unknown'
    if (payload?.status === 'running') {
      counters.runningAgents.add(id)
      counters.lastActivityAt = Date.now()
    } else {
      counters.runningAgents.delete(id)
      counters.lastTurnEndAt = Date.now()
    }
    // agent/status 只带 id、不带会话对象，可能在 session/created 之前到达。
    // 这里反查一次 header 喂给看板：只有明确了主/子，看板才敢显示这一条。
    // 查不到就不登记（宁可这一帧不显示），等会话事件带来真正的对象。
    const known = findSession(id)
    if (known) board.touch(id, known)
    board.setRunning(id, payload?.status === 'running')
    publish()
    publishActivity()
  }, { global: true }))

  offs.push(ctx.on('agent/error', () => {
    counters.failedAt = Date.now()
    publish()
  }, { global: true }))

  offs.push(ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id ?? payload?.agent?.sessionId ?? 'unknown'
    counters.runningAgents.delete(id)
    publish()
  }, { global: true }))

  // tools/execute 是 waterfall：不接管决策就必须 next()，用 try/finally 保证
  // 计数一定会减回去。
  offs.push(ctx.on('tools/execute', async (exec, next) => {
    const key = exec?.callId ?? exec?.id ?? String(Math.random())
    counters.runningTools.add(key)
    counters.lastActivityAt = Date.now()
    // 「向用户提问」也是一次工具调用，而且它会阻塞到用户真的作答为止。
    // 这是等待态最可靠的观测点：user-questions/request 那条 waterfall 我们收不到
    // （它只在有 answerer 的一侧派发），但工具派发一定经过这里。
    const asks = toolName(exec) === 'ask_user_question'
    if (asks) counters.waiting += 1
    publish()
    publishActivity()
    try {
      return await next()
    } finally {
      counters.runningTools.delete(key)
      if (asks) counters.waiting = Math.max(0, counters.waiting - 1)
      publish()
      publishActivity()
    }
  }, { global: true }))

  // 等待用户：审批与提问都是 waterfall，同样必须 next()。
  //
  // payload 里不一定有 agent（`ask()` 在 `agent === undefined` 时派发的是裸
  // request），所以不能只靠 request.agent.id 定位会话。改成：
  //   - 计数照加，驱动宠物姿态；
  //   - 卡片由 publishActivity() 按 counters.waiting 统一标记活跃条目，
  //     这样无论等待来自主会话还是它的子智能体，卡片都能显示「需要你的选择」。
  const waitingWaterfall = async (request, next) => {
    counters.waiting += 1
    pet.log(`[diag] waiting+1 总数=${counters.waiting} agent=${request?.agent?.id ?? '无'}`)
    publish()
    publishActivity()
    try {
      return await next()
    } finally {
      counters.waiting = Math.max(0, counters.waiting - 1)
      pet.log(`[diag] waiting-1 总数=${counters.waiting}`)
      publish()
      publishActivity()
    }
  }
  offs.push(ctx.on('approval/request', waitingWaterfall, { global: true }))
  offs.push(ctx.on('user-questions/request', waitingWaterfall, { global: true }))

  offs.push(ctx.on('agent/turn-stopping', () => {
    counters.lastTurnEndAt = Date.now()
    publish()
  }, { global: true }))

  // 用户中断只能从已提交的 turn/end 事件里读——agent/error 在中断路径上不发。
  // 该事件的签名是 `(this: Scoped<Session>, session, event)`；`this` 是否占一个实参
  // 位置随 Cordis 版本而异，这里两种取法都认。同一条订阅顺带喂活动卡片。
  offs.push(ctx.on('session/event', (first, second) => {
    const event = isSessionEvent(second) ? second : (isSessionEvent(first) ? first : null)
    if (!event) return
    if (applySessionEvent(counters, event)) publish()

    const session = isSessionEvent(second) ? first : second
    const id = session?.id ?? session?.sessionId
    if (typeof id !== 'string' || id === '') return
    board.touch(id, session)
    const touched = board.noteEvent(id, event)
    if (feedTracker(id, event) || touched) publishActivity()
  }))

  // 流式帧：推理与正文的按 token 增量。这是「现在到底在干什么」最及时的来源，
  // 比 session/event 早一拍（后者要等提交）。限流后再落盘。
  offs.push(ctx.on('agent/assistant-stream', (first, second) => {
    const payload = pickStreamPayload(first, second)
    if (!payload) return
    const id = payload.agent?.id
    if (typeof id !== 'string' || id === '') return
    // 还在出 token 就是在干活。这里不续期的话，长思考/长正文那一轮会超过
    // RUNNING_QUIET_MS 没有工具派发也没有 agent/status，被判成「静默」而退回
    // idle —— 表现就是敲键盘动画播几秒后被待机动画盖掉。
    if (feedStream(id, payload.frame)) {
      counters.lastActivityAt = Date.now()
      publish()
    }
    publishActivityThrottled()
  }, { global: true }))

  // 会话登记 / 注销（卡片要知道有哪些会话）
  offs.push(ctx.on('session/created', (session) => {
    const id = session?.id
    if (typeof id !== 'string' || id === '') return
    board.touch(id, session)
    publishActivity()
  }))

  offs.push(ctx.on('session/disposed', (session) => {
    const id = session?.id ?? session?.sessionId
    if (typeof id !== 'string' || id === '') return
    board.drop(id)
    trackers.delete(id)
    publishActivity()
  }))

  // 审批/提问的等待态由上面的 session/event 里的 approval/asked、approval/decided
  // 两条会话事件驱动——它们不是 Cordis Event，没有对应的 ctx.on 名字。

  // 已存在的会话（插件中途启用时）先登记一遍
  try {
    const store = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    if (store && typeof store.list === 'function') {
      for (const session of store.list()) {
        if (session && typeof session.id === 'string') board.touch(session.id, session)
      }
      publishActivity()
    }
  } catch {
    // 会话存储还没起来，等 session/created
  }

  // ---- 卡片动作 ----
  // 窗口把动作写进 action.json，这里消费。走文件而不是新增 HTTP 变更端点：
  // `/api/*` 有鉴权、非 /api 的路径没有，为一个桌宠按钮开免鉴权的会话写入口不值当。
  const actionPath = join(dir, 'action.json')

  async function handleCardAction(payload) {
    if (!payload || typeof payload !== 'object') return

    // 「关闭宠物」不带会话：关掉显示，设置页里可以再打开。
    if (payload.action === 'close') {
      const merged = normalizeConfig({ ...loadConfig(env), enabled: false })
      saveConfig(merged, env)
      pet.setEnabled(false)
      publish(true)
      return
    }

    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') return
    const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    if (!controller) return

    if (payload.action === 'stop') {
      try {
        await controller.cancel({ sessionId })
        pet.log(`卡片停止：已投递 cancel sessionId=${sessionId}`)
      } catch (error) {
        // 不能静默吞掉：投递失败和「会话已结束」在用户看来完全不同
        pet.log(`卡片停止失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (payload.action === 'reply') {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (text === '') return
      const mode = payload.mode === 'steer' ? 'steer' : 'queue'
      const requestId = 'qoduck-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      try {
        await controller.prompt({
          requestId,
          sessionId,
          mode,
          content: [{ type: 'text', text }],
        }, new AbortController().signal)
        pet.log(`卡片回复：已投递 prompt requestId=${requestId} mode=${mode} 文本=${JSON.stringify(text.slice(0, 40))}`)
      } catch (error) {
        pet.log(`卡片回复失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const actionSweep = setInterval(() => {
    let payload = null
    try {
      if (!existsSync(actionPath)) return
      payload = JSON.parse(readFileSync(actionPath, 'utf8'))
    } catch {
      payload = null
    }
    try { unlinkSync(actionPath) } catch { /* 已经没了 */ }
    if (!payload) return
    // 动作是文件轮询，不是消息队列：宿主没在跑时写下的动作会一直躺在磁盘上，
    // 重启后不该被当成刚发生的操作执行（尤其是「关闭宠物」和「停止会话」）。
    const at = Date.parse(payload.at ?? '')
    if (Number.isFinite(at) && Date.now() - at > ACTION_MAX_AGE_MS) return
    handleCardAction(payload).catch(() => {})
  }, 250)
  actionSweep.unref?.()

  // ---- 路由 ----
  const stateRoute = {
    kind: 'exact',
    path: API_PREFIX + '/state',
    handler: (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      const cfg = loadConfig(env)
      let win = null
      try { win = JSON.parse(readFileSync(windowPath(env), 'utf8')) } catch { win = null }
      json(res, 200, { ok: true, config: cfg, phase: currentPhase ?? 'idle', window: win, running: pet.child !== null })
    },
  }

  const configRoute = {
    kind: 'exact',
    path: API_PREFIX + '/config',
    handler: (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method-not-allowed' }); return }
      readJsonBody(req).then(
        (body) => {
          const merged = normalizeConfig({ ...loadConfig(env), ...(body && typeof body === 'object' ? body : {}) })
          saveConfig(merged, env)
          pet.setEnabled(merged.enabled)
          publish(true)
          json(res, 200, { ok: true, config: merged })
        },
        (error) => json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
    },
  }

  const assetRoute = { kind: 'prefix', path: ASSET_PREFIX, handler: assetHandler }

  ctx.effect(() => {
    const disposers = [stateRoute, configRoute, assetRoute].map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
      for (const off of offs) {
        try { off?.() } catch { /* 已经释放 */ }
      }
      if (writeTimer) clearTimeout(writeTimer)
      if (activityTimer) clearTimeout(activityTimer)
      clearInterval(sweep)
      clearInterval(actionSweep)
      pet.dispose()
    }
  }, 'qoduck-pet: routes + pet process + activity card')

  // 启动桌宠（配置说关就不启）
  const initial = loadConfig(env)
  pet.setEnabled(initial.enabled !== false)
  publish(true)
  publishActivity()
}

export { DEFAULT_CONFIG, PINS, FAILED_HOLD_MS, REVIEW_HOLD_MS }
export { ActivityBoard, describeTool, statusFromTurnEnd, MAX_CARDS } from './activity.js'
export {
  StepTracker, assistantTextOf, liveToolDetail, normalizeDetail,
  processTitle, rankCounts, toolKind, PROCESS_ICONS, DETAIL_MAX_CHARS,
} from './step-summary.js'
