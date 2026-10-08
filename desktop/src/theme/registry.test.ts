import { describe, expect, it } from 'vitest'
import * as registryModule from './registry'
import { darkTheme, lightTheme } from './builtins'

describe('developer theme registry', () => {
  it('lists a registered custom theme with its independent light mode', () => {
    const custom = { ...lightTheme, id: 'daybreak', label: '晨光' }
    const registry = registryModule.createThemeRegistry([darkTheme, lightTheme, custom])
    expect(registry.list()).toContainEqual({ id: 'daybreak', label: '晨光', mode: 'light' })
    expect(registry.get('daybreak')?.colors['text-main']).toBe('#332028')
  })

  it('excludes every duplicate id, invalid color and incomplete palette with diagnostics', () => {
    const diagnostics: string[] = []
    const registry = registryModule.createThemeRegistry([
      darkTheme, lightTheme,
      { ...darkTheme, id: 'duplicate' }, { ...lightTheme, id: 'duplicate' },
      { ...darkTheme, id: 'bad', colors: { ...darkTheme.colors, accent: 'red; display:none' } },
      { ...darkTheme, id: 'partial', colors: { accent: '#123456' } },
    ], message => diagnostics.push(message))
    expect(registry.list().map(theme => theme.id)).toEqual(['dark', 'light'])
    expect(diagnostics.join('\n')).toMatch(/duplicate/)
    expect(diagnostics.join('\n')).toMatch(/bad.*accent/)
    expect(diagnostics.join('\n')).toMatch(/partial/)
    expect(registry.get('../light')).toBeUndefined()
  })

  it('snapshots definitions so later mutations cannot produce half-applied palettes', () => {
    const mutable = { ...darkTheme, id: 'custom', colors: { ...darkTheme.colors } }
    const registry = registryModule.createThemeRegistry([mutable])
    mutable.colors.accent = '#123456'
    expect(registry.get('custom')?.colors.accent).toBe('#cb3862')
    expect(Object.isFrozen(registry.get('custom')?.colors)).toBe(true)
  })

  it('maps every role and compatibility aliases without dropping alpha colors', () => {
    const theme = { ...darkTheme, colors: { ...darkTheme.colors, overlay: '#12345680', 'shadow-catch': 'transparent' } }
    const vars = registryModule.themeVariables(theme)
    expect(vars['--overlay']).toBe('#12345680')
    expect(vars['--shadow-catch']).toBe('transparent')
    expect(vars['--rose']).toBe('#cb3862')
    expect(vars['--rose-lite']).toBe('#e8698c')
    expect(vars['--success']).toBe('#acd39c')
  })
})
