const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tunebox', {
  get: () => ipcRenderer.invoke('tb:settings-get'),
  set: (patch) => ipcRenderer.invoke('tb:settings-set', patch),
  openExternal: (url) => ipcRenderer.invoke('tb:open-external', url),
  clearData: () => ipcRenderer.invoke('tb:clear-data'),
  firefoxSignIn: () => ipcRenderer.invoke('tb:firefox-signin'),
  updateGet: () => ipcRenderer.invoke('tb:update-get'),
  updateCheck: () => ipcRenderer.invoke('tb:update-check'),
  updateInstall: () => ipcRenderer.send('tb:update-install'),
  onUpdate: (fn) => ipcRenderer.on('tb:update', (_e, s) => fn(s)),
});
