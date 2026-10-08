import { describe, expect, it } from 'vitest'
import { themeRegistry, validateTheme } from './registry'

function luminance(hex: string): number {
  const clean = hex.trim().slice(0, 7)
  const r = parseInt(clean.slice(1, 3), 16) / 255
  const g = parseInt(clean.slice(3, 5), 16) / 255
  const b = parseInt(clean.slice(5, 7), 16) / 255
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrast(hex1: string, hex2: string): number {
  const l1 = luminance(hex1)
  const l2 = luminance(hex2)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

describe('custom developer theme suite (Codex, Claude, Forest)', () => {
  const EXPECTED_THEMES = [
    'dark',
    'light',
    'codex-light',
    'codex-dark',
    'claude-light',
    'claude-dark',
    'forest-light',
    'forest-dark',
  ]

  it('registers all 8 shipped and developer theme variants', () => {
    const registeredIds = themeRegistry.list().map((t) => t.id)
    expect(registeredIds).toEqual(expect.arrayContaining(EXPECTED_THEMES))
  })

  it('validates every theme with 0 schema and token role errors', () => {
    for (const id of EXPECTED_THEMES) {
      const theme = themeRegistry.get(id)
      expect(theme, `Theme ${id} must exist in registry`).toBeDefined()
      const errors = validateTheme(theme)
      expect(errors, `Theme ${id} must have 0 validation errors`).toEqual([])
    }
  })

  it('ensures body text and action buttons meet WCAG 4.5:1 contrast standards', () => {
    for (const id of EXPECTED_THEMES) {
      const theme = themeRegistry.get(id)!
      const textMain = theme.colors['text-main']
      const surface0 = theme.colors['surface-0']
      const surface1 = theme.colors['surface-1']
      const accent = theme.colors['accent']
      const onAccent = theme.colors['on-accent']

      const textSurface0Contrast = contrast(textMain, surface0)
      const textSurface1Contrast = contrast(textMain, surface1)
      const accentContrast = contrast(onAccent, accent)

      expect(
        textSurface0Contrast,
        `Theme ${id} text-main (${textMain}) on surface-0 (${surface0}) contrast must be >= 4.5:1, got ${textSurface0Contrast.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5)

      expect(
        textSurface1Contrast,
        `Theme ${id} text-main (${textMain}) on surface-1 (${surface1}) contrast must be >= 4.5:1, got ${textSurface1Contrast.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5)

      expect(
        accentContrast,
        `Theme ${id} on-accent (${onAccent}) on accent (${accent}) contrast must be >= 4.5:1, got ${accentContrast.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(['light', 'codex-light', 'claude-light', 'forest-light'])(
    '%s keeps the canvas, panels, graph and window pure white',
    (id) => {
      const colors = themeRegistry.get(id)!.colors
      for (const role of ['surface-0', 'surface-1', 'graph-background', 'graph-control-surface', 'graph-minimap-background', 'window-background'] as const) {
        expect(colors[role], `${id}: ${role}`).toBe('#ffffff')
      }
      expect(colors['graph-minimap-mask']).toBe('#ffffffb3')
      expect(colors['surface-2']).not.toBe('#ffffff')
      expect(colors['surface-hover']).not.toBe('#ffffff')
    },
  )
})
