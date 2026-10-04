import React, { useState, useMemo, useCallback } from 'react'
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
import { ResearchNodeComponent } from './ResearchNodeComponent'
import { NodeDetailDrawer } from './NodeDetailDrawer'
import type { ResearchNodeData } from '../../types/research'

const INITIAL_RESEARCH_NODES: Node<ResearchNodeData>[] = [
  {
    id: 'n0',
    type: 'researchNode',
    position: { x: 50, y: 220 },
    data: {
      id: '0',
      kind: 'root',
      title: '核心研究课题：现代性反思与当代青年个体化困境',
      question: '探讨晚期现代性社会转型中，青年群体面临的制度性风险、原子化生存与情感折叠机制。',
      assignee: {
        id: 'lo',
        name: 'Last Order',
        role: '研究统筹协调',
        avatarBg: '#cb3862',
      },
      status: 'done',
      depth: 0,
      summary: '拆解为社会学三大经典框架分支，分派三位 Sister 专家协同论证。',
      findings: [
        '确定研究总纲：从结构、关系与文化三个剖面解构个体化困境。',
        '建立交叉验证约束：理论推演必须与东亚特有社会结构结合。',
      ],
      evidence: ['PROJECT.md 核心研究规划', 'Last Order 任务总纲 v1.0'],
      replies: [],
    },
  },
  {
    id: 'n1',
    type: 'researchNode',
    position: { x: 450, y: 50 },
    data: {
      id: '1',
      kind: 'alt',
      title: '贝克风险社会视角下的“制度化个体化”',
      question: '考察传统纽带消解后，教育、就业与社保制度如何反向要求个体独立承担系统性风险。',
      assignee: {
        id: '10032',
        name: 'Sister 10032',
        role: '风险社会学专员',
        avatarBg: '#3c9a80',
      },
      status: 'done',
      depth: 1,
      summary: '个体化并非自愿选择，而是制度安排强加给个人的传记式要求。',
      findings: [
        '青年“内卷”实质是制度化风险向个人转嫁带来的代偿性努力。',
        '传统托底保障剥离后，失败的系统性归因被重构为“个人能力不足”。',
      ],
      evidence: ['乌尔里希·贝克《风险社会》', '贝克 & 贝克-格恩斯海姆《个体化》'],
      replies: [
        {
          id: 'r1',
          sender: '用户',
          content: '请进一步结合青年就业市场的非标准契约展开论证。',
          timestamp: '17:20',
        },
      ],
    },
  },
  {
    id: 'n2',
    type: 'researchNode',
    position: { x: 450, y: 220 },
    data: {
      id: '2',
      kind: 'alt',
      title: '鲍曼“液态现代性”与青年亲密关系原子化',
      question: '分析商品化逻辑与流动性对长效承诺的解构，以及数字连接对实体社群的虚拟替代。',
      assignee: {
        id: '10031',
        name: 'Sister 10031',
        role: '文化社会学专员',
        avatarBg: '#4f70c4',
      },
      status: 'done',
      depth: 1,
      summary: '液态关系的脆弱性使得安全感缺失，导致青年在亲密关系中采取防御性退缩。',
      findings: [
        '即时满足与低成本退出机制削弱了深度人际联结的建构能力。',
        '“赛博同温层”提供了低风险拟态陪伴，但加剧了线下真实交往的无力感。',
      ],
      evidence: ['齐格蒙特·鲍曼《液态之爱》', '雪莉·特克尔《群体性孤独》'],
      replies: [],
    },
  },
  {
    id: 'n3',
    type: 'researchNode',
    position: { x: 450, y: 390 },
    data: {
      id: '3',
      kind: 'alt',
      title: '东亚语境下的“压缩现代性”与代际缓冲',
      question: '检验家庭网络在制度性福利滞后背景下的非正式托底作用及其附带的情感负荷。',
      assignee: {
        id: '10039',
        name: 'Sister 10039',
        role: '比较社会学专员',
        avatarBg: '#e0b23e',
      },
      status: 'running',
      depth: 1,
      summary: '东亚个体化呈现出“半个体化”特征：一方面追求自主，另一方面深度依附代际资源。',
      findings: [
        '家庭买房资助与育儿支持构成了核心安全阀。',
        '然而经济连带反向转化为代际控制与婚姻观念冲突。',
      ],
      evidence: ['张庆燮《压缩现代性研究》', '东亚青年代际转移调查数据 (2024)'],
      replies: [],
    },
  },
  {
    id: 'n4',
    type: 'researchNode',
    position: { x: 850, y: 220 },
    data: {
      id: '4',
      kind: 'alt',
      title: '红队对抗性审查：方法论局限与样本偏差质疑',
      question: '针对上述三大假说提出批判性质疑，警惕将宏观经济周期结构性变动简化为文化心理归因。',
      assignee: {
        id: '10035',
        name: 'Sister 10035',
        role: '方法论与红队专员',
        avatarBg: '#e05252',
      },
      status: 'review',
      depth: 2,
      summary: '提出 3 项批判性修正意见：需区分一线城市精英青年与下沉市场青年的体验断层。',
      findings: [
        '过度聚焦城市知识青年，忽视技能型蓝领青年的结构性机遇。',
        '建议在综合报告中增加阶层分化维度，避免均质化论述。',
      ],
      evidence: ['审查备忘录 RedTeam-LO-004', '实证检验与反事实推演报告'],
      replies: [],
    },
  },
  {
    id: 'n5',
    type: 'researchNode',
    position: { x: 1250, y: 220 },
    data: {
      id: '5',
      kind: 'join',
      title: '终稿综合报告：多维现代性冲突与青年生存策略矩阵',
      question: '汇聚合著者论点，吸纳红队修正案，产出最终人文社科研究成果简报与政策对策矩阵。',
      assignee: {
        id: 'lo',
        name: 'Last Order',
        role: '终审定稿负责人',
        avatarBg: '#cb3862',
      },
      status: 'pending',
      depth: 3,
      summary: '形成综合框架：结构风险、关系液态化与代际嵌合三位一体模型。',
      findings: ['待红队复审节点（n4）完成签收后自动生成最终报告文档。'],
      evidence: ['final/run-01-graph.json', 'final/report-draft.docx'],
      replies: [],
    },
  },
]

