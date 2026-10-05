import React, { useEffect, useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Network, RefreshCw } from 'lucide-react'
import { ResearchNodeComponent } from './ResearchNodeComponent'
import { NodeDetailDrawer } from './NodeDetailDrawer'
import { useThemeTokens, withAlpha } from '../../theme/useThemeTokens'
import { useSessionStore } from '../../store/useSessionStore'
import type { ResearchGraphNode, ResearchGraphPayload, ResearchNodeData, ResearchNodeStatus } from '../../types/research'

const POLL_INTERVAL_MS = 4000

/** Node status → the four visual states the card understands. Anything transient is "running",
 *  the terminal trio keeps its own state, and everything not yet started reads as pending. */
function mapStatus(status: string): ResearchNodeStatus {
  switch (status) {
    case 'closed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'parked':
    case 'queued':
      return 'pending'
    default:
      // planning, executing, synthesizing, critiquing, diverging, deciding, filling_gaps,
      // disposing, waiting_input, awaiting_approval — all "working".
      return 'running'
  }
}

// Mirrors the themed chart palette (1/4/5/2/6) plus danger, so avatars follow the active
// theme. var() inside an inline background-color resolves at paint time, so this needs no
// JS re-read on a theme switch — and nothing feeds these into withAlpha(), which needs hex.
const AVATAR_COLORS = [
  'var(--chart-1)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-2)',
  'var(--chart-6)',
  'var(--danger)',
]

function avatarFor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

/** Map one real graph node onto the node card's data shape. */
function toNodeData(node: ResearchGraphNode): ResearchNodeData {
  const cards = node.cards || []
  const redTeam = node.red_team || null
  const assigneeId = redTeam?.assignee || cards[0]?.assignee || 'lo'
  return {
    id: node.id,
    kind: node.kind,
    title: node.question,
    question: node.question,
    assignee: {
      id: assigneeId,
      name: redTeam?.assignee ? `Sister ${redTeam.assignee}` : assigneeId === 'lo' ? 'Last Order' : `Sister ${assigneeId}`,
      role: redTeam ? '红队复审' : node.kind === 'root' ? '研究统筹' : node.kind === 'join' ? '汇合节点' : '研究分支',
      avatarBg: avatarFor(assigneeId),
    },
    status: mapStatus(node.status),
    depth: node.depth,
    summary: node.dissolves?.grounds || '',
    evidence: cards.map((c) => c.title).filter(Boolean),
  }
}

/** Lay the DAG out left-to-right by depth, spreading each depth's nodes vertically. */
function layoutNodes(nodes: ResearchGraphNode[]): Node<ResearchNodeData>[] {
  const byDepth = new Map<number, ResearchGraphNode[]>()
  for (const node of nodes) {
    const list = byDepth.get(node.depth) || []
    list.push(node)
    byDepth.set(node.depth, list)
  }
  const columns = [...byDepth.keys()].sort((a, b) => a - b)
  const out: Node<ResearchNodeData>[] = []
  for (const depth of columns) {
    const column = byDepth.get(depth)!
    column.forEach((node, index) => {
      out.push({
        id: node.id,
        type: 'researchNode',
        position: { x: 60 + depth * 400, y: 60 + index * 190 },
        data: toNodeData(node),
      })
    })
  }
  return out
}

interface EdgePalette {
  accent: string
  border: string
  borderStrong: string
}

