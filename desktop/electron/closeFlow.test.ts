import { describe, expect, it, vi } from 'vitest'
import { createCloseFlow, RENDERER_PRESENT_TIMEOUT_MS, STOP_WAIT_MS, type CloseFlowDeps, type NativeDialogRequest } from './closeFlow'

interface Harness {
  flow: ReturnType<typeof createCloseFlow>
  deps: CloseFlowDeps
  sendToRenderer: ReturnType<typeof vi.fn>
  showNativeDialog: ReturnType<typeof vi.fn>
  stopResearch: ReturnType<typeof vi.fn>
  forceTerminate: ReturnType<typeof vi.fn>
  showError: ReturnType<typeof vi.fn>
  hideWindow: ReturnType<typeof vi.fn>
  allowWindowClose: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  run: (ms: number) => void
}

function harness(overrides: Partial<CloseFlowDeps> = {}): Harness {
  let now = 0
  const scheduled: Array<{ at: number, callback: () => void, id: number }> = []
  let nextId = 1
  const run = (ms: number) => {
    const target = now + ms
    while (true) {
      const due = scheduled.filter(item => item.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      const index = scheduled.indexOf(due)
      scheduled.splice(index, 1)
      now = due.at
      due.callback()
    }
    now = target
  }
  const deps: CloseFlowDeps = {
    sendToRenderer: vi.fn(),
    showNativeDialog: vi.fn(async () => 0),
    researchActive: () => true,
    stopResearch: vi.fn(async () => true),
    forceTerminate: vi.fn(async () => true),
    showError: vi.fn(),
    hideWindow: vi.fn(),
    allowWindowClose: vi.fn(),
    quit: vi.fn(),
    log: vi.fn(),
    timers: {
      set: (callback, ms) => { const id = nextId++; scheduled.push({ at: now + ms, callback, id }); return id },
      clear: handle => { const index = scheduled.findIndex(item => item.id === handle); if (index >= 0) scheduled.splice(index, 1) },
    },
    ...overrides,
  }
  const flow = createCloseFlow(deps)
  return { flow, deps, run, sendToRenderer: deps.sendToRenderer as ReturnType<typeof vi.fn>,
    showNativeDialog: deps.showNativeDialog as ReturnType<typeof vi.fn>,
    stopResearch: deps.stopResearch as ReturnType<typeof vi.fn>,
    forceTerminate: deps.forceTerminate as ReturnType<typeof vi.fn>,
    showError: deps.showError as ReturnType<typeof vi.fn>,
    hideWindow: deps.hideWindow as ReturnType<typeof vi.fn>,
    allowWindowClose: deps.allowWindowClose as ReturnType<typeof vi.fn>,
    quit: deps.quit as ReturnType<typeof vi.fn>, log: deps.log as ReturnType<typeof vi.fn> }
}

/** Let a pending `requestClose()` settle without spinning the fake clock past its timeout. */
async function settled(promise: Promise<void>, ms = 0) {
  await promise
  void ms
}

describe('close flow', () => {
  it('hands the close to a living page and never shows a native box', async () => {
    const h = harness()
    const request = h.flow.requestClose()
    await Promise.resolve()
    expect(h.sendToRenderer).toHaveBeenCalledWith(1)
    expect(h.flow.phase()).toBe('awaiting-renderer')
    h.flow.rendererTookOver(1)
    await settled(request)
    expect(h.flow.phase()).toBe('renderer-dialog')
    expect(h.showNativeDialog).not.toHaveBeenCalled()
    expect(h.quit).not.toHaveBeenCalled()
  })

  it('falls back to the native box when the page does not confirm in time', async () => {
    const h = harness({ showNativeDialog: vi.fn(async () => 0) })
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.run(RENDERER_PRESENT_TIMEOUT_MS + 1)
    await settled(request)
    expect(h.showNativeDialog).toHaveBeenCalledTimes(1)
    const ask = h.showNativeDialog.mock.calls[0][0] as NativeDialogRequest
    expect(ask.stage).toBe('close')
    expect(ask.buttons).toEqual(['停止并退出', '后台继续', '取消'])
    expect(ask.cancelId).toBe(2)
    expect(h.stopResearch).toHaveBeenCalledWith(STOP_WAIT_MS)
    expect(h.quit).toHaveBeenCalledTimes(1)
    expect(h.flow.phase()).toBe('exited')
  })

  it('answers the renderer never being there by asking natively at once', async () => {
    const h = harness()
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.flow.noteUnresponsive()
    await settled(request)
    expect(h.showNativeDialog).toHaveBeenCalledTimes(1)
    expect(h.flow.phase()).toBe('exited')
  })

  it('uses native confirmation after a presented renderer dialog loses its owner', async () => {
    const h = harness({ showNativeDialog: vi.fn(async () => 2) })
    const first = h.flow.requestClose()
    h.flow.rendererTookOver(1)
    await first
    h.flow.noteUnresponsive()
    await h.flow.requestClose()
    expect(h.showNativeDialog).toHaveBeenCalledTimes(1)
    expect(h.sendToRenderer).toHaveBeenCalledTimes(1)
    expect(h.flow.phase()).toBe('idle')
    h.flow.rendererCancelled(1)
    expect(h.flow.phase()).toBe('idle')
  })

  it('does not commit renderer ownership if it dies immediately after acknowledging', async () => {
    const h = harness({ showNativeDialog: vi.fn(async () => 2) })
    const request = h.flow.requestClose()
    h.flow.rendererTookOver(1)
    h.flow.noteUnresponsive()
    await request
    expect(h.showNativeDialog).toHaveBeenCalledTimes(1)
    expect(h.flow.phase()).toBe('idle')
  })

  it('ignores a second close while one flow owns the decision', async () => {
    const h = harness()
    const first = h.flow.requestClose()
    await Promise.resolve()
    const second = h.flow.requestClose()
    await second
    expect(h.sendToRenderer).toHaveBeenCalledTimes(1)
    h.flow.rendererTookOver(1)
    await first
    // The in-page dialog is up: another press must not stack a second one.
    await h.flow.requestClose()
    expect(h.sendToRenderer).toHaveBeenCalledTimes(1)
    expect(h.showNativeDialog).not.toHaveBeenCalled()
  })

  it('drops a late confirmation instead of opening a second dialog', async () => {
    const shown: number[] = []
    const h = harness({ showNativeDialog: vi.fn(async () => { shown.push(1); return 2 }) })
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.run(RENDERER_PRESENT_TIMEOUT_MS + 1)
    await settled(request)
    expect(shown).toHaveLength(1)
    // The page finally answers, after the native box already ran and was cancelled.
    h.flow.rendererTookOver(1)
    expect(h.flow.phase()).toBe('idle')
    expect(shown).toHaveLength(1)
    expect(h.log.mock.calls.some(call => call[0] === 'close:stale-presented')).toBe(true)
  })

  it('keeps the research running on 后台继续 and hides the window', async () => {
    const h = harness({ showNativeDialog: vi.fn(async () => 1) })
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.run(RENDERER_PRESENT_TIMEOUT_MS + 1)
    await settled(request)
    expect(h.hideWindow).toHaveBeenCalledTimes(1)
    expect(h.stopResearch).not.toHaveBeenCalled()
    expect(h.quit).not.toHaveBeenCalled()
    expect(h.flow.phase()).toBe('idle')
  })

  it('leaves everything alone on 取消', async () => {
    const h = harness({ showNativeDialog: vi.fn(async () => 2) })
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.run(RENDERER_PRESENT_TIMEOUT_MS + 1)
    await settled(request)
    expect(h.stopResearch).not.toHaveBeenCalled()
    expect(h.hideWindow).not.toHaveBeenCalled()
    expect(h.flow.phase()).toBe('idle')
  })

  it('escalates past a runtime that will not stop, then force-cleans its own tree', async () => {
    const stages: string[] = []
    const h = harness({
      stopResearch: vi.fn(async () => false),
      showNativeDialog: vi.fn(async (request: NativeDialogRequest) => { stages.push(request.stage); return request.stage === 'close' ? 0 : 1 }),
    })
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.run(RENDERER_PRESENT_TIMEOUT_MS + 1)
    await settled(request)
    expect(stages).toEqual(['close', 'escalate'])
    expect(h.forceTerminate).toHaveBeenCalledTimes(1)
    expect(h.quit).toHaveBeenCalledTimes(1)
    expect(h.flow.phase()).toBe('exited')
  })

  it('keeps waiting when the reader chooses 继续等待, and asks again', async () => {
    const stages: string[] = []
    const h = harness({
      stopResearch: vi.fn(async () => false),
      showNativeDialog: vi.fn(async (request: NativeDialogRequest) => {
        stages.push(request.stage)
        return request.stage === 'close' ? 0 : request.buttons.indexOf('继续等待') >= 0 && stages.length <= 2 ? 0 : 2
      }),
    })
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.run(RENDERER_PRESENT_TIMEOUT_MS + 1)
    await settled(request)
    expect(stages).toEqual(['close', 'escalate', 'escalate'])
    expect(h.stopResearch).toHaveBeenCalledTimes(2)
    expect(h.forceTerminate).not.toHaveBeenCalled()
    expect(h.flow.phase()).toBe('idle')
  })

  it('reports failure rather than a successful exit when cleanup fails', async () => {
    const h = harness({
      stopResearch: vi.fn(async () => false),
      forceTerminate: vi.fn(async () => false),
      showNativeDialog: vi.fn(async (request: NativeDialogRequest) => (request.stage === 'close' ? 0 : 1)),
    })
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.run(RENDERER_PRESENT_TIMEOUT_MS + 1)
    await settled(request)
    expect(h.showError).toHaveBeenCalledWith('强制退出未完成', expect.any(String))
    expect(h.quit).not.toHaveBeenCalled()
    expect(h.flow.phase()).toBe('idle')
  })

  it('offers a plain two-button box when nothing is running', async () => {
    const h = harness({ researchActive: () => false })
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.run(RENDERER_PRESENT_TIMEOUT_MS + 1)
    await settled(request)
    const ask = h.showNativeDialog.mock.calls[0][0] as NativeDialogRequest
    expect(ask.buttons).toEqual(['退出', '取消'])
    expect(ask.defaultId).toBe(0)
  })

  it('takes the page dialog 退出 through the same stop path', async () => {
    const h = harness()
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.flow.rendererTookOver(1)
    await settled(request)
    await h.flow.rendererQuit()
    expect(h.stopResearch).toHaveBeenCalledWith(STOP_WAIT_MS)
    expect(h.quit).toHaveBeenCalledTimes(1)
  })

  it('takes the page dialog 后台继续 without stopping research', async () => {
    const h = harness()
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.flow.rendererTookOver(1)
    await settled(request)
    h.flow.rendererHide()
    expect(h.hideWindow).toHaveBeenCalledTimes(1)
    expect(h.stopResearch).not.toHaveBeenCalled()
    expect(h.flow.phase()).toBe('idle')
  })

  it('releases the window when the page dialog goes away unused', async () => {
    const h = harness()
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.flow.rendererTookOver(1)
    await settled(request)
    h.flow.rendererCancelled(1)
    expect(h.flow.phase()).toBe('idle')
    const again = h.flow.requestClose()
    await Promise.resolve()
    expect(h.sendToRenderer).toHaveBeenCalledTimes(2)
    h.flow.rendererTookOver(2)
    await again
  })

  it('skips the page entirely when the app itself asks to quit', async () => {
    const h = harness()
    await h.flow.requestClose({ skipRenderer: true })
    expect(h.sendToRenderer).not.toHaveBeenCalled()
    expect(h.showNativeDialog).toHaveBeenCalledTimes(1)
    expect(h.quit).toHaveBeenCalledTimes(1)
  })

  it('dispose() releases the pending wait', async () => {
    const h = harness()
    const request = h.flow.requestClose()
    await Promise.resolve()
    h.flow.dispose()
    await settled(request)
    expect(h.flow.phase()).toBe('exited')
  })
})
