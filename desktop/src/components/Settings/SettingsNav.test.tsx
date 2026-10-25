import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SettingsNav } from './SettingsNav'
import { useSettingsStore } from '../../store/useSettingsStore'

describe('SettingsNav network search', () => {
  beforeEach(() => {
    useSettingsStore.setState({ searchQuery: '', activeSection: 'models', providerGroups: [], customProviders: [] })
  })

  it('finds and opens 网络与代理 from settings search', () => {
    render(<SettingsNav />)
    fireEvent.change(screen.getByPlaceholderText('搜索设置项...'), { target: { value: '网络' } })
    expect(screen.queryByRole('button', { name: /模型与供应商/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '网络与代理' }))
    expect(useSettingsStore.getState().activeSection).toBe('network')
  })
})
