import { beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ThinkingSlider } from './ThinkingSlider'

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isThumb = this.classList.contains('misaka-thinking-thumb')
    const rail = isThumb ? this.parentElement : this
    const left = isThumb ? Number.parseFloat(rail?.style.getPropertyValue('--thumb-x') || '0') : 0
    const width = isThumb ? Number.parseFloat(rail?.style.getPropertyValue('--thumb-box') || '24') : 232
    return { left, width, right: left + width, top: 0, bottom: 32, height: 32, x: left, y: 0, toJSON() {} }
  })
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = () => false
  window.PointerEvent = MouseEvent as typeof PointerEvent
})
it('keeps fill and handle continuous when the nearest preview stop changes before its position', () => {
  const change = vi.fn()
  render(<ThinkingSlider size="compact" levels={['off', 'low', 'medium', 'high']} value="low" onChange={change} />)
  const slider = screen.getByRole('slider')
  fireEvent.pointerDown(slider, { clientX: 12, button: 0, pointerId: 1 })
  fireEvent.pointerMove(slider, { clientX: 132, pointerId: 1 })
  expect(slider).toHaveAttribute('aria-valuenow', '2')
  // With a 30px handle the next stop is x=134.67; the pointer still controls x=117.
  expect(Number.parseFloat(slider.style.getPropertyValue('--thumb-x'))).toBeCloseTo(117)
  expect(Number.parseFloat(slider.style.getPropertyValue('--fill-x'))).toBeCloseTo(132)
  expect(change).not.toHaveBeenCalled()
})
it('preserves the grab offset at the edge of the handle instead of recentering it', () => {
  render(<ThinkingSlider size="compact" levels={['off', 'medium', 'high']} value="medium" onChange={vi.fn()} />)
  const slider = screen.getByRole('slider')
  fireEvent.pointerDown(slider, { clientX: 125, button: 0, pointerId: 1 })
  expect(slider.style.getPropertyValue('--thumb-x')).toBe('101px')
  fireEvent.pointerMove(slider, { clientX: 135, pointerId: 1 })
  expect(slider.style.getPropertyValue('--thumb-x')).toBe('111px')
  expect(slider.style.getPropertyValue('--fill-x')).toBe('126px')
})
it('commits the final release coordinate even if its pointermove was coalesced', () => {
  const change = vi.fn()
  render(<ThinkingSlider size="compact" levels={['low', 'high']} value="low" onChange={change} />)
  const slider = screen.getByRole('slider')
  fireEvent.pointerDown(slider, { clientX: 12, button: 0, pointerId: 1 })
  fireEvent.pointerUp(slider, { clientX: 220, pointerId: 1 })
  expect(change).toHaveBeenCalledExactlyOnceWith('high')
})
it('uses the actual top of a two-stop ladder and focuses on compact open', () => {
  const { container } = render(<ThinkingSlider size="compact" levels={['low', 'high']} value="high" onChange={vi.fn()} />)
  expect(container.firstChild).toHaveAttribute('data-tier', 'max')
  expect(screen.getByRole('slider')).toHaveFocus()
})
it('names an empty ladder instead of treating it as a non-reasoning off stop', () => {
  render(<ThinkingSlider size="compact" levels={[]} value="off" onChange={vi.fn()} />)
  expect(screen.getByText('没有可选深度')).toBeInTheDocument()
  expect(screen.getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
})
it('keeps a fixed high stop static and names the real level', () => {
  const change = vi.fn()
  const { container } = render(<ThinkingSlider size="compact" levels={['high']} value="off" onChange={change} />)
  expect(screen.getByText('高')).toBeInTheDocument()
  expect(container.firstChild).toHaveAttribute('data-tier', 'quiet')
  fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' })
  expect(change).not.toHaveBeenCalled()
})
it('previews during a drag, commits one endpoint on release and clamps thumb travel', () => {
  const change = vi.fn()
  render(<ThinkingSlider size="compact" levels={['off', 'low', 'medium', 'high']} value="low" onChange={change} />)
  const slider = screen.getByRole('slider')
  fireEvent.pointerDown(slider, { clientX: 80, button: 0, pointerId: 1 })
  fireEvent.pointerMove(slider, { clientX: 231, pointerId: 1 })
  expect(change).not.toHaveBeenCalled()
  expect(slider).toHaveAttribute('aria-valuenow', '3')
  expect(slider.style.getPropertyValue('--thumb-x')).toBe('202px')
  fireEvent.pointerUp(slider, { clientX: 231, pointerId: 1 })
  expect(change).toHaveBeenCalledExactlyOnceWith('high')
})
it('cancels both pointer cancellation and lost capture without submitting', () => {
  const change = vi.fn()
  render(<ThinkingSlider levels={['low', 'high']} value="low" onChange={change} />)
  const slider = screen.getByRole('slider')
  fireEvent.pointerDown(slider, { clientX: 232, button: 0, pointerId: 1 })
  fireEvent.lostPointerCapture(slider, { pointerId: 1 })
  expect(slider).toHaveAttribute('aria-valuenow', '0')
  fireEvent.pointerDown(slider, { clientX: 232, button: 0, pointerId: 1 })
  fireEvent.pointerCancel(slider, { pointerId: 1 })
  expect(change).not.toHaveBeenCalled()
})
it('supports arrows, Home and End with announced depth and blocks busy commits', () => {
  const change = vi.fn()
  const { rerender } = render(<ThinkingSlider levels={['off', 'medium', 'high']} value="medium" onChange={change} />)
  const slider = screen.getByRole('slider')
  expect(slider).toHaveAttribute('aria-valuetext', '均衡 (medium)')
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) fireEvent.keyDown(slider, { key })
  expect(change.mock.calls.map(([level]) => level)).toEqual(['high', 'off', 'off', 'high'])
  rerender(<ThinkingSlider levels={['off', 'medium', 'high']} value="medium" onChange={change} busy />)
  fireEvent.keyDown(slider, { key: 'End' })
  expect(change).toHaveBeenCalledTimes(4)
})
it('never submits a keyboard change inside a cancellable pointer gesture', () => {
  const change = vi.fn()
  render(<ThinkingSlider levels={['low', 'high']} value="low" onChange={change} />)
  const slider = screen.getByRole('slider')
  fireEvent.pointerDown(slider, { clientX: 180, button: 0, pointerId: 1 })
  fireEvent.keyDown(slider, { key: 'End' })
  fireEvent.pointerCancel(slider, { pointerId: 1 })
  expect(change).not.toHaveBeenCalled()
  expect(slider).toHaveAttribute('aria-valuenow', '0')
})

