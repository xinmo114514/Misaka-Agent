import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage } from '../../types/session'
import type { ResearchSessionDescriptor } from '../../types/research'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { redactSecrets } from '../../lib/toolDisplay'
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
  const storedSession = useResearchSessionsStore(state => state.byExecutor[descriptor.executorId])
  const ownerWorkspace = canonicalWorkspace(descriptor.workspace) || canonicalWorkspace(workspace)
  const scope = sessionScope(runId, ownerWorkspace, descriptor)
  const pagingOwner = useRef({ mounted: false, scope })
  pagingOwner.current.scope = scope
  useEffect(() => {
    pagingOwner.current.mounted = true
    return () => { pagingOwner.current.mounted = false }
  }, [])
  const session = storedSession && sessionScope(storedSession.runId,
    canonicalWorkspace(storedSession.descriptor.workspace) || canonicalWorkspace(workspace), storedSession.descriptor) === scope
    ? storedSession : undefined
  const history = useFocusHistory(runId, ownerWorkspace, descriptor, session)
  const executorId = descriptor.executorId
  const previews = session?.previews ?? EMPTY_PREVIEWS
  const offsets = session?.contentOffsets ?? EMPTY_OFFSETS
  const paging = useMemo<ChatPaging>(() => ({
    preview: key => previews[key],
    nextOffset: key => offsets[key],
    load: ({ entryId, field, offset }: { entryId: string; field: PagedField; offset: number }) =>
      researchSessionsBridge.content(runId, executorId, entryId, field, offset, 8192, ownerWorkspace),
    save: (key, content, nextOffset) => {
      if (!pagingOwner.current.mounted || pagingOwner.current.scope !== scope) return
      const current = useResearchSessionsStore.getState().byExecutor[executorId]
      const currentWorkspace = current && (canonicalWorkspace(current.descriptor.workspace) || ownerWorkspace)
      if (!current || sessionScope(current.runId, currentWorkspace, current.descriptor) !== scope) return
      useResearchSessionsStore.getState().setPreview(executorId, key, content, nextOffset)
    },
  }), [executorId, offsets, ownerWorkspace, previews, runId, scope])
  const surface = useMemo<ChatSurface>(() => ({
    key: researchSurfaceKey(runId, executorId, area), readOnly, hideRunEntry, paging,
  }), [area, executorId, hideRunEntry, paging, readOnly, runId])
  const messages: ChatMessage[] = [...(session?.messages ?? []), ...(session?.streaming ? [session.streaming] : [])]
  const notice = returnAction ? <div className="research-readonly-notice" role="note">{returnAction}</div> : null
  const sessionError = session?.error && <p role="alert" className="research-transcript-error">{session.error}</p>
  const availabilityNotice = session?.availability === 'missing'
    ? <p className="research-transcript-availability" role="status">会话记录缺失</p>
    : session?.availability === 'interrupted'
      ? <p className="research-transcript-availability" role="status">会话记录读取中断</p>
      : null
  return <>
    {notice}
    <ConversationTranscript key={`${surface.key}:${scope}`} viewKey={surface.key} messages={messages} surface={surface}
      label={`${descriptor.label} 会话记录`}
      loading={history.loading}
      loadError={history.error}
      onRetry={history.retry}
      loadingLabel={history.loadingLabel}
      header={messages.length ? <>
        {header}
        {history.button}
        {availabilityNotice}
        {sessionError}
      </> : undefined}
      empty={<div className="conversation-empty text-muted">
        <ResearchTranscriptEmpty descriptor={descriptor} availability={session?.availability} custom={empty} />
        {history.button}
        {sessionError}
      </div>} />
  </>
}

const EMPTY_PREVIEWS: Record<string, string> = {}
const EMPTY_OFFSETS: Record<string, number | null> = {}

function canonicalWorkspace(path: string): string {
  return path.trim().replace(/[\\/]+$/, '')
}

function sessionScope(runId: string, workspace: string, descriptor: ResearchSessionDescriptor): string {
  return JSON.stringify([runId, canonicalWorkspace(workspace).toLowerCase(), descriptor.executorId, descriptor.sessionId,
    descriptor.sessionFile, descriptor.generation, descriptor.attempt])
}

function ResearchTranscriptEmpty({ descriptor, availability, custom }: {
  descriptor: ResearchSessionDescriptor
  availability: string | undefined
  custom?: ReactNode
}) {
  if (!descriptor.sessionId || availability === 'not_started') return <>
    <p className="text-sm font-medium text-text-main">等待会话开始</p>
    <p className="text-xs text-dim">研究卡片开始执行并创建会话后，记录会出现在这里。</p>
  </>
  if (availability === 'missing') return <>
    <p className="text-sm font-medium text-text-main">会话记录缺失</p>
    <p className="text-xs text-dim">这次执行没有留下可读取的已保存记录。</p>
  </>
  if (availability === 'interrupted') return <>
    <p className="text-sm font-medium text-text-main">会话记录读取中断</p>
    <p className="text-xs text-dim">已保存记录没有完整结束，仍会显示能够读取的内容。</p>
  </>
  return custom ?? <>
    <p className="text-sm font-medium text-text-main">会话暂无内容</p>
    <p className="text-xs text-dim">已读取这个会话，但其中还没有可显示的消息。</p>
  </>
}

