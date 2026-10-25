import { useRef, useState, type ReactNode } from 'react'
import type { ResearchSessionDescriptor } from '../../types/research'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { redactSecrets } from '../../lib/toolDisplay'
import { ResearchCardContract } from './ResearchCardContract'
import { ResearchPaneFooter } from './ResearchPaneFooter'
import { Bot, Maximize2, Minimize2, Workflow } from 'lucide-react'
import { ResearchStatusBadge } from './ResearchStatusBadge'
import { ResearchPaneMessage } from './ResearchPaneMessage'
import { ResearchPagedBody } from './ResearchPagedField'
import { ResearchContentChangeContext, useResearchPaneReading } from './useResearchPaneReading'

export function ResearchAgentPane({ runId, descriptor, focused = false, onFocus, overview, isRootController, expanded = false, onToggleExpanded }: {
  runId: string; descriptor: ResearchSessionDescriptor; focused?: boolean; onFocus?: () => void; overview?: ReactNode
  isRootController?: boolean; expanded?: boolean; onToggleExpanded?: () => void
}) {
  const session = useResearchSessionsStore(s => s.byExecutor[descriptor.executorId])
  const scrollRef = useRef<HTMLDivElement>(null)
  const sessionIdentity = JSON.stringify([runId, descriptor.executorId, descriptor.sessionId, descriptor.sessionFile, descriptor.generation, descriptor.attempt])
  const { beforeChange, preserveAsync, onScroll, onDisclosureClick } = useResearchPaneReading(runId, descriptor.executorId, scrollRef, session?.messages, session?.streaming, sessionIdentity)
  const [historyRead, setHistoryRead] = useState<{ scope: string; loading: boolean; error: string } | null>(null)
  const historyLoading = historyRead?.scope === sessionIdentity && historyRead.loading
  const historyError = historyRead?.scope === sessionIdentity ? historyRead.error : ''
  const loadHistory = async () => {
    if (historyLoading) return
    setHistoryRead({ scope: sessionIdentity, loading: true, error: '' })
    try { await preserveAsync(() => researchSessionsBridge.history(runId, descriptor.executorId, descriptor.workspace, session?.nextCursor ?? undefined)) }
    catch (failure) { setHistoryRead(current => current?.scope === sessionIdentity ? { ...current, error: redactSecrets(String(failure)) } : current) }
    finally { setHistoryRead(current => current?.scope === sessionIdentity ? { ...current, loading: false } : current) }
  }
  const messages = [...(session?.messages ?? []), ...(session?.streaming ? [session.streaming] : [])]
  const isCoordinator = descriptor.role === 'last_order'
  const RoleIcon = isCoordinator ? Workflow : Bot
  const title = isCoordinator ? isRootController === false ? '节点主控' : '主控' : descriptor.cardTitle || descriptor.label
  const titleIncludesIdentity = title === descriptor.label || Boolean(descriptor.label && title.startsWith(descriptor.label)
    && /^\s*[·•|｜:：–—]\s*/u.test(title.slice(descriptor.label.length)))
  const showAttempt = descriptor.attempt > 1 || (descriptor.isCurrent === false && descriptor.attempt > 0)
  const metadata = [descriptor.isCurrent === false ? '历史记录' : '', titleIncludesIdentity ? '' : descriptor.label,
    showAttempt ? `第 ${descriptor.attempt} 次执行` : ''].filter(Boolean)
  return <section data-testid={`research-pane-${descriptor.executorId}`} role="region" aria-label={`${descriptor.label} 会话`}
    className={`research-agent-pane research-agent-pane--reading ${isCoordinator ? 'research-agent-pane--coordinator' : ''} ${focused ? 'is-focused' : ''}`}>
    <header className="research-pane-heading">
      <button type="button" onClick={onFocus} className="research-pane-focus" aria-label={`聚焦 ${descriptor.label}`} aria-pressed={focused}>
        <span className="research-pane-role-icon"><RoleIcon size={16} strokeWidth={1.6} aria-hidden="true" /></span>
        <span className="research-pane-title"><strong title={title}>{title}</strong>
          {metadata.length > 0 && <small title={metadata.join(' · ')}>{metadata.map((item, index) => <span key={item}>{index > 0 ? ' · ' : ''}{item}</span>)}</small>}</span>
        <ResearchStatusBadge status={descriptor.status} />
      </button>
      {onToggleExpanded && <button type="button" className="research-pane-expand" aria-label={expanded ? '退出展开' : '展开会话'}
        aria-pressed={expanded} title={expanded ? '退出展开' : '展开会话'} onClick={onToggleExpanded}>
        {expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
      </button>}
    </header>
    <ResearchCardContract contract={descriptor.contract} />
    {overview}
    <ResearchContentChangeContext.Provider value={beforeChange}>
    <div ref={scrollRef} className="research-pane-body min-h-0 flex-1 space-y-2 overflow-y-auto" onScroll={onScroll} onClickCapture={onDisclosureClick}>
      {!messages.length && <p className="py-4 text-center text-[11px] text-dim">{session?.availability === 'missing' ? '会话记录缺失' : '等待会话内容'}</p>}
      {session?.hasMore && session.nextCursor && <button type="button" disabled={historyLoading} className="text-[11px] text-accent underline" onClick={() => void loadHistory()}>{historyError ? '重试读取历史' : '读取更多历史'}</button>}
      {historyError && <p className="research-content-error" role="alert">{historyError}</p>}
      {messages.filter(message => message.display !== false).map((message, index) => <ResearchPaneMessage key={message.id}
        runId={runId} descriptor={descriptor} message={message} initialBrief={Boolean(!isCoordinator && descriptor.contract && !session?.hasMore && index === 0 && message.role === 'user')} />)}
      {session?.error && <div className="research-session-error rounded border border-danger-border bg-danger-surface p-2 text-danger" data-research-reading-anchor="session-error"><ResearchPagedBody runId={runId} descriptor={descriptor} entryId={descriptor.executorId} field="error" preview={session.error} label="查看完整错误" /></div>}
    </div>
    </ResearchContentChangeContext.Provider>
    <ResearchPaneFooter telemetry={session?.telemetry ?? descriptor.telemetry ?? null} sessionLabel={title} />
  </section>
}
