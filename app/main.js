// Chata Thu ngân – vỏ app Windows: mở trang bán hàng và in thẳng ra máy in (không hộp thoại)
const { app, BrowserWindow, ipcMain, shell, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_URL = 'https://taichata123.github.io/baihat/pos.html';
let win = null;

function config() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8')); } catch (e) { return {}; }
}
function startUrl() { return config().url || DEFAULT_URL; }

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

function offlinePage(err) {
  const html = '<!DOCTYPE html><meta charset="utf-8"><body style="font-family:Segoe UI,sans-serif;background:#2B3F5C;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
    '<div style="text-align:center"><h2>Chưa kết nối được máy chủ Chata</h2><p>Kiểm tra mạng Internet của máy quầy rồi bấm Thử lại.</p>' +
    '<p style="opacity:.6;font-size:13px">' + String(err || '').replace(/</g, '&lt;') + '</p>' +
    '<button onclick="location.href=\'' + startUrl() + '\'" style="font-size:18px;padding:12px 28px;border:none;border-radius:8px;background:#13C48A;color:#fff;cursor:pointer">Thử lại</button></div></body>';
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 768, show: false, title: 'Chata Thu ngân', backgroundColor: '#2B3F5C', autoHideMenuBar: true,
    icon: path.join(__dirname, 'chata.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  win.maximize(); win.show();
  win.loadURL(startUrl());
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) offlinePage(desc + ' (' + code + ')'); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5') { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
    if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  win.on('page-title-updated', (e) => { e.preventDefault(); });
  // Tự kiểm tra cập nhật giao diện mỗi sáng: tải lại khi máy để không lúc 5h
  setInterval(() => { const h = new Date().getHours(); if (h === 5 && win && !win.isFocused()) win.webContents.reloadIgnoringCache(); }, 3600000);
}

ipcMain.on('version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.on('title', (e, t) => { if (win && t) win.setTitle(t); });
ipcMain.handle('printers', async () => {
  const list = await win.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, isDefault: !!p.isDefault, status: p.status }));
});

// Hàng đợi in: in lần lượt từng lệnh
let queue = Promise.resolve();
ipcMain.handle('print', (e, job) => { const p = queue.then(() => doPrint(job)); queue = p.catch(() => {}); return p; });

function doPrint(job) {
  return new Promise((resolve) => {
    const w = Math.max(20, Number(job.widthMm) || 80);
    const pw = new BrowserWindow({ show: false, width: Math.round(w / 25.4 * 96) + 20, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: true, offscreen: false } });
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); setTimeout(() => { try { pw.destroy(); } catch (x) {} }, 500); };
    const timer = setTimeout(() => finish({ ok: false, error: 'Hết thời gian chờ máy in' }), 30000);
    pw.webContents.once('did-finish-load', async () => {
      try {
        let h = Number(job.heightMm) || 0;
        if (!h) {
          const px = await pw.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)');
          h = Math.max(30, Math.ceil(px * 25.4 / 96) + 4);
        }
        const opts = { silent: true, printBackground: true, copies: Math.max(1, Math.min(5, Number(job.copies) || 1)),
          margins: { marginType: 'none' }, pageSize: { width: Math.round(w * 1000), height: Math.round(h * 1000) } };
        if (job.printer) opts.deviceName = job.printer;
        pw.webContents.print(opts, (success, reason) => { clearTimeout(timer); finish(success ? { ok: true } : { ok: false, error: reason || 'Không in được' }); });
      } catch (err) { clearTimeout(timer); finish({ ok: false, error: String(err && err.message || err) }); }
    });
    pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(String(job.html || '')));
  });
}

app.whenReady().then(() => {
  try { if (!config().noAutoStart) app.setLoginItemSettings({ openAtLogin: true }); } catch (e) {}
  createWindow();
});
app.on('window-all-closed', () => app.quit());