it('renders 默认 heading and disabled grayed slider when modelDefault is true', () => {
  const change = vi.fn()
  const reset = vi.fn()
  const { container } = render(<ThinkingSlider size="compact" levels={[]} value="off" onChange={change} modelDefault resetTo="medium" onReset={reset} />)
  expect(screen.getByText('默认')).toBeInTheDocument()
  expect(container.querySelector('[data-default]')).toBeInTheDocument()
  const slider = screen.getByRole('slider')
  expect(slider).toHaveAttribute('aria-disabled', 'true')
  expect(slider).toHaveAttribute('aria-readonly', 'true')
  // dots and thumb are rendered
  expect(container.querySelectorAll('.misaka-thinking-dot').length).toBe(5)
  expect(container.querySelector('.misaka-thinking-thumb')).toBeInTheDocument()
  // reset button is not rendered
  expect(screen.queryByRole('button', { name: /重置到默认档位/ })).not.toBeInTheDocument()
  // keyboard navigation is blocked
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  expect(change).not.toHaveBeenCalled()
  // drag is blocked
  fireEvent.pointerDown(slider, { clientX: 120, button: 0, pointerId: 1 })
  fireEvent.pointerUp(slider, { clientX: 200, pointerId: 1 })
  expect(change).not.toHaveBeenCalled()
})
