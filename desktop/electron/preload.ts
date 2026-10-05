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
})

contextBridge.exposeInMainWorld('app', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  pickDirectory: () => ipcRenderer.invoke('app:pick-directory'),
  openPath: (targetPath: string) => ipcRenderer.invoke('app:open-path', targetPath),
  showItemInFolder: (targetPath: string) => ipcRenderer.invoke('app:show-item-in-folder', targetPath),
})
