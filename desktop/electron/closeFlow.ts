/**
 * The close path the main process can walk without the renderer.
 *
 * A window close used to be handed to the page for confirmation, and a page whose main thread is
 * stuck cannot answer -- so a reader with a frozen window had no way out that the app owned. This
 * state machine keeps the normal in-page dialog while the page is alive, and takes the decision into
 * native code the moment it is not.
 */

export const RENDERER_PRESENT_TIMEOUT_MS = 1500
export const STOP_WAIT_MS = 5000
/** How long a killed tree may take to actually disappear before the cleanup counts as failed. */
export const TERMINATE_WAIT_MS = 3000

export type ClosePhase = 'idle' | 'awaiting-renderer' | 'renderer-dialog' | 'native-dialog' | 'stopping' | 'exited'

export type NativeChoice = 'stop' | 'background' | 'cancel' | 'wait' | 'force'

export interface NativeDialogRequest {
  stage: 'close' | 'escalate'
  buttons: string[]
  cancelId: number
  defaultId: number
  message: string
  detail: string
}

export interface CloseFlowDeps {
  sendToRenderer: (closeRequestId: number) => void
  showNativeDialog: (request: NativeDialogRequest) => Promise<number>
  researchActive: () => boolean
  /** Ask the research runtime to stop cooperatively; resolves true once the process has exited. */
  stopResearch: (timeoutMs: number) => Promise<boolean>
  forceTerminate: () => Promise<boolean>
  showError: (message: string, detail: string) => void
  hideWindow: () => void
  allowWindowClose: () => void
  quit: () => void
  log: (kind: string, fields?: Record<string, unknown>) => void
  timers?: { set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void }
}

export interface CloseFlow {
  phase(): ClosePhase
  closeRequestId(): number
  requestClose(input?: { skipRenderer?: boolean }): Promise<void>
  /** The page took the close over: it painted its own dialog, or it is quitting or hiding itself. */
  rendererTookOver(closeRequestId: number): void
  /** The page's dialog went away without a decision, so the window close is available again. */
  rendererCancelled(closeRequestId: number): void
  /** The page's dialog chose to quit: same stop path, same guarantees. */
  rendererQuit(): Promise<void>
  /** The page's dialog chose to stay in the background. */
  rendererHide(): void
  /** Quit without asking the reader first (the tray's 退出), but still stop cleanly. */
  quitDirectly(): Promise<void>
  /** The window stopped answering: a close from here on is decided in native code. */
  noteUnresponsive(): void
  noteResponsive(): void
  dispose(): void
}

const BUSY_PHASES: ClosePhase[] = ['renderer-dialog', 'native-dialog', 'stopping']

