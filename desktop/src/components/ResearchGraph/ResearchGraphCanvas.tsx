import { researchActivity, subscribeResearchHistory, subscribeResearchRun, useResearchActivityStore } from '../../lib/researchActivityStore'
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
import { useThemeTokens } from '../../theme/useThemeTokens'
import { useSessionStore } from '../../store/useSessionStore'
import { researchRunLabel } from '../../lib/researchStatus'
import type { ResearchGraphNode, ResearchGraphPayload, ResearchNodeData } from '../../types/research'


/** Node status → the four visual states the card understands. Anything transient is "running",
 *  the terminal trio keeps its own state, and everything not yet started reads as pending. */
function isActiveNode(status: string): boolean {
  return !['closed', 'failed', 'parked', 'queued'].includes(status)
}

// Mirrors the themed chart palette (1/4/5/2/6) plus danger, so avatars follow the active
// theme. var() inside an inline background-color resolves at paint time, so this needs no
// JS re-read on a theme switch.
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
    status: node.status,
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
  active: string
  strong: string
}

function buildEdges(nodes: ResearchGraphNode[], palette: EdgePalette): Edge[] {
  const edges: Edge[] = []
  for (const node of nodes) {
    for (const parent of node.parents || []) {
      const active = isActiveNode(node.status)
      const color = active ? palette.active : palette.strong
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

interface ResearchGraphCanvasProps {
  runId?: string | null
  showRunPicker?: boolean
  showNodeDrawer?: boolean
  onSelectNode?: (node: ResearchGraphNode) => void
}

export const ResearchGraphCanvas: React.FC<ResearchGraphCanvasProps> = ({
  runId: requestedRunId, showRunPicker = true, showNodeDrawer = true, onSelectNode,
}) => {
  const tokens = useThemeTokens()
  const legacyGraph = useSessionStore((s) => s.researchGraph)
  const researchRuns = useSessionStore((s) => s.researchRuns)
  const selectedRunId = useSessionStore((s) => s.researchRunId)
  const researchRunId = requestedRunId ?? selectedRunId ?? researchRuns[0]?.id
  const detailGraph = useResearchActivityStore(s=>researchRunId ? s.details[researchRunId]?.graph : undefined)
  const researchGraph = detailGraph ?? (legacyGraph?.run === researchRunId ? legacyGraph : null)
  const workspace = researchRuns.find(run=>run.id === researchRunId)?.workspace

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ResearchNodeData>>([])
  const [selectedNode, setSelectedNode] = React.useState<ResearchNodeData | null>(null)

  // Graph views use the same run-detail subscription as the history and task pills.
  useEffect(() => showRunPicker ? subscribeResearchHistory() : undefined, [showRunPicker])
  useEffect(() => {
    setSelectedNode(null)
    if (!researchRunId) return
    return subscribeResearchRun(researchRunId,workspace)
  }, [researchRunId,workspace])

  const graphNodes: ResearchGraphNode[] = researchGraph?.nodes || []

  // Rebuild nodes whenever a fresh snapshot arrives.
  useEffect(() => {
    setNodes(layoutNodes(graphNodes))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchGraph])

  const themedEdges = useMemo(
    () => buildEdges(graphNodes, { active: tokens.graphEdgeActive, strong: tokens.graphEdgeStrong }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [researchGraph, tokens.graphEdgeActive, tokens.graphEdgeStrong],
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(themedEdges)
  useEffect(() => setEdges(themedEdges), [themedEdges, setEdges])

  const nodeTypes = useMemo(() => ({ researchNode: ResearchNodeComponent }), [])

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node.data as ResearchNodeData)
    const selected = graphNodes.find(item => item.id === node.id)
    if (selected) onSelectNode?.(selected)
  }, [graphNodes, onSelectNode])

  const hasRun = Boolean(researchGraph && graphNodes.length > 0)

  return (
    <div className="relative flex-1 h-full w-full overflow-hidden select-none">
      {/* Run picker */}
      {showRunPicker && researchRuns.length > 0 && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-2">
          <select
            value={researchRunId || ''}
            onChange={(e) => useSessionStore.setState({researchRunId:e.target.value})}
            className="max-w-[320px] bg-card text-text-main border border-border-subtle rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-accent cursor-pointer shadow-e1"
          >
            {researchRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {researchRunLabel(run)} · {run.question || run.id}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void researchActivity.refresh()}
            className="w-7 h-7 flex items-center justify-center rounded-lg bg-card border border-border-subtle text-dim hover:text-text-main transition-colors cursor-pointer shadow-e1"
            title="刷新研究图"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {hasRun ? (
        <ReactFlow
          className="misaka-research-graph"
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
          <Background color={tokens.graphGrid} gap={20} size={1} />
          <Controls className="!bg-graph-control-surface !border-graph-control-border !rounded-lg !shadow-e2" />
          <MiniMap
            className="!bg-graph-minimap-background !border-graph-control-border !rounded-lg"
            nodeColor={(n) => {
              const data = n.data as ResearchNodeData
              if (data?.status === 'closed') return tokens.success
              if (data?.status === 'failed') return tokens.danger
              if (['critique', 'critiquing', 'diverging', 'divergence'].includes(data?.status)) return tokens.danger
              if (!['queued', 'parked'].includes(data?.status)) return tokens.warning
              return tokens.graphEdgeStrong
            }}
            nodeStrokeColor="transparent"
            maskColor={tokens.graphMinimapMask}
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
      {showNodeDrawer && <NodeDetailDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />}
    </div>
  )
}

export type { ResearchGraphPayload }
