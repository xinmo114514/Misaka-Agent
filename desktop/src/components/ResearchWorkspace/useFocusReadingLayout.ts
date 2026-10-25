import { useLayoutEffect, useState, type RefObject } from 'react'

/** Measure the conversation, not the window: the session/task tree may consume its width. */
export function useFocusReadingLayout(root: RefObject<HTMLDivElement | null>, hasSide: boolean, deferDrawer = false) {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const host = root.current?.closest<HTMLElement>('[data-conversation-viewport]') ?? root.current
    if (!host) return
    const measure = () => {
      const width = host.getBoundingClientRect().width
      const drawer = width > 0 && width < 1000 && !deferDrawer
      setNarrow(drawer)
      if (hasSide) host.dataset.researchSideLayout = drawer ? 'drawer' : 'wide'
      else delete host.dataset.researchSideLayout
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => { observer.disconnect(); delete host.dataset.researchSideLayout }
  }, [root, hasSide, deferDrawer])
  return narrow
}
