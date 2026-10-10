import { describe, expect, it } from 'vitest'
import type { ToolCall } from '../types/session'
import { formatDuration, redactSecrets, toolCallElapsed, toolCallSummary, toolDisplayName } from './toolDisplay'

const call = (over: Partial<ToolCall>): ToolCall => ({ id: 'c1', name: 'read', status: 'success', ...over })

describe('tool display labels', () => {
  it('names known tools in the reader language and keeps unknown ones readable', () => {
    expect(toolDisplayName('read')).toBe('读取文件')
    expect(toolDisplayName('bash')).toBe('终端命令')
    expect(toolDisplayName('web_search')).toBe('搜索资料')
    expect(toolDisplayName('Task')).toBe('委派子 Agent')
    expect(toolDisplayName('query_database')).toBe('query database')
    expect(toolDisplayName('')).toBe('工具调用')
  })
})

describe('tool call summaries', () => {
  it('prefers the argument that carries the intent', () => {
    expect(toolCallSummary(call({ arguments: { path: 'src/a.ts', limit: 20 } }))).toBe('src/a.ts')
    expect(toolCallSummary(call({ name: 'bash', arguments: { command: 'pytest tests -q', timeout: 60 } }))).toBe('pytest tests -q')
    expect(toolCallSummary(call({ name: 'grep', arguments: { pattern: 'ExecutionGroup', path: 'desktop' } }))).toBe('ExecutionGroup')
  })

  it('falls back to the first non-secret field for unmapped tools', () => {
    expect(toolCallSummary(call({ name: 'query_database', arguments: { sql: 'SELECT 1' } }))).toBe('SELECT 1')
    expect(toolCallSummary(call({ name: 'query_database', arguments: { api_key: 'sk-SECRET', sql: 'SELECT 1' } }))).toBe('SELECT 1')
  })

  it('collapses whitespace, bounds length and never renders an object blob', () => {
    expect(toolCallSummary(call({ name: 'bash', arguments: { command: 'a\n  b\t c' } }))).toBe('a b c')
    expect(toolCallSummary(call({ arguments: { path: 'x'.repeat(900) } })).length).toBeLessThanOrEqual(321)
    expect(toolCallSummary(call({ arguments: undefined }))).toBe('')
  })

  it('summarises list arguments without dumping JSON', () => {
    expect(toolCallSummary(call({ name: 'web_extract', arguments: { urls: ['a', 'b'] } }))).toBe('a、b')
    expect(toolCallSummary(call({ name: 'web_extract', arguments: { urls: ['a', 'b', 'c', 'd', 'e'] } }))).toBe('a、b、c 等 5 项')
  })
})

describe('credential redaction', () => {
  it('masks secret-looking values in summaries and raw text', () => {
    expect(toolCallSummary(call({ name: 'bash', arguments: { command: 'curl -H "Authorization: Bearer abcdef123456"' } })))
      .toBe('curl -H "Authorization: Bearer ••••"')
    expect(redactSecrets('token=ghp_abcdefghijklmnop')).toBe('token=••••')
    expect(redactSecrets('export API_KEY="super-secret-value"')).toBe('export API_KEY="••••"')
    expect(redactSecrets('{"api_key": "sk-live-123456", "model": "gpt"}')).toBe('{"api_key": "••••", "model": "gpt"}')
  })

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('pytest tests -q --cache-clear')).toBe('pytest tests -q --cache-clear')
  })
})

describe('elapsed time', () => {
  it('reports nothing when the transcript never carried a clock', () => {
    expect(toolCallElapsed(call({ status: 'success' }))).toBeNull()
    expect(toolCallElapsed(call({ status: 'success', endedAt: 5_000 }))).toBeNull()
  })

  it('keeps counting while running and freezes on the terminal status', () => {
    expect(toolCallElapsed(call({ status: 'running', startedAt: 1_000 }), 4_000)).toBe(3_000)
    expect(toolCallElapsed(call({ status: 'success', startedAt: 1_000, endedAt: 2_500 }), 9_000)).toBe(1_500)
    expect(toolCallElapsed(call({ status: 'cancelled', startedAt: 1_000 }), 9_000)).toBeNull()
  })

  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(400)).toBe('不足 1 秒')
    expect(formatDuration(3500)).toBe('3.5 秒')
    expect(formatDuration(28_000)).toBe('28 秒')
    expect(formatDuration(78_000)).toBe('1 分 18 秒')
    expect(formatDuration(3_720_000)).toBe('1 小时 2 分')
  })
})
