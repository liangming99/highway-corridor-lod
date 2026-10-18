// tilemanager.js — 瓦片兴趣集、四叉树切割（LOD）、请求队列、预算与淘汰
// 两种渲染路径：mode='mesh' 逐瓦片网格（对照用）；mode='batch' 每层一个合批网格 + 分级图集
import * as THREE from 'three';
import { tileIndex, tileMeters, tileMetersAt, tileBoundsMeters, metersToLonLat } from './geo.js';
import { LevelAtlas } from './atlas.js';
import { LevelBatch } from './batch.js';

export const LEVELS = [11, 12, 13, 14, 15, 16];

const DEFAULTS = {
  mode: 'batch',
  bufferMeters: 2500,
  lodBias: 0,
  concurrency: 6,
  maxBuildsPerFrame: 3,
  texBudgetMB: 384,
  totalTileCap: 320,
  imgCap: 16,
  wantImagery: true,
  allowRemoteDem: true,
  useLocalDem: false,
  skirt: true,
  skirtDepth: 26,
  gridByLevel: { 11: 8, 12: 8, 13: 16, 14: 24, 15: 32, 16: 32 },
  thresholds: { 11: 40000, 12: 40000, 13: 15000, 14: 6200, 15: 2600, 16: 1100 },
  budgets: { 11: 16, 12: 32, 13: 26, 14: 22, 15: 16, 16: 16 },
};

const key = (z, x, y) => z + '/' + x + '/' + y;

export class TileManager {
  constructor({ scene, corridor, onEvent, renderer }) {
    this.scene = scene;
    this.corridor = corridor;
    this.renderer = renderer;
    this.onEvent = onEvent || (() => {});
    this.opts = { ...DEFAULTS };
    this.group = new THREE.Group();
    this.group.name = 'tiles';
    scene.add(this.group);
    this.skirtGroup = new THREE.Group();
    this.skirtGroup.name = 'skirts';
    scene.add(this.skirtGroup);

    this.workers = [];
    this.resident = new Map();
    this.desired = new Map();
    this.queue = [];
    this.inflight = new Map();
    this.ready = [];
    this.byLevel = new Map(LEVELS.map((z) => [z, []]));
    this.atlases = new Map();
    this.atlas = null;
    this.batches = new Map();
    this.stats = {
      built: 0, evictions: 0, staleDrops: 0, demFail: 0, imgFail: 0,
      demBytes: 0, imgBytes: 0, demTiles: 0, lastSelectMs: 0, lastPumpMs: 0,
      atlasWrites: 0, atlasFallback: 0,
      readyDrops: 0,
    };
    this.frame = 0;
    this.skirtMaterial = new THREE.MeshBasicMaterial({ color: 0x23282a });
    this.workerCount = 3;
    this._initWorkers(this.workerCount);
    this._initRenderPath();
    this.rebuildInterest();
  }

