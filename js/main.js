// main.js — 场景、相机、界面绑定与渲染循环
import * as THREE from 'three';
import { COPY } from './copy.js';
import { buildCorridor } from './geo.js';
import { TileManager } from './tilemanager.js';
import { Hud, Bench } from './hud.js';
import { frameStats } from './hud.js';

window.addEventListener('error', (e) => {
  (window.__errs = window.__errs || []).push(String((e && e.message) || e));
});
window.addEventListener('unhandledrejection', (e) => {
  (window.__errs = window.__errs || []).push('rejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason)));
});

const state = {
  corridor: null,
  dist: 0,
  speedKmh: 240,
  altitude: 420,
  playing: true,
  mode: 'follow',
  mouseYaw: 0,
  mousePitch: 0,
  dragging: false,
  lastPointer: { x: 0, y: 0 },
  keys: new Set(),
  camera2d: { x: 0, z: 0, bearing: 0 },
  residentRects: [],
  tiles: null,
  hud: null,
  bench: null,
  scene: null,
  camera: null,
  renderer: null,
  options: {
    mode: 'batch',
    lodBias: 0,
    bufferMeters: 2500,
    concurrency: 6,
    maxBuilds: 3,
    texBudgetMB: 384,
    imgCap: 16,
    wantImagery: true,
    allowRemoteDem: true,
    useLocalDem: false,
    skirt: true,
  },
};

const BENCH_MODES = {
  A: { key: 'A', name: COPY.bench.modes.A, durationSec: 30, speedKmh: 60 },
  B: { key: 'B', name: COPY.bench.modes.B, durationSec: 45, speedKmh: 3600 },
  C: { key: 'C', name: COPY.bench.modes.C, durationSec: 40, speedKmh: 0, jumpKm: 5, jumpEverySec: 2 },
};

function getCopy(path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), COPY);
}

function applyCopy(root = document) {
  root.querySelectorAll('[data-copy]').forEach((el) => {
    const v = getCopy(el.dataset.copy);
    if (typeof v === 'string') el.textContent = v;
  });
  root.querySelectorAll('[data-copy-title]').forEach((el) => {
    const v = getCopy(el.dataset.copyTitle);
    if (typeof v === 'string') el.title = v;
  });
  root.querySelectorAll('[data-copy-aria]').forEach((el) => {
    const v = getCopy(el.dataset.copyAria);
    if (typeof v === 'string') el.setAttribute('aria-label', v);
  });
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2600);
}

async function loadCorridor() {
  for (const url of ['data/corridor.json', 'data/corridor.dev.json']) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* 尝试下一个 */ }
  }
  throw new Error('corridor-json-missing');
}

function initScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9cddb);
  scene.fog = new THREE.Fog(0xb9cddb, 4000, 28000);
  const camera = new THREE.PerspectiveCamera(52, 1, 5, 60000);
  camera.rotation.order = 'YXZ';
  const sun = new THREE.DirectionalLight(0xfff3e2, 1.55);
  sun.position.set(-6000, 9000, 4000);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xcfe2f0, 0x50604a, 1.05);
  scene.add(hemi);
  state.sun = sun;
  state.hemi = hemi;
  state.renderer = renderer;
  state.scene = scene;
  state.camera = camera;
}

