import React from 'react'
import { Streamdown, defaultRehypePlugins, type Components } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { CodeBlock } from './CodeBlock'

interface MarkdownContentProps {
  content: string
  isStreaming?: boolean
}

function textOf(children: React.ReactNode): string {
  return React.Children.toArray(children).map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    if (React.isValidElement<{ children?: React.ReactNode }>(child)) return textOf(child.props.children)
    return ''
  }).join('')
}

const components: Components = {
  strong: ({ children }) => <strong>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  pre: ({ children }) => {
    const child = React.Children.toArray(children).find(React.isValidElement)
    const props = child && React.isValidElement<{ className?: string; children?: React.ReactNode }>(child) ? child.props : undefined
    return <CodeBlock language={/language-([^\s]+)/.exec(props?.className || '')?.[1] || 'text'} code={textOf(props?.children ?? children).replace(/\n$/, '')} />
  },
  code: ({ children }) => <code className="conversation-inline-code">{children}</code>,
  table: ({ children, node: _node, ...props }) => <div className="conversation-table-scroll" tabIndex={0} aria-label="可横向滚动的表格"><table {...props}>{children}</table></div>,
  a: ({ href, children, title }) => {
    const allowed = Boolean(href && /^https?:\/\//i.test(href))
    if (!allowed) return <span>{children}</span>
    return <a href={href} title={title} onClick={event => {
      event.preventDefault()
      void window.app?.openExternal?.(href!)
    }}>{children}</a>
  },
}
const plugins = { cjk }
// skipHtml operates on raw nodes; do not turn those nodes into DOM with rehype-raw first.
const rehypePlugins = Object.entries(defaultRehypePlugins).filter(([name]) => name !== 'raw').map(([, plugin]) => plugin)

export const MarkdownContent = React.memo(function MarkdownContent({ content, isStreaming = false }: MarkdownContentProps) {
  if (!content) return null
  return <Streamdown
    className="conversation-markdown"
    mode={isStreaming ? 'streaming' : 'static'}
    isAnimating={isStreaming}
    parseIncompleteMarkdown={isStreaming}
    animated={false}
    components={components}
    plugins={plugins}
    rehypePlugins={rehypePlugins}
    controls={false}
    skipHtml
  >{content}</Streamdown>
})
