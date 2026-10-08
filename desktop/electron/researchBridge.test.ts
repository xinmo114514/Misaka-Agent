import { describe, expect, it } from 'vitest'
import { researchBridgeArgs, researchCloseOutcome, resolvedResearchBridgeLaunch, sameResearchBridge } from './researchBridge'

describe('independent research host arguments', () => {
  it('opens Last Order in the requested project and resumes its saved research session', () => {
    expect(researchBridgeArgs({ cwd: 'C:\\project', sessionFile: 'C:\\sessions\\root.jsonl' })).toEqual([
      'run', 'misaka', 'desktop-bridge', '--cwd', 'C:\\project', '--research-context',
      '--session', 'C:\\sessions\\root.jsonl',
    ])
  })

  it('creates a fresh independent session when there is no saved owner yet', () => {
    expect(researchBridgeArgs({ cwd: 'C:\\project' })).toEqual([
      'run', 'misaka', 'desktop-bridge', '--cwd', 'C:\\project', '--research-context',
    ])
  })

  it('reuses the new research root session path for subsequent controls', () => {
    const initial = { cwd: 'C:\\project' }
    const resolved = resolvedResearchBridgeLaunch(initial, 'C:\\sessions\\root.jsonl')
    expect(sameResearchBridge(resolved, { cwd: 'C:\\project', sessionFile: 'C:\\sessions\\root.jsonl' })).toBe(true)
  })
})

describe('active-research window close choices', () => {
  it.each([
    ['background', 'hide'], ['stop', 'stop-and-quit'], ['cancel', 'stay-open'],
  ] as const)('maps %s to %s', (choice, result) => {
    expect(researchCloseOutcome(choice)).toBe(result)
  })
})
