import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('bridge', {
  send: (cmd: unknown) => {
    ipcRenderer.send('bridge:send', cmd)
  },
  on: (handler: (event: any) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => {
      handler(data)
    }
    ipcRenderer.on('bridge:event', listener)
    return () => {
      ipcRenderer.removeListener('bridge:event', listener)
    }
  },
})

contextBridge.exposeInMainWorld('researchBridge', {
  send: (command: unknown) => ipcRenderer.send('research:send', command),
  on: (handler: (event: any) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => handler(data)
    ipcRenderer.on('research:event', listener)
    return () => ipcRenderer.removeListener('research:event', listener)
  },
})

contextBridge.exposeInMainWorld('theme', {
  onChange: (handler: (themeData: any) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: any) => {
      handler(data)
    }
    ipcRenderer.on('theme:change', listener)
    return () => {
      ipcRenderer.removeListener('theme:change', listener)
    }
  },
  getTheme: (name?: string) => ipcRenderer.invoke('theme:get', name),
  setTheme: (name: string) => ipcRenderer.invoke('theme:set', name),
  listThemes: () => ipcRenderer.invoke('theme:list'),
})

contextBridge.exposeInMainWorld('app', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  pickDirectory: () => ipcRenderer.invoke('app:pick-directory'),
  pickFiles: () => ipcRenderer.invoke('app:pick-files'),
  openPath: (targetPath: string) => ipcRenderer.invoke('app:open-path', targetPath),
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke('app:show-item-in-folder', targetPath),
  startResearchBridge: (input: { cwd: string; sessionFile?: string | null }) =>
    ipcRenderer.invoke('app:start-research-bridge', input),  setResearchActive: (state: boolean | { active: boolean; pendingCount: number }) =>
    ipcRenderer.send('app:research-state', state),
  onRequestClose: (handler: () => void) => {
    const listener = () => handler()
    ipcRenderer.on('app:request-close', listener)
    return () => ipcRenderer.removeListener('app:request-close', listener)
  },
  confirmClose: (action: 'tray' | 'quit') => ipcRenderer.invoke('app:confirm-close', action),
})
