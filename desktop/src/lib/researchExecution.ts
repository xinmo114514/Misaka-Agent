import type { ToolCall } from '../types/session'
import type { ResearchExecutionEntry, ResearchExecutionInstance } from '../types/research'

/** The recorded status text a transcript may hold for a call nobody answered. */
const TERMINAL = new Set(['completed', 'closed', 'done', 'failed', 'error', 'cancelled', 'canceled', 'stopped', 'skipped'])

/** Feed a recorded call into the same row the live timeline uses, so both say the same words. */
export function executionEntryToToolCall(entry: ResearchExecutionEntry): ToolCall {
  let args: Record<string, unknown> = {}
  if (entry.arguments) {
    try {
      const parsed = JSON.parse(entry.arguments)
      args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { 参数: entry.arguments }
    } catch {
      // A cut-off preview of a huge argument blob is still worth showing as text.
      args = { 参数: entry.arguments }
    }
  }
  const startedAt = entry.startedAt ?? undefined
  const endedAt = entry.endedAt ?? undefined
  return {
    id: entry.toolCallId,
    name: entry.toolName,
    arguments: args,
    status: entry.status,
    result: entry.result ?? undefined,
    error: entry.error ?? undefined,
    startedAt,
    endedAt,
  }
}

/** A command is only worth showing when the call really ran a terminal tool. */
export function terminalCommandOf(entry: ResearchExecutionEntry): string | null {
  if (entry.toolName !== 'bash' && entry.toolName !== 'powershell' && entry.toolName !== 'exec') return null
  if (!entry.arguments) return null
  try {
    const parsed = JSON.parse(entry.arguments) as Record<string, unknown>
    const command = parsed?.command
    return typeof command === 'string' && command.trim() ? command : null
  } catch {
    return null
  }
}

export function instanceIsRunning(instance: ResearchExecutionInstance | undefined): boolean {
  if (!instance) return false
  return !TERMINAL.has(String(instance.status))
}

/** Only a live instance while its drawer is open earns a poll; a settled transcript does not. */
export function shouldPoll(input: { open: boolean; instance: ResearchExecutionInstance | undefined; availability: string }): boolean {
  if (!input.open) return false
  if (input.availability === 'not_started') return true
  return instanceIsRunning(input.instance)
}

export function recordedTime(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
