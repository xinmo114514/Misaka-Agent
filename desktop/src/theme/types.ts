import type { ThemeColors } from './tokens'
export { COLOR_ROLES, isThemeColor } from './tokens'
export type { ColorRole, ThemeColors } from './tokens'

export type ThemeMode = 'dark' | 'light'
export interface ThemeSummary {
  id: string
  label: string
  mode: ThemeMode
}
export interface DesktopTheme extends ThemeSummary {
  colors: ThemeColors
}

/** `name` remains the theme ID on the existing IPC contract. */
export interface ResolvedThemeData {
  name: string
  label: string
  mode: ThemeMode
  colors: ThemeColors
}
