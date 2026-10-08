import { describe, expect, it } from 'vitest'
import type { SessionTreePayload } from '../types/session'
import { flattenTree, nodeCopyText, nodePreview, roleBadge, selectRows } from './sessionTree'

interface Node { id: string; type?: string; role?: string; text?: string; stopReason?: string;
  toolResult?: boolean; label?: string | null; children?: Node[] }

function entryOf(node: Node) {
  const type = node.type ?? 'message'
  if (type !== 'message') return { type, id: node.id, ...(node.text ? { summary: node.text } : {}) }
  return {
    type: 'message',
    id: node.id,
    message: {
      role: node.role ?? 'user',
      content: node.text === undefined ? [] : [{ type: 'text', text: node.text }],
      ...(node.stopReason ? { stopReason: node.stopReason } : {}),
    },
  }
}

function serial(node: Node): any {
  return {
    entry: entryOf(node),
    label: node.label ?? null,
    labelTimestamp: node.label ? '2026-10-05T10:00:00.000Z' : null,
    children: (node.children ?? []).map(serial),
  }
}

function payload(roots: Node[], leafId: string | null): SessionTreePayload {
  return { sessionId: 's', sessionFile: null, historyVersion: null, leafId, tree: roots.map(serial) }
}

/** A transcript with one fork: a1 -> a2 -> (a3 | b3). */
function forked(): SessionTreePayload {
  return payload([
    { id: 'root', children: [
      { id: 'a1', children: [
        { id: 'a2', children: [
          { id: 'b3', role: 'assistant', text: '旧分支' },
          { id: 'a3', role: 'assistant', text: '当前分支' },
        ] },
      ] },
    ] },
  ], 'a3')
}

const ids = (rows: { id: string }[]) => rows.map(row => row.id)

