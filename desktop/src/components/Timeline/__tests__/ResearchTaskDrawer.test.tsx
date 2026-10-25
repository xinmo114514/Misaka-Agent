import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchTaskDrawer } from '../ResearchTaskDrawer'
import { useSessionStore } from '../../../store/useSessionStore'
import { installBridge } from '../../../lib/bridge'
import type { ResearchExecutionPage } from '../../../types/research'

let deliver: ((message: any) => void) | null = null
let sent: any[] = []
let disposeBridge: (() => void) | null = null
let responder: (command: any) => void = () => {}

function respond(command: any, data: unknown) {
  deliver?.({ type: 'ack', requestId: command.requestId, ok: true, data })
}

const taskDetail = {
  id: 't_licences', title: '核对 licence 记录', body: '找出 1805 年的征税依据',
  status: 'running', assignee: 'archive-specialist', round: 1, artifacts: [], findings: [],
}

function page(overrides: Partial<ResearchExecutionPage> = {}): ResearchExecutionPage {
  return {
    instances: [{ instanceId: 'tr_1', taskId: 't_licences', generation: 1, attempt: 1, phase: 'worker',
      status: 'running', startedAt: 1_760_000_000_000, endedAt: null, exitCode: null, failureKind: null,
      summary: null, source: 'task_run' }],
    entries: [{ toolCallId: 'call-1', toolName: 'bash', status: 'success',
      arguments: JSON.stringify({ command: 'ls /srv/archives' }), argumentsTruncated: false,
      resultTruncated: false, result: 'ledger-1805.txt', error: null,
      startedAt: 1_760_000_100_000, endedAt: 1_760_000_103_000, recordIndex: 1 }],
    nextCursor: null, hasMore: false, availability: 'available', reason: null,
    runId: 'r_1', taskId: 't_licences', instanceId: 'tr_1',
    ...overrides,
  }
}

beforeEach(() => {
  vi.useRealTimers()
  sent = []
  responder = command => {
    if (command.type === 'get_research_task') respond(command, { detail: taskDetail })
    if (command.type === 'get_research_execution') respond(command, { execution: page() })
  }
  window.bridge = {
    send: (command: any) => { sent.push(command); responder(command) },
    on: (callback: (message: any) => void) => { deliver = callback; return () => { deliver = null } },
  } as any
  window.researchBridge = { send: vi.fn(), on: () => () => {} } as any
  disposeBridge = installBridge()
  useSessionStore.setState({
    currentWorkspace: 'C:/research',
    researchBinding: { sessionId: 'root-session', sessionFile: 'C:/research/root.jsonl', workspace: 'C:/research', runId: 'r_1', streamId: 'stream-1' },
    researchCards: { r_1: { runId: 'r_1', question: 'q', status: 'active', phase: 'working', workspace: 'C:/research', tasks: [], updatedAt: 1 } },
    activeResearchTaskId: { runId: 'r_1', taskId: 't_licences' },
  })
})

afterEach(() => {
  disposeBridge?.()
  disposeBridge = null
  cleanup()
  vi.useRealTimers()
})

