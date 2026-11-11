// Preload for the YouTube window.
// Runs in an isolated world and injects `pageScript` into the page's own world
// before any of YouTube's scripts run.
const { ipcRenderer, contextBridge, webFrame } = require('electron');

let cfg = ipcRenderer.sendSync('yt:get-config');

// ============================================================================
// Page-world script. Must be self-contained: it is serialized and re-evaluated
// inside the page, so it can't reference anything outside this function.
// ============================================================================
function pageScript(initialCfg) {
  if (window.__ranchYT) return;
  window.__ranchYT = true;
  let cfg = initialCfg;

  const emit = (name, detail) =>
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));

  // Make patched functions look native to any integrity checks.
  const nativeToString = Function.prototype.toString;
  const disguised = new WeakMap();
  const fakeToString = function toString() {
    return disguised.has(this) ? nativeToString.call(disguised.get(this)) : nativeToString.call(this);
  };
  disguised.set(fakeToString, nativeToString);
  Function.prototype.toString = fakeToString;
  const patch = (obj, key, make) => {
    const orig = obj[key];
    if (typeof orig !== 'function') return;
    const wrapped = make(orig);
    disguised.set(wrapped, orig);
    obj[key] = wrapped;
  };

  // --------------------------------------------------------------- ad pruning
  // Video ads are delivered inside the player's JSON. Removing these keys before
  // the player reads them means it never knows there was an ad to play.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adBreakParams'];
  let pruned = 0;
  const prune = (o) => {
    if (!cfg.adblock || !o || typeof o !== 'object') return o;
    const one = (x) => {
      if (!x || typeof x !== 'object') return;
      for (const k of AD_KEYS) {
        if (k in x) { delete x[k]; pruned++; }
      }
    };
    one(o);
    if (o.playerResponse) one(o.playerResponse);
    if (Array.isArray(o)) for (const x of o) { one(x); if (x && x.playerResponse) one(x.playerResponse); }
    return o;
  };
  patch(JSON, 'parse', (orig) => function parse(...args) {
    const r = orig.apply(this, args);
    try { prune(r); } catch { /* never break the page */ }
    return r;
  });
  patch(Response.prototype, 'json', (orig) => async function json() {
    const r = await orig.call(this);
    try { prune(r); } catch { /* ignore */ }
    return r;
  });
  for (const name of ['ytInitialPlayerResponse', 'playerResponse']) {
    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => value,
        set: (v) => { value = prune(v); },
      });
    } catch { /* ignore */ }
  }

  // ------------------------------------------------ background play / no AFK
  // YouTube pauses or degrades playback when it thinks the window is hidden.
  try {
    const hidden = (d) => d.webkitHidden;
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return cfg.backgroundPlay ? false : hidden(this); } });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return cfg.backgroundPlay ? 'visible' : (hidden(this) ? 'hidden' : 'visible'); } });
    document.addEventListener('visibilitychange', (e) => { if (cfg.backgroundPlay) e.stopImmediatePropagation(); }, true);
  } catch { /* ignore */ }
  // "Video paused. Continue watching?" appears after a long time with no activity.
  setInterval(() => {
    if (cfg.noAfkPause) { try { window._lact = Date.now(); } catch { /* ignore */ } }
  }, 60000);

  // ----------------------------------------------- clean share links
  // Copied links lose the "si=" tracking part that ties them to your account.
  const cleanLinks = (text) => (typeof text === 'string' && cfg.cleanShareLinks
    ? text.replace(/(https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/[^\s]*)/g, (url) => {
      try {
        const u = new URL(url);
        u.searchParams.delete('si');
        u.searchParams.delete('pp');
        u.searchParams.delete('feature');
        return u.toString();
      } catch { return url; }
    })
    : text);
  if (window.Clipboard) {
    patch(Clipboard.prototype, 'writeText', (orig) => function writeText(text) {
      return orig.call(this, cleanLinks(text));
    });
  }

  // Shorts have their own player; everything else uses the main one
  const player = () => (location.pathname.startsWith('/shorts/') && document.getElementById('shorts-player'))
    || document.getElementById('movie_player');
  const isAd = (p) => !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));

  // ------------------------------------------- fallback: skip anything left
  let mutedByUs = false;
  let lastAdLog = 0;
  setInterval(() => {
    const p = player();
    const video = p && p.querySelector('video');
    if (!p || !video) return;
    if (cfg.adblock && isAd(p)) {
      if (!video.muted) { video.muted = true; mutedByUs = true; }
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
        video.currentTime = video.duration;
      }
      document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[id^="skip-button"]')
        .forEach((b) => b.click());
      if (Date.now() - lastAdLog > 5000) { lastAdLog = Date.now(); emit('rt:log', 'Ad skipped'); }
    } else if (mutedByUs) {
      video.muted = false;
      mutedByUs = false;
    }
  }, 300);

  // ------------------------------------------- per-video preferences
  // Quality, remembered speed and theater mode, applied when a new video starts.
  const HEIGHTS = { highres: 4320, hd2880: 2880, hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };
  function pickQuality(levels) {
    const real = levels.filter((l) => l in HEIGHTS).sort((a, b) => HEIGHTS[b] - HEIGHTS[a]);
    if (!real.length) return null;
    if (cfg.quality === 'highest') return real[0];
    const max = Number(cfg.quality) || 0;
    return real.find((l) => HEIGHTS[l] <= max) || real[real.length - 1];
  }
  let curId = null;
  let changedAt = 0;
  let theaterDone = false;
  const SPEED_KEY = 'ranch-speed';
  const savedSpeed = () => { try { return Number(localStorage.getItem(SPEED_KEY)) || 1; } catch { return 1; } };

  function applyPrefs(p, id, tries) {
    if (curId !== id || tries > 20) return;
    let again = false;
    try {
      if (cfg.quality && cfg.quality !== 'auto' && typeof p.getAvailableQualityLevels === 'function') {
        const q = pickQuality(p.getAvailableQualityLevels() || []);
        if (!q) again = true;
        else if (p.getPlaybackQuality() !== q) {
          if (p.setPlaybackQualityRange) p.setPlaybackQualityRange(q, q);
          if (p.setPlaybackQuality) p.setPlaybackQuality(q);
        }
      }
      if (cfg.rememberSpeed) {
        const want = savedSpeed();
        const video = p.querySelector('video');
        if (video && Math.abs(video.playbackRate - want) > 0.01) {
          if (p.setPlaybackRate) p.setPlaybackRate(want); else video.playbackRate = want;
        }
        if (Date.now() - changedAt < 3000) again = true; // YouTube may reset it once more
      }
    } catch { /* ignore */ }
    if (again) setTimeout(() => applyPrefs(p, id, tries + 1), 500);
  }

  setInterval(() => {
    const p = player();
    if (!p || typeof p.getVideoData !== 'function' || isAd(p)) return;
    let id;
    try { id = p.getVideoData().video_id; } catch { return; }
    if (!id || id === curId) return;
    curId = id;
    changedAt = Date.now();
    applyPrefs(p, id, 0);
    if (cfg.theaterMode && !theaterDone && location.pathname === '/watch') {
      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy && !flexy.hasAttribute('theater') && !document.fullscreenElement) {
        const b = p.querySelector('.ytp-size-button');
        if (b) { b.click(); theaterDone = true; }
      } else if (flexy) theaterDone = true;
    }
  }, 500);

  // Remember the speed you pick (but not YouTube's own resets when a video loads)
  document.addEventListener('ratechange', (e) => {
    const v = e.target;
    const p = player();
    if (!cfg.rememberSpeed || !v || v.tagName !== 'VIDEO' || !p || !p.contains(v) || isAd(p)) return;
    if (Date.now() - changedAt < 3000) return;
    try { localStorage.setItem(SPEED_KEY, String(v.playbackRate)); } catch { /* ignore */ }
  }, true);

  // -------------------------------------------------------- now-playing feed
  let lastPruned = 0;
  setInterval(() => {
    if (pruned !== lastPruned) { lastPruned = pruned; emit('rt:pruned', pruned); }
    const p = player();
    const watching = location.pathname === '/watch' || location.pathname.startsWith('/shorts/') || !!document.querySelector('ytd-miniplayer[active], ytd-miniplayer[enabled][active]');
    if (!p || !watching || typeof p.getVideoData !== 'function') { emit('rt:state', null); return; }
    let data;
    try { data = p.getVideoData(); } catch { return; }
    if (!data || !data.video_id) { emit('rt:state', null); return; }
    const state = typeof p.getPlayerState === 'function' ? p.getPlayerState() : -1;
    const ad = isAd(p);
    emit('rt:state', {
      videoId: data.video_id,
      title: data.title || '',
      channel: data.author || '',
      live: !!data.isLive,
      currentTime: p.getCurrentTime ? p.getCurrentTime() : 0,
      duration: p.getDuration ? p.getDuration() : 0,
      rate: p.getPlaybackRate ? p.getPlaybackRate() : 1,
      paused: !(state === 1 || state === 3) || ad, // 1 = playing, 3 = buffering
      adShowing: ad,
    });
  }, 1000);

  // ----------------------------------------------------- remote control
  document.addEventListener('rt:control', (e) => {
    const p = player();
    if (!p) return;
    const action = e.detail;
    try {
      if (action === 'playpause') (p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo());
      else if (action === 'pause') p.pauseVideo();
      else if (action === 'play') p.playVideo();
      else if (action === 'next') p.nextVideo();
    } catch { /* ignore */ }
  });
  document.addEventListener('rt:config', (e) => {
    try { cfg = JSON.parse(e.detail); } catch { /* ignore */ }
  });
}

