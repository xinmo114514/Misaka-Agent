import React from 'react'
import { CodeBlock } from './CodeBlock'

interface MarkdownContentProps {
  content: string
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content }) => {
  if (!content) return null

  // Split into code blocks and normal markdown segments
  const parts: React.ReactNode[] = []
  const regex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(renderTextSegment(content.slice(lastIndex, match.index), `seg-${lastIndex}`))
    }
    const lang = match[1] || 'text'
    const code = match[2].trimEnd()
    parts.push(<CodeBlock key={`code-${match.index}`} language={lang} code={code} />)
    lastIndex = regex.lastIndex
  }

  if (lastIndex < content.length) {
    parts.push(renderTextSegment(content.slice(lastIndex), `seg-${lastIndex}`))
  }

  return <div className="space-y-2.5 text-[length:var(--font-size-body)] leading-[1.65] text-text-main selection:bg-accent/20">{parts}</div>
}

function renderTextSegment(text: string, keyPrefix: string): React.ReactNode {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []

  let listItems: React.ReactNode[] = []
  let inList = false
  let listType: 'ul' | 'ol' = 'ul'

  const flushList = (key: string) => {
    if (listItems.length > 0) {
      if (listType === 'ol') {
        elements.push(
          <ol key={key} className="my-2 ml-5 space-y-1.5 list-decimal text-text-main">
            {listItems}
          </ol>
        )
      } else {
        elements.push(
          <ul key={key} className="my-2 ml-5 space-y-1.5 list-disc marker:text-rose-lite text-text-main">
            {listItems}
          </ul>
        )
      }
      listItems = []
      inList = false
    }
  }

  lines.forEach((line, idx) => {
    const trimmed = line.trim()
    const lineKey = `${keyPrefix}-line-${idx}`

    // Heading 1
    if (line.startsWith('# ')) {
      flushList(`${lineKey}-list`)
      elements.push(
        <h1 key={lineKey} className="text-h1 font-bold text-text-main mt-4 mb-2 first:mt-0 pb-1 border-b border-border-subtle">
          {formatInline(line.slice(2))}
        </h1>
      )
      return
    }

    // Heading 2
    if (line.startsWith('## ')) {
      flushList(`${lineKey}-list`)
      elements.push(
        <h2 key={lineKey} className="text-h2 font-bold text-text-main mt-3.5 mb-1.5 first:mt-0">
          {formatInline(line.slice(3))}
        </h2>
      )
      return
    }

    // Heading 3
    if (line.startsWith('### ')) {
      flushList(`${lineKey}-list`)
      elements.push(
        <h3 key={lineKey} className="text-h3 font-semibold text-text-main mt-3 mb-1 first:mt-0">
          {formatInline(line.slice(4))}
        </h3>
      )
      return
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList(`${lineKey}-list`)
      elements.push(
        <blockquote key={lineKey} className="my-2 pl-3 border-l-2 border-accent text-muted italic bg-surface-1/40 py-1 rounded-r">
          {formatInline(line.slice(2))}
        </blockquote>
      )
      return
    }

    // Unordered List
    if (/^[*-]\s+/.test(trimmed)) {
      if (!inList || listType !== 'ul') {
        flushList(`${lineKey}-list`)
        inList = true
        listType = 'ul'
      }
      const itemContent = trimmed.replace(/^[*-]\s+/, '')
      listItems.push(<li key={lineKey} className="pl-1">{formatInline(itemContent)}</li>)
      return
    }

    // Ordered List
    if (/^\d+\.\s+/.test(trimmed)) {
      if (!inList || listType !== 'ol') {
        flushList(`${lineKey}-list`)
        inList = true
        listType = 'ol'
      }
      const itemContent = trimmed.replace(/^\d+\.\s+/, '')
      listItems.push(<li key={lineKey} className="pl-1">{formatInline(itemContent)}</li>)
      return
    }

    // Normal paragraph
    flushList(`${lineKey}-list`)
    if (!trimmed) {
      elements.push(<div key={lineKey} className="h-2" />)
    } else {
      elements.push(
        <p key={lineKey} className="my-1.5 first:mt-0 last:mb-0">
          {formatInline(line)}
        </p>
      )
    }
  })

  flushList(`${keyPrefix}-final-list`)
  return <React.Fragment key={keyPrefix}>{elements}</React.Fragment>
}

function formatInline(str: string): React.ReactNode {
  // Matches inline code: `code`
  const parts: React.ReactNode[] = []
  const codeRegex = /`([^`]+)`/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = codeRegex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      parts.push(formatBoldItalic(str.slice(lastIndex, match.index), `sub-${lastIndex}`))
    }
    parts.push(
      <code
        key={`inline-code-${match.index}`}
        className="px-1.5 py-0.5 mx-0.5 rounded text-[length:var(--font-size-prose-sm)] font-mono bg-surface-2 border border-border-subtle text-rose-lite font-medium"
      >
        {match[1]}
      </code>
    )
    lastIndex = codeRegex.lastIndex
  }

  if (lastIndex < str.length) {
    parts.push(formatBoldItalic(str.slice(lastIndex), `sub-${lastIndex}`))
  }

  return parts
}

function formatBoldItalic(str: string, keyPrefix: string): React.ReactNode {
  // Matches **bold**
  const parts: React.ReactNode[] = []
  const boldRegex = /\*\*([^*]+)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = boldRegex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      parts.push(str.slice(lastIndex, match.index))
    }
    parts.push(
      <strong key={`${keyPrefix}-b-${match.index}`} className="font-semibold text-text-main">
        {match[1]}
      </strong>
    )
    lastIndex = boldRegex.lastIndex
  }

  if (lastIndex < str.length) {
    parts.push(str.slice(lastIndex))
  }

  return parts
}