function updateCamera(dt) {
  const c = state.corridor;
  const camera = state.camera;
  if (state.mode === 'follow') {
    if (state.playing || state.bench.running) {
      const jump = BENCH_MODES.C;
      const speed = state.bench.running ? state.bench.ctxSpeedKmh : state.speedKmh;
      if (!(state.bench.running && state.bench.mode.key === 'C')) {
        state.dist += (speed / 3.6) * dt;
        if (state.dist > c.totalMeters) state.dist -= c.totalMeters;
      }
    }
    const p = c.sampleAt(state.dist);
    const ahead = c.sampleAt(state.dist + 900);
    const bearing = Math.atan2(-(ahead.x - p.x), -(ahead.z - p.z));
    const ground = state.tiles ? state.tiles.groundHeightAt(p.x, p.z) : null;
    const targetY = (ground != null ? ground : p.ele) + state.altitude;
    if (state.camY === undefined) state.camY = targetY;
    const diff = targetY - state.camY;
    state.camY += Math.abs(diff) > 400 ? diff : diff * Math.min(1, dt * 2.5);
    camera.position.set(p.x, state.camY, p.z);
    camera.rotation.y = bearing + state.mouseYaw;
    camera.rotation.x = -0.30 + state.mousePitch;
    state.camera2d = { x: p.x, z: p.z, bearing: (-bearing * 180) / Math.PI };
  } else {
    camera.rotation.y = state.freeYaw;
    camera.rotation.x = state.freePitch;
    const speed = 900 * dt;
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
    const right = new THREE.Vector3(1, 0, 0).applyEuler(camera.rotation);
    if (state.keys.has('w')) camera.position.addScaledVector(fwd, speed);
    if (state.keys.has('s')) camera.position.addScaledVector(fwd, -speed);
    if (state.keys.has('a')) camera.position.addScaledVector(right, -speed);
    if (state.keys.has('d')) camera.position.addScaledVector(right, speed);
    if (state.keys.has('q')) camera.position.y += speed;
    if (state.keys.has('e')) camera.position.y -= speed;
    state.camera2d = { x: camera.position.x, z: camera.position.z, bearing: (-camera.rotation.y * 180) / Math.PI };
  }
}

function resize() {
  const canvas = state.renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(320, rect.width), h = Math.max(240, rect.height);
  state.renderer.setSize(w, h, false);
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
}

