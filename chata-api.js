/* Chata – máy chủ bán hàng, gọi món QR, đăng ký bài hát trên Firebase (Firestore, dự án chata-checklist).
   Thay cho Apps Script: các trang gọi ChataAPI.call(tên hàm, [tham số]) giống hệt trước đây.
   Dữ liệu: config/pos, posMenu/{normal,night}, posOrders, posCounters, posShifts, songReq, songFb, posBookings. */
(function () {
  'use strict';
  var CFG = { apiKey: 'AIzaSyCFiq2ErjvnmPplyF1_A7GPsfx7dvFn3WU', authDomain: 'chata-checklist.firebaseapp.com', projectId: 'chata-checklist',
    storageBucket: 'chata-checklist.firebasestorage.app', messagingSenderId: '29868386580', appId: '1:29868386580:web:8e95949c92b1a962537a01' };
  var FN = 'https://asia-southeast1-chata-checklist.cloudfunctions.net/';
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var TZ = 'Asia/Ho_Chi_Minh';
  var POS_ROLES = ['Pha chế', 'Thu ngân', 'Quản lý'];
  var ORD_MODES = ['Tự động', 'Đêm nhạc', 'Thường'];
  var STATUSES = ['Chờ', 'Đang phát', 'Đã phát', 'Bỏ qua'];
  var BK_AREAS = ['Không yêu cầu', 'Gần sân khấu', 'Xa loa, yên tĩnh', 'Ngoài trời'];
  var BK_STATUSES = ['Chờ xác nhận', 'Đã xác nhận', 'Đã hủy', 'Đã đến'];
  var MAX_QUEUE = 30;
  var SES_KEY = 'chata_fb_pos';

  var db = null, auth = null, listeners = [], subs = {}, unsubs = {};
  var C = { cfg: null, menu: { normal: null, night: null }, orders: null, pend: null, paid: null, keep: {}, shifts: null, songs: null, fb: null, bk: null };

  function loadJs(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error('Không tải được thư viện, kiểm tra mạng.')); }; document.head.appendChild(s);
    });
  }
  var ready = (window.firebase && firebase.firestore ? Promise.resolve() : loadJs(SDK + 'firebase-app-compat.js')
    .then(function () { return Promise.all([loadJs(SDK + 'firebase-auth-compat.js'), loadJs(SDK + 'firebase-firestore-compat.js')]); }))
    .then(function () {
      var app = firebase.apps.filter(function (a) { return a.name === 'chata'; })[0] || firebase.initializeApp(CFG, 'chata');
      auth = app.auth(); db = app.firestore();
      try { db.settings({ cacheSizeBytes: 40 * 1048576, ignoreUndefinedProperties: true, merge: true }); } catch (e) {}
      return db.enablePersistence({ synchronizeTabs: true }).catch(function () {});
    })
    .then(function () {
      return new Promise(function (res) { var off = auth.onAuthStateChanged(function (u) { off(); res(u); }); });
    })
    .then(function (u) { if (!u) return auth.signInAnonymously(); });

  /* ---------- tiện ích ---------- */
  function ymdOf(t) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); }
  function today() { return ymdOf(Date.now()); }
  function vnParts(t) {
    var p = {}; new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date(t))
      .forEach(function (x) { p[x.type] = x.value; });
    return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour) % 24 };
  }
  function startOfDay(t) { var d = ymdOf(t || Date.now()); return new Date(d + 'T00:00:00+07:00').getTime(); }
  function hhOf(t) { return ('0' + vnParts(t).hour).slice(-2); }
  function clean(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max); }
  function norm(s) { return String(s || '').trim().toLowerCase(); }
  function uid(p) { var a = new Uint8Array(6); crypto.getRandomValues(a); return p + Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('').toUpperCase(); }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function phoneOf(s) { var p = String(s || '').replace(/[^\d+ ]/g, '').trim().slice(0, 15), dg = p.replace(/\D/g, ''); if (p && (dg.length < 9 || dg.length > 12)) return null; return p; }
  function sha256(s) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))).then(function (b) {
      return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    });
  }
  function emit() { listeners.forEach(function (f) { try { f(); } catch (e) {} }); }
  function withTimeout(p, ms, msg) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error(msg || 'timeout')); }, ms); })]); }

  /* ---------- theo dõi dữ liệu (realtime) ---------- */
  function watch(key, ref, onData) {
    if (subs[key]) return subs[key];
    subs[key] = new Promise(function (res) {
      var first = true;
      unsubs[key] = ref.onSnapshot({ includeMetadataChanges: false }, function (s) { onData(s); if (first) { first = false; res(); } emit(); },
        function (e) { console.error(key, e); delete subs[key]; delete unsubs[key]; if (first) { first = false; res(); } });
    });
    return subs[key];
  }
  // Đổi người đăng nhập (quyền khác nhau) → bỏ các kết nối cũ, lần sau tự nối lại
  function resetSubs() {
    Object.keys(unsubs).forEach(function (k) { try { unsubs[k](); } catch (e) {} });
    subs = {}; unsubs = {}; C.orders = C.pend = C.paid = C.shifts = null; C.keep = {}; C.songs = C.fb = C.bk = null; C.rev = null;
  }
  function wantCfg() {
    return ready.then(function () {
      return Promise.all([
        watch('cfg', db.doc('config/pos'), function (s) { C.cfg = s.exists ? s.data() : {}; }),
        watch('mN', db.doc('posMenu/normal'), function (s) { C.menu.normal = s.exists ? (s.data().items || []) : []; }),
        watch('mT', db.doc('posMenu/night'), function (s) { C.menu.night = s.exists ? (s.data().items || []) : []; })
      ]);
    });
  }
  function wantOrders() {
    return ready.then(function () {
      return Promise.all([
        watch('ord', db.collection('posOrders').where('created', '>=', Date.now() - 36 * 3600000), function (s) {
          var m = {}; s.forEach(function (d) { m[d.id] = Object.assign({ id: d.id }, d.data()); }); C.orders = m;
        }),
        // đơn thu tiền gần đây (kể cả đơn ghi sổ tạo từ lâu) để tính đúng ca và tab Đã thanh toán
        watch('paid', db.collection('posOrders').where('paidAt', '>=', Date.now() - 36 * 3600000), function (s) {
          var m = {}; s.forEach(function (d) { m[d.id] = Object.assign({ id: d.id }, d.data()); }); C.paid = m;
        }),
        // mọi đơn chưa thu, kể cả đơn cũ hơn 36 giờ
        watch('pend', db.collection('posOrders').where('status', '==', 'Chờ thanh toán'), function (s) {
          var m = {}; s.forEach(function (d) { m[d.id] = Object.assign({ id: d.id }, d.data()); }); C.pend = m;
        }),
        // đơn khách về chưa trả (Tài 21/11) – giữ tới khi khách quay lại thu
        watch('debt', db.collection('posOrders').where('status', '==', 'Chưa thu'), function (s) {
          var m = {}; s.forEach(function (d) { m[d.id] = Object.assign({ id: d.id }, d.data()); }); C.debt = m;
        })
      ]);
    });
  }
  function wantShifts() {
    return ready.then(function () {
      return watch('sh', db.collection('posShifts').where('status', '==', 'Đang mở'), function (s) {
        var a = []; s.forEach(function (d) { a.push(Object.assign({ id: d.id }, d.data())); }); C.shifts = a;
      });
    });
  }
  function wantSongs() {
    return ready.then(function () {
      return watch('song', db.collection('songReq').where('time', '>=', startOfDay() - 2 * 86400000), function (s) {
        var a = []; s.forEach(function (d) { a.push(Object.assign({ id: d.id }, d.data())); });
        C.songs = a.sort(function (x, y) { return x.time - y.time; });
      });
    });
  }
  function wantAdmin() {
    return ready.then(function () {
      return Promise.all([
        watch('fb', db.collection('songFb').where('time', '>=', startOfDay()), function (s) {
          var a = []; s.forEach(function (d) { a.push(Object.assign({ id: d.id }, d.data())); }); C.fb = a.sort(function (x, y) { return x.time - y.time; });
        }),
        watch('bk', db.collection('posBookings').where('date', '>=', today()), function (s) {
          var a = []; s.forEach(function (d) { a.push(Object.assign({ id: d.id }, d.data())); }); C.bk = a;
        })
      ]);
    });
  }

  /* ---------- menu ---------- */
  function cfg() { return C.cfg || {}; }
  function modeSetting() { var v = cfg().mode; return ORD_MODES.indexOf(v) >= 0 ? v : 'Tự động'; }
  function orderOpen() { return cfg().qrOpen !== false; }
  function orderMode() {
    var s = modeSetting(); if (s === 'Đêm nhạc') return 'night'; if (s === 'Thường') return 'normal';
    var p = vnParts(Date.now()); return p.dow === 2 && p.hour >= 16 ? 'night' : 'normal';
  }
  /* Trường thêm của món (19/11/2026): dg nhóm hiển thị, b tên ô, s size/loại, img ảnh, vid mã biến thể Sapo (định lượng), r số bán, nq không hiện ở trang gọi món QR */
  var XF = ['dg', 'b', 's', 'img', 'vid', 'r', 'nq'];
  function menuList(k) {
    return (C.menu[k] || []).filter(function (m) { return m && m.n && Number(m.p) > 0 && m.on !== false; })
      .map(function (m) { var o = { g: String(m.g || 'Khác'), n: String(m.n).trim(), p: Number(m.p) }; XF.forEach(function (k) { if (m[k] != null && m[k] !== '') o[k] = m[k]; }); return o; });
  }
  function menuFor(mode) { return menuList(mode === 'night' ? 'night' : 'normal'); }
  function defTables() { var t = []; for (var i = 1; i <= 20; i++) t.push(String(i)); return [{ a: 'Thẻ rung', t: t }]; }
  function cleanTables(v) {
    try { if (typeof v === 'string') v = JSON.parse(v); } catch (e) { return defTables(); }
    if (!Array.isArray(v)) return defTables();
    var seen = {};
    var out = v.slice(0, 12).map(function (z) {
      var a = String((z && z.a) || 'Khu').trim().slice(0, 24) || 'Khu';
      var t = (Array.isArray(z && z.t) ? z.t : []).map(function (x) { return String(x).trim().slice(0, 10); })
        .filter(function (x) { if (!x || seen[x]) return false; seen[x] = 1; return true; }).slice(0, 150);
      return { a: a, t: t };
    }).filter(function (z) { return z.t.length; });
    return out.length ? out : defTables();
  }
  // Giảm giá món: dt '%' (phần trăm) hoặc 'đ' (số tiền giảm mỗi món), dv = giá trị
  function lineDisc(o) {
    var v = Number(o.dv) || 0; if (!o.dt || v <= 0) return 0;
    var g = o.p * o.q; return Math.min(g, o.dt === '%' ? Math.round(g * Math.min(v, 100) / 100) : Math.round(v) * o.q);
  }
  /* Món thêm (topping) theo nhóm Sapo – Tài 20/11/2026: config/pos.addons = [{ n: tên nhóm, m: biểu thức tên món, o: [{ n, p }] }]
     Dòng món có món thêm: ad = [{ n, p, q }] (q = số lượng mỗi món), p = giá món + món thêm, p0 = giá món gốc */
  function addonsCfg() { var v = cfg().addons; return (Array.isArray(v) ? v : []).filter(function (s) { return s && s.m && Array.isArray(s.o); }).map(function (s) { return { n: clean(s.n, 60), m: String(s.m).slice(0, 120), o: s.o.filter(function (o) { return o && o.n && Number(o.p) >= 0; }).map(function (o) { return { n: clean(o.n, 40), p: Math.round(Number(o.p)) }; }) }; }); }
  function addonsFor(n) { var L = []; addonsCfg().forEach(function (s) { var re; try { re = new RegExp(s.m, 'i'); } catch (e) { return; } if (re.test(n)) s.o.forEach(function (o) { if (!L.some(function (x) { return x.n === o.n; })) L.push(o); }); }); return L; }
  function cleanAd(ad, n) {
    var av = addonsFor(n), out = [];
    (Array.isArray(ad) ? ad : []).forEach(function (a) { var o = av.filter(function (x) { return x.n === String(a && a.n || ''); })[0], q = Math.round(Number(a && a.q) || 0); if (!o || q < 1) return;
      var ex = out.filter(function (x) { return x.n === o.n; })[0]; if (ex) ex.q = Math.min(10, ex.q + q); else out.push({ n: o.n, p: o.p, q: Math.min(10, q) }); });
    return out.sort(function (a, b) { return av.indexOf(av.filter(function (x) { return x.n === a.n; })[0]) - av.indexOf(av.filter(function (x) { return x.n === b.n; })[0]); });
  }
  function adText(ad) { return (ad || []).map(function (a) { return '+ ' + (a.q > 1 ? a.q + ' ' : '') + a.n; }).join(', '); }
  function lines(items, menu, extra) {
    var price = {};
    (extra || []).forEach(function (x) { price[x.n] = { g: x.g || '', p: x.p0 != null ? x.p0 : x.p, vid: x.vid }; });
    menu.forEach(function (m) { if (!price[m.n]) price[m.n] = { g: m.g, p: m.p, vid: m.vid }; else if (!price[m.n].vid && m.vid) price[m.n].vid = m.vid; });
    var out = [], total = 0, gross = 0, idisc = 0;
    (Array.isArray(items) ? items : []).slice(0, 60).forEach(function (it) {
      var n = String(it && it.n || ''), q = Math.round(Number(it && it.q) || 0), m = price[n], t = clean(it && it.t, 60);
      var dt = it && (it.dt === '%' || it.dt === 'đ') ? it.dt : '', dv = dt ? Math.max(0, Number(it.dv) || 0) : 0; if (!dv) dt = '';
      if (!m || q < 1 || q > 50) return;
      var ad = cleanAd(it && it.ad, n), ak = adText(ad), adp = ad.reduce(function (s, a) { return s + a.p * a.q; }, 0);
      var ex = out.filter(function (o) { return o.n === n && (o.t || '') === t && (o.dt || '') === dt && (o.dv || 0) === dv && adText(o.ad) === ak; })[0];
      if (ex) ex.q = Math.min(50, ex.q + q);
      else { var L = { n: n, g: m.g, p: m.p + adp, q: q }; if (ad.length) { L.ad = ad; L.p0 = m.p; } if (m.vid) L.vid = m.vid; if (t) L.t = t; if (dt) { L.dt = dt; L.dv = dv; } out.push(L); }
    });
    out.forEach(function (o) { var da = lineDisc(o); if (da) o.da = da; else delete o.da; gross += o.p * o.q; idisc += da; });
    total = gross - idisc;
    return { items: out, total: total, gross: gross, idisc: idisc };
  }
  // Giảm giá cả đơn: { t: '%'|'đ', v, r: lý do, promo: tên chương trình, by }
  function applyDisc(L, d) {
    var sub = L.total, od = null, amt = 0;
    if (d && (d.t === '%' || d.t === 'đ') && Number(d.v) > 0) {
      var v = Number(d.v); amt = Math.min(sub, d.t === '%' ? Math.round(sub * Math.min(v, 100) / 100) : Math.round(v));
      od = { t: d.t, v: v, amt: amt, r: clean(d.r, 80), promo: clean(d.promo, 60), by: clean(d.by, 60) };
    }
    return { gross: L.gross, itemDisc: L.idisc, disc: od, discAmt: L.idisc + amt, total: sub - amt };
  }
  // Báo bếp: chỉ in phần món mới so với lần báo trước (sent = [{k: tên|ghi chú, q}])
  function kKey(i) { return i.n + '|' + (i.t || '') + (i.ad && i.ad.length ? '|' + adText(i.ad) : ''); }
  function kitchenDelta(items, sent) {
    var had = {}, cur = {}, out = [], left = {};
    (Array.isArray(sent) ? sent : []).forEach(function (x) { had[x.k] = (had[x.k] || 0) + (Number(x.q) || 0); });
    items.forEach(function (i) { var k = kKey(i); cur[k] = (cur[k] || 0) + i.q; });
    Object.keys(cur).forEach(function (k) { left[k] = Math.max(0, cur[k] - (had[k] || 0)); });
    items.forEach(function (i) {
      var k = kKey(i), take = Math.min(i.q, left[k] || 0); if (take < 1) return; left[k] -= take;
      var x = { n: i.n, g: i.g, p: i.p, q: take }; if (i.t) x.t = i.t; if (i.ad && i.ad.length) { x.ad = i.ad; x.p0 = i.p0; } out.push(x);
    });
    return { items: out, sent: Object.keys(cur).map(function (k) { return { k: k, q: cur[k] }; }) };
  }
  // Đơn QR do khách gửi: giá luôn lấy theo menu, không tin giá ghi trong đơn
  function inMenu(menu, n) { return menu.some(function (m) { return m.n === n; }); }
  function qrMenu(o) { return menuFor(o.mode === 'Đêm nhạc' ? 'night' : 'normal').concat(menuFor(orderMode())); }
  function priceExtra(o, menu) { return o.src === 'Quầy' ? o.items : (o.items || []).filter(function (i) { return !inMenu(menu, i.n); }); }
  function fixQR(o) {
    if (o.src === 'Quầy') return o;
    var menu = qrMenu(o), L = lines(o.items, menu, priceExtra(o, menu)), A = applyDisc(L, o.disc);
    return Object.assign({}, o, { items: L.items, total: A.total, gross: A.gross, discAmt: A.discAmt });
  }
  function cleanPromos(v) {
    try { if (typeof v === 'string') v = JSON.parse(v); } catch (e) { return []; }
    return (Array.isArray(v) ? v : []).slice(0, 20).map(function (x) {
      return { n: clean(x && x.n, 60), t: x && x.t === 'đ' ? 'đ' : '%', v: Math.max(0, Number(x && x.v) || 0) };
    }).filter(function (x) { return x.n && x.v > 0 && (x.t === 'đ' || x.v <= 100); });
  }

  /* Sự kiện sắp diễn ra (Tài 19/11): hiện ở trang QR (đầu menu + phiếu chờ món). w = thứ (0 CN … 6 T7) lặp hằng tuần, hoặc d = ngày YYYY-MM-DD */
  var EV_DEF = [{ n: 'Đêm nhạc Chata', w: 2, h: '19:30', s: 'Lên hát cùng ban nhạc, gửi bài hát, đặt bàn trước', u: 'index.html' }];
  function cleanEvents(v) {
    try { if (typeof v === 'string') v = JSON.parse(v); } catch (e) { return []; }
    return (Array.isArray(v) ? v : []).slice(0, 10).map(function (x) {
      x = x || {}; var e = { n: clean(x.n, 60), h: /^\d{1,2}:\d{2}$/.test(String(x.h || '')) ? String(x.h) : '', s: clean(x.s, 100), u: /^(https:\/\/|[\w-]+\.html)/.test(String(x.u || '')) ? clean(x.u, 200) : '' };
      if (x.w !== undefined && x.w !== '' && +x.w >= 0 && +x.w <= 6) e.w = +x.w; else if (/^\d{4}-\d{2}-\d{2}$/.test(String(x.d || ''))) e.d = String(x.d); else return null;
      return e.n ? e : null;
    }).filter(Boolean);
  }
  function eventsCfg() { var c = cfg(); return c.events === undefined ? EV_DEF : cleanEvents(c.events); }

  /* ---------- số đơn trong ngày ---------- */
  function tempCode(date) {
    // mất mạng: số tạm theo giờ phút giây (Thhmmss, không trùng trong ngày), đồng bộ khi có mạng
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return { date: date, code: 'T' + p(vnParts(d.getTime()).hour) + p(d.getMinutes()) + p(d.getSeconds()), temp: true };
  }
  function newCode() {
    var date = today(), ref = db.doc('posCounters/' + date);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(tempCode(date));
    var tx = db.runTransaction(function (t) {
      return t.get(ref).then(function (s) { var n = (s.exists ? s.data().n : 0) + 1; t.set(ref, { n: n, at: Date.now() }, { merge: true }); return n; });
    });
    return withTimeout(tx, 3500, 'slow').then(function (n) { return { date: date, code: ('00' + n).slice(-3) }; }, function () { return tempCode(date); });
  }
  function pub(o) {
    var log = Array.isArray(o.log) ? o.log : [];
    return { id: o.id, code: o.code, name: o.name, phone: o.phone || '', items: o.items || [], total: o.total || 0, note: o.note || '',
      status: o.status, pay: o.pay || '', split: o.split || null, pager: o.pager || '', created: o.created || 0, paidAt: o.paidAt || 0, mode: o.mode || '',
      src: o.src || 'QR', cashier: o.cashier || '', by: o.createdBy || (log.length ? log[0].by : ''),
      gross: o.gross || o.total || 0, discAmt: o.discAmt || 0, disc: o.disc || null, togo: !!o.togo,
      ack: o.ack && o.ack.at || 0, ackBy: o.ack && o.ack.by || '',
      ready: o.ready && o.ready.at || 0, readyBy: o.ready && o.ready.by || '', askPhone: o.askPhone || 0, more: o.more && o.more.at || 0, moreX: o.more && o.more.x || '',
      nv: o.nvName || '', autoPrint: !!o.autoPrint,
      unpaid: o.unpaid ? { at: o.unpaid.at || 0, by: o.unpaid.by || '', why: o.unpaid.why || '', pager: o.unpaid.pager || '' } : null };
  }
  function save(ref, data, merge) {
    var p = merge ? ref.set(data, { merge: true }) : ref.set(data);
    p.catch(function (e) { console.error('save', e); if (window.ChataAPI.onError) window.ChataAPI.onError(e); });
    return p;
  }

  /* ---------- phiên thu ngân ---------- */
  function fnCall(name, data) {
    return fetch(FN + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: data }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.error || !j.result) return { ok: false, msg: (j.error && j.error.message) || 'Không kiểm tra được mã, thử lại sau.' };
        return { ok: true, r: j.result };
      }); }, function () { return { ok: false, msg: 'Mất kết nối mạng, thử lại nhé.' }; });
  }
  function staffDoc(code) {
    return db.doc('staff/' + code).get().then(function (s) {
      if (!s.exists) return null; var d = s.data();
      return { code: code, name: d.name || code, role: d.role || '', active: d.active !== false, posAllow: d.posAllow };
    });
  }
  function posAllowed(st) {
    if (!st || !st.active) return false; if (st.posAllow === true) return true; if (st.posAllow === false) return false;
    return POS_ROLES.indexOf(st.role) >= 0;
  }
  function who(u) { return u.n + (u.c && u.c !== u.n ? ' (' + u.c + ')' : ''); }
  function getSes() { try { return JSON.parse(localStorage.getItem(SES_KEY) || 'null'); } catch (e) { return null; } }
  function setSes(v) { try { if (v) localStorage.setItem(SES_KEY, JSON.stringify(v)); else localStorage.removeItem(SES_KEY); } catch (e) {} }
  function me() {
    return ready.then(function () {
      var s = getSes(), u = auth.currentUser;
      if (!s || !s.me || !u || u.isAnonymous || s.uid !== u.uid) throw new Error('Sai mã thu ngân');
      if (s.me.r === 'staff' && Date.now() - (s.chk || 0) > 3600000) {
        staffDoc(s.me.c).then(function (st) {
          if (!(s.me.o ? st && st.active : posAllowed(st))) { setSes(null); auth.signOut(); return; }
          s.me.n = st.name; s.chk = Date.now(); setSes(s);
        }).catch(function () {});
      }
      return s.me;
    });
  }
  // Từ 18/11/2026: không duyệt tại chỗ nữa – nhân viên tự làm, việc nhạy cảm được ghi vào posReviews để quản lý xem lại sau
  function approve(u) { return Promise.resolve({ ok: true, by: who(u) }); }
  function logReview(u, kind, o, amount, why, x) {
    if (!u || u.r === 'manager') return;   // quản lý tự làm thì không cần xem lại
    var id = uid('RV'), r = { at: Date.now(), date: today(), kind: kind, orderId: (o && o.id) || '', code: (o && o.code) || '', name: (o && o.name) || '',
      amount: Math.round(Number(amount) || 0), why: clean(why, 160), x: clean(x, 200), by: who(u), byCode: u.c, status: 'Chờ duyệt' };
    C.rev = C.rev || {}; C.rev[id] = Object.assign({ id: id }, r);
    save(db.doc('posReviews/' + id), r);
  }
  function wantReviews() {
    return ready.then(function () {
      return watch('rev', db.collection('posReviews').where('status', '==', 'Chờ duyệt'), function (s) {
        var m = {}; s.forEach(function (d) { m[d.id] = Object.assign({ id: d.id }, d.data()); }); C.rev = m;
      });
    });
  }
  function discReview(u, o, A, L, old, idr) {
    // giảm giá tự nhập (không theo chương trình) hoặc giảm giá món: ghi lại khi mới áp dụng / thay đổi
    old = old || {};
    if (A.disc && !A.disc.promo && JSON.stringify(A.disc) !== JSON.stringify(old.disc || null))
      logReview(u, 'Giảm giá đơn', o, A.disc.amt, A.disc.r, (A.disc.t === '%' ? A.disc.v + '%' : A.disc.v + 'đ') + ' · tạm tính ' + L.total);
    var ik = function (it) { return (it || []).filter(function (i) { return i.da; }).map(function (i) { return i.n + ':' + i.dt + i.dv + 'x' + i.q; }).join('|'); };
    if (L.idisc > 0 && ik(L.items) !== ik(old.items))
      logReview(u, 'Giảm giá món', o, L.idisc, idr || '', L.items.filter(function (i) { return i.da; }).map(function (i) { return i.q + '× ' + i.n + ' −' + (i.dt === '%' ? i.dv + '%' : i.dv + 'đ/món'); }).join(', '));
  }
  /* Thanh toán nhiều cách (Tài 20/11): chỉ Tiền mặt + Chuyển khoản. Đơn chia lưu pay = 'Tiền mặt + CK', split = { cash, ck } */
  var PAY_SPLIT = 'Tiền mặt + CK';
  function payParts(o) {
    var t = Number(o.total) || 0;
    if (o.pay === PAY_SPLIT && o.split) { var c = Math.max(0, Math.min(t, Number(o.split.cash) || 0)); return { cash: c, ck: t - c }; }
    return o.pay === 'Chuyển khoản' ? { cash: 0, ck: t } : { cash: t, ck: 0 };
  }
  function payOf(d, total) {
    if (d.pay === PAY_SPLIT) { var c = Math.round(Number(d.split && d.split.cash) || 0); if (c > 0 && c < total) return { pay: PAY_SPLIT, split: { cash: c, ck: total - c } }; return { pay: c >= total ? 'Tiền mặt' : 'Chuyển khoản', split: null }; }
    return { pay: d.pay === 'Chuyển khoản' ? 'Chuyển khoản' : 'Tiền mặt', split: null };
  }
  function payTxt(o) { return o.pay === PAY_SPLIT && o.split ? 'TM ' + Number(o.split.cash).toLocaleString('vi-VN') + ' + CK ' + Number(o.split.ck).toLocaleString('vi-VN') : (o.pay || ''); }
  function byCode(w, code) { return !!w && (w === code || w.indexOf('(' + code + ')') >= 0 || w.split(' (')[0] === code); }
  function sumFor(all, code, from, to) {
    var s = { orders: 0, revenue: 0, cash: 0, transfer: 0, cancels: 0, refunds: 0, refundAmt: 0, unpaid: 0, unpaidAmt: 0 };
    all.forEach(function (o) {
      if ((o.status === 'Đã thanh toán' || o.refundAt) && o.paidAt >= from && o.paidAt < to && byCode(o.cashier, code)) {
        var pp = payParts(o); s.orders++; s.revenue += o.total; s.transfer += pp.ck; s.cash += pp.cash;
      }
      // hoàn tiền đơn đã thu: trừ vào ca của người hoàn
      if (o.refundAt && o.refundAt >= from && o.refundAt < to && o.refundCode === code) {
        var rp = payParts(o); s.refunds++; s.refundAmt += o.total; s.revenue -= o.total; s.transfer -= rp.ck; s.cash -= rp.cash;
      }
      if (o.status === 'Đã hủy') (o.log || []).forEach(function (l) { if (l.a === 'huy' && l.at >= from && l.at < to && byCode(l.by, code)) s.cancels++; });
      if (o.status === 'Chưa thu' && o.unpaid && o.unpaid.code === code && o.unpaid.at >= from && o.unpaid.at < to) { s.unpaid++; s.unpaidAmt += o.total || 0; }
    });
    return s;
  }
  function allOrders() {
    var m = {}, b = C.orders || {};
    [C.keep, C.pend, C.debt, C.paid].forEach(function (a) { Object.keys(a || {}).forEach(function (k) { m[k] = a[k]; }); });
    Object.keys(b).forEach(function (k) { m[k] = b[k]; }); // bản trong C.orders là bản mới nhất trên máy
    return Object.keys(m).map(function (k) { return m[k]; });
  }
  /* Quỹ tiền lẻ cố định trong tủ (Tài chốt 20/11/2026: 500.000đ để thối, giữ lại tủ khi kết ca) */
  function floatCfg() { var v = Number(cfg().float); return v >= 0 && cfg().float !== undefined && cfg().float !== '' ? Math.round(v) : 500000; }
  /* Chi từ két (Tài 22/11): khoản chi thu ngân lấy tiền trong tủ → cash (src pos, shiftId) – trừ vào tiền mặt phải có khi kết ca */
  var KX = {};
  function kExpLoad(sid) { if (!sid || KX[sid]) return; KX[sid] = []; db.collection('cash').where('shiftId', '==', sid).get().then(function (q) { var cur = KX[sid] || []; q.forEach(function (d) { var x = d.data(); if (x.type === 'chi' && x.src === 'pos' && x.status !== 'tu_choi' && x.status !== 'xoa' && !cur.some(function (y) { return y.id === d.id; })) cur.push(Object.assign({ id: d.id }, x)); }); KX[sid] = cur; }).catch(function () { delete KX[sid]; }); }
  function kExpSum(sid) { kExpLoad(sid); return (KX[sid] || []).reduce(function (s, x) { return s + (+x.amount || 0); }, 0); }
  function openShiftOf(code) { return (C.shifts || []).filter(function (s) { return s.code === code; }).sort(function (a, b) { return a.openAt - b.openAt; }).pop() || null; }
  function shiftLive(u) {
    var s = openShiftOf(u.c); if (!s) return null;
    var t = sumFor(allOrders(), u.c, s.openAt, Date.now() + 60000);
    return { id: s.id, openAt: s.openAt, openCash: s.openCash, float: s.float != null ? s.float : floatCfg(), openNote: s.openNote || '', orders: t.orders, revenue: t.revenue, cash: t.cash, transfer: t.transfer,
      cancels: t.cancels, refunds: t.refunds, refundAmt: t.refundAmt, unpaid: t.unpaid, unpaidAmt: t.unpaidAmt, exp: kExpSum(s.id), expList: (KX[s.id] || []).map(function (x) { return { cat: x.cat, amount: x.amount, note: x.note }; }), expect: s.openCash + t.cash - kExpSum(s.id) };
  }
  function cashierPatch(id, fn) {
    return me().then(function (u) {
      return posReady().then(function () {
        var c = C.orders[id] || (C.pend || {})[id] || (C.paid || {})[id] || C.keep[id];
        var get = c ? Promise.resolve(JSON.parse(JSON.stringify(c))) : db.doc('posOrders/' + id).get().then(function (s) { return s.exists ? Object.assign({ id: s.id }, s.data()) : null; });
        return get.then(function (o) {
          if (!o) return { ok: false, msg: 'Không tìm thấy đơn.' };
          var r = fn(o, u); if (typeof r === 'string') return { ok: false, msg: r };
          if (r !== true) { delete o.id; C.keep[id] = Object.assign({ id: id }, o); if (C.orders[id]) C.orders[id] = C.keep[id]; if (C.paid && C.paid[id]) C.paid[id] = C.keep[id]; save(db.doc('posOrders/' + id), o); }
          return { ok: true, order: pub(Object.assign({ id: id }, o)), data: cashierData(u) };
        });
      });
    });
  }
  function cashierData(u) {
    // Đơn tại quầy chưa thu: luôn hiện (không tự mất). Đơn QR khách gửi mà không ra quầy: ẩn sau 12 giờ.
    var mode = orderMode(), d = today(), qrSince = Date.now() - 12 * 3600000, all = allOrders();
    var pending = all.filter(function (o) { return o.status === 'Chờ thanh toán' && (o.src === 'Quầy' || o.src === 'NV' || o.created >= qrSince); })
      .sort(function (a, b) { return a.created - b.created; }).map(function (o) { return pub(fixQR(o)); });
    var paid = all.filter(function (o) { return o.status === 'Đã thanh toán' && (o.paidDate || o.date) === d; });
    var sum = function (a) { return a.reduce(function (s, o) { return s + o.total; }, 0); };
    return {
      me: { code: u.c, name: u.n, role: u.r }, shift: shiftLive(u), revPending: u.r === 'manager' ? Object.keys(C.rev || {}).filter(function (k) { return C.rev[k].status === 'Chờ duyệt'; }).length : 0,
      mode: mode, modeSetting: modeSetting(), open: orderOpen(), tables: cleanTables(cfg().tables), promos: cleanPromos(cfg().promos),
      menu: menuFor(mode), night: mode === 'night' ? null : menuFor('night'), other: menuFor(mode === 'night' ? 'normal' : 'night'),
      pending: pending, events: eventsCfg(), float: floatCfg(), addons: addonsCfg(),
      debt: all.filter(function (o) { return o.status === 'Chưa thu'; }).sort(function (a, b) { return ((b.unpaid || {}).at || 0) - ((a.unpaid || {}).at || 0); }).map(pub),
      /* đơn QR đã thu tiền nhưng chưa báo món xong (3 giờ gần đây) – để thu ngân bấm "Món xong" */
      waiting: paid.filter(function (o) { return o.src === 'QR' && !(o.ready && o.ready.at) && Date.now() - (o.paidAt || 0) < 3 * 3600000; }).sort(function (a, b) { return a.paidAt - b.paidAt; }).map(pub),
      paid: paid.sort(function (a, b) { return b.paidAt - a.paidAt; }).slice(0, 40).map(pub),
      stats: { paid: paid.length, revenue: sum(paid), cash: paid.reduce(function (s, o) { return s + payParts(o).cash; }, 0),
        transfer: paid.reduce(function (s, o) { return s + payParts(o).ck; }, 0) }
    };
  }
  function posReady() { khoBeat(); return Promise.all([wantCfg(), wantOrders(), wantShifts()]); }
  /* ===== Trừ kho theo đơn app thu ngân (Tài chốt 19/11/2026: trừ ngay khi lưu đơn, Sapo đã ngưng) =====
     Mỗi lần lưu/thu/hủy/hoàn/gộp: so số món đã trừ (o.kho = {vid: số}) với món hiện tại, ghi phần chênh vào sales/{id}
     (rows [{vid, title, qty}], qty âm = trả lại kho). Cloud Function truKhoBanHang trừ theo định lượng recipes/{vid}, mỗi phiếu 1 lần.
     Món menu đêm nhạc chưa có định lượng → lấy theo món thường tương ứng (Tài chốt). */
  var NIGHT_ALIAS = { 'xúc xích chiên': 'Xúc xích Đức (3 cây)', 'cá viên chiên': 'Cá viên', 'bò viên chiên': 'Bò viên', 'tôm viên chiên': 'Tôm viên',
    'hồ lô chiên': 'Hồ lô', 'trà đác thơm': 'Trà thơm hạt đác', 'trà sữa trân châu': 'Trà sữa truyền thống (M)' };
  function khoItem(n, vid) {
    var N = menuFor('normal'), lo = function (x) { return String(x || '').toLowerCase().trim(); }, k = lo(n);
    var hit = N.filter(function (m) { return m.n === n; })[0];
    if (hit) return { vid: hit.vid || vid, n: n };
    if (NIGHT_ALIAS[k]) k = lo(NIGHT_ALIAS[k]);
    var c = N.filter(function (m) { return lo(m.n) === k; });
    if (!c.length) c = N.filter(function (m) { return lo(m.b) === k; });
    if (!c.length) c = N.filter(function (m) { return lo(m.n).indexOf(k + ' (') === 0; });
    var m = c.filter(function (x) { return /^(m|vừa)$/i.test(x.s || ''); })[0] || c[0];
    return m && m.vid ? { vid: m.vid, n: m.n } : { vid: vid, n: n };
  }
  function khoWant(o) {
    var w = {}, t = {};
    if (o.status !== 'Đã hủy') (o.items || []).forEach(function (i) {
      var k = khoItem(i.n, i.vid); if (!k.vid) return;
      w[k.vid] = (w[k.vid] || 0) + (Number(i.q) || 0); t[k.vid] = k.n;
    });
    return { w: w, t: t };
  }
  function vidName(v) { var m = menuFor('normal').concat(menuFor('night')).filter(function (x) { return x.vid === v; })[0]; return m ? m.n : v; }
  function khoSync(o, id, u) {
    var W = khoWant(o), had = o.kho || {}, rows = [];
    Object.keys(W.w).concat(Object.keys(had)).forEach(function (v) {
      if (rows.some(function (r) { return r.vid === v; })) return;
      var dq = (W.w[v] || 0) - (Number(had[v]) || 0); if (dq) rows.push({ vid: v, title: W.t[v] || vidName(v), qty: dq });
    });
    if (!rows.length) return;
    var now = Date.now();
    o.kho = W.w;
    save(db.doc('sales/p-' + id + '-' + now), { date: ymdOf(now), from: now - 1, to: now, at: now, by: 'App thu ngân · ' + (u ? u.n : ''), src: 'pos',
      orderId: id, code: o.code || '', rows: rows });
  }
  /* Mốc đồng bộ bán hàng: phiếu kiểm kho chờ "đồng bộ bán hàng" tới giờ kiểm → 30 phút ghi 1 phiếu rỗng nếu mốc cũ (khi app đang mở) */
  var beatT = 0;
  function khoBeat() {
    if (beatT || !window.ChataAPI) return; beatT = setInterval(beat, 30 * 60000); setTimeout(beat, 20000);
    function beat() {
      var s = getSes(); if (!s || !s.me) return;
      db.doc('config/salesSync').get().then(function (d) {
        var to = d.exists ? Number(d.data().to) || 0 : 0, now = Date.now() - 60000;
        if (now - to < 30 * 60000) return;
        return db.doc('sales/p-beat-' + now).set({ date: ymdOf(now), from: to, to: now, at: Date.now(), by: 'App thu ngân (mốc)', src: 'pos', rows: [] });
      }).catch(function () {});
    }
  }
  /* Tổng hợp ngày cho báo cáo bán hàng của Web vận hành (revenuePos/{ngày}, cùng dạng revenue của Sapo) */
  var dayT = {};
  function dayLater(d) { if (!d) return; clearTimeout(dayT[d]); dayT[d] = setTimeout(function () { rebuildDay(d); }, 1500); }
  function rebuildDay(d) {
    return db.collection('posOrders').where('paidDate', '==', d).get().then(function (q) {
      var r = { date: d, total: 0, gross: 0, disc: 0, orders: 0, pay: {}, items: [], hours: {}, cancel: 0, cancelAmt: 0, src: 'app', at: Date.now() }, it = {};
      q.forEach(function (x) {
        var o = x.data(); if (o.status !== 'Đã thanh toán') return;
        r.orders++; r.total += o.total; r.gross += (o.gross || o.total); r.disc += (o.discAmt || 0); var rpp = payParts(o); if (rpp.cash) r.pay['Tiền mặt'] = (r.pay['Tiền mặt'] || 0) + rpp.cash; if (rpp.ck) r.pay['Chuyển khoản'] = (r.pay['Chuyển khoản'] || 0) + rpp.ck;
        (o.items || []).forEach(function (i) { var k = i.n, e = it[k] || (it[k] = { n: i.n, c: i.g || '', q: 0, a: 0 }); e.q += i.q; e.a += i.p * i.q - (i.da || 0); });
        var h = hhOf(o.paidAt), hh = r.hours[h] || (r.hours[h] = [0, 0]); hh[0]++; hh[1] += o.total;
      });
      return db.collection('posOrders').where('date', '==', d).get().then(function (q2) {
        q2.forEach(function (x) { var o = x.data(); if (o.status === 'Đã hủy' && !o.mergedInto) { r.cancel++; r.cancelAmt += o.total || 0; } if (o.status === 'Chưa thu') { r.unpaid = (r.unpaid || 0) + 1; r.unpaidAmt = (r.unpaidAmt || 0) + (o.total || 0); } });
        r.items = Object.keys(it).map(function (k) { return it[k]; }).sort(function (a, b) { return b.a - a.a; });
        return db.doc('revenuePos/' + d).set(r).then(function () { return mirrorRev(d, r); });
      });
    }).catch(function (e) { console.error('rebuildDay', e); });
  }
  /* Doanh thu cho thưởng tuần, sổ quỹ, lãi lỗ của Web vận hành (đọc revenue/{ngày}) – Tài chốt 19/11/2026 khi ngưng Sapo:
     revenue/{ngày} = phần Sapo (giữ nguyên bản chụp ở revenueSapo/{ngày}, chụp 1 lần) + phần app thu ngân. */
  function mergeRev(a, b) {
    var m = { date: b.date, total: 0, orders: 0, gross: 0, disc: 0, cancel: 0, cancelAmt: 0, pay: {}, hours: {}, cat: {}, items: [], src: a ? 'sapo+app' : 'app', at: Date.now(), salesAt: Date.now(), payAt: Date.now() }, it = {};
    [a, b].forEach(function (r) {
      if (!r) return;
      ['total', 'orders', 'gross', 'disc', 'cancel', 'cancelAmt', 'unpaid', 'unpaidAmt'].forEach(function (k) { m[k] = (m[k] || 0) + (Number(r[k]) || 0); });
      Object.keys(r.pay || {}).forEach(function (k) { m.pay[k] = (m.pay[k] || 0) + (Number(r.pay[k]) || 0); });
      Object.keys(r.hours || {}).forEach(function (h) { var v = r.hours[h] || [], x = m.hours[h] || (m.hours[h] = [0, 0]); x[0] += Number(v[0]) || 0; x[1] += Number(v[1]) || 0; });
      Object.keys(r.cat || {}).forEach(function (k) { m.cat[k] = (m.cat[k] || 0) + (Number(r.cat[k]) || 0); });
      (r.items || []).forEach(function (i) { var k = i.n + '|' + (i.c || ''), x = it[k] || (it[k] = { n: i.n, c: i.c || '', q: 0, a: 0 }); x.q += Number(i.q) || 0; x.a += Number(i.a) || 0; });
    });
    (b.items || []).forEach(function (i) { var k = i.c || 'Khác'; m.cat[k] = (m.cat[k] || 0) + (Number(i.a) || 0); });
    m.items = Object.keys(it).map(function (k) { return it[k]; }).sort(function (x, y) { return y.a - x.a; });
    return m;
  }
  function mirrorRev(d, r) {
    var sref = db.doc('revenueSapo/' + d), rref = db.doc('revenue/' + d);
    return sref.get().then(function (s) {
      if (s.exists) return s.data().none ? null : s.data();
      return rref.get().then(function (x) {
        var sp = x.exists && x.data().src === 'sapo-orders' ? x.data() : null;
        return sref.set(sp ? Object.assign({}, sp, { copiedAt: Date.now() }) : { none: true, date: d, copiedAt: Date.now() }).then(function () { return sp; });
      });
    }).then(function (sp) { return rref.set(mergeRev(sp, r)); });
  }
  function act(o, u, a, x) { var it = { a: a, by: typeof u === 'string' ? u : who(u), at: Date.now() }; if (x) it.x = x; o.log = (o.log || []).concat([it]).slice(-30); }

  var API = {
    /* ===== Khách gọi món QR ===== */
    getOrderMenu: function () { return wantCfg().then(function () { var mode = orderMode(); return { mode: mode, open: orderOpen(), events: eventsCfg(), menu: menuFor(mode).filter(function (m) { return !m.nq; }), addons: addonsCfg() }; }); },
    submitOrder: function (d) {
      d = d || {};
      return wantCfg().then(function () {
        if (!orderOpen()) return { ok: false, msg: 'Quầy đang nhận order trực tiếp, bạn ghé quầy giúp Chata nhé.' };
        var name = clean(d.name, 30); if (!name) return { ok: false, msg: 'Bạn cho Chata xin tên để gọi khi tới quầy nhé.' };
        var phone = phoneOf(d.phone); if (phone === null) return { ok: false, msg: 'Số điện thoại chưa đúng, bạn kiểm tra lại hoặc để trống nhé.' };
        var mode = orderMode(), L = lines(d.items, menuFor(mode).filter(function (m) { return !m.nq; }));
        if (!L.items.length) return { ok: false, msg: 'Bạn chọn ít nhất 1 món nhé.' };
        return newCode().then(function (c) {
          var id = uid('D'), token = rand(16), now = Date.now();
          var o = { code: c.code, date: c.date, created: now, name: name, phone: phone, items: L.items, total: L.total, note: clean(d.note, 200),
            status: 'Chờ thanh toán', pay: '', pager: clean(d.pager, 10), paidAt: 0, paidDate: '', mode: mode === 'night' ? 'Đêm nhạc' : 'Thường', token: token, src: 'QR', cashier: '', log: [],
            uid: auth.currentUser ? auth.currentUser.uid : '' };
          return db.collection('posOrders').doc(id).set(o).then(function () { return { ok: true, id: id, token: token, code: c.code, total: L.total }; });
        });
      });
    },
    getMyOrder: function (id, token) {
      return ready.then(function () { return db.doc('posOrders/' + String(id)).get(); }).then(function (s) {
        if (!s.exists || s.data().token !== token) return { ok: false };
        var out = { ok: true, order: pub(Object.assign({ id: s.id }, s.data())) };
        return wantCfg().then(function () { out.events = eventsCfg(); return out; }, function () { return out; });
      }, function () { return { ok: false }; });
    },
    /* Khách bổ sung SĐT khi quầy yêu cầu (Tài 19/11): chỉ ghi được trường phone của đơn mình (quy tắc Firestore) */
    setMyPhone: function (id, token, phone) {
      var ph = phoneOf(phone);
      if (!ph) return Promise.resolve({ ok: false, msg: 'Số điện thoại chưa đúng, bạn kiểm tra lại giúp Chata nhé.' });
      return ready.then(function () {
        var ref = db.doc('posOrders/' + String(id));
        return ref.get().then(function (s) {
          if (!s.exists || s.data().token !== token) return { ok: false, msg: 'Không tìm thấy đơn.' };
          if (s.data().status === 'Đã hủy') return { ok: false, msg: 'Đơn này đã hủy.' };
          return ref.update({ phone: ph }).then(function () { return { ok: true }; });
        });
      }).catch(function () { return { ok: false, msg: 'Chưa gửi được, bạn đọc số điện thoại cho thu ngân giúp Chata nhé.' }; });
    },
    cancelMyOrder: function (id, token) {
      return ready.then(function () {
        var ref = db.doc('posOrders/' + String(id));
        return db.runTransaction(function (t) {
          return t.get(ref).then(function (s) {
            if (!s.exists || s.data().token !== token) return { ok: false, msg: 'Không tìm thấy đơn.' };
            if (s.data().status !== 'Chờ thanh toán') return { ok: false, msg: 'Đơn đã được thu ngân xử lý, bạn ra quầy nhé.' };
            if (s.data().kho && Object.keys(s.data().kho).length) return { ok: false, msg: 'Quầy đã làm món cho đơn này, bạn ra quầy để đổi/hủy nhé.' };
            t.update(ref, { status: 'Đã hủy', log: (s.data().log || []).concat([{ a: 'huy', by: 'Khách tự hủy', at: Date.now() }]) });
            return { ok: true };
          });
        });
      });
    },

    /* ===== Thu ngân ===== */
    cashierLogin: function () { return Promise.resolve({ ok: false, msg: 'Mã chung đã ngừng dùng. Mở app Chata Thu ngân, đăng nhập bằng mã nhân viên và PIN của bạn.' }); },
    posLogin: function (kind, code, pin, any) {
      code = String(code || '').trim().toUpperCase(); pin = String(pin || '').trim();
      if (!pin) return Promise.resolve({ ok: false, msg: 'Nhập PIN của bạn.' });
      if (kind !== 'manager' && !code) return Promise.resolve({ ok: false, msg: 'Nhập mã nhân viên.' });
      return ready.then(function () {
        return fnCall('dangNhap', kind === 'manager' ? (code ? { role: 'manager', pin: pin, code: code } : { role: 'manager', pin: pin }) : { code: code, pin: pin });
      }).then(function (r) {
        if (!r.ok) return r;
        if (kind !== 'manager' && r.r.noPin) return { ok: false, msg: 'Bạn chưa có PIN. Nhờ quản lý cấp PIN trong Web vận hành (Nhân viên → Cấp PIN).' };
        return auth.signInWithCustomToken(r.r.token).then(function (cred) {
          resetSubs();
          if (kind === 'manager') return { c: r.r.code || code || 'QL', n: r.r.name || 'Quản lý', r: 'manager' };
          return staffDoc(r.r.code || code).then(function (st) {
            if (!(any ? st && st.active : posAllowed(st))) return null;
            return { c: st.code, n: st.name, r: 'staff', o: any ? 1 : 0 };
          });
        }).then(function (u) {
          if (!u) { setSes(null); resetSubs(); return auth.signOut().then(function () { return auth.signInAnonymously(); }).then(function () { return { ok: false, msg: 'Tài khoản này chưa được dùng app thu ngân. Nhờ quản lý bật quyền trong Web vận hành (Nhân viên → App thu ngân).' }; }); }
          setSes({ me: u, uid: auth.currentUser.uid, chk: Date.now() });
          posReady();
          return { ok: true, token: 'FB' + auth.currentUser.uid, me: { code: u.c, name: u.n, role: u.r } };
        });
      });
    },
    posLogout: function () { setSes(null); return ready.then(function () { resetSubs(); return auth.signOut(); }).then(function () { return auth.signInAnonymously(); }).then(function () { return { ok: true }; }, function () { return { ok: true }; }); },
    getCashier: function () { return me().then(function (u) { return Promise.all([posReady(), u.r === 'manager' ? wantReviews() : null]).then(function () { return cashierData(u); }); }); },
    /* Việc chờ quản lý xem lại */
    reviewList: function () {
      return me().then(function (u) {
        var mgr = u.r === 'manager', since = ymdOf(Date.now() - 14 * 86400000);
        var q = mgr ? db.collection('posReviews').where('date', '>=', since) : db.collection('posReviews').where('byCode', '==', u.c);
        return q.get().then(function (s) {
          var a = []; s.forEach(function (d) { var r = Object.assign({ id: d.id }, d.data()); if (r.date >= since) a.push(r); });
          a.sort(function (x, y) { return (x.status === 'Chờ duyệt' ? 0 : 1) - (y.status === 'Chờ duyệt' ? 0 : 1) || y.at - x.at; });
          return { ok: true, mgr: mgr, list: a.slice(0, 150) };
        });
      });
    },
    reviewSet: function (tok, id, agree, note) {
      return me().then(function (u) {
        if (u.r !== 'manager') return { ok: false, msg: 'Chỉ quản lý xác nhận được.' };
        var up = { status: agree ? 'Đồng ý' : 'Không đồng ý', reviewBy: who(u), reviewAt: Date.now(), reviewNote: clean(note, 160) };
        if (C.rev && C.rev[id]) Object.assign(C.rev[id], up);
        save(db.doc('posReviews/' + String(id)), up, true);
        return { ok: true };
      });
    },
    cashierCreate: function (tok, d) {
      d = d || {};
      return me().then(function (u) {
        return posReady().then(function () {
          var mode = orderMode(), L = lines(d.items, menuFor(mode).concat(menuFor(mode === 'night' ? 'normal' : 'night')));
          if (!L.items.length) return { ok: false, msg: 'Đơn chưa có món nào.' };
          var phone = phoneOf(d.phone); if (phone === null) return { ok: false, msg: 'Số điện thoại chưa đúng.' };
          var A = applyDisc(L, d.disc);
          var PO = d.pay ? payOf(d, A.total) : { pay: '', split: null }, pay = PO.pay;
          return newCode().then(function (c) {
            var id = uid('D'), now = Date.now();
            var o = { code: c.code, date: c.date, created: now, name: clean(d.name, 30) || 'Khách lẻ', phone: phone, items: L.items, total: A.total,
              gross: A.gross, itemDisc: A.itemDisc, disc: A.disc, discAmt: A.discAmt,
              note: clean(d.note, 200), status: pay ? 'Đã thanh toán' : 'Chờ thanh toán', pay: pay, pager: clean(d.pager, 10), paidAt: pay ? now : 0,
              paidDate: pay ? today() : '', mode: mode === 'night' ? 'Đêm nhạc' : 'Thường', token: '', src: 'Quầy', cashier: pay ? who(u) : '', cashierCode: pay ? u.c : '', createdBy: who(u), log: [] };
            if (d.togo) o.togo = true;
            if (PO.split) o.split = PO.split;
            act(o, u, 'tao'); if (pay) act(o, u, 'thu', payTxt(o));
            if (c.temp) o.tempCode = true;
            var K = d.kitchen ? kitchenDelta(L.items, null) : null; if (K) { o.sent = K.sent; act(o, u, 'bep'); }
            khoSync(o, id, u);
            C.orders[id] = Object.assign({ id: id }, o);
            save(db.collection('posOrders').doc(id), o);
            discReview(u, C.orders[id], A, L, null, clean(d.idr, 160));
            if (pay) dayLater(o.paidDate);
            return { ok: true, order: pub(C.orders[id]), kitchen: K ? K.items : [], data: cashierData(u) };
          });
        });
      });
    },
    cashierUpdate: function (tok, id, action, d) {
      d = d || {};
      return me().then(function (u) {
        return posReady().then(function () { return approve(u); }).then(function (ok) {
          if (!ok.ok) return ok;
          var cur = C.orders[id] || (C.paid || {})[id] || (C.pend || {})[id] || (C.debt || {})[id] || C.keep[id], K = null;
          var get = cur ? Promise.resolve(cur) : db.doc('posOrders/' + id).get().then(function (s) { return s.exists ? Object.assign({ id: s.id }, s.data()) : null; });
          return get.then(function (o0) {
            if (!o0) return { ok: false, msg: 'Không tìm thấy đơn.' };
            var o = JSON.parse(JSON.stringify(o0)); delete o.id;
            var apx = '', why0 = clean(d.reason, 120), rv = null;
            if (action === 'method') {
              if (o.status !== 'Đã thanh toán') return { ok: false, msg: 'Chỉ đổi được hình thức của đơn đã thanh toán.' };
              var NP = payOf(d, o.total), was = payTxt(o), nt = payTxt({ pay: NP.pay, split: NP.split });
              if (nt === was) return { ok: false, msg: 'Đơn này đã là ' + nt + '.' };
              act(o, u, 'doitt', was + ' → ' + nt + (why0 ? ' · ' + why0 : '')); rv = ['Đổi hình thức TT', o.total, why0, was + ' → ' + nt]; o.pay = NP.pay; if (NP.split) o.split = NP.split; else delete o.split;
            } else if (action === 'refund') {
              if (o.status !== 'Đã thanh toán') return { ok: false, msg: 'Đơn này chưa thanh toán, dùng Hủy đơn.' };
              var why = clean(d.reason, 120); if (!why) return { ok: false, msg: 'Ghi lý do hoàn/hủy đơn.' };
              o.status = 'Đã hủy'; o.refundAt = Date.now(); o.refundCode = u.c; o.refundBy = who(u); o.refundWhy = why;
              act(o, u, 'hoan', why); rv = ['Hoàn/hủy đơn đã thu', o.total, why, o.pay + ' · thu lúc ' + new Date(o.paidAt).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })];
            } else if (action === 'unpaid') {
              /* Khách về chưa trả (Tài 21/11): đơn rời danh sách chờ, kho vẫn trừ, chưa tính doanh thu, nhả thẻ rung; thu sau ở mục "Chưa thu" */
              if (o.status !== 'Chờ thanh toán') return { ok: false, msg: 'Chỉ đơn đang chờ thanh toán mới chuyển sang chưa thu.' };
              if (!why0) return { ok: false, msg: 'Ghi lý do.' };
              var pg0 = o.pager || '';
              o.status = 'Chưa thu'; o.unpaid = { at: Date.now(), by: who(u), code: u.c, why: why0, pager: pg0 }; o.pager = '';
              act(o, u, 'chuathu', why0); rv = ['Khách về chưa trả', o.total, why0, (pg0 ? 'Bàn ' + pg0 + ' · ' : '') + (o.src === 'Quầy' ? 'Tại quầy' : o.src === 'NV' ? 'NV order' : 'Đơn QR')];
            } else if (action === 'cancel') {
              if (o.status === 'Đã thanh toán') return { ok: false, msg: 'Đơn đã thanh toán, không hủy ở đây được.' };
              if (!why0) return { ok: false, msg: 'Ghi lý do hủy đơn.' };
              o.status = 'Đã hủy'; act(o, u, 'huy', why0); rv = ['Hủy đơn chờ', o.total, why0, o.src === 'QR' ? 'Đơn QR' : 'Tại quầy'];
            } else {
              if (o.status === 'Đã hủy') return { ok: false, msg: 'Đơn này đã bị hủy.' };
              if (o.status === 'Đã thanh toán' && action === 'pay') return { ok: false, msg: 'Đơn đã thanh toán rồi.' };
              var menu = qrMenu(o), L = lines(d.items, menu, priceExtra(o, menu));
              if (!L.items.length) return { ok: false, msg: 'Đơn chưa có món nào.' };
              var note = clean(d.note, 200), A = applyDisc(L, d.disc), old0 = { disc: o.disc, items: o.items };
              if (JSON.stringify(L.items) !== JSON.stringify(o.items) || note !== (o.note || '')) { o.edited = true; act(o, u, 'sua'); }
              if (JSON.stringify(A.disc) !== JSON.stringify(o.disc || null) && (A.disc || o.disc)) act(o, u, 'giam', A.disc ? (A.disc.promo || A.disc.r || '') + ' -' + A.disc.amt : 'bỏ giảm giá');
              o.items = L.items; o.total = A.total; o.note = note; o.gross = A.gross; o.itemDisc = A.itemDisc; o.disc = A.disc; o.discAmt = A.discAmt;
              if (d.name !== undefined && clean(d.name, 30)) o.name = clean(d.name, 30);
              if (d.phone !== undefined) { var ph = phoneOf(d.phone); if (ph !== null) o.phone = ph; }
              o.pager = clean(d.pager, 10);
              if (d.togo !== undefined) o.togo = !!d.togo;
              if (action === 'pay') {
                var PO2 = payOf(d, o.total);
                if (o.status === 'Chưa thu' && o.unpaid) { o.unpaid.paidAt = Date.now(); o.unpaid.paidBy = who(u); act(o, u, 'thuno', 'khách quay lại trả'); }
                o.status = 'Đã thanh toán'; o.pay = PO2.pay; if (PO2.split) o.split = PO2.split; else delete o.split; o.paidAt = Date.now(); o.paidDate = today(); o.cashier = who(u); o.cashierCode = u.c; act(o, u, 'thu', payTxt(o));
              }
              if (d.kitchen) { K = kitchenDelta(L.items, o.sent); o.sent = K.sent; if (K.items.length) act(o, u, 'bep'); }
            }
            if (action !== 'method') khoSync(o, id, u);
            C.orders[id] = C.keep[id] = Object.assign({ id: id }, o);
            save(db.doc('posOrders/' + id), o);
            if (rv) logReview(u, rv[0], C.orders[id], rv[1], rv[2], rv[3]);
            else if (A) discReview(u, C.orders[id], A, L, old0, clean(d.idr, 160));
            if (action === 'pay' || action === 'method') dayLater(o.paidDate);
            else if (action === 'refund') { dayLater(o.paidDate); if (o.date !== o.paidDate) dayLater(o.date); }
            else if (action === 'cancel' || action === 'unpaid') dayLater(o.date);
            else if (o.status === 'Đã thanh toán' && o.paidDate) dayLater(o.paidDate);
            return { ok: true, total: o.total, order: pub(C.orders[id]), kitchen: K ? K.items : [], data: cashierData(u) };
          });
        });
      });
    },

    /* ===== Trang "Order tại bàn" cho nhân viên phục vụ (20/11/2026) =====
       Tài chốt: gửi đơn xong máy quầy tự in phiếu bếp + tem ly (không chờ xác nhận); thu tiền tại quầy;
       bàn/thẻ đang có đơn chờ thì gọi thêm vào đơn đó; tem ly in "NV ORDER", phiếu bếp in tên người order. */
    staffMe: function () { return me().then(function (u) { return { ok: true, me: { code: u.c, name: u.n, role: u.r } }; }); },
    staffMenu: function () {
      return me().then(function () { return wantCfg(); }).then(function () {
        var mode = orderMode(); return { ok: true, open: true, mode: mode, events: [], menu: menuFor(mode), addons: addonsCfg() };
      });
    },
    staffOrder: function (tok, d) {
      d = d || {};
      return me().then(function (u) {
        return posReady().then(function () {
          var pager = clean(d.pager, 10); /* Tài 20/11: bàn / thẻ không bắt buộc – không có thì luôn tạo đơn mới */
          var mode = orderMode(), menu = menuFor(mode).concat(menuFor(mode === 'night' ? 'normal' : 'night'));
          var L = lines(d.items, menu); if (!L.items.length) return { ok: false, msg: 'Chọn ít nhất 1 món.' };
          var note = clean(d.note, 200), now = Date.now(), nAdd = L.items.reduce(function (s, i) { return s + i.q; }, 0);
          var open = !pager ? null : allOrders().filter(function (o) { return o.status === 'Chờ thanh toán' && o.pager === pager && now - (o.created || 0) < 12 * 3600000; })
            .sort(function (a, b) { return b.created - a.created; })[0];
          if (open && !d.newOrder) {
            var id = open.id, o = JSON.parse(JSON.stringify(open)); delete o.id;
            var m2 = qrMenu(o).concat(menu), L2 = lines((o.items || []).concat(L.items), m2, priceExtra(o, m2)), A = applyDisc(L2, o.disc);
            o.items = L2.items; o.total = A.total; o.gross = A.gross; o.itemDisc = A.itemDisc; o.discAmt = A.discAmt; o.disc = A.disc;
            if (note) o.note = o.note ? o.note + ' · ' + note : note;
            if (d.togo) o.togo = true;
            o.autoPrint = true; o.edited = true; if (!o.nvName) { o.nvName = u.n; o.nvCode = u.c; }
            o.nvBy = (o.nvBy || []).concat([u.c]).filter(function (x, k, a) { return a.indexOf(x) === k; });
            act(o, u, 'sua', 'NV gọi thêm: ' + L.items.map(function (i) { return i.q + ' ' + i.n; }).join(', '));
            khoSync(o, id, u);
            C.orders[id] = Object.assign({ id: id }, o); save(db.doc('posOrders/' + id), o);
            return { ok: true, id: id, code: o.code, added: nAdd, merged: true };
          }
          return newCode().then(function (c) {
            var id = uid('D');
            var o = { code: c.code, date: c.date, created: now, name: clean(d.name, 30) || (pager ? 'Bàn ' + pager : 'Tại bàn · ' + u.n), phone: '', items: L.items, total: L.total,
              gross: L.gross, itemDisc: L.idisc, disc: null, discAmt: L.idisc, note: note, status: 'Chờ thanh toán', pay: '', pager: pager, paidAt: 0, paidDate: '',
              mode: mode === 'night' ? 'Đêm nhạc' : 'Thường', token: '', src: 'NV', cashier: '', createdBy: who(u), log: [],
              ack: { at: now, by: who(u) }, nvName: u.n, nvCode: u.c, nvBy: [u.c], autoPrint: true };
            if (d.togo) o.togo = true;
            if (c.temp) o.tempCode = true;
            act(o, u, 'tao', 'Order tại bàn');
            khoSync(o, id, u);
            C.orders[id] = Object.assign({ id: id }, o); save(db.collection('posOrders').doc(id), o);
            return { ok: true, id: id, code: c.code, added: nAdd, merged: false };
          });
        });
      });
    },
    staffOpen: function () {
      return me().then(function () {
        return posReady().then(function () {
          var now = Date.now(), list = allOrders().filter(function (o) { return o.status === 'Chờ thanh toán' && o.pager && now - (o.created || 0) < 12 * 3600000; })
            .sort(function (a, b) { return (parseInt(a.pager) || 0) - (parseInt(b.pager) || 0); }).map(function (o) { return { code: o.code, pager: o.pager, items: o.items || [] }; });
          return { ok: true, list: list };
        });
      });
    },
    staffMine: function () {
      return me().then(function (u) {
        return posReady().then(function () {
          var d = today(), list = allOrders().filter(function (o) { return o.date === d && (o.nvBy || []).indexOf(u.c) >= 0; })
            .sort(function (a, b) { return b.created - a.created; }).slice(0, 60).map(function (o) { var p = pub(o); p.autoPrint = !!o.autoPrint && kitchenDelta(o.items || [], o.sent).items.length > 0; return p; });
          return { ok: true, list: list };
        });
      });
    },
    /* Máy quầy (bản cài) nhận in đơn NV: giao dịch để 2 máy không in trùng, chỉ in phần món chưa báo bếp */
    cashierAutoPrint: function (tok, id) {
      return me().then(function (u) {
        var ref = db.doc('posOrders/' + String(id));
        return db.runTransaction(function (t) {
          return t.get(ref).then(function (s) {
            if (!s.exists) return null; var o = s.data();
            if (!o.autoPrint || o.status === 'Đã hủy') return null;
            var K = kitchenDelta(o.items || [], o.sent), log = o.log || [];
            if (K.items.length) log = log.concat([{ a: 'bep', by: who(u), at: Date.now(), x: 'tự in (NV order)' }]).slice(-30);
            t.update(ref, { autoPrint: false, sent: K.sent, log: log });
            o.sent = K.sent; o.autoPrint = false; o.log = log;
            return { o: Object.assign({ id: s.id }, o), items: K.items };
          });
        }).then(function (r) {
          if (!r) return { ok: false };
          if (C.orders[id]) C.orders[id] = r.o;
          return { ok: true, order: pub(r.o), items: r.items };
        });
      });
    },
    /* Gộp đơn (Tài yêu cầu 19/11): chuyển hết món của đơn chờ srcId vào đơn chờ id; đơn srcId chuyển "Đã hủy" ghi "gộp vào #mã" */
    /* Xác nhận đơn QR (19/11/2026): thu ngân mở đơn, kiểm tra rồi bấm Xác nhận → trang của khách hiện "Quầy đã nhận đơn" */
    cashierAck: function (tok, id, pager, askPhone) {
      return me().then(function (u) {
        return posReady().then(function () {
          var c = C.orders[id] || (C.pend || {})[id] || (C.debt || {})[id] || C.keep[id];
          var get = c ? Promise.resolve(JSON.parse(JSON.stringify(c))) : db.doc('posOrders/' + id).get().then(function (s) { return s.exists ? Object.assign({ id: s.id }, s.data()) : null; });
          return get.then(function (o) {
            if (!o) return { ok: false, msg: 'Không tìm thấy đơn.' };
            if (o.status !== 'Chờ thanh toán') return { ok: false, msg: 'Đơn này không còn chờ thanh toán.' };
            if (o.ack && o.ack.at) return { ok: true, order: pub(o), data: cashierData(u) };
            /* thẻ rung thu ngân sửa trên đầu đơn trước khi xác nhận */
            delete o.id; o.ack = { at: Date.now(), by: u.n }; if (pager != null) o.pager = clean(pager, 10);
            if (askPhone && !o.pager && !o.phone) o.askPhone = Date.now();
            act(o, u, 'xn', o.pager ? 'thẻ ' + o.pager : o.askPhone ? 'xin SĐT khách' : '');
            C.orders[id] = C.keep[id] = Object.assign({ id: id }, o);
            save(db.doc('posOrders/' + id), o);
            return { ok: true, order: pub(C.orders[id]), data: cashierData(u) };
          });
        });
      });
    },
    /* Báo món xong cho đơn QR (Tài 19/11): trang của khách kêu + rung, báo 1 lần. Dùng được khi đơn chờ thanh toán (thẻ rung) hoặc đã thanh toán */
    cashierReady: function (tok, id) {
      return cashierPatch(id, function (o, u) {
        if (o.status === 'Đã hủy') return 'Đơn này đã hủy.';
        if (o.ready && o.ready.at) return true;
        o.ready = { at: Date.now(), by: u.n }; act(o, u, 'mx');
      });
    },
    /* Cập nhật thẻ rung / SĐT sau khi đã xác nhận hoặc đã thu tiền */
    cashierContact: function (tok, id, pager, phone) {
      return cashierPatch(id, function (o, u) {
        if (o.status === 'Đã hủy') return 'Đơn này đã hủy.';
        var ph = phone == null ? (o.phone || '') : phoneOf(phone); if (ph === null) return 'Số điện thoại chưa đúng.';
        var pg = pager == null ? (o.pager || '') : clean(pager, 10);
        if (pg === (o.pager || '') && ph === (o.phone || '')) return true;
        o.pager = pg; o.phone = ph; act(o, u, 'lh', [pg ? 'thẻ ' + pg : '', ph].filter(Boolean).join(' · '));
      });
    },
    cashierMerge: function (tok, id, srcId) {
      return me().then(function (u) {
        return posReady().then(function () {
          if (!id || !srcId || id === srcId) return { ok: false, msg: 'Chọn đơn khác để gộp.' };
          function load(k) {
            var c = C.orders[k] || (C.pend || {})[k] || C.keep[k];
            return c ? Promise.resolve(JSON.parse(JSON.stringify(c))) : db.doc('posOrders/' + k).get().then(function (s) { return s.exists ? Object.assign({ id: s.id }, s.data()) : null; });
          }
          return Promise.all([load(id), load(srcId)]).then(function (r) {
            var o = r[0], x = r[1];
            if (!o || !x) return { ok: false, msg: 'Không tìm thấy đơn.' };
            if (o.status !== 'Chờ thanh toán' || x.status !== 'Chờ thanh toán') return { ok: false, msg: 'Chỉ gộp được các đơn đang chờ thanh toán.' };
            delete o.id; delete x.id;
            var xf = fixQR(x), menu = qrMenu(o), L = lines((o.items || []).concat(xf.items || []), menu, priceExtra(o, menu).concat(xf.items || []));
            if (!L.items.length) return { ok: false, msg: 'Đơn chưa có món nào.' };
            var A = applyDisc(L, o.disc), sent = {};
            (o.sent || []).concat(x.sent || []).forEach(function (s) { sent[s.k] = (sent[s.k] || 0) + (Number(s.q) || 0); });
            o.items = L.items; o.total = A.total; o.gross = A.gross; o.itemDisc = A.itemDisc; o.disc = A.disc; o.discAmt = A.discAmt;
            o.sent = Object.keys(sent).map(function (k) { return { k: k, q: sent[k] }; }); o.edited = true;
            if (x.note) o.note = clean((o.note ? o.note + ' · ' : '') + x.note, 200);
            if (x.togo) o.togo = true;
            act(o, u, 'gop', '#' + x.code + (x.pager ? ' (thẻ ' + x.pager + ')' : '') + ' · ' + x.total);
            x.status = 'Đã hủy'; x.mergedInto = o.code; x.mergedId = id; act(x, u, 'gop', '→ #' + o.code);
            khoSync(x, srcId, u); khoSync(o, id, u);
            C.orders[id] = C.keep[id] = Object.assign({ id: id }, o);
            C.orders[srcId] = C.keep[srcId] = Object.assign({ id: srcId }, x);
            save(db.doc('posOrders/' + id), o); save(db.doc('posOrders/' + srcId), x);
            dayLater(x.date);
            return { ok: true, order: pub(C.orders[id]), lostDisc: !!(x.disc && x.disc.amt), data: cashierData(u) };
          });
        });
      });
    },
    cashierSetting: function (tok, key, val, ap) {
      return me().then(function (u) {
        return approve(u, ap).then(function (ok) {
          if (!ok.ok) return ok;
          var up = {};
          if (key === 'mode' && ORD_MODES.indexOf(val) >= 0) up.mode = val;
          if (key === 'open') up.qrOpen = !!val;
          if (key === 'float') up.float = Math.max(0, Math.round(Number(val) || 0));
          if (key === 'tables') up.tables = cleanTables(val);
          if (key === 'promos') up.promos = cleanPromos(val);
          if (key === 'events') up.events = cleanEvents(val);
          up.updatedBy = ok.by; up.updatedAt = Date.now();
          var desc = key === 'mode' ? 'Menu: ' + val : key === 'open' ? (val ? 'Bật' : 'Tắt') + ' nhận đơn QR' : key === 'tables' ? 'Sơ đồ bàn: ' + (up.tables || []).map(function (z) { return z.a + ' (' + z.t.length + ')'; }).join(', ')
            : key === 'float' ? 'Quỹ tiền lẻ cố định: ' + up.float
            : key === 'events' ? 'Sự kiện: ' + (up.events || []).map(function (x) { return x.n; }).join(', ')
            : key === 'promos' ? 'Khuyến mãi: ' + (up.promos || []).map(function (x) { return x.n + ' ' + (x.t === '%' ? x.v + '%' : x.v + 'đ'); }).join(', ') : key;
          logReview(u, 'Đổi cài đặt', null, 0, '', desc);
          C.cfg = Object.assign({}, cfg(), up);
          save(db.doc('config/pos'), up, true);
          return posReady().then(function () { return cashierData(u); });
        });
      });
    },
    shiftOpen: function (tok, cash, note) {
      return me().then(function (u) {
        return posReady().then(function () {
          if (!openShiftOf(u.c)) {
            var id = uid('CA'), s = { code: u.c, name: u.n, role: u.r === 'manager' ? 'Quản lý' : 'Thu ngân', date: today(), openAt: Date.now(),
              openCash: Math.max(0, Math.round(Number(cash) || 0)), float: floatCfg(), openNote: clean(note, 200), closeAt: 0, status: 'Đang mở' };
            C.shifts = (C.shifts || []).concat([Object.assign({ id: id }, s)]);
            save(db.collection('posShifts').doc(id), s);
          }
          return { ok: true, data: cashierData(u) };
        });
      });
    },
    cashierExpCats: function () {
      return db.doc('config/fin').get().then(function (d) { var f = d.exists ? d.data() : {}; var c = (f.chi || []).map(function (x) { return x.name; }).filter(function (n) { return n && !/^(Lương|Thưởng|Đầu tư|Nhân công|Chi cá nhân|Trả nhà cung cấp|Chênh lệch|Thuê mặt bằng)/.test(n); }); return { ok: true, cats: c }; })
        .catch(function () { return { ok: true, cats: ['Mua nguyên liệu nhập kho', 'Vật tư tiêu hao (ly, ống hút, túi)', 'Gas', 'Vận chuyển', 'Chi khác'] }; });
    },
    cashierExpense: function (tok, cat, amount, note) {
      return me().then(function (u) {
        return posReady().then(function () {
          var s = openShiftOf(u.c); if (!s) return { ok: false, msg: 'Bạn chưa mở ca nào.' };
          var a = Math.round(Number(amount) || 0); if (a < 1000 || a > 50000000) return { ok: false, msg: 'Số tiền không hợp lệ.' };
          var n = clean(note, 200); if (n.length < 3) return { ok: false, msg: 'Ghi rõ chi cho việc gì.' };
          var c = clean(cat, 80) || 'Chi khác';
          return db.doc('config/fin').get().then(function (d) { var f = d.exists ? d.data() : {}; var k = (f.chi || []).filter(function (x) { return x.name === c; })[0]; return k ? k.pl !== false : true; }, function () { return true; }).then(function (pl) {
            var id = 'kc-' + s.id + '-' + Date.now().toString(36);
            var doc = { date: today(), type: 'chi', cat: c, amount: a, method: 'tm', acct: 'Tiền mặt', note: n + ' · chi từ két (app thu ngân)', photos: [], by: u.c, byName: u.n, status: 'cho_duyet', pl: pl, src: 'pos', shiftId: s.id, at: Date.now() };
            kExpLoad(s.id); (KX[s.id] = KX[s.id] || []).push(Object.assign({ id: id }, doc));
            return db.doc('cash/' + id).set(doc).then(function () { return { ok: true, id: id }; });
          });
        });
      });
    },
    shiftClose: function (tok, counted, note, bills, why) {
      return me().then(function (u) {
        return posReady().then(function () {
          var s = openShiftOf(u.c); if (!s) return { ok: false, msg: 'Bạn chưa mở ca nào.' };
          var now = Date.now();
          var src = s.openAt >= Date.now() - 30 * 3600000 ? Promise.resolve(allOrders())
            : db.collection('posOrders').where('created', '>=', s.openAt - 24 * 3600000).get().then(function (q) { var a = []; q.forEach(function (d) { a.push(d.data()); }); return a; });
          return Promise.all([src, db.collection('cash').where('shiftId', '==', s.id).get().catch(function () { return null; })]).then(function (rr) {
            var all = rr[0], ex = 0;
            if (rr[1]) rr[1].forEach(function (d) { var x = d.data(); if (x.type === 'chi' && x.src === 'pos' && x.status !== 'tu_choi' && x.status !== 'xoa') ex += +x.amount || 0; }); else ex = kExpSum(s.id);
            /* đếm theo mệnh giá (Tài 21/11): có bảng tờ thì tổng tiền đếm = tổng bảng */
            var bl = null; if (bills && typeof bills === 'object') { bl = {}; [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000, 500].forEach(function (v) { var n = Math.max(0, Math.min(9999, Math.round(Number(bills[v]) || 0))); if (n) bl[v] = n; }); counted = Object.keys(bl).reduce(function (a, v) { return a + v * bl[v]; }, 0); }
            var t = sumFor(all, u.c, s.openAt, now + 1), expect = s.openCash + t.cash - ex, c = Math.max(0, Math.round(Number(counted) || 0));
            var fl = s.float != null ? s.float : floatCfg();
            /* tách: quỹ cố định để lại tủ · tiền mặt thu thực tế (đếm − tiền đầu ca) so với tiền mặt thu theo app · tiền nộp (đếm − quỹ) */
            var up = { closeAt: now, orders: t.orders, revenue: t.revenue, cash: t.cash, transfer: t.transfer, expect: expect, counted: c, diff: c - expect,
              float: fl, cashActual: c - s.openCash, handover: Math.max(0, c - fl), keep: Math.min(c, fl),
              cancels: t.cancels, refunds: t.refunds, refundAmt: t.refundAmt, unpaid: t.unpaid, unpaidAmt: t.unpaidAmt, note: clean(note, 200), status: 'Đã kết' };
            if (bl) up.bills = bl;
            up.exp = ex;
            /* lệch từ 20.000đ phải chọn lý do (Tài 22/11) */
            var W = why && typeof why === 'object' ? { k: ['chi', 'sai', 'chuaro'].indexOf(why.k) >= 0 ? why.k : 'chuaro', t: clean(why.t, 200) } : null;
            if (Math.abs(up.diff) >= 20000 && !W) return { ok: false, needWhy: true, diff: up.diff, msg: 'Tiền lệch ' + up.diff.toLocaleString('vi-VN') + 'đ – chọn lý do lệch.' };
            if (W) up.why = W;
            C.shifts = (C.shifts || []).filter(function (x) { return x.id !== s.id; });
            save(db.doc('posShifts/' + s.id), up, true);
            // tính lại doanh thu ngày cho báo cáo Web vận hành (phòng đơn cuối chưa kịp tính)
            rebuildDay(today()); if (ymdOf(s.openAt) !== today()) rebuildDay(ymdOf(s.openAt));
            return { ok: true, report: Object.assign({ id: s.id, code: u.c, name: u.n, openAt: s.openAt, openCash: s.openCash, openNote: s.openNote || '' }, up) };
          });
        });
      });
    },
    posReport: function (tok, date) {
      return me().then(function (u) {
        date = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : today();
        var mgr = u.r === 'manager';
        return Promise.all([
          db.collection('posOrders').where('date', '==', date).get(),
          db.collection('posOrders').where('paidDate', '==', date).get(),
          db.collection('posShifts').where('date', '==', date).get()
        ]).then(function (r) {
          var m = {}; [r[0], r[1]].forEach(function (q) { q.forEach(function (d) { m[d.id] = Object.assign({ id: d.id }, d.data()); }); });
          var all = Object.keys(m).map(function (k) { return m[k]; });
          var mine = function (o) { return mgr || byCode(o.cashier, u.c); };
          var paid = all.filter(function (o) { return o.status === 'Đã thanh toán' && (o.paidDate || o.date) === date && mine(o); });
          var sum = function (a) { return a.reduce(function (s, o) { return s + o.total; }, 0); };
          var cashiers = {}, items = {}, hours = {};
          paid.forEach(function (o) {
            var k = o.cashier || '(không rõ)', c = cashiers[k] || (cashiers[k] = { name: k, orders: 0, revenue: 0, cash: 0, transfer: 0 });
            var cp = payParts(o); c.orders++; c.revenue += o.total; c.transfer += cp.ck; c.cash += cp.cash;
            (o.items || []).forEach(function (i) { var it = items[i.n] || (items[i.n] = { n: i.n, g: i.g, q: 0, a: 0 }); it.q += i.q; it.a += i.p * i.q - (i.da || 0); });
            var h = hhOf(o.paidAt), hh = hours[h] || (hours[h] = { h: h, orders: 0, revenue: 0 }); hh.orders++; hh.revenue += o.total;
          });
          var cancels = all.filter(function (o) { return o.status === 'Đã hủy' && !o.mergedInto && (o.refundAt ? o.paidDate === date : o.date === date); }).map(function (o) {
            var l = (o.log || []).filter(function (x) { return x.a === 'huy' || x.a === 'hoan'; }).pop() || {};
            return { code: o.code, name: o.name, total: o.total, src: o.refundAt ? 'Hoàn tiền (' + (o.pay || '') + ')' : o.src, by: l.by || (o.src === 'QR' ? 'Khách tự hủy' : ''), at: l.at || 0, x: l.x || '' };
          }).filter(function (c) { return mgr || byCode(c.by, u.c); });
          var shifts = [];
          r[2].forEach(function (d) {
            var s = Object.assign({ id: d.id }, d.data()); if (!mgr && s.code !== u.c) return;
            if (s.status === 'Đang mở') { var mm = {}; allOrders().concat(all).forEach(function (x) { mm[x.id] = x; }); var t = sumFor(Object.keys(mm).map(function (k) { return mm[k]; }), s.code, s.openAt, Date.now() + 60000); s.orders = t.orders; s.revenue = t.revenue; s.cash = t.cash; s.transfer = t.transfer; s.cancels = t.cancels; s.refunds = t.refunds; s.refundAmt = t.refundAmt; s.expect = s.openCash + t.cash; }
            shifts.push(s);
          });
          shifts.sort(function (a, b) { return a.openAt - b.openAt; });
          return { date: date, scope: mgr ? 'all' : 'mine', me: { code: u.c, name: u.n, role: u.r },
            discounts: paid.filter(function (o) { return o.discAmt > 0; }).map(function (o) { return { code: o.code, name: o.name, gross: o.gross || o.total, amt: o.discAmt, total: o.total, why: o.disc ? (o.disc.promo || o.disc.r || '') : 'Giảm giá món', by: o.disc && o.disc.by || o.cashier || '' }; }),
            total: { orders: paid.length, revenue: sum(paid), disc: paid.reduce(function (s, o) { return s + (o.discAmt || 0); }, 0), cash: paid.reduce(function (s, o) { return s + payParts(o).cash; }, 0),
              transfer: paid.reduce(function (s, o) { return s + payParts(o).ck; }, 0), qr: paid.filter(function (o) { return o.src !== 'Quầy'; }).length,
              pending: mgr ? all.filter(function (o) { return o.status === 'Chờ thanh toán'; }).length : 0 },
            cashiers: Object.keys(cashiers).map(function (k) { return cashiers[k]; }).sort(function (a, b) { return b.revenue - a.revenue; }),
            items: Object.keys(items).map(function (k) { return items[k]; }).sort(function (a, b) { return b.a - a.a; }).slice(0, 15),
            hours: Object.keys(hours).sort().map(function (k) { return hours[k]; }),
            unpaid: all.filter(function (o) { return o.status === 'Chưa thu' || (o.unpaid && o.unpaid.paidAt); }).filter(function (o) { return mgr || byCode(o.unpaid.by, u.c); }).map(function (o) {
              return { id: o.id, code: o.code, name: o.name, total: o.total, by: o.unpaid.by || '', why: o.unpaid.why || '', at: o.unpaid.at || 0, pager: o.unpaid.pager || '', paidAt: o.unpaid.paidAt || 0, paidBy: o.unpaid.paidBy || '' }; }),
            cancels: cancels, shifts: shifts };
        });
      });
    },

    /* ===== Quản lý menu (quản lý) ===== */
    getMenuAdmin: function () {
      return me().then(function (u) { return wantCfg().then(function () { return { me: { code: u.c, name: u.n, role: u.r }, normal: C.menu.normal || [], night: C.menu.night || [], mode: modeSetting() }; }); });
    },
    saveMenu: function (tok, key, items, ap) {
      return me().then(function (u) {
        return approve(u, ap).then(function (ok) {
          if (!ok.ok) return ok;
          if (key !== 'normal' && key !== 'night') return { ok: false, msg: 'Bảng giá không hợp lệ.' };
          var seen = {}, out = [];
          (Array.isArray(items) ? items : []).slice(0, 300).forEach(function (m) {
            var n = clean(m && m.n, 80), p = Math.round(Number(m && m.p) || 0), g = clean(m && m.g, 40) || 'Khác';
            if (!n || seen[n.toLowerCase()]) return; seen[n.toLowerCase()] = 1;
            var o = { g: g, n: n, p: Math.max(0, p), on: m.on !== false };
            if (m.dg) o.dg = clean(m.dg, 40); if (m.b) o.b = clean(m.b, 80); if (m.s) o.s = clean(m.s, 40);
            if (m.img && /^https:\/\//.test(m.img)) o.img = String(m.img).slice(0, 300); if (m.vid) o.vid = clean(m.vid, 60);
            if (+m.r > 0) o.r = Math.round(+m.r); if (m.nq) o.nq = true;
            out.push(o);
          });
          C.menu[key] = out;
          return db.doc('posMenu/' + key).set({ items: out, updatedBy: ok.by, updatedAt: Date.now() }).then(function () { return { ok: true, count: out.length }; });
        });
      });
    },
    checkApprove: function (tok, ap) { return me().then(function (u) { return approve(u, ap); }); },
    rebuildRevenue: function (tok, date) { return me().then(function () { return rebuildDay(date || today()); }).then(function () { return { ok: true }; }); },

    /* ===== Đăng ký bài hát / quầy nhạc ===== */
    getQueue: function (pin) {
      return Promise.all([wantCfg(), wantSongs()]).then(function () { return isAdmin(pin); }).then(function (admin) {
        var all = C.songs || [], start = startOfDay();
        var pick = function (r) {
          var o = { id: r.id, kind: r.kind, name: r.name, song: r.song, artist: r.artist, status: r.status };
          if (admin) { o.place = r.place; o.note = r.note; o.time = r.time; }
          return o;
        };
        var out = { open: cfg().songOpen !== false,
          playing: all.filter(function (r) { return r.status === 'Đang phát'; }).map(pick),
          waiting: all.filter(function (r) { return r.status === 'Chờ'; }).map(pick) };
        if (!admin) return out;
        // dọn bài còn chờ từ hôm trước
        all.forEach(function (r) { if ((r.status === 'Chờ' || r.status === 'Đang phát') && r.time < start) { r.status = 'Bỏ qua'; save(db.doc('songReq/' + r.id), { status: 'Bỏ qua' }, true); } });
        out.playing = all.filter(function (r) { return r.status === 'Đang phát'; }).map(pick);
        out.waiting = all.filter(function (r) { return r.status === 'Chờ'; }).map(pick);
        return wantAdmin().then(function () {
          out.doneToday = all.filter(function (r) { return r.status === 'Đã phát' && r.time >= start; }).length;
          var fb = C.fb || [];
          out.fbToday = fb.length;
          out.alerts = fb.filter(function (f) { return !f.done; }).map(function (f) { return { row: f.id, time: f.time, star: f.star || 0, text: f.text, name: f.name || '', phone: f.phone || '' }; });
          var d = today();
          out.bookings = (C.bk || []).filter(function (b) { return b.date >= d && (b.status === 'Chờ xác nhận' || b.status === 'Đã xác nhận'); })
            .sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
          return out;
        });
      });
    },
    submitRequest: function (d) {
      d = d || {};
      var song = clean(d.song, 100);
      if (!song) return Promise.resolve({ ok: false, msg: 'Bạn nhập tên bài hát giúp Chata nhé.' });
      var isReq = d.kind === 'yeucau';
      if (!isReq && !clean(d.name, 40)) return Promise.resolve({ ok: false, msg: 'Bạn ghi tên để ban nhạc mời bạn lên hát nhé.' });
      return Promise.all([wantCfg(), wantSongs()]).then(function () {
        if (cfg().songOpen === false) return { ok: false, msg: 'Quầy nhạc đang tạm ngưng nhận bài. Bạn quay lại sau nhé!' };
        var active = (C.songs || []).filter(function (r) { return r.status === 'Chờ' || r.status === 'Đang phát'; });
        if (active.some(function (r) { return norm(r.song) === norm(song); })) return { ok: false, msg: 'Bài này đã có trong danh sách rồi, sắp tới lượt nha! 🎶' };
        var waiting = active.filter(function (r) { return r.status === 'Chờ'; }).length;
        if (waiting >= MAX_QUEUE) return { ok: false, msg: 'Danh sách đang đầy, bạn thử lại sau ít phút nhé.' };
        var id = uid('R');
        return db.doc('songReq/' + id).set({ time: Date.now(), name: clean(d.name, 40), place: clean(d.place, 40), song: song, artist: clean(d.artist, 60),
          note: clean(d.note, 150), status: 'Chờ', kind: isReq ? 'yeucau' : 'hat' }).then(function () { return { ok: true, pos: waiting + 1 }; });
      });
    },
    submitFeedback: function (d) {
      d = d || {};
      var text = clean(d.text, 500); if (!text) return Promise.resolve({ ok: false, msg: 'Bạn viết vài dòng góp ý giúp Chata nhé.' });
      var star = Math.round(Number(d.star) || 0); if (star < 1 || star > 5) star = 0;
      var phone = String(d.phone || '').replace(/[^\d+ ]/g, '').trim().slice(0, 15), dg = phone.replace(/\D/g, '');
      if (phone && (dg.length < 9 || dg.length > 12)) return Promise.resolve({ ok: false, msg: 'Số điện thoại chưa đúng, bạn kiểm tra lại giúp Chata nhé.' });
      return ready.then(function () { return db.collection('songFb').doc(uid('F')).set({ time: Date.now(), star: star, text: text, name: clean(d.name, 40), phone: phone, done: '' }); })
        .then(function () { return { ok: true }; });
    },
    adminLogin: function () { return Promise.resolve({ ok: false, msg: 'Quầy nhạc giờ đăng nhập bằng mã nhân viên + PIN (như Web vận hành).' }); },
    bandLogin: function (code, pin) {
      code = String(code || '').trim().toUpperCase(); pin = String(pin || '').trim();
      if (!pin) return Promise.resolve({ ok: false, msg: 'Nhập PIN của bạn.' });
      return ready.then(function () {
        return fnCall('dangNhap', code ? { code: code, pin: pin } : { role: 'manager', pin: pin });
      }).then(function (r) {
        if (!r.ok) return r;
        if (code && r.r.noPin) return { ok: false, msg: 'Bạn chưa có PIN. Nhờ quản lý cấp PIN trong Web vận hành.' };
        return auth.signInWithCustomToken(r.r.token).then(function () {
          resetSubs();
          if (!code) return { c: r.r.code || 'QL', n: r.r.name || 'Quản lý' };
          return staffDoc(r.r.code || code).then(function (st) { return st && st.active ? { c: st.code, n: st.name } : null; });
        }).then(function (u) {
          if (!u) return auth.signOut().then(function () { return auth.signInAnonymously(); }).then(function () { return { ok: false, msg: 'Tài khoản này đã nghỉ hoặc bị tắt.' }; });
          try { localStorage.setItem(BAND_KEY, JSON.stringify({ c: u.c, n: u.n, uid: auth.currentUser.uid })); } catch (e) {}
          return { ok: true, me: { code: u.c, name: u.n } };
        });
      });
    },
    bandLogout: function () {
      try { localStorage.removeItem(BAND_KEY); } catch (e) {}
      return ready.then(function () { resetSubs(); return auth.signOut(); }).then(function () { return auth.signInAnonymously(); }).then(function () { return { ok: true }; }, function () { return { ok: true }; });
    },
    bandMe: function () { return isAdmin().then(function (ok) { var b = ok && getBand(); return b ? { ok: true, me: { code: b.c, name: b.n } } : { ok: false }; }); },
    adminSetStatus: function (pin, id, status) {
      return needAdmin(pin).then(function () {
        if (STATUSES.indexOf(status) < 0) throw new Error('Trạng thái không hợp lệ');
        var b = db.batch();
        if (status === 'Đang phát') (C.songs || []).forEach(function (r) { if (r.status === 'Đang phát' && r.id !== id) { r.status = 'Đã phát'; b.set(db.doc('songReq/' + r.id), { status: 'Đã phát' }, { merge: true }); } });
        (C.songs || []).forEach(function (r) { if (r.id === id) r.status = status; });
        b.set(db.doc('songReq/' + id), { status: status }, { merge: true });
        b.commit().catch(function (e) { console.error(e); });
        return API.getQueue(pin);
      });
    },
    adminAckFeedback: function (pin, row) {
      return needAdmin(pin).then(function () {
        var t = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date());
        (C.fb || []).forEach(function (f) { if (f.id === row) f.done = 'Đã xử lý ' + t; });
        save(db.doc('songFb/' + String(row)), { done: 'Đã xử lý ' + t }, true);
        return API.getQueue(pin);
      });
    },
    adminSetOpen: function (pin, open) {
      return needAdmin(pin).then(function () { C.cfg = Object.assign({}, cfg(), { songOpen: !!open }); save(db.doc('config/pos'), { songOpen: !!open }, true); return API.getQueue(pin); });
    },
    getMenu: function () { return wantCfg().then(function () { return { menu: menuFor('night'), areas: BK_AREAS, tuesdays: nextTuesdays(8) }; }); },
    submitBooking: function (d) {
      d = d || {};
      var name = clean(d.name, 40); if (!name) return Promise.resolve({ ok: false, msg: 'Bạn cho Chata xin tên để giữ bàn nhé.' });
      var phone = String(d.phone || '').replace(/[^\d+ ]/g, '').trim().slice(0, 15), digits = phone.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 12) return Promise.resolve({ ok: false, msg: 'Số điện thoại chưa đúng, bạn kiểm tra lại giúp Chata nhé.' });
      var date = String(d.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Promise.resolve({ ok: false, msg: 'Bạn chọn ngày đến giúp Chata nhé.' });
      var max = ymdOf(Date.now() + 60 * 86400000);
      if (date < today() || date > max) return Promise.resolve({ ok: false, msg: 'Ngày đến chưa hợp lệ, bạn chọn lại giúp Chata nhé.' });
      if (new Date(date + 'T12:00:00Z').getUTCDay() !== 2) return Promise.resolve({ ok: false, msg: 'Đêm nhạc diễn ra tối thứ 3, bạn chọn ngày thứ 3 giúp Chata nhé.' });
      var time = String(d.time || '');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return Promise.resolve({ ok: false, msg: 'Bạn chọn giờ đến giúp Chata nhé.' });
      var people = Math.round(Number(d.people) || 0);
      if (people < 1 || people > 50) return Promise.resolve({ ok: false, msg: 'Số người từ 1 đến 50 nhé. Đoàn đông hơn bạn nhắn Fanpage giúp Chata.' });
      var area = BK_AREAS.indexOf(d.area) >= 0 ? d.area : BK_AREAS[0];
      return wantCfg().then(function () {
        var by = {}; menuFor('night').forEach(function (m) { by[m.n] = m; });
        var items = [], total = 0;
        (Array.isArray(d.items) ? d.items : []).slice(0, 40).forEach(function (it) {
          var m = by[String(it && it.n || '')], q = Math.round(Number(it && it.q) || 0);
          if (!m || q < 1 || q > 30) return; items.push(q + '× ' + m.n + ' (' + (m.p / 1000) + 'k)'); total += q * m.p;
        });
        // Chống đặt trùng: mỗi SĐT + ngày một khóa (posBookingKeys), khách không cần đọc danh sách đặt bàn của người khác
        var key = db.doc('posBookingKeys/' + digits + '_' + date), id = uid('B');
        return key.get().then(function (k) {
          if (k.exists && k.data().active !== false) return { ok: false, msg: 'Số điện thoại này đã có đơn đặt bàn cho ngày đó rồi. Cần đổi gì bạn nhắn Fanpage Chata nhé.' };
          var b = db.batch();
          b.set(key, { id: id, date: date, at: Date.now(), active: true });
          b.set(db.doc('posBookings/' + id), { created: Date.now(), name: name, phone: phone, phoneDigits: digits, date: date, time: time, people: people, area: area,
            items: items.join('\n'), total: total, note: clean(d.note, 200), status: 'Chờ xác nhận', doneAt: '' });
          return b.commit().then(function () { return { ok: true, id: id, total: total }; });
        }, function () { return { ok: false, msg: 'Mạng đang chập chờn, bạn thử gửi lại nhé.' }; });
      });
    },
    adminSetBooking: function (pin, id, status) {
      return needAdmin(pin).then(function () {
        if (BK_STATUSES.indexOf(status) < 0) throw new Error('Trạng thái không hợp lệ');
        var t = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date());
        var bk = null; (C.bk || []).forEach(function (b) { if (b.id === id) { b.status = status; bk = b; } });
        save(db.doc('posBookings/' + id), { status: status, doneAt: t }, true);
        if (bk && bk.phoneDigits && bk.date) save(db.doc('posBookingKeys/' + bk.phoneDigits + '_' + bk.date), { active: status !== 'Đã hủy' }, true);
        return API.getQueue(pin);
      });
    }
  };
  function nextTuesdays(n) { var out = []; for (var i = 0; out.length < n && i < 70; i++) { var s = ymdOf(Date.now() + i * 86400000); if (new Date(s + 'T12:00:00Z').getUTCDay() === 2) out.push(s); } return out; }
  // Quầy nhạc (từ 18/11/2026): đăng nhập bằng mã nhân viên + PIN (hoặc PIN quản lý), không còn mã quầy chung
  function isAdmin(flag) {
    if (arguments.length && !flag) return Promise.resolve(false);   // trang khách gọi getQueue('') → không phải quầy nhạc
    return ready.then(function () { var u = auth.currentUser; return !!(u && !u.isAnonymous && getBand()); });
  }
  function needAdmin() { return isAdmin().then(function (ok) { if (!ok) throw new Error('Phiên quầy nhạc đã hết, đăng nhập lại'); }); }
  var BAND_KEY = 'chata_band_ses';
  function getBand() {
    try { var b = JSON.parse(localStorage.getItem(BAND_KEY) || 'null'); var u = auth && auth.currentUser; return b && u && b.uid === u.uid ? b : null; } catch (e) { return null; }
  }

  window.ChataAPI = {
    ready: ready,
    call: function (fn, args) {
      var f = API[fn]; if (!f) return Promise.reject(new Error('Yêu cầu không hợp lệ'));
      return Promise.resolve().then(function () { return f.apply(null, Array.isArray(args) ? args : []); });
    },
    onChange: function (f) { listeners.push(f); },
    onError: null,
    online: function () { return navigator.onLine; },
    _db: function () { return db; }, _auth: function () { return auth; }, _sha: sha256, _C: C, _today: today
  };
})();
