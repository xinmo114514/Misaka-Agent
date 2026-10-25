import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSettingsStore } from '../store/useSettingsStore'
import { CloseConfirmDialog } from './CloseConfirmDialog'

describe('CloseConfirmDialog', () => {
  const onClose = vi.fn()
  const onConfirm = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ closeWindowAction: 'ask' })
    window.app = {
      confirmClose: vi.fn().mockResolvedValue(undefined),
    } as any
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the custom close confirmation dialog matching design', () => {
    render(<CloseConfirmDialog open={true} onClose={onClose} />)

    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('关闭 Misaka 窗口？')).toBeInTheDocument()
    expect(
      screen.getByText('最小化到托盘后，Agent 和后台任务会继续运行；退出应用会停止正在进行的工作。')
    ).toBeInTheDocument()
    expect(screen.getByText('不再询问')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出应用' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '最小化到托盘' })).toBeInTheDocument()
  })

  it('does not render when open is false', () => {
    render(<CloseConfirmDialog open={false} onClose={onClose} />)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('cancels without confirming when clicking 取消', () => {
    render(<CloseConfirmDialog open={true} onClose={onClose} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(window.app.confirmClose).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().closeWindowAction).toBe('ask')
  })

  it('dismisses when pressing Escape', () => {
    render(<CloseConfirmDialog open={true} onClose={onClose} onConfirm={onConfirm} />)

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('triggers minimize to tray without saving preference if 不再询问 is not checked', () => {
    render(<CloseConfirmDialog open={true} onClose={onClose} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }))
    expect(onConfirm).toHaveBeenCalledWith('tray', false)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().closeWindowAction).toBe('ask')
  })

  it('triggers minimize to tray and saves preference when 不再询问 is checked', () => {
    render(<CloseConfirmDialog open={true} onClose={onClose} onConfirm={onConfirm} />)

    const checkbox = screen.getByLabelText('不再询问')
    fireEvent.click(checkbox)

    fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }))
    expect(onConfirm).toHaveBeenCalledWith('tray', true)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().closeWindowAction).toBe('tray')
  })

  it('triggers exit app and saves preference when 不再询问 is checked', () => {
    render(<CloseConfirmDialog open={true} onClose={onClose} onConfirm={onConfirm} />)

    const checkbox = screen.getByLabelText('不再询问')
    fireEvent.click(checkbox)

    fireEvent.click(screen.getByRole('button', { name: '退出应用' }))
    expect(onConfirm).toHaveBeenCalledWith('quit', true)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().closeWindowAction).toBe('quit')
  })

  it('calls default window.app.confirmClose when onConfirm prop is omitted', () => {
    render(<CloseConfirmDialog open={true} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: '最小化到托盘' }))
    expect(window.app.confirmClose).toHaveBeenCalledWith('tray')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
