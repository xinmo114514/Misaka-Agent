import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PermissionDialog } from './PermissionDialog'
import { useSessionStore } from '../../store/useSessionStore'

const request = { requestId: 'permission-1', toolName: 'bash', toolInput: { command: 'npm test' }, reason: '运行验证', agentId: 'agent-1' }
let seq = 0
beforeEach(() => {
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({ pendingPermissionRequest: null, currentSessionId: 'session-1', lastEventSeq: 0, isSessionLoading: false, sessionOperation: null })
})
afterEach(cleanup)

it.each([
  {},
  { canApplySuggestions: false, suggestionLabel: '允许此命令' },
  { canApplySuggestions: true },
  { canApplySuggestions: true, suggestionLabel: '' },
  { canApplySuggestions: true, suggestionLabel: '   ' },
])('only offers once and denial without usable SDK suggestions: %j', fields => {
  useSessionStore.setState({ pendingPermissionRequest: { ...request, ...fields } })
  render(<PermissionDialog />)
  expect(screen.getAllByRole('button')).toHaveLength(2)
  expect(screen.getByRole('button', { name: '本次允许' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '拒绝 (Deny)' })).toBeInTheDocument()
})

it('preserves bridge suggestion metadata through to the rendered action', () => {
  useSessionStore.getState().handleBridgeMessage({ seq: ++seq, sessionId: 'session-1', event: {
    type: 'permission:request', ...request, canApplySuggestions: true, suggestionLabel: '本会话允许此命令',
  } })
  expect(useSessionStore.getState().pendingPermissionRequest).toMatchObject({ canApplySuggestions: true, suggestionLabel: '本会话允许此命令' })
  render(<PermissionDialog />)
  expect(screen.getByRole('button', { name: '本会话允许此命令' })).toBeInTheDocument()
})

it.each([
  ['本次允许', 'allow', 'once'],
  ['本会话允许此命令', 'allow', 'suggested'],
  ['拒绝 (Deny)', 'deny', 'once'],
])('sends the %s decision through the real store', (button, decision, scope) => {
  useSessionStore.setState({ pendingPermissionRequest: { ...request, canApplySuggestions: true, suggestionLabel: '本会话允许此命令' } })
  render(<PermissionDialog />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '仅用于验证' } })
  fireEvent.click(screen.getByRole('button', { name: button }))
  expect(window.bridge.send).toHaveBeenCalledWith({ type: 'permission_response', requestId: 'permission-1', decision, scope, feedback: '仅用于验证' })
  expect(useSessionStore.getState().pendingPermissionRequest).toBeNull()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('does not clear a newer request when responding to an older request', () => {
  useSessionStore.setState({ pendingPermissionRequest: request })
  useSessionStore.getState().respondPermission('older-request', 'deny')
  expect(useSessionStore.getState().pendingPermissionRequest?.requestId).toBe('permission-1')
})