describe('research task drawer execution records', () => {
  it('reads the real commands, arguments and output of the recorded instance', async () => {
    render(<ResearchTaskDrawer />)
    const panel = await screen.findByTestId('research-execution-panel')
    await waitFor(() => expect(panel.textContent).toContain('$ ls /srv/archives'), { timeout: 10000 })
    expect(sent.some(command => command.type === 'get_research_execution'
      && command.runId === 'r_1' && command.taskId === 't_licences' && command.sessionId === 'root-session')).toBe(true)
    // A call that really ran a terminal tool shows its command line; its output opens on demand.
    expect(panel.querySelector('[data-tool-status="success"]')).not.toBeNull()
    expect(panel.textContent).not.toContain('该任务当前没有可展示的执行记录')
  })

  it('opens a recorded call to show its parameters', async () => {
    render(<ResearchTaskDrawer />)
    const panel = await screen.findByTestId('research-execution-panel')
    await waitFor(() => expect(panel.querySelector('[data-tool-status]')).not.toBeNull(), { timeout: 10000 })
    const row = panel.querySelector('[data-tool-status]')!
    const toggle = row.querySelector('button')!
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(row.textContent).toContain('ls /srv/archives')
    expect(row.textContent).toContain('ledger-1805.txt')
  })

  it('says which kind of absence it is instead of pretending an empty success', async () => {
    responder = command => {
      if (command.type === 'get_research_task') respond(command, { detail: taskDetail })
      if (command.type === 'get_research_execution') {
        respond(command, { execution: page({ instances: [], entries: [], availability: 'not_started', reason: '该实例尚未开始写入执行记录。' }) })
      }
    }
    render(<ResearchTaskDrawer />)
    const panel = await screen.findByTestId('research-execution-panel')
    await waitFor(() => expect(panel.textContent).toContain('尚未开始执行'), { timeout: 10000 })
    expect(panel.textContent).toContain('该实例尚未开始写入执行记录。')
  })

  it('shows a failed call with its reason, and a missing time as unrecorded', async () => {
    responder = command => {
      if (command.type === 'get_research_task') respond(command, { detail: taskDetail })
      if (command.type === 'get_research_execution') respond(command, { execution: page({
        entries: [{ toolCallId: 'call-9', toolName: 'read', status: 'error', arguments: '{}', argumentsTruncated: false,
          resultTruncated: false, result: null, error: '1 validation error: responsible is not permitted',
          startedAt: null, endedAt: null, recordIndex: 2 }],
      }) })
    }
    render(<ResearchTaskDrawer />)
    const panel = await screen.findByTestId('research-execution-panel')
    await waitFor(() => expect(panel.querySelector('[data-tool-status="error"]')).not.toBeNull(), { timeout: 10000 })
    expect(panel.textContent).toContain('时间未记录')
  })

  it('polls a running instance every two seconds without overlapping a pending request', async () => {
    vi.useFakeTimers()
    let executions = 0
    let release: ((value: unknown) => void) | null = null
    responder = command => {
      if (command.type === 'get_research_task') respond(command, { detail: taskDetail })
      if (command.type === 'get_research_execution') {
        executions += 1
        release = value => respond(command, value)
      }
    }
    render(<ResearchTaskDrawer />)
    await act(async () => { vi.advanceTimersByTime(10) })
    expect(executions).toBe(1)

    // Nothing has answered yet: a tick of the poll must not stack a second request.
    await act(async () => { vi.advanceTimersByTime(6000) })
    expect(executions).toBe(1)

    await act(async () => { release?.({ execution: page() }); await Promise.resolve() })
    await act(async () => { vi.advanceTimersByTime(2100) })
    expect(executions).toBe(2)
    vi.useRealTimers()
  })

  it('stops polling once the instance has settled', async () => {
    vi.useFakeTimers()
    let executions = 0
    responder = command => {
      if (command.type === 'get_research_task') respond(command, { detail: taskDetail })
      if (command.type === 'get_research_execution') {
        executions += 1
        respond(command, { execution: page({ entries: [], availability: 'available',
          instances: [{ instanceId: 'tr_1', taskId: 't_licences', generation: 1, attempt: 1, phase: 'worker',
            status: 'completed', startedAt: 1, endedAt: 2, exitCode: 0, failureKind: null, summary: null, source: 'task_run' }] }) })
      }
    }
    render(<ResearchTaskDrawer />)
    await act(async () => { vi.advanceTimersByTime(10) })
    expect(executions).toBe(1)
    await act(async () => { vi.advanceTimersByTime(9000) })
    expect(executions).toBe(1)
    vi.useRealTimers()
  })

  it('ignores a reply that belongs to the card the reader left', async () => {
    let late: ((value: unknown) => void) | null = null
    responder = command => {
      if (command.type === 'get_research_task') respond(command, { detail: taskDetail })
      if (command.type === 'get_research_execution') {
        if (command.taskId === 't_licences') late = value => respond(command, value)
        else respond(command, { execution: page({ taskId: command.taskId, entries: [], instances: [], availability: 'not_started', reason: '新任务尚无记录' }) })
      }
    }
    const { rerender } = render(<ResearchTaskDrawer />)
    await waitFor(() => expect(late).toBeInstanceOf(Function), { timeout: 10000 })
    act(() => useSessionStore.getState().setActiveResearchTask({ runId: 'r_1', taskId: 't_other' }))
    rerender(<ResearchTaskDrawer />)
    await waitFor(() => expect(screen.getByTestId('research-execution-panel').textContent).toContain('新任务尚无记录'), { timeout: 10000 })
    await act(async () => { late?.({ execution: page() }); await Promise.resolve() })
    // The old card's records must not reappear under the new one.
    expect(screen.getByTestId('research-execution-panel').textContent).not.toContain('ls /srv/archives')
  })

  it('fetches the next page only when the reader asks for it', async () => {
    responder = command => {
      if (command.type === 'get_research_task') respond(command, { detail: taskDetail })
      if (command.type === 'get_research_execution') {
        respond(command, { execution: command.cursor
          ? page({ entries: [{ toolCallId: 'call-2', toolName: 'read', status: 'success', arguments: '{"path":"/b"}',
            argumentsTruncated: false, resultTruncated: false, result: 'second', error: null,
            startedAt: 1_760_000_200_000, endedAt: null, recordIndex: 5 }], nextCursor: null, hasMore: false })
          : page({ nextCursor: '1', hasMore: true }) })
      }
    }
    render(<ResearchTaskDrawer />)
    const panel = await screen.findByTestId('research-execution-panel')
    await waitFor(() => expect(panel.querySelectorAll('[data-execution-record]')).toHaveLength(1), { timeout: 10000 })
    const more = await screen.findByRole('button', { name: '继续读取后续记录' }, { timeout: 10000 })
    const before = sent.filter(command => command.type === 'get_research_execution').length
    act(() => more.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await waitFor(() => expect(panel.querySelectorAll('[data-execution-record]')).toHaveLength(2), { timeout: 10000 })
    const after = sent.filter(command => command.type === 'get_research_execution')
    expect(after.length).toBe(before + 1)
    expect(after.at(-1).cursor).toBe('1')
    expect(screen.queryByRole('button', { name: '继续读取后续记录' })).not.toBeInTheDocument()
  })

  it('reads nothing while the drawer is closed', async () => {
    act(() => useSessionStore.getState().setActiveResearchTask(null))
    render(<ResearchTaskDrawer />)
    expect(screen.queryByTestId('research-execution-panel')).not.toBeInTheDocument()
    expect(sent.filter(command => command.type === 'get_research_execution')).toHaveLength(0)
  })
})
