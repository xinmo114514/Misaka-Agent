import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Sidebar } from './Sidebar'
import { SessionDeleteDialog } from '../SessionDeleteDialog'
import { useSessionStore } from '../../store/useSessionStore'
import { useResearchRunStore } from '../../store/useResearchRunStore'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

beforeEach(() => {
  useResearchRunStore.setState({ runs: {} })
  useSessionStore.setState({
    sessions: [], projects: [], currentWorkspace: 'C:/Misaka-Agent', recentWorkspaces: ['C:/New-project'],
    currentSessionPath: 'C:/Misaka-Agent/active.jsonl', sessionFilterScope: 'all',
  })
})
it('shows every executor in a workspace group, including cards beyond the four visible tiles', () => {
  useResearchRunStore.setState({ runs: { r: { runId: 'r', run: { id: 'r', question: 'Question', workspace: 'C:/Misaka-Agent', status: 'active', phase: 'cards', nodes: 1, tasks: 6 },
    graph: { run: 'r', question: 'Question', status: 'active', phase: 'cards', nodes: [{ id: 'n1', question: 'Node', depth: 0,
      status: 'active', kind: 'root', parents: [], children: [] }] },
    sessions: [{ executorId: 'root-executor', sessionId: 'root', sessionFile: 'root.jsonl', nodeId: 'n1', taskId: null,
      role: 'last_order' as const, label: 'Last Order root', workspace: 'C:/Misaka-Agent', status: 'running', generation: 1,
      attempt: 1, startedAt: Date.now() - 120000, endedAt: null, error: null },
    ...Array.from({ length: 6 }, (_, index) => ({ executorId: `executor-${index}`, sessionId: null, sessionFile: null,
      nodeId: 'n1', taskId: `task-${index}`, role: 'sister' as const, label: `Agent ${index}`, workspace: 'C:/Misaka-Agent',
      status: index ? 'ready' : 'running', generation: 1, attempt: 1, startedAt: index ? null : Date.now() - 120000, endedAt: null, error: null }))],
    suspension: null, suspensions: [] } } })
  render(<Sidebar />)
  expect(screen.getByText('Sessions · Agents')).toBeInTheDocument()
  for (let index = 0; index < 6; index++) expect(screen.getByText(`Agent ${index}`)).toBeInTheDocument()
  expect(screen.getAllByText('Sister').length).toBe(6)
  expect(screen.getByText('Last Order · 1')).toBeInTheDocument()
  expect(screen.getByText('Sisters / Agents · 6')).toBeInTheDocument()
  expect(screen.getAllByText(/2m/).length).toBeGreaterThan(0)
})

it('renders projects and recent conversations as separate compact sections', () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    id: `session-${index}`, path: `C:/Misaka-Agent/session-${index}.jsonl`, cwd: 'C:/Misaka-Agent',
    name: `会话 ${index}`, firstMessage: '', messageCount: 42,
    created: '2026-10-05T00:00:00Z', modified: new Date(Date.UTC(2026, 9, 6, 0, index)).toISOString(),
  }))
  useSessionStore.setState({
    sessions,
    projects: [{
      id: 'C:/Misaka-Agent', name: 'Misaka-Agent', sessions: sessions.map(session => ({
        id: session.id, path: session.path, cwd: session.cwd, title: session.name,
        modified: session.modified, messageCount: session.messageCount,
      })),
    }],
  })

  render(<Sidebar />)

  expect(screen.getByRole('button', { name: '新聊天' })).toBeInTheDocument()
  expect(screen.getByText('项目')).toBeInTheDocument()
  expect(screen.getByText('最近')).toBeInTheDocument()
  expect(screen.queryByText('MISAKA')).not.toBeInTheDocument()
  expect(screen.queryByText('42 条')).not.toBeInTheDocument()
  expect(screen.getAllByText('会话 11')).toHaveLength(2)
  expect(screen.getAllByTitle('会话 11')).toHaveLength(2)
  expect(screen.getAllByText('会话 10')).toHaveLength(2)
  expect(screen.queryByText('会话 0')).not.toBeInTheDocument()
})

