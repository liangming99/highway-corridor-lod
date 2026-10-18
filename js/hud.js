// hud.js — 帧率面板、帧时间曲线、小地图、基准记录
import { COPY } from './copy.js';

const LEVEL_COLORS = { 11: '#5b6b8c', 12: '#3f7f9c', 13: '#2f9e8f', 14: '#6aa84f', 15: '#d0a73a', 16: '#e2683c' };

export class Hud {
  constructor({ corridor }) {
    this.corridor = corridor;
    this.frames = [];
    this.maxFrames = 300;
    this.lastRender = 0;
    this.graph = document.getElementById('frameGraph');
    this.gctx = this.graph ? this.graph.getContext('2d') : null;
    this.minimap = document.getElementById('minimap');
    this.mctx = this.minimap ? this.minimap.getContext('2d') : null;
    this.metrics = {};
  }

  frame(dtMs) {
    this.frames.push(dtMs);
    if (this.frames.length > this.maxFrames) this.frames.shift();
  }

  percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[i];
  }

  summary(frames) {
    const arr = (frames && frames.length ? frames : this.frames).slice().sort((a, b) => a - b);
    if (!arr.length) return { avg: 0, fps: 0, p50: 0, p95: 0, low1: 0, max: 0 };
    const sum = arr.reduce((s, v) => s + v, 0);
    const avg = sum / arr.length;
    const worst = arr.slice(Math.floor(arr.length * 0.99));
    const low1Avg = worst.length ? worst.reduce((s, v) => s + v, 0) / worst.length : avg;
    return {
      avg,
      fps: 1000 / avg,
      p50: this.percentile(arr, 50),
      p95: this.percentile(arr, 95),
      low1: low1Fps(low1Avg),
      max: arr[arr.length - 1],
    };
  }

  render(state, stats, renderer, now) {
    if (now - this.lastRender < 200) return;
    this.lastRender = now;
    const s = this.summary();
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    set('mFps', COPY.fmt.fps(s.fps));
    set('mP50', COPY.fmt.ms(s.p50));
    set('mP95', COPY.fmt.ms(s.p95));
    set('mLow1', COPY.fmt.fps(s.low1));
    set('mDraw', COPY.fmt.count(renderer.info.render.calls));
    set('mTris', renderer.info.render.triangles.toLocaleString('en-US'));
    set('mResident', COPY.fmt.count(stats.resident));
    set('mQueue', COPY.fmt.count(stats.queue) + ' / ' + COPY.fmt.count(stats.inflight));
    set('mTexMB', COPY.fmt.mb(stats.memMB));
    set('mNet', COPY.fmt.mb(stats.demMB + stats.imgMB));
    set('mEvict', COPY.fmt.count(stats.evictions));
    set('mStale', COPY.fmt.count(stats.staleDrops));
    set('mBuilt', COPY.fmt.count(stats.built));
    set('mMode', stats.mode === 'batch' ? COPY.hud.modeBatch : COPY.hud.modeMesh);
    set('mDemTiles', COPY.fmt.count(stats.demTiles || 0));
    if (state.profile) {
      set('mStageTiles', COPY.fmt.ms(state.profile.tilesMs));
      set('mStageRender', COPY.fmt.ms(state.profile.renderMs));
      if (state.profile.envRafFps) set('mEnvCap', COPY.fmt.fps(state.profile.envRafFps) + ' fps');
      set('mMainMs', COPY.fmt.ms((state.profile.tilesMs || 0) + (state.profile.renderMs || 0)));
    }
    const lv = Object.entries(stats.perLevel)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => 'z' + k + ':' + v)
      .join('  ');
    set('mLevels', lv || '—');
    set('mDist', COPY.fmt.km(state.dist / 1000));
    this.drawGraph();
    this.drawMinimap(state);
  }

  drawGraph() {
    if (!this.gctx) return;
    const c = this.graph;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = this.gctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, 0, w, h);
    const budget = 16.7, scale = 40; // 毫秒满刻度
    const y0 = h - (budget / scale) * h;
    ctx.strokeStyle = 'rgba(120,220,140,0.6)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.stroke();
    ctx.setLineDash([]);
    const n = this.frames.length;
    const bw = Math.max(1, w / this.maxFrames);
    for (let i = 0; i < n; i++) {
      const v = Math.min(scale, this.frames[i]);
      const bh = (v / scale) * h;
      const x = i * bw;
      ctx.fillStyle = this.frames[i] > 33 ? '#e2481f' : this.frames[i] > 16.7 ? '#e0a53a' : 'rgba(120,190,255,0.85)';
      ctx.fillRect(x, h - bh, Math.max(1, bw - 0.5), bh);
    }
  }

  drawMinimap(state) {
    if (!this.mctx) return;
    const c = this.minimap;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = this.mctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(18,22,26,0.85)';
    ctx.fillRect(0, 0, w, h);
    const nodes = this.corridor.nodes;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of nodes) {
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.z < minZ) minZ = n.z;
      if (n.z > maxZ) maxZ = n.z;
    }
    const pad = 8;
    const sx = (w - pad * 2) / Math.max(1, maxX - minX);
    const sz = (h - pad * 2) / Math.max(1, maxZ - minZ);
    const scl = Math.min(sx, sz);
    const ox = pad + ((w - pad * 2) - (maxX - minX) * scl) / 2;
    const oz = pad + ((h - pad * 2) - (maxZ - minZ) * scl) / 2;
    const px = (x) => ox + (x - minX) * scl;
    const pz = (z) => oz + (z - minZ) * scl;
    for (const r of state.residentRects || []) {
      const half = (r.size * scl) / 2;
      ctx.fillStyle = LEVEL_COLORS[r.z] || '#888';
      ctx.globalAlpha = 0.5;
      ctx.fillRect(px(r.cx) - half, pz(r.cz) - half, Math.max(1.5, half * 2), Math.max(1.5, half * 2));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    nodes.forEach((n, i) => (i === 0 ? ctx.moveTo(px(n.x), pz(n.z)) : ctx.lineTo(px(n.x), pz(n.z))));
    ctx.stroke();
    const cam = state.camera2d;
    if (cam) {
      ctx.fillStyle = '#ff8a3d';
      ctx.beginPath();
      ctx.arc(px(cam.x), pz(cam.z), 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ff8a3d';
      ctx.beginPath();
      ctx.moveTo(px(cam.x), pz(cam.z));
      const a = (cam.bearing * Math.PI) / 180;
      ctx.lineTo(px(cam.x) + Math.sin(a) * 14, pz(cam.z) - Math.cos(a) * 14);
      ctx.stroke();
    }
  }
}

