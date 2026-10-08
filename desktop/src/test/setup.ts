import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(cleanup)

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
  }))
}
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
    if (typeof options === 'object' && options.top !== undefined) this.scrollTop = options.top
    else if (typeof y === 'number') this.scrollTop = y
  }
}
