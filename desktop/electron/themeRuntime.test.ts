import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createThemeRuntime, nativeColor, themeStartupQuery, windowThemeOptions } from './themeRuntime'
import { createThemeRegistry, themeRegistry } from '../src/theme/registry'

const temporaryDirectories: string[] = []
function statePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'misaka-theme-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'desktop-theme.json')
}
function bootstrap(query: Record<string, string>) {
  const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
  const dom = document.implementation.createHTMLDocument('First paint')
  vm.runInNewContext(script, { document: dom, location: { search: `?${new URLSearchParams(query)}` }, URLSearchParams })
  return dom.documentElement
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('theme persistence', () => {
  it('restores valid IDs and falls back to dark for removed or malformed persisted IDs', () => {
    const file = statePath()
    fs.writeFileSync(file, JSON.stringify({ name: 'light' }))
    expect(createThemeRuntime(themeRegistry, file).current().name).toBe('light')
    for (const record of ['{"name":"removed-palette"}', '{', '{"name":42}']) {
      fs.writeFileSync(file, record)
      expect(createThemeRuntime(themeRegistry, file).current().name).toBe('dark')
    }
  })

  it('persists registry IDs atomically and leaves no temporary file', () => {
    const file = statePath()
    const runtime = createThemeRuntime(themeRegistry, file)
    expect(runtime.set('light')).toEqual({ ok: true, name: 'light' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ name: 'light' })
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(createThemeRuntime(themeRegistry, file).current().name).toBe('light')
  })

  it('restores a custom registry fixture including an independently configured mode and colors', () => {
    const file = statePath()
    const base = themeRegistry.get('dark')!
    const registry = createThemeRegistry([base, { ...base, id: 'ocean-test', label: 'Ocean', mode: 'light', colors: { ...base.colors, accent: '#123456' } }])
    expect(createThemeRuntime(registry, file).set('ocean-test')).toEqual({ ok: true, name: 'ocean-test' })
    expect(createThemeRuntime(registry, file).current()).toMatchObject({ name: 'ocean-test', mode: 'light', colors: { accent: '#123456' } })
  })

  it('rejects unknown IDs without changing active state or the persisted record', () => {
    const file = statePath()
    fs.writeFileSync(file, '{"name":"light"}')
    const runtime = createThemeRuntime(themeRegistry, file)
    expect(runtime.set('missing')).toMatchObject({ ok: false, name: 'light' })
    expect(runtime.current().name).toBe('light')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"name":"light"}')
  })

  it('preserves active state and saved record when atomic rename fails, reporting the failure', () => {
    const file = statePath()
    fs.writeFileSync(file, '{"name":"light"}')
    const runtime = createThemeRuntime(themeRegistry, file)
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk rename failed') })
    expect(runtime.set('dark')).toEqual({ ok: false, name: 'light', error: 'disk rename failed' })
    expect(runtime.current().name).toBe('light')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"name":"light"}')
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('reports write errors before mutating active state or the persisted record', () => {
    const file = statePath()
    fs.writeFileSync(file, '{"name":"light"}')
    const runtime = createThemeRuntime(themeRegistry, file)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('disk full') })
    expect(runtime.set('dark')).toEqual({ ok: false, name: 'light', error: 'disk full' })
    expect(runtime.current().name).toBe('light')
    expect(fs.readFileSync(file, 'utf8')).toBe('{"name":"light"}')
  })
})

