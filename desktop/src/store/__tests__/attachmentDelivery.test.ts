import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../useSessionStore'
import type { BridgeMessage } from '../../types/global'

const image = { type: 'image' as const, name: 'chart.png', mimeType: 'image/png', data: 'cG5n' }

function command(type: string) {
  return vi.mocked(window.bridge.send).mock.calls.map(([value]) => value as any).findLast(value => value.type === type)!
}

beforeEach(() => {
  window.bridge = { send: vi.fn(), on: () => () => {} }
  useSessionStore.setState({
    currentSessionId: 'attachment-session', currentSessionPath: 'attachment.jsonl',
    messages: [], draft: '', attachments: [], isSessionLoading: false, sessionLoadError: null,
    isStreaming: false, isAborting: false, sessionOperation: null,
  } as any)
})
afterEach(() => vi.restoreAllMocks())

describe('composer attachments', () => {
  it.each(['steer', 'followUp'] as const)('keeps prepared image snapshots on %s and retry', mode => {
    useSessionStore.getState().sendMessage('总结该图', mode, [image])
    const sent = command('prompt')
    expect(sent).toMatchObject({ text: '总结该图', streamingBehavior: mode, images: [{ mimeType: 'image/png', data: 'cG5n' }] })
    const user = useSessionStore.getState().messages.find(message => message.role === 'user')!
    expect(user.images).toEqual([image])
    useSessionStore.getState().handleBridgeMessage({ type: 'ack', requestId: sent.requestId, ok: false, error: '稍后重试' } as BridgeMessage)
    useSessionStore.getState().retryMessage(user.id)
    expect(command('prompt')).toMatchObject({ text: '总结该图', streamingBehavior: mode, images: [{ data: 'cG5n', mimeType: 'image/png' }] })
  })

  it('correlates the live user image echo without dropping the optimistic image payload', () => {
    useSessionStore.getState().sendMessage('请看图', 'steer', [image])
    useSessionStore.getState().handleBridgeMessage({
      seq: 1, sessionId: 'attachment-session',
      event: { type: 'message_start', message: { role: 'user', timestamp: 123, content: [
        { type: 'text', text: '请看图' }, { type: 'image', mimeType: image.mimeType, data: image.data },
      ] } },
    } as BridgeMessage)
    expect(useSessionStore.getState().messages.find(message => message.role === 'user')?.images).toEqual([image])
  })
})
