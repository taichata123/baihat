/* Chata – thư viện nhẹ cho trang gọi món QR (20/11/2026)
 * Thay chata-api.js trên goimon.html: không tải Firebase SDK, không đăng nhập ẩn danh.
 * Mọi yêu cầu gửi tới hàm goiMon (Cloud Functions, Singapore). */
(function () {
  var URL = 'https://asia-southeast1-chata-checklist.cloudfunctions.net/goiMon';
  function req(body, get) {
    var ctl = window.AbortController ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    var p = get ? fetch(URL + '?a=' + encodeURIComponent(body.a), { signal: ctl && ctl.signal })
      /* text/plain = "yêu cầu đơn giản", trình duyệt không phải hỏi trước (OPTIONS) → nhanh hơn 1 vòng mạng */
      : fetch(URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), signal: ctl && ctl.signal });
    return p.then(function (r) { clearTimeout(to); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }, function (e) { clearTimeout(to); throw e; });
  }
  function retry(f) { return f().catch(function () { return new Promise(function (ok) { setTimeout(ok, 1200); }).then(f); }); }
  var cid = '';
  try { cid = localStorage.getItem('chata_cid') || ''; if (!cid) { cid = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('chata_cid', cid); } } catch (e) {}
  var MK = 'chata_menu_c';
  var API = {
    getOrderMenu: function () {
      return retry(function () { return req({ a: 'menu' }, true); }).then(function (d) {
        try { sessionStorage.setItem(MK, JSON.stringify({ at: Date.now(), d: d })); } catch (e) {}
        return d;
      }, function (e) {
        try { var c = JSON.parse(sessionStorage.getItem(MK) || 'null'); if (c && c.d) return c.d; } catch (x) {}
        throw e;
      });
    },
    submitOrder: function (d) { d = d || {}; return req({ a: 'submit', name: d.name, phone: d.phone, pager: d.pager, note: d.note, items: d.items, cid: cid }); },
    getMyOrder: function (id, token) { return retry(function () { return req({ a: 'my', id: id, token: token }); }); },
    setMyPhone: function (id, token, phone) { return req({ a: 'phone', id: id, token: token, phone: phone }); },
    cancelMyOrder: function (id, token) { return req({ a: 'cancel', id: id, token: token }); }
  };
  window.ChataAPI = {
    call: function (fn, args) {
      var f = API[fn]; if (!f) return Promise.reject(new Error('Yêu cầu không hợp lệ'));
      return Promise.resolve().then(function () { return f.apply(null, Array.isArray(args) ? args : []); });
    }
  };
})();
