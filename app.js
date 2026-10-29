// app.js — browser front-end for the WebAssembly Doom port
import { DoomEngine, DoomFatalError, DoomExit, inspectWad, GAME_LABEL, SCREENW, SCREENH } from './engine.js';
import { WebAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const app = $('app'), canvas = $('screen'), view = $('view');

// ---------------------------------------------------------------------------
// i18n (ja / en)
// ---------------------------------------------------------------------------
const EN = {
  hintMove: '◀ MOVE', hintLook: 'LOOK ▶', back: 'BACK',
  subtitle: 'A WebAssembly port of linuxdoom-1.10. Bring your own game data (WAD).',
  wadFiles: 'WAD files', dropTitle: 'Drop WAD files here, or tap to choose',
  dropSub: 'One IWAD (doom.wad / doom2.wad / freedoom …) plus optional PWADs. Multiple selection is fine.',
  onServer: 'WADs on this server', start: 'START GAME', advanced: 'Advanced options',
  extraArgs: 'Extra command line arguments (e.g. -skill 4 -warp 1 1 -nomonsters -fast)',
  iosNote: 'Safari on iPhone has no Fullscreen API. Use Share → "Add to Home Screen" to play fullscreen.',
  license: 'The Doom source code is released under the GNU GPL v2. No WAD is bundled. Your WAD files never leave your browser.',
  restart: 'Restart', backToWads: 'Back to WAD selection', settings: 'Settings',
  secDisplay: 'Display', aspect: 'Aspect ratio', asp43: '4:3 (original, tall pixels)', asp1610: '16:10 (square pixels)', aspFill: 'Stretch to fill',
  filter: 'Scaling filter', fCrisp: 'Crisp (recommended)', fNearest: 'Nearest (raw pixels)', fSmooth: 'Smooth',
  secSound: 'Sound', sfxVol: 'Effects volume', musVol: 'Music volume', mute: 'Mute',
  secInput: 'Controls', touchMode: 'Touch controls', tAuto: 'Auto', tOn: 'Always show', tOff: 'Hide',
  uiScale: 'Button size', uiOpacity: 'Button opacity', lookSens: 'Look sensitivity (touch)', stickMode: 'Stick horizontal',
  smStrafe: 'Strafe', smTurn: 'Turn', swap: 'Swap left/right', mouseSens: 'Mouse sensitivity', wasd: 'WASD to move (E = use)',
  wasdNote: 'With WASD on, the d / a keys cannot be typed for cheat codes (iddqd …). Turn it off to use cheats.',
  fullscreen: 'Fullscreen', resetCfg: 'Reset settings',
  keysHelp: 'Keys: Arrows/WASD move · Ctrl/Left click fire · Space/E/Right click use · Shift run · Alt+←→ strafe · 1–7 weapons · Tab map · Esc menu · Wheel = next weapon',
  // dynamic
  needIwad: 'Select an IWAD to start.', pwadHint: 'PWADs are loaded in the order shown.',
  del: 'Delete', loading: 'Starting…', loadingWasm: 'Loading engine…', persistWarn: 'Storage is unavailable: WADs will not be remembered after you close the tab.',
  notWad: 'is not a valid WAD', added: 'Added', stored: 'Stored in this browser — it will be remembered.',
  fetchFail: 'Download failed', load: 'Load', onlySession: 'Session only',
  crashTitle: 'The engine stopped', exitTitle: 'Game ended', exitBody: 'You quit the game.',
  tapHint: 'Tap the screen / OK to continue', fsFail: 'Fullscreen is not available here', saved: 'Saved',
  iwadSel: 'IWAD', pwadSel: 'PWAD', size: 'MB',
};
const JA = {};
for (const el of document.querySelectorAll('[data-i18n]')) JA[el.dataset.i18n] = el.textContent;
const LANG = (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
const JA_DYN = {
  needIwad: 'IWAD を選択してください。', pwadHint: 'PWAD は表示順に読み込まれます。',
  del: '削除', loading: '起動中…', loadingWasm: 'エンジンを読み込み中…', persistWarn: 'ストレージが使えないため、タブを閉じると WAD は保持されません。',
  notWad: 'は有効な WAD ではありません', added: '追加しました', stored: 'このブラウザに保存されます（次回から選び直し不要）。',
  fetchFail: 'ダウンロードに失敗しました', load: '読み込み', onlySession: 'このセッションのみ',
  crashTitle: 'エンジンが停止しました', exitTitle: 'ゲームを終了しました', exitBody: 'ゲームを終了しました。',
  tapHint: '画面タップ / OK で進みます', fsFail: 'この環境では全画面にできません', saved: '保存しました',
  iwadSel: 'IWAD', pwadSel: 'PWAD', size: 'MB',
};
const T = (k) => (LANG === 'ja' ? (JA_DYN[k] ?? JA[k] ?? EN[k]) : (EN[k] ?? k));
if (LANG === 'en') {
  document.documentElement.lang = 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) { const k = el.dataset.i18n; if (EN[k]) el.textContent = EN[k]; }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
const DEFAULTS = {
  aspect: '4:3', filter: 'crisp', touch: 'auto', uiScale: 1, uiOpacity: 0.55, lookSens: 5, mouseSens: 3,
  wasd: true, stickMode: 'strafe', swapSides: false, sfxScale: 1, musicScale: 1, muted: false,
};
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('doomweb.settings') || '{}')); } catch (e) { /* ignore */ }
const saveSettings = () => { try { localStorage.setItem('doomweb.settings', JSON.stringify(settings)); } catch (e) { /* ignore */ } };

