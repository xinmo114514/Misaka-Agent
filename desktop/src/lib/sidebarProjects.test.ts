import { describe, expect, it } from 'vitest'
import { buildSidebarProjects } from './sidebarProjects'

describe('sidebar workspace projects', () => {
  it('deduplicates workspace aliases, retains empty folders, and orders sessions newest first', () => {
    const projects = buildSidebarProjects([
      { id: 'older', path: 'C:/repo/older.jsonl', cwd: 'C:/repo', name: 'Older', firstMessage: '',
        created: '2026-10-01', modified: '2026-10-05', messageCount: 1 },
      { id: 'newer', path: 'C:/repo/newer.jsonl', cwd: 'c:/REPO/', name: 'Newer', firstMessage: '',
        created: '2026-10-01', modified: '2026-10-06', messageCount: 1 },
    ], ['C:/Empty-project', 'c:/empty-project/'])

    expect(projects.map(project => project.name)).toEqual(['repo', 'Empty-project'])
    expect(projects[0].sessions.map(session => session.title)).toEqual(['Newer', 'Older'])
    expect(projects[1].sessions).toEqual([])
  })
})