/** 判定：环境 rAF 上限足够时按 P95 判；否则按应用主线程每帧耗时判 */
function verdictOf(p95, envFps, mainMs, baselineP95) {
  // 环境能跑满 60：直接看帧时间
  if (envFps >= 55 && baselineP95 <= 25) return p95 <= 16.7 ? 'pass' : p95 <= 25 ? 'warn' : 'fail';
  // 环境本身抖动或不达 60：改用主线程每帧耗时判定
  return mainMs <= 8 ? 'pass' : mainMs <= 14 ? 'warn' : 'fail';
}

function low1Fps(avgMs) {
  return avgMs > 0 ? 1000 / avgMs : 0;
}

/** 基准记录：A 巡航 / B 高吞吐流式 / C 跳转重载 */
export class Bench {
  constructor({ onProgress, onDone }) {
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.running = false;
    this.results = [];
  }

  start(mode, ctx) {
    this.mode = mode;
    this.frames = [];
    this.baselineFrames = [];
    this.phase = 'baseline';
    this.phaseT0 = performance.now();
    this.t0 = performance.now();
    this.lastJump = 0;
    this.running = true;
    this.startDist = ctx.state.dist;
    this.viewport = ctx.viewportInfo();
    this.settings = ctx.settingsSnapshot();
    this.ctx = ctx;
    ctx.setTilesVisible(false);
  }

  stop() {
    this.running = false;
  }

  tick(now, dtMs, ctx) {
    if (!this.running) return;
    if (this.phase === 'baseline') {
      this.baselineFrames.push(dtMs);
      if ((now - this.phaseT0) / 1000 >= 3) {
        this.phase = 'run';
        this.t0 = now;
        this.frames = [];
        ctx.setTilesVisible(true);
        ctx.tiles.clear();
        ctx.tiles.resetCounters();
        // 计数快照必须在清空之后取，否则增量会变成负数
        this.startCounters = { ...ctx.tiles.stats };
      }
      return;
    }
    this.frames.push(dtMs);
    this.mainSamples = this.mainSamples || [];
    const pr = ctx.state.profile || {};
    this.mainSamples.push((pr.tiles || 0) + (pr.render || 0));
    const elapsed = (now - this.t0) / 1000;
    if (this.mode.jumpKm && elapsed - this.lastJump >= this.mode.jumpEverySec) {
      this.lastJump = elapsed;
      const total = ctx.corridor.totalMeters;
      ctx.state.dist = (ctx.state.dist + this.mode.jumpKm * 1000) % total;
    }
    this.onProgress && this.onProgress(COPY.bench.running, elapsed, this.mode.durationSec);
    if (elapsed >= this.mode.durationSec) this.finish(ctx);
  }

