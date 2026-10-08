import { createThemeRegistry, themeRegistry } from '../src/theme/registry'
import { COLOR_ROLES, type ThemeColors } from '../src/theme/tokens'
import type { DesktopTheme } from '../src/theme/types'
import type { ResearchGraphPayload } from '../src/types/research'

/** Every role differs from the shipped palettes; representative roles use literal,
 * hand-checked RGB values so acceptance asserts actual consumer paint, not helpers. */
const probeColors = Object.fromEntries(COLOR_ROLES.map((role, index) => [
  role, `#${((index + 1) * 7919).toString(16).padStart(6, '0')}`,
])) as unknown as ThemeColors

export const probeTheme: DesktopTheme = {
  id: 'theme-probe', label: '开发主题验收', mode: 'light',
  colors: {
    ...probeColors,
    'surface-0': '#061b28', 'surface-1': '#103b4a', 'surface-2': '#174b5a',
    'surface-3': '#245f6b', 'surface-hover': '#30717b',
    'text-main': '#e7fff5', muted: '#bceedd', dim: '#99ccbb',
    accent: '#43ffe1', 'on-accent': '#082e27', 'on-chart': '#112233',
    'border-accent': '#55ffaa', 'focus-ring': '#aaffdd',
    'permission-plan': '#00ccff', 'permission-edit': '#00ff88', 'permission-bypass': '#ff66cc',
    overlay: '#12345680',
    'md-heading': '#ffee88', 'md-link': '#55ddff', 'md-code': '#ffaadd', 'md-quote': '#aaffdd',
    'tool-title': '#ddffaa', 'tool-output': '#99eeff', 'tool-error': '#ff7755',
    'graph-background': '#04232e', 'graph-grid': '#336677', 'graph-edge-active': '#e0ff55',
    'graph-control-bg': '#114455', 'graph-control-hover': '#226677', 'graph-control-text': '#bbffee',
    'graph-control-surface': '#0f3440', 'graph-minimap-background': '#133d49',
    'graph-minimap-mask': '#01234580',
  },
}
export const fixtureThemes = createThemeRegistry([
  ...themeRegistry.list().map(({ id }) => themeRegistry.get(id)!), probeTheme,
])

export const themeGraph: ResearchGraphPayload = {
  run: 'theme-run', question: '主题研究验收', status: 'executing', phase: 'research',
  nodes: [
    { id: 'root', kind: 'root', question: '根节点配色', depth: 0, status: 'closed', parents: [], children: ['child'] },
    { id: 'child', kind: 'alt', question: '分支节点配色', depth: 1, status: 'executing', parents: ['root'], children: [] },
  ],
}
