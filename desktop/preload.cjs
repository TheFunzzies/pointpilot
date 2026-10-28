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
  llmStatus: () => ipcRenderer.invoke('llm-status'),
  llmOpenAiSignIn: () => ipcRenderer.invoke('llm-openai-sign-in'),
  llmOpenAiDisconnect: () => ipcRenderer.invoke('llm-openai-disconnect'),
  llmSaveClaudeKey: apiKey => ipcRenderer.invoke('llm-save-claude-key', apiKey),
  llmRemoveClaudeKey: () => ipcRenderer.invoke('llm-remove-claude-key'),
  llmAsk: request => ipcRenderer.invoke('llm-ask', request),
  // Restricted file access: no paths in or out. kind is 'backup' or 'diagnostics'; content is the JSON text.
  saveArtifact: ({ kind, content } = {}) => ipcRenderer.invoke('save-artifact', { kind, content }),
  openBackup: () => ipcRenderer.invoke('open-backup'),
  onUpdateStatus: subscribe('update-status'),
  onNavigate: subscribe('navigate')
});
