const {
  app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage, shell, net, dialog,
} = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const { DiscordPresence } = require('./discord');
const updater = require('./updater');

const YT_URL = 'https://www.youtube.com/';
const PARTITION = 'persist:youtube';
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const APP_NAME = 'YouTube';

const APP_ID = 'local.ranch.youtube';
app.setAppUserModelId(APP_ID);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Developer test hook: run a separate copy alongside the installed app
if (process.env.RANCHYT_USER_DATA) app.setPath('userData', process.env.RANCHYT_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let settingsWin = null;
let tray = null;
let quitting = false;
let blocker = null;
let nowPlaying = null;

const logFile = () => path.join(app.getPath('userData'), 'youtube.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(logFile(), line); } catch { /* ignore */ }
}

const discord = new DiscordPresence(log);

// Keep the Start Menu shortcut (what Windows search finds) in place.
function ensureShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  const opts = {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    description: APP_NAME,
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId: APP_ID,
  };
  const fix = (lnk) => {
    let current = null;
    try { current = shell.readShortcutLink(lnk); } catch { /* missing */ }
    const ok = current
      && path.resolve(current.target).toLowerCase() === path.resolve(process.execPath).toLowerCase()
      && current.appUserModelId === APP_ID;
    if (!ok) {
      try {
        fs.mkdirSync(path.dirname(lnk), { recursive: true });
        shell.writeShortcutLink(lnk, current ? 'replace' : 'create', opts);
        log(`${current ? 'Repaired' : 'Created'} shortcut: ${lnk}`);
      } catch (e) { log(`Shortcut failed (${lnk}): ${e.message}`); }
    }
  };
  fix(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`));
  if (!config.get('desktopShortcutDone')) {
    fix(path.join(app.getPath('desktop'), `${APP_NAME}.lnk`));
    config.set({ desktopShortcutDone: true });
  }
}

function isClosedToTray() {
  return !BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
}
function onWindowHiddenChanged() {
  setImmediate(() => discord.setActivity(buildActivity(nowPlaying)));
}

// ---------------------------------------------------------------- sign-in
// Google refuses sign-in from browsers that announce themselves as Electron,
// so present a plain Chrome user agent.
function cleanUserAgent(ua) {
  return ua
    .replace(/\s?Electron\/\S+/i, '')
    .replace(new RegExp(`\\s?${app.getName()}\\/\\S+`, 'i'), '')
    .replace(/\s?ranch-youtube\/\S+/i, '');
}

const SIGNIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const isGoogleAccounts = (url) => {
  try { return /^accounts\.google\.[a-z.]+$/.test(new URL(url).hostname); } catch { return false; }
};

function setupSignInHeaders(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*', 'https://*.google.com/*'] }, (details, cb) => {
    const fromSignIn = signInWin && !signInWin.isDestroyed() && details.webContentsId === signInWin.webContents.id;
    if (!fromSignIn && !isGoogleAccounts(details.url)) return cb({ requestHeaders: details.requestHeaders });
    const headers = {};
    for (const [k, v] of Object.entries(details.requestHeaders)) {
      if (!/^sec-ch-ua/i.test(k)) headers[k] = v;
    }
    headers['User-Agent'] = SIGNIN_UA;
    cb({ requestHeaders: headers });
  });
}

// Google blocks password sign-in in embedded browsers, so by default we offer
// to reuse the YouTube sign-in the user already has in Firefox.
async function signInWithFirefox() {
  const { importInto } = require('./firefox-signin');
  let res;
  try {
    res = await importInto(session.fromPartition(PARTITION));
  } catch (e) {
    res = { ok: false, reason: e.message };
  }
  if (res.ok) {
    log(`Imported Firefox sign-in (${res.imported} cookies)`);
    if (signInWin && !signInWin.isDestroyed()) signInWin.close();
    win?.loadURL(YT_URL);
    showWindow();
    return { ok: true };
  }
  log(`Firefox sign-in import failed: ${res.reason}`);
  const msg = {
    'no-firefox': ['Firefox isn\'t installed on this PC.',
      'Google doesn\'t allow signing in inside apps, so this app borrows your sign-in from Firefox (or Zen, LibreWolf, Waterfox or Floorp).\n\nInstall Firefox from firefox.com, sign in at youtube.com there, then click "Sign in with Firefox" again. You can also try "Try Google sign-in page".'],
    'not-signed-in': ['Firefox isn\'t signed in to YouTube.',
      'Open youtube.com in Firefox, sign in there, then click "Sign in with Firefox" again.\n\nKeep Firefox signed in afterwards: signing out of YouTube in Firefox signs this app out too.'],
  }[res.reason] || ['Couldn\'t read your Firefox sign-in.', `Close Firefox and try again.\n\nDetails: ${res.reason}`];
  const { response } = await dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: APP_NAME,
    message: msg[0],
    detail: msg[1],
    buttons: ['OK', 'Try Google sign-in page'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) openSignIn('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F');
  return { ok: false };
}

async function promptSignIn(url) {
  if (process.env.RANCHYT_NO_SIGNIN) return; // developer test copies never touch your accounts
  const { response } = await dialog.showMessageBox(win || undefined, {
    type: 'question',
    title: 'Sign in',
    message: 'Sign in with your Firefox account?',
    detail: 'Google blocks password sign-in inside apps. YouTube can reuse the YouTube sign-in you already have in Firefox. It stays on this PC.',
    buttons: ['Sign in with Firefox', 'Try Google sign-in page', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0) await signInWithFirefox();
  else if (response === 1) openSignIn(url);
}

let signInWin = null;
function openSignIn(url) {
  if (signInWin && !signInWin.isDestroyed()) { signInWin.focus(); return; }
  signInWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: `Sign in — ${APP_NAME}`,
    icon: ICON,
    parent: win || undefined,
    backgroundColor: '#202124',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'signin-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  signInWin.setMenuBarVisibility(false);
  signInWin.webContents.setUserAgent(SIGNIN_UA);
  signInWin.webContents.setWindowOpenHandler(({ url: u }) => {
    signInWin.loadURL(u);
    return { action: 'deny' };
  });
  signInWin.webContents.on('did-navigate', (_e, u) => {
    try {
      if (new URL(u).hostname === 'www.youtube.com') {
        signInWin.close();
        win?.loadURL(YT_URL);
        log('Signed in');
      }
    } catch { /* ignore */ }
  });
  signInWin.on('closed', () => { signInWin = null; });
  signInWin.loadURL(url);
}

// ---------------------------------------------------------------- ad blocking
async function setupNetworkBlocking(ses) {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(net.fetch.bind(net), {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    // Only block requests. The library's own page scripts clash with this app's ad
    // removal on YouTube (they wrap the same functions until the page overflows and
    // the player never starts), and the app already handles what they would do.
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (!config.get('networkBlocking') || details.resourceType === 'mainFrame') return callback({});
      try { blocker.onBeforeRequest(details, callback); } catch { callback({}); }
    });
    let count = 0;
    blocker.on('request-blocked', () => { count++; });
    setInterval(() => { if (count) log(`Network blocker: ${count} requests blocked so far`); }, 5 * 60 * 1000);
    log('Network ad/tracker blocking ready');
  } catch (e) {
    log(`Network blocking unavailable: ${e.message}`);
  }
}

// ---------------------------------------------------------------- main window
const shortsToWatch = (url) => {
  try {
    const u = new URL(url);
    const m = /^\/shorts\/([\w-]{11})/.exec(u.pathname);
    if (u.hostname.endsWith('youtube.com') && m) return `https://www.youtube.com/watch?v=${m[1]}`;
  } catch { /* ignore */ }
  return null;
};

