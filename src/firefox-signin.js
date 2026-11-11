// Copies your existing YouTube/Google sign-in from Firefox into the app.
// Google refuses password sign-in inside embedded browsers, but an existing
// Firefox session works fine. Everything happens locally on this PC.
const fs = require('fs');
const os = require('os');
const path = require('path');

const COOKIE_HOST = /(^|\.)(youtube\.com|google\.com)$/;

function firefoxRoot() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Mozilla', 'Firefox');
}

function profileDirs() {
  const root = firefoxRoot();
  const dirs = new Set();
  try {
    const ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8');
    let isRelative = true;
    for (const line of ini.split(/\r?\n/)) {
      if (/^\[/.test(line)) isRelative = true;
      const rel = line.match(/^IsRelative=(\d)/);
      if (rel) isRelative = rel[1] === '1';
      const m = line.match(/^(?:Path|Default)=(.+)$/);
      if (m && /[\\/]/.test(m[1])) dirs.add(isRelative ? path.join(root, m[1]) : m[1]);
    }
  } catch { /* no profiles.ini */ }
  try {
    for (const d of fs.readdirSync(path.join(root, 'Profiles'))) dirs.add(path.join(root, 'Profiles', d));
  } catch { /* ignore */ }
  return [...dirs].map((d) => path.normalize(d)).filter((d) => fs.existsSync(path.join(d, 'cookies.sqlite')));
}

// Firefox keeps the database open; read a copy (with its write-ahead log).
function readProfileCookies(dir) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunebox-ff-'));
  try {
    for (const f of ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm']) {
      const src = path.join(dir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
    }
    const db = new DatabaseSync(path.join(tmp, 'cookies.sqlite'));
    try {
      const rows = db.prepare(`
        SELECT name, value, host, path, expiry, lastAccessed, isSecure, isHttpOnly, sameSite
        FROM moz_cookies
        WHERE originAttributes = '' AND (host LIKE '%youtube.com' OR host LIKE '%google.com')
      `).all();
      return rows.filter((r) => COOKIE_HOST.test(r.host));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Find the Firefox profile that's signed in to YouTube most recently.
function findSignedInProfile() {
  let best = null;
  for (const dir of profileDirs()) {
    let cookies;
    try { cookies = readProfileCookies(dir); } catch { continue; }
    const login = cookies.find((c) => c.name === 'LOGIN_INFO' && /youtube\.com$/.test(c.host));
    const sid = cookies.find((c) => /^(__Secure-3PSID|SAPISID|SID)$/.test(c.name) && /google\.com$/.test(c.host));
    if (!login || !sid) continue;
    const last = Math.max(...cookies.map((c) => Number(c.lastAccessed) || 0));
    if (!best || last > best.last) best = { dir, cookies, last };
  }
  return best;
}

function toSeconds(expiry) {
  const n = Number(expiry) || 0;
  return n > 1e11 ? n / 1000 : n; // newer Firefox stores milliseconds
}

async function importInto(ses) {
  const profile = findSignedInProfile();
  if (!profile) return { ok: false, reason: 'not-signed-in' };

  const now = Date.now() / 1000;
  let imported = 0;
  for (const c of profile.cookies) {
    const expirationDate = toSeconds(c.expiry);
    if (expirationDate && expirationDate < now) continue;
    const bareHost = c.host.replace(/^\./, '');
    const details = {
      url: `${c.isSecure ? 'https' : 'http'}://${bareHost}${c.path || '/'}`,
      name: c.name,
      value: c.value,
      path: c.path || '/',
      secure: !!c.isSecure,
      httpOnly: !!c.isHttpOnly,
      sameSite: ['no_restriction', 'lax', 'strict'][c.sameSite] || 'unspecified',
    };
    if (expirationDate) details.expirationDate = expirationDate;
    // Domain cookies (".youtube.com") keep their domain; __Host- cookies must not have one.
    if (c.host.startsWith('.') && !c.name.startsWith('__Host-')) details.domain = c.host;
    if (details.sameSite === 'no_restriction') details.secure = true;
    try {
      await ses.cookies.set(details);
      imported++;
    } catch { /* skip cookies Chromium won't accept */ }
  }
  await ses.cookies.flushStore();
  return { ok: imported > 0, imported, profile: path.basename(profile.dir) };
}

module.exports = { importInto, findSignedInProfile };
