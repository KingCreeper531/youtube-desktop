const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Ad blocking
  adblock: true,            // strip ads from player data + skip any that slip through
  networkBlocking: true,    // EasyList / tracker blocking (Ghostery engine)
  hideFeedAds: true,        // sponsored cards in the feed, search and sidebar
  hideUpsells: true,        // "Get Premium" banners & popups
  // SponsorBlock
  sponsorBlock: true,
  sponsorCategories: ['sponsor', 'selfpromo', 'interaction'],
  sponsorBarMarkers: true,  // show segments on the progress bar
  // Return YouTube Dislike
  dislikes: true,
  // Quality of life
  hideShorts: false,        // hide Shorts shelves and the Shorts tab
  shortsAsVideos: false,    // open Shorts in the normal player instead of the Shorts feed
  quality: 'auto',          // auto | highest | 2160 | 1440 | 1080 | 720 | 480
  rememberSpeed: true,      // keep your playback speed for the next video
  theaterMode: false,       // open videos in theater mode
  hideEndCards: false,      // hide the video cards that cover the last seconds
  cleanShareLinks: true,    // remove the tracking "si=" part from copied links
  noAfkPause: true,         // never show "Video paused. Continue watching?"
  backgroundPlay: true,     // keep playing when minimized or hidden
  // Discord
  discord: true,
  discordClientId: '',
  discordHidePaused: false,
  discordShowButton: true,
  // Window
  closeToTray: false,
  bounds: { width: 1360, height: 860 },
  maximized: false,
};

const file = () => path.join(app.getPath('userData'), 'config.json');
let data = null;
const listeners = new Set();

function load() {
  if (data) return data;
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  watchForOutsideChanges();
  return data;
}

let saveTimer = null;
let lastWritten = null; // our own last save, so the file watcher can ignore it
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      lastWritten = JSON.stringify(data, null, 2);
      fs.writeFileSync(file(), lastWritten);
    } catch (e) {
      console.error('config save failed', e);
    }
  }, 250);
}

// Settings can also be changed from outside the app (the Ranch Launcher edits this
// file). Pick those changes up and apply them like any change made in Settings.
let watching = false;
function watchForOutsideChanges() {
  if (watching) return;
  watching = true;
  try {
    const dir = path.dirname(file());
    fs.mkdirSync(dir, { recursive: true });
    let timer = null;
    fs.watch(dir, { persistent: false }, (_event, name) => {
      if (name && name !== 'config.json') return;
      clearTimeout(timer);
      timer = setTimeout(reloadFromDisk, 150);
    });
  } catch { /* watching isn't available; changes apply on next start */ }
}

function reloadFromDisk() {
  let text;
  try { text = fs.readFileSync(file(), 'utf8'); } catch { return; }
  if (text === lastWritten) return;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; } // half-written; the next event retries
  const before = { ...load() };
  const next = { ...DEFAULTS, ...parsed };
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  data = next;
  lastWritten = text;
  for (const fn of listeners) fn(data, before);
}

function get(key) {
  return load()[key];
}

function set(patch) {
  const before = { ...load() };
  Object.assign(data, patch);
  save();
  for (const fn of listeners) fn(data, before);
}

function onChange(fn) {
  listeners.add(fn);
}

module.exports = { load, get, set, onChange, DEFAULTS };