contextBridge.executeInMainWorld({ func: pageScript, args: [cfg] });

// ============================================================================
// Isolated-world side: page cleanup, SponsorBlock, dislikes, buttons, bridge.
// ============================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const log = (msg) => ipcRenderer.send('yt:log', msg);

// ------------------------------------------------------------- page styles
const SHEETS = {
  hideFeedAds: `
    ytd-ad-slot-renderer, ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-sparkles-web-renderer,
    ytd-promoted-video-renderer, ytd-compact-promoted-video-renderer, ytd-display-ad-renderer,
    ytd-action-companion-ad-renderer, ytd-player-legacy-desktop-watch-ads-renderer, ytd-search-pyv-renderer,
    ytd-banner-promo-renderer, ytd-statement-banner-renderer, ytd-brand-video-singleton-renderer,
    ytd-brand-video-shelf-renderer, ytd-merch-shelf-renderer, ytd-movie-offer-module-renderer,
    #player-ads, #masthead-ad, .ytp-ad-overlay-container, .ytp-featured-product,
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer), ytd-rich-item-renderer:has(ad-slot-renderer),
    ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
    ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"] { display: none !important; }`,
  hideUpsells: `
    ytd-mealbar-promo-renderer, yt-mealbar-promo-renderer, ytd-primetime-promo-renderer,
    ytd-popup-container tp-yt-paper-dialog:has(ytd-mealbar-promo-renderer),
    ytd-popup-container tp-yt-paper-dialog:has(yt-mealbar-promo-renderer),
    ytd-guide-section-renderer:has(a[href="/premium"]) ytd-guide-entry-renderer:has(a[href^="/premium"]),
    ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[has-paygated-featured-badge]) { display: none !important; }`,
  hideShorts: `
    ytd-rich-shelf-renderer[is-shorts], ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts]),
    ytd-reel-shelf-renderer, grid-shelf-view-model:has(ytm-shorts-lockup-view-model),
    ytd-rich-section-renderer:has(ytm-shorts-lockup-view-model),
    ytd-guide-entry-renderer:has(a[title="Shorts"]), ytd-mini-guide-entry-renderer[aria-label="Shorts"],
    ytd-video-renderer:has(a[href^="/shorts/"]), ytd-grid-video-renderer:has(a[href^="/shorts/"]),
    ytd-rich-item-renderer:has(a[href^="/shorts/"]), ytd-compact-video-renderer:has(a[href^="/shorts/"]),
    yt-tab-shape[tab-title="Shorts"] { display: none !important; }`,
  hideEndCards: `
    .ytp-ce-element, .ytp-cards-teaser, .ytp-cards-button { display: none !important; }`,
};
const BASE_CSS = `
  #ranch-sb-markers { position: absolute; left: 0; right: 0; bottom: 0; height: 100%; pointer-events: none; z-index: 33; }
  #ranch-sb-markers > div { position: absolute; top: 0; bottom: 0; min-width: 2px; opacity: .9; }
  #ranch-sb-toast { position: absolute; right: 16px; bottom: 72px; z-index: 70; display: flex; align-items: center; gap: 10px;
    padding: 8px 8px 8px 14px; border-radius: 8px; background: rgba(15,15,15,.9); color: #f1f1f1;
    font: 500 13px/1.2 Roboto, "Segoe UI", sans-serif; opacity: 0; transform: translateY(6px);
    transition: opacity .18s, transform .18s; pointer-events: none; }
  #ranch-sb-toast.show { opacity: 1; transform: none; pointer-events: auto; }
  #ranch-sb-toast i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
  #ranch-sb-toast button { border: 0; border-radius: 6px; padding: 6px 10px; background: rgba(255,255,255,.12); color: #fff;
    font: inherit; cursor: pointer; }
  #ranch-sb-toast button:hover { background: rgba(255,255,255,.22); }
  .ranch-ryd-bar { position: absolute; left: 10px; right: 10px; bottom: -5px; height: 2px; border-radius: 1px;
    background: rgba(255,255,255,.18); overflow: hidden; pointer-events: none; }
  .ranch-ryd-bar > div { height: 100%; background: #f1f1f1; }
  html:not([dark]) .ranch-ryd-bar { background: rgba(0,0,0,.15); }
  html:not([dark]) .ranch-ryd-bar > div { background: #0f0f0f; }
  .ranch-top-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; border: 0;
    border-radius: 18px; cursor: pointer; font: 500 14px/1 Roboto, "Segoe UI", sans-serif; white-space: nowrap; flex: none; }
  #ranch-settings-btn { width: 40px; padding: 0; margin-right: 4px; background: transparent; color: var(--yt-spec-text-primary, #f1f1f1); }
  #ranch-settings-btn:hover { background: var(--yt-spec-badge-chip-background, rgba(255,255,255,.1)); }
  #ranch-update-btn { padding: 0 16px; margin-right: 8px; background: #1ed760; color: #04210f; font-weight: 600; }
  #ranch-update-btn:hover:not(:disabled) { background: #1bc456; }
  #ranch-pip-btn svg { width: 100%; height: 100%; }
  .ranch-dislike-count { margin-left: 6px; }
`;
webFrame.insertCSS(BASE_CSS);
const sheetKeys = {};
function applyCss() {
  for (const [key, css] of Object.entries(SHEETS)) {
    if (cfg[key] && !sheetKeys[key]) sheetKeys[key] = webFrame.insertCSS(css);
    else if (!cfg[key] && sheetKeys[key]) { webFrame.removeInsertedCSS(sheetKeys[key]); delete sheetKeys[key]; }
  }
}
applyCss();

