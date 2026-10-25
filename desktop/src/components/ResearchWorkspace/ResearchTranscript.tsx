import { useCallback, useMemo, type ReactNode } from 'react'
import type { ChatMessage } from '../../types/session'
import type { ResearchSessionDescriptor } from '../../types/research'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { ConversationTranscript } from '../Timeline/ConversationTranscript'
import { researchSurfaceKey, type ChatPaging, type ChatSurface, type PagedField } from '../Timeline/ChatSurface'

/**
 * One research conversation, read through the same transcript the ordinary chat uses.
 *
 * The workspace does not have its own chat renderer: a sub-agent session is a chat whose rows come
 * from the research host, so it takes the shared typography, tool folding and reading position and
 * only differs in where the rows come from, who may act on them and how a clipped body is paged.
 */
export function ResearchTranscript({ runId, workspace, descriptor, area, readOnly, hideRunEntry, header, empty, returnAction }: {
  runId: string
  workspace: string
  descriptor: ResearchSessionDescriptor
  /** Which reading area this transcript belongs to: its own folding and reading state. */
  area: 'main' | 'side'
  readOnly?: boolean
  hideRunEntry?: boolean
  header?: ReactNode
  empty?: ReactNode
  /** Drawn for a sub-agent: the controller is the only writer. */
  returnAction?: ReactNode
}) {
  const session = useResearchSessionsStore(state => state.byExecutor[descriptor.executorId])
  const loadMore = useHistoryPager(runId, workspace, descriptor, session?.nextCursor ?? null, Boolean(session?.hasMore))
  const executorId = descriptor.executorId
  const previews = session?.previews ?? EMPTY_PREVIEWS
  const offsets = session?.contentOffsets ?? EMPTY_OFFSETS
  const paging = useMemo<ChatPaging>(() => ({
    preview: key => previews[key],
    nextOffset: key => offsets[key],
    load: ({ entryId, field, offset }: { entryId: string; field: PagedField; offset: number }) =>
      researchSessionsBridge.content(runId, executorId, entryId, field, offset, 8192, descriptor.workspace || workspace),
    save: (key, content, nextOffset) => useResearchSessionsStore.getState().setPreview(executorId, key, content, nextOffset),
  }), [descriptor.workspace, executorId, offsets, previews, runId, workspace])
  const surface = useMemo<ChatSurface>(() => ({
    key: researchSurfaceKey(runId, executorId, area), readOnly, hideRunEntry, paging,
  }), [area, executorId, hideRunEntry, paging, readOnly, runId])
  const messages: ChatMessage[] = [...(session?.messages ?? []), ...(session?.streaming ? [session.streaming] : [])]
  const missing = session?.availability === 'missing' || session?.availability === 'not_started'
  const notice = returnAction ? <div className="research-readonly-notice" role="note">{returnAction}</div> : null
  return <>
    {notice}
    <ConversationTranscript key={surface.key} viewKey={surface.key} messages={messages} surface={surface}
      label={`${descriptor.label} 会话记录`}
      header={messages.length ? <>
        {header}
        {loadMore.button}
        {session?.error && <p role="alert" className="research-transcript-error">{session.error}</p>}
      </> : undefined}
      empty={<div className="conversation-empty text-muted">
        {empty ?? <><p className="text-sm font-medium text-text-main">{missing ? '会话记录缺失' : '等待会话内容'}</p>
          <p className="text-xs text-dim">{missing ? '这次执行没有留下可读取的记录，历史代次里可能还有上一次的内容。' : '研究卡片开始执行后，它自己的会话会出现在这里。'}</p></>}
        {loadMore.button}
      </div>} />
  </>
}

const EMPTY_PREVIEWS: Record<string, string> = {}
const EMPTY_OFFSETS: Record<string, number | null> = {}

/**
 * The older pages of one session, fetched on demand.
 *
 * Expanding the directory must not load every transcript the user might open, so a page is asked
 * for only when this conversation is the one being read, and only when the reader asks for it.
 */
function useHistoryPager(runId: string, workspace: string, descriptor: ResearchSessionDescriptor, cursor: string | null, hasMore: boolean) {
  const executorId = descriptor.executorId
  const load = useCallback(async () => {
    if (!cursor) return
    try {
      await researchSessionsBridge.history(runId, executorId, descriptor.workspace || workspace, cursor)
    } catch {
      // The bridge reports the failure; the page simply did not arrive and the button stays.
    }
  }, [cursor, descriptor.workspace, executorId, runId, workspace])
  const button = hasMore && cursor
    ? <button type="button" className="research-history-more" onClick={() => void load()}>读取更多历史</button>
    : null
  return { button }
}
