import type { SessionTreePayload, SessionTreeSerialNode, TreeFilterMode } from '../types/session'

/**
 * Session-tree projection for the desktop panel.
 *
 * Mirrors misaka/ui/tui/interactive/components/tree_selector.py so both front ends agree on what
 * a "no-tools" filter hides and when a branch is indented. The rules are duplicated rather than
 * shared because the TUI walks SessionTreeNode dataclasses while this side receives plain JSON.
 */

export const TREE_FILTER_MODES: TreeFilterMode[] = ['default', 'no-tools', 'user-only', 'labeled-only', 'all']

/** Entry types the TUI treats as bookkeeping rather than conversation. */
const SETTINGS_ENTRY_TYPES = new Set(['label', 'custom', 'model_change', 'thinking_level_change', 'session_info'])

export interface FlatRow {
  id: string
  /** The entry's real parent, which may not be the row rendered above it after filtering. */
  parentId: string | null
  /** Visual indent. Chains of only children do not deepen. */
  depth: number
  entry: Record<string, any>
  label: string | null
  labelTimestamp: string | null
  isLeaf: boolean
  onActivePath: boolean
  /** Visible rows sit beneath this one, so folding it changes the list. */
  foldable: boolean
  /** This row is folded and its visible descendants are hidden. */
  collapsed: boolean
  /** How many rows this fold currently hides. */
  hiddenCount: number
  isLastChild: boolean
  /** A filtered or searched result whose real parent is not on screen. */
  truncatedBranch: boolean
}

export interface SelectOptions {
  mode: TreeFilterMode
  query?: string
  collapsed?: Set<string>
}

interface Index {
  nodeById: Map<string, SessionTreeSerialNode>
  realParent: Map<string, string | null>
  activePath: Set<string>
  leafId: string | null
}

function entryId(node: SessionTreeSerialNode | undefined): string | null {
  const id = node?.entry?.id
  return typeof id === 'string' ? id : null
}

function childrenOf(node: SessionTreeSerialNode | undefined): SessionTreeSerialNode[] {
  return Array.isArray(node?.children) ? node.children.filter(Boolean) : []
}

function roleOf(entry: Record<string, any> | undefined): string {
  const message = entry?.message
  return message && typeof message === 'object' && typeof message.role === 'string' ? message.role : ''
}

/** Text of a message content value: a bare string, or the text blocks of a content list. */
export function contentText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && typeof block === 'object' && block.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('')
}

/** The TUI hides an assistant turn that produced neither text nor a real stop reason. */
function isHollowAssistant(entry: Record<string, any>, isLeaf: boolean): boolean {
  if (entry?.type !== 'message' || roleOf(entry) !== 'assistant') return false
  if (isLeaf) return false
  const message = entry.message ?? {}
  const hasText = contentText(message.content).trim().length > 0
  const stopReason = message.stopReason
  const isErrorOrAborted = typeof stopReason === 'string' && stopReason !== 'stop' && stopReason !== 'toolUse'
  return !hasText && !isErrorOrAborted
}

function passesFilter(node: SessionTreeSerialNode, mode: TreeFilterMode, leafId: string | null): boolean {
  const entry = node?.entry ?? {}
  const id = entryId(node)
  if (isHollowAssistant(entry, id !== null && id === leafId)) return false

  const isSettingsEntry = SETTINGS_ENTRY_TYPES.has(String(entry.type))
  switch (mode) {
    case 'user-only':
      return entry.type === 'message' && roleOf(entry) === 'user'
    case 'no-tools':
      return !isSettingsEntry && !(entry.type === 'message' && roleOf(entry) === 'toolResult')
    case 'labeled-only':
      return node.label != null
    case 'all':
      return true
    default:
      return !isSettingsEntry
  }
}

/** Everything the TUI's search reaches, appended in the same order. */
export function nodeSearchableText(row: FlatRow): string {
  const entry = row.entry ?? {}
  const parts: string[] = []
  if (row.label) parts.push(row.label)

  switch (entry.type) {
    case 'message': {
      const role = roleOf(entry)
      if (role) parts.push(role)
      if (entry.message?.content) parts.push(contentText(entry.message.content))
      if (role === 'bashExecution' && typeof entry.message?.command === 'string') parts.push(entry.message.command)
      break
    }
    case 'custom_message':
      if (typeof entry.customType === 'string') parts.push(entry.customType)
      parts.push(typeof entry.content === 'string' ? entry.content : contentText(entry.content))
      break
    case 'compaction':
      parts.push('compaction')
      break
    case 'branch_summary':
      parts.push('branch summary', String(entry.summary ?? ''))
      break
    case 'session_info':
      parts.push('title', String(entry.name ?? ''))
      break
    case 'model_change':
      parts.push('model', String(entry.modelId ?? ''))
      break
    case 'thinking_level_change':
      parts.push('thinking', String(entry.thinkingLevel ?? ''))
      break
    case 'custom':
      parts.push('custom', String(entry.customType ?? ''))
      break
    case 'label':
      parts.push('label', String(entry.label ?? ''))
      break
    default:
      break
  }
  return parts.filter(Boolean).join(' ')
}