// ---------------------------------------------------------------------------
// tiny IndexedDB wrapper (WAD library + savegames). Falls back to memory.
// ---------------------------------------------------------------------------
const mem = { wads: new Map(), meta: new Map(), saves: new Map() };
let idb = null, idbOK = false;
function idbOpen() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('no indexedDB'));
    const r = indexedDB.open('doomweb', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('wads'); d.createObjectStore('meta'); d.createObjectStore('saves'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });
}
const store = {
  async init() { try { idb = await idbOpen(); idbOK = true; } catch (e) { idbOK = false; } },
  _tx(name, mode, fn) {
    return new Promise((res, rej) => {
      const tx = idb.transaction(name, mode); const st = tx.objectStore(name);
      let out; const r = fn(st);
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  },
  async put(name, key, val) { if (!idbOK) return mem[name].set(key, val); return this._tx(name, 'readwrite', (s) => s.put(val, key)); },
  async get(name, key) { if (!idbOK) return mem[name].get(key); return this._tx(name, 'readonly', (s) => s.get(key)); },
  async del(name, key) { if (!idbOK) return mem[name].delete(key); return this._tx(name, 'readwrite', (s) => s.delete(key)); },
  async keys(name) { if (!idbOK) return [...mem[name].keys()]; return this._tx(name, 'readonly', (s) => s.getAllKeys()); },
};

// ---------------------------------------------------------------------------
// small UI helpers
// ---------------------------------------------------------------------------
let toastTimer = 0;
function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const fmtMB = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
const logLines = [];
const log = (l) => { logLines.push(l); if (logLines.length > 300) logLines.shift(); };

// ---------------------------------------------------------------------------
// WAD library / selection
// ---------------------------------------------------------------------------
let library = [];          // [{name,size,type,game,lumps}]
let selection = { iwad: null, pwads: [] };
try { selection = Object.assign(selection, JSON.parse(localStorage.getItem('doomweb.selection') || '{}')); } catch (e) { /* ignore */ }
const saveSelection = () => { try { localStorage.setItem('doomweb.selection', JSON.stringify(selection)); } catch (e) { /* ignore */ } };
let serverWads = [];

async function refreshLibrary() {
  library = [];
  for (const name of await store.keys('meta')) { const m = await store.get('meta', name); if (m) library.push(m); }
  library.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'IWAD' ? -1 : 1));
  const names = new Set(library.map((w) => w.name));
  if (selection.iwad && !names.has(selection.iwad)) selection.iwad = null;
  selection.pwads = selection.pwads.filter((n) => names.has(n));
  if (!selection.iwad) { const first = library.find((w) => w.type === 'IWAD'); if (first) selection.iwad = first.name; }
  renderLibrary();
}

function renderLibrary() {
  const ul = $('lib'); ul.textContent = '';
  for (const w of library) {
    const li = document.createElement('li');
    const isI = w.type === 'IWAD';
    const checked = isI ? selection.iwad === w.name : selection.pwads.includes(w.name);
    if (checked) li.classList.add('sel');
    const inp = document.createElement('input');
    inp.type = isI ? 'radio' : 'checkbox'; inp.name = 'iwad'; inp.checked = checked;
    inp.addEventListener('change', () => {
      if (isI) selection.iwad = w.name;
      else if (inp.checked) selection.pwads.push(w.name);
      else selection.pwads = selection.pwads.filter((n) => n !== w.name);
      saveSelection(); renderLibrary();
    });
    const body = document.createElement('div'); body.className = 'grow';
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = w.name;
    const tag = document.createElement('span'); tag.className = 'tag ' + (isI ? 'iwad' : 'pwad'); tag.textContent = isI ? 'IWAD' : 'PWAD';
    nm.appendChild(tag);
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = fmtMB(w.size) + ' · ' + w.lumps + ' lumps' + (w.game ? ' · ' + GAME_LABEL[w.game] : '');
    body.append(nm, meta);
    const del = document.createElement('button'); del.className = 'btn small'; del.textContent = T('del');
    del.addEventListener('click', async () => {
      await store.del('wads', w.name); await store.del('meta', w.name);
      await refreshLibrary();
    });
    li.append(inp, body, del);
    ul.appendChild(li);
  }
  const hasIwad = !!selection.iwad;
  $('start').disabled = !hasIwad;
  $('startInfo').textContent = hasIwad ? '' : T('needIwad');
  $('libNote').textContent = !idbOK ? T('persistWarn') : library.some((w) => w.type === 'PWAD') ? T('pwadHint') : '';
  renderServerList();
}