describe('native chrome and first paint', () => {
  it.each(['light', 'codex-light', 'claude-light', 'forest-light'])(
    'bootstraps %s with the same white canvas and window before React loads',
    (id) => {
      const theme = themeRegistry.get(id)!
      const root = bootstrap(themeStartupQuery(theme))
      expect(root.dataset.themeMode).toBe('light')
      expect(root.style.getPropertyValue('--surface-0')).toBe('#ffffff')
      expect(root.style.getPropertyValue('--graph-background')).toBe('#ffffff')
      expect(root.style.getPropertyValue('--window-background')).toBe('#ffffff')
      expect(root.style.getPropertyValue('--glass-highlight')).toBe('#ffffffcc')
      expect(windowThemeOptions(theme).backgroundColor).toBe('#ffffff')
    },
  )

  it('converts CSS alpha ordering for Electron without changing opaque colors', () => {
    expect(nativeColor('#12345678')).toBe('#78123456')
    expect(nativeColor('#abcdef')).toBe('#abcdef')
    expect(nativeColor('transparent')).toBe('#00000000')
  })

  it('uses native color tokens rather than inferring chrome colors from the theme mode', () => {
    const base = themeRegistry.get('dark')!
    const custom = { ...base, id: 'day-bright', mode: 'light' as const, colors: { ...base.colors, 'window-background': '#12345678', 'window-symbol': '#987654' } }
    expect(windowThemeOptions(custom)).toEqual({
      backgroundColor: '#78123456', titleBarOverlay: { color: '#12345678', symbolColor: '#987654', height: 38 },
    })
  })

  it('carries the complete custom palette and stamps all valid variables before React loads', () => {
    const base = themeRegistry.get('dark')!
    const theme = { ...base, id: 'ocean-test', mode: 'light' as const, colors: { ...base.colors, 'surface-0': '#123456', 'accent': '#11223344' } }
    const query = themeStartupQuery(theme)
    expect(query.theme).toBe('ocean-test')
    const payload = JSON.parse(query.themePalette)
    expect(payload).toMatchObject({ name: 'ocean-test', mode: 'light', vars: { '--surface-0': '#123456', '--accent': '#11223344' } })
    const root = bootstrap(query)
    expect(root.dataset.theme).toBe('ocean-test')
    expect(root.dataset.themeMode).toBe('light')
    expect(root.style.colorScheme).toBe('light')
    for (const [key, value] of Object.entries(payload.vars)) expect(root.style.getPropertyValue(key)).toBe(value)
  })

  it('ignores unknown variables and unsafe CSS values', () => {
    const malicious = { name: 'injected', mode: 'dark', vars: { '--surface-0': '#ffffff', '--accent': 'red; background:url(https://attacker.test)', '--arbitrary': '#123456' } }
    const root = bootstrap({ theme: 'injected', themePalette: JSON.stringify(malicious) })
    expect(root.style.getPropertyValue('--accent')).toBe('')
    expect(root.style.getPropertyValue('--arbitrary')).toBe('')
  })

  it('rejects incomplete or mixed-invalid palettes before stamping metadata or any color', () => {
    const valid = JSON.parse(themeStartupQuery(themeRegistry.get('dark')!).themePalette)
    for (const payload of [
      { name: 'dark', mode: 'dark', vars: { '--accent': '#ffffff' } },
      { ...valid, vars: { ...valid.vars, '--accent': 'red; background:url(https://attacker.test)' } },
      { ...valid, vars: { ...valid.vars, '--surface-0': undefined } },
    ]) {
      const root = bootstrap({ theme: 'dark', themePalette: JSON.stringify(payload) })
      expect(root.dataset.theme).toBeUndefined()
      expect(root.dataset.themeMode).toBeUndefined()
      expect(root.style.cssText).toBe('')
    }
  })

  it('applies a complete valid palette while ignoring extra unknown variables', () => {
    const query = themeStartupQuery(themeRegistry.get('dark')!)
    const valid = JSON.parse(query.themePalette)
    valid.vars['--arbitrary'] = '#123456'
    const root = bootstrap({ ...query, themePalette: JSON.stringify(valid) })
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.getPropertyValue('--accent')).toBe('#cb3862')
    expect(root.style.getPropertyValue('--arbitrary')).toBe('')
  })

  it('rejects mismatched IDs, malformed payloads and invalid modes without stamping the document', () => {
    for (const payload of [
      '{',
      JSON.stringify({ name: 'mismatch', mode: 'dark', vars: { '--accent': '#ffffff' } }),
      JSON.stringify({ name: 'test', mode: 'injected', vars: { '--accent': '#ffffff' } }),
      JSON.stringify({ name: 'test;injected', mode: 'dark', vars: { '--accent': '#ffffff' } }),
    ]) {
      const root = bootstrap({ theme: 'test', themePalette: payload })
      expect(root.dataset.theme).toBeUndefined()
      expect(root.style.getPropertyValue('--accent')).toBe('')
    }
  })
})
