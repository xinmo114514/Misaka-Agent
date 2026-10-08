import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AppearanceSection } from './AppearanceSection'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { darkTheme, lightTheme } from '../../../theme/builtins'
import { themeRegistry, toThemeData } from '../../../theme/registry'
import { applyThemeToDom, useTheme } from '../../../theme/useTheme'
import type { ThemeData } from '../../../types/global'

const custom = { ...lightTheme, id: 'daybreak', label: '晨光' }
let callbacks: Set<(data: ThemeData) => void>
let commands: unknown[]

function Surface() {
  useTheme()
  return <AppearanceSection />
}

describe('registered appearance themes', () => {
  beforeEach(() => {
    callbacks = new Set()
    commands = []
    useSettingsStore.setState({ themeName: 'dark', themeError: null })
    applyThemeToDom(toThemeData(darkTheme))
    window.bridge = { send: cmd => commands.push(cmd), on: () => () => {} }
    window.theme = {
      listThemes: async () => [...themeRegistry.list(), { id: custom.id, label: custom.label, mode: custom.mode }],
      getTheme: async () => toThemeData(darkTheme),
      onChange: cb => { callbacks.add(cb); return () => { callbacks.delete(cb) } },
      setTheme: async name => {
        const theme = name === custom.id ? custom : themeRegistry.get(name)!
        for (const cb of callbacks) cb(toThemeData(theme))
        return { ok: true, name }
      },
    }
  })

  it('shows registered themes and synchronizes the selected theme without sending custom IDs to the terminal', async () => {
    render(<Surface />)
    const button = await screen.findByRole('button', { name: /晨光/ })
    fireEvent.click(button)
    await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('daybreak')
    expect(document.documentElement.style.getPropertyValue('--success')).toBe('#2f6b34')
    expect(commands).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: /深色主题/ }))
    await waitFor(() => expect(useSettingsStore.getState().themeName).toBe('dark'))
    expect(commands).toEqual([expect.objectContaining({ type: 'set_theme', name: 'dark' })])
  })

  it('preserves the actual selection and palette when the main process rejects a switch', async () => {
    window.theme.setTheme = async () => ({ ok: false, name: 'dark', error: '保存主题失败' })
    render(<Surface />)
    fireEvent.click(await screen.findByRole('button', { name: /晨光/ }))
    expect(await screen.findByText('保存主题失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /深色主题/ })).toHaveAttribute('aria-pressed', 'true')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(commands).toEqual([])
  })

  it('ignores superseded errors so rapid theme choices do not show stale failures', async () => {
    let rejectFirst: (result: { ok: boolean; name: string; error: string }) => void = () => {}
    window.theme.setTheme = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { rejectFirst = resolve }))
      .mockImplementationOnce(async () => ({ ok: true, name: 'light' }))
    render(<Surface />)
    fireEvent.click(await screen.findByRole('button', { name: /晨光/ }))
    fireEvent.click(screen.getByRole('button', { name: /浅色主题/ }))
    await waitFor(() => expect(useSettingsStore.getState().themeName).toBe('light'))
    rejectFirst({ ok: false, name: 'dark', error: '旧请求错误' })
    await waitFor(() => expect(useSettingsStore.getState().themeError).toBeNull())
    expect(screen.queryByText('旧请求错误')).not.toBeInTheDocument()
  })

  it('still mirrors a successful builtin when a later custom choice fails before its acknowledgement', async () => {
    let acknowledgeBuiltin: (result: { ok: boolean; name: string }) => void = () => {}
    window.theme.setTheme = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { acknowledgeBuiltin = resolve }))
      .mockImplementationOnce(async () => ({ ok: false, name: 'light', error: '自定义主题保存失败' }))
    render(<Surface />)
    await screen.findByRole('button', { name: /晨光/ })
    fireEvent.click(screen.getByRole('button', { name: /浅色主题/ }))
    act(() => { for (const cb of callbacks) cb(toThemeData(lightTheme)) })
    fireEvent.click(screen.getByRole('button', { name: /晨光/ }))
    await screen.findByText('自定义主题保存失败')
    await act(async () => { acknowledgeBuiltin({ ok: true, name: 'light' }) })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(commands).toEqual([expect.objectContaining({ type: 'set_theme', name: 'light' })])
    expect(useSettingsStore.getState().themeError).toBe('自定义主题保存失败')
  })

  it('does not mirror an older builtin acknowledgement over a newer successful builtin', async () => {
    let acknowledgeOlder: (result: { ok: boolean; name: string }) => void = () => {}
    window.theme.setTheme = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { acknowledgeOlder = resolve }))
      .mockImplementationOnce(async () => ({ ok: true, name: 'dark' }))
    render(<Surface />)
    await screen.findByRole('button', { name: /晨光/ })
    fireEvent.click(screen.getByRole('button', { name: /浅色主题/ }))
    fireEvent.click(screen.getByRole('button', { name: /深色主题/ }))
    await waitFor(() => expect(commands).toHaveLength(1))
    await act(async () => { acknowledgeOlder({ ok: true, name: 'light' }) })
    expect(commands).toEqual([expect.objectContaining({ type: 'set_theme', name: 'dark' })])
  })
})
