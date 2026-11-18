const { contextBridge, ipcRenderer } = require('electron');
const ALLOWED = ['https://taichata123.github.io'];
if (ALLOWED.indexOf(location.origin) >= 0 || location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('chataNative', {
    version: ipcRenderer.sendSync('version'),
    printers: () => ipcRenderer.invoke('printers'),
    print: (job) => ipcRenderer.invoke('print', job),
    setTitle: (t) => ipcRenderer.send('title', String(t || ''))
  });
}
