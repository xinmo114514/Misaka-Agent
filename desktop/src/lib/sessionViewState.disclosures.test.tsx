import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { forgetSessionView, hasOpenDisclosure, useDisclosure } from './sessionViewState'

it('does not let a mounted main-area disclosure expand a side-area group with the same call id', () => {
  const key = 'tool:cross-surface-fixture'
  const main = 'research:disclosure-fixture:worker:main', side = 'research:disclosure-fixture:worker:side'
  const hook = renderHook(() => useDisclosure(key, main))
  act(() => hook.result.current[1](true))
  expect(hasOpenDisclosure(main, [key])).toBe(true)
  expect(hasOpenDisclosure(side, [key])).toBe(false)
  hook.unmount()
  forgetSessionView(main); forgetSessionView(side)
})

it('keeps duplicate pathless mounts registered until the final opened mount leaves', () => {
  const key = 'tool:duplicate-pathless-fixture'
  const first = renderHook(() => useDisclosure(key, null))
  const second = renderHook(() => useDisclosure(key, null))
  act(() => { first.result.current[1](true); second.result.current[1](true) })
  first.unmount()
  expect(hasOpenDisclosure(null, [key])).toBe(true)
  second.unmount()
  expect(hasOpenDisclosure(null, [key])).toBe(false)
})

it('does not inherit a pathless open choice in a named reading surface', () => {
  const key = 'tool:pathless-isolation-fixture'
  const hook = renderHook(() => useDisclosure(key, null))
  act(() => hook.result.current[1](true))
  expect(hasOpenDisclosure(null, [key])).toBe(true)
  expect(hasOpenDisclosure('research:named-surface', [key])).toBe(false)
  hook.unmount(); forgetSessionView('research:named-surface')
})

it('restores the named surface choice after the row remounts', () => {
  const path = 'research:remount-fixture:worker:main', key = 'tool:remount-fixture'
  const first = renderHook(() => useDisclosure(key, path))
  act(() => first.result.current[1](true))
  first.unmount()
  const again = renderHook(() => useDisclosure(key, path))
  expect(again.result.current[0]).toBe(true)
  again.unmount(); forgetSessionView(path)
})
