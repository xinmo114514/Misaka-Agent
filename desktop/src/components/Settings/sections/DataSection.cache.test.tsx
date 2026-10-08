import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DataSection } from './DataSection'
import { sessionHistoryCache } from '../../../lib/sessionHistoryCache'
import { messageHeights, readPosition, savePosition, useDisclosure } from '../../../lib/sessionViewState'
import { useSessionStore } from '../../../store/useSessionStore'

let fixtureId = 0

describe('DataSection cache cleanup', () => {
  beforeEach(() => {
    fixtureId += 1
    sessionHistoryCache.clear()
  })

  afterEach(() => {
    sessionHistoryCache.clear()
  })

  it('clears history and non-current view caches while preserving the current session and editor state', () => {
    const currentPath = `cache-current-${fixtureId}.jsonl`
    const otherPath = `cache-other-${fixtureId}.jsonl`
    const messages = [{ id: 'current-message', role: 'user' as const, content: '保留当前消息', timestamp: 1 }]
    useSessionStore.setState({ currentSessionPath: currentPath, messages, draft: '保留草稿' })

    sessionHistoryCache.put({ path: currentPath, sessionId: 'current', title: 'current', workspace: 'C:/project', historyVersion: 'v1', messages })
    sessionHistoryCache.put({ path: otherPath, sessionId: 'other', title: 'other', workspace: 'C:/project', historyVersion: 'v1', messages: [] })
    const currentReading = { scrollTop: 42, following: false }
    savePosition(currentPath, currentReading)
    savePosition(otherPath, { scrollTop: 12, following: false })
    messageHeights(currentPath).set('current-message', 88)
    messageHeights(otherPath).set('other-message', 55)

    useSessionStore.setState({ currentSessionPath: otherPath })
    const otherDisclosure = renderHook(() => useDisclosure('other-message'))
    act(() => otherDisclosure.result.current[1](true))
    otherDisclosure.unmount()

    useSessionStore.setState({ currentSessionPath: currentPath })
    const currentDisclosure = renderHook(() => useDisclosure('current-message'))
    act(() => currentDisclosure.result.current[1](true))
    render(<DataSection />)

    fireEvent.click(screen.getByRole('button', { name: /清理临时缓存/ }))

    expect(sessionHistoryCache.size).toBe(0)
    expect(sessionHistoryCache.retainedBytes).toBe(0)
    expect(readPosition(currentPath)).toEqual(currentReading)
    expect(messageHeights(currentPath).get('current-message')).toBe(88)
    expect(useSessionStore.getState().currentSessionPath).toBe(currentPath)
    expect(useSessionStore.getState().messages).toEqual(messages)
    expect(useSessionStore.getState().draft).toBe('保留草稿')
    expect(screen.getByText('已清理前端会话缓存')).toBeInTheDocument()

    currentDisclosure.unmount()
    const retainedCurrentDisclosure = renderHook(() => useDisclosure('current-message'))
    expect(retainedCurrentDisclosure.result.current[0]).toBe(true)

    useSessionStore.setState({ currentSessionPath: otherPath })
    const clearedDisclosure = renderHook(() => useDisclosure('other-message'))
    expect(clearedDisclosure.result.current[0]).toBeNull()
    expect(readPosition(otherPath)).toBeUndefined()
    expect(messageHeights(otherPath).size).toBe(0)
  })
})
