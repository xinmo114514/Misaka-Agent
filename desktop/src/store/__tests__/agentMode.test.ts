import { beforeEach, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'

beforeEach(() => {
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({ agentMode: 'agent', permissionMode: 'default',
    isSessionLoading: false, sessionLoadError: null, sessionOperation: null, isCompacting: false })
})

it('combines research mode with bypass permission without inventing a backend permission mode', () => {
  useSessionStore.getState().setAgentMode('research')
  expect(useSessionStore.getState().agentMode).toBe('research')
  expect(useSessionStore.getState().permissionMode).toBe('bypassPermissions')
  expect(window.bridge.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'set_permission_mode', mode: 'bypassPermissions',
  }))
})

it('leaves research mode when choosing an ordinary permission mode', () => {
  useSessionStore.getState().setAgentMode('research')
  useSessionStore.getState().setPermissionMode('plan')
  expect(useSessionStore.getState().agentMode).toBe('agent')
  expect(useSessionStore.getState().permissionMode).toBe('plan')
})

it('keeps mode unchanged while the session is not ready', () => {
  useSessionStore.setState({ isSessionLoading: true })
  useSessionStore.getState().setAgentMode('research')
  expect(useSessionStore.getState().agentMode).toBe('agent')
  expect(window.bridge.send).not.toHaveBeenCalled()
})