function bindUI() {
  const $ = (id) => document.getElementById(id);
  const sync = () => {
    $('valSpeed').textContent = COPY.fmt.speed(state.speedKmh);
    $('valAlt').textContent = COPY.fmt.meters(state.altitude);
    $('valBias').textContent = String(state.options.lodBias);
    $('valBuffer').textContent = COPY.fmt.km(state.options.bufferMeters / 1000);
    $('valConc').textContent = String(state.options.concurrency);
    $('valBuilds').textContent = String(state.options.maxBuilds);
    $('valTex').textContent = COPY.fmt.mb(state.options.texBudgetMB);
    $('btnPlay').textContent = state.playing ? COPY.panel.pause : COPY.panel.play;
    state.tiles.setOptions({
      mode: state.options.mode,
      lodBias: state.options.lodBias,
      bufferMeters: state.options.bufferMeters,
      concurrency: state.options.concurrency,
      maxBuildsPerFrame: state.options.maxBuilds,
      texBudgetMB: state.options.texBudgetMB,
      imgCap: state.options.imgCap,
      wantImagery: state.options.wantImagery,
      allowRemoteDem: state.options.allowRemoteDem,
      skirt: state.options.skirt,
    });
    state.tiles.skirtGroup.visible = state.options.skirt;
  };
  $('speed').addEventListener('input', (e) => { state.speedKmh = Number(e.target.value); sync(); });
  $('altitude').addEventListener('input', (e) => { state.altitude = Number(e.target.value); sync(); });
  $('bias').addEventListener('input', (e) => { state.options.lodBias = Number(e.target.value); sync(); });
  $('buffer').addEventListener('input', (e) => { state.options.bufferMeters = Number(e.target.value) * 1000; sync(); });
  $('concurrency').addEventListener('input', (e) => { state.options.concurrency = Number(e.target.value); sync(); });
  $('builds').addEventListener('input', (e) => { state.options.maxBuilds = Number(e.target.value); sync(); });
  $('texBudget').addEventListener('input', (e) => { state.options.texBudgetMB = Number(e.target.value); sync(); });
  $('imgCap').addEventListener('change', (e) => { state.options.imgCap = Number(e.target.value); sync(); });
  $('btnPlay').addEventListener('click', () => { state.playing = !state.playing; sync(); });
  $('btnJump').addEventListener('click', () => {
    const v = Number($('jumpTo').value);
    if (!Number.isFinite(v)) return;
    state.dist = Math.max(0, Math.min(state.corridor.totalMeters, v * 1000));
    toast(COPY.toast.jumped + ' ' + COPY.fmt.km(state.dist / 1000));
  });
  $('modeSelect').addEventListener('change', (e) => {
    state.mode = e.target.value;
    if (state.mode === 'free') {
      state.freeYaw = state.camera.rotation.y;
      state.freePitch = state.camera.rotation.x;
    }
  });
  $('imgOn').addEventListener('change', (e) => { state.options.wantImagery = e.target.checked; sync(); });
  $('reliefOn').addEventListener('change', (e) => {
    state.sun.intensity = e.target.checked ? 1.55 : 0.28;
    state.hemi.intensity = e.target.checked ? 1.05 : 1.3;
  });
  $('skirtOn').addEventListener('change', (e) => { state.options.skirt = e.target.checked; sync(); });
  $('hudOn').addEventListener('change', (e) => { $('hud').hidden = !e.target.checked; });
  $('minimapOn').addEventListener('change', (e) => { $('minimapWrap').hidden = !e.target.checked; });
  $('wireframe').addEventListener('change', (e) => {
    for (const r of state.tiles.resident.values()) r.mesh.material.wireframe = e.target.checked;
  });
  $('tileEdges').addEventListener('change', (e) => { state.showEdges = e.target.checked; });
  $('dprLock').addEventListener('change', (e) => {
    state.renderer.setPixelRatio(e.target.checked ? 1 : Math.min(window.devicePixelRatio, 2));
    resize();
  });
  $('baseline').addEventListener('change', (e) => {
    window.__lod.setTilesVisible(!e.target.checked);
  });
  $('batchMode').addEventListener('change', (e) => {
    state.options.mode = e.target.checked ? 'batch' : 'mesh';
    state.tiles.setMode(state.options.mode);
    toast(state.options.mode === 'batch' ? COPY.toast.modeBatch : COPY.toast.modeMesh);
  });
  for (const key of ['A', 'B', 'C']) {
    $('bench' + key).addEventListener('click', () => startBench(key));
  }
  $('benchStop').addEventListener('click', () => { state.bench.stop(); toast(COPY.bench.idle); });
  $('benchCopy').addEventListener('click', async () => {
    const text = JSON.stringify(state.bench.toJSON(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast(COPY.toast.copied);
    } catch (e) {
      toast(COPY.toast.copyFail);
    }
  });
  const canvas = state.renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    state.dragging = true;
    state.lastPointer = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    const dx = e.clientX - state.lastPointer.x;
    const dy = e.clientY - state.lastPointer.y;
    state.lastPointer = { x: e.clientX, y: e.clientY };
    if (state.mode === 'follow') {
      state.mouseYaw -= dx * 0.0025;
      state.mousePitch = Math.max(-0.5, Math.min(0.6, state.mousePitch - dy * 0.002));
    } else {
      state.freeYaw -= dx * 0.0025;
      state.freePitch = Math.max(-1.3, Math.min(1.3, state.freePitch - dy * 0.002));
    }
  });
  canvas.addEventListener('pointerup', (e) => { state.dragging = false; canvas.releasePointerCapture(e.pointerId); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.altitude = Math.max(120, Math.min(1600, state.altitude + e.deltaY * 0.6));
    $('altitude').value = String(state.altitude);
    sync();
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    state.keys.add(e.key.toLowerCase());
  });
  window.addEventListener('keyup', (e) => state.keys.delete(e.key.toLowerCase()));
  window.addEventListener('resize', resize);
  sync();
}

function startBench(key) {
  const mode = BENCH_MODES[key];
  state.playing = true;
  state.dist = 0;
  state.bench.ctxSpeedKmh = mode.speedKmh;
  state.bench.start(mode, benchCtx());
  document.getElementById('benchCard').hidden = true;
  toast(COPY.toast.benchRunning);
}

function benchCtx() {
  return {
    state,
    tiles: state.tiles,
    corridor: state.corridor,
    setTilesVisible: (v) => {
      state.tiles.group.visible = v;
      state.tiles.skirtGroup.visible = v && state.options.skirt;
    },
    viewportInfo: () => ({
      width: state.renderer.domElement.clientWidth,
      height: state.renderer.domElement.clientHeight,
      dpr: state.renderer.getPixelRatio(),
    }),
    settingsSnapshot: () => ({
      speedKmh: state.speedKmh,
      altitude: state.altitude,
      lodBias: state.options.lodBias,
      bufferKm: state.options.bufferMeters / 1000,
      concurrency: state.options.concurrency,
      maxBuilds: state.options.maxBuilds,
      texBudgetMB: state.options.texBudgetMB,
      imgCap: state.options.imgCap,
      imagery: state.options.wantImagery,
    }),
  };
}

