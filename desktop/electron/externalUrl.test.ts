import { describe, expect, it } from 'vitest'

import { validatedExternalHttpUrl } from './externalUrl'

describe('validatedExternalHttpUrl', () => {
  it.each([
    ['https://example.com/docs?q=misaka#answer', 'https://example.com/docs?q=misaka#answer'],
    ['http://localhost:5173/path', 'http://localhost:5173/path'],
  ])('accepts a navigable web URL %s', (input, expected) => {
    expect(validatedExternalHttpUrl(input)).toBe(expected)
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///C:/secret.txt',
    '//example.com/path',
    '/relative/path',
    'not a url',
    '',
  ])('rejects a non-web target %s', (input) => {
    expect(validatedExternalHttpUrl(input)).toBeNull()
  })

  it('rejects non-string IPC input', () => {
    expect(validatedExternalHttpUrl({ href: 'https://example.com' })).toBeNull()
  })
})