describe('session tree projection', () => {
  it('keeps a single-child chain flat and indents only at a fork', () => {
    const rows = flattenTree(forked())
    expect(ids(rows)).toEqual(['root', 'a1', 'a2', 'a3', 'b3'])
    const depth = Object.fromEntries(rows.map(row => [row.id, row.depth]))
    expect(depth.root).toBe(0)
    expect(depth.a1).toBe(0)
    expect(depth.a2).toBe(0)
    // The fork is where depth appears, and the active branch is listed first.
    expect(depth.a3).toBe(1)
    expect(depth.b3).toBe(1)
    expect(rows[3].id).toBe('a3')
  })

  it('marks the current leaf and its active path', () => {
    const rows = flattenTree(forked())
    const leaf = rows.find(row => row.isLeaf)
    expect(leaf?.id).toBe('a3')
    expect(Object.fromEntries(rows.map(row => [row.id, row.onActivePath]))).toMatchObject({
      root: true, a1: true, a2: true, a3: true, b3: false,
    })
  })

  it('hides bookkeeping entries by default but keeps conversation', () => {
    const tree = payload([
      { id: 'u1', role: 'user', text: '问题' },
      { id: 'a1', role: 'assistant', text: '回答' },
      { id: 'm1', type: 'model_change', text: 'x' },
      { id: 't1', role: 'toolResult', text: '结果' },
    ], 'u1')
    expect(ids(selectRows(tree, { mode: 'default' }))).toEqual(['u1', 'a1', 't1'])
    expect(ids(selectRows(tree, { mode: 'no-tools' }))).toEqual(['u1', 'a1'])
    expect(ids(selectRows(tree, { mode: 'user-only' }))).toEqual(['u1'])
    expect(ids(selectRows(tree, { mode: 'all' }))).toEqual(['u1', 'a1', 'm1', 't1'])
  })

  it('hides an assistant turn that produced no text unless it stopped in error', () => {
    const tree = payload([
      { id: 'u1', role: 'user', text: '问' },
      { id: 'empty', role: 'assistant' },
      { id: 'failed', role: 'assistant', stopReason: 'error' },
    ], 'u1')
    expect(ids(selectRows(tree, { mode: 'default' }))).toEqual(['u1', 'failed'])
  })

  it('keeps the leaf assistant turn even when it is still empty', () => {
    const tree = payload([
      { id: 'u1', role: 'user', text: '问' },
      { id: 'streaming', role: 'assistant' },
    ], 'streaming')
    // Siblings holding the active leaf are listed first, exactly as the TUI orders them.
    expect(ids(selectRows(tree, { mode: 'default' }))).toEqual(['streaming', 'u1'])
  })

  it('filters to labeled rows only', () => {
    const tree = payload([
      { id: 'u1', role: 'user', text: '问' },
      { id: 'u2', role: 'user', text: '带标签', label: '关键' },
    ], 'u1')
    expect(ids(selectRows(tree, { mode: 'labeled-only' }))).toEqual(['u2'])
  })

  it('requires every search token to appear', () => {
    const tree = payload([
      { id: 'u1', role: 'user', text: '分析 实验 数据' },
      { id: 'u2', role: 'user', text: '分析 图表' },
    ], 'u1')
    expect(ids(selectRows(tree, { mode: 'default', query: '分析' }))).toEqual(['u1', 'u2'])
    expect(ids(selectRows(tree, { mode: 'default', query: '分析 实验' }))).toEqual(['u1'])
    expect(ids(selectRows(tree, { mode: 'default', query: 'ANALYSIS' }))).toEqual([])
  })

  it('searches labels and the role name too', () => {
    const tree = payload([
      { id: 'u1', role: 'user', text: 'x', label: '起点' },
      { id: 'u2', role: 'assistant', text: 'y' },
    ], 'u1')
    expect(ids(selectRows(tree, { mode: 'labeled-only', query: '起点' }))).toEqual(['u1'])
    expect(ids(selectRows(tree, { mode: 'default', query: 'assistant' }))).toEqual(['u2'])
  })

  it('hides the rows under a collapsed fold and reports the count', () => {
    const tree = forked()
    const rows = selectRows(tree, { mode: 'default', collapsed: new Set(['a2']) })
    expect(ids(rows)).toEqual(['root', 'a1', 'a2'])
    const fold = rows.find(row => row.id === 'a2')
    expect(fold?.collapsed).toBe(true)
    expect(fold?.hiddenCount).toBe(2)
    expect(fold?.foldable).toBe(true)
  })

  it('re-parents a search result onto its nearest visible ancestor', () => {
    const rows = selectRows(forked(), { mode: 'default', query: '当前分支' })
    expect(ids(rows)).toEqual(['a3'])
    expect(rows[0].truncatedBranch).toBe(true)
    expect(rows[0].depth).toBe(0)
  })

  it('exposes the text a row would copy, per entry type', () => {
    const rows = flattenTree(payload([
      { id: 'u1', role: 'user', text: '用户文本' },
      { id: 'a1', role: 'assistant', text: '助手文本' },
      { id: 'c1', type: 'compaction', text: '压缩摘要' },
      { id: 'b1', type: 'branch_summary', text: '分支摘要' },
      { id: 'm1', type: 'model_change', text: 'x' },
    ], 'u1'))
    const byId = Object.fromEntries(rows.map(row => [row.id, row]))
    expect(nodeCopyText(byId.u1)).toBe('用户文本')
    expect(nodeCopyText(byId.a1)).toBe('助手文本')
    expect(nodeCopyText(byId.c1)).toBe('压缩摘要')
    expect(nodeCopyText(byId.b1)).toBe('分支摘要')
    expect(nodeCopyText(byId.m1)).toBeNull()
  })

  it('falls back to the error message for a failed assistant turn', () => {
    const rows = flattenTree({ sessionId: 's', sessionFile: null, historyVersion: null, leafId: 'e1',
      tree: [{ entry: { type: 'message', id: 'e1', message: { role: 'assistant', content: [], errorMessage: '连接失败' } },
        label: null, labelTimestamp: null, children: [] }] })
    expect(nodeCopyText(rows[0])).toBe('连接失败')
    expect(nodePreview(rows[0]).text).toBe('连接失败')
  })

  it('badges each entry type for the list', () => {
    const rows = flattenTree(payload([
      { id: 'u1', role: 'user', text: 'a' },
      { id: 'a1', role: 'assistant', text: 'b' },
      { id: 't1', role: 'toolResult', text: 'c' },
      { id: 'c1', type: 'compaction', text: 'd' },
      { id: 'b1', type: 'branch_summary', text: 'e' },
    ], 'u1'))
    const badges = Object.fromEntries(rows.map(row => [row.id, roleBadge(row)]))
    expect(badges).toMatchObject({ u1: '用户', a1: '助手', t1: '工具', c1: '压缩', b1: '分支摘要' })
  })

  it('collapses whitespace and truncates a long preview', () => {
    const long = 'x'.repeat(400)
    const rows = flattenTree(payload([{ id: 'u1', role: 'user', text: 'a\n\n  b  ' + long }], 'u1'))
    const preview = nodePreview(rows[0]).text
    expect(preview.startsWith('a b ')).toBe(true)
    expect(preview.length).toBe(120)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('tolerates an empty or missing payload', () => {
    expect(flattenTree(null)).toEqual([])
    expect(selectRows(null, { mode: 'default' })).toEqual([])
    expect(selectRows({ sessionId: 's', sessionFile: null, historyVersion: null, leafId: null, tree: [] },
      { mode: 'all' })).toEqual([])
  })
})
