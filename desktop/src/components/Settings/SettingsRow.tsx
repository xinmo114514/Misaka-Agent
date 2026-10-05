import React from 'react'

interface SettingsRowProps {
  title: string
  description?: string
  children: React.ReactNode
  badge?: string
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  title,
  description,
  children,
  badge,
}) => {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3.5 border-b border-border-subtle/60 text-xs">
      <div className="space-y-0.5 max-w-xl pr-4">
        <div className="flex items-center gap-2">
          <span className="font-medium text-text-main text-[13px]">{title}</span>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-dim border border-border-subtle">
              {badge}
            </span>
          )}
        </div>
        {description && (
          <p className="text-[12px] text-muted leading-relaxed font-normal">{description}</p>
        )}
      </div>
      <div className="shrink-0 flex items-center justify-end">{children}</div>
    </div>
  )
}
