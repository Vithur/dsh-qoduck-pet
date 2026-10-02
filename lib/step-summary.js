/**
 * dsh-qoduck-pet — 对话活动摘要（宿主侧移植）。
 *
 * 卡片第二行要显示的「已完成分析」「已读取文件」「修改了文件，已读取文件，执行了命令等」
 * 是 DSH 聊天界面在**浏览器侧**算出来的（只存在于
 * `@deepseek-ai/dsh-client-ui-chat/lib/client.js`），宿主不提供。桌宠的窗口是独立进程，
 * 更拿不到。所以这里把同一套算法照搬到宿主，输入换成 `session/event` 里的事件。
 *
 * 移植来源（逐条对齐，不自行发挥）：
 *   - `activity(name)`        @ client.js:485220  工具名 → 类别
 *   - `processActivity(nodes)`@ client.js:488954  按「出现次数降序、同次数先出现者前」排名
 *   - `processTitle(summary)` @ client.js:123404  取前三类拼标题，超过三类补「等」
 *   - `liveToolDetail`        @ client.js:488126  按固定优先级从参数里取一行明细
 *   - `PROCESS_ICONS`         @ client.js:139538  类别 → 图标（这里只导出类别名）
 *
 * @module dsh-qoduck-pet/step-summary
 */

/** 明细行上限，与客户端 `LIVE_TOOL_DETAIL_MAX_CHARS` 一致。 */
export const DETAIL_MAX_CHARS = 160

/**
 * 工具名 → 类别。完全照抄客户端的 `activity()`，包括分支顺序——
 * `endsWith('_inspect')` 必须排在默认分支之前，`startsWith('subagent_')` 同理。
 */
export function toolKind(name) {
  const n = String(name ?? '')
  if (n === 'read') return 'read'
  if (n === 'read_image') return 'readImage'
  if (n === 'grep' || n === 'glob' || n.endsWith('_inspect')) return 'search'
  if (n === 'write') return 'write'
  if (n === 'edit' || n === 'apply_patch') return 'edit'
  if (['bash', 'pwsh', 'exec_command', 'write_stdin'].includes(n) || n.startsWith('terminal_')) {
    return 'commands'
  }
  if (n === 'run_code') return 'code'
  if (n === 'web_search') return 'webSearch'
  if (n === 'web_fetch') return 'webFetch'
  if (n === 'subagent' || n.startsWith('subagent_')) return 'subagents'
  if (['todo_write', 'create_goal', 'update_goal', 'get_goal'].includes(n)) return 'plan'
  if (n === 'ask_user_question' || n === 'request_user_input') return 'questions'
  return 'tools'
}

/** 类别 → 图标名，对应客户端 `PROCESS_ICONS`；桌宠用它选矢量图形。 */
export const PROCESS_ICONS = {
  thinking: 'think',
  read: 'browse',
  readImage: 'browse',
  search: 'search',
  edit: 'edit',
  write: 'edit',
  commands: 'api',
  code: 'code',
  webSearch: 'globe',
  webFetch: 'browse',
  subagents: 'agent',
  plan: 'plan',
  questions: 'question',
  tools: 'sparkle',
}

/**
 * 类别 → 动作词。卡片的实时行要说「在干什么」，
 * 只有聚合摘要（「修改了文件，已读取文件，执行了命令等」）等于什么都没说。
 */
const KIND_VERBS = {
  zh: {
    thinking: '思考中',
    read: '读取',
    readImage: '查看图片',
    search: '搜索',
    write: '写入',
    edit: '编辑',
    commands: '运行',
    code: '运行代码',
    webSearch: '搜索网页',
    webFetch: '访问网页',
    subagents: '协调子智能体',
    plan: '更新计划',
    questions: '等待你的处理',
    tools: '调用',
  },
  en: {
    thinking: 'Thinking',
    read: 'Reading',
    readImage: 'Viewing',
    search: 'Searching',
    write: 'Writing',
    edit: 'Editing',
    commands: 'Running',
    code: 'Running code',
    webSearch: 'Searching the web',
    webFetch: 'Visiting',
    subagents: 'Coordinating subagents',
    plan: 'Updating the plan',
    questions: 'Waiting for you',
    tools: 'Calling',
  },
}

function kindVerb(kind, lang) {
  const verbs = KIND_VERBS[lang] ?? KIND_VERBS.zh
  return verbs[kind] ?? verbs.tools
}

/** 完成态文案，键名与客户端 `message.stepProcess.done.*` 一致。 */
const DONE_LABELS = {
  zh: {
    thinking: '已完成分析',
    read: '已读取文件',
    readImage: '已读取图片',
    write: '已写入文件',
    search: '已搜索代码',
    edit: '修改了文件',
    commands: '执行了命令',
    code: '运行了代码',
    webSearch: '已搜索网页',
    webFetch: '已访问网页',
    subagents: '已协调子智能体',
    plan: '更新了计划',
    questions: '向用户提出了问题',
    tools: '已调用工具',
  },
  en: {
    thinking: 'Analysis completed',
    read: 'Read files',
    readImage: 'Read images',
    write: 'Wrote files',
    search: 'Searched code',
    edit: 'Edited files',
    commands: 'Ran commands',
    code: 'Ran code',
    webSearch: 'Searched the web',
    webFetch: 'Visited web pages',
    subagents: 'Coordinated subagents',
    plan: 'Updated the plan',
    questions: 'Asked questions',
    tools: 'Called tools',
  },
}

