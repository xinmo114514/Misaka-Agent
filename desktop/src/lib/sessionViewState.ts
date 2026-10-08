import { useEffect, useState } from 'react'
import { useSessionStore } from '../store/useSessionStore'

export interface ReadingPosition {
  scrollTop: number
  following: boolean
  anchor?: { messageId: string; entryId?: string; landmark: number; offset: number }
}
interface SessionView { reading?: ReadingPosition; disclosures: Map<string, boolean>; heights: Map<string, number> }
const views = new Map<string, SessionView>()

function view(path: string): SessionView {
  const existing = views.get(path) ?? { disclosures: new Map<string, boolean>(), heights: new Map<string, number>() }
  views.delete(path)
  views.set(path, existing)
  while (views.size > 8) views.delete(views.keys().next().value!)
  return existing
}
export function readPosition(path: string): ReadingPosition | undefined { return view(path).reading }
export function savePosition(path: string, reading: ReadingPosition): void { view(path).reading = reading }
export function forgetSessionView(path: string): void { views.delete(path) }
export function clearSessionViewsExcept(currentPath: string | null): void {
  for (const path of views.keys()) {
    if (path !== currentPath) views.delete(path)
  }
}
export function messageHeights(path: string): Map<string, number> { return view(path).heights }

export function migrateEntryDisclosures(path: string, liveId: string, entryId: string): void {
  if (!path || !liveId || !entryId) return
  const v = view(path)
  for (const [key, value] of Array.from(v.disclosures.entries())) {
    if (key.includes(liveId)) {
      const newKey = key.split(liveId).join(entryId)
      v.disclosures.set(newKey, value)
    }
  }
  if (v.reading?.anchor?.messageId === liveId) {
    v.reading.anchor.messageId = entryId
    v.reading.anchor.entryId = entryId
  }
}

/** Manual choices outlive DOM rows. Defaults (such as streaming thinking) stay live. */
export function useDisclosure(key: string): [boolean | null, (expanded: boolean) => void] {
  const path = useSessionStore(state => state.currentSessionPath)
  const [choice, setChoice] = useState(() => ({ path, key, value: path ? view(path).disclosures.get(key) ?? null : null }))
  const manual = choice.path === path ? choice.value : path ? view(path).disclosures.get(key) ?? null : null
  // A live message acquires its durable entryId without remounting. Migrate the
  // manual choice to that identity before virtual rows are replaced by history.
  useEffect(() => {
    if (choice.path === path && choice.key === key) return
    if (path && manual !== null) {
      const choices = view(path).disclosures
      choices.set(key, manual)
      while (choices.size > 1000) choices.delete(choices.keys().next().value!)
    }
    setChoice({ path, key, value: manual })
  }, [path, key, manual, choice.path, choice.key])
  const setExpanded = (expanded: boolean) => {
    if (path) {
      const choices = view(path).disclosures
      choices.delete(key)
      choices.set(key, expanded)
      while (choices.size > 1000) choices.delete(choices.keys().next().value!)
    }
    setChoice({ path, key, value: expanded })
  }
  return [manual, setExpanded]
}