it('expands a project without switching sessions and reveals five more rows at a time', () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    id: `row-${index}`, path: `C:/Misaka-Agent/row-${index}.jsonl`, cwd: 'C:/Misaka-Agent',
    name: `项目会话 ${index}`, firstMessage: '', messageCount: 1,
    created: '2026-10-05T00:00:00Z', modified: new Date(Date.UTC(2026, 9, 6, 0, index)).toISOString(),
  }))
  useSessionStore.setState({
    sessions,
    projects: [{ id: 'C:/Misaka-Agent', name: 'Misaka-Agent', sessions: sessions.map(session => ({
      id: session.id, path: session.path, cwd: session.cwd, title: session.name,
      modified: session.modified, messageCount: session.messageCount,
    })) }],
  })
  const openSession = vi.spyOn(useSessionStore.getState(), 'openSession')
  const { container } = render(<Sidebar />)
  const project = screen.getByRole('button', { name: '展开项目 Misaka-Agent' })
  expect(project).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(project)
  expect(project).toHaveAttribute('aria-expanded', 'false')
  expect(openSession).not.toHaveBeenCalled()
  fireEvent.click(project)
  expect(container.querySelector('[data-project-session="C:/Misaka-Agent"][data-session-title="项目会话 6"]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '显示更多项目会话' }))
  expect(container.querySelector('[data-project-session="C:/Misaka-Agent"][data-session-title="项目会话 6"]')).not.toBeNull()
})

it('opens a named delete confirmation from either copy of a session row', () => {
  const session = { id: 'delete', path: 'C:/Misaka-Agent/delete.jsonl', cwd: 'C:/Misaka-Agent',
    name: '目标会话', firstMessage: '', messageCount: 1, created: '2026-10-05', modified: '2026-10-06' }
  useSessionStore.setState({ sessions: [session], projects: [], currentWorkspace: session.cwd, currentSessionPath: null })
  render(<><Sidebar /><SessionDeleteDialog /></>)

  fireEvent.click(screen.getAllByRole('button', { name: '删除会话 目标会话' })[0])
  expect(screen.getByRole('alertdialog', { name: '删除会话' })).toBeInTheDocument()
  expect(useSessionStore.getState().sessionDeletion).toMatchObject({ path: session.path, status: 'confirm' })
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(useSessionStore.getState().sessionDeletion).toBeNull()
})

it('bounds mounted rows in a large session index while retaining the full list', () => {
  const sessions = Array.from({ length: 1000 }, (_, index) => ({ id: `index-${index}`, path: `index-${index}.jsonl`, cwd: 'C:/large',
    name: `性能会话 ${index}`, firstMessage: '', messageCount: 1, created: '2026-10-05', modified: '2026-10-05' }))
  useSessionStore.setState({ sessions, currentWorkspace: 'C:/large', sessionFilterScope: 'here', projects: [] })
  const { container } = render(<Sidebar />)
  const mounted = container.querySelectorAll('button[title^="性能会话"]')
  expect(mounted.length).toBeGreaterThan(0)
  expect(mounted.length).toBeLessThan(60)
  expect(useSessionStore.getState().sessions).toHaveLength(1000)
}, 15000)

it('opens the shared acknowledged rename dialog for a sidebar session', async () => {
  const row = { id: 'rename', path: 'C:/Misaka-Agent/rename.jsonl', cwd: 'C:/Misaka-Agent', name: '原会话', firstMessage: '', messageCount: 1, created: '2026-10-05', modified: '2026-10-05' }
  const rename = vi.fn().mockResolvedValue(undefined)
  useSessionStore.setState({ sessions: [row], projects: [{ id: row.cwd, name: 'Misaka-Agent', sessions: [{ id: row.id, path: row.path, cwd: row.cwd, title: row.name, modified: row.modified, messageCount: 1 }] }], currentWorkspace: row.cwd, renameSession: rename as any })
  render(<Sidebar />)
  fireEvent.click(screen.getAllByRole('button', { name: '重命名会话 原会话' })[0])
  const input = screen.getByRole('textbox', { name: '会话名称' })
  fireEvent.change(input, { target: { value: '新名称' } })
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
  await waitFor(() => expect(rename).toHaveBeenCalledOnce())
  expect(rename).toHaveBeenCalledWith(row.path, '新名称')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})
