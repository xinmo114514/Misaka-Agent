import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ResearchSessionDescriptor } from '../../types/research'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { redactSecrets } from '../../lib/toolDisplay'
import { MarkdownContent } from '../Timeline/MarkdownContent'
import { ResearchContentChangeContext } from './useResearchPaneReading'

type ContentField = 'content' | 'arguments' | 'result' | 'error'
interface ReadStatus { loading: boolean; error: string }
interface PendingRead { marker: string; epoch: number; promise: Promise<void> }
const idle: ReadStatus = { loading: false, error: '' }
const statuses = new Map<string, ReadStatus>()
const listeners = new Map<string, Set<() => void>>()
const pendingReads = new Map<string, PendingRead>()
const epochs = new Map<string, number>()
const owners = new Map<string, string>()
const contentChanges = new Map<string, () => void>()
let requestSequence = 0

function identity(runId: string, descriptor: ResearchSessionDescriptor): string {
  return JSON.stringify([runId, descriptor.executorId, descriptor.workspace, descriptor.sessionId, descriptor.sessionFile, descriptor.generation, descriptor.attempt])
}

// Source previews may change on a live snapshot. They select a different buffer, not a cursor.
function previewFingerprint(value: string): string {
  let first = 2166136261, second = 5381
  for (let index = 0; index < value.length; index++) {
    first = Math.imul(first ^ value.charCodeAt(index), 16777619)
    second = Math.imul(second, 33) ^ value.charCodeAt(index)
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`
}

function notify(key: string, status: ReadStatus) {
  contentChanges.get(key)?.()
  statuses.set(key, status)
  listeners.get(key)?.forEach(listener => listener())
}

function visibleContent(preview: string, buffer: string | undefined, complete: boolean): string {
  if (!buffer) return preview
  if (buffer.length >= preview.length) return buffer
  // A nonempty completed server value is authoritative even if an older preview used a
  // different serialization. Native prefix pages never replace a longer visible preview.
  return complete && !preview.startsWith(buffer) ? buffer : preview
}

export interface ResearchPagedState {
  content: string
  started: boolean
  complete: boolean
  loading: boolean
  error: string
  load: () => Promise<void>
}

export function useResearchPagedField({ runId, descriptor, entryId, cacheEntryId = entryId, field, preview, legacyCacheKey }: {
  runId: string; descriptor: ResearchSessionDescriptor; entryId: string; cacheEntryId?: string; field: ContentField; preview: string
  /** The old error-selected tool field, or unambiguous content:/error: body keys. */
  legacyCacheKey?: string
}): ResearchPagedState {
  const beforeChange = useContext(ResearchContentChangeContext)
  const scope = identity(runId, descriptor)
  const owner = useMemo(() => `pane-field:${JSON.stringify([scope, cacheEntryId, field])}`, [scope, cacheEntryId, field])
  const key = useMemo(() => `${owner}:${previewFingerprint(preview)}`, [owner, preview])
  const markerKey = `${key}:request`
  owners.set(owner, key)
  contentChanges.set(key, beforeChange)
  useEffect(() => () => { if (contentChanges.get(key) === beforeChange) contentChanges.delete(key) }, [beforeChange, key])
  const stored = useResearchSessionsStore(state => state.byExecutor[descriptor.executorId]?.previews[key])
  const offset = useResearchSessionsStore(state => state.byExecutor[descriptor.executorId]?.contentOffsets[key])
  const legacyOwnerKey = legacyCacheKey ? `${legacyCacheKey}:pane-owner` : ''
  const legacyOwner = useResearchSessionsStore(state => legacyOwnerKey ? state.byExecutor[descriptor.executorId]?.previews[legacyOwnerKey] : undefined)
  const oldContent = useResearchSessionsStore(state => legacyCacheKey ? state.byExecutor[descriptor.executorId]?.previews[legacyCacheKey] : undefined)
  const oldOffset = useResearchSessionsStore(state => legacyCacheKey ? state.byExecutor[descriptor.executorId]?.contentOffsets[legacyCacheKey] : undefined)
  // Once mirrored by this reader, a legacy value belongs to that exact source preview.
  const legacy = !legacyOwner || legacyOwner === key ? oldContent : undefined
  const legacyOffset = !legacyOwner || legacyOwner === key ? oldOffset : undefined
  const buffer = stored ?? (legacyOffset !== undefined ? legacy : undefined)
  const cursor = offset === undefined && stored === undefined ? legacyOffset : offset
  const complete = cursor === null
  const content = visibleContent(preview, buffer, complete)
  const subscribe = useCallback((listener: () => void) => {
    const group = listeners.get(key) ?? new Set<() => void>()
    group.add(listener)
    listeners.set(key, group)
    return () => { group.delete(listener); if (!group.size) listeners.delete(key) }
  }, [key])
  const snapshot = useCallback(() => useResearchSessionsStore.getState().byExecutor[descriptor.executorId]?.previews[markerKey]
    ? statuses.get(key) ?? idle : idle, [descriptor.executorId, key, markerKey])
  const status = useSyncExternalStore(subscribe, snapshot, snapshot)

  useEffect(() => {
    if (stored !== undefined || legacy === undefined || legacyOffset === undefined || legacyOwner) return
    const current = useResearchSessionsStore.getState().byExecutor[descriptor.executorId]
    if (!current || identity(current.runId, current.descriptor) !== scope) return
    const store = useResearchSessionsStore.getState()
    store.setPreview(descriptor.executorId, key, legacy, legacyOffset)
    store.setPreview(descriptor.executorId, legacyOwnerKey, key)
  }, [descriptor.executorId, key, legacy, legacyOffset, legacyOwner, legacyOwnerKey, scope, stored])

  const load = useCallback(async () => {
    const store = useResearchSessionsStore.getState()
    const current = store.byExecutor[descriptor.executorId]
    if (!current || identity(current.runId, current.descriptor) !== scope) return
    const existing = pendingReads.get(key)
    if (existing && current.previews[markerKey] === existing.marker) return existing.promise
    if (current.contentOffsets[key] === null || (current.previews[key] === undefined && legacyOffset === null)) return

    const marker = String(++requestSequence)
    const epoch = (epochs.get(key) ?? 0) + 1
    epochs.set(key, epoch)
    store.setPreview(descriptor.executorId, markerKey, marker)
    const valid = () => {
      const latest = useResearchSessionsStore.getState().byExecutor[descriptor.executorId]
      return Boolean(latest && identity(latest.runId, latest.descriptor) === scope && latest.previews[markerKey] === marker
        && owners.get(owner) === key && epochs.get(key) === epoch)
    }
    notify(key, { loading: true, error: '' })
    const operation = async () => {
      let assembled = current.previews[key] ?? (legacyOffset !== undefined ? legacy ?? '' : '')
      let next = current.contentOffsets[key] ?? legacyOffset ?? 0
      const targetLength = visibleContent(preview, assembled, false).length
      try {
        do {
          const page = await researchSessionsBridge.content(runId, descriptor.executorId, entryId, field, next, 8192, descriptor.workspace)
          if (!valid()) return
          if (!page || typeof page.content !== 'string' || !page.content) throw new Error('读取返回空内容，已保留预览，请重试。')
          if (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= next)) throw new Error('读取游标未前进，已保留现有内容，请重试。')
          if (page.hasMore && page.nextOffset === null) throw new Error('读取游标缺失，已保留现有内容，请重试。')
          assembled += page.content
          contentChanges.get(key)?.()
          const latest = useResearchSessionsStore.getState()
          latest.setPreview(descriptor.executorId, key, assembled, page.nextOffset)
          if (legacyCacheKey) {
            latest.setPreview(descriptor.executorId, legacyOwnerKey, key)
            latest.setPreview(descriptor.executorId, legacyCacheKey, assembled, page.nextOffset)
          }
          if (page.nextOffset === null || assembled.length > targetLength) break
          // Python counts Unicode codepoints; only the server's cursor advances this read.
          next = page.nextOffset
        } while (valid())
      } catch (failure) {
        if (valid()) notify(key, { loading: false, error: redactSecrets(String(failure)) })
      } finally {
        if (pendingReads.get(key)?.epoch === epoch) pendingReads.delete(key)
        if (valid() && statuses.get(key)?.loading) notify(key, { loading: false, error: '' })
      }
    }
    const promise = operation()
    pendingReads.set(key, { marker, epoch, promise })
    return promise
  }, [descriptor, entryId, field, key, legacy, legacyCacheKey, legacyOffset, legacyOwnerKey, markerKey, owner, preview, runId, scope])

  return { content, started: buffer !== undefined, complete, loading: status.loading, error: status.error, load }
}

export function ResearchPagedField({ state, initialLabel, moreLabel = initialLabel, retryLabel = `重试${initialLabel}`, completeLabel,
  markdown = false, isStreaming = false, revealOnRead = false, redact = false, showError = true }: {
  state: ResearchPagedState; initialLabel: string; moreLabel?: string; retryLabel?: string; completeLabel: string
  markdown?: boolean; isStreaming?: boolean; revealOnRead?: boolean; redact?: boolean; showError?: boolean
}) {
  const content = redact ? redactSecrets(state.content) : state.content
  return <div className="research-paged-field" aria-busy={state.loading}>
    {(!revealOnRead || state.started) && (markdown ? <MarkdownContent content={content} isStreaming={isStreaming} /> : <pre>{content}</pre>)}
    {!state.complete && <button type="button" disabled={state.loading} className="research-content-read" onClick={() => void state.load()}>
      {state.error ? retryLabel : state.started ? moreLabel : initialLabel}
    </button>}
    {state.loading && <span className="research-content-hint" role="status">正在读取…</span>}
    {state.complete && <span className="research-content-hint" role="status">{completeLabel}</span>}
    {showError && state.error && <p className="research-content-error" role="alert">{state.error}</p>}
  </div>
}

export function ResearchPagedBody({ runId, descriptor, entryId, field, preview, label, revealOnRead = false, isStreaming = false }: {
  runId: string; descriptor: ResearchSessionDescriptor; entryId: string; field: 'content' | 'error'; preview: string; label: string
  revealOnRead?: boolean; isStreaming?: boolean
}) {
  const state = useResearchPagedField({ runId, descriptor, entryId, field, preview, legacyCacheKey: `${field}:${entryId}` })
  return <ResearchPagedField state={state} initialLabel={label} completeLabel={field === 'content' ? '完整消息已读取' : '完整错误已读取'}
    markdown={field === 'content'} isStreaming={isStreaming} revealOnRead={revealOnRead} redact={field === 'error'} />
}
