const { contextBridge, ipcRenderer } = require('electron');
const ALLOWED = ['https://taichata123.github.io', 'https://chata-checklist.web.app'];
if (ALLOWED.indexOf(location.origin) >= 0 || location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('chataNative', {
    version: ipcRenderer.sendSync('version'),
    displays: () => ipcRenderer.sendSync('displays'),
    printers: () => ipcRenderer.invoke('printers'),
    print: (job) => ipcRenderer.invoke('print', job),
    setTitle: (t) => ipcRenderer.send('title', String(t || '')),
    updateReady: () => ipcRenderer.sendSync('update-state'),
    onUpdate: (cb) => ipcRenderer.on('update-ready', (e, v) => { try { cb(String(v)); } catch (x) {} }),
    restart: () => ipcRenderer.send('restart'),
    refocus: (hard) => ipcRenderer.send('refocus', !!hard)
  });
}
