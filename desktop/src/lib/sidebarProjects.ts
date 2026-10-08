import type { SessionInfoOut, SessionRow } from '../types/session'
import { normalizeWorkspacePath, projectNameForCwd } from '../store/useSessionStore'

export interface SidebarProject {
  id: string
  path: string
  name: string
  sessions: SessionRow[]
}

/** Combines session-backed projects with recently used folders, retaining empty workspaces. */
export function buildSidebarProjects(sessions: SessionInfoOut[], workspacePaths: string[]): SidebarProject[] {
  const byPath = new Map<string, SidebarProject>()
  const order = new Map<string, number>()
  let nextOrder = 0

  const ensureProject = (path: string): SidebarProject => {
    const normalized = normalizeWorkspacePath(path)
    const key = normalized || '__ungrouped__'
    const existing = byPath.get(key)
    if (existing) return existing
    const project: SidebarProject = {
      id: path || 'ungrouped',
      path,
      name: projectNameForCwd(path),
      sessions: [],
    }
    byPath.set(key, project)
    order.set(key, nextOrder++)
    return project
  }

  for (const path of workspacePaths) {
    if (path?.trim()) ensureProject(path.trim())
  }

  for (const session of sessions) {
    const project = ensureProject(session.cwd || '')
    const title = (session.name || '').trim()
      || ((session.firstMessage || '').trim() && session.firstMessage !== '(no messages)'
        ? (session.firstMessage.length > 60 ? `${session.firstMessage.slice(0, 60)}…` : session.firstMessage)
        : '新对话')
    project.sessions.push({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      title,
      modified: session.modified,
      messageCount: session.messageCount,
    })
  }

  for (const project of byPath.values()) {
    project.sessions.sort((a, b) => b.modified.localeCompare(a.modified))
  }

  return [...byPath.entries()].sort(([aKey, a], [bKey, b]) => {
    const aLatest = a.sessions[0]?.modified || ''
    const bLatest = b.sessions[0]?.modified || ''
    if (aLatest !== bLatest) return bLatest.localeCompare(aLatest)
    return (order.get(aKey) ?? Number.MAX_SAFE_INTEGER) - (order.get(bKey) ?? Number.MAX_SAFE_INTEGER)
  }).map(([, project]) => project)
}
