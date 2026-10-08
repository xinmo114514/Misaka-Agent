export interface ResearchBridgeLaunch {
  cwd: string
  sessionFile?: string | null
}

export function researchBridgeArgs(input: ResearchBridgeLaunch): string[] {
  const args = ['run', 'misaka', 'desktop-bridge', '--cwd', input.cwd, '--research-context']
  if (input.sessionFile) args.push('--session', input.sessionFile)
  return args
}

/** The Python host creates its session on first launch; remember that concrete path for later controls. */
export function resolvedResearchBridgeLaunch(input: ResearchBridgeLaunch, sessionFile?: string | null): ResearchBridgeLaunch {
  return { cwd: input.cwd, sessionFile: sessionFile || input.sessionFile || null }
}

export function sameResearchBridge(active: ResearchBridgeLaunch | null, requested: ResearchBridgeLaunch): boolean {
  return Boolean(active && active.cwd === requested.cwd &&
    (active.sessionFile || null) === (requested.sessionFile || null))
}

export type ResearchCloseChoice = 'background' | 'stop' | 'cancel'
export type ResearchCloseOutcome = 'hide' | 'stop-and-quit' | 'stay-open'

export function researchCloseOutcome(choice: ResearchCloseChoice): ResearchCloseOutcome {
  if (choice === 'background') return 'hide'
  if (choice === 'stop') return 'stop-and-quit'
  return 'stay-open'
}
