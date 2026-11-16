// ==UserScript==
// @name         Zalo Web Privacy
// @namespace    zalo-privacy
// @version      0.9.0
// @description  Chặn seen/typing/thu hồi/analytics + xem tin thu hồi
// @match        https://chat.zalo.me/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const DEFAULTS = {
    BLOCK_SEEN:       true,
    BLOCK_TYPING:     true,
    BLOCK_DELIVERED:  false,
    ANTI_RECALL:      true,
    BLOCK_ANALYTICS:  true,
    BLOCK_PRESENCE:   true,
    BLOCK_STICKER_AI: false,
    BLOCK_TENOR:      false,
    BLOCK_ACTIONLOG:  true,
    BLOCK_REACT_SEEN: false,
    DEBUG:            false,
  };
  const LS_KEY = 'zpPrivCfg';
  let CFG;
  try { CFG = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY))); }
  catch { CFG = Object.assign({}, DEFAULTS); }
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(CFG)); } catch {} };

  // ── Khóa màn hình (PIN) ──────────────────────────────────────────────────────
  const PIN_KEY = 'zpPin', LOCK_KEY = 'zpLocked';
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  let lockStyleEl = null;

  // Ẩn toàn bộ trang (trừ panel) ngay khi khóa, kể cả lúc F5 chưa dựng xong overlay
  function setLocked(on) {
    lsSet(LOCK_KEY, on ? '1' : null);
    if (on && !lockStyleEl) {
      lockStyleEl = document.createElement('style');
      lockStyleEl.textContent = 'body > *:not(#zp-root){visibility:hidden!important}';
      (document.head || document.documentElement).appendChild(lockStyleEl);
    } else if (!on && lockStyleEl) { lockStyleEl.remove(); lockStyleEl = null; }
  }

  async function hashPin(pin, salt) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
    return btoa(String.fromCharCode(...new Uint8Array(bits)));
  }

  if (lsGet(LOCK_KEY) === '1') { if (lsGet(PIN_KEY)) setLocked(true); else lsSet(LOCK_KEY, null); }

  // ── Recall history ───────────────────────────────────────────────────────────
  const recallHistory = [];
  let recallBadgeEl = null, recallListEl = null, _recallHook = null;

  function addRecall(text, note) {
    const item = {
      text: (text || '').trim().slice(0, 300) || null,
      note,
      ts: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    };
    recallHistory.unshift(item);
    if (recallHistory.length > 60) recallHistory.pop();
    if (recallBadgeEl) { recallBadgeEl.textContent = recallHistory.length; recallBadgeEl.hidden = false; }
    if (recallListEl) renderRecallList();
    if (_recallHook) _recallHook();
    if (CFG.DEBUG) console.info('[ZaloPriv] RECALL saved:', item);
  }

  function renderRecallList() {
    if (!recallListEl) return;
    if (!recallHistory.length) { recallListEl.innerHTML = '<div class="zp-empty">Chưa có tin thu hồi nào</div>'; return; }
    recallListEl.innerHTML = recallHistory.map((r) => {
      const isWs = /WS/i.test(r.note);
      return `<div class="zp-ri${isWs ? ' zp-ri-ws' : ''}">
        <div class="zp-ri-top">
          <span class="zp-ri-ts">${r.ts}</span>
          <span class="zp-ri-src ${isWs ? 'zp-ri-src-ws' : 'zp-ri-src-dom'}">${esc(r.note)}</span>
        </div>
        ${r.text ? `<div class="zp-ri-txt">${esc(r.text)}</div>` : '<div class="zp-ri-na">✓ Đã chặn · tin vẫn hiển thị trong chat</div>'}
      </div>`;
    }).join('');
  }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ── Log buffers ──────────────────────────────────────────────────────────────
  const httpLog = [], wsLog = [];
  let httpEl = null, wsEl = null;
  const NOISE = /giphy\/trending|\/thumbnail|\/avatar/i;

  let httpOnlyBlocked = false;
  const httpView = () => (httpOnlyBlocked ? httpLog.filter((l) => l.startsWith('🔴')) : httpLog);
  function renderHttp() {
    if (httpEl) httpEl.textContent = httpView().join('\n') || (httpOnlyBlocked ? '(không có)' : '(chưa có)');
  }

  function logHttp(url, blocked, name) {
    if (!CFG.DEBUG) return;
    let path; try { path = new URL(url, location.href).pathname; } catch { path = url; }
    if (!blocked && NOISE.test(path)) return;
    const line = blocked ? `🔴 ${name.padEnd(12)} ${path}` : `⬜ pass         ${path}`;
    httpLog.unshift(line);
    if (httpLog.length > 80) httpLog.pop();
    renderHttp();
  }

  // Zalo đóng gói JSON trong binary frame có prefix bytes → tìm '{' để parse (1 lần/frame)
  function extractJson(raw) {
    if (typeof raw !== 'string') return null;
    const i = raw.indexOf('{');
    if (i < 0) return null;
    const s = i ? raw.slice(i) : raw;
    try { const d = JSON.parse(s); return d && typeof d === 'object' ? { d, s } : null; } catch { return null; }
  }

  // p = kết quả extractJson (hoặc null); out = frame gửi đi
  function logWs(raw, p, out) {
    if (!wsEl) return;
    let line;
    if (p) {
      const { d, s } = p;
      const prefix = d.encrypt === 1 ? '[gz] ' : d.encrypt === 2 ? '[enc] ' : '';
      line = `${out ? '↑ ' : isRecall(p) ? '🔴 RECALL  ' : '⬜ '}${prefix}cmd:${String(d.cmd ?? '—').padEnd(5)}  ${s.slice(0, 85)}`;
    } else { line = `${out ? '↑ ' : ''}[bin] ${raw.slice(0, 95)}`; }
    wsLog.unshift(line);
    if (wsLog.length > 80) wsLog.pop();
    wsEl.textContent = wsLog.join('\n');
  }

  // ── HTTP intercept ───────────────────────────────────────────────────────────
  const HTTP_RULES = [
    { key: 'BLOCK_SEEN',       name: 'seen',       re: /\/api\/(?:message|group|subtab)\/seen(?:v2)?(?:[/?#]|$)/i },
    { key: 'BLOCK_TYPING',     name: 'typing',     re: /\/api\/(?:message|group)\/typing(?:[/?#]|$)/i },
    { key: 'BLOCK_DELIVERED',  name: 'delivered',  re: /\/api\/(?:message|group)\/delivered(?:v2)?(?:[/?#]|$)/i },
    { key: 'BLOCK_ANALYTICS',  name: 'analytics',  re: /google-analytics|firebaseapp|analytics\.google|googletagmanager|firebaselogging-pa/i },
    { key: 'BLOCK_PRESENCE',   name: 'presence',   re: /\/api\/social\/profile\/ping(?:[/?#]|$)/i },
    { key: 'BLOCK_STICKER_AI', name: 'sticker-ai', re: /\/api\/message\/sticker\/(?:suggest|personalized)/i },
    { key: 'BLOCK_TENOR',      name: 'tenor',      re: /\/api\/message\/sticker\/tenor\//i },
    // Chặn telemetry hành vi người dùng (clickstream, session events)
    { key: 'BLOCK_ACTIONLOG',  name: 'actionlog',  re: /\/api\/qos\/[^?#]*(?:actionlog|uploadpc|event)/i },
    // Chặn receipt "đã react"
    { key: 'BLOCK_REACT_SEEN', name: 'react-seen', re: /\/api\/(?:message|group)\/react_(?:seen|delivered)(?:[/?#]|$)/i },
  ];
  const FAKE_OK   = JSON.stringify({ error_code: 0, error_message: 'Successful.' });
  const matchRule = (url) => HTTP_RULES.find((r) => CFG[r.key] && r.re.test(url));

  const XHR = XMLHttpRequest.prototype;
  const _open = XHR.open, _send = XHR.send;
  XHR.open = function (_m, url) { this.__zpUrl = String(url); return _open.apply(this, arguments); };
  XHR.send = function () {
    const url = this.__zpUrl || '', rule = matchRule(url);
    if (!rule) { if (/\/api\//.test(url)) logHttp(url, false, ''); return _send.apply(this, arguments); }
    logHttp(url, true, rule.name);
    const xhr = this, def = (k, v) => Object.defineProperty(xhr, k, { configurable: true, get: () => v });
    def('readyState', 4); def('status', 200); def('statusText', 'OK');
    def('responseURL', url); def('responseText', FAKE_OK);
    def('response', xhr.responseType === 'json' ? JSON.parse(FAKE_OK) : FAKE_OK);
    xhr.getAllResponseHeaders = () => 'content-type: application/json\r\n';
    xhr.getResponseHeader = (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null);
    setTimeout(() => ['readystatechange', 'load', 'loadend'].forEach((t) => { try { xhr.dispatchEvent(new Event(t)); } catch {} }), 0);
  };

  const _fetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const rule = matchRule(url);
    if (rule) { logHttp(url, true, rule.name); return Promise.resolve(new Response(FAKE_OK, { status: 200, headers: { 'content-type': 'application/json' } })); }
    if (/\/api\//.test(url)) logHttp(url, false, '');
    return _fetch.apply(this, arguments);
  };

  if (navigator.sendBeacon) {
    const _beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      const rule = matchRule(String(url));
      if (rule) { logHttp(url, true, rule.name + '·bcn'); return true; }
      return _beacon(url, data);
    };
  }

  // ── WebSocket — anti-recall ──────────────────────────────────────────────────
  const OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);

    // Chiều gửi đi: chỉ ghi log khi Debug (frame đã mã hóa nên không lọc được nội dung)
    const _wsSend = ws.send.bind(ws);
    ws.send = function (data) {
      if (CFG.DEBUG && data instanceof ArrayBuffer) {
        const raw = new TextDecoder('utf-8', { fatal: false }).decode(data);
        logWs(raw, extractJson(raw), true);
      }
      return _wsSend(data);
    };

    ws.addEventListener('message', async function (evt) {
      if (!CFG.ANTI_RECALL && !CFG.DEBUG) return;
      let raw = evt.data;

      if (raw instanceof ArrayBuffer) {
        raw = new TextDecoder('utf-8', { fatal: false }).decode(raw);
      } else if (raw instanceof Blob) {
        // async — stopImmediatePropagation se vo hieu sau await, chi ghi log
        const decoded = await evt.data.text().catch(() => `[Blob ${evt.data.size}B]`);
        const pb = extractJson(decoded);
        if (CFG.DEBUG) logWs(decoded, pb);
        if (CFG.ANTI_RECALL && isRecall(pb)) addRecall(null, 'WS Blob (phát hiện muộn)');
        return;
      }

      const p = extractJson(raw);
      if (CFG.DEBUG) logWs(raw, p);
      if (!CFG.ANTI_RECALL || !isRecall(p)) return;
      addRecall(null, 'WS blocked');
      evt.stopImmediatePropagation();
    }, true);
    return ws;
  }
  Object.setPrototypeOf(PatchedWS, OrigWS);
  PatchedWS.prototype = OrigWS.prototype;
  window.WebSocket = PatchedWS;

  // p = kết quả extractJson. Chỉ khớp field chính xác — không quét chữ "undo"/"recall" trong nội dung tin.
  function isRecall(p) {
    if (!p) return false;
    const { d } = p;
    if (d.cmd === 501) return true;
    if (d.ztype === 'undo' || d.action === 'undo') return true;
    const inner = d.data;
    return !!inner && typeof inner === 'object' && (inner.action === 'undo' || inner.type === 'recall' || inner.msgType === 'recall');
  }

  // ── MutationObserver: backup recall detection ────────────────────────────────
  function startDomObserver() {
    // Khớp đúng chuỗi Zalo hiện thị, tránh bắt nhầm menu "Thu hồi tin nhắn"
    const RECALL_TEXT = /tin nhắn đã (?:được|bị) thu hồi/i;
    // Không phải tin nhắn: chỉ có giờ, hoặc chỉ báo "đang soạn"
    const NOT_MSG = /^\d{1,2}:\d{2}$|đang (?:soạn|nhập)|typing/i;
    const recentRemoved = []; // [{text, ts, parent}]

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        // Buoc 1: luu text + parent cua node bi xoa (textContent: khong ep tinh lai layout)
        m.removedNodes.forEach((node) => {
          if (node.nodeType !== 1 || node.childElementCount > 15) return;
          const text = (node.textContent || '').trim();
          if (text.length > 1 && text.length < 2000 && !RECALL_TEXT.test(text) && !NOT_MSG.test(text)) {
            recentRemoved.push({ text, ts: Date.now(), parent: m.target });
            if (recentRemoved.length > 10) recentRemoved.shift();
          }
        });

        // Buoc 2: recall indicator xuat hien — chi tinh la "thu hoi moi" neu co
        // message bi xoa tu cung parent trong vong 350ms (phan biet voi lich su)
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1 || node.childElementCount > 15) return;
          const text = (node.textContent || '').trim();
          if (text.length < 80 && RECALL_TEXT.test(text)) {
            const now = Date.now();
            const idx = recentRemoved.findLastIndex((r) => now - r.ts < 350 && r.parent === m.target);
            if (idx < 0) return; // khong co message bi xoa tu cung parent = thu hoi lich su, bo qua
            const removed = recentRemoved.splice(idx, 1)[0];
            addRecall(removed.text, 'DOM detect');
            if (!node.querySelector('[data-zp-recall]')) {
              const tip = document.createElement('div');
              tip.setAttribute('data-zp-recall', '1');
              tip.style.cssText = 'font-size:11px;color:#94a3b8;padding:3px 8px;background:rgba(0,104,255,.09);border-left:2px solid #0068ff55;border-radius:0 4px 4px 0;margin-top:3px;font-style:italic;word-break:break-word;line-height:1.5;';
              tip.textContent = '🛡 ' + removed.text;
              node.appendChild(tip);
            }
          }
        });
      }
    });

    // Doi Zalo render xong moi bat
    setTimeout(() => {
      obs.observe(document.body, { childList: true, subtree: true });
    }, 3000);
  }

  // ── UI ───────────────────────────────────────────────────────────────────────
  const FEATURES = [
    { key: 'BLOCK_SEEN',       ico: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 3C4.1 3 1 8 1 8s3.1 5 7 5 7-5 7-5-3.1-5-7-5zm0 8.3A3.3 3.3 0 1 1 8 4.7a3.3 3.3 0 0 1 0 6.6zm0-5.3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>`, label: 'Ẩn "Đã xem"' },
    { key: 'BLOCK_TYPING',     ico: `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="4" width="14" height="8" rx="1.5"/><circle cx="4.5" cy="8" r="1" fill="#0a0f1e"/><circle cx="8" cy="8" r="1" fill="#0a0f1e"/><circle cx="11.5" cy="8" r="1" fill="#0a0f1e"/></svg>`, label: 'Ẩn "Đang soạn"' },
    { key: 'BLOCK_DELIVERED',  ico: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4zm1 0v.5l5 3.5 5-3.5V4H3zm0 1.8V12h10V5.8L8 9.1 3 5.8z"/></svg>`, label: 'Ẩn "Đã nhận"' },
    { key: 'ANTI_RECALL',      ico: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a6 6 0 1 0 6 6H12.5A4.5 4.5 0 1 1 8 3.5V2zM7 1l3 2.5L7 6V4.5A5.5 5.5 0 0 0 2.5 8a5.5 5.5 0 0 0 11 0h1A6.5 6.5 0 0 1 8 14.5 6.5 6.5 0 0 1 1.5 8 6.5 6.5 0 0 1 7 1.6V1z"/></svg>`, label: 'Chống thu hồi' },
    { key: 'BLOCK_ANALYTICS',  ico: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h2v9H2zM7 5h2v6H7zM12 7h2v4h-2zM1 13h14v1H1z"/></svg>`, label: 'Chặn Analytics' },
    { key: 'BLOCK_PRESENCE',   ico: `<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="6" r="3"/><path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6H2z"/></svg>`, label: 'Chặn ping online (HTTP)' },
    { key: 'BLOCK_STICKER_AI', ico: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM5 7.5h6v1H5v-1zM6 5h1v1H6V5zm3 0h1v1H9V5zm-3 4.5h1v1H6v-1zm3 0h1v1H9v-1z"/></svg>`, label: 'Chặn Sticker AI (đọc tin)' },
    { key: 'BLOCK_TENOR',      ico: `<svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="3" width="14" height="10" rx="1.5"/><path fill="#0a0f1e" d="M4 6h8v1H4zm0 2h5v1H4z"/></svg>`, label: 'Chặn Tenor/Google GIF' },
    { key: 'BLOCK_ACTIONLOG',  ico: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h12v1H2zM2 5h8v1H2zM2 8h10v1H2zM2 11h6v1H2z"/><circle cx="12.5" cy="11.5" r="2.5" fill="#ef4444"/><path fill="#fff" d="M11.8 11.8l.7.7 1.4-1.4.5.5-1.9 1.9-.7-.7z"/></svg>`, label: 'Chặn Actionlog (hành vi)' },
    { key: 'BLOCK_REACT_SEEN', ico: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zm0 1a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm0 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>`, label: 'Ẩn "React đã xem"' },
    { key: 'DEBUG',            ico: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1h1a1 1 0 0 1 0 2h-1v1a4 4 0 0 1-2 3.46V11h1a1 1 0 0 1 0 2h-1v1a1 1 0 0 1-2 0v-1H7v1a1 1 0 0 1-2 0v-1H4a1 1 0 0 1 0-2h1V9.46A4 4 0 0 1 3 6V5H2a1 1 0 0 1 0-2h1V2zm1 1v3a3 3 0 0 0 6 0V3H5z"/></svg>`, label: 'Debug + Log' },
  ];

  const CSS = `
    #zp-root { all:initial; position:fixed; bottom:68px; right:14px; z-index:2147483647; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; }

    /* FAB + badge */
    #zp-fab-wrap { position:relative; width:42px; margin-left:auto; }
    #zp-fab  { width:42px; height:42px; border-radius:50%; background:#0068ff; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 16px rgba(0,104,255,.45); transition:transform .15s,box-shadow .15s; }
    #zp-fab:hover { transform:scale(1.08); box-shadow:0 6px 20px rgba(0,104,255,.6); }
    #zp-fab svg { width:20px; height:20px; }
    #zp-badge { position:absolute; top:-4px; right:-4px; background:#ef4444; color:#fff; border-radius:10px; font-size:9px; font-weight:700; padding:1px 5px; min-width:16px; text-align:center; line-height:14px; pointer-events:none; }

    /* Panel */
    #zp-panel { background:#0a0f1e; border:1px solid rgba(255,255,255,.08); color:#e2e8f0; border-radius:14px; width:272px; box-shadow:0 8px 32px rgba(0,0,0,.7); margin-bottom:10px; overflow:hidden; }

    #zp-hdr { padding:11px 14px 0; display:flex; align-items:center; justify-content:space-between; }
    #zp-title { font-size:12px; font-weight:600; letter-spacing:.6px; text-transform:uppercase; color:#fff; display:flex; align-items:center; gap:6px; }
    #zp-title svg { width:14px; height:14px; fill:#0068ff; }
    #zp-ver { font-size:10px; color:rgba(255,255,255,.25); }

    /* Tabs — 4 tabs */
    #zp-tabs { display:flex; gap:3px; padding:10px 14px 0; }
    .zp-tab { flex:1; background:rgba(255,255,255,.05); border:none; color:rgba(255,255,255,.4); font-size:10.5px; font-weight:500; padding:5px 2px; border-radius:6px; cursor:pointer; transition:background .15s,color .15s; white-space:nowrap; }
    .zp-tab:hover { background:rgba(255,255,255,.09); color:rgba(255,255,255,.7); }
    .zp-tab.active { background:#0068ff; color:#fff; }
    .zp-tab.recall-tab.has-new { background:#ef444422; color:#f87171; border:1px solid #ef444433; }
    .zp-tab.recall-tab.has-new.active { background:#ef4444; color:#fff; border-color:transparent; }

    .zp-pane { display:none; padding:10px 14px 12px; }
    .zp-pane.active { display:block; }

    /* Toggles */
    .zp-row { display:flex; align-items:center; justify-content:space-between; padding:5px 0; border-bottom:1px solid rgba(255,255,255,.05); }
    .zp-row:last-child { border-bottom:none; }
    .zp-lbl { font-size:12px; display:flex; align-items:center; gap:7px; color:#cbd5e1; }
    .zp-lbl svg { width:14px; height:14px; fill:#64748b; flex-shrink:0; }
    .zp-sw { position:relative; width:34px; height:19px; flex-shrink:0; }
    .zp-sw input { opacity:0; width:0; height:0; }
    .zp-sw span { position:absolute; inset:0; background:#1e293b; border-radius:19px; cursor:pointer; transition:background .2s; border:1px solid rgba(255,255,255,.08); }
    .zp-sw span::before { content:''; position:absolute; width:13px; height:13px; left:2px; top:2px; background:#475569; border-radius:50%; transition:transform .2s,background .2s; }
    .zp-sw input:checked + span { background:#0068ff; border-color:#0068ff; }
    .zp-sw input:checked + span::before { transform:translateX(15px); background:#fff; }

    /* Log */
    .zp-log-bar { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
    .zp-log-label { font-size:10px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:.5px; }
    .zp-log-actions { display:flex; gap:4px; }
    .zp-btn { background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.1); color:#64748b; border-radius:5px; padding:2px 8px; font-size:10px; cursor:pointer; transition:all .15s; white-space:nowrap; }
    .zp-btn:hover { background:rgba(255,255,255,.1); color:#e2e8f0; border-color:rgba(255,255,255,.2); }
    .zp-btn.ok { color:#22c55e; border-color:#22c55e44; }
    .zp-filter { display:flex; align-items:center; gap:5px; margin-bottom:6px; }
    .zp-filter input { accent-color:#0068ff; cursor:pointer; }
    .zp-filter label { font-size:10px; color:#64748b; cursor:pointer; }
    .zp-pre { margin:0; font-size:9.5px; font-family:'SF Mono','Fira Code','Cascadia Code',monospace; background:#060b18; border:1px solid rgba(255,255,255,.06); border-radius:7px; padding:7px 9px; height:118px; overflow-y:auto; white-space:pre; word-break:break-all; line-height:1.65; color:#94a3b8; scrollbar-width:thin; scrollbar-color:#1e293b transparent; }
    .zp-pre::-webkit-scrollbar { width:4px; }
    .zp-pre::-webkit-scrollbar-thumb { background:#1e293b; border-radius:4px; }

    /* Recall tab */
    #zp-recall-list { overflow-y:auto; max-height:200px; scrollbar-width:thin; scrollbar-color:#1e293b transparent; }
    #zp-recall-list::-webkit-scrollbar { width:4px; }
    #zp-recall-list::-webkit-scrollbar-thumb { background:#1e293b; border-radius:4px; }
    .zp-ri { background:rgba(0,104,255,.05); border:1px solid rgba(0,104,255,.18); border-radius:8px; padding:8px 10px; margin-bottom:6px; }
    .zp-ri.zp-ri-ws { background:rgba(34,197,94,.05); border-color:rgba(34,197,94,.2); }
    .zp-ri:last-child { margin-bottom:0; }
    .zp-ri-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:5px; }
    .zp-ri-ts  { font-size:9px; color:#475569; font-variant-numeric:tabular-nums; }
    .zp-ri-src { font-size:9px; padding:1px 6px; border-radius:4px; }
    .zp-ri-src-dom { color:#f59e0b; background:rgba(245,158,11,.15); }
    .zp-ri-src-ws  { color:#22c55e; background:rgba(34,197,94,.15); }
    .zp-ri-txt { font-size:11.5px; color:#e2e8f0; word-break:break-word; line-height:1.55; }
    .zp-ri-na  { font-size:10px; color:#22c55e; font-style:italic; }
    .zp-empty  { font-size:11.5px; color:#475569; text-align:center; padding:24px 0; }
    .zp-recall-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
    .zp-recall-title { font-size:10px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:.5px; }

    /* Khóa màn hình */
    .zp-hr { display:flex; align-items:center; gap:8px; }
    #zp-lockbtn { background:none; border:none; color:#94a3b8; cursor:pointer; padding:2px; display:flex; }
    #zp-lockbtn:hover { color:#fff; }
    #zp-lockbtn svg { width:14px; height:14px; }
    #zp-lock { position:fixed; inset:0; z-index:2147483647; background:#0a0f1e; color:#e2e8f0; display:flex; align-items:center; justify-content:center; }
    #zp-lock [hidden], #zp-lock[hidden] { display:none !important; }
    #zp-lk-box { width:260px; display:flex; flex-direction:column; align-items:center; gap:10px; }
    #zp-lk-box > svg { width:34px; height:34px; fill:#0068ff; }
    #zp-lk-title { font-size:15px; font-weight:600; }
    #zp-lock input { width:100%; box-sizing:border-box; background:#060b18; border:1px solid rgba(255,255,255,.12); color:#e2e8f0; border-radius:8px; padding:9px 12px; font-size:14px; text-align:center; letter-spacing:3px; outline:none; }
    #zp-lock input:focus { border-color:#0068ff; }
    #zp-lk-err { font-size:11.5px; color:#f87171; min-height:14px; }
    #zp-lk-go { width:100%; background:#0068ff; border:none; color:#fff; border-radius:8px; padding:9px; font-size:13px; font-weight:600; cursor:pointer; }
    #zp-lk-go:hover { background:#1a7aff; }
    #zp-lk-x { background:none; border:none; color:#64748b; font-size:11.5px; cursor:pointer; }
  `;

  const FAB_ICON = `<svg viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="1.6"><path d="M10 2.5 L17 5.5 L17 10 C17 14 10 17.5 10 17.5 C10 17.5 3 14 3 10 L3 5.5 Z"/><path stroke-width="1.4" d="M7 10 L9 12 L13 8"/></svg>`;

  function copyText(buf, btn) {
    const t = Array.isArray(buf) ? buf.join('\n') : buf;
    const ok = () => { btn.textContent = '✓ Copied'; btn.className = 'zp-btn ok'; setTimeout(() => { btn.textContent = 'Copy'; btn.className = 'zp-btn'; }, 1800); };
    const fail = () => { btn.textContent = '✗ Lỗi'; setTimeout(() => { btn.textContent = 'Copy'; btn.className = 'zp-btn'; }, 1800); };
    navigator.clipboard.writeText(t).then(ok).catch(() => {
      // Fallback: execCommand hoạt động trong mọi context Tampermonkey
      const ta = document.createElement('textarea');
      Object.assign(ta.style, { position: 'fixed', opacity: '0', top: '0', left: '0', width: '1px', height: '1px' });
      ta.value = t; document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand('copy') ? ok() : fail(); } catch { fail(); }
      ta.remove();
    });
  }

  function makeLogPane(id, label, buf, setEl) {
    const pane = document.createElement('div');
    pane.className = 'zp-pane'; pane.dataset.pane = id;
    const bar = document.createElement('div'); bar.className = 'zp-log-bar';
    const lbl = document.createElement('span'); lbl.className = 'zp-log-label'; lbl.textContent = label;
    const acts = document.createElement('div'); acts.className = 'zp-log-actions';
    const copyBtn = document.createElement('button'); copyBtn.className = 'zp-btn'; copyBtn.textContent = 'Copy';
    const clearBtn = document.createElement('button'); clearBtn.className = 'zp-btn'; clearBtn.textContent = 'Xóa';
    acts.appendChild(copyBtn); acts.appendChild(clearBtn);
    bar.appendChild(lbl); bar.appendChild(acts);
    if (id === 'http') {
      const frow = document.createElement('div'); frow.className = 'zp-filter';
      const fcb = document.createElement('input'); fcb.type = 'checkbox'; fcb.id = 'zp-fcb';
      const flbl = document.createElement('label'); flbl.htmlFor = 'zp-fcb'; flbl.textContent = 'Chỉ hiện bị chặn';
      fcb.addEventListener('change', () => { httpOnlyBlocked = fcb.checked; renderHttp(); });
      frow.appendChild(fcb); frow.appendChild(flbl);
      pane.appendChild(bar); pane.appendChild(frow);
    } else { pane.appendChild(bar); }
    const pre = document.createElement('pre'); pre.className = 'zp-pre';
    pre.textContent = '(bật Debug để ghi log)';
    setEl(pre); pane.appendChild(pre);
    copyBtn.addEventListener('click', () => copyText(id === 'http' ? httpView() : buf, copyBtn));
    clearBtn.addEventListener('click', () => { buf.length = 0; pre.textContent = '(trống)'; });
    return pane;
  }

  function injectUI() {
    const root = document.createElement('div'); root.id = 'zp-root';
    document.body.appendChild(root);
    const style = document.createElement('style'); style.textContent = CSS;

    // FAB + badge
    const fabWrap = document.createElement('div'); fabWrap.id = 'zp-fab-wrap';
    const fab = document.createElement('button'); fab.id = 'zp-fab'; fab.title = 'Zalo Privacy'; fab.innerHTML = FAB_ICON;
    const badge = document.createElement('span'); badge.id = 'zp-badge'; badge.hidden = true;
    recallBadgeEl = badge;
    fabWrap.appendChild(fab); fabWrap.appendChild(badge);

    const panel = document.createElement('div'); panel.id = 'zp-panel'; panel.hidden = true;

    // Header
    const hdr = document.createElement('div'); hdr.id = 'zp-hdr';
    hdr.innerHTML = `<span id="zp-title"><svg viewBox="0 0 16 16" fill="none" stroke="#0068ff" stroke-width="1.5"><path d="M8 1.5L14 4v4.5C14 12 8 14.5 8 14.5S2 12 2 8.5V4z"/><path stroke-width="1.3" d="M5.5 8.5L7 10l3.5-3"/></svg>Zalo Privacy</span><span class="zp-hr"><button id="zp-lockbtn" title="Khóa Zalo"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3zM6 4a2 2 0 1 1 4 0v2H6V4z"/></svg></button><span id="zp-ver">v0.9</span></span>`;

    // 4 tabs
    const tabBar = document.createElement('div'); tabBar.id = 'zp-tabs';
    const TAB_DEFS = [
      { id: 'settings', label: '⚙️ Cài đặt' },
      { id: 'recall',   label: '🔔 Thu hồi', cls: 'recall-tab' },
      { id: 'http',     label: '📤 HTTP' },
      { id: 'ws',       label: '📡 WS' },
    ];
    const tabBtns = {};
    TAB_DEFS.forEach(({ id, label, cls }) => {
      const btn = document.createElement('button');
      btn.className = 'zp-tab' + (id === 'settings' ? ' active' : '') + (cls ? ' ' + cls : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        switchTab(id);
        // Reset badge khi mo tab thu hoi
        if (id === 'recall') { badge.hidden = true; tabBtns.recall.classList.remove('has-new'); }
      });
      tabBtns[id] = btn;
      tabBar.appendChild(btn);
    });
    function switchTab(id) {
      Object.entries(tabBtns).forEach(([k, b]) => b.classList.toggle('active', k === id));
      panel.querySelectorAll('.zp-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === id));
    }

    // Settings pane
    const settingsPane = document.createElement('div');
    settingsPane.className = 'zp-pane active'; settingsPane.dataset.pane = 'settings';
    FEATURES.forEach(({ key, ico, label }) => {
      const row = document.createElement('div'); row.className = 'zp-row';
      const lbl = document.createElement('span'); lbl.className = 'zp-lbl'; lbl.innerHTML = `${ico} ${label}`;
      const sw = document.createElement('label'); sw.className = 'zp-sw';
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!CFG[key];
      inp.addEventListener('change', () => {
        CFG[key] = inp.checked; save();
        if (key === 'DEBUG' && !inp.checked) {
          if (httpEl) httpEl.textContent = '(bật Debug để ghi log)';
          if (wsEl)   wsEl.textContent   = '(bật Debug để ghi log)';
        }
      });
      const knob = document.createElement('span');
      sw.appendChild(inp); sw.appendChild(knob);
      row.appendChild(lbl); row.appendChild(sw);
      settingsPane.appendChild(row);
    });

    // Recall pane
    const recallPane = document.createElement('div');
    recallPane.className = 'zp-pane'; recallPane.dataset.pane = 'recall';
    const recallBar = document.createElement('div'); recallBar.className = 'zp-recall-bar';
    const recallTitle = document.createElement('span'); recallTitle.className = 'zp-recall-title'; recallTitle.textContent = 'Tin nhắn đã bị thu hồi';
    const recallClear = document.createElement('button'); recallClear.className = 'zp-btn'; recallClear.textContent = 'Xóa';
    recallClear.addEventListener('click', () => { recallHistory.length = 0; renderRecallList(); badge.hidden = true; });
    const recallCopy = document.createElement('button'); recallCopy.className = 'zp-btn'; recallCopy.textContent = 'Copy';
    recallCopy.addEventListener('click', () => copyText(recallHistory.map((r) => `[${r.ts}][${r.note}] ${r.text || '(no text)'}`), recallCopy));
    const recallActs = document.createElement('div'); recallActs.className = 'zp-log-actions';
    recallActs.appendChild(recallCopy); recallActs.appendChild(recallClear);
    recallBar.appendChild(recallTitle); recallBar.appendChild(recallActs);
    const recallList = document.createElement('div'); recallList.id = 'zp-recall-list';
    recallListEl = recallList;
    renderRecallList();
    recallPane.appendChild(recallBar); recallPane.appendChild(recallList);

    // Log panes
    const httpPane = makeLogPane('http', 'Request log', httpLog, (el) => { httpEl = el; });
    const wsPane   = makeLogPane('ws',   'WebSocket log', wsLog,  (el) => { wsEl   = el; });

    panel.appendChild(hdr); panel.appendChild(tabBar);
    panel.appendChild(settingsPane); panel.appendChild(recallPane);
    panel.appendChild(httpPane); panel.appendChild(wsPane);

    const wrap = document.createElement('div');
    wrap.appendChild(style); wrap.appendChild(panel); wrap.appendChild(fabWrap);
    root.appendChild(wrap);

    // Overlay khóa (nằm sau FAB trong DOM nên phủ lên cả panel)
    const lockEl = document.createElement('div'); lockEl.id = 'zp-lock'; lockEl.hidden = true;
    lockEl.innerHTML = `<div id="zp-lk-box"><svg viewBox="0 0 16 16"><path d="M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3zM6 4a2 2 0 1 1 4 0v2H6V4z"/></svg><div id="zp-lk-title"></div><input id="zp-lk-a" type="password" autocomplete="off" maxlength="12"><input id="zp-lk-b" type="password" autocomplete="off" maxlength="12" placeholder="Nhập lại mã PIN"><div id="zp-lk-err"></div><button id="zp-lk-go"></button><button id="zp-lk-x">Hủy</button></div>`;
    wrap.appendChild(lockEl);
    ['keydown', 'keyup', 'keypress'].forEach((t) => lockEl.addEventListener(t, (e) => e.stopPropagation()));
    const $ = (id) => lockEl.querySelector('#' + id);
    const setErr = (t) => { $('zp-lk-err').textContent = t; };
    let lockMode = 'unlock';

    // setup: đặt PIN lần đầu (rồi khóa) · unlock: mở khóa · change: nhập PIN cũ để đổi
    // newpin: nhập PIN mới (không khóa) · remove: nhập PIN cũ để xóa PIN
    const LOCK_TEXT = {
      setup:  ['Đặt mã PIN để khóa', 'Mã PIN mới (4-12 ký tự)', 'Đặt PIN & khóa'],
      newpin: ['Đặt mã PIN mới', 'Mã PIN mới (4-12 ký tự)', 'Lưu PIN mới'],
      unlock: ['Zalo đã khóa', 'Nhập mã PIN', 'Mở khóa'],
      change: ['Nhập PIN hiện tại để đổi PIN', 'Mã PIN hiện tại', 'Tiếp tục'],
      remove: ['Nhập PIN hiện tại để xóa PIN', 'Mã PIN hiện tại', 'Xóa PIN'],
    };

    function openLock(mode) {
      lockMode = mode; lockEl.hidden = false; panel.hidden = true;
      const [title, ph, go] = LOCK_TEXT[mode];
      $('zp-lk-title').textContent = title;
      $('zp-lk-a').placeholder = ph;
      $('zp-lk-b').hidden = mode !== 'setup' && mode !== 'newpin';
      $('zp-lk-x').hidden = mode === 'unlock';
      $('zp-lk-go').textContent = go;
      $('zp-lk-a').value = ''; $('zp-lk-b').value = ''; setErr('');
      setTimeout(() => $('zp-lk-a').focus(), 0);
    }

    async function checkPin(pin) {
      let rec; try { rec = JSON.parse(lsGet(PIN_KEY)); } catch {}
      if (!rec) return true;
      const salt = Uint8Array.from(atob(rec.s), (c) => c.charCodeAt(0));
      return (await hashPin(pin, salt)) === rec.h;
    }

    async function submitLock() {
      const a = $('zp-lk-a').value;
      if (lockMode === 'setup' || lockMode === 'newpin') {
        if (a.length < 4) return setErr('PIN tối thiểu 4 ký tự');
        if (a !== $('zp-lk-b').value) return setErr('Hai lần nhập không khớp');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        lsSet(PIN_KEY, JSON.stringify({ s: btoa(String.fromCharCode(...salt)), h: await hashPin(a, salt) }));
        refreshPinRow();
        if (lockMode === 'setup') { setLocked(true); openLock('unlock'); } else lockEl.hidden = true;
        return;
      }
      if (!(await checkPin(a))) { setErr('Sai mã PIN'); $('zp-lk-a').value = ''; return; }
      if (lockMode === 'change') { openLock('newpin'); return; }
      if (lockMode === 'remove') { lsSet(PIN_KEY, null); refreshPinRow(); lockEl.hidden = true; return; }
      setLocked(false); lockEl.hidden = true;
    }

    $('zp-lk-go').addEventListener('click', submitLock);
    $('zp-lk-x').addEventListener('click', () => { lockEl.hidden = true; });
    lockEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLock(); });
    hdr.querySelector('#zp-lockbtn').addEventListener('click', () => {
      if (lsGet(PIN_KEY)) { setLocked(true); openLock('unlock'); } else openLock('setup');
    });

    // Hàng "Mã PIN khóa" trong tab Cài đặt: chỉ hiện khi đã có PIN
    const pinRow = document.createElement('div'); pinRow.className = 'zp-row';
    const pinLbl = document.createElement('span'); pinLbl.className = 'zp-lbl'; pinLbl.textContent = 'Mã PIN khóa';
    const pinActs = document.createElement('div'); pinActs.className = 'zp-log-actions';
    [['Đổi PIN', 'change'], ['Xóa PIN', 'remove']].forEach(([text, mode]) => {
      const b = document.createElement('button'); b.className = 'zp-btn'; b.textContent = text;
      b.addEventListener('click', () => openLock(mode));
      pinActs.appendChild(b);
    });
    pinRow.appendChild(pinLbl); pinRow.appendChild(pinActs);
    settingsPane.appendChild(pinRow);
    function refreshPinRow() { pinRow.style.display = lsGet(PIN_KEY) ? '' : 'none'; }
    refreshPinRow();

    if (lsGet(LOCK_KEY) === '1') openLock('unlock');

    // Kéo thả — kéo xa hơn vài px thì bỏ qua click để không bật/tắt panel
    let drag = null, moved = false;
    fab.addEventListener('click', () => { if (moved) { moved = false; return; } panel.hidden = !panel.hidden; });
    fab.addEventListener('mousedown', (e) => {
      const s = getComputedStyle(root);
      drag = { x: e.clientX, y: e.clientY, r: parseInt(s.right), b: parseInt(s.bottom) };
      moved = false;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) moved = true;
      root.style.right  = (drag.r + drag.x - e.clientX) + 'px';
      root.style.bottom = (drag.b + drag.y - e.clientY) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = null; });

    _recallHook = () => {
      if (tabBtns.recall && !tabBtns.recall.classList.contains('active')) {
        tabBtns.recall.classList.add('has-new');
      }
    };
  }

  if (document.body) { injectUI(); startDomObserver(); }
  else document.addEventListener('DOMContentLoaded', () => { injectUI(); startDomObserver(); });

  if (typeof __ZP_TEST__ === 'function') __ZP_TEST__({ HTTP_RULES, extractJson, isRecall, hashPin });
  console.info('[ZaloPriv] v0.9 loaded');
})();