/** The text the TUI's copy action would put on the clipboard, or null when there is none. */
export function nodeCopyText(row: FlatRow): string | null {
  const entry = row.entry ?? {}
  let text: string | null = null

  if (entry.type === 'message') {
    const message = entry.message ?? {}
    if (message.role === 'bashExecution') {
      text = typeof message.command === 'string' ? message.command : null
    } else if ('content' in message) {
      text = contentText(message.content)
      if (!text && message.role === 'assistant') text = message.errorMessage ?? null
    }
  } else if (entry.type === 'custom_message') {
    text = typeof entry.content === 'string' ? entry.content : contentText(entry.content)
  } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    text = typeof entry.summary === 'string' ? entry.summary : null
  }

  return typeof text === 'string' && text.trim() ? text : null
}

function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 120 ? collapsed.slice(0, 119) + '\u2026' : collapsed
}

/** A one-line preview for the list, tagged so the row knows what it is reading. */
export function nodePreview(row: FlatRow): { kind: string; text: string } {
  const entry = row.entry ?? {}
  const kind = roleBadge(row)

  switch (entry.type) {
    case 'message': {
      const message = entry.message ?? {}
      if (message.role === 'bashExecution') return { kind, text: oneLine(String(message.command ?? '')) }
      const text = oneLine(contentText(message.content))
      if (text) return { kind, text }
      if (message.errorMessage) return { kind, text: oneLine(String(message.errorMessage)) }
      return { kind, text: String(message.stopReason ?? '') }
    }
    case 'custom_message':
      return { kind, text: oneLine(typeof entry.content === 'string' ? entry.content : contentText(entry.content)) }
    case 'compaction':
    case 'branch_summary':
      return { kind, text: oneLine(String(entry.summary ?? '')) }
    case 'label':
      return { kind, text: oneLine(String(entry.label ?? '(已清除)')) }
    case 'session_info':
      return { kind, text: oneLine(String(entry.name ?? '')) }
    case 'model_change':
      return { kind, text: oneLine(String(entry.modelId ?? '')) }
    case 'thinking_level_change':
      return { kind, text: oneLine(String(entry.thinkingLevel ?? '')) }
    case 'custom':
      return { kind, text: oneLine(String(entry.customType ?? '')) }
    default:
      return { kind, text: oneLine(String(entry.type ?? '')) }
  }
}

/** Short Chinese badge for a row, matching what the TUI prints in brackets. */
export function roleBadge(row: FlatRow): string {
  const entry = row.entry ?? {}
  if (entry.type === 'message') {
    switch (roleOf(entry)) {
      case 'user': return '用户'
      case 'assistant': return '助手'
      case 'toolResult': return '工具'
      case 'bashExecution': return '命令'
      case 'system': return '系统'
      case 'custom': return '提示'
      default: return '消息'
    }
  }
  switch (entry.type) {
    case 'custom_message': return '提示'
    case 'compaction': return '压缩'
    case 'branch_summary': return '分支摘要'
    case 'label': return '标签'
    case 'session_info': return '标题'
    case 'model_change': return '模型'
    case 'thinking_level_change': return '思考'
    case 'custom': return '自定义'
    default: return '记录'
  }
}

function indexTree(tree: SessionTreeSerialNode[], leafId: string | null): Index {
  const nodeById = new Map<string, SessionTreeSerialNode>()
  const realParent = new Map<string, string | null>()
  const activePath = new Set<string>()

  const visit = (nodes: SessionTreeSerialNode[], parentId: string | null) => {
    for (const node of nodes) {
      const id = entryId(node)
      if (!id) continue
      nodeById.set(id, node)
      realParent.set(id, parentId)
      visit(childrenOf(node), id)
    }
  }
  visit(tree, null)

  let current = leafId
  while (current && !activePath.has(current)) {
    activePath.add(current)
    current = realParent.get(current) ?? null
  }
  return { nodeById, realParent, activePath, leafId }
}

/** Siblings holding the current leaf come first; timestamps otherwise decide. */
function orderSiblings(nodes: SessionTreeSerialNode[], activePath: Set<string>): SessionTreeSerialNode[] {
  const rank = (node: SessionTreeSerialNode) => {
    const id = entryId(node)
    return id !== null && activePath.has(id) ? 0 : 1
  }
  return [...nodes].sort((a, b) => rank(a) - rank(b))
}

function toRow(node: SessionTreeSerialNode, info: Index, depth: number, isLastChild: boolean, truncatedBranch: boolean): FlatRow {
  const id = entryId(node) as string
  return {
    id,
    parentId: info.realParent.get(id) ?? null,
    depth,
    entry: node.entry ?? {},
    label: node.label ?? null,
    labelTimestamp: node.labelTimestamp ?? null,
    isLeaf: id === info.leafId,
    onActivePath: info.activePath.has(id),
    foldable: false,
    collapsed: false,
    hiddenCount: 0,
    isLastChild,
    truncatedBranch,
  }
}

