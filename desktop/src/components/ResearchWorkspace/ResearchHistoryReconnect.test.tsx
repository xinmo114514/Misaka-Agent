import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { request } from '../../lib/bridge'
import { addResearchSink, requestResearch } from '../../lib/researchBridge'
import { researchSessionsBridge } from '../../lib/researchSessionsBridge'
import { useResearchSessionsStore } from '../../store/useResearchSessionsStore'
import type { ResearchSessionDescriptor, ResearchSessionHistory, ResearchSessionSnapshot } from '../../types/research'
import { ResearchTranscript } from './ResearchTranscript'
import { useMultiHistory } from './useMultiHistory'

vi.mock('../../lib/bridge', () => ({ request: vi.fn() }))
vi.mock('../../lib/researchBridge', () => ({ requestResearch: vi.fn(), addResearchSink: vi.fn(() => () => {}) }))

const descriptor: ResearchSessionDescriptor = {
  executorId: 'reader', sessionId: 'session', sessionFile: 'session.jsonl', nodeId: 'node', taskId: 'task',
  role: 'sister', label: 'Reader', workspace: 'A', status: 'running', generation: 1, attempt: 1,
  startedAt: 1, endedAt: null, error: null,
}
const snapshot: ResearchSessionSnapshot = {
  runId: 'r', executorId: 'reader', sessionId: 'session', nodeId: 'node', taskId: 'task', generation: 1,
  attempt: 1, revision: 1, historyVersion: 'v1', streaming: null, telemetry: null, error: null, availability: 'available',
}
const page = (content: string, extra: Partial<ResearchSessionHistory> = {}): ResearchSessionHistory => ({
  runId: 'r', executorId: 'reader', messages: [{ id: content, role: 'assistant', content, timestamp: 1 }],
  historyVersion: 'v1', nextCursor: null, hasMore: false, availability: 'available', ...extra,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const releases: (() => void)[] = []
const pending: ReturnType<typeof deferred<ResearchSessionHistory>>[] = []
const retain = (run = 'r', workspace = 'A') => {
  const release = researchSessionsBridge.retain(run, workspace)
  releases.push(release)
  return release
}
const flush = () => act(async () => {})

function MultiReader({ runId, workspace }: { runId: string; workspace: string }) {
  const history = useMultiHistory(runId, workspace, [descriptor], true)
  const session = useResearchSessionsStore(state => state.byExecutor.reader)
  return <section aria-label="Multi reader">
    {session.messages.map(message => <p key={message.id}>{message.content}</p>)}
    {history.error && <><p role="alert">{history.error}</p><button onClick={history.retry}>Retry multi</button></>}
  </section>
}
function Readers({ mode, runId = 'r', workspace = 'A' }: { mode: 'focus' | 'multi' | 'both'; runId?: string; workspace?: string }) {
  return <>{mode !== 'multi' && <ResearchTranscript runId={runId} workspace={workspace} descriptor={descriptor} area="main" />}
    {mode !== 'focus' && <MultiReader runId={runId} workspace={workspace} />}</>
}

beforeEach(() => {
  pending.length = 0
  useResearchSessionsStore.setState({ byExecutor: {} })
  useResearchSessionsStore.getState().upsertDescriptors('r', [descriptor])
  useResearchSessionsStore.getState().applySnapshot(snapshot)
  vi.mocked(requestResearch).mockResolvedValue({ subscriptionId: 'observer', stopped: true })
  vi.mocked(request).mockImplementation((type) => {
    if (type === 'get_research_sessions') return Promise.reject(new Error('saved fixture has no native listing'))
    if (type === 'get_research_session_history') {
      const reading = deferred<ResearchSessionHistory>()
      pending.push(reading)
      return reading.promise
    }
    throw new Error(`Unexpected request: ${type}`)
  })
})
afterEach(() => { while (releases.length) releases.pop()!() })

it.each(['focus', 'multi', 'both'] as const)('reloads same-version %s history after retain reconnect and never shows the retired page', async mode => {
  const release = retain()
  render(<Readers mode={mode} />)
  expect(pending).toHaveLength(1)
  act(() => { release(); retain() })
  await act(async () => { pending[0].resolve(page('Retired owner row')) })
  // Same-version packets do not alter reader keys: the invalidation must wake readers itself.
  researchSessionsBridge.listen()
  const sink = vi.mocked(addResearchSink).mock.calls.at(-1)![0]
  act(() => sink({ sessionId: 'session', seq: 1, event: { type: 'research_session_snapshot', snapshot } }))
  expect(pending).toHaveLength(2)
  expect(screen.queryByText('Retired owner row')).not.toBeInTheDocument()
  expect(useResearchSessionsStore.getState().byExecutor.reader.loadedHistoryVersion).toBeNull()
  await act(async () => { pending[1].resolve(page('Current owner row')) })
  expect(screen.getAllByText('Current owner row')).toHaveLength(mode === 'both' ? 2 : 1)
  expect(useResearchSessionsStore.getState().byExecutor.reader.loadedHistoryVersion).toBe('v1')
})

it.each(['focus', 'multi'] as const)('does not restart an unmounted %s reader after reconnect invalidation', async mode => {
  const release = retain()
  const view = render(<Readers mode={mode} />)
  view.unmount()
  act(() => { release(); retain() })
  await act(async () => { pending[0].resolve(page('Retired owner row')) })
  expect(pending).toHaveLength(1)
  expect(useResearchSessionsStore.getState().byExecutor.reader.loadedHistoryVersion).toBeNull()
})

it.each(['focus', 'multi'] as const)('reports %s invalidation without a retry loop while another run owns the bridge', async mode => {
  const release = retain()
  render(<Readers mode={mode} />)
  act(() => { release(); retain('other', 'B') })
  await act(async () => { pending[0].resolve(page('Wrong owner row')) })
  await flush()
  expect(screen.getByText(/研究会话历史读取已失效/)).toBeVisible()
  expect(pending).toHaveLength(1)
  expect(screen.queryByText('Wrong owner row')).not.toBeInTheDocument()
})

it.each(['focus', 'multi'] as const)('does not retry or report the retired %s read after switching runs', async mode => {
  const release = retain()
  const view = render(<Readers mode={mode} />)
  act(() => {
    release(); retain('other', 'A')
    useResearchSessionsStore.getState().upsertDescriptors('other', [descriptor])
  })
  view.rerender(<Readers mode={mode} runId="other" />)
  expect(pending).toHaveLength(2)
  await act(async () => { pending[0].resolve(page('Retired run row')) })
  expect(pending).toHaveLength(2)
  expect(screen.queryByText(/研究会话历史读取已失效/)).not.toBeInTheDocument()
  expect(screen.queryByText('Retired run row')).not.toBeInTheDocument()
  await act(async () => { pending[1].resolve(page('Replacement run row', { runId: 'other' })) })
  expect(screen.getByText('Replacement run row')).toBeVisible()
})

it.each(['focus', 'multi'] as const)('bounds automatic %s reconnect retries and leaves explicit recovery visible', async mode => {
  let release = retain()
  render(<Readers mode={mode} />)
  act(() => { release(); release = retain() })
  await act(async () => { pending[0].resolve(page('First retired row')) })
  expect(pending).toHaveLength(2)
  act(() => { release(); retain() })
  await act(async () => { pending[1].resolve(page('Second retired row')) })
  await flush()
  expect(pending).toHaveLength(2)
  expect(screen.getByText(/研究会话历史读取已失效/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: mode === 'focus' ? '重试' : 'Retry multi' }))
  expect(pending).toHaveLength(3)
  await act(async () => { pending[2].resolve(page('Manually recovered row')) })
  expect(screen.getByText('Manually recovered row')).toBeVisible()
})

it('keeps invalidated older pages visibly retryable without applying retired history', async () => {
  useResearchSessionsStore.getState().applyHistory(page('Current row', { nextCursor: 'v1@20', hasMore: true }))
  const release = retain()
  render(<Readers mode="focus" />)
  fireEvent.click(screen.getByRole('button', { name: '读取更多历史' }))
  act(() => { release(); retain() })
  await act(async () => { pending[0].resolve(page('Retired older row', { direction: 'older' })) })
  expect(screen.getByText(/研究会话历史读取已失效/)).toBeVisible()
  expect(screen.getByRole('button', { name: '重试读取历史' })).toBeVisible()
  expect(screen.queryByText('Retired older row')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试读取历史' }))
  await act(async () => { pending[1].resolve(page('Current older row', { direction: 'older' })) })
  expect(screen.getByText('Current older row')).toBeVisible()
  expect(screen.getByText('Current row')).toBeVisible()
})
