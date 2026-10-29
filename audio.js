// audio.js — WebAudio backend for the Doom port
//   * sound effects: DMX lumps (8-bit unsigned PCM) -> AudioBuffers
//   * music: MUS and MIDI lumps -> small subtractive synth (no soundfont needed)

// ---------------------------------------------------------------------------
// Music parsers: return { events:[{t,k,ch,a,b}], duration } with t in seconds
// k: 'on'(a=note,b=vel) 'off'(a=note) 'prog'(a) 'vol'(a) 'expr'(a) 'bend'(a=semitones) 'alloff'
// ---------------------------------------------------------------------------
export function parseMus(d) {
  if (d.length < 16 || d[0] !== 0x4d || d[1] !== 0x55 || d[2] !== 0x53) return null;
  const scoreStart = d[6] | (d[7] << 8);
  const events = [];
  const lastVel = new Array(16).fill(100);
  let p = scoreStart, tick = 0;
  const TICK = 1 / 140;
  const mapCh = (c) => (c === 15 ? 9 : c >= 9 ? c + 1 : c);
  while (p < d.length) {
    const b = d[p++];
    const last = b & 0x80, type = (b >> 4) & 7, ch = mapCh(b & 15);
    const t = tick * TICK;
    if (type === 0) { events.push({ t, k: 'off', ch, a: d[p++] & 127 }); }
    else if (type === 1) {
      const n = d[p++];
      if (n & 0x80) lastVel[ch] = d[p++] & 127;
      events.push({ t, k: 'on', ch, a: n & 127, b: lastVel[ch] });
    } else if (type === 2) { events.push({ t, k: 'bend', ch, a: ((d[p++] - 128) / 128) * 2 }); }
    else if (type === 3) {
      const c = d[p++];
      if (c === 10 || c === 11) events.push({ t, k: 'alloff', ch });
    } else if (type === 4) {
      const c = d[p++], v = d[p++] & 127;
      if (c === 0) events.push({ t, k: 'prog', ch, a: v });
      else if (c === 3) events.push({ t, k: 'vol', ch, a: v });
      else if (c === 4) events.push({ t, k: 'pan', ch, a: v });
      else if (c === 5) events.push({ t, k: 'expr', ch, a: v });
    } else if (type === 6) { break; }
    else if (type === 5 || type === 7) { /* no data */ }
    if (last) {
      let delay = 0, x;
      do { x = d[p++]; delay = delay * 128 + (x & 127); } while (x & 0x80 && p < d.length);
      tick += delay;
    }
  }
  return { events, duration: tick * TICK };
}

