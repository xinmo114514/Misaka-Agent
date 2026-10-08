import fs from 'node:fs'
import path from 'node:path'
import { themeVariables, toThemeData, type ThemeRegistry } from '../src/theme/registry'
import type { DesktopTheme } from '../src/theme/types'

export interface ThemeSetResult {
  ok: boolean
  name: string
  error?: string
}

/** Electron window backgrounds use ARGB hex; titlebar overlay colors use CSS RGBA hex. */
export function nativeColor(cssColor: string): string {
  if (cssColor === 'transparent') return '#00000000'
  if (/^#[\da-f]{8}$/i.test(cssColor)) return `#${cssColor.slice(7, 9)}${cssColor.slice(1, 7)}`
  return cssColor
}

export function windowThemeOptions(theme: DesktopTheme) {
  return {
    backgroundColor: nativeColor(theme.colors['window-background']),
    // Keep the CSS alpha ordering here: Electron's overlay accepts CSS color strings.
    // Actual transparency is platform dependent; do not invent a mode-based backdrop.
    titleBarOverlay: { color: theme.colors['window-background'], symbolColor: theme.colors['window-symbol'], height: 38 },
  }
}

export function themeStartupQuery(theme: DesktopTheme): Record<string, string> {
  return {
    theme: theme.id,
    themePalette: JSON.stringify({ name: theme.id, mode: theme.mode, vars: themeVariables(theme) }),
  }
}

function persistTheme(file: string, name: string): void {
  const temporary = `${file}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify({ name }), 'utf8')
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch { /* Nothing was written or cleanup failed; preserve original error. */ }
    throw error
  }
}

/** Persistence completes before active state changes, so disk errors never half-apply a theme. */
export function createThemeRuntime(registry: ThemeRegistry, file: string) {
  const fallback = registry.get('dark')
  if (!fallback) throw new Error('The desktop theme registry requires a dark fallback')
  let active: DesktopTheme = fallback
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (saved && typeof saved === 'object' && 'name' in saved) active = registry.get(saved.name) ?? fallback
  } catch { /* Missing or malformed state uses the registered default. */ }

  return {
    currentTheme: () => active,
    current: () => toThemeData(active),
    get: (id?: unknown) => {
      const theme = id === undefined ? active : registry.get(id)
      return theme ? toThemeData(theme) : null
    },
    list: () => registry.list(),
    set(id: unknown): ThemeSetResult {
      const next = registry.get(id)
      if (!next) return { ok: false, name: active.id, error: `Unsupported theme: ${String(id)}` }
      try {
        if (next.id !== active.id) persistTheme(file, next.id)
        active = next
        return { ok: true, name: active.id }
      } catch (error) {
        return { ok: false, name: active.id, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
