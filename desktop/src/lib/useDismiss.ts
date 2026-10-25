import { useEffect, useRef, type RefObject } from 'react'
import { consumeEscape, useEscapeLayer } from './useEscapeLayer'

type Root = RefObject<HTMLElement | null>

/**
 * Close an open popover the way a desktop menu closes: a pointer outside, or Escape.
 *
 * `roots` may name several containers, because a popover rendered through a portal is no longer a
 * DOM descendant of its trigger: both the trigger and the floating layer have to count as inside,
 * or choosing an entry would dismiss the menu before the choice lands.
 *
 * Focus returns to the trigger when Escape closes it, because the popover's contents are already
 * unmounted by then and a keyboard user must not be dropped at the document body.
 */
export function useDismiss(open: boolean, close: () => void, roots: Root | Root[], trigger?: Root) {
  const closeRef = useRef(close)
  closeRef.current = close
  const rootsRef = useRef<Root[]>([])
  rootsRef.current = Array.isArray(roots) ? roots : [roots]
  useEscapeLayer(open, event => {
    consumeEscape(event)
    closeRef.current()
    trigger?.current?.focus()
  })
  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      const target = event.target as Node | null
      if (target && rootsRef.current.some(root => root.current?.contains(target))) return
      closeRef.current()
    }
    // A portalled layer is not in the trigger's tab order, so tabbing past it has to dismiss it —
    // otherwise the menu stays open while the keyboard reader is somewhere else entirely.
    const focusElsewhere = (event: FocusEvent) => {
      const target = event.target as Node | null
      if (target && rootsRef.current.some(root => root.current?.contains(target))) return
      closeRef.current()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', focusElsewhere)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', focusElsewhere)
    }
  }, [open, trigger])
}
