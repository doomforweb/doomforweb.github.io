// engine.js — runtime for the WebAssembly build of linuxdoom-1.10
//
// * loads doom.wasm
// * provides a tiny WASI implementation backed by an in-memory virtual
//   filesystem (WAD files, savegames, config)
// * provides the "env" imports used by port/web_port.c
// * is DOM-free, so it also runs under Node (used for headless tests)

export const SCREENW = 320;
export const SCREENH = 200;

export class DoomFatalError extends Error {}
export class DoomExit extends Error {
  constructor(code) { super('exit ' + code); this.code = code; }
}

// Doom event types (d_event.h)
export const EV_KEYDOWN = 0, EV_KEYUP = 1, EV_MOUSE = 2;

const ERR = { OK: 0, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31, NOENT: 44, NOSYS: 52 };

// ---------------------------------------------------------------------------
// WAD inspection helpers (used by the UI before the engine is started)
// ---------------------------------------------------------------------------
export function inspectWad(bytes) {
  if (!bytes || bytes.length < 12) return { ok: false, reason: 'too small' };
  const id = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (id !== 'IWAD' && id !== 'PWAD') return { ok: false, reason: 'not a WAD (header ' + JSON.stringify(id) + ')' };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const num = dv.getInt32(4, true), ofs = dv.getInt32(8, true);
  if (num < 0 || ofs < 12 || ofs + num * 16 > bytes.length) return { ok: false, reason: 'corrupt directory' };
  const names = new Set();
  for (let i = 0; i < num; i++) {
    const p = ofs + i * 16 + 8;
    let n = '';
    for (let k = 0; k < 8 && bytes[p + k]; k++) n += String.fromCharCode(bytes[p + k]);
    names.add(n.toUpperCase());
  }
  let game = null;
  if (id === 'IWAD') {
    if (names.has('MAP01')) game = 'doom2';
    else if (names.has('E4M1')) game = 'ultimate';
    else if (names.has('E3M1')) game = 'registered';
    else if (names.has('E1M1')) game = 'shareware';
  }
  return { ok: true, type: id, lumps: num, game };
}

export const GAME_LABEL = {
  doom2: 'DOOM II', ultimate: 'The Ultimate DOOM', registered: 'DOOM (Registered)', shareware: 'DOOM (Shareware)',
};

// ---------------------------------------------------------------------------
// Null audio backend (replaced by the real WebAudio one in the browser)
// ---------------------------------------------------------------------------
export const nullAudio = {
  sfxStart() { return 0; }, sfxUpdate() {}, sfxStop() {}, sfxPlaying() { return 0; },
  musicRegister() { return 0; }, musicPlay() {}, musicStop() {}, musicPause() {},
  musicResume() {}, musicVolume() {}, musicUnregister() {},
};

// ---------------------------------------------------------------------------
export class DoomEngine {
  /**
   * @param {object} o
   * @param {(line:string)=>void} [o.log]
   * @param {()=>number} [o.now]            game clock in ms (monotonic)
   * @param {object} [o.audio]              see nullAudio
   * @param {(name:string, bytes:Uint8Array|null)=>void} [o.persist]  called when a writable file is closed / removed
   */
  constructor(o = {}) {
    this.log = o.log || ((l) => console.log(l));
    this.now = o.now || (() => performance.now());
    this.audio = o.audio || nullAudio;
    this.persist = o.persist || (() => {});

    this.files = new Map();       // normalized path -> {data, size}
    this.fds = new Map();
    this.nextFd = 4;
    this.fds.set(0, { kind: 'stdio' });
    this.fds.set(1, { kind: 'stdio' });
    this.fds.set(2, { kind: 'stdio' });
    this.fds.set(3, { kind: 'dir' });

    this.queue = [];
    this.mdx = 0; this.mdy = 0; this.mbtn = 0; this.mbtnSent = 0;
    this.fbPtr = 0;
    this.dirty = false;
    this.frames = 0;
    this._outbuf = '';
    this._dec = new TextDecoder();
    this._enc = new TextEncoder();
    this.sfxCache = new Map();
    this.ready = false;
  }

  // ---- virtual filesystem -------------------------------------------------
  static norm(p) {
    const out = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
  }

  addFile(name, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.files.set(DoomEngine.norm(name), { data, size: data.length });
  }
  getFile(name) {
    const f = this.files.get(DoomEngine.norm(name));
    return f ? f.data.subarray(0, f.size) : null;
  }