async function addWadBytes(name, bytes) {
  const info = inspectWad(bytes);
  if (!info.ok) throw new Error(info.reason);
  const meta = { name, size: bytes.length, type: info.type, game: info.game, lumps: info.lumps };
  await store.put('wads', name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  await store.put('meta', name, meta);
  if (info.type === 'IWAD') selection.iwad = name;
  else if (!selection.pwads.includes(name)) selection.pwads.push(name);
  saveSelection();
  return meta;
}

async function addFiles(files) {
  for (const f of files) {
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const m = await addWadBytes(f.name, bytes);
      toast(`${T('added')}: ${m.name}`);
    } catch (e) {
      toast(`${f.name} ${T('notWad')} (${e.message})`, 4000);
    }
  }
  await refreshLibrary();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
}

// optional: WADs placed next to index.html in ./wads/ (static hosting)
async function probeServerWads() {
  try {
    const r = await fetch('wads/index.json', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    serverWads = (Array.isArray(j) ? j : j.wads || []).filter((n) => typeof n === 'string');
    renderServerList();
  } catch (e) { /* no server wads */ }
}
function renderServerList() {
  const ul = $('srvList'); ul.textContent = '';
  $('srvWrap').hidden = serverWads.length === 0;
  for (const name of serverWads) {
    const li = document.createElement('li'); li.className = 'row';
    const sp = document.createElement('span'); sp.className = 'grow'; sp.textContent = name;
    const have = library.some((w) => w.name === name);
    const b = document.createElement('button'); b.className = 'btn small'; b.textContent = have ? '✓' : T('load'); b.disabled = have;
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fetchWad(name, 'wads/' + encodeURIComponent(name)); await refreshLibrary(); }
      catch (e) { toast(`${T('fetchFail')}: ${name}`, 4000); b.disabled = false; }
    });
    li.append(sp, b); ul.appendChild(li);
  }
}
async function fetchWad(name, url) {
  const bar = $('bar'), fill = bar.firstElementChild;
  bar.hidden = false; fill.style.width = '0%';
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = +r.headers.get('content-length') || 0;
    let bytes;
    if (r.body && total) {
      bytes = new Uint8Array(total); let got = 0; const rd = r.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; bytes.set(value, got); got += value.length; fill.style.width = ((got / total) * 100).toFixed(1) + '%'; }
      if (got !== total) bytes = bytes.subarray(0, got);
    } else bytes = new Uint8Array(await r.arrayBuffer());
    await addWadBytes(name, bytes);
  } finally { bar.hidden = true; }
}

// drop zone / file input
const drop = $('drop'), fileInput = $('file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', async () => { const fs = [...fileInput.files]; fileInput.value = ''; await addFiles(fs); });
for (const ev of ['dragenter', 'dragover']) window.addEventListener(ev, (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); if (!running) drop.classList.add('over'); } });
for (const ev of ['dragleave', 'drop']) window.addEventListener(ev, () => drop.classList.remove('over'));
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (running || !e.dataTransfer) return;
  await addFiles([...e.dataTransfer.files]);
});

// ---------------------------------------------------------------------------
// engine lifecycle
// ---------------------------------------------------------------------------
let wasmModule = null;
let engine = null, running = false, rafId = 0;
let lostMs = 0, lastRaf = 0, suspended = false, suspendedAt = 0;
const audio = new WebAudio();
let profile = 'default';

async function getWasmModule() {
  if (!wasmModule) {
    const r = await fetch('doom.wasm');
    if (!r.ok) throw new Error('doom.wasm: HTTP ' + r.status);
    wasmModule = await WebAssembly.compile(await r.arrayBuffer());   // does not depend on the response MIME type
  }
  return wasmModule;
}

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }

async function startGame(opts) {
  const iwadName = opts.iwad, pwadNames = opts.pwads, extra = opts.args || '';
  audio.ensure();                       // inside the user gesture
  applyAudioSettings();
  $('start').disabled = true; $('startInfo').textContent = T('loadingWasm');
  try {
    const mod = await getWasmModule();
    $('startInfo').textContent = T('loading');
    const iwadBuf = await store.get('wads', iwadName);
    if (!iwadBuf) throw new Error('IWAD missing: ' + iwadName);
    const pwadBufs = [];
    for (const n of pwadNames) { const b = await store.get('wads', n); if (b) pwadBufs.push([n, b]); }

    profile = hashStr([iwadName, iwadBuf.byteLength, ...pwadBufs.map(([n, b]) => n + b.byteLength)].join('|'));
    const eng = new DoomEngine({
      log, now: () => performance.now() - lostMs, audio,
      persist: (name, bytes) => { const k = profile + '/' + name; if (bytes) store.put('saves', k, bytes).catch(() => {}); else store.del('saves', k).catch(() => {}); },
    });
    await eng.load(mod);
    eng.addFile('iwad.wad', new Uint8Array(iwadBuf));
    const pw = pwadBufs.map(([, b], i) => { const n = `pwad${i}.wad`; eng.addFile(n, new Uint8Array(b)); return n; });
    // restore savegames / config for this wad combination
    for (const k of await store.keys('saves')) {
      if (typeof k === 'string' && k.startsWith(profile + '/')) { const v = await store.get('saves', k); if (v) eng.addFile(k.slice(profile.length + 1), v); }
    }
    logLines.length = 0;
    const args = extra.trim() ? extra.trim().split(/\s+/) : [];
    engine = eng;
    $('loader').hidden = true;
    app.classList.add('running');
    layout();
    lostMs = 0; lastRaf = performance.now(); suspended = false; held.clear(); heldCount.clear();
    eng.start({ iwad: 'iwad.wad', pwads: pw, args });
    running = true;
    canvas.focus();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    fail(e);
  } finally {
    $('start').disabled = !selection.iwad; if (!running) $('startInfo').textContent = '';
  }
}