/** 连接词，对应 `joinTwo` / `comma` / `sharedPrefix` / `more` 四个键。 */
const JOINERS = {
  zh: { joinTwo: '{first}并{second}', comma: '，', sharedPrefix: '已', more: '{title}等' },
  en: { joinTwo: '{first} and {second}', comma: ', ', sharedPrefix: '', more: '{title}, etc.' },
}

/** 明细取值优先级，与客户端 `LIVE_TOOL_DETAIL_KEYS` 同序。 */
const DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name',
  'question', 'questions', 'prompt', 'message', 'command', 'cmd',
  'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path',
  'target', 'action', 'status',
]

/** 折叠空白并按字素截断——客户端用 Intl.Segmenter，这里用 Array.from 等价。 */
export function normalizeDetail(value) {
  const text = (typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value.join(', ')
      : ''
  ).replace(/\s+/g, ' ').trim()
  const chars = Array.from(text)
  if (chars.length <= DETAIL_MAX_CHARS) return text
  return `${chars.slice(0, DETAIL_MAX_CHARS - 1).join('').trimEnd()}…`
}

function questionDetail(value) {
  if (!Array.isArray(value)) return ''
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const detail = normalizeDetail(item.question)
    if (detail !== '') return detail
  }
  return ''
}

/**
 * 从工具参数里取一行明细，取不到就退回工具名。
 * 参数不是合法 JSON（流式截断、空串）时同样退回工具名。
 */
export function liveToolDetail(name, argsRaw) {
  let args
  try {
    args = JSON.parse(argsRaw)
  } catch {
    return normalizeDetail(name)
  }
  if (args === null || typeof args !== 'object') return normalizeDetail(name)
  for (const key of DETAIL_KEYS) {
    if (!(key in args)) continue
    const value = args[key]
    const detail = key === 'questions' ? questionDetail(value) : normalizeDetail(value)
    if (detail !== '') return detail
  }
  return normalizeDetail(name)
}

/**
 * 把排好序的类别计数拼成一行标题。逐字对齐客户端 `processTitle`：
 * 空 → 已完成分析；一类直出；两类用「并」，两边都以「已」开头时省掉第二个的前缀；
 * 三类及以上用「，」连接，类别总数超过三时补「等」。
 */
export function processTitle(counts, lang = 'zh') {
  const done = (DONE_LABELS[lang] ?? DONE_LABELS.zh)
  const join = JOINERS[lang] ?? JOINERS.zh
  const labels = counts.slice(0, 3).map(({ kind }) => done[kind] ?? done.tools)
  const first = labels[0]
  if (first === undefined) return done.thinking
  // 客户端的 continuation 是「首字母小写」，对中文是恒等；英文才起作用。
  const continuation = (label) => label.charAt(0).toLowerCase() + label.slice(1)
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    const { sharedPrefix } = join
    const stripped = sharedPrefix !== '' && first.startsWith(sharedPrefix) && second.startsWith(sharedPrefix)
      ? second.slice(sharedPrefix.length)
      : second
    return join.joinTwo.replace('{first}', first).replace('{second}', continuation(stripped))
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(join.comma)
  return counts.length > 3 ? join.more.replace('{title}', title) : title
}

/**
 * 按「出现次数降序、同次数先出现者在前」排序，与客户端
 * `sort((a, b) => b.count - a.count)` + Map 插入序一致。
 */
export function rankCounts(counts, firstSeen) {
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => (b.count - a.count) || ((firstSeen.get(a.kind) ?? 0) - (firstSeen.get(b.kind) ?? 0)))
}

/**
 * 跟踪一个会话当前这一轮的工具活动，产出卡片第二行要的两样东西：
 * 一行标题（`已完成分析` / `修改了文件，已读取文件，执行了命令等`）和对应图标类别。
 *
 * 只按 `turn/start` 重置计数——DSH 界面是按「回复块」切分组，
 * 桌宠要的是「这一轮干了什么」，跨度取整轮更稳也更不容易空。
 */
export class StepTracker {
  constructor(lang = 'zh') {
    this.lang = lang
    this.reset()
  }

  reset() {
    /** @type {Map<string, number>} 类别 → 次数 */
    this.counts = new Map()
    /** @type {Map<string, number>} 类别 → 首次出现的序号，用于同次数时定序 */
    this.firstSeen = new Map()
    this.order = 0
    /** 本轮累计的推理文本（实时流） */
    this.reasoning = ''
    /** 本轮累计的助手正文（实时流） */
    this.text = ''
    /** 当前正在跑的工具类别 */
    this.runningKind = ''
    /** 当前正在跑的工具明细 */
    this.runningDetail = ''
  }

