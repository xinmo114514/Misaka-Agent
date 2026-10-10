import { describe, expect, it } from 'vitest'
import { hasOpenDisclosure, selectSessionViewKey } from './sessionViewState'

describe('session view identity', () => {
  it('files reading state under the transcript that is actually displayed', () => {
    expect(selectSessionViewKey({ agentMode: 'agent', currentSessionPath: 'a.jsonl', researchBinding: null })).toBe('a.jsonl')
    expect(selectSessionViewKey({ agentMode: 'research', currentSessionPath: 'a.jsonl', researchBinding: { sessionFile: 'research.jsonl' } })).toBe('research.jsonl')
    expect(selectSessionViewKey({ agentMode: 'research', currentSessionPath: 'a.jsonl', researchBinding: null })).toBe('a.jsonl')
  })
})

describe('open disclosure lookup', () => {
  it('is false for an empty key list and without a session', () => {
    expect(hasOpenDisclosure(null, [])).toBe(false)
    expect(hasOpenDisclosure(null, ['tool:never-mounted'])).toBe(false)
  })
})
