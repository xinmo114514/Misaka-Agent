import React, { useState } from 'react'
import { GraduationCap, RotateCcw, Check } from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { SettingsRow } from '../SettingsRow'

export const ResearchSection: React.FC = () => {
  const productSettings = useSettingsStore((s) => s.productSettings)
  const saveProductSetting = useSettingsStore((s) => s.saveProductSetting)
  const resetResearchSettings = useSettingsStore((s) => s.resetResearchSettings)

  const [savedNotice, setSavedNotice] = useState<string | null>(null)

  const research = productSettings.research || {}
  const subagents = productSettings.subagents || {}
  const network = productSettings.network || {}

  const planApproval = research.plan_approval !== false
  const tokenCap = research.token_cap || 0
  const coordinatorMode = subagents.coordinator_mode !== false
  const verificationAgent = subagents.verification_agent !== false
  const autoMemory = subagents.auto_memory !== false
  const maxSisters = network.max_concurrent_sisters || 4

  const handleUpdate = (section: string, key: string, val: any) => {
    saveProductSetting(section, key, val)
    setSavedNotice('设置已实时保存至 settings.json')
    setTimeout(() => setSavedNotice(null), 2500)
  }

  const handleReset = () => {
    resetResearchSettings()
    setSavedNotice('已恢复为人文社科推荐默认参数')
    setTimeout(() => setSavedNotice(null), 3000)
  }

  return (
    <div className="space-y-6">
      <div className="p-4 rounded-xl bg-card shadow-e1 border border-border-subtle flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
            <GraduationCap className="w-4 h-4 text-accent" />
            <span>人文社科研究专有引擎参数</span>
          </h2>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            针对人文社会科学学术研究设计的协同参数：包括论点规划前置审批、学术严谨性红队复审、跨 Sister 协同研究网络配额。
          </p>
        </div>

        <button
          type="button"
          onClick={handleReset}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-text-main border border-border-subtle text-xs transition-colors cursor-pointer shrink-0"
          title="重置为官方推荐学术默认值"
        >
          <RotateCcw className="w-3.5 h-3.5 text-dim" />
          <span>恢复推荐默认值</span>
        </button>
      </div>

      <div className="rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-1">
        <SettingsRow
          title="研究规划审批 (Plan Approval)"
          description="当 Sister 启动大规模学术课题前，强制输出结构化研究规划大纲，等待用户审查确认后方可调用工具推进。"
          badge="学术合规"
        >
          <button
            type="button"
            onClick={() => handleUpdate('research', 'plan_approval', !planApproval)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              planApproval ? 'bg-accent' : 'bg-surface-3'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                planApproval ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </SettingsRow>

        <SettingsRow
          title="单次研究 Token 预算上限 (Token Cap)"
          description="限制单次课题研究所能消耗的最大 Token 总数。0 表示不设硬上限。"
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={tokenCap}
              onChange={(e) => handleUpdate('research', 'token_cap', parseInt(e.target.value) || 0)}
              className="w-24 bg-surface-2 text-text-main px-2.5 py-1 rounded-lg border border-border text-xs text-right font-mono outline-none focus:border-accent"
              step="5000"
              min="0"
            />
            <span className="text-dim text-xs">Tokens</span>
          </div>
        </SettingsRow>

        <SettingsRow
          title="协调者多 Agent 模式 (Coordinator Mode)"
          description="启用总协调 Sister（Last Order），在复杂社科命题下自动调度不同细分专业领域的 Sister 协同执行分支任务。"
          badge="多智能体"
        >
          <button
            type="button"
            onClick={() => handleUpdate('subagents', 'coordinator_mode', !coordinatorMode)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              coordinatorMode ? 'bg-accent' : 'bg-surface-3'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                coordinatorMode ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </SettingsRow>

        <SettingsRow
          title="学术严谨性复审 (Verification & Red-teaming)"
          description="在合成最终研究结论前，自动指派一名独立 Sister 担任反方或审稿专家（Reviewer），查找论证漏洞与文献缺漏。"
          badge="红队复审"
        >
          <button
            type="button"
            onClick={() => handleUpdate('subagents', 'verification_agent', !verificationAgent)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              verificationAgent ? 'bg-accent' : 'bg-surface-3'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                verificationAgent ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </SettingsRow>

        <SettingsRow
          title="学术观点自动沉淀 (Auto Memory)"
          description="会话沉淀时自动提取具有长期学术价值的论据、学者观点与文献考证，存入长期知识记忆库。"
        >
          <button
            type="button"
            onClick={() => handleUpdate('subagents', 'auto_memory', !autoMemory)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              autoMemory ? 'bg-accent' : 'bg-surface-3'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
                autoMemory ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </SettingsRow>

        <SettingsRow
          title="并发协同 Sister 上限 (Max Concurrent Sisters)"
          description="允许同时并行研读文献与推理的 Sister Agent 最大数量。"
        >
          <div className="flex items-center gap-2">
            <select
              value={maxSisters}
              onChange={(e) => handleUpdate('network', 'max_concurrent_sisters', parseInt(e.target.value))}
              className="bg-surface-2 text-text-main px-2.5 py-1 rounded-lg border border-border text-xs outline-none focus:border-accent cursor-pointer"
            >
              <option value="2">2 名专家</option>
              <option value="4">4 名专家 (推荐)</option>
              <option value="8">8 名专家</option>
            </select>
          </div>
        </SettingsRow>
      </div>

      {savedNotice && (
        <div className="p-3 rounded-lg bg-success-surface text-success border border-success-border text-xs flex items-center gap-2">
          <Check className="w-4 h-4 shrink-0" />
          <span>{savedNotice}</span>
        </div>
      )}
    </div>
  )
}