  /** 记一次工具调用。`name` 是工具名，`argsRaw` 是原始 JSON 字符串。 */
  noteToolCall(name, argsRaw) {
    const kind = toolKind(name)
    if (!this.firstSeen.has(kind)) this.firstSeen.set(kind, this.order++)
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1)
    this.runningKind = kind
    this.runningDetail = liveToolDetail(name, argsRaw)
    // 开始动手了，之前那段推理不再是「正在发生的事」
    this.reasoning = ''
    this.text = ''
  }

  /** 工具跑完了——清掉「正在跑」，但计数保留（它已经发生过了）。 */
  clearRunning() {
    this.runningKind = ''
    this.runningDetail = ''
  }

  /** 追加一段实时推理。缓冲区设上限，长回合不至于无限膨胀。 */
  appendReasoning(delta) {
    this.reasoning = capBuffer(this.reasoning + (delta ?? ''))
  }

  /** 追加一段实时正文。 */
  appendText(delta) {
    this.text = capBuffer(this.text + (delta ?? ''))
  }

  /**
   * 提交态的助手正文。流已经推过就不覆盖（保留更细的实时版本），
   * 只在没有流可听的路径（历史回放等）上兜底。
   */
  noteAssistantText(text) {
    if (this.text.trim() !== '') return
    const value = normalizeDetail(text)
    if (value !== '') this.text = value
  }

  /** 新的流式尝试开始：上一段已经结束，清掉实时文本。 */
  beginStream() {
    this.reasoning = ''
    this.text = ''
  }

  /**
   * 实时的「在说什么」。优先推理，其次正文——两者都取最后一段（空行分段），
   * 与客户端 `liveReasoningDetail` 的取法一致（它也是倒着找第一段非空文本）。
   * 顺手去掉 `**` 这类 markdown 标记。
   */
  liveText() {
    for (const raw of [this.reasoning, this.text]) {
      if (raw.trim() === '') continue
      const paragraphs = raw.replaceAll('**', '').split(/\r?\n[\t ]*\r?\n/)
      for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
        const detail = normalizeDetail(paragraphs[i])
        if (detail !== '') return detail
      }
    }
    return ''
  }

  /** 本轮的聚合摘要：类别标题 + 图标。 */
  summary() {
    const ranked = rankCounts(this.counts, this.firstSeen)
    const top = ranked[0]?.kind ?? 'thinking'
    return {
      kind: top,
      icon: PROCESS_ICONS[top] ?? PROCESS_ICONS.tools,
      title: processTitle(ranked, this.lang),
    }
  }

  /**
   * 给卡片用的快照。第一行是会话标题（由宿主的活动看板提供），这里是第二行：
   *
   *   1. 有工具在跑   → 「运行 pnpm test」「读取 lib/pet.ps1」——具体在干什么
   *   2. 模型在生成   → 实时的推理 / 正文末段
   *   3. 都没有       → 回退聚合摘要（「修改了文件，已读取文件，执行了命令等」）
   */
  snapshot() {
    const summary = this.summary()
    const running = this.runningKind !== ''

    if (running) {
      const verb = kindVerb(this.runningKind, this.lang)
      return {
        detail: this.runningDetail ? `${verb} ${this.runningDetail}` : verb,
        icon: PROCESS_ICONS[this.runningKind] ?? summary.icon,
        kind: this.runningKind,
        running: true,
        runningDetail: this.runningDetail,
        summary: summary.title,
      }
    }

    const live = this.liveText()
    return {
      detail: live !== '' ? live : summary.title,
      icon: live !== '' ? PROCESS_ICONS.thinking : summary.icon,
      kind: live !== '' ? 'thinking' : summary.kind,
      running: false,
      runningDetail: '',
      summary: summary.title,
    }
  }
}

/** 实时文本缓冲上限——长回合下没必要留住整段推理。 */
const BUFFER_MAX_CHARS = 4000

function capBuffer(value) {
  const chars = Array.from(String(value ?? ''))
  return chars.length <= BUFFER_MAX_CHARS ? chars.join('') : chars.slice(-BUFFER_MAX_CHARS).join('')
}

/** 从 `assistant/message` 事件里抽出正文文本（只取 text 块）。 */
export function assistantTextOf(event) {
  const blocks = event?.data?.message?.content
  if (Array.isArray(blocks)) {
    const text = blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    if (text.trim() !== '') return text
  }
  // 有些路径正文只在流记录里（assistant/attempt 不会带 message）
  const stream = event?.data?.stream
  if (Array.isArray(stream)) {
    const text = stream
      .filter((record) => record && record.type === 'text-chunks' && Array.isArray(record.texts))
      .map((record) => record.texts.join(''))
      .join('')
    if (text.trim() !== '') return text
  }
  return ''
}
