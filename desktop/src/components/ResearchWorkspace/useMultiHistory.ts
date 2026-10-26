import { useEffect, useReducer, useRef, useState } from 'react'
import type { ResearchSessionDescriptor } from '../../types/research'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { redactSecrets } from '../../lib/toolDisplay'
import { useResearchSessionsStore, type SessionState } from '../../store/useResearchSessionsStore'

interface ReadAttempt { retry: number; error: string; pending: boolean }

function readKey(runId: string, workspace: string, session: SessionState) {
  const descriptor = session.descriptor
  return JSON.stringify([runId, workspace, descriptor.executorId, descriptor.workspace, descriptor.sessionId,
    descriptor.sessionFile, descriptor.generation, descriptor.attempt, session.historyVersion])
}

/** A peer's history update must not implicitly retry a different failed session. */
export function useMultiHistory(runId: string, workspace: string, descriptors: ResearchSessionDescriptor[], enabled: boolean) {
  const attempts = useRef(new Map<string, ReadAttempt>())
  const live = useRef(true)
  const [, settled] = useReducer(value => value + 1, 0)
  const [retry, setRetry] = useState(0)
  const version = useResearchSessionsStore(state => JSON.stringify(descriptors.map(descriptor => {
    const item = state.byExecutor[descriptor.executorId]
    return item ? [readKey(runId, workspace, item), item.loadedHistoryVersion, item.messages.length > 0] : null
  })))
  const states = useResearchSessionsStore.getState().byExecutor
  const reads = enabled ? descriptors.flatMap(descriptor => {
    const item = states[descriptor.executorId]
    if (!item || item.runId !== runId || !item.descriptor.sessionId
      || (item.loadedHistoryVersion === item.historyVersion && (item.messages.length || item.loadedHistoryVersion))) return []
    return [{ key: readKey(runId, workspace, item), executorId: descriptor.executorId }]
  }) : []
  const liveReads = useRef(new Set<string>())
  liveReads.current = new Set(reads.map(read => read.key))
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  useEffect(() => {
    const keep = new Set(reads.map(read => read.key))
    for (const key of attempts.current.keys()) if (!keep.has(key)) attempts.current.delete(key)
    for (const read of reads) {
      const previous = attempts.current.get(read.key)
      if (previous?.pending || previous?.retry === retry) continue
      const attempt: ReadAttempt = { retry, error: '', pending: true }
      attempts.current.set(read.key, attempt)
      const load = async () => {
        for (let reconnect = 0; ; reconnect++) {
          try {
            await researchSessionsBridge.history(runId, read.executorId, workspace)
            return
          } catch (error) {
            if (reconnect === 0 && live.current && liveReads.current.has(read.key)
              && attempts.current.get(read.key) === attempt && error instanceof Error
              && error.name === 'ResearchHistoryInvalidatedError' && 'retryable' in error && error.retryable === true) continue
            throw error
          }
        }
      }
      void load().then(
        () => {
          attempt.pending = false
          if (live.current && attempts.current.get(read.key) === attempt) settled()
        },
        error => {
          attempt.pending = false
          attempt.error = redactSecrets(String(error))
          if (live.current && attempts.current.get(read.key) === attempt) settled()
        },
      )
    }
  }, [runId, workspace, enabled, version, retry])
  const error = [...new Set(reads.map(read => attempts.current.get(read.key)?.error).filter(Boolean))].join('\n')
  return { error, retry: () => setRetry(value => value + 1) }
}
