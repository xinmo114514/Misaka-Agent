import { useLayoutEffect, useRef, useState, type UIEvent } from 'react'
import { getResearchMosaicLayout, researchMosaicRowCap } from '../../lib/researchMultiLayout'

/** Measure the workspace, not its inset grid, and only the available viewport height. */
export function useResearchMosaicSizing(memberCount: number, hasController: boolean, enabled: boolean, readingKey: string) {
  const workspaceRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const reading = useRef(new Map<string, number>())
  const restoration = useRef<{
    key: string; layout: HTMLDivElement; target: number; appliedTop: number | null; applying: boolean
  } | null>(null)
  const restorationFrame = useRef<number | null>(null)

  useLayoutEffect(() => {
    const workspace = workspaceRef.current
    const layout = layoutRef.current
    if (!enabled || !workspace || !layout) return
    const measure = () => {
      const width = workspace.clientWidth
      const height = layout.clientHeight
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(workspace)
    observer.observe(layout)
    return () => observer.disconnect()
  }, [enabled])

  useLayoutEffect(() => {
    const layout = layoutRef.current
    restoration.current = enabled && layout
      ? { key: readingKey, layout, target: reading.current.get(readingKey) ?? 0, appliedTop: null, applying: false }
      : null
    return () => {
      restoration.current = null
      if (restorationFrame.current !== null) window.cancelAnimationFrame(restorationFrame.current)
      restorationFrame.current = null
    }
  }, [enabled, readingKey])

  useLayoutEffect(() => {
    const pending = restoration.current
    const workspace = workspaceRef.current
    if (!enabled || !pending || pending.key !== readingKey || pending.layout !== layoutRef.current || !workspace) return
    // A remounted grid first renders the previous multi viewport's spans. Wait until the
    // measured dimensions have committed their new spans/cap before Chromium clamps this write.
    if (workspace.clientWidth !== size.width || pending.layout.clientHeight !== size.height) return
    pending.applying = true
    pending.layout.scrollTop = pending.target
    pending.appliedTop = pending.layout.scrollTop
    pending.applying = false
    if (pending.target === 0) { restoration.current = null; return }
    if (restorationFrame.current !== null) window.cancelAnimationFrame(restorationFrame.current)
    restorationFrame.current = window.requestAnimationFrame(() => {
      restorationFrame.current = null
      if (restoration.current !== pending || layoutRef.current !== pending.layout) return
      reading.current.set(pending.key, pending.layout.scrollTop)
      restoration.current = null
    })
  }, [enabled, readingKey, size.width, size.height])

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const pending = restoration.current
    if (pending?.layout === event.currentTarget && pending.key === readingKey) {
      // Ignore only unsettled restoration events; a new reader-selected offset takes over.
      if (pending.applying || pending.appliedTop === null || event.currentTarget.scrollTop === pending.appliedTop) return
      restoration.current = null
      if (restorationFrame.current !== null) window.cancelAnimationFrame(restorationFrame.current)
      restorationFrame.current = null
    }
    reading.current.set(readingKey, event.currentTarget.scrollTop)
  }
  const mosaic = getResearchMosaicLayout(size.width, memberCount, hasController)
  return {
    workspaceRef, layoutRef, onScroll, mosaic,
    rowCap: researchMosaicRowCap(size.height, mosaic.rowCount, mosaic.soloController),
    tinyHeight: size.height > 0 && size.height < 264,
  }
}
