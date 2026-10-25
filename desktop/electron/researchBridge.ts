export interface ResearchBridgeLaunch {
  cwd: string
  sessionFile?: string | null
}

/** User-selected routing belongs to the request; launching a bridge must not rewrite it. */
export function bridgeEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...parent, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }
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