export function parseMidi(d) {
  if (d.length < 14 || d[0] !== 0x4d || d[1] !== 0x54 || d[2] !== 0x68 || d[3] !== 0x64) return null;
  const be16 = (o) => (d[o] << 8) | d[o + 1];
  const be32 = (o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
  const ntr = be16(10), div = be16(12);
  if (div & 0x8000) return null;
  let p = 8 + be32(4);
  const raw = [], tempos = [{ tick: 0, us: 500000 }];
  for (let tr = 0; tr < ntr && p + 8 <= d.length; tr++) {
    if (d[p] !== 0x4d || d[p + 1] !== 0x54) break;
    const len = be32(p + 4); let q = p + 8; const end = Math.min(d.length, q + len);
    let tick = 0, run = 0;
    while (q < end) {
      let delta = 0, x;
      do { x = d[q++]; delta = delta * 128 + (x & 127); } while (x & 0x80 && q < end);
      tick += delta;
      let st = d[q];
      if (st & 0x80) { q++; if (st < 0xf0) run = st; } else st = run;
      if (st === 0xff) {
        const type = d[q++]; let l = 0, y;
        do { y = d[q++]; l = l * 128 + (y & 127); } while (y & 0x80 && q < end);
        if (type === 0x51 && l === 3) tempos.push({ tick, us: (d[q] << 16) | (d[q + 1] << 8) | d[q + 2] });
        q += l;
      } else if (st === 0xf0 || st === 0xf7) {
        let l = 0, y;
        do { y = d[q++]; l = l * 128 + (y & 127); } while (y & 0x80 && q < end);
        q += l;
      } else {
        const hi = st & 0xf0, ch = st & 15;
        if (hi === 0xc0 || hi === 0xd0) { const a = d[q++]; if (hi === 0xc0) raw.push({ tick, k: 'prog', ch, a }); }
        else {
          const a = d[q++], b = d[q++];
          if (hi === 0x90) raw.push(b ? { tick, k: 'on', ch, a, b } : { tick, k: 'off', ch, a });
          else if (hi === 0x80) raw.push({ tick, k: 'off', ch, a });
          else if (hi === 0xb0) {
            if (a === 7) raw.push({ tick, k: 'vol', ch, a: b });
            else if (a === 11) raw.push({ tick, k: 'expr', ch, a: b });
            else if (a === 10) raw.push({ tick, k: 'pan', ch, a: b });
            else if (a === 123 || a === 120) raw.push({ tick, k: 'alloff', ch });
          } else if (hi === 0xe0) raw.push({ tick, k: 'bend', ch, a: (((b << 7) | a) - 8192) / 8192 * 2 });
        }
      }
    }
    p += 8 + len;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  const toSec = (tick) => {
    let sec = 0, last = 0, us = 500000;
    for (const t of tempos) {
      if (t.tick > tick) break;
      sec += ((t.tick - last) * us) / 1e6 / div; last = t.tick; us = t.us;
    }
    return sec + ((tick - last) * us) / 1e6 / div;
  };
  raw.sort((a, b) => a.tick - b.tick);
  const events = raw.map((e) => ({ ...e, t: toSec(e.tick) }));
  return { events, duration: events.length ? events[events.length - 1].t + 0.2 : 0 };
}

// ---------------------------------------------------------------------------
// Instrument table (General MIDI program groups -> synth parameters)
// ---------------------------------------------------------------------------
const GROUPS = [
  // 0 piano
  { w: 'triangle', w2: 'sine', a: 0.003, d: 0.7, s: 0.12, r: 0.25, lp: 9 },
  // 1 chromatic percussion
  { w: 'sine', w2: 'triangle', a: 0.002, d: 0.9, s: 0.02, r: 0.4, lp: 12 },
  // 2 organ
  { w: 'square', a: 0.01, d: 0.05, s: 0.7, r: 0.06, lp: 4 },
  // 3 guitar
  { w: 'sawtooth', a: 0.003, d: 0.5, s: 0.25, r: 0.15, lp: 5 },
  // 4 bass
  { w: 'sawtooth', w2: 'sine', a: 0.004, d: 0.35, s: 0.4, r: 0.1, lp: 3 },
  // 5 strings
  { w: 'sawtooth', a: 0.12, d: 0.2, s: 0.8, r: 0.3, lp: 4, det: 8 },
  // 6 ensemble
  { w: 'sawtooth', a: 0.1, d: 0.2, s: 0.8, r: 0.3, lp: 3.5, det: 10 },
  // 7 brass
  { w: 'sawtooth', a: 0.04, d: 0.15, s: 0.7, r: 0.12, lp: 4 },
  // 8 reed
  { w: 'square', a: 0.04, d: 0.1, s: 0.7, r: 0.1, lp: 3.5 },
  // 9 pipe
  { w: 'sine', a: 0.04, d: 0.1, s: 0.8, r: 0.12, lp: 8 },
  // 10 synth lead
  { w: 'square', w2: 'sawtooth', a: 0.01, d: 0.1, s: 0.75, r: 0.1, lp: 6, det: 6 },
  // 11 synth pad
  { w: 'triangle', w2: 'sawtooth', a: 0.25, d: 0.3, s: 0.8, r: 0.5, lp: 3, det: 8 },
  // 12 synth fx
  { w: 'sawtooth', a: 0.05, d: 0.5, s: 0.5, r: 0.4, lp: 4, det: 12 },
  // 13 ethnic
  { w: 'triangle', a: 0.004, d: 0.4, s: 0.15, r: 0.2, lp: 6 },
  // 14 percussive
  { w: 'sine', a: 0.002, d: 0.25, s: 0.0, r: 0.1, lp: 10 },
  // 15 sound fx
  { w: 'sawtooth', a: 0.1, d: 0.5, s: 0.4, r: 0.5, lp: 3, det: 20 },
];
// overdriven / distortion guitars are everywhere in Doom's soundtrack
const GUITAR_DIST = { w: 'sawtooth', w2: 'square', a: 0.004, d: 0.25, s: 0.7, r: 0.08, lp: 3.2, det: 7, dist: true };

const groupFor = (prog) => (prog === 29 || prog === 30 ? GUITAR_DIST : GROUPS[Math.min(15, prog >> 3)]);

// ---------------------------------------------------------------------------
export class WebAudio {
  constructor() {
    this.ctx = null;
    this.sfxVol = 1;         // user multiplier (settings)
    this.musVol = 8 / 15;    // doom music volume 0..15
    this.userMusic = 1;
    this.handleSeq = 1;
    this.voices = new Map(); // sfx handle -> {src, gain, pan, end}
    this.bufCache = new Map();
    this.songs = new Map();
    this.songSeq = 1;
    this.cur = null;
    this.timer = null;
    this.muted = false;
  }

  /** Must be called from a user gesture at least once. */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC({ latencyHint: 'interactive' });
      const c = this.ctx;
      this.master = c.createGain();
      this.comp = c.createDynamicsCompressor();
      this.sfxBus = c.createGain();
      this.musBus = c.createGain();
      this.sfxBus.connect(this.comp);
      this.musBus.connect(this.comp);
      this.comp.connect(this.master);
      this.master.connect(c.destination);
      this._applyVol();
      this.noiseBuf = this._makeNoise();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return true;
  }

  _makeNoise() {
    const c = this.ctx, n = c.sampleRate * 1;
    const b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _applyVol() {
    if (!this.ctx) return;
    this.sfxBus.gain.value = this.muted ? 0 : this.sfxVol;
    this.musBus.gain.value = this.muted ? 0 : this.musVol * this.musVol * 1.4 * this.userMusic;
  }
  setSfxScale(v) { this.sfxVol = v; this._applyVol(); }
  setMusicScale(v) { this.userMusic = v; this._applyVol(); }
  setMuted(m) { this.muted = m; this._applyVol(); }

  // ----- sound effects ------------------------------------------------------
  _sfxBuffer(id, bytes) {
    let b = this.bufCache.get(id);
    if (b !== undefined) return b;
    b = null;
    if (bytes.length > 8 && bytes[0] === 3 && bytes[1] === 0) {
      const rate = (bytes[2] | (bytes[3] << 8)) || 11025;
      let n = (bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0;
      n = Math.min(n, bytes.length - 8);
      let start = 8, cnt = n;
      if (n > 32) { start = 8 + 16; cnt = n - 32; }   // DMX pads 16 bytes at both ends
      if (cnt > 0) {
        b = this.ctx.createBuffer(1, cnt, Math.max(3000, Math.min(192000, rate)));
        const ch = b.getChannelData(0);
        for (let i = 0; i < cnt; i++) ch[i] = (bytes[start + i] - 128) / 128;
      }
    }
    this.bufCache.set(id, b);
    return b;
  }

  sfxStart(id, bytes, vol, sep, pitch) {
    if (!this.ensure()) return 0;
    const buf = this._sfxBuffer(id, bytes);
    if (!buf) return 0;
    const c = this.ctx;
    // keep the number of live voices bounded
    if (this.voices.size > 32) this._reap(true);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.pow(2, (pitch - 128) / 64);
    const g = c.createGain();
    g.gain.value = Math.min(1, vol / 15);
    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    if (pan) { pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128)); src.connect(g); g.connect(pan); pan.connect(this.sfxBus); }
    else { src.connect(g); g.connect(this.sfxBus); }
    const h = this.handleSeq++;
    const dur = buf.duration / src.playbackRate.value;
    const v = { src, g, pan, end: c.currentTime + dur };
    src.onended = () => { this.voices.delete(h); };
    src.start();
    this.voices.set(h, v);
    return h;
  }
  _reap(force) {
    const now = this.ctx.currentTime;
    for (const [h, v] of this.voices) if (v.end < now) this.voices.delete(h);
    if (force && this.voices.size > 32) {
      const first = this.voices.keys().next().value;
      this.sfxStop(first);
    }
  }
  sfxUpdate(h, vol, sep, pitch) {
    const v = this.voices.get(h);
    if (!v) return;
    v.g.gain.value = Math.min(1, vol / 15);
    if (v.pan) v.pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
  }
  sfxStop(h) {
    const v = this.voices.get(h);
    if (!v) return;
    try { v.src.stop(); } catch (e) { /* already stopped */ }
    this.voices.delete(h);
  }
  sfxPlaying(h) {
    const v = this.voices.get(h);
    return !!v && this.ctx && v.end > this.ctx.currentTime;
  }

  // ----- music --------------------------------------------------------------
  musicRegister(bytes) {
    const song = parseMus(bytes) || parseMidi(bytes);
    if (!song) return 0;
    const h = this.songSeq++;
    this.songs.set(h, song);
    return h;
  }
  musicUnregister(h) { if (this.cur && this.cur.h === h) this._stopSong(); this.songs.delete(h); }
  musicVolume(v) {
    if (v > 15) return;      // doom briefly sets 127 before the real value
    this.musVol = Math.max(0, Math.min(1, v / 15));
    this._applyVol();
  }
  musicPlay(h, loop) {
    this._stopSong();
    const song = this.songs.get(h);
    if (!song || !this.ensure()) { this.pending = song ? { h, loop } : null; return; }
    this.pending = null;
    const c = this.ctx;
    const chans = [];
    for (let i = 0; i < 16; i++) {
      const g = c.createGain(); g.connect(this.musBus);
      chans.push({ g, prog: 0, vol: 100, expr: 127, bend: 0, notes: new Map() });
      this._chanGain(chans[i], c.currentTime);
    }
    this.cur = { h, song, loop, chans, idx: 0, base: c.currentTime + 0.08, voices: new Set(), paused: false, offset: 0 };
    this.timer = setInterval(() => this._pump(), 25);
    this._pump();
  }
  _chanGain(ch, when) {
    const v = (ch.vol / 127) * (ch.expr / 127);
    ch.g.gain.setValueAtTime(v * v * 0.9, when);
  }
  _stopSong() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const cur = this.cur;
    this.cur = null;
    if (cur) {
      for (const v of cur.voices) this._killVoice(v);
      for (const ch of cur.chans) { try { ch.g.disconnect(); } catch (e) { /* */ } }
    }
  }
  musicStop() { this._stopSong(); this.pending = null; }
  musicPause() {
    const cur = this.cur;
    if (!cur || cur.paused) return;
    cur.paused = true;
    cur.offset = this.ctx.currentTime - cur.base;
    for (const v of cur.voices) this._killVoice(v);
    cur.voices.clear();
    for (const ch of cur.chans) ch.notes.clear();
  }
  musicResume() {
    const cur = this.cur;
    if (!cur || !cur.paused) return;
    cur.paused = false;
    cur.base = this.ctx.currentTime - cur.offset;
    const ev = cur.song.events;
    // skip events that already happened (state events are re-applied)
    let i = 0;
    while (i < ev.length && ev[i].t < cur.offset) {
      const e = ev[i];
      if (e.k === 'prog' || e.k === 'vol' || e.k === 'expr' || e.k === 'bend') this._event(cur, e, this.ctx.currentTime, true);
      i++;
    }
    cur.idx = i;
  }

  _pump() {
    const cur = this.cur;
    if (!cur || cur.paused) return;
    const c = this.ctx, horizon = c.currentTime + 0.18;
    const ev = cur.song.events;
    for (;;) {
      if (cur.idx >= ev.length) {
        if (c.currentTime < cur.base + cur.song.duration) return;
        if (cur.loop) {
          // restart; channel state keeps program/volume exactly like a real loop
          cur.base += cur.song.duration; cur.idx = 0;
          for (const ch of cur.chans) ch.notes.clear();
          continue;
        }
        this._stopSong();
        return;
      }
      const e = ev[cur.idx];
      const when = cur.base + e.t;
      if (when > horizon) return;
      cur.idx++;
      this._event(cur, e, Math.max(when, c.currentTime), false);
    }
  }

  _event(cur, e, when, silent) {
    const ch = cur.chans[e.ch];
    switch (e.k) {
      case 'prog': ch.prog = e.a; break;
      case 'vol': ch.vol = e.a; this._chanGain(ch, when); break;
      case 'expr': ch.expr = e.a; this._chanGain(ch, when); break;
      case 'bend':
        ch.bend = e.a;
        for (const v of ch.notes.values()) for (const o of v.oscs) o.detune.setValueAtTime(e.a * 100 + (o._det || 0), when);
        break;
      case 'on': if (!silent) this._noteOn(cur, ch, e.ch, e.a, e.b, when); break;
      case 'off': this._noteOff(cur, ch, e.a, when); break;
      case 'alloff':
        for (const n of [...ch.notes.keys()]) this._noteOff(cur, ch, n, when);
        break;
      default: break;
    }
  }

  _killVoice(v) {
    try { v.gain.disconnect(); } catch (e) { /* */ }
    for (const o of v.oscs) { try { o.stop(); } catch (e) { /* */ } }
  }

  _noteOn(cur, ch, chIdx, note, vel, when) {
    if (cur.voices.size > 44) {
      const oldest = cur.voices.values().next().value;
      this._killVoice(oldest); cur.voices.delete(oldest);
    }
    if (chIdx === 9) return this._drum(cur, ch, note, vel, when);
    const c = this.ctx, P = groupFor(ch.prog);
    const old = ch.notes.get(note);
    if (old) this._noteOff(cur, ch, note, when);
    const freq = 440 * Math.pow(2, (note - 69) / 12);
    const peak = Math.pow(vel / 127, 1.3) * 0.22 * (P.w === 'sine' ? 1.1 : 1);
    const g = c.createGain();
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(16000, freq * P.lp + 300);
    lp.Q.value = 0.4;
    let tail = g;
    if (P.dist) {
      const ws = c.createWaveShaper();
      ws.curve = this._distCurve(); ws.oversample = '2x';
      g.connect(ws); tail = ws;
      // when distorted, compensate level
    }
    lp.connect(g);
    tail.connect(ch.g);
    const oscs = [];
    const mk = (type, det, level) => {
      const o = c.createOscillator();
      o.type = type; o.frequency.value = freq;
      o._det = det;
      o.detune.value = det + ch.bend * 100;
      if (level !== 1) { const lg = c.createGain(); lg.gain.value = level; o.connect(lg); lg.connect(lp); }
      else o.connect(lp);
      o.start(when);
      oscs.push(o);
    };
    mk(P.w, 0, 1);
    if (P.w2) mk(P.w2, P.det || 0, 0.55);
    else if (P.det) mk(P.w, P.det, 0.6);
    const sus = Math.max(0.0001, peak * P.s);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + P.a);
    g.gain.setTargetAtTime(sus, when + P.a, Math.max(0.02, P.d / 3));
    const v = { gain: g, oscs, rel: P.r, lp };
    cur.voices.add(v);
    ch.notes.set(note, v);
  }

  _distCurve() {
    if (this._dc) return this._dc;
    const n = 1024, a = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; a[i] = Math.tanh(x * 3.2) * 0.6; }
    return (this._dc = a);
  }

  _noteOff(cur, ch, note, when) {
    const v = ch.notes.get(note);
    if (!v) return;
    ch.notes.delete(note);
    const g = v.gain.gain;
    g.cancelScheduledValues(when);
    g.setTargetAtTime(0.0001, when, v.rel / 3);
    const stopAt = when + v.rel * 2.2 + 0.05;
    for (const o of v.oscs) { try { o.stop(stopAt); } catch (e) { /* */ } }
    const last = v.oscs[0];
    last.onended = () => { try { v.gain.disconnect(); } catch (e) { /* */ } cur.voices.delete(v); };
  }

  _drum(cur, ch, note, vel, when) {
    const c = this.ctx, lvl = Math.pow(vel / 127, 1.2);
    const out = ch.g;
    const env = (g, peak, dec) => {
      g.gain.setValueAtTime(peak, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dec);
    };
    const tone = (f0, f1, dec, peak, type) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, when);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dec * 0.7);
      env(g, peak * lvl, dec);
      o.connect(g); g.connect(out);
      o.start(when); o.stop(when + dec + 0.05);
      return o;
    };
    const noise = (dec, peak, hp, bp) => {
      const s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
      s.buffer = this.noiseBuf; s.loop = true;
      if (bp) { f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = 0.8; }
      else { f.type = 'highpass'; f.frequency.value = hp; }
      env(g, peak * lvl, dec);
      s.connect(f); f.connect(g); g.connect(out);
      s.start(when, Math.random() * 0.5); s.stop(when + dec + 0.05);
    };
    if (note === 35 || note === 36) { tone(150, 45, 0.28, 0.9); noise(0.02, 0.2, 800); }
    else if (note === 38 || note === 40) { noise(0.16, 0.55, 1500); tone(220, 130, 0.1, 0.4, 'triangle'); }
    else if (note === 37 || note === 39) { noise(0.05, 0.5, 1800); }
    else if (note === 42 || note === 44) noise(0.045, 0.3, 7000);
    else if (note === 46) noise(0.3, 0.3, 6500);
    else if (note === 49 || note === 52 || note === 55 || note === 57) noise(0.9, 0.35, 4500);
    else if (note === 51 || note === 53 || note === 59) noise(0.35, 0.22, 0, 8000);
    else if (note >= 41 && note <= 50) { const f = 70 + (note - 41) * 18; tone(f * 2, f, 0.3, 0.7); }
    else noise(0.07, 0.25, 3000);
  }
}
