import { EMPTY_RESEARCH_MESSAGES } from '../../lib/researchView'
import React from 'react'
import { Loader2 } from 'lucide-react'
import { MisakaLogo } from '../MisakaLogo'
import { useSessionStore } from '../../store/useSessionStore'
import { useSessionViewKey } from '../../lib/sessionViewState'
import { ConversationTranscript } from './ConversationTranscript'

export const Timeline: React.FC = () => {
  const path = useSessionViewKey()
  return <TimelineContent key={path ?? 'new-session'} path={path} />
}

function TimelineContent({ path }: { path: string | null }) {
  const messages = useSessionStore(s => s.agentMode === 'research' ? (s.researchPageView === 'new' ? EMPTY_RESEARCH_MESSAGES : s.researchConversation.messages) : s.messages)
  const startingResearch = useSessionStore(s => s.agentMode === 'research' && Boolean(s.researchPendingCreationRequestId) && !s.researchBinding?.runId)
  const loading = useSessionStore(s => s.isSessionLoading)
  const loadError = useSessionStore(s => s.sessionLoadError)
  const retry = useSessionStore(s => s.retrySessionLoad)
  return <ConversationTranscript viewKey={path} messages={messages} loading={loading} loadError={loadError} onRetry={retry}
    empty={<div className="conversation-empty text-muted">
      <div className="conversation-empty-icon">{loading || startingResearch ? <Loader2 className="w-6 h-6 text-rose-lite animate-spin" /> : <MisakaLogo size={26} />}</div>
      <p className="text-sm font-medium text-text-main">{loading ? '正在加载对话' : loadError ? '会话尚未就绪' : startingResearch ? '研究正在启动' : '开始新的研究对话'}</p>
      <p className="text-xs text-dim">{loading || loadError ? '你可以先在下方写草稿，准备完成后再发送。'
        : startingResearch ? '正在准备研究团队与规划；这一刻可能持续较长时间，状态会随研究事件更新。'
          : '在下方输入框中提出问题或课题，Misaka 将开始研究。'}</p>
    </div>} />
}
