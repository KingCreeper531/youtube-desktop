// Minimal Discord Rich Presence client over Discord's local IPC pipe.
// No dependencies: talks the documented frame protocol directly.
const net = require('net');
const crypto = require('crypto');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function pipePath(i) {
  // Test hook: point at a fake Discord instead of the real one
  if (process.env.TUNEBOX_DISCORD_PIPE) return `${process.env.TUNEBOX_DISCORD_PIPE}-${i}`;
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp';
  return `${base.replace(/\/$/, '')}/discord-ipc-${i}`;
}

function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

class DiscordPresence {
  constructor(log = () => {}) {
    this.log = log;
    this.clientId = '';
    this.socket = null;
    this.ready = false;
    this.connecting = false;
    this.buffer = Buffer.alloc(0);
    this.retryTimer = null;
    this.enabled = false;
    this.desired = null;        // activity we want Discord to show (or null)
    this.lastSentJson = undefined;
    this.lastSendAt = 0;
    this.sendTimer = null;
    this.status = 'off';
  }

  setClientId(id) {
    id = String(id || '').trim();
    if (id === this.clientId) return;
    this.clientId = id;
    this.disconnect();
    if (this.enabled) this.connect();
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) {
      this.disconnect(true);
      this.status = 'off';
    } else {
      this.connect();
    }
  }

  async connect() {
    if (!this.enabled || this.ready || this.connecting) return;
    if (!/^\d{15,22}$/.test(this.clientId)) {
      this.status = 'no-client-id';
      return;
    }
    this.connecting = true;
    this.status = 'connecting';
    for (let i = 0; i < 10; i++) {
      const ok = await this._tryPipe(i);
      if (ok) {
        this.connecting = false;
        return;
      }
      if (this.status === 'bad-client-id') {
        this.connecting = false;
        return; // Discord answered: the ID is wrong. Don't keep retrying.
      }
    }
    this.connecting = false;
    this.status = 'discord-not-running';
    this._scheduleRetry();
  }

  _tryPipe(i) {
    return new Promise((resolve) => {
      const sock = net.createConnection(pipePath(i));
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        sock.destroy();
        done(false);
      }, 3000);

      sock.once('error', () => done(false));
      sock.once('connect', () => {
        this.socket = sock;
        this.buffer = Buffer.alloc(0);
        sock.on('data', (chunk) => this._onData(chunk));
        sock.on('close', () => this._onClose());
        sock.on('error', () => {});
        sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
        this._onReady = () => done(true);
        this._onFail = () => done(false);
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) break;
      const body = this.buffer.subarray(8, 8 + len).toString('utf8');
      this.buffer = this.buffer.subarray(8 + len);
      let msg = null;
      try { msg = JSON.parse(body); } catch { /* ignore */ }
      this._handle(op, msg);
    }
  }

  _handle(op, msg) {
    if (op === OP.PING) {
      this.socket?.write(encode(OP.PONG, msg));
      return;
    }
    if (op === OP.CLOSE) {
      this.log(`Discord closed the connection: ${msg?.message || msg?.code || 'unknown'}`);
      this.status = /client id/i.test(msg?.message || '') ? 'bad-client-id' : 'closed';
      this._onFail?.();
      this.disconnect();
      if (this.status !== 'bad-client-id') this._scheduleRetry();
      return;
    }
    if (op === OP.FRAME && msg) {
      if (msg.evt === 'READY') {
        this.ready = true;
        this.status = 'connected';
        this.lastSentJson = undefined;
        this.log('Connected to Discord');
        this._onReady?.();
        this._flush(true);
      } else if (msg.evt === 'ERROR') {
        this.log(`Discord error: ${msg.data?.message}`);
      }
    }
  }

  _onClose() {
    const wasReady = this.ready;
    this.ready = false;
    this.socket = null;
    if (wasReady) this.log('Discord connection lost');
    if (this.enabled && this.status !== 'bad-client-id') {
      this.status = 'discord-not-running';
      this._scheduleRetry();
    }
  }

  _scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (!this.enabled) return;
    this.retryTimer = setTimeout(() => this.connect(), 15000);
  }

  disconnect(clear = false) {
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    if (this.socket) {
      if (clear && this.ready) {
        try { this.socket.write(encode(OP.FRAME, this._activityCmd(null))); } catch { /* ignore */ }
      }
      this.socket.removeAllListeners('close');
      this.socket.end();
      this.socket.destroy();
    }
    this.socket = null;
    this.ready = false;
  }

  /**
   * Clears the status and closes the connection, waiting until Discord has the
   * message (or 1 second at most). Use this when the app quits.
   */
  shutdown() {
    this.enabled = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sendTimer);
    const sock = this.socket;
    if (!sock || !this.ready) {
      this.disconnect();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); try { sock.destroy(); } catch { /* ignore */ } resolve(); };
      const timer = setTimeout(finish, 1000);
      sock.removeAllListeners('close');
      sock.once('close', finish);
      // Wait for Discord's reply to the clear before hanging up
      sock.removeAllListeners('data');
      sock.once('data', () => sock.end());
      try {
        sock.write(encode(OP.FRAME, this._activityCmd(null)));
      } catch {
        finish();
      }
      this.socket = null;
      this.ready = false;
      this.status = 'off';
    });
  }

  _activityCmd(activity) {
    return {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: crypto.randomUUID(),
    };
  }

  // Discord allows ~5 updates / 20s. Coalesce changes and send at most one every 4s.
  setActivity(activity) {
    this.desired = activity;
    this._flush(false);
  }

  _flush(force) {
    if (!this.ready) return;
    const json = JSON.stringify(this.desired);
    if (!force && json === this.lastSentJson) return;
    const wait = Math.max(0, this.lastSendAt + 4000 - Date.now());
    clearTimeout(this.sendTimer);
    if (wait > 0 && !force) {
      this.sendTimer = setTimeout(() => this._flush(false), wait);
      return;
    }
    this.lastSentJson = json;
    this.lastSendAt = Date.now();
    try {
      this.socket.write(encode(OP.FRAME, this._activityCmd(this.desired)));
    } catch (e) {
      this.log(`Discord send failed: ${e.message}`);
    }
  }
}

module.exports = { DiscordPresence };
