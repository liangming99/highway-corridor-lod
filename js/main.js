// main.js — 场景、相机、界面绑定与渲染循环
import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { COPY } from './copy.js';
import { buildCorridor } from './geo.js';
import { TileManager } from './tilemanager.js';
import { Hud, Bench } from './hud.js';
import { AssetPanel } from './assetpanel.js';
import { BridgePanel } from './bridgepanel.js';
import { buildRiver } from './river.js';
import { frameStats } from './hud.js';

window.addEventListener('error', (e) => {
  (window.__errs = window.__errs || []).push(String((e && e.message) || e));
});
// 长任务监测：漫游卡顿时可查到主线程被什么拖住
window.__longTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__longTasks.push({
        d: Math.round(e.duration),
        at: Math.round(e.startTime),
        attribution: (e.attribution || []).map((a) => ({ name: a.name, type: a.entryType, container: a.containerType, src: a.containerSrc })),
      });
    }
  }).observe({ entryTypes: ['longtask'] });
} catch (e) { /* 浏览器不支持则不采集 */ }
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
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 0.8;
  controls.minDistance = 90;
  controls.maxDistance = 9000;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.enabled = false;
  state.controls = controls;
}

function updateCamera(dt) {
  const c = state.corridor;
  const camera = state.camera;
  // 桥梁构件模式：相机由轨道控制驱动，不跟走廊里程
  if (state.bridgeMode) {
    if (state.controls) {
      // 构件选中后把轨道中心移到该构件
      if (state.bridgeFocus) state.controls.target.copy(state.bridgeFocus);
      state.controls.update();
    }
    return;
  }
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
    if (e.key.toLowerCase() === 'b') {
      if (state.bridgeMode) exitBridge(); else enterBridge();
    }
    if (e.key === 'Escape' && state.bridgeMode) exitBridge();
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


/** 进入桥梁构件模式：隐藏地形瓦片，把相机对到桥 */
function enterBridge() {
  const bp = state.bridgePanel;
  if (!bp) { toast(COPY.bridge.title + ' 模型未加载'); return; }
  state.bridgeMode = true;
  bp.setVisible(true);
  if (state.controls) state.controls.enabled = true;
  document.getElementById('assetPanel').hidden = true;
  state.tiles.group.visible = false;
  state.tiles.skirtGroup.visible = false;
  if (state.assetPanel) state.assetPanel.group.visible = false;
  if (state.bridgeRiver) state.bridgeRiver.group.visible = true;
  state.playing = false;
  const anchor = state.bridgeAnchor.clone();
  const cam = state.camera;
  // 按模型包围盒自动取景：832 m 长的桥需要约 1.6 km 视距才能整幅入画
  const box = new THREE.Box3();
  if (state.bridgePanel && state.bridgePanel.model) {
    box.setFromObject(state.bridgePanel.model.group);
  }
  const size = box.isEmpty() ? new THREE.Vector3(800, 150, 60) : box.getSize(new THREE.Vector3());
  const center = box.isEmpty() ? anchor.clone() : box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.62;
  const fov = (cam.fov * Math.PI) / 180;
  // 视距按最长边装框，再留 25% 余量
  const distance = (radius / Math.tan(fov / 2)) * 0.95;
  // 侧前方 25° 俯视：能同时看到桥面、两座塔与索面
  const dir = new THREE.Vector3(0.30, 0.26, 0.92).normalize();
  if (state.controls) {
    state.controls.target.copy(center);
    state.controls.enabled = true;
  }
  cam.position.copy(center.clone().addScaledVector(dir, distance));
  cam.lookAt(center);
  cam.far = Math.max(cam.far, distance * 4);
  cam.updateProjectionMatrix();
  if (state.controls) state.controls.update();
  document.getElementById('minimapWrap').hidden = true;
  document.querySelector('.panel').hidden = true;
  document.querySelector('.hud').hidden = true;
  toast(COPY.bridge.title + ' · 构件模式');
}

/** 退出桥梁模式，回到走廊漫游 */
function exitBridge() {
  if (!state.bridgeMode) return;
  state.bridgeMode = false;
  state.bridgePanel.setVisible(false);
  if (state.controls) state.controls.enabled = false;
  document.getElementById('minimapWrap').hidden = false;
  document.querySelector('.panel').hidden = false;
  document.querySelector('.hud').hidden = false;
  document.getElementById('assetPanel').hidden = false;
  state.tiles.group.visible = true;
  state.tiles.skirtGroup.visible = !!state.options.skirt;
  if (state.assetPanel) state.assetPanel.group.visible = true;
  if (state.bridgeRiver) state.bridgeRiver.group.visible = false;
  toast(COPY.bridge.title + ' · 已退出');
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
    onReady: () => {},
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
  state.assetPanel = new AssetPanel({
    scene: state.scene,
    camera: state.camera,
    canvas: state.renderer.domElement,
    corridor: state.corridor,
    tiles: state.tiles,
    state,
    onLocate: (asset) => {
      state.dist = asset.dist;
      const p = state.corridor.sampleAt(asset.dist);
      state.altitude = Math.max(260, Math.min(700, state.altitude));
    },
  });
  state.assetPanel.onToast = toast;
  // 桥梁构件模式：加载 Blender 导出的 GLB
  const bridgeAsset = state.assetPanel.assets.find((a) => a.type === 'bridge' && a.span >= 400);
  if (bridgeAsset) {
    const bp = new BridgePanel({
      scene: state.scene,
      camera: state.camera,
      canvas: state.renderer.domElement,
      renderer: state.renderer,
      state,
      onChanged: (ev) => {
        if (ev.toast) toast(ev.toast);
        if (ev.focus) state.bridgeFocus = ev.focus;
      },
    });
    const ground = state.tiles.groundHeightAt(bridgeAsset.x, bridgeAsset.z);
    const baseY = ground != null ? ground : bridgeAsset.ele;
    const ok = await bp.init({
      position: new THREE.Vector3(bridgeAsset.x, baseY, bridgeAsset.z),
      bearingDeg: (bridgeAsset.bearing * 180) / Math.PI,
    });
    if (ok) {
      state.bridgePanel = bp;
      state.bridgeAnchor = new THREE.Vector3(bridgeAsset.x, baseY + 60, bridgeAsset.z);
      const river = buildRiver(state.bridgeAnchor, (bridgeAsset.bearing * 180) / Math.PI);
      river.group.visible = false;
      state.scene.add(river.group);
      state.bridgeRiver = river;
      document.getElementById('bridgeExit').addEventListener('click', () => exitBridge());
      document.getElementById('bridgeOpenBtn').addEventListener('click', () => enterBridge());
    }
  }

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
    // 慢帧归因：记录每段的耗时，便于定位卡顿来源
    if (dtMs > 300) {
      (window.__slowFrames = window.__slowFrames || []).push({
        at: Math.round(now), dt: Math.round(dtMs),
        tiles: +(state.profile?.tiles || 0).toFixed(1),
        render: +(state.profile?.render || 0).toFixed(1),
        res: state.tiles ? state.tiles.getStats().resident : -1,
        queue: state.tiles ? state.tiles.getStats().queue : -1,
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
      });
      if (window.__slowFrames.length > 40) window.__slowFrames.shift();
    }
    const dt = dtMs / 1000;
    const t0 = performance.now();
    updateCamera(dt);
    if (!document.hidden && !state.bridgeMode) {
      state.tiles.update({ x: state.camera.position.x, z: state.camera.position.z, dist: state.dist });
    }
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
    if (state.assetPanel) state.assetPanel.followSelection();
    const st = state.tiles.getStats();
    document.getElementById('hKm').textContent = COPY.fmt.km(state.dist / 1000);
    document.getElementById('hSpeed').textContent = COPY.fmt.speed(state.bench.running ? state.bench.ctxSpeedKmh : state.speedKmh);
    document.getElementById('hAlt').textContent = COPY.fmt.meters(state.altitude);
    document.getElementById('hHeading').textContent = COPY.fmt.deg(state.camera2d.bearing);
  };
  requestAnimationFrame(loop);
  window.dispatchEvent(new Event('lod:ready'));
  // 环境反射延后生成：首帧后渲染器状态才完整
  setTimeout(() => {
    try {
      const pmrem = new THREE.PMREMGenerator(state.renderer);
      const envScene = new THREE.Scene();
      const skyGeo = new THREE.SphereGeometry(5000, 32, 16);
      const colors = [];
      const pos = skyGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const t = Math.max(0, Math.min(1, pos.getY(i) / 5000 * 0.5 + 0.5));
        colors.push(0.30 + 0.44 * t, 0.44 + 0.36 * t, 0.58 + 0.26 * t);
      }
      skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      envScene.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
      state.envMap = pmrem.fromScene(envScene, 0.05).texture;
      state.scene.environment = state.envMap;
    } catch (e) {
      (window.__errs = window.__errs || []).push('envmap: ' + String(e && e.message));
    }
  }, 600);
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
  /** E2E 采样：状态 + 堆 + 长任务 */
  sample: () => {
    const st = state.tiles ? state.tiles.getStats() : null;
    const mem = performance.memory;
    return {
      t: Math.round(performance.now()),
      dist: Math.round(state.dist),
      resident: st ? st.resident : -1,
      desired: st ? st.desired : -1,
      queue: st ? st.queue : -1,
      inflight: st ? st.inflight : -1,
      built: st ? st.built : -1,
      evictions: st ? st.evictions : -1,
      stale: st ? st.staleDrops : -1,
      slotsFree: state.tiles && state.tiles.atlas ? state.tiles.atlas.free.length : -1,
      atlasSlotsFree: state.tiles && state.tiles.atlases
        ? [...state.tiles.atlases.values()].reduce((s, a) => s + a.free.length, 0)
        : -1,
      slotsAcquired: st ? st.slotsAcquired : -1,
      slotsReleased: st ? st.slotsReleased : -1,
      ready: st ? st.ready : -1,
      readyDrops: st ? st.readyDrops : -1,
      assetMeshes: (() => {
        let n = 0;
        state.scene.traverse((o) => { if (o.isMesh && o.userData && o.userData.assetId) n++; });
        return n;
      })(),
      memMB: st ? +st.memMB.toFixed(1) : -1,
      draws: state.renderer.info.render.calls,
      tris: state.renderer.info.render.triangles,
      heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : -1,
      heapLimitMB: mem ? +(mem.jsHeapSizeLimit / 1048576).toFixed(1) : -1,
      atlasUploads: st ? st.atlasUploads : -1,
      longTasks: (window.__longTasks || []).length,
      longestTask: (window.__longTasks || []).reduce((m, x) => Math.max(m, x.d), 0),
      slowFrames: (window.__slowFrames || []).slice(-6),
      uploadMsByLevel: st ? st.uploadMsByLevel : {},
      atlasSize: st ? st.atlasSize : {},
      maxUploadMs: st ? st.maxUploadMs : -1,
      errs: (window.__errs || []).length,
    };
  },
};
