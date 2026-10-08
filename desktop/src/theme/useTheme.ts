import { useEffect } from 'react'
import type { ThemeData } from '../types/global'
import { themeRegistry, themeVariables, toThemeData, validateTheme } from './registry'

/** Matches index.css. Duplicate IPC/StrictMode applications do not restart the fade. */
const TRANSITION_MS = 240
let settleTimer: number | undefined

export function applyThemeToDom(themeData: ThemeData): boolean {
  const errors = validateTheme({ id: themeData?.name, label: themeData?.label, mode: themeData?.mode, colors: themeData?.colors })
  if (errors.length) {
    console.error(`Invalid desktop theme: ${errors.join('; ')}`)
    return false
  }
  const root = document.documentElement
  const vars = themeVariables(themeData)
  const same = root.getAttribute('data-theme') === themeData.name
    && root.getAttribute('data-theme-mode') === themeData.mode
    && root.style.colorScheme === themeData.mode
    && Object.entries(vars).every(([key, value]) => root.style.getPropertyValue(key) === value)
  if (same) return false
  const redraw = Boolean(root.style.getPropertyValue('--accent'))
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value)
  root.setAttribute('data-theme', themeData.name)
  root.setAttribute('data-theme-mode', themeData.mode)
  root.style.colorScheme = themeData.mode
  if (redraw) {
    root.classList.add('theme-switching')
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => root.classList.remove('theme-switching'), TRANSITION_MS + 40)
  }
  window.dispatchEvent(new CustomEvent('misaka-theme-applied', { detail: themeData }))
  return true
}

/** Electron stamps its complete palette before first paint. Browser-only entrypoints
 * initialize the same registry synchronously before mounting any React surfaces. */
export function initializeTheme(): void {
  const root = document.documentElement
  if (root.style.getPropertyValue('--accent')) return
  const theme = themeRegistry.get(root.getAttribute('data-theme')) || themeRegistry.get('dark')!
  applyThemeToDom(toThemeData(theme))
}

export function useTheme(): void {
  useEffect(() => {
    initializeTheme()
    let receivedChange = false
    let disposed = false
    const unsub = window.theme?.onChange?.((data) => {
      if (data) {
        receivedChange = true
        applyThemeToDom(data)
      }
    })
    if (window.theme?.getTheme) {
      window.theme.getTheme().then(data => {
        if (data && !receivedChange && !disposed) applyThemeToDom(data)
      }).catch((error: unknown) => { if (!disposed) console.error('theme:get failed', error) })
    }
    return () => { disposed = true; unsub?.() }
  }, [])
}
