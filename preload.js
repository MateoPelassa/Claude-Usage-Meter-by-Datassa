const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  get: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  size: (s) => ipcRenderer.invoke('win:size', s),
  openUsage: () => ipcRenderer.invoke('open:usage'),
  hide: () => ipcRenderer.invoke('app:hide'),
  login: () => ipcRenderer.invoke('auth:login'),
  onUsage: (fn) => ipcRenderer.on('usage', (_e, u) => fn(u)),
  onSettings: (fn) => ipcRenderer.on('settings', (_e, s) => fn(s)),
  getLang: () => ipcRenderer.invoke('lang:get'),
  getLinks: () => ipcRenderer.invoke('links:get'),
  openLink: (key) => ipcRenderer.invoke('links:open', key),
  getAuto: () => ipcRenderer.invoke('auto:get'),
  scanAuto: () => ipcRenderer.invoke('auto:scan'),
  setAuto: (patch) => ipcRenderer.invoke('auto:set', patch),
  cancelShutdown: () => ipcRenderer.invoke('auto:cancel-shutdown'),
  onAuto: (fn) => ipcRenderer.on('auto', (_e, a) => fn(a)),
});