function stopGame() {
  running = false; cancelAnimationFrame(rafId);
  if (engine) engine.saveConfig();
  audio.musicStop();
  engine = null;
  releaseAll();
  app.classList.remove('running', 'menumode');
  document.exitPointerLock && document.exitPointerLock();
}

function fail(e) {
  const wasRunning = running;
  stopGame();
  const exit = e instanceof DoomExit;
  $('msgTitle').textContent = exit ? T('exitTitle') : T('crashTitle');
  $('msgBody').textContent = exit ? T('exitBody') : (e && e.message ? e.message : String(e));
  const pre = $('msgLog');
  pre.hidden = exit || !logLines.length; pre.textContent = logLines.slice(-30).join('\n');
  $('msg').hidden = false;
  $('msgRestart').onclick = () => { $('msg').hidden = true; if (lastStart) startGame(lastStart); else showLoader(); };
  $('msgBack').onclick = showLoader;
  if (!wasRunning) { /* failed while booting */ $('loader').hidden = true; }
}
function showLoader() { $('msg').hidden = true; $('settings').hidden = true; if (running) stopGame(); $('loader').hidden = false; refreshLibrary(); }

let lastStart = null;
$('start').addEventListener('click', () => {
  if (!selection.iwad) return;
  try { localStorage.setItem('doomweb.args', $('extraArgs').value); } catch (e) { /* ignore */ }
  lastStart = { iwad: selection.iwad, pwads: [...selection.pwads], args: $('extraArgs').value };
  startGame(lastStart);
});
try { $('extraArgs').value = localStorage.getItem('doomweb.args') || ''; } catch (e) { /* ignore */ }

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
let lastUIState = 0;
function loop(ts) {
  if (!running) return;
  rafId = requestAnimationFrame(loop);
  const d = ts - lastRaf; lastRaf = ts;
  if (d > 250) lostMs += d - 17;                  // background tab / hiccup: do not fast-forward the game
  if (suspended) return;
  try {
    pollGamepad(d);
    engine.frame();
    if (engine.dirty) { engine.dirty = false; render(); }
    if (ts - lastUIState > 90) { lastUIState = ts; syncState(); }
  } catch (e) {
    if (e instanceof DoomFatalError || e instanceof DoomExit) fail(e);
    else { console.error(e); fail(e); }
  }
}

function setSuspended(s) {
  if (s === suspended || !running) return;
  suspended = s;
  if (s) { suspendedAt = performance.now(); releaseAll(); audio.ctx && audio.ctx.suspend && audio.ctx.suspend().catch(() => {}); }
  else { lostMs += performance.now() - suspendedAt; lastRaf = performance.now(); audio.ctx && audio.ctx.resume && audio.ctx.resume().catch(() => {}); }
}

// ---------------------------------------------------------------------------
// rendering + layout (any window size / aspect ratio)
// ---------------------------------------------------------------------------
const ctx2d = canvas.getContext('2d', { alpha: false });
const srcCanvas = document.createElement('canvas'); srcCanvas.width = SCREENW; srcCanvas.height = SCREENH;
const srcCtx = srcCanvas.getContext('2d', { alpha: false });
let midCanvas = null, midCtx = null, midK = 0;

function render() {
  const fb = engine.framebuffer();
  if (!fb) return;
  srcCtx.putImageData(new ImageData(fb, SCREENW, SCREENH), 0, 0);
  const cw = canvas.width, ch = canvas.height;
  if (settings.filter === 'nearest') {
    ctx2d.imageSmoothingEnabled = false; ctx2d.drawImage(srcCanvas, 0, 0, cw, ch);
  } else if (settings.filter === 'smooth') {
    ctx2d.imageSmoothingEnabled = true; ctx2d.imageSmoothingQuality = 'high'; ctx2d.drawImage(srcCanvas, 0, 0, cw, ch);
  } else {
    // integer pre-scale with nearest neighbour, then a small bilinear step to the exact size:
    // crisp pixels at any (non-integer) scale without shimmering
    const k = Math.max(1, Math.min(8, Math.ceil(Math.max(cw / SCREENW, ch / SCREENH))));
    if (k <= 1) { ctx2d.imageSmoothingEnabled = true; ctx2d.imageSmoothingQuality = 'high'; ctx2d.drawImage(srcCanvas, 0, 0, cw, ch); return; }
    if (!midCanvas || midK !== k) {
      midCanvas = document.createElement('canvas'); midCanvas.width = SCREENW * k; midCanvas.height = SCREENH * k;
      midCtx = midCanvas.getContext('2d', { alpha: false }); midK = k;
    }
    midCtx.imageSmoothingEnabled = false; midCtx.drawImage(srcCanvas, 0, 0, midCanvas.width, midCanvas.height);
    ctx2d.imageSmoothingEnabled = true; ctx2d.imageSmoothingQuality = 'high'; ctx2d.drawImage(midCanvas, 0, 0, cw, ch);
  }
}