/**
 * The unfiltered structural list, in the TUI's preorder with the active branch first.
 *
 * Depth only grows at a real fork: a chain of single children continues its parent's line, which
 * keeps a long linear transcript flat instead of stair-stepping one level per message.
 */
export function flattenTree(payload: SessionTreePayload | null): FlatRow[] {
  const tree = payload?.tree ?? []
  const info = indexTree(tree, payload?.leafId ?? null)
  const positions: Array<{ id: string; depth: number; isLastChild: boolean }> = []

  const walk = (nodes: SessionTreeSerialNode[], depth: number) => {
    const ordered = orderSiblings(nodes, info.activePath)
    ordered.forEach((node, index) => {
      const id = entryId(node)
      if (!id) return
      positions.push({ id, depth, isLastChild: index === ordered.length - 1 })
      const children = childrenOf(node)
      walk(children, children.length > 1 ? depth + 1 : depth)
    })
  }
  walk(tree, 0)

  const descendantCount = (node: SessionTreeSerialNode): number =>
    childrenOf(node).reduce((total, child) => total + 1 + descendantCount(child), 0)

  return positions.map(position => {
    const node = info.nodeById.get(position.id) as SessionTreeSerialNode
    const row = toRow(node, info, position.depth, position.isLastChild, false)
    row.foldable = descendantCount(node) > 0
    return row
  })
}

/**
 * Rows the panel shows for one filter mode, search query and fold set.
 *
 * Filtering is per entry, exactly like the TUI: a visible row whose parent was filtered out is
 * re-parented onto its nearest visible ancestor and flagged truncatedBranch.
 */
export function selectRows(payload: SessionTreePayload | null, options: SelectOptions): FlatRow[] {
  const tree = payload?.tree ?? []
  const leafId = payload?.leafId ?? null
  const info = indexTree(tree, leafId)
  const collapsed = options.collapsed ?? new Set<string>()
  const tokens = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)

  const matches = (node: SessionTreeSerialNode): boolean => {
    if (!passesFilter(node, options.mode, leafId)) return false
    if (!tokens.length) return true
    const probe = toRow(node, info, 0, true, false)
    const haystack = nodeSearchableText(probe).toLowerCase()
    return tokens.every(token => haystack.includes(token))
  }

  const visible = new Set<string>()
  const hiddenBy = new Map<string, number>()
  const collect = (nodes: SessionTreeSerialNode[], hiddenUnder: string | null) => {
    for (const node of orderSiblings(nodes, info.activePath)) {
      const id = entryId(node)
      if (!id) continue
      const matched = matches(node)
      if (matched) {
        if (hiddenUnder) hiddenBy.set(hiddenUnder, (hiddenBy.get(hiddenUnder) ?? 0) + 1)
        else visible.add(id)
      }
      // A fold only hides matches; it does not stop the search from reaching deeper content.
      const nextHidden = hiddenUnder ?? (matched && collapsed.has(id) ? id : null)
      collect(childrenOf(node), nextHidden)
    }
  }
  collect(tree, null)

  const visibleParent = new Map<string, string | null>()
  const visibleRootIds: string[] = []
  for (const id of visible) {
    let ancestor = info.realParent.get(id) ?? null
    while (ancestor && !visible.has(ancestor)) ancestor = info.realParent.get(ancestor) ?? null
    visibleParent.set(id, ancestor)
    if (!ancestor) visibleRootIds.push(id)
  }

  const visibleChildren = new Map<string, string[]>()
  for (const [id, parent] of visibleParent) {
    if (!parent) continue
    const siblings = visibleChildren.get(parent) ?? []
    siblings.push(id)
    visibleChildren.set(parent, siblings)
  }

  const rows: FlatRow[] = []
  const emit = (ids: string[], depth: number) => {
    const ordered = orderSiblings(
      ids.map(id => info.nodeById.get(id)).filter(Boolean) as SessionTreeSerialNode[],
      info.activePath,
    ).map(node => entryId(node) as string)
    ordered.forEach((id, index) => {
      const node = info.nodeById.get(id) as SessionTreeSerialNode
      const children = visibleChildren.get(id) ?? []
      const row = toRow(node, info, depth, index === ordered.length - 1,
        (visibleParent.get(id) ?? null) !== (info.realParent.get(id) ?? null))
      const hidden = hiddenBy.get(id) ?? 0
      const descendants = visibleChildren.get(id) ?? []
      row.hiddenCount = hidden
      row.collapsed = hidden > 0
      row.foldable = descendants.length > 0 || hidden > 0
      rows.push(row)
      emit(children, children.length > 1 ? depth + 1 : depth)
    })
  }
  emit(visibleRootIds, 0)
  return rows
}
