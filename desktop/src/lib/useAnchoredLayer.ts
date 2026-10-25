import { useLayoutEffect, useState, type RefObject } from 'react'

interface Layer { left: number; top: number; width: number; maxHeight: number; placement?: 'above' | 'below' }
interface AnchoredLayerOptions {
  placement?: 'above' | 'below' | 'auto'
  collision?: boolean
  width?: number
  maxHeight?: number
}

/**
 * Where a floating layer goes when it is rendered through a portal.
 *
 * The page header clips its own children — the session title truncates — so a menu that must not be
 * cut in half cannot stay inside it. Rendering into `document.body` fixes the clipping and costs the
 * CSS anchor, which this measures back from the trigger: fixed coordinates, kept on screen, and
 * re-measured when the window or the column changes size.
 *
 * Existing callers keep the below-trigger menu geometry. Opt-in panels can prefer above or choose
 * the roomier side, flip at an edge, and stay bounded within the viewport.
 */
export function useAnchoredLayer(open: boolean, trigger: RefObject<HTMLElement | null>, align: 'start' | 'end', options?: AnchoredLayerOptions): Layer | null {
  const [style, setStyle] = useState<Layer | null>(null)
  const { placement, collision = false, width: preferredWidth, maxHeight: heightLimit = 480 } = options ?? {}
  useLayoutEffect(() => {
    if (!open) { setStyle(null); return }
    const measure = () => {
      const anchor = trigger.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const margin = 8
      const positioned = placement !== undefined || collision
      const measuredWidth = Math.min(preferredWidth ?? (align === 'end' ? 340 : 360), window.innerWidth - margin * 2)
      const width = positioned ? Math.max(0, measuredWidth) : measuredWidth
      const left = align === 'end'
        ? Math.max(margin, Math.min(rect.right - width, window.innerWidth - margin - width))
        : Math.max(margin, Math.min(rect.left, window.innerWidth - margin - width))
      const top = rect.bottom + 7
      let next: Layer = { left, top, width, maxHeight: Math.max(220, window.innerHeight - top - margin) }
      if (positioned) {
        const edge = (value: number) => Math.max(margin, Math.min(value, window.innerHeight - margin))
        const above = edge(rect.top - 7), below = edge(rect.bottom + 7)
        const room = { above: above - margin, below: Math.max(0, window.innerHeight - below - margin) }
        let side: 'above' | 'below' = placement === 'auto' ? room.above > room.below ? 'above' : 'below' : placement === 'above' ? 'above' : 'below'
        const opposite = side === 'above' ? 'below' : 'above'
        if (collision && room[side] < Math.min(220, heightLimit) && room[opposite] > room[side]) side = opposite
        next = { left, top: side === 'above' ? above : below, width, maxHeight: Math.max(0, Math.min(heightLimit, room[side])), placement: side }
      }
      setStyle(previous => previous && previous.left === next.left && previous.top === next.top
        && previous.width === next.width && previous.maxHeight === next.maxHeight && previous.placement === next.placement ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (trigger.current) observer.observe(trigger.current)
    if (placement !== undefined || collision) {
      // A fixed-size details button also moves when the pane or one of its layout ancestors resizes.
      for (let parent = trigger.current?.parentElement; parent; parent = parent.parentElement) observer.observe(parent)
    }
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true) }
  }, [align, collision, heightLimit, open, placement, preferredWidth, trigger])
  return style
}
