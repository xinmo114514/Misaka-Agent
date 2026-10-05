import { useEffect } from 'react'
import type { ThemeData } from '../types/global'

const DARK_FALLBACK = {
  surface0: '#18181e',
  surface1: '#1e1e24',
  surface2: '#25252d',
  surface3: '#2c2c36',
  surfaceHover: '#232329',
  borderSubtle: '#2a2a33',
  border: '#37373f',
  borderStrong: '#4a3d42',
  borderAccent: '#8f2545',
  disabled: '#6e5f64',
  focusRing: '#e8698c',
}

const LIGHT_FALLBACK = {
  surface0: '#faf4f6',
  surface1: '#ffffff',
  surface2: '#f3e9ee',
  surface3: '#e9dde4',
  surfaceHover: '#f7eef3',
  borderSubtle: '#ede0e6',
  border: '#dcc8d1',
  borderStrong: '#c4a4b1',
  borderAccent: '#e0a9bd',
  disabled: '#b8a6ad',
  focusRing: '#b12a55',
}

const DARK_CHART = ['#cb3862', '#e0b23e', '#acd39c', '#3c9a80', '#4f70c4', '#c191d4']
const LIGHT_CHART = ['#b12a55', '#a56a1e', '#3f7a3f', '#2f7a68', '#4f5fa8', '#8d4470']

const CHART_SLOTS = 6
/** Must match the transition duration in index.css; the class outlives the animation by a frame. */
const TRANSITION_MS = 240
const SETTLE_MARGIN_MS = 40

let lastAppliedSignature: string | undefined
let settleTimer: number | undefined

function playThemeTransition(root: HTMLElement) {
  root.classList.add('theme-switching')
  window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => root.classList.remove('theme-switching'), TRANSITION_MS + SETTLE_MARGIN_MS)
}

/** Paint a theme onto :root. Returns true when something actually changed.
 *
 * Duplicate applications are dropped outright rather than merely kept quiet, because several
 * entry points can deliver the same palette: the pull on mount, main's did-finish-load push,
 * StrictMode's double effect, and Windows firing fs.watch twice per save. */
export function applyThemeToDom(themeData: ThemeData): boolean {
  const root = document.documentElement
  const colors = themeData.colors || {}
  const desktop = themeData.desktop || {}

  const isLight = themeData.name === 'light'
  const fb = isLight ? LIGHT_FALLBACK : DARK_FALLBACK

  // Text + brand tokens: colors.* are already var-resolved by the main process
  const vars: Record<string, string> = {
    '--accent': colors.accent || fb.focusRing,
    '--rose': colors.accent || fb.focusRing,
    '--rose-lite': colors.mdHeading || fb.borderStrong,
    '--text-main': colors.text || (isLight ? '#332028' : '#ffffff'),
    '--muted': colors.muted || (isLight ? '#8a7078' : '#bba8ad'),
    '--dim': colors.dim || (isLight ? '#a89098' : '#a99398'),
    '--thinking-text': colors.thinkingText || (isLight ? '#8d4470' : '#c99bb4'),

    // Surfaces — every one comes from the theme file, never hardcoded per-mode
    '--surface-0': desktop.surface0 || fb.surface0,
    '--surface-1': desktop.surface1 || fb.surface1,
    '--surface-2': desktop.surface2 || fb.surface2,
    '--surface-3': desktop.surface3 || fb.surface3,
    '--surface-hover': desktop.surfaceHover || fb.surfaceHover,

    // Borders
    '--border-subtle': desktop.borderSubtle || fb.borderSubtle,
    '--border': desktop.border || fb.border,
    '--border-strong': desktop.borderStrong || colors.borderMuted || fb.borderStrong,
    '--border-accent': desktop.borderAccent || fb.borderAccent,

    // Other tokens
    '--disabled': desktop.disabled || fb.disabled,
    '--focus-ring': desktop.focusRing || fb.focusRing,
  }

  const source = Array.isArray(desktop.chart) && desktop.chart.length > 0 ? desktop.chart : isLight ? LIGHT_CHART : DARK_CHART
  const filledChart = new Set<number>()
  for (let i = 0; i < CHART_SLOTS; i++) {
    const color = source[i]
    if (typeof color === 'string' && color) {
      vars[`--chart-${i + 1}`] = color
      filledChart.add(i + 1)
    }
  }

  const signature = [themeData.name || '', ...Object.entries(vars).map(([k, v]) => k + ':' + v)].join('|')
  if (signature === lastAppliedSignature) return false
  const isRedraw = lastAppliedSignature !== undefined
  lastAppliedSignature = signature

  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)
  // Slots the new theme does not provide must go back to the stylesheet: an inline value left
  // over from the previous theme would outrank :root[data-theme=…] forever.
  for (let slot = 1; slot <= CHART_SLOTS; slot++) {
    if (!filledChart.has(slot)) root.style.removeProperty(`--chart-${slot}`)
  }

  root.setAttribute('data-theme', themeData.name || 'dark')
  root.style.colorScheme = isLight ? 'light' : 'dark'
  if (isRedraw) playThemeTransition(root)
  window.dispatchEvent(new CustomEvent('misaka-theme-applied', { detail: themeData }))
  return true
}

/** Subscribe to theme updates. Two entry points, one writer: this pull and main's
 *  did-finish-load push can arrive in either order, and applyThemeToDom keeps the loser a no-op. */
export function useTheme(): void {
  useEffect(() => {
    if (window.theme?.getTheme) {
      window.theme
        .getTheme()
        .then((data) => {
          if (data) applyThemeToDom(data)
        })
        .catch((error: unknown) => {
          console.error('theme:get failed', error)
        })
    }

    const unsub = window.theme?.onChange?.((data) => {
      if (data) applyThemeToDom(data)
    })

    return () => unsub?.()
  }, [])
}