const playerEl = () => (location.pathname.startsWith('/shorts/') && document.getElementById('shorts-player'))
  || document.getElementById('movie_player');
const videoEl = () => { const p = playerEl(); return p && p.querySelector('video'); };

// ------------------------------------------------------- popups and nags
let enforcementLogged = false;
setInterval(() => {
  // YouTube's "Ad blockers aren't allowed" popup: close it and keep watching
  if (cfg.adblock) {
    const enf = $('ytd-enforcement-message-view-model');
    if (enf) {
      const dlg = enf.closest('tp-yt-paper-dialog');
      (dlg || enf).remove();
      $$('tp-yt-iron-overlay-backdrop').forEach((b) => b.remove());
      const v = videoEl();
      if (v && v.paused) document.dispatchEvent(new CustomEvent('rt:control', { detail: 'play' }));
      if (!enforcementLogged) { enforcementLogged = true; log('Closed YouTube\'s ad blocker popup'); }
    }
  }
  if (cfg.hideUpsells) {
    $$('ytd-popup-container yt-mealbar-promo-renderer, ytd-popup-container ytd-mealbar-promo-renderer').forEach((el) => {
      const d = el.closest('tp-yt-paper-dialog');
      if (d) d.remove();
    });
  }
  // "Video paused. Continue watching?"
  if (cfg.noAfkPause) {
    for (const d of $$('ytd-popup-container yt-confirm-dialog-renderer')) {
      if (d.offsetParent === null) continue;
      const text = d.textContent || '';
      if (/continue watching/i.test(text)) {
        const btn = d.querySelector('#confirm-button button, #confirm-button tp-yt-paper-button, #confirm-button');
        if (btn) { btn.click(); log('Dismissed "Continue watching?"'); }
      }
    }
  }
  // Share dialog: show the link without the tracking part
  if (cfg.cleanShareLinks) {
    const input = $('#share-url');
    if (input && /[?&]si=/.test(input.value)) {
      try {
        const u = new URL(input.value);
        u.searchParams.delete('si');
        input.value = u.toString();
      } catch { /* ignore */ }
    }
  }
}, 700);