function createWindow() {
  const cfg = config.load();
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));

  win = new BrowserWindow({
    ...cfg.bounds,
    minWidth: 480,
    minHeight: 360,
    title: APP_NAME,
    icon: ICON,
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep playing smoothly when minimized
      autoplayPolicy: 'no-user-gesture-required', // videos opened from links start by themselves
    },
  });
  win.setMenuBarVisibility(false);
  if (cfg.maximized) win.maximize();
  // Test copies (RANCHYT_HIDDEN) stay hidden so they never pop up over what you're doing
  if (!process.env.RANCHYT_HIDDEN) win.once('ready-to-show', () => win.show());

  // Use the video title for the window title, without YouTube's notification count
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    const clean = String(title || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();
    win.setTitle(clean && clean !== 'YouTube' ? `${clean} · ${APP_NAME}` : APP_NAME);
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) {
      config.set({ maximized: win.isMaximized() });
    } else {
      config.set({ bounds: win.getBounds(), maximized: false });
    }
  };
  let boundsTimer;
  win.on('resize', () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 500); });
  win.on('move', () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 500); });

  win.on('close', (e) => {
    saveBounds();
    if (!quitting && config.get('closeToTray')) {
      e.preventDefault();
      win.hide();
      onWindowHiddenChanged();
      if (!config.get('trayHintShown') && tray) {
        config.set({ trayHintShown: true });
        tray.displayBalloon({
          iconType: 'info',
          title: `${APP_NAME} is still running`,
          content: 'Right-click the tray icon and choose Quit to close it completely.',
        });
      }
    }
  });
  win.on('show', onWindowHiddenChanged);
  win.on('hide', onWindowHiddenChanged);
  win.on('closed', () => { win = null; });

  // Links that leave YouTube / Google sign-in open in the default browser
  const internal = (url) => {
    try {
      const h = new URL(url).hostname;
      if (h === 'music.youtube.com') return false; // that's the YouTube Music app's job
      return /(^|\.)(youtube\.com|youtu\.be|google\.com|youtube-nocookie\.com|gstatic\.com|googleusercontent\.com|accounts\.google\.[a-z.]+)$/.test(h);
    } catch { return false; }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleAccounts(url)) promptSignIn(url);
    else if (internal(url)) win.loadURL(url);
    else shell.openExternal(url);
    return { action: 'deny' };
  });
  // Clicking "Sign in" (a link to Google) always offers the browser sign-in, like YouTube Music.
  // YouTube also checks sign-in quietly in the background ("passive" redirects that bounce
  // straight back); let those through so no prompt pops up on its own.
  let lastPrompt = 0;
  const toSignIn = (e, url, clicked) => {
    if (!isGoogleAccounts(url)) return false;
    if (!clicked && /[?&]passive=(true|1)\b/.test(url)) return false;
    e.preventDefault();
    if (!clicked && Date.now() - lastPrompt < 30000) return true; // a redirect loop: don't stack dialogs
    lastPrompt = Date.now();
    log(`Sign-in requested: ${url.split('?')[0]}`);
    promptSignIn(url);
    return true;
  };
  win.webContents.on('will-redirect', (e, url) => { toSignIn(e, url, false); });
  win.webContents.on('will-navigate', (e, url) => {
    if (toSignIn(e, url, true)) return;
    if (!internal(url)) {
      e.preventDefault();
      shell.openExternal(url);
      return;
    }
    const watch = config.get('shortsAsVideos') && shortsToWatch(url);
    if (watch) { e.preventDefault(); win.loadURL(watch); }
  });
  win.webContents.on('did-navigate', (_e, url) => log(`Page: ${String(url).split('&')[0]}`));
  // Shorts opened inside the page (no full page load): reopen in the normal player
  win.webContents.on('did-navigate-in-page', (_e, url) => {
    const watch = config.get('shortsAsVideos') && shortsToWatch(url);
    if (watch) win.webContents.send('yt:open-watch', watch);
  });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && !input.shift && input.key.toLowerCase() === 'r')) win.webContents.reload();
    else if (input.key === 'F12') win.webContents.toggleDevTools();
    else if (input.control && input.key === ',') { e.preventDefault(); openSettings(); }
    else if (input.control && input.shift && input.key.toLowerCase() === 'p') { e.preventDefault(); togglePip(); }
    else if (input.alt && input.key === 'ArrowLeft' && win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack();
    else if (input.alt && input.key === 'ArrowRight' && win.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
  });

  if (process.env.RANCHYT_MUTE) win.webContents.setAudioMuted(true);
  win.loadURL(process.env.RANCHYT_START_URL || YT_URL);
}

