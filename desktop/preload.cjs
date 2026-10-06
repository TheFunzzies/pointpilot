const { contextBridge, ipcRenderer } = require('electron');

const subscribe = channel => callback => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('pointpilot', {
  openProvider: (providerId, url) => ipcRenderer.invoke('open-provider', { providerId, url }),
  appInfo: () => ipcRenderer.invoke('app-info'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  settingsChanged: () => ipcRenderer.invoke('settings-changed'),
  onUpdateStatus: subscribe('update-status'),
  onNavigate: subscribe('navigate')
});
