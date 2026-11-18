// Chata Thu ngân – khởi động an toàn: nếu bản cập nhật mới lỗi thì tự quay về bản trước
const fs = require('fs');
const path = require('path');
const D = __dirname;
const PREV = path.join(D, 'prev');
const FLAG = path.join(D, 'update.pending');

function rollback() {
  try {
    if (!fs.existsSync(PREV)) return false;
    let bad = '';
    try { bad = JSON.parse(fs.readFileSync(path.join(D, 'package.json'), 'utf8')).version || ''; } catch (e) {}
    for (const f of fs.readdirSync(PREV)) fs.copyFileSync(path.join(PREV, f), path.join(D, f));
    try { fs.unlinkSync(FLAG); } catch (e) {}
    try { fs.writeFileSync(path.join(D, 'update.failed'), String(bad)); } catch (e) {}
    try { require('electron').app.setVersion(JSON.parse(fs.readFileSync(path.join(D, 'package.json'), 'utf8')).version); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

// Bản mới đã khởi động 2 lần mà chưa mở được trang bán hàng -> quay lại bản trước
if (fs.existsSync(FLAG)) {
  let n = 0;
  try { n = Number(fs.readFileSync(FLAG, 'utf8')) || 0; } catch (e) {}
  if (n >= 2) rollback(); else try { fs.writeFileSync(FLAG, String(n + 1)); } catch (e) {}
}

try {
  require('./main.js');
} catch (err) {
  if (rollback()) {
    for (const k of Object.keys(require.cache)) if (k.indexOf(D) === 0 && !/boot\.js$/.test(k)) delete require.cache[k];
    require('./main.js');
  } else {
    throw err;
  }
}
