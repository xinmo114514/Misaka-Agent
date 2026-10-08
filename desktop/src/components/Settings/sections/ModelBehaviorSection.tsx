import React, { useMemo } from 'react'
import { Brain } from 'lucide-react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { SettingsRow } from '../SettingsRow'
import { ThinkingSlider } from '../../Thinking/ThinkingSlider'
import { resetTarget, thinkingStopsFor } from '../../../lib/thinkingLevels'

export const ModelBehaviorSection: React.FC = () => {
  const models = useSettingsStore((s) => s.models)
  const currentModel = useSettingsStore((s) => s.currentModel)
  const thinkingLevel = useSettingsStore((s) => s.thinkingLevel)
  const availableThinkingLevels = useSettingsStore((s) => s.availableThinkingLevels)
  const supportsThinking = useSettingsStore(s => s.supportsThinking)
  const modelSwitchPending = useSettingsStore(s => s.modelSwitchPending)
  const setThinkingLevel = useSettingsStore((s) => s.setThinkingLevel)

  const configPaths = useSettingsStore((s) => s.configPaths)
  // Unset is not `off`: the engine falls through to DEFAULT_THINKING_LEVEL, so showing
  // `medium` here is what a new session actually gets.
  const storedDefault = configPaths?.defaultThinkingLevel
  const defaultThinkingLevel = storedDefault || 'medium'
  const setDefaultThinkingLevel = useSettingsStore((s) => s.setDefaultThinkingLevel)

  const stops = useMemo(
    () => thinkingStopsFor({ currentModel, models, backendLevels: availableThinkingLevels, backendSupportsThinking: supportsThinking }),
    [currentModel, models, availableThinkingLevels, supportsThinking],
  )
  const toDefault = resetTarget(storedDefault, stops.levels)

  const autoCompaction = useSettingsStore((s) => s.autoCompaction)
  const setAutoCompaction = useSettingsStore((s) => s.setAutoCompaction)

  const hideThinkingBlock = useSettingsStore((s) => s.hideThinkingBlock)
  const setHideThinkingBlock = useSettingsStore((s) => s.setHideThinkingBlock)

  return (
    <div className="space-y-6">
      <div className="misaka-glass-panel relative p-4 rounded-xl bg-card shadow-e1 border border-border-subtle">
        <h2 className="text-sm font-semibold text-text-main flex items-center gap-2">
          <Brain className="w-4 h-4 text-accent" />
          <span>思考推理与上下文管理行为</span>
        </h2>
        <p className="text-xs text-muted mt-1 leading-relaxed">
          针对具备推理（Reasoning）能力的前沿模型（如 DeepSeek-R1, Claude 3.7 Sonnet, o3-mini），配置思考预算与上下文压缩策略。
        </p>
      </div>

      <div className="misaka-glass-panel relative rounded-xl border border-border-subtle bg-card shadow-e1 p-4 space-y-1">
        <SettingsRow
          title="当前会话思考强度 (Session Thinking Level)"
          description="调节推理模型在输出前展开的思考深度。立即作用于当前活跃会话。"
        >
          <ThinkingSlider
            levels={stops.levels}
            value={thinkingLevel}
            busy={modelSwitchPending}
            isFallback={stops.isFallback}
            resetTo={toDefault}
            onReset={() => setThinkingLevel(toDefault)}
            onChange={setThinkingLevel}
          />
        </SettingsRow>

        <SettingsRow
          title="新会话默认思考强度 (Default Thinking Level)"
          description="创建新课题或新对话时模型默认继承的推理强度。社科理论推演建议设为深度档。"
          badge="持久化配置"
        >
          <ThinkingSlider
            levels={stops.levels}
            value={defaultThinkingLevel}
            isFallback={stops.isFallback}
            onChange={setDefaultThinkingLevel}
          />
        </SettingsRow>

        <SettingsRow
          title="自动上下文压缩 (Auto Compaction)"
          description="当历史会话上下文接近模型窗口极限时，自动执行摘要压缩，保留最近重要学术论断。"
          badge="长上下文优化"
        >
          <button
            type="button"
            onClick={() => setAutoCompaction(!autoCompaction)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              autoCompaction ? 'bg-accent' : 'bg-surface-3'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-switch-thumb shadow-lg ring-0 transition duration-200 ease-in-out ${
                autoCompaction ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </SettingsRow>

        <SettingsRow
          title="默认折叠思考链 (Fold Thinking Block)"
          description="在对话时间线中默认折叠详细思维链推导过程，点击展开查看，保持文献阅读专注。"
        >
          <button
            type="button"
            onClick={() => setHideThinkingBlock(!hideThinkingBlock)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              hideThinkingBlock ? 'bg-accent' : 'bg-surface-3'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-switch-thumb shadow-lg ring-0 transition duration-200 ease-in-out ${
                hideThinkingBlock ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </SettingsRow>
      </div>
    </div>
  )
}
