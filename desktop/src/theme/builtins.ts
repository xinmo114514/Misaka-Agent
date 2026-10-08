import { PALETTE, type ThemeColors } from './tokens'
import type { DesktopTheme } from './types'

export const darkTheme: DesktopTheme = {
  id: 'dark', label: '深色主题 (Dark)', mode: 'dark',
  colors: Object.fromEntries(PALETTE.map(([role, dark]) => [role, dark])) as ThemeColors,
}
export const lightTheme: DesktopTheme = {
  id: 'light', label: '浅色主题 (Light)', mode: 'light',
  colors: Object.fromEntries(PALETTE.map(([role, , light]) => [role, light])) as ThemeColors,
}