function showBenchResult(rec) {
  const card = document.getElementById('benchCard');
  const rows = [
    [COPY.bench.name, rec.name],
    [COPY.bench.duration, rec.durationSec + ' s'],
    [COPY.bench.distance, COPY.fmt.km(rec.distanceKm)],
    [COPY.bench.avgFps, COPY.fmt.fps(rec.avgFps)],
    [COPY.bench.p95, COPY.fmt.ms(rec.frameMs.p95)],
    [COPY.bench.low1, COPY.fmt.fps(rec.low1Fps)],
    [COPY.bench.envCap, (rec.envRafFps || 0) + ' fps' + (rec.limitedByEnvironment ? COPY.bench.envLimited : '')],
    [COPY.bench.mainMs, COPY.fmt.ms(rec.mainThreadMs || 0)],
    [COPY.bench.mainP95, COPY.fmt.ms(rec.mainThreadP95Ms || 0)],
    [COPY.bench.warmup, COPY.fmt.ms(rec.warmupMaxMs || 0)],
    [COPY.bench.baseline, (rec.baseline ? COPY.fmt.ms(rec.baseline.p95) + ' p95 · ' + COPY.fmt.fps(rec.baseline.fps) + ' fps' : '—')],
    [COPY.bench.built, String(rec.built)],
    [COPY.bench.evicted, String(rec.evictions)],
    [COPY.bench.downloaded, COPY.fmt.mb(rec.downloadedMB)],
    [COPY.bench.texMem, COPY.fmt.mb(rec.memoryMB)],
    [COPY.bench.viewport, rec.viewport.width + ' × ' + rec.viewport.height + ' @ ' + rec.viewport.dpr + 'x'],
  ];
  document.getElementById('benchRows').innerHTML = rows
    .map(([k, v]) => '<div class="row"><span>' + k + '</span><b>' + v + '</b></div>')
    .join('');
  const verdict = document.getElementById('benchVerdict');
  verdict.textContent = rec.verdict === 'pass' ? COPY.bench.verdictPass : rec.verdict === 'warn' ? COPY.bench.verdictWarn : COPY.bench.verdictFail;
  verdict.className = 'verdict ' + rec.verdict;
  card.hidden = false;
}