function layout() {
  const W = view.clientWidth, H = view.clientHeight;
  if (W < 2 || H < 2) return;
  let w, h;
  if (settings.aspect === 'fill') { w = W; h = H; }
  else {
    const r = settings.aspect === '16:10' ? 16 / 10 : 4 / 3;
    if (W / H > r) { h = H; w = H * r; } else { w = W; h = W / r; }
  }
  w = Math.floor(w); h = Math.floor(h);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  const maxPix = 9e6;
  if (bw * bh > maxPix) { const s = Math.sqrt(maxPix / (bw * bh)); bw = Math.round(bw * s); bh = Math.round(bh * s); }
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  app.classList.toggle('portrait', window.innerHeight > window.innerWidth);
  if (engine && engine.fbPtr) render();
}
new ResizeObserver(layout).observe(view);
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', () => setTimeout(layout, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);

// ---------------------------------------------------------------------------
// input: key helpers (reference counted so keyboard + touch can overlap)
// ---------------------------------------------------------------------------
const K = {
  RIGHT: 0xae, LEFT: 0xac, UP: 0xad, DOWN: 0xaf, ESC: 27, ENTER: 13, TAB: 9, BACKSPACE: 127, PAUSE: 0xff,
  RSHIFT: 0x80 + 0x36, RCTRL: 0x80 + 0x1d, RALT: 0x80 + 0x38, SPACE: 32, COMMA: 44, PERIOD: 46, MINUS: 45, EQUALS: 61,
};
const heldCount = new Map();
const held = new Map();     // source id -> doom key (keyboard codes)
function press(code) {
  const n = heldCount.get(code) || 0; heldCount.set(code, n + 1);
  if (n === 0 && engine) engine.key(true, code);
}
function release(code) {
  const n = heldCount.get(code) || 0;
  if (n <= 0) return;
  if (n === 1) { heldCount.delete(code); if (engine) engine.key(false, code); } else heldCount.set(code, n - 1);
}
function releaseAll() {
  if (engine) for (const code of heldCount.keys()) engine.key(false, code);
  heldCount.clear(); held.clear();
  stickKeys.clear(); stickRun = false;
  if (engine) engine.mouseButtons(0);
  mouseMask = 0;
}
function tap(code, ms = 60) { press(code); setTimeout(() => release(code), ms); }

// ---- keyboard ----
function codeToDoom(e, st) {
  const c = e.code;
  switch (c) {
    case 'ArrowUp': return K.UP; case 'ArrowDown': return K.DOWN; case 'ArrowLeft': return K.LEFT; case 'ArrowRight': return K.RIGHT;
    case 'Enter': case 'NumpadEnter': return K.ENTER; case 'Escape': return K.ESC; case 'Tab': return K.TAB;
    case 'Backspace': return K.BACKSPACE; case 'Pause': return K.PAUSE; case 'Space': return K.SPACE;
    case 'ControlLeft': case 'ControlRight': return K.RCTRL;
    case 'AltLeft': case 'AltRight': return K.RALT;
    case 'ShiftLeft': case 'ShiftRight': return K.RSHIFT;
    case 'Comma': return K.COMMA; case 'Period': return K.PERIOD; case 'Minus': case 'NumpadSubtract': return K.MINUS; case 'Equal': case 'NumpadAdd': return K.EQUALS;
    case 'Insert': return K.SPACE;
    default: break;
  }
  let m;
  if ((m = /^F(\d{1,2})$/.exec(c))) { const n = +m[1]; if (n >= 1 && n <= 10) return 0x80 + 0x3b + (n - 1); return 0; } // F11/F12 stay with the browser
  if ((m = /^Key([A-Z])$/.exec(c))) {
    const ch = m[1].toLowerCase();
    if (settings.wasd && st && st.level && !st.menu && !st.typing && !e.ctrlKey && !e.metaKey) {
      if (ch === 'w') return K.UP; if (ch === 's') return K.DOWN; if (ch === 'a') return K.COMMA; if (ch === 'd') return K.PERIOD;
      if (ch === 'e') return K.SPACE;
    }
    return ch.charCodeAt(0);
  }
  if ((m = /^(?:Digit|Numpad)(\d)$/.exec(c))) return 48 + +m[1];
  return 0;
}

