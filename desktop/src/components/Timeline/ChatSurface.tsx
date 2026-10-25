import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSessionViewKey } from '../../lib/sessionViewState'
import type { ChatMessage } from '../../types/session'
import { MarkdownContent } from './MarkdownContent'

export type PagedField = 'content' | 'error' | 'result' | 'arguments'

/**
 * Page-by-page reading of a body the host clipped.
 *
 * A sub-agent transcript is assembled from a snapshot that carries only a prefix of a large
 * message or tool result; the rest is fetched on demand. The ordinary conversation has no pager,
 * so `paging` is simply absent there.
 */
export interface ChatPaging {
  /** Text already read for this key, if any. */
  preview: (key: string) => string | undefined
  /** Offset of the next page; `undefined` starts at 0, `null` means the body is complete. */
  nextOffset: (key: string) => number | null | undefined
  load: (input: { entryId: string; field: PagedField; offset: number }) => Promise<{ content: string; nextOffset: number | null }>
  save: (key: string, content: string, nextOffset: number | null) => void
}

/**
 * Which reading surface a chat row belongs to.
 *
 * The ordinary timeline is one transcript per session path. The research workspace shows several
 * transcripts at once (main area, side viewer, tiles) and some of them can show the same executor,
 * so folding state, reading position and the permissions of a row are all filed under this key
 * rather than under the mounted session.
 */
export interface ChatSurface {
  /** Stable identity of this reading surface: run + executor + area. */
  key: string
  /** A transcript that is not the user's own session: no fork, no retry, no writes. */
  readOnly?: boolean
  /** The run entry already lives on this surface (the focus header), so notices must not repeat it. */
  hideRunEntry?: boolean
  paging?: ChatPaging
}

const ChatSurfaceContext = createContext<ChatSurface | null>(null)

export function ChatSurfaceProvider({ surface, children }: { surface: ChatSurface; children: ReactNode }) {
  return <ChatSurfaceContext.Provider value={surface}>{children}</ChatSurfaceContext.Provider>
}

export function useChatSurface(): ChatSurface | null {
  return useContext(ChatSurfaceContext)
}

/** The disclosure key for the mounted row: the explicit surface, else the session path. */
export function useChatSurfaceKey(): string | null {
  const surface = useChatSurface()
  const sessionPath = useSessionViewKey()
  return surface ? surface.key : sessionPath
}

export function useChatPermissions(): { readOnly: boolean; hideRunEntry: boolean } {
  const surface = useChatSurface()
  return { readOnly: Boolean(surface?.readOnly), hideRunEntry: Boolean(surface?.hideRunEntry) }
}

/** A stable surface key for one research transcript in one area of the workspace. */
export function researchSurfaceKey(runId: string, executorId: string, area: 'main' | 'side' | 'tile'): string {
  return `research:${runId}:${executorId}:${area}`
}

/**
 * Page-by-page reading of one body the host clipped.
 *
 * The surface object is rebuilt whenever a page lands, so a row can read the shared preview
 * directly: no per-row subscription, and no refetch when the row unmounts and returns.
 */
export function usePagedValue({ entryId, field, enabled, preview = '' }: { entryId: string | undefined; field: PagedField; enabled: boolean; preview?: string }) {
  const surface = useChatSurface()
  const paging = surface?.paging
  const key = `${field}:${entryId ?? ''}`
  const owner = JSON.stringify([surface?.key, key])
  const latestOwner = useRef(owner)
  latestOwner.current = owner
  const pending = useRef<{ owner: string } | null>(null)
  const active = Boolean(enabled && paging && entryId)
  const loaded = useMemo(() => (active ? paging!.preview(key) : undefined), [active, paging, key])
  const nextOffset = active ? paging!.nextOffset(key) : null
  const [status, setStatus] = useState({ owner, loading: false, error: '' })
  const loading = status.owner === owner && status.loading
  const error = status.owner === owner ? status.error : ''
  const readable = active && nextOffset !== null
  const load = async () => {
    if (!active || pending.current?.owner === owner || nextOffset === null) return
    const request = { owner }
    pending.current = request
    const current = () => pending.current === request && latestOwner.current === owner
    setStatus({ owner, loading: true, error: '' })
    try {
      let content = loaded ?? ''
      let offset = nextOffset ?? 0
      do {
        const page = await paging!.load({ entryId: entryId!, field, offset })
        if (!current()) return
        if (!page.content || (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset))) {
          throw new Error('读取游标未前进，已保留现有内容，请重试。')
        }
        content += page.content
        paging!.save(key, content, page.nextOffset)
        if (page.nextOffset === null || content.length > preview.length) break
        // The host counts Unicode codepoints; never derive a cursor from JS string length.
        offset = page.nextOffset
      } while (current())
      if (current()) setStatus({ owner, loading: false, error: '' })
    } catch (failure) {
      if (current()) setStatus({ owner, loading: false, error: failure instanceof Error ? failure.message : String(failure) })
    } finally { if (pending.current === request) pending.current = null }
  }
  return { loaded, readable, complete: nextOffset === null, loading, error, load }
}

/** The prose of one message: markdown normally, or the rest of a clipped body on demand. */
export function ChatText({ message, text, isStreaming, plain, className, paginate = true, revealOnRead = false }: { message: ChatMessage; text: string; isStreaming?: boolean; plain?: boolean; className?: string; paginate?: boolean; revealOnRead?: boolean }) {
  const paging = useChatSurface()?.paging
  const clipped = Boolean(paginate && paging && message.contentTruncated && message.entryId)
  const paged = usePagedValue({ entryId: message.entryId, field: 'content', enabled: clipped, preview: text })
  const body = paged.loaded !== undefined && (paged.loaded.length >= text.length || (paged.complete && !text.startsWith(paged.loaded))) ? paged.loaded : text
  return <>
    {(!revealOnRead || paged.loaded !== undefined) && (plain ? <div className={className}>{body}</div> : <MarkdownContent content={body} isStreaming={isStreaming} />)}
    {paged.readable && <button type="button" disabled={paged.loading} onClick={() => void paged.load()}
      className="mt-1 text-[11px] text-accent underline disabled:opacity-50">
      {paged.loading ? '读取中…' : '读取完整消息'}
    </button>}
    {paged.error && <p role="alert" className="text-[11px] text-danger">{paged.error}</p>}
  </>
}
