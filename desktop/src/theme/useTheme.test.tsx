import { StrictMode } from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { darkTheme, lightTheme } from './builtins'
import { toThemeData } from './registry'
import { applyThemeToDom, useTheme } from './useTheme'
import type { ThemeData } from '../types/global'

function Consumer() { useTheme(); return null }

describe('theme subscription lifetime', () => {
  it('ignores get responses from cleaned up StrictMode effects after a live change', async () => {
    const pulls: Array<(data: ThemeData) => void> = []
    const listeners = new Set<(data: ThemeData) => void>()
    window.theme = {
      listThemes: async () => [], setTheme: async name => ({ ok: true, name }),
      getTheme: () => new Promise(resolve => pulls.push(resolve)),
      onChange: callback => { listeners.add(callback); return () => { listeners.delete(callback) } },
    }
    applyThemeToDom(toThemeData(darkTheme))
    render(<StrictMode><Consumer /></StrictMode>)
    expect(pulls).toHaveLength(2)
    act(() => { for (const listener of listeners) listener(toThemeData(lightTheme)) })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await act(async () => { pulls[0](toThemeData(darkTheme)); pulls[1](toThemeData(darkTheme)) })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('does not repaint after the theme consumer unmounts', async () => {
    let resolvePull: (data: ThemeData) => void = () => {}
    window.theme = {
      listThemes: async () => [], setTheme: async name => ({ ok: true, name }),
      getTheme: () => new Promise(resolve => { resolvePull = resolve }),
      onChange: () => () => {},
    }
    applyThemeToDom(toThemeData(darkTheme))
    const { unmount } = render(<Consumer />)
    unmount()
    await act(async () => { resolvePull(toThemeData(lightTheme)) })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
