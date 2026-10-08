import { darkTheme } from '../builtins'
import type { DesktopTheme } from '../types'

/** Copy this definition, then add it to registry.ts. Omitted overrides retain the
 * copied theme's complete required palette; no component changes are needed. */
export const oceanTheme: DesktopTheme = {
  id: 'ocean',
  label: '深海 (Ocean)',
  mode: 'dark',
  colors: {
    ...darkTheme.colors,
    accent: '#38bdf8',
    'accent-soft': '#7dd3fc',
    'on-accent': '#082f49',
    'surface-0': '#071923',
    'surface-1': '#0b2533',
    'surface-2': '#123446',
    'surface-3': '#1a465b',
    'surface-hover': '#143c50',
    'border-subtle': '#183a4a',
    border: '#245368',
    'border-accent': '#38bdf8',
    'focus-ring': '#7dd3fc',
    'text-main': '#e0f2fe',
    muted: '#a8c9da',
    dim: '#80a6bb',
    'thinking-text': '#a5d8ef',
    'shadow-ink': '#02101a',
    well: '#04121b',
    'band-1': '#38bdf8',
    'thinking-quiet': '#38bdf8',
    'md-heading': '#e0f2fe',
    'md-link': '#38bdf8',
    'md-code': '#7dd3fc',
    'graph-background': '#071923',
    'graph-grid': '#245368',
    'graph-edge-active': '#38bdf8',
    'graph-minimap-mask': '#071923b3',
    'window-background': '#071923',
    'window-symbol': '#e0f2fe',
  },
}
