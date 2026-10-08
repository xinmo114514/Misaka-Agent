import { useEffect, useState } from 'react'

export interface ThemeTokens {
  surface0: string
  surface1: string
  surface2: string
  surface3: string
  border: string
  borderSubtle: string
  borderStrong: string
  borderAccent: string
  accent: string
  textMain: string
  muted: string
  dim: string
  success: string
  warning: string
  danger: string
  info: string
  graphBackground: string
  graphGrid: string
  graphEdge: string
  graphEdgeActive: string
  graphEdgeStrong: string
  graphMinimapMask: string
  graphControlBg: string
  graphControlHover: string
  graphControlText: string
  graphControlBorder: string
}

const VAR_NAMES: Record<keyof ThemeTokens, string> = {
  surface0: '--surface-0',
  surface1: '--surface-1',
  surface2: '--surface-2',
  surface3: '--surface-3',
  border: '--border',
  borderSubtle: '--border-subtle',
  borderStrong: '--border-strong',
  borderAccent: '--border-accent',
  accent: '--accent',
  textMain: '--text-main',
  muted: '--muted',
  dim: '--dim',
  success: '--success',
  warning: '--warning',
  danger: '--danger',
  info: '--info',
  graphBackground: '--graph-background',
  graphGrid: '--graph-grid',
  graphEdge: '--graph-edge',
  graphEdgeActive: '--graph-edge-active',
  graphEdgeStrong: '--graph-edge-strong',
  graphMinimapMask: '--graph-minimap-mask',
  graphControlBg: '--graph-control-bg',
  graphControlHover: '--graph-control-hover',
  graphControlText: '--graph-control-text',
  graphControlBorder: '--graph-control-border',
}

function readTokens(): ThemeTokens {
  const style = getComputedStyle(document.documentElement)
  const out = {} as ThemeTokens
  for (const key of Object.keys(VAR_NAMES) as (keyof ThemeTokens)[]) {
    out[key] = style.getPropertyValue(VAR_NAMES[key]).trim()
  }
  return out
}

/** Resolved theme tokens for canvas-style surfaces (SVG fill/stroke) that
 *  cannot consume a CSS variable directly. Re-reads on every theme application. */
export function useThemeTokens(): ThemeTokens {
  const [tokens, setTokens] = useState<ThemeTokens>(() =>
    typeof window === 'undefined'
      ? ({} as ThemeTokens)
      : readTokens(),
  )

  useEffect(() => {
    const refresh = () => setTokens(readTokens())
    refresh()
    window.addEventListener('misaka-theme-applied', refresh)
    return () => window.removeEventListener('misaka-theme-applied', refresh)
  }, [])

  return tokens
}

/** Convert a resolved hex token into an rgba() string with the given alpha. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim()
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(hex)) {
    return 'rgba(0, 0, 0, 0)'
  }
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const sourceAlpha = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1
  const composed = sourceAlpha * Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 0))
  return `rgba(${r}, ${g}, ${b}, ${composed})`
}