  _initWorkers(n) {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => this._onWorkerDone(ev.data);
      w.busy = false;
      this.workers.push(w);
    }
  }

  _initRenderPath() {
    // 清掉旧路径
    for (const k of [...this.resident.keys()]) this._dispose(k, true);
    for (const b of this.batches.values()) b.dispose(this.scene);
    if (this.atlas) this.atlas.dispose();
    for (const a of this.atlases.values()) a.dispose();
    this.atlases.clear();
    this.atlas = null;
    this.batches.clear();
    if (this.group) this.group.clear();
    if (this.skirtGroup) this.skirtGroup.clear();

    if (this.opts.mode === 'batch') {
      // 每层一张小图集：单张越小，整张上传的长任务越短
      for (const z of LEVELS) {
        const cap = this.opts.budgets[z];
        const grid = this.opts.gridByLevel[z];
        const vertsPerTile = (grid + 1) ** 2 + 4 * (grid + 1) * 2;
        const indexPerTile = grid * grid * 6 + 4 * grid * 6;
        const atlas = new LevelAtlas({ renderer: this.renderer, slots: cap, tier: z });
        const batch = new LevelBatch({
          scene: this.scene,
          capacity: cap,
          vertsPerTile,
          indexPerTile,
          atlas,
          material: new THREE.MeshLambertMaterial({ map: atlas.texture }),
          tier: z,
        });
        this.atlases.set(z, atlas);
        this.batches.set(z, batch);
      }
    }
  }

  setMode(mode) {
    if (this.opts.mode === mode) return;
    this.opts.mode = mode;
    this.queue = [];
    this.ready = [];
    this._initRenderPath();
  }

  setOptions(patch) {
    let rebuild = false;
    let modeChanged = false;
    for (const [k, v] of Object.entries(patch)) {
      if (this.opts[k] === v) continue;
      this.opts[k] = v;
      if (k === 'bufferMeters') rebuild = true;
      if (k === 'mode') modeChanged = true;
    }
    if (modeChanged) this.setMode(this.opts.mode);
    if (rebuild) this.rebuildInterest();
    if (patch.skirt !== undefined && this.skirtGroup) this.skirtGroup.visible = !!patch.skirt;
  }

  /** 各层兴趣集：走廊缓冲范围内的瓦片，并记录沿线里程 */
  rebuildInterest() {
    const t0 = performance.now();
    for (const z of LEVELS) this.byLevel.set(z, []);
    const nodes = this.corridor.nodes;
    const maps = new Map(LEVELS.map((z) => [z, new Map()]));
    for (const z of LEVELS) {
      const strideM = tileMetersAt(z, nodes[0].lat) / 2;
      let next = 0;
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.dist < next) continue;
        next = node.dist + strideM;
        const half = Math.ceil(this.opts.bufferMeters / tileMetersAt(z, node.lat));
        const t = tileIndex(node.lon, node.lat, z);
        const m = maps.get(z);
        for (let dx = -half; dx <= half; dx++) {
          for (let dy = -half; dy <= half; dy++) {
            const k = key(z, t.x + dx, t.y + dy);
            const prev = m.get(k);
            if (prev === undefined || node.dist < prev) m.set(k, node.dist);
          }
        }
      }
    }
    for (const z of LEVELS) {
      const list = [];
      for (const [k, dist] of maps.get(z)) {
        const [zz, xx, yy] = k.split('/').map(Number);
        const b = tileBoundsMeters(zz, xx, yy);
        const c = metersToLonLat((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        const l = this.corridor.toLocal(c.lon, c.lat);
        list.push({ z: zz, x: xx, y: yy, dist, cx: l.x, cz: l.z, size: b.x1 - b.x0 });
      }
      list.sort((a, b) => a.dist - b.dist);
      this.byLevel.set(z, list);
    }
    this.interestMs = performance.now() - t0;
  }

  _children(t) {
    const z = t.z + 1;
    const x = t.x * 2, y = t.y * 2;
    const out = [];
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) {
        const b = tileBoundsMeters(z, x + dx, y + dy);
        const c = metersToLonLat((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        const l = this.corridor.toLocal(c.lon, c.lat);
        out.push({ z, x: x + dx, y: y + dy, dist: t.dist, cx: l.x, cz: l.z, size: b.x1 - b.x0 });
      }
    }
    return out;
  }

  /** 四叉树切割：只在相机附近细分，保证同一地块只有一个层级被绘制 */
  select(cam) {
    const t0 = performance.now();
    const bias = 2 ** this.opts.lodBias;
    const desired = new Map();
    const walk = (t) => {
      const d = Math.hypot(t.cx - cam.x, t.cz - cam.z);
      const nextZ = t.z + 1;
      const threshold = this.opts.thresholds[nextZ] * bias;
      if (LEVELS.includes(nextZ) && d <= threshold) {
        for (const c of this._children(t)) walk(c);
      } else {
        const ahead = t.dist >= cam.dist;
        desired.set(key(t.z, t.x, t.y), {
          z: t.z, x: t.x, y: t.y, dist: t.dist, d,
          prio: d + (ahead ? 0 : 6000) + (t.z - 11) * 120,
          cx: t.cx, cz: t.cz, size: t.size,
        });
      }
    };
    const coarsest = this.byLevel.get(LEVELS[0]);
    if (coarsest) for (const t of coarsest) walk(t);
    this.desired = desired;
    this.stats.lastSelectMs = performance.now() - t0;
  }

  _frameParams() {
    return {
      lon0: this.corridor.origin.lon,
      lat0: this.corridor.origin.lat,
      mPerDegLon: this.corridor.mPerDegLon,
      mPerDegLat: this.corridor.mPerDegLat,
    };
  }

  _pump() {
    const t0 = performance.now();
    // 页面不可见时不派发：rAF 停摆时继续拉取只会堆内存
    if (typeof document !== 'undefined' && document.hidden) return;
    // 积压过多时暂停派发，等主线程追上来
    if (this.ready.length >= (this.readyCap || 12)) return;
    const queued = new Set(this.queue.map((q) => q.key));
    for (const [k, d] of this.desired) {
      if (this.resident.has(k) || this.inflight.has(k) || queued.has(k)) continue;
      this.queue.push({ key: k, ...d });
    }
    this.queue = this.queue.filter((q) => this.desired.has(q.key));
    this.queue.sort((a, b) => a.prio - b.prio);

    for (let wi = 0; wi < this.workers.length; wi++) {
      const w = this.workers[wi];
      if (w.busy) continue;
      if (this.inflight.size >= this.opts.concurrency) break;
      let job = null;
      let jobSlot = null;
      let atlasSlot = -1;
      let batchSlot = -1;
      // 最多轮转一遍候选：槽位不足时必须退出，不能原地打转
      let budget = this.queue.length;
      while (this.queue.length && budget-- > 0) {
        const cand = this.queue[0];
        if (this.opts.mode === 'batch') {
          const batch = this.batches.get(cand.z);
          const atlas = this.atlases.get(cand.z);
          const b = batch ? batch.acquire() : -1;
          const a = b >= 0 && atlas ? atlas.acquire(cand.key) : -1;
          if (a < 0 || b < 0) {
            // 该层或图集暂时没有空槽：释放已占的，换下一个候选
            if (a >= 0) atlas.release(a);
            if (b >= 0) batch.release(b);
            this.queue.shift();
            this.queue.push(cand);
            continue;
          }
          atlasSlot = a;
          batchSlot = b;
          jobSlot = atlas.uvRect(a);
          this.stats.slotsAcquired = (this.stats.slotsAcquired || 0) + 1;
        }
        job = this.queue.shift();
        break;
      }
      if (!job) break;
      w.busy = true;
      this.inflight.set(job.key, { ...job, atlasSlot, batchSlot, wid: wi });
      w.postMessage({
        id: job.key, z: job.z, x: job.x, y: job.y,
        wid: wi,
        gridSize: this.opts.gridByLevel[job.z] || 32,
        demZ: Math.min(15, Math.max(12, job.z)),
        allowRemote: this.opts.allowRemoteDem,
        wantImagery: this.opts.wantImagery,
        imgCap: this.opts.imgCap,
        useLocalDem: this.opts.useLocalDem,
        slot: jobSlot,
        frame: this._frameParams(),
        skirt: this.opts.skirt,
      });
    }
    this.stats.lastPumpMs = performance.now() - t0;
  }

  _onWorkerDone(res) {
    const wid = res.wid;
    if (typeof wid === 'number' && this.workers[wid]) this.workers[wid].busy = false;
    else for (const w of this.workers) if (w.busy) { w.busy = false; break; }
    const job = this.inflight.get(res.id);
    this.inflight.delete(res.id);
    if (!job) return;
    if (res.ok === false) {
      this.stats.demFail++;
      this.onEvent('demFail', res);
      this._releaseSlots(job);
      return;
    }
    if (res.imgError) {
      this.stats.imgFail++;
      this.onEvent('imgFail', res);
    }
    this.stats.demBytes += res.demBytes || 0;
    this.stats.imgBytes += res.imgBytes || 0;
    this.stats.demTiles = (this.stats.demTiles || 0) + (res.demTiles || 0);
    if (!this.desired.has(res.id)) {
      this.stats.staleDrops++;
      res.bitmap?.close?.();
      this._releaseSlots(job);
      return;
    }
    // 背压：主线程来不及消费时直接丢弃并回收位图，避免位图与队列无上限堆积
    if (this.ready.length >= (this.readyCap || 12)) {
      this.stats.readyDrops = (this.stats.readyDrops || 0) + 1;
      res.bitmap?.close?.();
      this._releaseSlots(job);
      return;
    }
    res.dist = job.dist;
    res.prio = job.prio;
    res.atlasSlot = job.atlasSlot;
    res.batchSlot = job.batchSlot;
    res.cx = job.cx;
    res.cz = job.cz;
    res.size = job.size;
    this.ready.push(res);
  }

  _releaseSlots(job) {
    const atlas = this.atlases.get(job.z);
    if (job.atlasSlot >= 0 && atlas) {
      atlas.release(job.atlasSlot);
      this.stats.slotsReleased = (this.stats.slotsReleased || 0) + 1;
    }
    if (job.batchSlot >= 0) {
      const b = this.batches.get(job.z);
      b && b.release(job.batchSlot);
    }
  }

  /** 逐瓦片路径：建网格 */
  buildMesh(res) {
    const N = res.gridSize + 1;
    const size = tileBoundsMeters(res.z, res.x, res.y);
    const stepX = (size.x1 - size.x0) / res.gridSize;
    const stepY = (size.y1 - size.y0) / res.gridSize;
    const wn = metersToLonLat(size.x0, size.y1);
    const es = metersToLonLat(size.x1, size.y0);
    const c0 = this.corridor.toLocal(wn.lon, wn.lat);
    const c1 = this.corridor.toLocal(es.lon, es.lat);
    const pos = new Float32Array(N * N * 3);
    const uv = new Float32Array(N * N * 2);
    for (let gy = 0; gy < N; gy++) {
      const fy = gy / res.gridSize;
      for (let gx = 0; gx < N; gx++) {
        const fx = gx / res.gridSize;
        const i = gy * N + gx;
        pos[i * 3] = c0.x + (c1.x - c0.x) * fx;
        pos[i * 3 + 1] = res.heights[i];
        pos[i * 3 + 2] = c0.z + (c1.z - c0.z) * fy;
        uv[i * 2] = fx;
        uv[i * 2 + 1] = 1 - fy;
      }
    }
    const idx = [];
    for (let gy = 0; gy < res.gridSize; gy++) {
      for (let gx = 0; gx < res.gridSize; gx++) {
        const a = gy * N + gx, b = a + 1, c = a + N, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    let material;
    if (res.bitmap) {
      const tex = new THREE.Texture(res.bitmap);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.maxAniso || 4;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.needsUpdate = true;
      material = new THREE.MeshLambertMaterial({ map: tex });
      res.texture = tex;
    } else {
      material = new THREE.MeshLambertMaterial({ color: 0x6f7a63 });
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.frustumCulled = true;
    mesh.userData.tile = { z: res.z, x: res.x, y: res.y };
    this.group.add(mesh);

    let skirtMesh = null;
    if (this.opts.skirt) {
      const sp = [], si = [];
      const depth = this.opts.skirtDepth;
      const pushStrip = (getter) => {
        const base = sp.length / 3;
        for (let i = 0; i < N; i++) {
          const v = getter(i);
          sp.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
          sp.push(pos[v * 3], pos[v * 3 + 1] - depth, pos[v * 3 + 2]);
        }
        for (let i = 0; i < N - 1; i++) {
          const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
          si.push(a, c, b, b, c, d);
        }
      };
      pushStrip((i) => i);
      pushStrip((i) => i + N * (N - 1));
      pushStrip((i) => i * N);
      pushStrip((i) => i * N + (N - 1));
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sp), 3));
      sg.setIndex(si);
      skirtMesh = new THREE.Mesh(sg, this.skirtMaterial);
      skirtMesh.frustumCulled = true;
      this.skirtGroup.add(skirtMesh);
    }

    const texBytes = res.bitmap ? 256 * 256 * 4 * 1.34 : 0;
    const geoBytes = pos.byteLength + uv.byteLength + idx.length * 4;
    const cx = (c0.x + c1.x) / 2;
    const cz = (c0.z + c1.z) / 2;
    return { mesh, skirtMesh, texBytes, geoBytes, texture: res.texture || null, z: res.z, dist: res.dist, cx, cz, size: Math.abs(c1.x - c0.x), halfSize: Math.abs(c1.x - c0.x) / 2 };
  }

  /** 合批路径：写进该层缓冲并更新图集 */
  writeBatch(res) {
    const batch = this.batches.get(res.z);
    const atlas = this.atlases.get(res.z);
    if (!batch || !atlas) return null;
    const ok = batch.write(res.batchSlot, {
      pos: res.pos, uv: res.uv, nrm: res.nrm, idx: res.idx,
      vTotal: res.vTotal, iTotal: res.iTotal,
    });
    if (res.bitmap) {
      const wrote = atlas.writeTile(res.atlasSlot, res.bitmap);
      this.stats.atlasWrites++;
      if (!wrote) this.stats.atlasFallback++;
    } else {
      atlas.release(res.atlasSlot);
      res.atlasSlot = -1;
    }
    const half = (res.size || 0) / 2;
    return {
      mesh: null, skirtMesh: null,
      texBytes: 0, geoBytes: 0, z: res.z, dist: res.dist,
      cx: res.cx, cz: res.cz, size: res.size, halfSize: half,
      ground: res.ground, groundN: 9, centerY: res.centerY,
      atlasSlot: res.atlasSlot, batchSlot: res.batchSlot, batched: true,
      ok,
    };
  }

  /** 供小地图绘制：常驻瓦片矩形 */
  residentRects() {
    const out = [];
    for (const r of this.resident.values()) out.push({ z: r.z, cx: r.cx, cz: r.cz, size: r.size });
    return out;
  }

  update(cam) {
    this.frame++;
    if (this.frame % 5 === 1) this.select(cam);
    this._pump();
    let built = 0;
    while (this.ready.length && built < this.opts.maxBuildsPerFrame) {
      const res = this.ready.shift();
      const k = res.id;
      if (!this.desired.has(k)) {
        this.stats.staleDrops++;
        this._releaseSlots({ z: res.z, atlasSlot: res.atlasSlot, batchSlot: res.batchSlot });
        continue;
      }
      const rec = this.opts.mode === 'batch' ? this.writeBatch(res) : this.buildMesh(res);
      if (!rec || rec.ok === false) {
        res.bitmap?.close?.();
        this._releaseSlots({ z: res.z, atlasSlot: res.atlasSlot, batchSlot: res.batchSlot });
        continue;
      }
      rec.lastUsed = this.frame;
      rec.key = k;
      this.resident.set(k, rec);
      this.stats.built++;
      built++;
    }
    if (this.opts.mode === 'batch') {
      for (const b of this.batches.values()) if (b.dirty) b.flush();
      // 每帧最多上传一张图集：把整张纹理上传的成本摊到多帧
      const now = performance.now();
      let uploaded = false;
      for (const z of LEVELS) {
        const a = this.atlases.get(z);
        if (!a) continue;
        const tU = performance.now();
        if (a.flush(now)) {
          const cost = performance.now() - tU;
          if (cost > (this.maxUploadMs || 0)) this.maxUploadMs = cost;
          const per = this.uploadMsByLevel || (this.uploadMsByLevel = {});
          per[z] = +((per[z] || 0) + cost).toFixed(1);
          uploaded = true; break;
        }
      }
    }
    this.evictIfNeeded(cam);
  }

  evictIfNeeded(cam) {
    for (const [k, r] of this.resident) {
      if (this.desired.has(k)) r.staleSince = 0;
      else if (!r.staleSince) r.staleSince = this.frame;
    }
    const grace = this.graceFrames || 45;
    for (const [k, r] of [...this.resident]) {
      if (r.staleSince && this.frame - r.staleSince > grace) {
        this._dispose(k);
        this.stats.evictions++;
        this.stats.staleEvicted = (this.stats.staleEvicted || 0) + 1;
      }
    }
    // 槽位压力：图集槽位耗尽且仍有瓦片待加载时，立即淘汰离相机最远的常驻瓦片
    if (this.opts.mode === 'batch') {
      let guard = 0;
      // 常驻下限：低于这个数量时不再按槽位压力淘汰，宁可暂时缺细节也别让画面空掉
      const minResident = Math.max(12, Math.round(this.opts.totalTileCap * 0.12));
      while (guard++ < 8) {
        const freeSlots = [...this.atlases.values()].reduce((s, a) => s + a.free.length, 0);
        if (freeSlots > 0) break;
        if (!this.queue.length) break;
        if (this.resident.size <= minResident) break;
        // 先淘汰不需要的；都还需要时，退而淘汰离相机最远的常驻瓦片
        let staleKey = null, staleDist = -Infinity;
        let anyKey = null, anyDist = -Infinity;
        for (const [k, r] of this.resident) {
          const d = Math.hypot(r.cx - cam.x, r.cz - cam.z);
          if (!this.desired.has(k) && d > staleDist) { staleDist = d; staleKey = k; }
          if (d > anyDist) { anyDist = d; anyKey = k; }
        }
        const worstKey = staleKey || anyKey;
        if (!worstKey) break;
        this._dispose(worstKey);
        this.stats.evictions++;
        this.stats.slotPressureEvicted = (this.stats.slotPressureEvicted || 0) + 1;
      }
      return;
    }
    const perLevel = {};
    for (const r of this.resident.values()) perLevel[r.z] = (perLevel[r.z] || 0) + 1;
    for (const z of Object.keys(this.opts.budgets)) {
      const budget = this.opts.budgets[z];
      let count = perLevel[z] || 0;
      if (count <= budget) continue;
      const list = [...this.resident.entries()].filter(([, r]) => r.z === Number(z));
      list.sort((a, b) => Math.hypot(b[1].cx - cam.x, b[1].cz - cam.z) - Math.hypot(a[1].cx - cam.x, a[1].cz - cam.z));
      for (const [k] of list) {
        if (count-- <= budget) break;
        this._dispose(k);
        this.stats.evictions++;
      }
    }
    const texBudget = this.opts.texBudgetMB * 1024 * 1024;
    let guard = 0;
    const bytes = () => [...this.resident.values()].reduce((s, r) => s + r.texBytes + r.geoBytes, 0);
    while ((this.resident.size > this.opts.totalTileCap || bytes() > texBudget) && guard++ < 64) {
      let worstKey = null, worstScore = -Infinity;
      for (const [k, r] of this.resident) {
        const stale = this.desired.has(k) ? 0 : 1;
        const age = this.frame - r.lastUsed;
        const score = stale * 1e6 + age + r.dist * 0.001 + (16 - r.z) * 30;
        if (score > worstScore) { worstScore = score; worstKey = k; }
      }
      if (!worstKey) break;
      this._dispose(worstKey);
      this.stats.evictions++;
    }
  }

  _dispose(k, silent) {
    const r = this.resident.get(k);
    if (!r) return;
    if (r.batched) {
      const b = this.batches.get(r.z);
      b && r.batchSlot >= 0 && b.release(r.batchSlot);
      const a = this.atlases.get(r.z);
      a && r.atlasSlot >= 0 && a.release(r.atlasSlot);
      this.stats.slotsReleased = (this.stats.slotsReleased || 0) + 1;
    } else {
      if (r.mesh) {
        this.group.remove(r.mesh);
        r.mesh.geometry.dispose();
        if (r.mesh.material.map) r.mesh.material.map.dispose();
        r.mesh.material.dispose();
      }
      if (r.skirtMesh) {
        this.skirtGroup.remove(r.skirtMesh);
        r.skirtMesh.geometry.dispose();
      }
    }
    this.resident.delete(k);
  }

  _disposeQuietly(k) {
    this.resident.delete(k);
  }

  clear() {
    for (const k of [...this.resident.keys()]) this._dispose(k);
    this.queue = [];
    this.ready = [];
    for (const b of this.batches.values()) if (b.dirty) b.flush();
  }

  /** 相机贴地：在常驻瓦片里找覆盖点，返回双线性高程；找不到返回 null */
  groundHeightAt(x, z) {
    const c = this.corridor;
    const lon = c.origin.lon + x / c.mPerDegLon;
    const lat = c.origin.lat - z / c.mPerDegLat;
    for (let i = LEVELS.length - 1; i >= 0; i--) {
      const lv = LEVELS[i];
      const t = tileIndex(lon, lat, lv);
      const rec = this.resident.get(key(lv, t.x, t.y));
      if (!rec || !rec.ground) continue;
      const fx = (x - (rec.cx - rec.halfSize)) / (rec.halfSize * 2);
      const fz = (z - (rec.cz - rec.halfSize)) / (rec.halfSize * 2);
      if (fx < 0 || fx > 1 || fz < 0 || fz > 1) continue;
      const n = rec.groundN;
      const px = fx * (n - 1), py = fz * (n - 1);
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
      const tx = px - x0, ty = py - y0;
      const g = rec.ground;
      const a = g[y0 * n + x0] * (1 - tx) + g[y0 * n + x1] * tx;
      const b = g[y1 * n + x0] * (1 - tx) + g[y1 * n + x1] * tx;
      return a * (1 - ty) + b * ty;
    }
    return null;
  }

  getStats() {
    const perLevel = {};
    for (const z of LEVELS) perLevel[z] = 0;
    let tex = 0, geo = 0;
    for (const r of this.resident.values()) {
      perLevel[r.z] = (perLevel[r.z] || 0) + 1;
      tex += r.texBytes || 0;
      geo += r.geoBytes || 0;
    }
    if (this.opts.mode === 'batch') {
      tex = 0;
      geo = 0;
      for (const a of this.atlases.values()) tex += a.width * a.height * 4 * 1.34;
      for (const b of this.batches.values()) {
        geo += b.position.byteLength + b.uv.byteLength + b.normal.byteLength + b.index.byteLength;
      }
    }
    return {
      mode: this.opts.mode,
      resident: this.resident.size,
      desired: this.desired.size,
      queue: this.queue.length,
      inflight: this.inflight.size,
      perLevel,
      texBytes: tex,
      geoBytes: geo,
      memMB: (tex + geo) / 1024 / 1024,
      built: this.stats.built,
      evictions: this.stats.evictions,
      staleDrops: this.stats.staleDrops,
      staleEvicted: this.stats.staleEvicted || 0,
      readyDrops: this.stats.readyDrops || 0,
      slotPressureEvicted: this.stats.slotPressureEvicted || 0,
      ready: this.ready.length,
      demFail: this.stats.demFail,
      imgFail: this.stats.imgFail,
      demMB: this.stats.demBytes / 1024 / 1024,
      imgMB: this.stats.imgBytes / 1024 / 1024,
      demTiles: this.stats.demTiles || 0,
      atlasWrites: this.stats.atlasWrites || 0,
      atlasUploads: [...this.atlases.values()].reduce((s, a) => s + a.uploadCount, 0),
      maxUploadMs: +(this.maxUploadMs || 0).toFixed(1),
      atlasFreePerLevel: Object.fromEntries([...this.atlases.entries()].map(([z, a]) => [z, a.free.length])),
      uploadMsByLevel: this.uploadMsByLevel || {},
      atlasSize: Object.fromEntries([...this.atlases.entries()].map(([z, a]) => [z, a.width])),
      atlasFallback: this.stats.atlasFallback || 0,
      slotsAcquired: this.stats.slotsAcquired || 0,
      slotsReleased: this.stats.slotsReleased || 0,
      lastSelectMs: this.stats.lastSelectMs,
      lastPumpMs: this.stats.lastPumpMs,
      interestMs: this.interestMs || 0,
      batches: this.batches.size,
    };
  }

  resetCounters() {
    for (const k of Object.keys(this.stats)) {
      if (typeof this.stats[k] === 'number' && k !== 'lastSelectMs' && k !== 'lastPumpMs') this.stats[k] = 0;
    }
  }
}
