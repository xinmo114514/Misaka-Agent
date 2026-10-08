import { afterEach, describe, expect, it } from 'vitest'
import { readSidebarVisible, saveSidebarVisible } from './sidebarPreference'

afterEach(() => localStorage.clear())

describe('sidebar visibility preference', () => {
  it('defaults to visible and restores a previously hidden sidebar', () => {
    expect(readSidebarVisible()).toBe(true)
    saveSidebarVisible(false)
    expect(readSidebarVisible()).toBe(false)
  })

  it('restores a previously visible sidebar', () => {
    saveSidebarVisible(true)
    expect(readSidebarVisible()).toBe(true)
  })
})