let lastState = { menu: false, level: false, automap: false, typing: false, paused: false };
window.addEventListener('keydown', (e) => {
  if (!running) return;
  const tgt = e.target;
  if (tgt && tgt !== document.body && tgt !== canvas && tgt.id !== 'kbd' && /^(INPUT|SELECT|TEXTAREA)$/.test(tgt.tagName)) return;
  if (!$('settings').hidden) { if (e.key === 'Escape') { closeSettings(); e.preventDefault(); } return; }
  if (e.metaKey || (e.ctrlKey && /^Key[RWTNLQ]$/.test(e.code)) || (e.ctrlKey && e.code === 'Tab')) return;   // browser shortcuts
  audio.ensure();
  const st = lastState;
  const code = codeToDoom(e, st);
  if (!code) return;
  e.preventDefault();
  if (e.repeat) { if (held.has(e.code)) engine.key(true, held.get(e.code)); return; }
  held.set(e.code, code);
  press(code);
  maybeLockPointer(st);
});
window.addEventListener('keyup', (e) => {
  if (!running) return;
  const code = held.get(e.code);
  if (code !== undefined) { held.delete(e.code); release(code); e.preventDefault(); }
});
window.addEventListener('blur', () => { releaseAll(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { releaseAll(); if (engine) engine.saveConfig(); }
});
window.addEventListener('pagehide', () => { if (engine) engine.saveConfig(); });

// ---- mouse (pointer lock) ----
let mouseMask = 0;
function maybeLockPointer(st) {
  if (!running || matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) return;
  if (st && st.level && !st.menu && !document.pointerLockElement && canvas.requestPointerLock) {
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  }
}
canvas.addEventListener('mousedown', (e) => {
  if (!running) return;
  audio.ensure();
  if (!document.pointerLockElement) { maybeLockPointer(lastState); if (!lastState.level || lastState.menu) return; }
  e.preventDefault();
  if (e.button === 0) { mouseMask |= 1; engine.mouseButtons(mouseMask); }
  else if (e.button === 2) press(K.SPACE);
  else if (e.button === 1) { mouseMask |= 4; engine.mouseButtons(mouseMask); }
});
window.addEventListener('mouseup', (e) => {
  if (!running) return;
  if (e.button === 0) { mouseMask &= ~1; engine.mouseButtons(mouseMask); }
  else if (e.button === 2) release(K.SPACE);
  else if (e.button === 1) { mouseMask &= ~4; engine.mouseButtons(mouseMask); }
});
window.addEventListener('mousemove', (e) => {
  if (running && document.pointerLockElement === canvas) engine.mouseMove(e.movementX * settings.mouseSens, 0);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && engine) { mouseMask = 0; engine.mouseButtons(0); } });
window.addEventListener('wheel', (e) => {
  if (!running || !lastState.level || lastState.menu || !$('settings').hidden) return;
  e.preventDefault();
  cycleWeapon(e.deltaY > 0 ? 1 : -1);
}, { passive: false });

// ---- weapons ----
const SLOT_OF = { 0: 1, 7: 1, 1: 2, 2: 3, 8: 3, 3: 4, 4: 5, 5: 6, 6: 7 };
const SLOT_OWNED = [null, [0, 7], [1], [2, 8], [3], [4], [5], [6]];
function cycleWeapon(dir) {
  if (!engine) return;
  const { current, owned } = engine.weapon();
  const have = (s) => SLOT_OWNED[s].some((w) => owned & (1 << w));
  let s = SLOT_OF[current] || 2;
  for (let i = 0; i < 7; i++) {
    s += dir; if (s > 7) s = 1; if (s < 1) s = 7;
    if (have(s)) { tap(48 + s, 50); return; }
  }
}

// ---- touch ----
const touchEl = $('touch'), moveZone = $('moveZone'), lookZone = $('lookZone');
const stickBase = $('stickBase'), stickKnob = $('stickKnob');
let usedTouch = false;
const stickKeys = new Set(); let stickRun = false;
const stick = { id: null, ox: 0, oy: 0 };

function touchWanted() {
  if (settings.touch === 'on') return true;
  if (settings.touch === 'off') return false;
  return usedTouch || (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches) || navigator.maxTouchPoints > 1 && matchMedia('(pointer: coarse)').matches;
}
function applyTouchMode() {
  app.classList.toggle('touch', touchWanted());
  app.classList.toggle('swap', !!settings.swapSides);
  app.classList.toggle('used-touch', usedTouch);
  document.documentElement.style.setProperty('--ui-scale', settings.uiScale);
  document.documentElement.style.setProperty('--ui-opacity', settings.uiOpacity);
}
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && !usedTouch) { usedTouch = true; applyTouchMode(); layout(); }
}, { capture: true });

function setStickKeys(want) {
  for (const k of [...stickKeys]) if (!want.has(k)) { stickKeys.delete(k); release(k); }
  for (const k of want) if (!stickKeys.has(k)) { stickKeys.add(k); press(k); }
}
function stickUpdate(x, y) {
  const R = 58 * settings.uiScale * (Math.min(window.innerWidth, window.innerHeight) < 500 ? 0.85 : 1);
  let dx = x - stick.ox, dy = y - stick.oy;
  const mag = Math.hypot(dx, dy);
  if (mag > R) { dx = dx / mag * R; dy = dy / mag * R; }
  stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  const nx = dx / R, ny = dy / R, dead = 0.28;
  const want = new Set();
  if (ny < -dead) want.add(K.UP); else if (ny > dead) want.add(K.DOWN);
  const left = settings.stickMode === 'turn' ? K.LEFT : K.COMMA, right = settings.stickMode === 'turn' ? K.RIGHT : K.PERIOD;
  if (nx < -dead) want.add(left); else if (nx > dead) want.add(right);
  if (mag > R * 0.95 && want.size) want.add(K.RSHIFT);       // push to the rim = run
  setStickKeys(want);
}
function stickEnd() {
  stick.id = null; stickBase.style.display = 'none'; stickKnob.style.transform = '';
  setStickKeys(new Set());
}
moveZone.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || stick.id !== null) return;
  e.preventDefault(); audio.ensure();
  moveZone.setPointerCapture(e.pointerId);
  stick.id = e.pointerId; stick.ox = e.clientX; stick.oy = e.clientY;
  stickBase.style.display = 'block'; stickBase.style.left = e.clientX + 'px'; stickBase.style.top = e.clientY + 'px';
  stickUpdate(e.clientX, e.clientY);
});
moveZone.addEventListener('pointermove', (e) => { if (e.pointerId === stick.id) { e.preventDefault(); stickUpdate(e.clientX, e.clientY); } });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) moveZone.addEventListener(ev, (e) => { if (e.pointerId === stick.id) stickEnd(); });

