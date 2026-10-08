import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyThemeToDom } from './useTheme'
import { withAlpha } from './useThemeTokens'
import type { ThemeData } from '../types/global'
import { darkTheme, lightTheme } from './builtins'
import { themeRegistry, toThemeData, validateTheme } from './registry'

describe('complete desktop theme application', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('style')
    vi.resetModules()
  })

  it('applies status, foreground and window colors independently of the theme id', () => {
    const theme = toThemeData({ ...lightTheme, id: 'daybreak', colors: {
      ...lightTheme.colors, accent: '#123456', 'text-main': '#234567', success: '#345678',
      'success-surface': '#456789', 'on-accent': '#56789a', 'window-symbol': '#6789ab',
    } })
    applyThemeToDom(theme)
    expect(document.documentElement.style.getPropertyValue('--success')).toBe('#345678')
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe('#56789a')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.documentElement.getAttribute('data-theme-mode')).toBe('light')
  })

  it('fully replaces a previous palette and drops duplicate applications', () => {
    applyThemeToDom(toThemeData({ ...darkTheme, id: 'custom', colors: { ...darkTheme.colors, 'chart-6': '#123456', overlay: '#aabbcc80' } }))
    const listener = vi.fn()
    window.addEventListener('misaka-theme-applied', listener)
    expect(applyThemeToDom(toThemeData(lightTheme))).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--chart-6')).toBe('#8d4470')
    expect(document.documentElement.style.getPropertyValue('--overlay')).toBe('#00000099')
    expect(applyThemeToDom(toThemeData(lightTheme))).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('misaka-theme-applied', listener)
  })

  it('keeps the existing palette when receiving incomplete or invalid data', () => {
    applyThemeToDom(toThemeData(darkTheme))
    const previous = document.documentElement.getAttribute('style')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(applyThemeToDom({ name: 'broken', label: 'broken', mode: 'light', colors: { accent: '#123456' } } as ThemeData)).toBe(false)
    expect(document.documentElement.getAttribute('style')).toBe(previous)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('preserves source transparency when composing a canvas mask', () => {
    expect(withAlpha('#12345680', 0.5)).toBe('rgba(18, 52, 86, 0.25098039215686274)')
    expect(withAlpha('transparent', 0.7)).toBe('rgba(0, 0, 0, 0)')
  })

  it.each([
    ['light', '#ffffffcc'], ['codex-light', '#ffffffcc'],
    ['claude-light', '#ffffffcc'], ['forest-light', '#ffffffcc'],
    ['dark', '#ffffff24'], ['codex-dark', '#ffffff24'],
    ['claude-dark', '#ffffff24'], ['forest-dark', '#ffffff24'],
  ])('applies the %s glass highlight without inferring it from the theme id', (id, highlight) => {
    applyThemeToDom(toThemeData(themeRegistry.get(id)!))
    expect(document.documentElement.style.getPropertyValue('--glass-highlight')).toBe(highlight)
  })

  it('rejects palettes missing the glass highlight instead of applying half a material', () => {
    const colors: Record<string, string> = { ...lightTheme.colors }
    delete colors['glass-highlight']
    expect(validateTheme({ ...lightTheme, colors }).some(error => error.includes('glass-highlight'))).toBe(true)
  })
})
