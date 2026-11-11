// Injected into m.youtube.com before the page's own scripts run (iPhone / iPad app).
// Talks to the app through window.webkit.messageHandlers.rt (see PlayerViewController.swift).
(function () {
  if (window.__ranchYT) return;
  window.__ranchYT = true;

  var native = function (msg) {
    try { return window.webkit.messageHandlers.rt.postMessage(msg); } catch (e) { return Promise.resolve(null); }
  };

  // ------------------------------------------------------------ ad pruning
  // Video ads arrive inside the player's JSON; remove them before the player reads it.
  var AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adBreakParams'];
  function prune(o) {
    if (!o || typeof o !== 'object') return o;
    var one = function (x) {
      if (!x || typeof x !== 'object') return;
      for (var i = 0; i < AD_KEYS.length; i++) if (AD_KEYS[i] in x) delete x[AD_KEYS[i]];
    };
    one(o);
    if (o.playerResponse) one(o.playerResponse);
    if (Array.isArray(o)) o.forEach(function (x) { one(x); if (x && x.playerResponse) one(x.playerResponse); });
    return o;
  }
  var nativeToString = Function.prototype.toString;
  var disguised = new WeakMap();
  var fakeToString = function toString() { return nativeToString.call(disguised.has(this) ? disguised.get(this) : this); };
  disguised.set(fakeToString, nativeToString);
  Function.prototype.toString = fakeToString;
  function patch(obj, key, make) {
    var orig = obj[key];
    if (typeof orig !== 'function') return;
    var wrapped = make(orig);
    disguised.set(wrapped, orig);
    obj[key] = wrapped;
  }
  patch(JSON, 'parse', function (orig) {
    return function parse() { var r = orig.apply(this, arguments); try { prune(r); } catch (e) { /* never break the page */ } return r; };
  });
  patch(Response.prototype, 'json', function (orig) {
    return function json() { return orig.call(this).then(function (r) { try { prune(r); } catch (e) { /* ignore */ } return r; }); };
  });
  ['ytInitialPlayerResponse', 'playerResponse'].forEach(function (name) {
    var value;
    try { Object.defineProperty(window, name, { configurable: true, get: function () { return value; }, set: function (v) { value = prune(v); } }); } catch (e) { /* ignore */ }
  });

  // ------------------------------------------------------------ background play
  // YouTube pauses when it thinks the page is hidden; always look visible.
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    document.addEventListener('visibilitychange', function (e) { e.stopImmediatePropagation(); }, true);
    document.addEventListener('webkitvisibilitychange', function (e) { e.stopImmediatePropagation(); }, true);
  } catch (e) { /* ignore */ }
  // No "Video paused. Continue watching?"
  setInterval(function () { try { window._lact = Date.now(); } catch (e) { /* ignore */ } }, 60000);

  // ------------------------------------------------------------ clean share links
  function cleanLinks(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s]*/g, function (url) {
      try { var u = new URL(url); ['si', 'pp', 'feature'].forEach(function (k) { u.searchParams.delete(k); }); return u.toString(); } catch (e) { return url; }
    });
  }
  if (window.Clipboard) patch(Clipboard.prototype, 'writeText', function (orig) { return function writeText(t) { return orig.call(this, cleanLinks(t)); }; });
  if (navigator.share) {
    var share = navigator.share.bind(navigator);
    navigator.share = function (data) {
      if (data && data.url) data = Object.assign({}, data, { url: cleanLinks(data.url) });
      if (data && data.text) data = Object.assign({}, data, { text: cleanLinks(data.text) });
      return share(data);
    };
  }

  // ------------------------------------------------------------ page styles
  var CSS = [
    // sponsored cards and promos
    'ad-slot-renderer, ytm-promoted-sparkles-web-renderer, ytm-promoted-video-renderer, ytm-companion-ad-renderer,',
    'ytm-companion-slot, ytm-statement-banner-renderer, ytm-mealbar-promo-renderer, ytm-in-feed-ad-layout-renderer,',
    'ytm-rich-item-renderer:has(ad-slot-renderer), ytm-item-section-renderer:has(> lazy-list > ad-slot-renderer),',
    'ytm-rich-section-renderer:has(ytm-statement-banner-renderer), .ytp-ad-overlay-container, ytm-merch-shelf-renderer,',
    'ytm-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"] { display: none !important; }',
    // SponsorBlock "skipped" note and dislike count
    '#ranch-sb-toast { position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom) + 72px); z-index: 99999;',
    '  transform: translate(-50%, 8px); display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px;',
    '  border-radius: 10px; background: rgba(15,15,15,.92); color: #f1f1f1; font: 500 14px/1.2 Roboto, -apple-system, sans-serif;',
    '  opacity: 0; transition: opacity .18s, transform .18s; pointer-events: none; }',
    '#ranch-sb-toast.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }',
    '#ranch-sb-toast i { width: 8px; height: 8px; border-radius: 2px; }',
    '#ranch-sb-toast button { border: 0; border-radius: 8px; padding: 7px 12px; background: rgba(255,255,255,.14); color: #fff; font: inherit; }',
    '.ranch-dislike-count { margin-left: 6px; }',
    '#ranch-update { position: fixed; top: calc(env(safe-area-inset-top) + 8px); left: 50%; transform: translateX(-50%); z-index: 99999;',
    '  border: 0; border-radius: 18px; padding: 8px 16px; background: #1ed760; color: #04210f; font: 600 14px/1 -apple-system, Roboto, sans-serif; }',
  ].join('\n');
  function addCss() {
    if (document.getElementById('ranch-css')) return;
    var s = document.createElement('style');
    s.id = 'ranch-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  addCss();
  document.addEventListener('DOMContentLoaded', addCss);

  var playerEl = function () { return document.querySelector('#movie_player, .html5-video-player'); };
  var videoEl = function () { var p = playerEl(); return (p && p.querySelector('video')) || document.querySelector('video'); };
  var isAd = function (p) { return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')); };
  var currentId = function () {
    var m = /[?&]v=([\w-]{11})/.exec(location.search) || /^\/shorts\/([\w-]{11})/.exec(location.pathname);
    return m ? m[1] : null;
  };

  // ------------------------------------------------------------ skip any ad that slips through
  var mutedByUs = false;
  setInterval(function () {
    var p = playerEl();
    var v = videoEl();
    if (!p || !v) return;
    if (isAd(p)) {
      if (!v.muted) { v.muted = true; mutedByUs = true; }
      if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.1) v.currentTime = v.duration;
      document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[id^="skip-button"]').forEach(function (b) { b.click(); });
    } else if (mutedByUs) {
      v.muted = false;
      mutedByUs = false;
    }
    // "Ad blockers aren't allowed" popup: close it and keep watching
    var enf = document.querySelector('ytm-enforcement-message-view-model, ytd-enforcement-message-view-model');
    if (enf) {
      var box = enf.closest('bottom-sheet-container, ytm-bottom-sheet-renderer, tp-yt-paper-dialog, dialog') || enf;
      box.remove();
      if (v.paused) v.play().catch(function () {});
    }
  }, 300);

  // ------------------------------------------------------------ SponsorBlock
  var SB = {
    sponsor: ['sponsor', '#00d400'], selfpromo: ['self-promotion', '#ffff00'], interaction: ['subscribe reminder', '#cc00ff'],
    intro: ['intro', '#00ffff'], outro: ['credits', '#0202ed'], preview: ['preview', '#008fd6'], filler: ['tangent', '#7300ff'],
    music_offtopic: ['non-music part', '#ff9900'],
  };
  var segments = [], segmentsFor = null, unskipped = {};
  function loadSegments(id) {
    if (id === segmentsFor) return;
    segmentsFor = id; segments = []; unskipped = {};
    if (!id) return;
    Promise.resolve(native({ type: 'segments', id: id })).then(function (list) {
      if (segmentsFor === id && Array.isArray(list)) segments = list;
    }).catch(function () {});
  }
  var toastTimer = null;
  function toast(seg) {
    var t = document.getElementById('ranch-sb-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ranch-sb-toast';
      t.appendChild(document.createElement('i'));
      t.appendChild(document.createElement('span'));
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Undo';
      t.appendChild(b);
      document.body.appendChild(t);
    }
    var info = SB[seg.category] || ['segment', '#00d400'];
    t.querySelector('i').style.background = info[1];
    t.querySelector('span').textContent = 'Skipped ' + info[0];
    t.querySelector('button').onclick = function (e) {
      e.stopPropagation();
      unskipped[seg.uuid] = true;
      var v = videoEl();
      if (v) v.currentTime = seg.start;
      t.classList.remove('show');
    };
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 4500);
  }
  setInterval(function () {
    if (!segments.length || isAd(playerEl())) return;
    var v = videoEl();
    if (!v || v.paused) return;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (unskipped[s.uuid]) continue;
      if (v.currentTime >= s.start && v.currentTime < s.end - 0.3) {
        v.currentTime = isFinite(v.duration) ? Math.min(s.end, v.duration) : s.end;
        toast(s);
        break;
      }
    }
  }, 200);

  // ------------------------------------------------------------ Return YouTube Dislike
  var votes = null, votesFor = null, pressedAtLoad = null;
  var compact = function (n) {
    try { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch (e) { return String(n); }
  };
  function loadVotes(id) {
    if (id === votesFor) return;
    votesFor = id; votes = null; pressedAtLoad = null;
    if (!id) return;
    Promise.resolve(native({ type: 'votes', id: id })).then(function (v) {
      if (votesFor === id && v && typeof v.dislikes === 'number') votes = v;
    }).catch(function () {});
  }
  function renderDislikes() {
    var btn = location.pathname === '/watch' && document.querySelector('dislike-button-view-model button, ytm-slim-video-action-bar-renderer .slim-video-action-bar-actions button[aria-label*="islike"]');
    if (!btn || !votes) { document.querySelectorAll('.ranch-dislike-count').forEach(function (n) { n.remove(); }); return; }
    var pressed = btn.getAttribute('aria-pressed') === 'true';
    if (pressedAtLoad === null) pressedAtLoad = pressed;
    var count = Math.max(0, votes.dislikes + (pressed ? 1 : 0) - (pressedAtLoad ? 1 : 0));
    var label = btn.querySelector('.ranch-dislike-count');
    if (!label) {
      label = document.createElement('div');
      label.className = 'yt-spec-button-shape-next__button-text-content ranch-dislike-count';
      btn.appendChild(label);
    }
    if (btn.classList.contains('yt-spec-button-shape-next--icon-button')) {
      btn.classList.remove('yt-spec-button-shape-next--icon-button');
      btn.classList.add('yt-spec-button-shape-next--icon-leading');
    }
    var text = compact(count);
    if (label.textContent !== text) label.textContent = text;
  }
  setInterval(renderDislikes, 800);

  // ------------------------------------------------------------ remember playback speed
  var changedAt = 0, lastId = null;
  document.addEventListener('ratechange', function (e) {
    var v = e.target;
    if (!v || v.tagName !== 'VIDEO' || isAd(playerEl()) || Date.now() - changedAt < 3000) return;
    try { localStorage.setItem('ranch-speed', String(v.playbackRate)); } catch (err) { /* ignore */ }
  }, true);

  // ------------------------------------------------------------ now-playing feed
  setInterval(function () {
    var id = currentId();
    var p = playerEl();
    var v = videoEl();
    if (id && !isAd(p)) { loadSegments(id); loadVotes(id); }
    if (id && id !== lastId && v && !isAd(p)) {
      lastId = id;
      changedAt = Date.now();
      var want = Number(localStorage.getItem('ranch-speed')) || 1;
      var apply = function () { if (Math.abs(v.playbackRate - want) > 0.01) v.playbackRate = want; };
      [200, 1000, 2500].forEach(function (d) { setTimeout(apply, d); });
    }
    native({ type: 'state', playing: !!(v && !v.paused && !v.ended) });
  }, 1000);

  // ------------------------------------------------------------ green Update button
  window.__rtUpdate = function (s) {
    var b = document.getElementById('ranch-update');
    if (!s || s.status !== 'available') { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('button');
      b.id = 'ranch-update';
      b.type = 'button';
      b.addEventListener('click', function () { native({ type: 'update' }); });
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = 'Update to ' + s.version;
  };
})();
