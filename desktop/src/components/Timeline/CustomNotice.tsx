import React from 'react'
import {
  AlertTriangle,
  ClipboardList,
  Flag,
  GitBranch,
  Info,
  MessagesSquare,
  ScrollText,
  ShieldAlert,
} from 'lucide-react'
import type { ChatMessage } from '../../types/session'

/**
 * One engine notice from the conversation's own feed.
 *
 * A research run reports itself this way (`research-progress`, `research-question`, ...) rather
 * than as assistant prose, and the TUI shows it apart from Last Order's replies. The desktop has
 * to do the same: rendered as an answer, a progress line would look like something she claimed.
 */

type Tone = 'neutral' | 'info' | 'warning' | 'danger' | 'success'

interface NoticeKind {
  label: string
  tone: Tone
  Icon: React.ComponentType<{ className?: string }>
}

const KINDS: Record<string, NoticeKind> = {
  'research-progress': { label: '研究进展', tone: 'neutral', Icon: GitBranch },
  'research-phase': { label: '研究阶段', tone: 'neutral', Icon: ClipboardList },
  'research-review': { label: '审阅意见', tone: 'info', Icon: ShieldAlert },
  'research-question': { label: '待你澄清', tone: 'warning', Icon: AlertTriangle },
  'research-discipline': { label: '研究规程', tone: 'info', Icon: ScrollText },
  'research-final': { label: '研究结论', tone: 'success', Icon: Flag },
  'research-error': { label: '研究故障', tone: 'danger', Icon: AlertTriangle },
  'resume-briefing': { label: '交接简报', tone: 'info', Icon: MessagesSquare },
  'board-hint': { label: '看板提示', tone: 'neutral', Icon: Info },
  'todo-reminder': { label: '待办提醒', tone: 'neutral', Icon: ClipboardList },
  'submission-held': { label: '提交暂缓', tone: 'warning', Icon: AlertTriangle },
  'submission-incomplete': { label: '提交不完整', tone: 'warning', Icon: AlertTriangle },
  'sister-notification': { label: '姐妹消息', tone: 'neutral', Icon: MessagesSquare },
  'agent-messages': { label: '网络消息', tone: 'neutral', Icon: MessagesSquare },
  'task-notification': { label: '任务通知', tone: 'neutral', Icon: Info },
  'hook-notification': { label: '钩子通知', tone: 'neutral', Icon: Info },
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-border-subtle bg-surface-1/60 text-muted',
  info: 'border-info-border bg-info-surface text-muted',
  warning: 'border-warning-border bg-warning-surface text-muted',
  danger: 'border-danger-border bg-danger-surface text-muted',
  success: 'border-success-border bg-success-surface text-muted',
}

const TONE_LABEL: Record<Tone, string> = {
  neutral: 'text-dim',
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-danger',
  success: 'text-success',
}

export const CustomNotice: React.FC<{ message: ChatMessage }> = ({ message }) => {
  // The engine decides what the feed shows; a notice it marked hidden stays out of the timeline.
  if (message.display === false) return null

  const kind = KINDS[message.customType || ''] || {
    label: message.customType || '系统消息',
    tone: 'neutral' as Tone,
    Icon: Info,
  }
  const { Icon } = kind
  const timeStr = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div
      className={`my-2 rounded-lg border px-3 py-2 ${TONE_CLASS[kind.tone]}`}
      data-custom-type={message.customType}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium">
        <Icon className="w-3.5 h-3.5" />
        <span className={TONE_LABEL[kind.tone]}>{kind.label}</span>
        <span className="ml-auto text-[10.5px] text-dim font-mono">{timeStr}</span>
      </div>
      {message.content && (
        <div className="mt-1 text-[12.5px] leading-relaxed whitespace-pre-wrap text-text-main/90">
          {message.content}
        </div>
      )}
    </div>
  )
}
