import { useMemo, useRef } from 'react'
import { MessagesSquare, ShieldQuestion } from 'lucide-react'
import type { ResearchSessionsPayload } from '../../types/research'
import { useResearchWorkspaceStore } from '../../store/useResearchWorkspaceStore'
import { ResearchTranscript } from './ResearchTranscript'
import { ResearchSidePanel } from './ResearchSidePanel'
import { ResearchRunPanel } from './ResearchRunPanel'
import { resolveMainSession, resolveResearchNodeId, rootControllerId, sessionLabel } from './researchTeam'
import { useFocusReadingLayout } from './useFocusReadingLayout'
import { ESCAPE_PRIORITY, useHasHigherEscapeLayer } from '../../lib/useEscapeLayer'

/**
 * 专注模式: one conversation in the ordinary chat layout, with the run's structure folded away.
 *
 * There is no run banner, no team column and no per-pane chrome: what is read is a chat. Which
 * member is shown is a reading choice held in the workspace store, so browsing never rebinds the
 * research conversation and never touches ordinary session switching. The second transcript opens
 * beside the first without replacing it, and the controller stays the only writer.
 */
export function ResearchFocusView({ runId, workspace, listing, nodeId }: {
  runId: string
  workspace: string
  listing: ResearchSessionsPayload
  nodeId: string | null
}) {
  const view = useResearchWorkspaceStore(state => state.byRun[runId])
  const setMain = useResearchWorkspaceStore(state => state.setMainExecutor)
  const setSide = useResearchWorkspaceStore(state => state.setSideExecutor)
  // The run's tasks and team are a working detail of the run, not part of the chat being read:
  // folded by default, and remembered per run so browsing members does not reopen it.
  const processOpen = view?.processOpen ?? false
  const setProcessOpen = (open: boolean) => useResearchWorkspaceStore.getState().setProcessOpen(runId, open)
  const controllerId = useMemo(() => rootControllerId(listing), [listing])
  const selectedNodeId = resolveResearchNodeId(listing, nodeId)
  const selectedNode = listing.graph.nodes.find(item => item.id === selectedNodeId)
  const main = resolveMainSession(listing, nodeId, view?.mainExecutorId)
  const side = useMemo(() => (view?.sideExecutorId
    ? listing.sessions.find(item => item.executorId === view.sideExecutorId) ?? null
    : null), [listing.sessions, view?.sideExecutorId])
  const root = useRef<HTMLDivElement>(null)
  const foregroundOpen = useHasHigherEscapeLayer(ESCAPE_PRIORITY.side)
  const narrow = useFocusReadingLayout(root, Boolean(side), foregroundOpen)
  const processPanel = processOpen && <ResearchRunPanel runId={runId} workspace={workspace} listing={listing} onClose={() => setProcessOpen(false)} />
  // Only the run's own controller may act; a branch node's Last Order is still a sub-agent.
  const isController = Boolean(main && controllerId && main.executorId === controllerId)
  const returnToController = () => {
    setMain(runId, controllerId)
    setSide(runId, null)
  }
  return <div ref={root} className="research-focus-view" data-research-focus-view={runId}>
    {processPanel}
    <div className="research-focus-body">
      <div className="research-focus-main">
        {main ? <ResearchTranscript runId={runId} workspace={workspace} descriptor={main} area="main"
          readOnly={!isController} hideRunEntry
          empty={<><p className="text-sm font-medium text-text-main">{isController ? '主控还没有会话内容' : '等待会话内容'}</p>
            <p className="text-xs text-dim">研究开始后，这里会像普通对话一样逐条显示。</p></>}
          returnAction={isController ? undefined
            : <><ShieldQuestion size={13} aria-hidden="true" />
              <span>子代理会话只读。需要补充或调整时，请在对话中向主控代理提出。</span>
              {controllerId && <button type="button" className="research-readonly-return" onClick={returnToController}>
                <MessagesSquare size={12} aria-hidden="true" />返回主控
              </button>}</>} />
          : <div className="research-focus-empty flex-1" role="status">
            {selectedNode ? <>节点“{selectedNode.question}”正在等待可查看的会话。</> : '当前节点还没有可查看的会话。'}
          </div>}
      </div>
      {side && <ResearchSidePanel runId={runId} workspace={workspace} descriptor={side}
        modal={narrow}
        label={sessionLabel(side, controllerId)}
        onClose={() => setSide(runId, null)}
        onOpenMain={() => { setMain(runId, side.executorId); setSide(runId, null) }} />}
    </div>
  </div>
}