const INITIAL_RESEARCH_EDGES: Edge[] = [
  {
    id: 'e-n0-n1',
    source: 'n0',
    target: 'n1',
    animated: true,
    style: { stroke: '#4a3d42', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#4a3d42' },
  },
  {
    id: 'e-n0-n2',
    source: 'n0',
    target: 'n2',
    animated: true,
    style: { stroke: '#4a3d42', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#4a3d42' },
  },
  {
    id: 'e-n0-n3',
    source: 'n0',
    target: 'n3',
    animated: true,
    style: { stroke: '#cb3862', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#cb3862' },
  },
  {
    id: 'e-n1-n4',
    source: 'n1',
    target: 'n4',
    style: { stroke: '#4a3d42', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#4a3d42' },
  },
  {
    id: 'e-n2-n4',
    source: 'n2',
    target: 'n4',
    style: { stroke: '#4a3d42', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#4a3d42' },
  },
  {
    id: 'e-n3-n4',
    source: 'n3',
    target: 'n4',
    animated: true,
    style: { stroke: '#cb3862', strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#cb3862' },
  },
  {
    id: 'e-n4-n5',
    source: 'n4',
    target: 'n5',
    style: { stroke: '#37373f', strokeWidth: 1.5, strokeDasharray: '4 4' },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#37373f' },
  },
]

export const ResearchGraphCanvas: React.FC = () => {
  const [nodes, setNodes, onNodesChange] = useNodesState(INITIAL_RESEARCH_NODES)
  const [edges, , onEdgesChange] = useEdgesState(INITIAL_RESEARCH_EDGES)
  const [selectedNode, setSelectedNode] = useState<ResearchNodeData | null>(null)

  const nodeTypes = useMemo(() => ({ researchNode: ResearchNodeComponent }), [])

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node.data as ResearchNodeData)
  }, [])

  const handleAddReply = (nodeId: string, replyText: string) => {
    // 1. Send steer instruction to python bridge
    if (window.bridge?.send) {
      window.bridge.send({
        type: 'steer',
        requestId: `steer-${Date.now()}`,
        text: `针对研究节点 #${nodeId} 的卡片应答：${replyText}`,
      })
    }

    // 2. Append reply locally to the node
    const newReply = {
      id: `reply-${Date.now()}`,
      sender: '你 (研究员)',
      content: replyText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }

    setNodes((prevNodes) =>
      prevNodes.map((n) => {
        if (n.id === nodeId) {
          const currentData = n.data as ResearchNodeData
          const updated = {
            ...currentData,
            replies: [...(currentData.replies || []), newReply],
          }
          if (selectedNode?.id === nodeId) {
            setSelectedNode(updated)
          }
          return { ...n, data: updated }
        }
        return n
      })
    )
  }

  return (
    <div className="relative flex-1 h-full w-full bg-surface-0 overflow-hidden select-none">
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
        <Background color="#2a2a33" gap={20} size={1} />
        <Controls className="!bg-surface-1 !border-border !rounded-lg !shadow-lg [&>button]:!bg-surface-2 [&>button]:!border-border-subtle [&>button]:!text-text-main hover:[&>button]:!bg-surface-3" />
        <MiniMap
          className="!bg-surface-1 !border-border !rounded-lg"
          nodeColor={(n) => {
            const data = n.data as ResearchNodeData
            if (data?.status === 'done') return '#3c9a80'
            if (data?.status === 'running') return '#e0b23e'
            if (data?.status === 'review') return '#e05252'
            return '#2c2c36'
          }}
          maskColor="rgba(24, 24, 30, 0.7)"
        />
      </ReactFlow>

      {/* Slide-in Node Details Drawer with Card Response */}
      <NodeDetailDrawer
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
        onAddReply={handleAddReply}
      />
    </div>
  )
}
