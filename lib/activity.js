/**
 * dsh-qoduck-pet — 活动卡片的数据面。
 *
 * 桌宠窗口是独立进程，拿不到 Cordis 上下文，所以卡片内容由宿主侧算好后写进
 * `activity.json`，窗口只负责画。这个模块负责「算」这一半：
 *
 *   会话事件 ──► 逐会话条目 ──► 卡片快照（按活跃度排序，只留有意义的几条）
 *
 * 对应 Qoder 活动卡片的字段：title / status / detail / canStop / canReply。
 *
 * @module dsh-qoduck-pet/activity
 */

/** 卡片上最多同时列几条会话。 */
export const MAX_CARDS = 4
/**
 * 回合结束后条目的保留时长。
 * 这个值要明显长于窗口侧的自动收起阈值（4 分钟）：先由窗口收起卡片，
 * 条目之后再自然过期，避免「卡片还开着但数据已经被丢掉」的闪断。
 */
export const SETTLE_HOLD_MS = 6 * 60_000
/** 明细行总长度上限。 */
export const DETAIL_MAX_CHARS = 56

/**
 * 参数里最像「这一步在干什么」的字段，按优先级排列。
 * 「找什么 / 查什么 / 跑什么」排在「在哪找」前面——前者更说明动作本身。
 * 取不到就退回第一个字符串值。
 */
const DETAIL_KEYS = [
  'query', 'url', 'command', 'cmd', 'pattern', 'prompt', 'text',
  'file_path', 'filePath', 'path', 'description', 'title', 'name',
]

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= max) return value
  return value.slice(0, Math.max(1, max - 1)) + '…'
}

/**
 * 把一次工具调用压成卡片明细行，例如：
 *   WebSearch + {"query":"今天的AI新闻"}  → "WebSearch. 今天的AI新闻"
 *   Bash      + {"command":"pnpm test"}   → "Bash. pnpm test"
 *
 * 参数不是合法 JSON（流式截断、非对象）时退回工具名本身。
 */
export function describeTool(name, argsJson, maxChars = DETAIL_MAX_CHARS) {
  const tool = String(name ?? '').trim() || '工具'
  let args = null
  if (typeof argsJson === 'string' && argsJson.trim() !== '') {
    try {
      const parsed = JSON.parse(argsJson)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
    } catch {
      // 参数还没流完或不是 JSON，退回只看工具名
    }
  }
  if (!args) return clip(tool, maxChars)

  let picked = ''
  for (const key of DETAIL_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') {
      picked = value
      break
    }
  }
  if (!picked) {
    for (const value of Object.values(args)) {
      if (typeof value === 'string' && value.trim() !== '') {
        picked = value
        break
      }
    }
  }
  if (!picked) return clip(tool, maxChars)

  // 留出 "工具名. " 的位置，明细本身再截一次
  const prefix = tool + '. '
  const room = Math.max(8, maxChars - prefix.length)
  return clip(prefix + clip(picked, room), maxChars)
}

/**
 * 回合结束原因 → 卡片状态。
 *
 * 与桌宠姿态用的是同一套语义，但卡片只关心「这一轮结果如何」：
 *   completed → completed，error → failed，用户中断 → interrupted，
 *   会话生命周期（parent/disposed/hook）与 blocked/forked 不算失败。
 */
export function statusFromTurnEnd(reason) {
  const kind = reason && reason.kind
  if (kind === 'completed') return 'completed'
  if (kind === 'error') return 'failed'
  if (kind === 'interrupted') return 'interrupted'
  if (kind === 'aborted') {
    const cause = reason.reason && reason.reason.kind
    return cause === 'user' ? 'interrupted' : 'completed'
  }
  if (kind === 'max-tokens') return 'completed'
  if (kind === 'blocked' || kind === 'forked') return 'completed'
  return null
}

/**
 * 会话头 → 是不是子会话。
 *
 * 只能看 header：子会话 id 常是裸 UUID、主会话常是 `session-xxx`，但这只是
 * 现状不是契约，拿 id 前缀判主次迟早翻车。`parentSession` 与
 * `origin === 'subagent'` 才是宿主给的定义。
 */