interface HistoryReadState {
  scope: string
  requestKey: string
  loading: boolean
  error: string
}

type TranscriptSession = ReturnType<typeof useResearchSessionsStore.getState>['byExecutor'][string]

/** Latest history and older pages belong to the mounted focus reader, not the workspace grid. */
function useFocusHistory(runId: string, workspace: string, descriptor: ResearchSessionDescriptor, session: TranscriptSession | undefined) {
  const executorId = descriptor.executorId
  const scope = sessionScope(runId, workspace, descriptor)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const initialGeneration = useRef(0)
  const pageGeneration = useRef(0)
  const initialPending = useRef<{ requestKey: string; token: number } | null>(null)
  const pagePending = useRef<{ requestKey: string; token: number } | null>(null)
  const [initialRead, setInitialRead] = useState<HistoryReadState | null>(null)
  const [pageRead, setPageRead] = useState<HistoryReadState | null>(null)
  const needsLatest = Boolean(descriptor.sessionId && session
    && (session.loadedHistoryVersion !== session.historyVersion || (!session.messages.length && !session.loadedHistoryVersion)))
  const latestKey = needsLatest
    ? JSON.stringify([scope, session?.historyVersion ?? null, session?.loadedHistoryVersion ?? null])
    : null
  const cursor = session?.nextCursor ?? null
  const hasMore = Boolean(session?.hasMore && cursor)
  const olderKey = cursor ? JSON.stringify([scope, session?.historyVersion ?? null, cursor]) : null

  const readLatest = useCallback(async (requestKey: string) => {
    if (initialPending.current?.requestKey === requestKey) return
    const token = ++initialGeneration.current
    initialPending.current = { requestKey, token }
    setInitialRead({ scope, requestKey, loading: true, error: '' })
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await researchSessionsBridge.history(runId, executorId, workspace)
          break
        } catch (failure) {
          // Reacquiring the same App owner does not change the saved-version
          // key. Retry that invalidated initial read once, while still mounted.
          if (attempt === 0 && initialGeneration.current === token && scopeRef.current === scope
            && failure instanceof Error && failure.name === 'ResearchHistoryInvalidatedError'
            && 'retryable' in failure && failure.retryable === true) continue
          throw failure
        }
      }
    } catch (failure) {
      if (initialGeneration.current === token && scopeRef.current === scope) {
        setInitialRead({ scope, requestKey, loading: false, error: redactSecrets(String(failure)) })
      }
    } finally {
      if (initialPending.current?.token === token) initialPending.current = null
      if (initialGeneration.current === token && scopeRef.current === scope) {
        setInitialRead(current => current?.scope === scope && current.requestKey === requestKey
          ? { ...current, loading: false } : current)
      }
    }
  }, [executorId, runId, scope, workspace])

  useEffect(() => {
    if (latestKey) void readLatest(latestKey)
    return () => {
      initialGeneration.current += 1
      if (initialPending.current?.requestKey === latestKey) initialPending.current = null
    }
  }, [latestKey, readLatest])

  const readOlder = useCallback(async () => {
    if (!olderKey || !cursor || pagePending.current?.requestKey === olderKey) return
    const token = ++pageGeneration.current
    pagePending.current = { requestKey: olderKey, token }
    setPageRead({ scope, requestKey: olderKey, loading: true, error: '' })
    try {
      await researchSessionsBridge.history(runId, executorId, workspace, cursor)
    } catch (failure) {
      if (pageGeneration.current === token && scopeRef.current === scope) {
        setPageRead({ scope, requestKey: olderKey, loading: false, error: redactSecrets(String(failure)) })
      }
    } finally {
      if (pagePending.current?.token === token) pagePending.current = null
      if (pageGeneration.current === token && scopeRef.current === scope) {
        setPageRead(current => current?.scope === scope && current.requestKey === olderKey
          ? { ...current, loading: false } : current)
      }
    }
  }, [cursor, executorId, olderKey, runId, scope, workspace])

  useEffect(() => () => {
    pageGeneration.current += 1
    if (pagePending.current?.requestKey === olderKey) pagePending.current = null
  }, [olderKey])

  const initialLoading = Boolean(latestKey && initialRead?.scope === scope && initialRead.requestKey === latestKey && initialRead.loading)
  const initialError = latestKey && initialRead?.scope === scope && initialRead.requestKey === latestKey ? initialRead.error : ''
  const pageLoading = Boolean(olderKey && pageRead?.scope === scope && pageRead.requestKey === olderKey && pageRead.loading)
  const pageError = olderKey && pageRead?.scope === scope && pageRead.requestKey === olderKey ? pageRead.error : ''
  const button = hasMore && cursor
    ? <button type="button" className="research-history-more" disabled={pageLoading || initialLoading}
        onClick={() => void readOlder()}>{pageLoading ? '正在读取历史…' : pageError ? '重试读取历史' : '读取更多历史'}</button>
    : null
  return {
    button,
    loading: initialLoading || pageLoading,
    error: pageError || initialError || null,
    retry: pageError ? () => { void readOlder() }
      : initialError && latestKey ? () => { void readLatest(latestKey) } : undefined,
    loadingLabel: initialLoading ? '正在读取会话历史…' : pageLoading ? '正在读取更多历史…' : undefined,
  }
}
