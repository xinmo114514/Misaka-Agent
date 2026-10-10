import { expect, it } from 'vitest'
import * as module from './researchDiagnostics'

it('records bounded metadata without retaining user content or extra input properties', async () => {
  const entries = (() => {
    for (let index = 0; index < 300; index++) module.recordResearchSubmissionDiagnostic({ requestId: `req-${index}`, text: '/secret TOKEN', sessionId: 'root', password: 'secret' } as any)
    return module.getResearchSubmissionDiagnostics()
  })()
  expect(entries.length).toBeGreaterThan(0)
  expect(entries.length).toBeLessThanOrEqual(100)
  expect(entries.at(-1)).toEqual({ requestId: 'req-299', type: 'string', chars: 13, blank: false, startsWithSlash: true, sessionId: 'root' })
  expect(JSON.stringify(entries)).not.toContain('TOKEN')
  expect(JSON.stringify(entries)).not.toContain('password')
})