export function isChildHeader(header) {
  if (!header || typeof header !== 'object') return false
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (header.origin === 'subagent') return true
  // 被派生的会话深度大于 0；主会话是 0 或没有这个字段
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/** 这一条是否「正在忙」：跑着或在等用户。已结束的不算。 */
function isEntryActive(entry) {
  return entry.running || entry.waiting || entry.status === 'running' || entry.status === 'waiting'
}

export class ActivityBoard {
  constructor(options = {}) {
    /** 读会话标题；拿不到就退回空串（卡片会显示 sessionId 短码）。 */
    this.readTitle = options.readTitle ?? (() => '')
    /** sessionId -> 条目 */
    this.entries = new Map()
  }

  #entry(sessionId) {
    let entry = this.entries.get(sessionId)
    if (!entry) {
      entry = {
        sessionId,
        title: '',
        running: false,
        waiting: false,
        status: 'idle',
        toolName: '',
        toolDetail: '',
        updatedAt: 0,
        /** 父会话 id；主会话为 null。决定这一条要不要单独占卡片。 */
        parentId: null,
        /** 是否子会话（由 header 判定，与父是否已登记无关）。 */
        isChild: false,
        /**
         * 是否见过真正的 session 对象（也就是读过 header）。
         *
         * 宿主里 `agent/status` 这类流只有 id、没有 session 对象，可能比
         * `session/created` 早一拍。没见过 header 就不知道是不是子会话，
         * 此时宁可不显示——漏一条远比弹一张写着派发提示的垃圾标题安全。
         */
        resolved: false,
      }
      this.entries.set(sessionId, entry)
    }
    return entry
  }

  /**
   * 只补登记父子关系，当拿不到完整 session 对象时用（例如状态流里只有 id）。
   * 一旦登记过就不再清空：子会话首次出现时 header 可能还没填全，
   * 之后只补不删，免得半路把子会话误判回主会话、冒出垃圾标题。
   */
  noteRelation(sessionId, header) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const entry = this.#entry(sessionId)
    if (!isChildHeader(header)) return entry
    entry.isChild = true
    const parent = typeof header.parentSession === 'string' ? header.parentSession : ''
    if (parent !== '') entry.parentId = parent
    return entry
  }

  /** 会话被创建或首次见到：登记并取标题。 */
  touch(sessionId, session) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    const entry = this.#entry(sessionId)
    // touch 是宿主侧的显式登记，说明这一条的主次身份可以上卡片了
    // （即使这一轮没带 session 对象，例如插件启用时补登记的既有会话）
    entry.resolved = true
    if (!session) return entry
    this.noteRelation(sessionId, session.header)
    if (!entry.isChild) {
      // 子会话不用取标题：它的首条消息是 system-reminder 那类派发提示，
      // 标题服务据此生成的标题对用户没有意义，反正也不会显示。
      try {
        const snapshot = this.readTitle(session)
        if (snapshot && typeof snapshot.title === 'string' && snapshot.title !== '') {
          entry.title = snapshot.title
        }
      } catch {
        // 标题服务不在或会话已冷，忽略
      }
    }
    return entry
  }

  drop(sessionId) {
    this.entries.delete(sessionId)
  }

  setRunning(sessionId, running) {
    const entry = this.#entry(sessionId)
    entry.running = !!running
    if (entry.running) {
      entry.status = 'running'
      entry.updatedAt = Date.now()
    } else if (entry.status === 'running') {
      // 回合结束事件还没到：先退回 idle，等 turn/end 给准确结果
      entry.status = 'idle'
      entry.updatedAt = Date.now()
    }
  }

  setWaiting(sessionId, waiting) {
    const entry = this.#entry(sessionId)
    entry.waiting = !!waiting
    if (entry.waiting) {
      entry.status = 'waiting'
      entry.updatedAt = Date.now()
    } else if (entry.status === 'waiting') {
      entry.status = entry.running ? 'running' : 'idle'
      entry.updatedAt = Date.now()
    }
  }

  noteToolCall(sessionId, name, argsJson) {
    const entry = this.#entry(sessionId)
    entry.toolName = String(name ?? '')
    entry.toolDetail = describeTool(name, argsJson)
    entry.updatedAt = Date.now()
  }

  clearTool(sessionId) {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.toolName = ''
    entry.toolDetail = ''
  }

  /** 一条已提交的会话事件。返回 true 表示卡片内容可能变了。 */
  noteEvent(sessionId, event) {
    if (!event || typeof event !== 'object') return false
    const entry = this.#entry(sessionId)
    const data = event.data ?? {}

    switch (event.type) {
      case 'turn/start':
        entry.status = 'running'
        entry.updatedAt = Date.now()
        return true
      case 'turn/end': {
        const status = statusFromTurnEnd(data.reason)
        if (status) entry.status = status
        entry.running = false
        entry.waiting = false
        entry.toolName = ''
        entry.toolDetail = ''
        entry.updatedAt = Date.now()
        return true
      }
      case 'tool/call':
        entry.toolName = String(data.name ?? '')
        entry.toolDetail = describeTool(data.name, data.arguments)
        if (entry.status === 'idle') entry.status = 'running'
        entry.updatedAt = Date.now()
        return true
      case 'tool/result':
        entry.toolName = ''
        entry.toolDetail = ''
        entry.updatedAt = Date.now()
        return true
      case 'approval/asked':
        entry.waiting = true
        entry.status = 'waiting'
        entry.updatedAt = Date.now()
        return true
      case 'approval/decided':
        entry.waiting = false
        entry.status = entry.running ? 'running' : 'idle'
        entry.updatedAt = Date.now()
        return true
      case 'session/title': {
        const title = typeof data.title === 'string' ? data.title : ''
        if (title) {
          entry.title = title
          return true
        }
        return false
      }
      default:
        return false
    }
  }

  /**
   * 可序列化的卡片快照。
   *
   * 卡片只服务于主智能体：子会话（子智能体 / 派发出来的会话）不单独占条目，
   * 它们的存在折叠进父会话标题的 `+N` 后缀。子会话的标题来自派发提示
   * （`<system-reminder> You are teammate ...`），对用户没有意义，一旦让它
   * 单独上榜还会因为更活跃而把主会话挤下去。
   *
   * 保留条件：正在跑、在等用户、刚结束不久，或者「有子会话在跑」——
   * 最后一条是补位：主会话在等子智能体时自己可能是 idle，此时不该整张卡片空掉。
   * 按活跃时间倒序，最多 MAX_CARDS 条。
   */
  snapshot(now = Date.now(), waitingCount = 0) {
    // 先按父会话汇总「还在忙的子会话」数量
    const busyChildren = new Map()
    const childrenLatestAt = new Map()
    for (const entry of this.entries.values()) {
      if (!entry.isChild || !entry.parentId) continue
      if (!isEntryActive(entry)) continue
      busyChildren.set(entry.parentId, (busyChildren.get(entry.parentId) ?? 0) + 1)
      const latest = Math.max(childrenLatestAt.get(entry.parentId) ?? 0, entry.updatedAt)
      childrenLatestAt.set(entry.parentId, latest)
    }

    const items = []
    for (const entry of this.entries.values()) {
      // 子会话永不单独上榜。父会话还没登记也不放它出来——宁可少一条，
      // 也不要让垃圾标题占住卡片第一行。
      if (entry.isChild) continue
      // 没见过 session 对象就不知道是不是子会话，先不上卡片
      if (!entry.resolved) continue

      const settled = entry.status === 'completed'
        || entry.status === 'failed'
        || entry.status === 'interrupted'
      const fresh = now - entry.updatedAt < SETTLE_HOLD_MS
      const active = isEntryActive(entry)
      const childCount = busyChildren.get(entry.sessionId) ?? 0
      // 等待还要兜住「主会话自己已 idle、但它的子智能体在等你」的情况：
      // 这时条目本身不 active，卡片却必须留着告诉用户该操作了。
      if (!active && childCount === 0 && waitingCount === 0 && !(settled && fresh)) continue

      // 标题保持纯净（只有会话标题本身），子智能体数量作为独立的 childCount
      // 字段交给渲染方。**不要**把「+N」拼进标题串：卡片标题会按宽度截断，
      // 拼进去就会跟着被省略掉，用户就看不到数量了（实测长标题会吃掉 +N）。
      const title = entry.title || shortId(entry.sessionId)

      // 主会话自己闲着但子会话在跑时，用子会话的时间参与排序，
      // 免得「正在干事的那一路」排到一个空转会话后面。
      const updatedAt = Math.max(entry.updatedAt, childrenLatestAt.get(entry.sessionId) ?? 0)

      // 有会话在等用户（审批或提问）——等待信号可能来自主会话自己，也可能来自
      // 它的子智能体（子会话不上卡片，所以这里统一由计数传导到活跃的主条目）。
      // 等待优先于运行：此时卡片的正确语义是「该你操作了」，不是「我在干活」。
      const status = waitingCount > 0 && active ? 'waiting' : (entry.status === 'idle' ? 'running' : entry.status)

      items.push({
        sessionId: entry.sessionId,
        title,
        status,
        detail: entry.toolDetail || '',
        canStop: status === 'running',
        canReply: true,
        updatedAt,
        childCount,
      })
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      items: items.slice(0, MAX_CARDS),
      total: items.length,
      updatedAt: new Date(now).toISOString(),
    }
  }
}

/** 没有标题时给个短码，别让卡片空着。 */
export function shortId(sessionId) {
  const text = String(sessionId ?? '')
  const tail = text.replace(/^session-/, '')
  return tail.length > 8 ? '会话 ' + tail.slice(0, 8) : '会话 ' + tail
}
