// Checks GitHub Releases for a newer version. Nothing downloads until the
// user clicks the green Update button.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 30 * 60 * 1000;       // background check every 30 minutes
const FOCUS_CHECK_GAP_MS = 10 * 60 * 1000;   // and when you come back to the app, at most every 10 minutes
let lastCheck = 0;

let state = { status: 'idle', current: app.getVersion() };
let onState = () => {};
let log = () => {};
let installAfterDownload = false;
let beforeInstallFn = () => {};

function setState(patch) {
  state = { ...state, ...patch, current: app.getVersion() };
  onState(state);
}

function init({ onChange, logger, beforeInstall }) {
  onState = onChange;
  log = logger;
  beforeInstallFn = beforeInstall;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: () => {}, warn: (m) => log(`updater: ${m}`), error: (m) => log(`updater: ${m}`), debug: () => {} };

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setState({ status: 'latest' }));
  autoUpdater.on('update-available', (info) => {
    log(`Update available: ${info.version}`);
    setState({ status: 'available', version: info.version });
  });
  autoUpdater.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    log(`Update ${info.version} downloaded`);
    setState({ status: 'ready', version: info.version });
    if (installAfterDownload) {
      beforeInstallFn();
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    }
  });
  autoUpdater.on('error', (err) => {
    log(`Update error: ${err?.message || err}`);
    setState({ status: 'error', error: String(err?.message || err).split('\n')[0] });
  });

  if (!app.isPackaged) {
    // Developer preview of the button: TUNEBOX_FAKE_UPDATE=1 npm start
    setState(process.env.TUNEBOX_FAKE_UPDATE ? { status: 'available', version: '9.9.9' } : { status: 'dev' });
    return;
  }
  setTimeout(check, 5000);
  setInterval(check, CHECK_EVERY_MS);
  app.on('browser-window-focus', () => {
    if (Date.now() - lastCheck > FOCUS_CHECK_GAP_MS) check();
  });
}

function check() {
  if (!app.isPackaged) return Promise.resolve(state);
  if (['downloading', 'ready', 'available'].includes(state.status)) return Promise.resolve(state);
  lastCheck = Date.now();
  return autoUpdater.checkForUpdates().then(() => state).catch(() => state);
}

// Download (if needed), then restart into the new version.
const RELEASES_URL = 'https://github.com/KingCreeper531/youtube-desktop/releases/latest';
// The portable .exe can't replace itself, so send people to the download page.
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;

function install() {
  if (isPortable()) {
    require('electron').shell.openExternal(RELEASES_URL);
    return;
  }
  if (state.status === 'ready') {
    beforeInstallFn();
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return;
  }
  // "error" with a version means a download failed: let the button retry it.
  if (state.status !== 'available' && !(state.status === 'error' && state.version)) return;
  installAfterDownload = true;
  setState({ status: 'downloading', percent: 0 });
  autoUpdater.downloadUpdate().catch(() => {});
}

module.exports = { init, check, install, getState: () => state };