function edgesGeometry() {
  const positions = [];
  for (const r of state.tiles.resident.values()) {
    const h = (r.size / 2);
    const y = (r.centerY || 0) + 3;
    const x0 = r.cx - h, x1 = r.cx + h, z0 = r.cz - h, z1 = r.cz + h;
    positions.push(x0, y, z0, x1, y, z0, x1, y, z0, x1, y, z1, x1, y, z1, x0, y, z1, x0, y, z1, x0, y, z0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  return g;
}

async function boot() {
  applyCopy();
  document.title = COPY.app.docTitle;
  toast(COPY.toast.loading);
  const canvas = document.getElementById('view');
  initScene(canvas);
  try {
    const raw = await loadCorridor();
    state.corridor = buildCorridor(raw);
    document.getElementById('corridorName').textContent = raw.name || '—';
    document.getElementById('corridorLen').textContent = COPY.fmt.km(state.corridor.totalMeters / 1000);
  } catch (err) {
    (window.__errs = window.__errs || []).push('boot: ' + String((err && err.message) || err));
    toast(COPY.toast.loadFail + String(err.message || err));
    return;
  }
  state.tiles = new TileManager({
    scene: state.scene,
    corridor: state.corridor,
    renderer: state.renderer,
    onEvent: (type) => {
      if (type === 'imgFail') toast(COPY.toast.imgFail);
      if (type === 'demFail') toast(COPY.toast.demFail);
    },
  });
  state.hud = new Hud({ corridor: state.corridor });
  state.bench = new Bench({
    onProgress: () => {},
    onDone: (rec) => { showBenchResult(rec); toast(COPY.toast.benchDone); },
  });
  state.bench.ctxSpeedKmh = state.speedKmh;
  state.tiles.maxAniso = Math.min(4, state.renderer.capabilities.getMaxAnisotropy());
  state.showEdges = false;
  state.profile = {};
  let edges = null;
  bindUI();
  resize();
  state.edgesGroup = new THREE.Group();
  state.scene.add(state.edgesGroup);

  let last = performance.now();
  let lastEdges = 0;
  // 环境 rAF 上限：启动负载很高时测值会偏低，取多次测量的最大值
  state.envRafFps = 0;
  for (const delay of [5000, 11000, 18000, 26000]) {
    setTimeout(() => {
      measureRafCeiling(1200).then((v) => {
        if (v > (state.envRafFps || 0)) state.envRafFps = v;
      });
    }, delay);
  }
  const loop = (now) => {
    state.rafId = requestAnimationFrame(loop);
    const dtMs = Math.min(200, now - last);
    last = now;
    const dt = dtMs / 1000;
    const t0 = performance.now();
    updateCamera(dt);
    state.tiles.update({ x: state.camera.position.x, z: state.camera.position.z, dist: state.dist });
    const t1 = performance.now();
    state.hud.frame(dtMs);
    state.bench.tick(now, dtMs, benchCtx());
    state.renderer.render(state.scene, state.camera);
    const t2 = performance.now();
    const ema = (k, v) => { state.profile[k] = state.profile[k] === undefined ? v : state.profile[k] * 0.92 + v * 0.08; };
    ema('tiles', t1 - t0);
    ema('render', t2 - t1);
    if (state.showEdges && now - lastEdges > 500) {
      lastEdges = now;
      if (edges) { state.edgesGroup.remove(edges); edges.geometry.dispose(); }
      edges = new THREE.LineSegments(edgesGeometry(), new THREE.LineBasicMaterial({ color: 0x9be0ff }));
      edges.frustumCulled = false;
      state.edgesGroup.add(edges);
    }
    if (!state.showEdges && edges) { state.edgesGroup.remove(edges); edges.geometry.dispose(); edges = null; }
    state.residentRects = state.tiles.residentRects();
    state.profileExtra = {
      tilesMs: state.profile.tiles || 0,
      renderMs: state.profile.render || 0,
      envRafFps: state.envRafFps || 0,
    };
    state.hud.render(
      { dist: state.dist, camera2d: state.camera2d, residentRects: state.residentRects, profile: state.profileExtra },
      state.tiles.getStats(),
      state.renderer,
      now
    );
    const st = state.tiles.getStats();
    document.getElementById('hKm').textContent = COPY.fmt.km(state.dist / 1000);
    document.getElementById('hSpeed').textContent = COPY.fmt.speed(state.bench.running ? state.bench.ctxSpeedKmh : state.speedKmh);
    document.getElementById('hAlt').textContent = COPY.fmt.meters(state.altitude);
    document.getElementById('hHeading').textContent = COPY.fmt.deg(state.camera2d.bearing);
  };
  requestAnimationFrame(loop);
  window.dispatchEvent(new Event('lod:ready'));
}

boot();

/** 测量浏览器 rAF 上限：判读帧率数字时必须知道环境上限 */
function measureRafCeiling(windowMs = 1500) {
  return new Promise((resolve) => {
    let n = 0;
    const t0 = performance.now();
    const step = () => {
      n++;
      const el = performance.now() - t0;
      if (el < windowMs) requestAnimationFrame(step);
      else resolve(n / (el / 1000));
    };
    requestAnimationFrame(step);
  });
}

// 自动化测试钩子
window.__lod = {
  state,
  stopLoop: () => { cancelAnimationFrame(state.rafId); state.loopStopped = true; },
  bench: () => state.bench,
  tiles: () => state.tiles,
  ctx: () => benchCtx(),
  startBench,
  setTilesVisible: (v) => {
    state.tiles.group.visible = v;
    state.tiles.skirtGroup.visible = v && state.options.skirt;
  },
  setBatchVisible: (z, v) => {
    const b = state.tiles.batches.get(Number(z));
    if (b) b.mesh.visible = v;
  },
  measure: (ms = 8000) =>
    new Promise((resolve) => {
      const frames = [];
      const t0 = performance.now();
      let last = t0;
      const step = (now) => {
        frames.push(now - last);
        last = now;
        if (now - t0 < ms) requestAnimationFrame(step);
        else resolve(frameStats(frames));
      };
      requestAnimationFrame(step);
    }),
};