function togglePip() {
  // Runs with a user gesture, which picture-in-picture needs
  win?.webContents.executeJavaScript(`(() => {
    const v = document.querySelector('#movie_player video');
    if (!v) return;
    if (document.pictureInPictureElement) document.exitPictureInPicture();
    else v.requestPictureInPicture().catch(() => {});
  })()`, true).catch(() => {});
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- settings
function openSettings() {
  if (settingsWin) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560,
    height: 760,
    resizable: true,
    title: `${APP_NAME} Settings`,
    icon: ICON,
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    parent: win || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') settingsWin.close();
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------------------------------------------------------------- tray
function sendControl(action) {
  win?.webContents.send('yt:control', action);
}

function updateTray() {
  if (!tray) return;
  const np = nowPlaying;
  const label = np?.title ? `${np.title}`.slice(0, 60) : 'Nothing playing';
  tray.setToolTip(np?.title ? `${APP_NAME}\n${label}` : APP_NAME);
  const up = updater.getState();
  const updateItems = up.status === 'available' || up.status === 'ready'
    ? [{ label: `Update to v${up.version}`, click: () => updater.install() }, { type: 'separator' }]
    : [];
  tray.setContextMenu(Menu.buildFromTemplate([
    ...updateItems,
    { label, enabled: false },
    { type: 'separator' },
    { label: np && !np.paused ? 'Pause' : 'Play', click: () => sendControl('playpause'), enabled: !!np },
    { label: 'Next video', click: () => sendControl('next'), enabled: !!np },
    { label: 'Picture in picture', click: togglePip, enabled: !!np },
    { type: 'separator' },
    { label: `Show ${APP_NAME}`, click: showWindow },
    { label: 'Sign in with Firefox', click: () => signInWithFirefox() },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', () => {
    if (win && win.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  });
  updateTray();
}

// ---------------------------------------------------------------- now playing → Discord
function buildActivity(np) {
  if (!np || !np.title) return null;
  if (np.paused && config.get('discordHidePaused')) return null;
  if (np.paused && isClosedToTray()) return null;

  const fit = (s, fallback) => {
    s = String(s || '').trim() || fallback;
    if (s.length < 2) s += '⠀';
    return s.length > 128 ? `${s.slice(0, 125)}...` : s;
  };

  const activity = {
    type: 3, // "Watching"
    status_display_type: 2, // member list shows the video title
    details: fit(np.title, 'A video'),
    state: np.paused ? '(Paused)' : fit(np.live ? `${np.channel || 'YouTube'} · LIVE` : np.channel, 'YouTube'),
    assets: {
      large_image: `https://i.ytimg.com/vi/${np.videoId}/hqdefault.jpg`,
      large_text: fit(np.channel, 'YouTube'),
    },
    instance: false,
  };

  if (!np.paused && !np.live && np.duration > 0 && np.duration < 24 * 3600) {
    const rate = np.rate > 0 ? np.rate : 1;
    const start = Date.now() - Math.round((np.currentTime / rate) * 1000);
    activity.timestamps = {
      start: Math.round(start / 1000) * 1000,
      end: Math.round((start + (np.duration / rate) * 1000) / 1000) * 1000,
    };
  }

  if (config.get('discordShowButton') && np.videoId) {
    activity.buttons = [{ label: 'Watch on YouTube', url: `https://www.youtube.com/watch?v=${np.videoId}` }];
  }
  return activity;
}

let lastStartSent = 0;
function onNowPlaying(np) {
  const prev = nowPlaying;
  nowPlaying = np;
  const trackChanged = !prev || prev.videoId !== np?.videoId || prev.title !== np?.title;
  const pauseChanged = !prev || prev.paused !== np?.paused;

  if (trackChanged || pauseChanged) {
    log(np?.title ? `Now watching: "${np.title}" by ${np.channel} [${np.paused ? 'paused' : 'playing'}] ${Math.round(np.duration)}s` : 'Nothing playing');
    updateTray();
  }
  const activity = buildActivity(np);
  if (!trackChanged && !pauseChanged && activity?.timestamps) {
    if (Math.abs(activity.timestamps.start - lastStartSent) < 3000) return;
  }
  if (activity?.timestamps) lastStartSent = activity.timestamps.start;
  discord.setActivity(activity);
}

// ---------------------------------------------------------------- SponsorBlock
// Asks with only the first 4 characters of the video ID's hash, so the server
// never learns which video you're watching.
const sbCache = new Map();
async function getSegments(videoId) {
  if (!config.get('sponsorBlock') || !/^[\w-]{11}$/.test(videoId || '')) return [];
  const cats = config.get('sponsorCategories') || [];
  if (!cats.length) return [];
  const key = `${videoId}|${cats.join(',')}`;
  if (sbCache.has(key)) return sbCache.get(key);
  let segments = [];
  try {
    const prefix = crypto.createHash('sha256').update(videoId).digest('hex').slice(0, 4);
    const url = `https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${encodeURIComponent(JSON.stringify(cats))}`;
    const res = await net.fetch(url);
    if (res.ok) {
      const data = await res.json();
      const mine = (Array.isArray(data) ? data : []).find((v) => v.videoID === videoId);
      segments = (mine?.segments || [])
        .filter((s) => !s.actionType || s.actionType === 'skip')
        .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category, uuid: s.UUID }));
    }
  } catch { /* offline or no segments */ }
  sbCache.set(key, segments);
  if (sbCache.size > 300) sbCache.delete(sbCache.keys().next().value);
  return segments;
}

// ---------------------------------------------------------------- Return YouTube Dislike
const rydCache = new Map();
async function getVotes(videoId) {
  if (!config.get('dislikes') || !/^[\w-]{11}$/.test(videoId || '')) return null;
  const hit = rydCache.get(videoId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.votes;
  let votes = null;
  try {
    const res = await net.fetch(`https://returnyoutubedislikeapi.com/votes?videoId=${videoId}`);
    if (res.ok) {
      const d = await res.json();
      votes = { likes: Number(d.likes) || 0, dislikes: Number(d.dislikes) || 0 };
    }
  } catch { /* offline */ }
  if (votes) {
    rydCache.set(videoId, { at: Date.now(), votes });
    if (rydCache.size > 300) rydCache.delete(rydCache.keys().next().value);
  }
  return votes;
}

// ---------------------------------------------------------------- IPC
const PAGE_KEYS = [
  'adblock', 'hideFeedAds', 'hideUpsells', 'sponsorBlock', 'sponsorCategories', 'sponsorBarMarkers',
  'dislikes', 'hideShorts', 'shortsAsVideos', 'oldShortsUi', 'quality', 'rememberSpeed', 'theaterMode', 'hideEndCards',
  'cleanShareLinks', 'noAfkPause', 'backgroundPlay',
];
const pageConfig = (cfg = config.load()) => Object.fromEntries(PAGE_KEYS.map((k) => [k, cfg[k]]));

ipcMain.on('yt:get-config', (e) => { e.returnValue = pageConfig(); });
ipcMain.on('yt:now-playing', (_e, np) => onNowPlaying(np));
ipcMain.on('yt:open-settings', () => openSettings());
ipcMain.on('yt:log', (_e, msg) => log(String(msg).slice(0, 300)));
ipcMain.handle('yt:segments', (_e, videoId) => getSegments(String(videoId)));
ipcMain.handle('yt:votes', (_e, videoId) => getVotes(String(videoId)));
ipcMain.handle('tb:settings-get', () => ({ config: config.load(), discordStatus: discord.status, version: app.getVersion() }));
ipcMain.handle('tb:settings-set', (_e, patch) => {
  const allowed = new Set([...Object.keys(config.DEFAULTS)].filter((k) => !['bounds', 'maximized'].includes(k)));
  const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.has(k)));
  config.set(clean);
  return { config: config.load(), discordStatus: discord.status };
});
ipcMain.handle('tb:open-external', (_e, url) => {
  if (/^https:\/\/(discord\.com|sponsor\.ajay\.app|returnyoutubedislike\.com)\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('tb:firefox-signin', () => signInWithFirefox());
ipcMain.handle('tb:update-get', () => updater.getState());
ipcMain.handle('tb:update-check', () => updater.check());
ipcMain.on('tb:update-install', () => updater.install());
ipcMain.handle('tb:clear-data', async () => {
  await session.fromPartition(PARTITION).clearStorageData();
  win?.loadURL(YT_URL);
});

config.onChange((cfg, before) => {
  if (cfg.discord !== before.discord) discord.setEnabled(cfg.discord);
  if (cfg.discordClientId !== before.discordClientId) discord.setClientId(cfg.discordClientId);
  if (cfg.discordHidePaused !== before.discordHidePaused || cfg.discordShowButton !== before.discordShowButton) {
    discord.setActivity(buildActivity(nowPlaying));
  }
  // (networkBlocking is read on every request, so turning it on or off needs nothing here)
  if (PAGE_KEYS.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(before[k]))) {
    sbCache.clear();
    win?.webContents.send('yt:config', pageConfig(cfg));
  }
});

// ---------------------------------------------------------------- app lifecycle
app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'mediaKeySystem', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });

  setupSignInHeaders(ses);
  await setupNetworkBlocking(ses);
  createWindow();
  if (!process.env.RANCHYT_HIDDEN) createTray();

  discord.setClientId(config.get('discordClientId'));
  discord.setEnabled(config.get('discord'));
  ensureShortcuts();

  updater.init({
    logger: log,
    onChange: (state) => {
      win?.webContents.send('tb:update', state);
      settingsWin?.webContents.send('tb:update', state);
      updateTray();
    },
    beforeInstall: () => {
      quitting = true;
      discord.setEnabled(false);
    },
  });
  log(`${APP_NAME} ${app.getVersion()} started (Electron ${process.versions.electron})`);
});

// Clear the Discord status before the app exits (wait at most 1 second for Discord).
let discordCleared = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (discordCleared) return;
  e.preventDefault();
  discord.shutdown().finally(() => {
    discordCleared = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (quitting || !config.get('closeToTray'))) app.quit();
});
