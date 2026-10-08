import { darkTheme, lightTheme } from './builtins'
import { codexLightTheme, codexDarkTheme } from './themes/codex'
import { claudeLightTheme, claudeDarkTheme } from './themes/claude'
import { forestLightTheme, forestDarkTheme } from './themes/forest'
import { COLOR_ROLES, isThemeColor } from './tokens'
import type { DesktopTheme, ResolvedThemeData, ThemeSummary } from './types'

export interface ThemeRegistry {
  get: (id: unknown) => DesktopTheme | undefined
  list: () => ThemeSummary[]
}

export function validateTheme(value: unknown): string[] {
  if (!value || typeof value !== 'object') return ['definition must be an object']
  const theme = value as Partial<DesktopTheme>
  const errors: string[] = []
  if (typeof theme.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(theme.id)) errors.push('id must be lowercase letters, digits or hyphens')
  if (typeof theme.label !== 'string' || !theme.label.trim()) errors.push('label is required')
  if (theme.mode !== 'dark' && theme.mode !== 'light') errors.push('mode must be dark or light')
  for (const role of COLOR_ROLES) {
    if (!isThemeColor(theme.colors?.[role])) errors.push(`colors.${role} must be hex6, hex8 or transparent`)
  }
  return errors
}

export function createThemeRegistry(definitions: readonly unknown[], diagnose: (message: string) => void = console.error): ThemeRegistry {
  const counts = new Map<unknown, number>()
  for (const value of definitions) {
    const id = (value as Partial<DesktopTheme> | null)?.id
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  const themes = new Map<string, DesktopTheme>()
  for (const value of definitions) {
    const errors = validateTheme(value)
    const theme = value as DesktopTheme | null
    if ((counts.get(theme?.id) || 0) > 1) errors.push('duplicate id')
    if (errors.length) {
      diagnose(`[desktop theme ${String(theme?.id)}] ${errors.join('; ')}`)
      continue
    }
    const valid = theme!
    const colors = Object.freeze(Object.fromEntries(COLOR_ROLES.map(role => [role, valid.colors[role]]))) as DesktopTheme['colors']
    themes.set(valid.id, Object.freeze({ id: valid.id, label: valid.label, mode: valid.mode, colors }))
  }
  return {
    get: id => typeof id === 'string' ? themes.get(id.trim()) : undefined,
    list: () => [...themes.values()].map(({ id, label, mode }) => ({ id, label, mode })),
  }
}

export { codexLightTheme, codexDarkTheme } from './themes/codex'
export { claudeLightTheme, claudeDarkTheme } from './themes/claude'
export { forestLightTheme, forestDarkTheme } from './themes/forest'

/** Add developer definitions here. Both Electron and React import this registry. */
export const themeRegistry = createThemeRegistry([
  darkTheme,
  lightTheme,
  codexLightTheme,
  codexDarkTheme,
  claudeLightTheme,
  claudeDarkTheme,
  forestLightTheme,
  forestDarkTheme,
])

export function toThemeData(theme: DesktopTheme): ResolvedThemeData {
  return { name: theme.id, label: theme.label, mode: theme.mode, colors: theme.colors }
}

export function themeVariables(theme: Pick<DesktopTheme, 'colors'>): Record<string, string> {
  const vars = Object.fromEntries(COLOR_ROLES.map(role => [`--${role}`, theme.colors[role]]))
  vars['--rose'] = theme.colors.accent
  vars['--rose-lite'] = theme.colors['accent-soft']
  return vars
}
