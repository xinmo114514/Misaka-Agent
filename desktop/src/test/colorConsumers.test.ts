import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { scanColorConsumers } from './scanColorConsumers'

describe('theme color consumer guard', () => {
  it('rejects literal colors and palette utilities including variant and alpha forms', () => {
    expect(scanColorConsumers('a.tsx', '<div className="hover:bg-emerald-400/50 text-white" style={{ color: "#fff" }} />')).toHaveLength(3)
    expect(scanColorConsumers('a.css', '.x { color: rgb(1 2 3); background: hsl(1 2% 3%); }')).toHaveLength(2)
  })
  it('permits theme roles, transparent shapes, and opaque black mask geometry only', () => {
    expect(scanColorConsumers('a.css', '.x { color: var(--accent); background: transparent; mask-image: linear-gradient(90deg, #000, transparent); }')).toEqual([])
    expect(scanColorConsumers('a.css', '.x { background: #000; }')).toHaveLength(1)
    expect(scanColorConsumers('a.css', '.x { mask-image: linear-gradient(90deg, #fff, transparent); }')).toHaveLength(1)
  })
  it('rejects named visible inks and axis-specific palette utilities', () => {
    expect(scanColorConsumers('a.css', '.x { color: white; background: black; border: 1px solid red; }')).toHaveLength(3)
    expect(scanColorConsumers('a.tsx', '<div className="border-x-white divide-emerald-500" style={{ fill: "black" }} />')).toHaveLength(3)
  })
  it('keeps production components and styles entirely theme driven', () => {
    const src = resolve(process.cwd(), 'src')
    const collect = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = resolve(dir, entry.name)
      return entry.isDirectory() ? collect(path) : /\.(tsx?|css)$/.test(path) && !/\.test\.|__tests__/.test(path) ? [path] : []
    })
    const files = [...collect(resolve(src, 'components')), ...collect(resolve(src, 'styles')), resolve(src, 'index.css'), resolve(src, 'App.tsx')]
    expect(files.flatMap(path => scanColorConsumers(path, readFileSync(path, 'utf8')))).toEqual([])
  })
})