const look = { id: null, x: 0 };
lookZone.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || look.id !== null) return;
  e.preventDefault(); audio.ensure();
  lookZone.setPointerCapture(e.pointerId); look.id = e.pointerId; look.x = e.clientX;
});
lookZone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== look.id || !engine) return;
  e.preventDefault();
  const dx = e.clientX - look.x; look.x = e.clientX;
  engine.mouseMove(dx * settings.lookSens, 0);
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) lookZone.addEventListener(ev, (e) => { if (e.pointerId === look.id) look.id = null; });

// buttons (data-key = hold a doom key, data-act = one-shot action)
let repeatTimer = 0, repeatTimer2 = 0;
for (const b of touchEl.querySelectorAll('.tbtn')) {
  const key = b.dataset.key ? +b.dataset.key : 0, act = b.dataset.act, rep = !!b.dataset.repeat;
  let active = null;
  const down = (e) => {
    e.preventDefault(); audio.ensure();
    if (active !== null) return;
    active = e.pointerId; b.setPointerCapture(e.pointerId); b.classList.add('down');
    if (act === 'nextWeapon') cycleWeapon(1);
    else if (act === 'prevWeapon') cycleWeapon(-1);
    else if (key) {
      press(key);
      if (rep) { // auto-repeat for menu navigation / sliders
        repeatTimer = setTimeout(() => { repeatTimer2 = setInterval(() => engine && engine.key(true, key), 110); }, 380);
      }
    }
  };
  const up = (e) => {
    if (active === null || (e && e.pointerId !== undefined && e.pointerId !== active)) return;
    active = null; b.classList.remove('down');
    clearTimeout(repeatTimer); clearInterval(repeatTimer2);
    if (key) release(key);
  };
  b.addEventListener('pointerdown', down);
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, up);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}
// tap on the picture while in title/demo/intermission = "continue"
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || !running) return;
  audio.ensure();
  if (!lastState.level && !lastState.menu) tap(K.ENTER, 70);
});

// soft keyboard for savegame names on touch devices
const kbd = $('kbd');
function syncKeyboard(st) {
  const need = st.typing && app.classList.contains('touch');
  if (need && document.activeElement !== kbd) { kbd.focus({ preventScroll: true }); }
  else if (!need && document.activeElement === kbd) { kbd.blur(); canvas.focus({ preventScroll: true }); }
}
kbd.addEventListener('input', (e) => {
  const v = kbd.value; kbd.value = '';
  for (const ch of v) { const c = ch.charCodeAt(0); if (c >= 32 && c < 127) tap(c, 25); }
});
kbd.addEventListener('beforeinput', (e) => { if (e.inputType === 'deleteContentBackward') { tap(K.BACKSPACE, 25); } });
kbd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tap(K.ENTER, 40); } else if (e.key === 'Escape') { e.preventDefault(); tap(K.ESC, 40); } });

// state-dependent UI (menu pad vs in-game controls, pointer lock, soft keyboard)
function syncState() {
  if (!engine) return;
  const st = engine.state(); lastState = st;
  const menuMode = !st.level || st.menu;
  app.classList.toggle('menumode', menuMode);
  if (menuMode && document.pointerLockElement) document.exitPointerLock();
  if (menuMode && stick.id !== null) stickEnd();
  syncKeyboard(st);
}