function buildEdges(nodes: ResearchGraphNode[], palette: EdgePalette): Edge[] {
  const edges: Edge[] = []
  for (const node of nodes) {
    for (const parent of node.parents || []) {
      const active = mapStatus(node.status) === 'running'
      const color = active ? palette.accent : palette.borderStrong
      edges.push({
        id: `e-${parent}-${node.id}`,
        source: parent,
        target: node.id,
        animated: active,
        style: { stroke: color, strokeWidth: active ? 2 : 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      })
    }
  }
  return edges
}

export const ResearchGraphCanvas: React.FC = () => {
  const tokens = useThemeTokens()
  const researchGraph = useSessionStore((s) => s.researchGraph)
  const researchRuns = useSessionStore((s) => s.researchRuns)
  const researchRunId = useSessionStore((s) => s.researchRunId)
  const fetchResearchRuns = useSessionStore((s) => s.fetchResearchRuns)
  const fetchResearchGraph = useSessionStore((s) => s.fetchResearchGraph)

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ResearchNodeData>>([])
  const [selectedNode, setSelectedNode] = React.useState<ResearchNodeData | null>(null)

  // Refresh on open, then poll: a run is driven by a separate process with no event channel.
  useEffect(() => {
    fetchResearchRuns()
    fetchResearchGraph()
    const timer = window.setInterval(() => {
      fetchResearchGraph(useSessionStore.getState().researchRunId || undefined)
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [fetchResearchRuns, fetchResearchGraph])

  const graphNodes: ResearchGraphNode[] = researchGraph?.nodes || []

  // Rebuild nodes whenever a fresh snapshot arrives.
  useEffect(() => {
    setNodes(layoutNodes(graphNodes))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchGraph])

  const themedEdges = useMemo(
    () => buildEdges(graphNodes, { accent: tokens.accent, border: tokens.border, borderStrong: tokens.borderStrong }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [researchGraph, tokens.accent, tokens.border, tokens.borderStrong],
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(themedEdges)
  useEffect(() => setEdges(themedEdges), [themedEdges, setEdges])

  const nodeTypes = useMemo(() => ({ researchNode: ResearchNodeComponent }), [])

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node.data as ResearchNodeData)
  }, [])

  const hasRun = Boolean(researchGraph && graphNodes.length > 0)

  return (
    <div className="relative flex-1 h-full w-full overflow-hidden select-none">
      {/* Run picker */}
      {researchRuns.length > 0 && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-2">
          <select
            value={researchRunId || ''}
            onChange={(e) => fetchResearchGraph(e.target.value)}
            className="max-w-[320px] bg-card text-text-main border border-border-subtle rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-accent cursor-pointer shadow-e1"
          >
            {researchRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {run.status} · {run.question || run.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => fetchResearchGraph(researchRunId || undefined)}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-card border border-border-subtle text-dim hover:text-text-main transition-colors cursor-pointer shadow-e1"
            title="刷新研究图"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {hasRun ? (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.2}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
        >
          <Background color={tokens.border} gap={20} size={1} />
          <Controls className="!bg-card !border-border-subtle !rounded-lg !shadow-e2 [&>button]:!bg-surface-2 [&>button]:!border-border-subtle [&>button]:!text-text-main hover:[&>button]:!bg-surface-3" />
          <MiniMap
            className="!bg-card !border-border-subtle !rounded-lg"
            nodeColor={(n) => {
              const data = n.data as ResearchNodeData
              if (data?.status === 'done') return tokens.success
              if (data?.status === 'running') return tokens.warning
              if (data?.status === 'failed') return tokens.danger
              return tokens.borderStrong
            }}
            maskColor={withAlpha(tokens.surface0, 0.7)}
          />
        </ReactFlow>
      ) : (
        <div className="h-full flex flex-col items-center justify-center text-dim gap-3 select-none px-8 text-center">
          <div className="w-12 h-12 rounded-xl bg-card border border-border-subtle flex items-center justify-center shadow-e2">
            <Network className="w-6 h-6 text-rose-lite" />
          </div>
          <p className="text-sm font-medium text-text-main">暂无研究图</p>
          <p className="text-xs text-dim max-w-md leading-relaxed">
            在这个项目里用 <code className="font-mono text-rose-lite">misaka research &quot;你的问题&quot;</code> 启动一次研究运行，
            或在与 Last Order 的对话中输入 <code className="font-mono text-rose-lite">/research</code>。运行开始后，这里会显示真实的节点拓扑。
          </p>
        </div>
      )}

      {/* Slide-in Node Details Drawer (read-only) */}
      <NodeDetailDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />
    </div>
  )
}

export type { ResearchGraphPayload }
