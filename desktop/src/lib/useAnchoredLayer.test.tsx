import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAnchoredLayer } from './useAnchoredLayer'

let trigger: { current: HTMLButtonElement }
let ancestor: HTMLDivElement
let rect: { left: number; right: number; top: number; bottom: number }
const observers = new Set<{ targets: Set<Element>; callback: ResizeObserverCallback }>()

beforeEach(() => {
  vi.stubGlobal('innerWidth', 800)
  vi.stubGlobal('innerHeight', 600)
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(public callback: ResizeObserverCallback) { observers.add(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { observers.delete(this) }
  })
  ancestor = document.createElement('div')
  const button = document.createElement('button')
  ancestor.append(button)
  document.body.append(ancestor)
  rect = { left: 300, right: 340, top: 500, bottom: 528 }
  button.getBoundingClientRect = () => rect as DOMRect
  trigger = { current: button }
})

afterEach(() => { ancestor.remove(); observers.clear(); vi.unstubAllGlobals() })

it('retains the default below placement and legacy minimum height for existing callers', () => {
  const { result } = renderHook(() => useAnchoredLayer(true, trigger, 'end'))
  expect(result.current).toEqual({ left: 8, top: 535, width: 340, maxHeight: 220 })
})

it('anchors an opt-in footer panel above the trigger with bounded height', () => {
  const { result } = renderHook(() => useAnchoredLayer(true, trigger, 'end', { placement: 'above', collision: true, width: 360, maxHeight: 400 }))
  expect(result.current).toEqual({ left: 8, top: 493, width: 360, maxHeight: 400, placement: 'above' })
})

it('flips an above panel below a top-edge trigger and clamps it to the eight-pixel viewport', () => {
  vi.stubGlobal('innerWidth', 320)
  vi.stubGlobal('innerHeight', 240)
  rect = { left: 300, right: 318, top: 8, bottom: 36 }
  const { result } = renderHook(() => useAnchoredLayer(true, trigger, 'end', { placement: 'above', collision: true, width: 360, maxHeight: 480 }))
  expect(result.current).toEqual({ left: 8, top: 43, width: 304, maxHeight: 189, placement: 'below' })
})

it('chooses the roomier side for automatic collision placement', () => {
  rect = { left: 400, right: 440, top: 252, bottom: 280 }
  const { result } = renderHook(() => useAnchoredLayer(true, trigger, 'start', { placement: 'auto', collision: true, width: 360, maxHeight: 480 }))
  expect(result.current).toEqual({ left: 400, top: 287, width: 360, maxHeight: 305, placement: 'below' })
})

it('tracks ancestor resize and nested scrolling even when the trigger keeps its fixed dimensions', () => {
  const { result } = renderHook(() => useAnchoredLayer(true, trigger, 'end', { placement: 'above', collision: true, width: 360, maxHeight: 400 }))
  rect = { ...rect, top: 400, bottom: 428 }
  act(() => {
    for (const observer of observers) if (observer.targets.has(ancestor)) observer.callback([], observer as unknown as ResizeObserver)
  })
  expect(result.current?.top).toBe(393)
  rect = { ...rect, top: 300, bottom: 328 }
  act(() => ancestor.dispatchEvent(new Event('scroll')))
  expect(result.current?.top).toBe(293)
  act(() => { vi.stubGlobal('innerWidth', 260); window.dispatchEvent(new Event('resize')) })
  expect(result.current?.width).toBe(244)
  expect(result.current?.left).toBe(8)
})

it('clears its coordinates and resize ownership when closed', () => {
  const { result, rerender } = renderHook(({ open }) => useAnchoredLayer(open, trigger, 'end', { placement: 'above', collision: true }), { initialProps: { open: true } })
  expect(observers.size).toBe(1)
  rerender({ open: false })
  expect(result.current).toBeNull()
  expect(observers.size).toBe(0)
})