// ---------------------------------------------------------- Shorts → normal player
document.addEventListener('click', (e) => {
  if (!cfg.shortsAsVideos || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const a = e.target.closest && e.target.closest('a[href*="/shorts/"]');
  if (!a) return;
  const m = /\/shorts\/([\w-]{11})/.exec(a.getAttribute('href') || '');
  if (!m) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  location.assign(`/watch?v=${m[1]}`);
}, true);
ipcRenderer.on('yt:open-watch', (_e, url) => {
  if (cfg.shortsAsVideos && /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(url)) location.replace(url);
});

// ----------------------------------------------------------- SponsorBlock
const SB = {
  sponsor: ['Sponsor', '#00d400'],
  selfpromo: ['Self-promotion', '#ffff00'],
  interaction: ['Subscribe reminder', '#cc00ff'],
  intro: ['Intro', '#00ffff'],
  outro: ['Credits', '#0202ed'],
  preview: ['Preview', '#008fd6'],
  hook: ['Hook', '#395699'],
  filler: ['Tangent', '#7300ff'],
  music_offtopic: ['Non-music part', '#ff9900'],
};
let segments = [];
let segmentsFor = null;
const unskipped = new Set(); // segments you chose to watch with Undo
let adShowing = false;

async function loadSegments(videoId) {
  if (videoId === segmentsFor) return;
  segmentsFor = videoId;
  segments = [];
  unskipped.clear();
  renderMarkers();
  if (!cfg.sponsorBlock || !videoId) return;
  try {
    const res = await ipcRenderer.invoke('yt:segments', videoId);
    if (segmentsFor === videoId) { segments = res || []; renderMarkers(); }
  } catch { /* ignore */ }
}

function renderMarkers() {
  const bar = $('#movie_player .ytp-progress-bar');
  let box = document.getElementById('ranch-sb-markers');
  const v = videoEl();
  const dur = v && Number.isFinite(v.duration) ? v.duration : 0;
  if (!bar || !cfg.sponsorBlock || !cfg.sponsorBarMarkers || !segments.length || !dur || adShowing) { if (box) box.remove(); return; }
  if (!box) { box = document.createElement('div'); box.id = 'ranch-sb-markers'; }
  if (box.parentElement !== bar) bar.appendChild(box);
  const key = `${segmentsFor}|${dur}|${segments.length}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(...segments.map((s) => {
    const d = document.createElement('div');
    d.style.left = `${(s.start / dur) * 100}%`;
    d.style.width = `${(Math.max(0, s.end - s.start) / dur) * 100}%`;
    d.style.background = (SB[s.category] || ['', '#00d400'])[1];
    return d;
  }));
}

let toastTimer = null;
function showSkipToast(seg) {
  const p = playerEl();
  if (!p) return;
  let t = document.getElementById('ranch-sb-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'ranch-sb-toast';
    const dot = document.createElement('i');
    const label = document.createElement('span');
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Undo';
    t.append(dot, label, undo);
  }
  if (t.parentElement !== p) p.appendChild(t);
  const [name, color] = SB[seg.category] || ['segment', '#00d400'];
  t.querySelector('i').style.background = color;
  t.querySelector('span').textContent = `Skipped ${name.toLowerCase()}`;
  t.querySelector('button').onclick = (e) => {
    e.stopPropagation();
    unskipped.add(seg.uuid);
    const v = videoEl();
    if (v) v.currentTime = seg.start;
    t.classList.remove('show');
  };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}

setInterval(() => {
  if (!cfg.sponsorBlock || !segments.length || adShowing) return;
  const v = videoEl();
  if (!v || v.paused) return;
  const t = v.currentTime;
  for (const s of segments) {
    if (unskipped.has(s.uuid)) continue;
    if (t >= s.start && t < s.end - 0.3) {
      v.currentTime = Number.isFinite(v.duration) ? Math.min(s.end, v.duration) : s.end;
      showSkipToast(s);
      break;
    }
  }
}, 200);

// -------------------------------------------------- Return YouTube Dislike
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
let votes = null;
let votesFor = null;
let pressedAtLoad = null;

async function loadVotes(videoId) {
  if (videoId === votesFor) return;
  votesFor = videoId;
  votes = null;
  pressedAtLoad = null;
  if (!cfg.dislikes || !videoId) return;
  try {
    const v = await ipcRenderer.invoke('yt:votes', videoId);
    if (votesFor === videoId) votes = v;
  } catch { /* ignore */ }
}

function dislikeParts() {
  const root = $('ytd-watch-metadata #top-level-buttons-computed') || $('#top-level-buttons-computed');
  if (!root) return null;
  const btn = root.querySelector('dislike-button-view-model button, #segmented-dislike-button button');
  const likeBtn = root.querySelector('like-button-view-model button, #segmented-like-button button');
  const group = root.querySelector('segmented-like-dislike-button-view-model, ytd-segmented-like-dislike-button-renderer');
  return btn ? { btn, likeBtn, group } : null;
}

function renderDislikes() {
  const parts = location.pathname === '/watch' ? dislikeParts() : null;
  const old = $$('.ranch-dislike-count, .ranch-ryd-bar');
  if (!parts || !cfg.dislikes || !votes) { old.forEach((n) => n.remove()); return; }
  const { btn, likeBtn, group } = parts;
  const pressed = btn.getAttribute('aria-pressed') === 'true';
  if (pressedAtLoad === null) pressedAtLoad = pressed;
  const dislikes = Math.max(0, votes.dislikes + (pressed ? 1 : 0) - (pressedAtLoad ? 1 : 0));

  let label = btn.querySelector('.ranch-dislike-count');
  if (!label) {
    label = document.createElement('div');
    label.className = 'yt-spec-button-shape-next__button-text-content ranch-dislike-count';
    btn.appendChild(label);
  }
  if (btn.classList.contains('yt-spec-button-shape-next--icon-button')) {
    btn.classList.remove('yt-spec-button-shape-next--icon-button');
    btn.classList.add('yt-spec-button-shape-next--icon-leading');
  }
  const text = compact.format(dislikes);
  if (label.textContent !== text) label.textContent = text;
  btn.title = `${dislikes.toLocaleString()} dislikes (estimate from Return YouTube Dislike)`;

  // Like / dislike ratio bar under the buttons
  let likes = votes.likes;
  const likeText = likeBtn && likeBtn.getAttribute('aria-label');
  const m = likeText && likeText.replace(/[.,\s  ]/g, '').match(/(\d+)/);
  if (m && Number(m[1]) > likes) likes = Number(m[1]);
  if (group) {
    if (getComputedStyle(group).position === 'static') group.style.position = 'relative';
    let bar = group.querySelector('.ranch-ryd-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'ranch-ryd-bar';
      bar.appendChild(document.createElement('div'));
      group.appendChild(bar);
    }
    const total = likes + dislikes;
    const pct = total ? (likes / total) * 100 : 100;
    bar.firstChild.style.width = `${pct.toFixed(1)}%`;
    bar.title = `${pct.toFixed(1)}% liked`;
  }
}
setInterval(renderDislikes, 800);

// ------------------------------------------------- picture-in-picture button
const PIP_PATH = 'M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.99 2 1.99h18c1.1 0 2-.89 2-1.99V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z';
function svgIcon(d, size) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', size === 36 ? '-6 -6 36 36' : '0 0 24 24');
  svg.setAttribute('width', String(size || 24));
  svg.setAttribute('height', String(size || 24));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
}
function renderPipButton() {
  const host = $('#movie_player .ytp-right-controls');
  if (!host || !document.pictureInPictureEnabled) return;
  let btn = document.getElementById('ranch-pip-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'ranch-pip-btn';
    btn.className = 'ytp-button';
    btn.title = 'Picture in picture (Ctrl+Shift+P)';
    btn.setAttribute('aria-label', 'Picture in picture');
    btn.appendChild(svgIcon(PIP_PATH, 36));
    btn.addEventListener('click', () => {
      const v = videoEl();
      if (!v) return;
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else v.requestPictureInPicture().catch(() => {});
    });
  }
  // Sit just left of the theater / full-screen buttons, whatever wraps them
  const before = host.querySelector('.ytp-size-button') || host.querySelector('.ytp-fullscreen-button');
  const parent = before ? before.parentElement : host;
  if (btn.parentElement !== parent) parent.insertBefore(btn, before || null);
}

// --------------------------------------------- top bar: settings + Update
let updateState = null;
const GEAR_PATH = 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z';
const DOWNLOAD_PATH = 'M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1Zm-7 15a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z';

function updateLabel(s) {
  if (!s) return null;
  if (s.status === 'available') return { text: 'Update', title: `Update to version ${s.version}`, busy: false };
  if (s.status === 'downloading') return { text: `Updating… ${s.percent || 0}%`, title: 'Downloading the update', busy: true };
  if (s.status === 'ready') return { text: 'Restart to update', title: `Version ${s.version} is ready`, busy: false };
  if (s.status === 'error' && s.version) return { text: 'Retry update', title: s.error || 'The update failed', busy: false };
  return null;
}

function renderTopButtons() {
  const host = $('ytd-masthead #end');
  if (!host) return;
  let gear = document.getElementById('ranch-settings-btn');
  if (!gear) {
    gear = document.createElement('button');
    gear.id = 'ranch-settings-btn';
    gear.type = 'button';
    gear.className = 'ranch-top-btn';
    gear.title = 'App settings: ad blocking, SponsorBlock, dislikes and more (Ctrl+,)';
    gear.setAttribute('aria-label', 'App settings');
    gear.appendChild(svgIcon(GEAR_PATH, 24));
    gear.addEventListener('click', () => ipcRenderer.send('yt:open-settings'));
  }
  if (gear.parentElement !== host || host.firstChild !== gear) host.insertBefore(gear, host.firstChild);

  const want = updateLabel(updateState);
  let upd = document.getElementById('ranch-update-btn');
  if (!want) { if (upd) upd.remove(); return; }
  if (!upd) {
    upd = document.createElement('button');
    upd.id = 'ranch-update-btn';
    upd.type = 'button';
    upd.className = 'ranch-top-btn';
    upd.addEventListener('click', () => ipcRenderer.send('tb:update-install'));
  }
  if (upd.parentElement !== host || upd.nextSibling !== gear) host.insertBefore(upd, gear);
  const key = `${want.busy}|${want.text}`;
  if (upd.dataset.key !== key) {
    upd.dataset.key = key;
    upd.replaceChildren();
    if (!want.busy) upd.appendChild(svgIcon(DOWNLOAD_PATH, 18));
    const span = document.createElement('span');
    span.textContent = want.text;
    upd.appendChild(span);
  }
  upd.title = want.title;
  upd.disabled = want.busy;
}
ipcRenderer.on('tb:update', (_e, s) => { updateState = s; renderTopButtons(); });
ipcRenderer.invoke('tb:update-get').then((s) => { updateState = s; renderTopButtons(); }).catch(() => {});
setInterval(() => { renderTopButtons(); renderPipButton(); renderMarkers(); }, 1000);

// -------------------------------------------------------- now-playing bridge
let lastSent = '';
let lastSentAt = 0;
document.addEventListener('rt:state', (e) => {
  let state = null;
  try { state = JSON.parse(e.detail); } catch { return; }
  adShowing = !!(state && state.adShowing);
  if (state && !state.adShowing) { loadSegments(state.videoId); loadVotes(state.videoId); }
  const key = state ? JSON.stringify({ ...state, currentTime: 0 }) : 'null';
  if (key !== lastSent || Date.now() - lastSentAt > 5000) {
    lastSent = key;
    lastSentAt = Date.now();
    ipcRenderer.send('yt:now-playing', state);
  }
});
document.addEventListener('rt:log', (e) => {
  try { log(JSON.parse(e.detail)); } catch { /* ignore */ }
});
let prunedLogged = 0;
document.addEventListener('rt:pruned', (e) => {
  const n = Number(e.detail) || 0;
  if (n - prunedLogged >= 1) { prunedLogged = n; log(`Removed ads from player data (${n} so far)`); }
});

ipcRenderer.on('yt:control', (_e, action) => {
  document.dispatchEvent(new CustomEvent('rt:control', { detail: action }));
});
ipcRenderer.on('yt:config', (_e, next) => {
  cfg = next;
  applyCss();
  segmentsFor = null;
  votesFor = null;
  document.dispatchEvent(new CustomEvent('rt:config', { detail: JSON.stringify(cfg) }));
});
