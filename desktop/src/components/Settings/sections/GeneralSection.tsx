import React, { useState } from 'react'
import { Folder, FolderOpen, ShieldCheck, ExternalLink, Check } from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { SettingsRow } from '../SettingsRow'

export const GeneralSection: React.FC = () => {
  const configPaths = useSettingsStore((s) => s.configPaths)
  const pickDirectory = useSettingsStore((s) => s.pickDirectory)
  const requireShellConfirm = useSettingsStore((s) => s.requireShellConfirm)
  const setRequireShellConfirm = useSettingsStore((s) => s.setRequireShellConfirm)

  const [switchNotice, setSwitchNotice] = useState<string | null>(null)

  const handlePickDirectory = async () => {
    const chosen = await pickDirectory()
    if (chosen) {
      setSwitchNotice(`工作目录已成功切换至: ${chosen}`)
      setTimeout(() => setSwitchNotice(null), 4000)
    }
  }

  const handleOpenWorkspace = async () => {
    if (configPaths?.cwd && window.app?.openPath) {
      await window.app.openPath(configPaths.cwd)
    }
  }

  return (
    <div className="space-y-6">
      <div className="p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
        <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <Folder className="w-4 h-4 text-accent" />
          <span>本地工作空间与通用环境</span>
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          管理 Misaka Agent 执行研究任务时默认读写文献与输出报告的主工作区目录。目录变更会实时通知 Python 内核热切换。
        </p>
      </div>

      <div className="rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-1">
        <SettingsRow
          title="当前项目工作目录 (Workspace Root)"
          description="Agent 查找本地 PDF、Markdown、数据源和执行终端命令时使用的根目录。"
        >
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] font-mono bg-surface-2 px-2.5 py-1 rounded border border-border-subtle text-text-main truncate max-w-xs" title={configPaths?.cwd}>
              {configPaths?.cwd || '未获取'}
            </span>
            <button
              type="button"
              onClick={handlePickDirectory}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer"
              title="浏览并选择新工作目录"
            >
              <FolderOpen className="w-3.5 h-3.5 text-accent" />
              <span>选择目录</span>
            </button>
            {configPaths?.cwd && (
              <button
                type="button"
                onClick={handleOpenWorkspace}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer"
                title="在资源管理器中打开当前目录"
              >
                <ExternalLink className="w-3.5 h-3.5 text-dim" />
                <span>打开</span>
              </button>
            )}
          </div>
        </SettingsRow>

        <SettingsRow
          title="执行沙箱模式 (Execution Sandbox)"
          description="桌面客户端本地运行，默认具备完全文件读写与命令权限。"
        >
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-warning-surface text-warning border border-warning-border text-xs font-medium">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>完全本地访问 (Full Access)</span>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Shell 终端命令安全确认 (Confirm Shell Commands)"
          description="当智能体尝试在系统底层执行带有潜在修改性的终端命令（如 rm, del, git push）前提示确认。"
          badge="安全策略"
        >
          <button
            type="button"
            onClick={() => setRequireShellConfirm(!requireShellConfirm)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              requireShellConfirm ? 'bg-accent' : 'bg-surface-3'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                requireShellConfirm ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </SettingsRow>
      </div>

      {switchNotice && (
        <div className="p-3 rounded-lg bg-success-surface text-success border border-success-border text-xs flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" />
          <span>{switchNotice}</span>
        </div>
      )}
    </div>
  )
}