  // ---- loading -------------------------------------------------------------
  async load(wasmSource) {
    const module = wasmSource instanceof WebAssembly.Module ? wasmSource : await WebAssembly.compile(wasmSource);
    const wasi = this._makeWasi();
    const env = this._makeEnv();
    const imports = { env: {}, wasi_snapshot_preview1: {} };
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === 'env') {
        if (!(imp.name in env)) throw new Error('missing env import ' + imp.name);
        imports.env[imp.name] = env[imp.name];
      } else {
        imports[imp.module] = imports[imp.module] || {};
        imports[imp.module][imp.name] = wasi[imp.name] || (() => ERR.NOSYS);
      }
    }
    const inst = await WebAssembly.instantiate(module, imports);
    this.ex = inst.exports;
    this.memory = inst.exports.memory;
    if (this.ex._initialize) this.ex._initialize();
    this.ready = true;
  }

  get u8() { return new Uint8Array(this.memory.buffer); }
  get dv() { return new DataView(this.memory.buffer); }

  _cstr(ptr) {
    const m = this.u8; let e = ptr;
    while (m[e]) e++;
    return this._dec.decode(m.subarray(ptr, e));
  }
  _pushArg(str) {
    const b = this._enc.encode(str + '\0');
    const p = this.ex.doom_alloc(b.length);
    this.u8.set(b, p);
    this.ex.doom_add_arg(p);
  }

  /**
   * @param {object} o
   * @param {string} o.iwad       file name of the IWAD inside the VFS
   * @param {string[]} [o.pwads]  extra WAD file names
   * @param {string[]} [o.args]   extra doom command line arguments
   */
  start(o) {
    this._pushArg('doom');
    this._pushArg('-iwad'); this._pushArg(o.iwad);
    if (o.pwads && o.pwads.length) {
      this._pushArg('-file');
      for (const w of o.pwads) this._pushArg(w);
    }
    for (const a of (o.args || [])) this._pushArg(a);
    this.ex.doom_init();
  }

  frame() { this.ex.doom_frame(); this.frames++; }

  /** weapon info for the on-screen "next weapon" buttons */
  weapon() { return { current: this.ex.doom_weapon(), owned: this.ex.doom_owned() }; }
  saveConfig() { try { this.ex.doom_save_config(); } catch (e) { /* engine may be gone */ } }

  // bit0 menu, bit1 in level, bit2 automap, bit3 text entry, bit4 paused
  state() {
    const s = this.ex.doom_state();
    return { menu: !!(s & 1), level: !!(s & 2), automap: !!(s & 4), typing: !!(s & 8), paused: !!(s & 16) };
  }

  // ---- input ---------------------------------------------------------------
  key(down, code) { this.queue.push([down ? EV_KEYDOWN : EV_KEYUP, code, 0, 0]); }
  mouseMove(dx, dy) { this.mdx += dx; this.mdy += dy; }
  mouseButtons(mask) { this.mbtn = mask; }

  _pollEvents() {
    const ex = this.ex;
    if (this.queue.length) {
      const q = this.queue; this.queue = [];
      for (const e of q) ex.doom_event(e[0], e[1], e[2], e[3]);
    }
    if (this.mdx || this.mdy || this.mbtn !== this.mbtnSent) {
      const dx = Math.max(-2000, Math.min(2000, Math.round(this.mdx)));
      const dy = Math.max(-2000, Math.min(2000, Math.round(this.mdy)));
      this.mdx = this.mdy = 0;
      this.mbtnSent = this.mbtn;
      ex.doom_event(EV_MOUSE, this.mbtnSent, dx, dy);
    }
  }

  /** current 320x200 RGBA frame (a live view into wasm memory) */
  framebuffer() {
    if (!this.fbPtr) return null;
    return new Uint8ClampedArray(this.memory.buffer, this.fbPtr, SCREENW * SCREENH * 4);
  }

  // ---- env imports ---------------------------------------------------------
  _makeEnv() {
    const self = this;
    return {
      js_now_ms: () => self.now(),
      js_poll_events: () => self._pollEvents(),
      js_present: (ptr) => { self.fbPtr = ptr; self.dirty = true; },
      js_fatal: (ptr) => { throw new DoomFatalError(self._cstr(ptr)); },

      js_sfx_start(id, ptr, len, vol, sep, pitch) {
        let bytes = self.sfxCache.get(id);
        if (!bytes) { bytes = self.u8.slice(ptr, ptr + len); self.sfxCache.set(id, bytes); }
        return self.audio.sfxStart(id, bytes, vol, sep, pitch) | 0;
      },
      js_sfx_update: (h, v, s, p) => self.audio.sfxUpdate(h, v, s, p),
      js_sfx_stop: (h) => self.audio.sfxStop(h),
      js_sfx_playing: (h) => (self.audio.sfxPlaying(h) ? 1 : 0),

      js_music_register: (ptr, len) => self.audio.musicRegister(self.u8.slice(ptr, ptr + len)) | 0,
      js_music_play: (h, loop) => self.audio.musicPlay(h, !!loop),
      js_music_stop: (h) => self.audio.musicStop(h),
      js_music_pause: (h) => self.audio.musicPause(h),
      js_music_resume: (h) => self.audio.musicResume(h),
      js_music_volume: (v) => self.audio.musicVolume(v),
      js_music_unregister: (h) => self.audio.musicUnregister(h),
    };
  }

  // ---- WASI ----------------------------------------------------------------
  _stdout(bytes) {
    this._outbuf += this._dec.decode(bytes, { stream: true });
    let i;
    while ((i = this._outbuf.indexOf('\n')) >= 0) {
      this.log(this._outbuf.slice(0, i));
      this._outbuf = this._outbuf.slice(i + 1);
    }
    if (this._outbuf.length > 400) { this.log(this._outbuf); this._outbuf = ''; }
  }

  _readPath(ptr, len) { return DoomEngine.norm(this._dec.decode(this.u8.subarray(ptr, ptr + len))); }

  _makeWasi() {
    const self = this;
    const W = {};

    W.args_sizes_get = (argcP, sizeP) => { const d = self.dv; d.setUint32(argcP, 0, true); d.setUint32(sizeP, 0, true); return 0; };
    W.args_get = () => 0;
    W.environ_sizes_get = W.args_sizes_get;
    W.environ_get = () => 0;

    W.clock_time_get = (id, _prec, outP) => {
      const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.floor(performance.now() * 1e6));
      self.dv.setBigUint64(outP, ns, true);
      return 0;
    };
    W.clock_res_get = (_id, outP) => { self.dv.setBigUint64(outP, 1000n, true); return 0; };

    W.random_get = (p, len) => {
      const view = self.u8.subarray(p, p + len);
      for (let o = 0; o < len; o += 65536) {
        const chunk = view.subarray(o, Math.min(len, o + 65536));
        if (globalThis.crypto && crypto.getRandomValues) crypto.getRandomValues(chunk);
        else for (let i = 0; i < chunk.length; i++) chunk[i] = (Math.random() * 256) | 0;
      }
      return 0;
    };

    W.proc_exit = (code) => { throw new DoomExit(code); };
    W.sched_yield = () => 0;
    W.poll_oneoff = () => ERR.NOSYS;

    W.fd_prestat_get = (fd, buf) => {
      if (fd !== 3) return ERR.BADF;
      const d = self.dv; d.setUint8(buf, 0); d.setUint32(buf + 4, 1, true);
      return 0;
    };
    W.fd_prestat_dir_name = (fd, p, len) => {
      if (fd !== 3) return ERR.BADF;
      if (len >= 1) self.u8[p] = 0x2f; // "/"
      return 0;
    };

    W.fd_fdstat_get = (fd, buf) => {
      const e = self.fds.get(fd);
      if (!e) return ERR.BADF;
      const d = self.dv;
      d.setUint8(buf, e.kind === 'dir' ? 3 : e.kind === 'file' ? 4 : 2);
      d.setUint16(buf + 2, 0, true);
      d.setBigUint64(buf + 8, 0x1fffffffn, true);
      d.setBigUint64(buf + 16, 0x1fffffffn, true);
      return 0;
    };
    W.fd_fdstat_set_flags = () => 0;
    W.fd_sync = () => 0;
    W.fd_datasync = () => 0;
    W.fd_advise = () => 0;
    W.fd_allocate = () => 0;

    const fileStat = (buf, kind, size) => {
      const d = self.dv;
      for (let i = 0; i < 64; i += 8) d.setBigUint64(buf + i, 0n, true);
      d.setUint8(buf + 16, kind);
      d.setBigUint64(buf + 24, 1n, true);
      d.setBigUint64(buf + 32, BigInt(size), true);
    };
    W.fd_filestat_get = (fd, buf) => {
      const e = self.fds.get(fd);
      if (!e) return ERR.BADF;
      if (e.kind === 'file') fileStat(buf, 4, e.file.size);
      else fileStat(buf, e.kind === 'dir' ? 3 : 2, 0);
      return 0;
    };
    W.path_filestat_get = (_fd, _flags, pp, pl, buf) => {
      const path = self._readPath(pp, pl);
      if (path === '') { fileStat(buf, 3, 0); return 0; }
      const f = self.files.get(path);
      if (!f) return ERR.NOENT;
      fileStat(buf, 4, f.size);
      return 0;
    };

    W.path_open = (_dirfd, _dirflags, pp, pl, oflags, rightsBase, _rin, _fdflags, outP) => {
      const path = self._readPath(pp, pl);
      const CREAT = 1, DIRECTORY = 2, EXCL = 4, TRUNC = 8;
      if (path === '') {
        const fd = self.nextFd++;
        self.fds.set(fd, { kind: 'dir' });
        self.dv.setUint32(outP, fd, true);
        return 0;
      }
      if (oflags & DIRECTORY) return ERR.NOENT;
      let f = self.files.get(path);
      const wantWrite = (BigInt(rightsBase) & 64n) !== 0n;   // __WASI_RIGHTS_FD_WRITE
      if (!f) {
        if (!(oflags & CREAT)) return ERR.NOENT;
        f = { data: new Uint8Array(1024), size: 0 };
        self.files.set(path, f);
      } else {
        if ((oflags & CREAT) && (oflags & EXCL)) return ERR.EXIST;
        if (oflags & TRUNC) { f.size = 0; }
      }
      const fd = self.nextFd++;
      self.fds.set(fd, { kind: 'file', file: f, path, pos: 0, write: wantWrite, dirty: !!(oflags & (CREAT | TRUNC)) && wantWrite });
      self.dv.setUint32(outP, fd, true);
      return 0;
    };

    W.fd_close = (fd) => {
      const e = self.fds.get(fd);
      if (!e) return ERR.BADF;
      if (fd > 3) {
        self.fds.delete(fd);
        if (e.kind === 'file' && e.write && e.dirty) self.persist(e.path, e.file.data.slice(0, e.file.size));
      }
      return 0;
    };

    const readInto = (e, iovs, iovsLen, nrP, pos, advance) => {
      const d = self.dv; const m = self.u8; let total = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = d.getUint32(iovs + i * 8, true), len = d.getUint32(iovs + i * 8 + 4, true);
        const n = Math.max(0, Math.min(len, e.file.size - pos));
        if (n > 0) m.set(e.file.data.subarray(pos, pos + n), buf);
        pos += n; total += n;
        if (n < len) break;
      }
      if (advance) e.pos = pos;
      d.setUint32(nrP, total, true);
      return 0;
    };
    W.fd_read = (fd, iovs, n, nrP) => {
      const e = self.fds.get(fd);
      if (!e) return ERR.BADF;
      if (e.kind !== 'file') { self.dv.setUint32(nrP, 0, true); return 0; }
      return readInto(e, iovs, n, nrP, e.pos, true);
    };
    W.fd_pread = (fd, iovs, n, off, nrP) => {
      const e = self.fds.get(fd);
      if (!e || e.kind !== 'file') return ERR.BADF;
      return readInto(e, iovs, n, nrP, Number(off), false);
    };

    W.fd_write = (fd, iovs, n, nwP) => {
      const e = self.fds.get(fd);
      if (!e) return ERR.BADF;
      const d = self.dv; let total = 0;
      if (e.kind === 'stdio') {
        for (let i = 0; i < n; i++) {
          const buf = d.getUint32(iovs + i * 8, true), len = d.getUint32(iovs + i * 8 + 4, true);
          self._stdout(self.u8.subarray(buf, buf + len));
          total += len;
        }
        d.setUint32(nwP, total, true);
        return 0;
      }
      if (e.kind !== 'file' || !e.write) return ERR.BADF;
      for (let i = 0; i < n; i++) {
        const buf = d.getUint32(iovs + i * 8, true), len = d.getUint32(iovs + i * 8 + 4, true);
        const f = e.file, need = e.pos + len;
        if (need > f.data.length) {
          const nd = new Uint8Array(Math.max(need, f.data.length * 2));
          nd.set(f.data.subarray(0, f.size));
          f.data = nd;
        }
        f.data.set(self.u8.subarray(buf, buf + len), e.pos);
        e.pos = need;
        if (need > f.size) f.size = need;
        total += len;
      }
      e.dirty = true;
      self.dv.setUint32(nwP, total, true);
      return 0;
    };

    W.fd_seek = (fd, off, whence, outP) => {
      const e = self.fds.get(fd);
      if (!e) return ERR.BADF;
      if (e.kind !== 'file') return ERR.INVAL;
      const o = Number(off);
      const base = whence === 0 ? 0 : whence === 1 ? e.pos : e.file.size;
      const np = base + o;
      if (np < 0) return ERR.INVAL;
      e.pos = np;
      self.dv.setBigUint64(outP, BigInt(np), true);
      return 0;
    };
    W.fd_tell = (fd, outP) => {
      const e = self.fds.get(fd);
      if (!e || e.kind !== 'file') return ERR.BADF;
      self.dv.setBigUint64(outP, BigInt(e.pos), true);
      return 0;
    };

    W.path_unlink_file = (_fd, pp, pl) => {
      const path = self._readPath(pp, pl);
      if (!self.files.delete(path)) return ERR.NOENT;
      self.persist(path, null);
      return 0;
    };
    W.path_create_directory = () => 0;

    return W;
  }
}
