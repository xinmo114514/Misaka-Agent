import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Composer } from '../Composer'
import { useSessionStore } from '../../../store/useSessionStore'

type ResizeCallback = ResizeObserverCallback

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  callback: ResizeCallback
  target: Element | null = null

  constructor(callback: ResizeCallback) {
    this.callback = callback
    TestResizeObserver.instances.push(this)
  }

  observe = (target: Element) => { this.target = target }
  unobserve = () => { this.target = null }
  disconnect = () => { this.target = null }

  static resize(target: Element) {
    for (const observer of TestResizeObserver.instances) {
      if (observer.target === target) observer.callback([], observer as unknown as ResizeObserver)
    }
  }
}

const nativeResizeObserver = globalThis.ResizeObserver

beforeEach(() => {
  TestResizeObserver.instances = []
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
  useSessionStore.setState({ agentMode: 'agent', draft: '', attachments: [],
    retainedEditorText: null, isStreaming: false, isAborting: false,
    isSessionLoading: false, sessionLoadError: null, sessionOperation: null,
    isCompacting: false, researchBinding: null, researchCards: {},
    researchConnectionError: null, researchPageView: 'conversation' })
})

afterEach(() => {
  cleanup()
  globalThis.ResizeObserver = nativeResizeObserver
})

it('opts only the existing composer into multi presentation without replacing its editor', () => {
  const view = render(<Composer />)
  const editor = screen.getByRole('textbox', { name: '给 Misaka 发送任务' }) as HTMLTextAreaElement
  const form = editor.closest('form')!
  expect(form).not.toHaveAttribute('data-composer-presentation', 'multi')

  editor.focus()
  editor.setSelectionRange(0, 0)
  view.rerender(<Composer presentation="multi" />)

  expect(screen.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBe(editor)
  expect(editor.closest('form')).toBe(form)
  expect(form).toHaveAttribute('data-composer-presentation', 'multi')
  expect(document.activeElement).toBe(editor)
  expect(screen.getByRole('button', { name: '模型与思考深度' })).toHaveAccessibleDescription()
})

it('sizes a restored draft to the multi cap and removes stale geometry after leaving multi', () => {
  useSessionStore.setState({ draft: '持久化的长草稿' })
  let measuredHeight = 146
  const view = render(<Composer />)
  const editor = screen.getByRole('textbox', { name: '给 Misaka 发送任务' }) as HTMLTextAreaElement
  Object.defineProperty(editor, 'scrollHeight', { configurable: true, get: () => measuredHeight })

  view.rerender(<Composer presentation="multi" />)
  expect(editor.style.height).toBe('88px')
  expect(editor).toHaveValue('持久化的长草稿')

  view.rerender(<Composer presentation="default" />)
  expect(editor.style.height).toBe('146px')
  expect(screen.getByRole('textbox', { name: '给 Misaka 发送任务' })).toBe(editor)
})

it('sizes a restored draft when multi is the first presentation', () => {
  useSessionStore.setState({ draft: '恢复的多行研究草稿' })
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight')
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => 138 })
  try {
    render(<Composer presentation="multi" />)
    expect(screen.getByRole('textbox', { name: '给 Misaka 发送任务' })).toHaveStyle({ height: '88px' })
  } finally {
    if (descriptor) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', descriptor)
    else Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight')
  }
})

it('recomputes multi draft height only when the actual card width changes', () => {
  useSessionStore.setState({ draft: '保留选区的草稿' })
  let measuredHeight = 120
  let width = 720
  const view = render(<Composer presentation="multi" />)
  const editor = screen.getByRole('textbox', { name: '给 Misaka 发送任务' }) as HTMLTextAreaElement
  const form = editor.closest('form')!
  Object.defineProperty(editor, 'scrollHeight', { configurable: true, get: () => measuredHeight })
  Object.defineProperty(form, 'getBoundingClientRect', { configurable: true,
    value: () => ({ width, height: 87, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 87, toJSON: () => ({}) }) })
  editor.focus()
  editor.setSelectionRange(2, 4)

  measuredHeight = 57
  width = 380
  TestResizeObserver.resize(form)
  expect(editor.style.height).toBe('57px')
  expect(document.activeElement).toBe(editor)
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 4])

  measuredHeight = 76
  TestResizeObserver.resize(form)
  expect(editor.style.height).toBe('57px')
  expect(view.container.querySelectorAll('textarea')).toHaveLength(1)

  view.rerender(<Composer presentation="default" />)
  expect(TestResizeObserver.instances.every(observer => observer.target !== form)).toBe(true)
})

it('marks expanded pending stop for narrow multi layout while retaining each operation', () => {
  useSessionStore.setState({ agentMode: 'research', isStreaming: true, isAborting: true })
  render(<Composer presentation="multi" />)
  const stop = screen.getByRole('button', { name: '停止中' })
  const form = stop.closest('form')!

  expect(form).toHaveAttribute('data-composer-expanded-stop', 'true')
  expect(screen.getByRole('button', { name: '添加附件' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '研究模式' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '新研究' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '模型与思考深度' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '发送选项' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '干预当前运行 (Enter)' })).toBeInTheDocument()
  expect(stop).toHaveTextContent('停止中')
})

it('marks streaming send options for the narrow multi operations row', () => {
  useSessionStore.setState({ agentMode: 'research', isStreaming: true, isAborting: false })
  render(<Composer presentation="multi" />)
  const form = screen.getByRole('button', { name: '发送选项' }).closest('form')!
  expect(form).toHaveAttribute('data-composer-dense-operations', 'true')
  expect(form).not.toHaveAttribute('data-composer-expanded-stop')
  expect(screen.getByRole('button', { name: '新研究' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /中止生成/ })).toBeInTheDocument()
})

it('marks inline pending feedback for the narrow multi operations row', () => {
  useSessionStore.setState({ agentMode: 'research', isCompacting: true })
  render(<Composer presentation="multi" />)
  const form = screen.getByRole('status', { name: '' }).closest('form')!
  expect(form).toHaveAttribute('data-composer-dense-operations', 'true')
  expect(screen.getByRole('button', { name: '新研究' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '压缩中' })).toBeDisabled()
})