  finish(ctx) {
    this.running = false;
    // 冷启动段（基准开头，清空瓦片并复位里程）不进入帧时间统计
    const warmCount = Math.min(60, Math.floor(this.frames.length / 3));
    const warm = this.frames.slice(0, warmCount);
    const s = summarize(this.frames.slice(warmCount));
    const mainTail = (this.mainSamples || []).slice(warmCount);
    const base = frameStats(this.baselineFrames);
    const st = ctx.tiles.stats;
    const d = (k) => Math.round((st[k] || 0) - (this.startCounters[k] || 0));
    const durationSec = (performance.now() - this.t0) / 1000;
    const rec = {
      name: this.mode.name,
      durationSec: +durationSec.toFixed(1),
      distanceKm: +((ctx.state.dist - this.startDist) / 1000).toFixed(2),
      frames: this.frames.length,
      avgFps: +s.fps.toFixed(1),
      frameMs: { p50: +s.p50.toFixed(2), p95: +s.p95.toFixed(2), max: +s.max.toFixed(2) },
      low1Fps: +s.low1.toFixed(1),
      built: d('built'),
      evictions: d('evictions'),
      staleDrops: d('staleDrops'),
      demFail: d('demFail'),
      imgFail: d('imgFail'),
      downloadedMB: +(((st.demBytes - this.startCounters.demBytes) + (st.imgBytes - this.startCounters.imgBytes)) / 1048576).toFixed(1),
      memoryMB: +ctx.tiles.getStats().memMB.toFixed(1),
      resident: ctx.tiles.getStats().resident,
      viewport: this.viewport,
      settings: this.settings,
      envRafFps: +(ctx.state.envRafFps || 0).toFixed(1),
      mainThreadMs: +mean(mainTail).toFixed(2),
      mainThreadP95Ms: +p95(mainTail).toFixed(2),
      warmupMaxMs: +(warm.length ? Math.max(...warm) : 0).toFixed(1),
      baseline: { p50: base.p50, p95: base.p95, fps: base.fps, frames: base.count },
      limitedByEnvironment: (ctx.state.envRafFps || 0) > 0 && ctx.state.envRafFps < 55,
      verdict: verdictOf(s.p95, Math.max(ctx.state.envRafFps || 0, base.fps || 0), mean(mainTail), base.p95),
    };
    this.results.push(rec);
    this.onDone && this.onDone(rec);
  }

  toJSON() {
    return { generatedAt: new Date().toISOString(), results: this.results };
  }
}

export function frameStats(frames) {
  const arr = frames.slice().sort((a, b) => a - b);
  if (!arr.length) return { avg: 0, fps: 0, p50: 0, p95: 0, low1: 0, max: 0 };
  const sum = arr.reduce((s, v) => s + v, 0);
  const avg = sum / arr.length;
  const worst = arr.slice(Math.floor(arr.length * 0.99));
  const low1Avg = worst.length ? worst.reduce((s, v) => s + v, 0) / worst.length : avg;
  const pick = (p) => arr[Math.min(arr.length - 1, Math.max(0, Math.round((p / 100) * (arr.length - 1))))];
  return {
    avg: +avg.toFixed(2), fps: +(1000 / avg).toFixed(1),
    p50: +pick(50).toFixed(2), p95: +pick(95).toFixed(2), p99: +pick(99).toFixed(2),
    low1Fps: +(low1Avg > 0 ? 1000 / low1Avg : 0).toFixed(1),
    max: +arr[arr.length - 1].toFixed(2), count: arr.length,
  };
}

function summarize(frames) {
  const s = frameStats(frames);
  return { avg: s.avg, fps: s.fps, p50: s.p50, p95: s.p95, low1: s.low1Fps, max: s.max };
}

function mean(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function p95(arr) {
  if (!arr || !arr.length) return 0;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.round(0.95 * (a.length - 1)))];
}