// ---- gamepad ----
const padHeld = new Set();
let padTurn = 0;
function padKey(code, on) { if (on && !padHeld.has(code)) { padHeld.add(code); press(code); } else if (!on && padHeld.has(code)) { padHeld.delete(code); release(code); } }
const padPrev = {};
function pollGamepad(dtMs) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = [...pads].find((p) => p && p.connected && p.mapping === 'standard') || [...pads].find((p) => p && p.connected);
  if (!gp) { if (padHeld.size) for (const k of [...padHeld]) padKey(k, false); return; }
  const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
  const edge = (i) => { const v = b(i), p = !!padPrev[i]; padPrev[i] = v; return v && !p; };
  const st = lastState, inMenu = !st.level || st.menu, dz = 0.3;
  const lx = gp.axes[0] || 0, ly = gp.axes[1] || 0, rx = gp.axes[2] || 0;
  if (inMenu) {
    padKey(K.UP, b(12) || ly < -0.6); padKey(K.DOWN, b(13) || ly > 0.6); padKey(K.LEFT, b(14) || lx < -0.6); padKey(K.RIGHT, b(15) || lx > 0.6);
    padKey(K.ENTER, b(0)); padKey(K.ESC, b(1) || b(9)); padKey(121, b(3)); padKey(110, b(2));
    padKey(K.RCTRL, false); padKey(K.SPACE, false);
    edge(4); edge(5);
  } else {
    padKey(K.UP, ly < -dz || b(12)); padKey(K.DOWN, ly > dz || b(13));
    padKey(K.COMMA, lx < -dz || b(14)); padKey(K.PERIOD, lx > dz || b(15));
    padKey(K.RCTRL, b(7) || b(0) || b(6)); padKey(K.SPACE, b(2) || b(1)); padKey(K.RSHIFT, b(10) || Math.hypot(lx, ly) > 0.92);
    padKey(K.TAB, b(3)); padKey(K.ESC, b(9)); padKey(K.ENTER, false); padKey(121, false); padKey(110, false);
    if (edge(5)) cycleWeapon(1); if (edge(4)) cycleWeapon(-1);
    if (Math.abs(rx) > 0.15 && engine) engine.mouseMove(rx * Math.min(dtMs, 50) * 0.55 * settings.mouseSens, 0);
  }
}

// ---------------------------------------------------------------------------
// toolbar / fullscreen / settings
// ---------------------------------------------------------------------------
const fsEl = document.documentElement;
const fsActive = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
async function toggleFullscreen() {
  try {
    if (fsActive()) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    const req = fsEl.requestFullscreen || fsEl.webkitRequestFullscreen;
    if (!req) throw new Error('unsupported');
    await req.call(fsEl, { navigationUI: 'hide' });
    try { if (screen.orientation && screen.orientation.lock && app.classList.contains('touch')) await screen.orientation.lock('landscape'); } catch (e) { /* not supported / not allowed */ }
  } catch (e) { toast(T('fsFail'), 3000); }
}
function onFsChange() { $('btnFs').classList.toggle('on', fsActive()); setTimeout(layout, 50); }
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
$('btnFs').addEventListener('click', (e) => { e.currentTarget.blur(); toggleFullscreen(); });
$('cfgFs').addEventListener('click', () => { closeSettings(); toggleFullscreen(); });

function applyAudioSettings() {
  audio.setSfxScale(settings.sfxScale); audio.setMusicScale(settings.musicScale); audio.setMuted(settings.muted);
  $('btnMute').textContent = settings.muted ? '🔇' : '🔊';
}
$('btnMute').addEventListener('click', () => { audio.ensure(); settings.muted = !settings.muted; saveSettings(); applyAudioSettings(); syncSettingsUI(); });

function openSettings() { syncSettingsUI(); $('settings').hidden = false; setSuspended(true); if (document.pointerLockElement) document.exitPointerLock(); }
function closeSettings() { $('settings').hidden = true; setSuspended(false); canvas.focus && canvas.focus({ preventScroll: true }); }
$('btnCfg').addEventListener('click', () => ($('settings').hidden ? openSettings() : closeSettings()));
$('cfgClose').addEventListener('click', closeSettings);
$('settings').addEventListener('pointerdown', (e) => { if (e.target === $('settings')) closeSettings(); });
$('cfgBack').addEventListener('click', () => { closeSettings(); showLoader(); });
$('cfgReset').addEventListener('click', () => { settings = { ...DEFAULTS }; saveSettings(); syncSettingsUI(); applySettings(); });

function syncSettingsUI() {
  for (const el of $('settings').querySelectorAll('[data-k]')) {
    const v = settings[el.dataset.k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  }
}
function applySettings() {
  applyTouchMode(); applyAudioSettings(); layout();
  if (engine && engine.fbPtr) render();
}
for (const el of $('settings').querySelectorAll('[data-k]')) {
  el.addEventListener('input', () => {
    const k = el.dataset.k;
    settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? parseFloat(el.value) : el.value;
    saveSettings(); applySettings();
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  applyTouchMode(); applyAudioSettings(); layout();
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone && !document.fullscreenEnabled) $('iosNote').hidden = false;
  if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled) $('btnFs').title = T('fsFail');

  await store.init();
  await refreshLibrary();
  probeServerWads();

  // deep links: ?iwad=URL&pwad=URL,URL&args=...&autostart=1   (works on any static host)
  const q = new URLSearchParams(location.search);
  if (q.get('iwad')) {
    try {
      const urls = [q.get('iwad'), ...((q.get('pwad') || '').split(',').filter(Boolean))];
      selection.pwads = [];
      for (const u of urls) {
        const name = decodeURIComponent(u.split('/').pop().split('?')[0]) || 'game.wad';
        if (!library.some((w) => w.name === name)) await fetchWad(name, u);
        await refreshLibrary();
        const meta = library.find((w) => w.name === name);
        if (meta && meta.type === 'IWAD') selection.iwad = name; else if (meta && !selection.pwads.includes(name)) selection.pwads.push(name);
      }
      renderLibrary();
      if (q.get('args')) $('extraArgs').value = q.get('args');
      if (q.get('autostart') === '1') toast(T('tapHint'));
    } catch (e) { toast(T('fetchFail') + ': ' + e.message, 5000); }
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
