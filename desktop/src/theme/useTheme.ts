import { useEffect, useState } from 'react'
import type { ThemeData } from '../types/global'

export function applyThemeToDom(themeData: ThemeData) {
  const root = document.documentElement
  const colors = themeData.colors || {}
  const desktop = themeData.desktop || {}

  root.style.setProperty('--accent', colors.accent || '#cb3862')
  root.style.setProperty('--rose', colors.accent || '#cb3862')
  root.style.setProperty('--rose-lite', colors.mdHeading || '#e8698c')
  root.style.setProperty('--text-main', colors.text || '#ffffff')
  root.style.setProperty('--muted', colors.muted || '#bba8ad')
  root.style.setProperty('--dim', colors.dim || '#a99398')
  root.style.setProperty('--thinking-text', colors.thinkingText || '#c99bb4')

  // Surfaces
  root.style.setProperty('--surface-0', '#18181e')
  root.style.setProperty('--surface-1', '#1e1e24')
  root.style.setProperty('--surface-2', desktop.surface2 || '#25252d')
  root.style.setProperty('--surface-3', desktop.surface3 || '#2c2c36')
  root.style.setProperty('--surface-hover', desktop.surfaceHover || '#232329')

  // Borders
  root.style.setProperty('--border-subtle', desktop.borderSubtle || '#2a2a33')
  root.style.setProperty('--border', desktop.border || '#37373f')
  root.style.setProperty('--border-strong', colors.borderMuted || '#4a3d42')
  root.style.setProperty('--border-accent', desktop.borderAccent || '#8f2545')

  // Other tokens
  root.style.setProperty('--disabled', desktop.disabled || '#6e5f64')
  root.style.setProperty('--focus-ring', desktop.focusRing || '#e8698c')

  // Chart 6 colors
  const chart = desktop.chart || ['#cb3862', '#e0b23e', '#acd39c', '#3c9a80', '#4f70c4', '#c191d4']
  chart.forEach((c, idx) => {
    root.style.setProperty(`--chart-${idx + 1}`, c)
  })
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeData | null>(null)

  useEffect(() => {
    // Initial fetch
    if (window.theme?.getTheme) {
      window.theme.getTheme().then((data) => {
        if (data) {
          applyThemeToDom(data)
          setTheme(data)
        }
      })
    }

    // Live file watcher updates
    if (window.theme?.onChange) {
      const unsubscribe = window.theme.onChange((data) => {
        applyThemeToDom(data)
        setTheme(data)
      })
      return unsubscribe
    }
  }, [])

  return theme
}
