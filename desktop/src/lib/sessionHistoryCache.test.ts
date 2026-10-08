import { describe, expect, it } from 'vitest'
import { SessionHistoryCache } from './sessionHistoryCache'

const history = (path: string, content = path) => ({ path, sessionId: path, title: path, workspace: 'C:/project',
  historyVersion: 'v1', modified: '2026-10-05', messages: [{ id: path, role: 'assistant' as const, content, timestamp: 1 }] })

describe('bounded history cache', () => {
  it('evicts the least recently read of eight sessions', () => {
    const cache = new SessionHistoryCache()
    for (let i = 0; i < 8; i++) cache.put(history(String(i)))
    cache.get('0'); cache.put(history('8'))
    expect(cache.size).toBe(8)
    expect(cache.get('1')).toBeUndefined()
    expect(cache.get('0')).toBeDefined()
  })
  it('keeps its byte limit and skips an individually oversized history', () => {
    const cache = new SessionHistoryCache(8, 2000)
    cache.put(history('small')); cache.put(history('big', 'x'.repeat(2000)))
    expect(cache.retainedBytes).toBeLessThanOrEqual(2000)
    expect(cache.get('small')).toBeDefined()
    expect(cache.get('big')).toBeUndefined()
  })
  it('invalidates changed and deleted files while keeping unchanged histories', () => {
    const cache = new SessionHistoryCache()
    cache.put(history('same')); cache.put(history('changed')); cache.put(history('deleted'))
    cache.invalidateChanged([{ path: 'same', modified: '2026-10-05' }, { path: 'changed', modified: 'new' }])
    expect(cache.get('same')).toBeDefined()
    expect(cache.get('changed')).toBeUndefined()
    expect(cache.get('deleted')).toBeUndefined()
  })
})
