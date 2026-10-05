import React, { useEffect } from 'react'
import { ArrowLeft, ChevronRight, Settings } from 'lucide-react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { SettingsNav } from './SettingsNav'
import { ModelProviderSection } from './sections/ModelProviderSection'
import { ModelBehaviorSection } from './sections/ModelBehaviorSection'
import { ResearchSection } from './sections/ResearchSection'
import { GeneralSection } from './sections/GeneralSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { ToolsSection } from './sections/ToolsSection'
import { DataSection } from './sections/DataSection'
import { ShortcutsSection } from './sections/ShortcutsSection'
import { AboutSection } from './sections/AboutSection'

interface SettingsPageProps {
  onClose: () => void
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ onClose }) => {
  const activeSection = useSettingsStore((s) => s.activeSection)
  const fetchInitialData = useSettingsStore((s) => s.fetchInitialData)

  useEffect(() => {
    fetchInitialData()
  }, [fetchInitialData])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const renderSection = () => {
    switch (activeSection) {
      case 'models':
        return <ModelProviderSection />
      case 'modelBehavior':
        return <ModelBehaviorSection />
      case 'research':
        return <ResearchSection />
      case 'general':
        return <GeneralSection />
      case 'appearance':
        return <AppearanceSection />
      case 'tools':
        return <ToolsSection />
      case 'data':
        return <DataSection />
      case 'shortcuts':
        return <ShortcutsSection />
      case 'about':
        return <AboutSection />
      default:
        return <ModelProviderSection />
    }
  }

  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-hidden select-none font-sans">
      {/* Top Header Breadcrumb matching ZCode */}
      <div className="flex items-center justify-between px-5 h-11 select-none shrink-0">
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle transition-colors cursor-pointer font-medium"
            title="返回时间线 (Esc)"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回时间线</span>
          </button>

          <ChevronRight className="w-3.5 h-3.5 text-dim" />

          <div className="flex items-center gap-1.5 text-muted font-medium">
            <Settings className="w-3.5 h-3.5 text-dim" />
            <span>客户端设置</span>
          </div>
        </div>

        <div className="text-[11px] text-dim font-mono">
          按 Esc 键可随时退出设置
        </div>
      </div>

      {/* Main Two-Column Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Nav */}
        <SettingsNav />

        {/* Right Content */}
        <main className="flex-1 overflow-y-auto p-6 lg:p-8 max-w-4xl">
          {renderSection()}
        </main>
      </div>
    </div>
  )
}
