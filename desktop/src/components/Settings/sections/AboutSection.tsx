import React, { useEffect, useRef, useState } from 'react'
import {
  Info,
  ShieldCheck,
  RefreshCw,
  Activity,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Cpu,
  X,
} from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { clipboardErrorMessage, copyTextToClipboard } from '../../../lib/clipboard'
import { SettingsRow } from '../SettingsRow'
import desktopPackage from '../../../../package.json'

export const AboutSection: React.FC = () => {
  const [version, setVersion] = useState<string>(desktopPackage.version)
  const [copiedDiag, setCopiedDiag] = useState(false)
  const [copyingDiag, setCopyingDiag] = useState(false)
  const [copyDiagError, setCopyDiagError] = useState<string | null>(null)
  const copiedDiagTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateStatus = useSettingsStore((s) => s.updateStatus)
  const isCheckingUpdate = useSettingsStore((s) => s.isCheckingUpdate)
  const checkUpdate = useSettingsStore((s) => s.checkUpdate)

  const diagnostics = useSettingsStore((s) => s.diagnostics)
  const isDiagnosing = useSettingsStore((s) => s.isDiagnosing)
  const runDiagnostics = useSettingsStore((s) => s.runDiagnostics)

  useEffect(() => {
    if (window.app?.getVersion) {
      window.app.getVersion().then(setVersion).catch(() => { /* Keep the bundled version if IPC is unavailable. */ })
    }
    // Run diagnostics initially
    runDiagnostics()
  }, [runDiagnostics])

  useEffect(() => () => {
    if (copiedDiagTimer.current) clearTimeout(copiedDiagTimer.current)
  }, [])

  const handleCopyDiag = async () => {
    if (!diagnostics || copyingDiag) return
    setCopyingDiag(true)
    setCopiedDiag(false)
    setCopyDiagError(null)
    try {
      await copyTextToClipboard(JSON.stringify(diagnostics, null, 2))
      setCopiedDiag(true)
      if (copiedDiagTimer.current) clearTimeout(copiedDiagTimer.current)
      copiedDiagTimer.current = setTimeout(() => {
        setCopiedDiag(false)
        copiedDiagTimer.current = null
      }, 2000)
    } catch (error) {
      setCopyDiagError(`复制失败：${clipboardErrorMessage(error)}`)
    } finally {
      setCopyingDiag(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="misaka-glass-panel relative p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
        <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <Info className="w-4 h-4 text-accent" />
          <span>关于客户端与内核诊断</span>
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          专为人文社科研究学者打造的 AI Agent 桌面系统，基于 Electron 34、React 19 与 Python 内核驱动。提供实时系统健康巡检。
        </p>
      </div>

      {/* Version & Update Card */}
      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text-main text-[13px]">
                桌面客户端版本 (Desktop Version)
              </span>
              <span className="font-mono text-xs px-2 py-0.5 rounded bg-surface-2 text-text-main border border-border-subtle font-medium">
                v{version}
              </span>
            </div>
            <p className="text-xs text-muted leading-relaxed">
              协议桥接层：Stdio JSONL 双向全双工通道
            </p>
          </div>

          <button
            type="button"
            onClick={checkUpdate}
            disabled={isCheckingUpdate}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isCheckingUpdate ? 'animate-spin text-accent' : 'text-dim'}`} />
            <span>{isCheckingUpdate ? '检测更新中...' : '检查版本更新'}</span>
          </button>
        </div>

        {updateStatus && (
          <div className="p-3 rounded-lg bg-surface-2 border border-border-subtle text-xs space-y-1">
            <div className="flex items-center gap-2">
              {updateStatus.upToDate ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  <span className="text-success font-medium">当前已是最新版本</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-warning" />
                  <span className="text-warning font-medium">
                    发现新版本 (落后 {updateStatus.behind || 1} 个提交)
                  </span>
                </>
              )}
            </div>
            {updateStatus.reason && (
              <p className="text-[11px] text-dim">{updateStatus.reason}</p>
            )}
          </div>
        )}
      </div>

      {/* System Health & Diagnostics Card */}
      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-text-main flex items-center gap-2">
              <Activity className="w-4 h-4 text-accent" />
              <span>内核实时健康与系统诊断 (Live Diagnostics)</span>
            </h3>
            <p className="text-xs text-muted leading-relaxed">
              测试 Python 子进程环境、IPC 协议往返延时、工作目录可写权限与模型配置就绪度。
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {diagnostics && (
              <button
                type="button"
                onClick={handleCopyDiag}
                disabled={copyingDiag}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                title="复制诊断 JSON"
              >
                {copiedDiag ? (
                  <Check className="w-3.5 h-3.5 text-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-dim" />
                )}
                <span>{copyingDiag ? '复制中…' : copiedDiag ? '已复制' : '复制诊断'}</span>
                {copiedDiag && <span role="status" className="sr-only">诊断信息已复制</span>}
              </button>
            )}
            <button
              type="button"
              onClick={runDiagnostics}
              disabled={isDiagnosing}
              className="misaka-luminous flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-on-accent hover:bg-accent/90 text-xs font-medium transition-all shadow-xs cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isDiagnosing ? 'animate-spin' : ''}`} />
              <span>{isDiagnosing ? '正在诊断...' : '重新检测'}</span>
            </button>
          </div>
        </div>

        {copyDiagError && <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-danger-border bg-danger-surface px-3 py-2 text-xs text-danger">
          <span>{copyDiagError}</span>
          <button type="button" aria-label="关闭复制提示" onClick={() => setCopyDiagError(null)}><X className="h-3.5 w-3.5" /></button>
        </div>}

        {diagnostics ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div className="p-3 rounded-lg bg-surface-2/70 border border-border-subtle space-y-1 text-xs">
              <div className="text-[11px] text-dim">Bridge IPC 往返延迟</div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                <span className="font-mono text-sm font-semibold text-text-main">
                  {diagnostics.latencyMs || 1} ms
                </span>
                <span className="text-[10px] text-success">极速响应</span>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-surface-2/70 border border-border-subtle space-y-1 text-xs">
              <div className="text-[11px] text-dim">Python 解释器环境</div>
              <div className="font-mono text-xs font-medium text-text-main truncate">
                Python v{diagnostics.pythonVersion}
              </div>
              <div className="text-[10px] text-dim truncate">{diagnostics.platform}</div>
            </div>

            <div className="p-3 rounded-lg bg-surface-2/70 border border-border-subtle space-y-1 text-xs">
              <div className="text-[11px] text-dim">模型注册状态</div>
              <div className="flex items-center gap-1.5 font-medium text-text-main">
                <Cpu className="w-3.5 h-3.5 text-accent" />
                <span>已授权：{diagnostics.modelsConfigured} / 全部：{diagnostics.modelsTotal} 款</span>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-surface-2/70 border border-border-subtle space-y-1 text-xs">
              <div className="text-[11px] text-dim">工作区文件读写权限</div>
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${diagnostics.cwdWritable ? 'bg-success' : 'bg-danger'}`} />
                <span className="font-medium text-text-main">
                  {diagnostics.cwdWritable ? '读写完全许可 (RW OK)' : '受限只读'}
                </span>
              </div>
              <div className="text-[10px] text-dim truncate" title={diagnostics.cwd}>
                {diagnostics.cwd}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center text-xs text-dim">
            点击“重新检测”执行内核与桥接层健康巡检
          </div>
        )}
      </div>

      {/* Security & Data Ownership */}
      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-1">
        <SettingsRow title="数据所有权与隐私承诺">
          <div className="flex items-center gap-1.5 text-xs text-dim">
            <ShieldCheck className="w-3.5 h-3.5 text-accent" />
            <span>100% 本地运算与存储 · 绝无三方数据遥测</span>
          </div>
        </SettingsRow>
      </div>
    </div>
  )
}
