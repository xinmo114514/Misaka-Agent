import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

export const ESCAPE_PRIORITY = { process: 10, side: 20, popover: 30, dialog: 40 } as const
type Layer = { priority: number; escape: (event: KeyboardEvent) => void }
const layers: Layer[] = []
const subscribers = new Set<() => void>()
const subscribe = (notify: () => void) => {
  subscribers.add(notify)
  return () => { subscribers.delete(notify) }
}
const publish = () => { for (const notify of [...subscribers]) notify() }
const noLayersOnServer = () => false
let composing = false
const compositionStart = () => { composing = true }
const compositionEnd = () => { composing = false }
const dispatch = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  if (event.isComposing || composing || event.keyCode === 229) {
    // The browser owns IME cancellation. Do not prevent its default action, but keep the
    // same press out of background shortcuts even when an IME omits isComposing on Escape.
    event.stopImmediatePropagation()
    return
  }
  // Most recently opened wins within a priority. Snapshot one owner: closing it must never
  // route the same press through the next layer (or the Composer's document listener).
  const top = layers.reduce<Layer | undefined>((current, layer) => !current || layer.priority >= current.priority ? layer : current, undefined)
  if (!top) return
  top.escape(event)
}

/** One capture dispatcher for reading layers; ordinary chat Escape remains a later bubble action. */
export function useEscapeLayer(open: boolean, escape: (event: KeyboardEvent) => void, priority: number = ESCAPE_PRIORITY.popover) {
  const handler = useRef(escape)
  handler.current = escape
  useEffect(() => {
    if (!open) return
    const layer: Layer = { priority, escape: event => handler.current(event) }
    if (!layers.length) {
      document.addEventListener('keydown', dispatch, true)
      document.addEventListener('compositionstart', compositionStart, true)
      document.addEventListener('compositionend', compositionEnd, true)
    }
    layers.push(layer)
    publish()
    return () => {
      layers.splice(layers.indexOf(layer), 1)
      if (!layers.length) {
        document.removeEventListener('keydown', dispatch, true)
        document.removeEventListener('compositionstart', compositionStart, true)
        document.removeEventListener('compositionend', compositionEnd, true)
        composing = false
      }
      publish()
    }
  }, [open, priority])
}

/** A background reader must not take modal focus/inertness from a foreground menu or dialog. */
export function useHasHigherEscapeLayer(priority: number): boolean {
  const snapshot = useCallback(() => layers.some(layer => layer.priority > priority), [priority])
  return useSyncExternalStore(subscribe, snapshot, noLayersOnServer)
}

export function consumeEscape(event: KeyboardEvent) {
  event.preventDefault()
  event.stopImmediatePropagation()
}