export function createCloseFlow(deps: CloseFlowDeps): CloseFlow {
  const timers = deps.timers ?? {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }
  let current: ClosePhase = 'idle'
  let id = 0
  let unresponsive = false
  let waitTimer: unknown = null
  let resolveWait: ((answered: boolean) => void) | null = null
  let busy = false

  const clearWait = () => {
    if (waitTimer === null) return
    timers.clear(waitTimer)
    waitTimer = null
  }

  const setPhase = (phase: ClosePhase, fields: Record<string, unknown> = {}) => {
    current = phase
    deps.log('close:phase', { phase, closeRequestId: id, ...fields })
  }

  const settleWait = (answered: boolean) => {
    const resolve = resolveWait
    resolveWait = null
    clearWait()
    resolve?.(answered)
  }

  const awaitRenderer = () => new Promise<boolean>(resolve => {
    resolveWait = resolve
    waitTimer = timers.set(() => settleWait(false), RENDERER_PRESENT_TIMEOUT_MS)
  })

  const askNative = async (stage: 'close' | 'escalate'): Promise<NativeChoice> => {
    const active = deps.researchActive()
    const closeButtons = active ? ['停止并退出', '后台继续', '取消'] : ['退出', '取消']
    const request: NativeDialogRequest = stage === 'close'
      ? {
          stage,
          buttons: closeButtons,
          cancelId: closeButtons.length - 1,
          defaultId: active ? 1 : 0,
          message: active ? '研究仍在运行，如何处理？' : '退出 Misaka Agent',
          detail: active
            ? '窗口未响应应用内确认。后台继续会把研究留在系统托盘。'
            : '窗口未响应应用内确认，由应用直接询问。',
        }
      : {
          stage,
          buttons: ['继续等待', '强制退出', '取消关闭'],
          cancelId: 2,
          defaultId: 0,
          message: '研究仍在停止',
          detail: `停止请求已发出 ${Math.round(STOP_WAIT_MS / 1000)} 秒，运行时仍未退出。强制退出只清理本应用启动的进程。`,
        }
    setPhase('native-dialog', { stage })
    const response = await deps.showNativeDialog(request)
    const index = Number.isInteger(response) ? response : request.cancelId
    if (stage === 'close') {
      if (!active) return index === 0 ? 'stop' : 'cancel'
      return index === 0 ? 'stop' : index === 1 ? 'background' : 'cancel'
    }
    return index === 0 ? 'wait' : index === 1 ? 'force' : 'cancel'
  }

  const exitNow = () => {
    setPhase('exited')
    deps.allowWindowClose()
    deps.quit()
  }

  /** Cooperative stop first, then an escalation ask; only a verified cleanup counts as an exit. */
  const driveStopAndExit = async () => {
    while (true) {
      setPhase('stopping')
      if (await deps.stopResearch(STOP_WAIT_MS)) { exitNow(); return }
      const choice = await askNative('escalate')
      if (choice === 'cancel') { setPhase('idle'); return }
      if (choice === 'wait') continue
      if (await deps.forceTerminate()) { exitNow(); return }
      setPhase('idle')
      deps.showError('强制退出未完成', '本应用的研究进程仍在运行，窗口保持不变。请手动结束后再退出。')
      return
    }
  }

  const quitThroughStopPath = async () => {
    settleWait(false)
    if (current === 'exited') return
    if (busy || current === 'stopping') {
      deps.log('close:ignored-duplicate', { phase: current, closeRequestId: id, from: 'quit' })
      return
    }
    busy = true
    try {
      await driveStopAndExit()
    } finally { busy = false }
  }

  return {
    phase: () => current,
    closeRequestId: () => id,

    async requestClose(input = {}) {
      if (busy || BUSY_PHASES.includes(current)) {
        deps.log('close:ignored-duplicate', { phase: current, closeRequestId: id })
        return
      }
      busy = true
      try {
        if (!input.skipRenderer && !unresponsive) {
          id += 1
          setPhase('awaiting-renderer')
          deps.sendToRenderer(id)
          if (await awaitRenderer() && !unresponsive) { setPhase('renderer-dialog'); return }
        }
        const choice = await askNative('close')
        if (choice === 'cancel') { setPhase('idle'); return }
        if (choice === 'background') { setPhase('idle'); deps.hideWindow(); return }
        await driveStopAndExit()
      } finally {
        settleWait(false)
        busy = false
      }
    },

    rendererTookOver(closeRequestId) {
      if (current !== 'awaiting-renderer' || closeRequestId !== id) {
        deps.log('close:stale-presented', { closeRequestId, expected: id, phase: current })
        return
      }
      settleWait(true)
    },

    rendererCancelled(closeRequestId) {
      if (current !== 'renderer-dialog' || closeRequestId !== id) {
        deps.log('close:stale-cancelled', { closeRequestId, expected: id, phase: current })
        return
      }
      setPhase('idle', { reason: 'renderer-cancelled' })
    },

    async rendererQuit() { await quitThroughStopPath() },

    async quitDirectly() { await quitThroughStopPath() },

    rendererHide() {
      settleWait(false)
      setPhase('idle', { reason: 'renderer-hide' })
      deps.hideWindow()
    },

    noteUnresponsive() {
      unresponsive = true
      // A close already waiting on this page will never be answered.
      if (current === 'awaiting-renderer') settleWait(false)
      // A painted dialog belongs to the page too. Release that ownership so a later close
      // can use native confirmation after the page freezes or its process disappears.
      if (current === 'renderer-dialog') setPhase('idle', { reason: 'renderer-unresponsive' })
    },

    noteResponsive() { unresponsive = false },

    dispose() {
      settleWait(false)
      clearWait()
      current = 'exited'
    },
  }
}
