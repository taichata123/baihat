// Chata Thu ngân – vỏ app Windows: mở trang bán hàng và in thẳng ra máy in (không hộp thoại)
const { app, BrowserWindow, ipcMain, shell, Menu, globalShortcut, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_URL = 'https://taichata123.github.io/baihat/pos.html';
const UPDATE_BASE = process.env.CHATA_UPDATE_BASE || 'https://taichata123.github.io/baihat/app/';
const UPDATABLE = ['main.js', 'preload.js', 'package.json'];
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

function otherDisplay() {
  try { const p = screen.getPrimaryDisplay(); return screen.getAllDisplays().filter((d) => d.id !== p.id)[0] || null; } catch (e) { return null; }
}
ipcMain.on('displays', (e) => { try { e.returnValue = screen.getAllDisplays().length; } catch (x) { e.returnValue = 1; } });

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 768, show: false, title: 'Chata Thu ngân', backgroundColor: '#2B3F5C', autoHideMenuBar: true,
    icon: path.join(__dirname, 'chata.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  win.maximize(); win.show();
  win.loadURL(startUrl());
  win.webContents.once('did-finish-load', () => { try { fs.unlinkSync(path.join(__dirname, 'update.pending')); } catch (e) {} if (updateReady) win.webContents.send('update-ready', updateReady); });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) offlinePage(desc + ' (' + code + ')'); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    /* Màn hình khách (khach.html): mở trong app, toàn màn hình trên màn thứ hai nếu có (từ 1.2.0) */
    if (/^https:\/\/taichata123\.github\.io\/baihat\/khach\.html(\?|#|$)/.test(url)) {
      const ext = otherDisplay(), b = (ext || screen.getPrimaryDisplay()).workArea;
      return { action: 'allow', overrideBrowserWindowOptions: {
        x: b.x, y: b.y, width: ext ? b.width : Math.min(1280, b.width), height: ext ? b.height : Math.min(720, b.height),
        fullscreen: !!ext, focusable: !ext, autoHideMenuBar: true, title: 'Chata – Màn hình khách', backgroundColor: '#0D2F2D',
        icon: path.join(__dirname, 'chata.ico'),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } } };
    }
    if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.setMenu(null);
    child.on('page-title-updated', (e) => { e.preventDefault(); });
    child.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F11') { child.setFullScreen(!child.isFullScreen()); e.preventDefault(); }
      if (input.key === 'F5') { child.webContents.reloadIgnoringCache(); e.preventDefault(); }
    });
    /* trả bàn phím về màn thu ngân */
    setTimeout(() => { if (win && !win.isDestroyed()) win.focus(); }, 400);
  });
  win.on('closed', () => { for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (e) {} } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5') { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
    if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });
  win.on('page-title-updated', (e) => { e.preventDefault(); });
  // Tự kiểm tra cập nhật giao diện mỗi sáng: tải lại khi máy để không lúc 5h
  // Mỗi giờ: 5h sáng tải lại giao diện (và khởi động lại nếu có bản app mới); cứ 3 giờ kiểm tra cập nhật app
  setInterval(() => {
    const h = new Date().getHours();
    if (h === 5 && win && !win.isFocused()) { if (updateReady) return restartApp(); win.webContents.reloadIgnoringCache(); }
    if (h % 3 === 0) checkUpdate().catch(() => {});
  }, 3600000);
}

/* ===== Tự cập nhật vỏ app =====
   app/version.json trên GitHub: { "version": "1.1.0", "files": { "main.js": "<sha256>", ... } }
   Tải từng tệp, kiểm sha256 đủ cả mới ghi; giữ bản cũ ở thư mục prev để boot.js quay lại nếu lỗi. */
let updateReady = null;
function newer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; }
  return false;
}
async function getBuf(url, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 20000);
  try {
    const r = await fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally { clearTimeout(t); }
}
let checking = null;
function checkUpdate(ms) {
  if (checking) return checking;
  checking = (async () => {
    if (updateReady) return updateReady;
    const info = JSON.parse((await getBuf(UPDATE_BASE + 'version.json', ms)).toString('utf8'));
    if (!info || !info.version || !info.files || !newer(info.version, app.getVersion())) return null;
    let failed = ''; try { failed = fs.readFileSync(path.join(__dirname, 'update.failed'), 'utf8').trim(); } catch (e) {}
    if (failed && failed === String(info.version)) return null; // bản này từng lỗi, bỏ qua
    const got = {};
    for (const name of Object.keys(info.files)) {
      if (UPDATABLE.indexOf(name) < 0) continue;
      const buf = await getBuf(UPDATE_BASE + name, ms);
      const sum = crypto.createHash('sha256').update(buf).digest('hex');
      if (sum !== String(info.files[name]).toLowerCase()) throw new Error('Sai mã kiểm tra ' + name);
      got[name] = buf;
    }
    if (!got['main.js'] && !got['package.json']) return null;
    const D = __dirname, prev = path.join(D, 'prev');
    fs.mkdirSync(prev, { recursive: true });
    for (const name of UPDATABLE) { const f = path.join(D, name); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(prev, name)); }
    for (const name of Object.keys(got)) { const tmp = path.join(D, name + '.new'); fs.writeFileSync(tmp, got[name]); fs.renameSync(tmp, path.join(D, name)); }
    fs.writeFileSync(path.join(D, 'update.pending'), '0');
    updateReady = info.version;
    if (win && !win.isDestroyed()) win.webContents.send('update-ready', updateReady);
    return updateReady;
  })().finally(() => { checking = null; });
  return checking;
}
function restartApp() { app.relaunch(); app.exit(0); }
ipcMain.on('restart', () => { if (updateReady) restartApp(); });

ipcMain.on('version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.on('update-state', (e) => { e.returnValue = updateReady || ''; });
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

app.whenReady().then(async () => {
  try { if (!config().noAutoStart) app.setLoginItemSettings({ openAtLogin: true }); } catch (e) {}
  // Lúc mở app: kiểm tra nhanh bản mới (tối đa ~6 giây), có thì khởi động lại ngay bằng bản mới
  try { if (await Promise.race([checkUpdate(5000), new Promise((r) => setTimeout(() => r(null), 6000))])) return restartApp(); } catch (e) {}
  createWindow();
});
app.on('window-all-closed', () => app.quit());
