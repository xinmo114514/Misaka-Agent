import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useResearchMosaicSizing } from './useResearchMosaicSizing'

function Mosaic({ enabled, readingKey = 'run/root', stream = 0 }: { enabled: boolean; readingKey?: string; stream?: number }) {
  const sizing = useResearchMosaicSizing(6, true, enabled, readingKey)
  return <div ref={sizing.workspaceRef} data-testid="workspace">
    {enabled && <div ref={sizing.layoutRef} data-testid="canvas" data-rows={sizing.mosaic.rowCount} onScroll={sizing.onScroll}>
      <div data-testid="inner">Stream {stream}</div>
    </div>}
  </div>
}

afterEach(() => vi.unstubAllGlobals())

it('restores against committed measured rows after focus-mode resizing without caching a temporary clamp', () => {
  let width = 1440, height = 373
  const resized = new Set<() => void>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized.add(callback) }
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  const positions = new WeakMap<HTMLElement, number>()
  const scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) { return positions.get(this) ?? 0 },
    set(this: HTMLElement, value: number) {
      // Model Chromium's real boundary: the just-remounted stale three-row grid clamps to43,
      // although the measured narrow seven-row grid can retain the saved100 after its commit.
      const rows = Number(this.dataset.rows)
      const max = rows ? Math.max(0, rows * 264 + (rows - 1) * 12 - height) : Infinity
      positions.set(this, Math.min(Math.max(0, value), max))
      this.dispatchEvent(new Event('scroll'))
    },
  })
  try {
    const result = render(<Mosaic enabled />)
    const canvas = () => screen.getByTestId('canvas')
    expect(canvas()).toHaveAttribute('data-rows', '3')
    canvas().scrollTop = 100
    result.rerender(<Mosaic enabled={false} />)
    width = 780; height = 773
    result.rerender(<Mosaic enabled />)
    expect(canvas()).toHaveAttribute('data-rows', '7')
    expect(canvas().scrollTop).toBe(100)
    // Inner scrolling never replaces the outer position, including while restoration settles.
    screen.getByTestId('inner').scrollTop = 17
    fireEvent.scroll(screen.getByTestId('inner'))
    act(() => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(0) } })
    result.rerender(<Mosaic enabled={false} />)
    result.rerender(<Mosaic enabled />)
    expect(canvas().scrollTop).toBe(100)
    // A real new outer offset wins over the pending restoration, including its later RAF.
    canvas().scrollTop = 170
    result.rerender(<Mosaic enabled stream={1} />)
    act(() => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(1) } })
    expect(canvas().scrollTop).toBe(170)
    width = 1000
    act(() => resized.forEach(callback => callback()))
    expect(canvas().scrollTop).toBe(170)
    result.rerender(<Mosaic enabled={false} />)
    result.rerender(<Mosaic enabled />)
    expect(canvas().scrollTop).toBe(170)
    result.unmount()
  } finally {
    delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
    Object.defineProperty(Element.prototype, 'scrollTop', scroll)
  }
})
