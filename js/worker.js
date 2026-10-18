// worker.js — 瓦片构建：拉取高程与影像、采样成规则网格、在 worker 内装配几何
import { ORIGIN, TILE_PX, tileIndex, tileBoundsMeters, metersToLonLat } from './geo.js';

// worker 脚本位于 js/ 下，本地高程缓存用相对脚本的路径解析
const DEM_LOCAL = (z, x, y) => `../data/dem/${z}/${x}/${y}.png`;
const DEM_REMOTE = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const IMG_REMOTE = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

const demCache = new Map();
const DEM_CACHE_MAX = 96;

async function loadDemTile(z, x, y, allowRemote, useLocal) {
  const k = z + '/' + x + '/' + y;
  const hit = demCache.get(k);
  if (hit) {
    demCache.delete(k);
    demCache.set(k, hit);
    return hit;
  }
  let blob = null;
  let src = 'local';
  if (useLocal) {
    try {
      const r = await fetch(DEM_LOCAL(z, x, y));
      if (r.ok) blob = await r.blob();
    } catch (e) {
      /* 本地缓存缺失：回退远端 */
    }
  }
  if (!blob && allowRemote) {
    src = 'remote';
    const r = await fetch(DEM_REMOTE(z, x, y));
    if (!r.ok) throw new Error('dem-status-' + r.status);
    blob = await r.blob();
  }
  if (!blob) throw new Error('dem-missing');
  const bytes = blob.size;
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
  const heights = new Float32Array(TILE_PX * TILE_PX);
  for (let i = 0; i < heights.length; i++) {
    const o = i * 4;
    heights[i] = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
  }
  bmp.close?.();
  const rec = { heights, bytes, src };
  demCache.set(k, rec);
  if (demCache.size > DEM_CACHE_MAX) demCache.delete(demCache.keys().next().value);
  return rec;
}

function sampleBilinear(tile, px, py) {
  const x = Math.max(0, Math.min(TILE_PX - 1.001, px));
  const y = Math.max(0, Math.min(TILE_PX - 1.001, py));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const h = tile.heights;
  const i0 = y0 * TILE_PX + x0;
  const i1 = i0 + TILE_PX;
  const a = h[i0] * (1 - fx) + h[i0 + 1] * fx;
  const b = h[i1] * (1 - fx) + h[i1 + 1] * fx;
  return a * (1 - fy) + b * fy;
}

async function elevationGrid(z, x, y, gridSize, demZ, allowRemote, useLocal) {
  const n = 2 ** demZ;
  const size = tileBoundsMeters(z, x, y);
  const stepX = (size.x1 - size.x0) / gridSize;
  const stepY = (size.y1 - size.y0) / gridSize;
  const heights = new Float32Array((gridSize + 1) * (gridSize + 1));
  let demBytes = 0;
  const cx = (size.x0 + size.x1) / 2;
  const cy = (size.y0 + size.y1) / 2;
  const tx0 = Math.floor(((cx + ORIGIN) / (2 * ORIGIN)) * n);
  const ty0 = Math.floor(((ORIGIN - cy) / (2 * ORIGIN)) * n);
  const tile = await loadDemTile(demZ, tx0, ty0, allowRemote, useLocal);
  demBytes += tile.bytes;
  let min = Infinity, max = -Infinity;
  for (let gy = 0; gy <= gridSize; gy++) {
    const my = size.y1 - gy * stepY;
    for (let gx = 0; gx <= gridSize; gx++) {
      const mx = size.x0 + gx * stepX;
      const px = Math.max(0, Math.min(TILE_PX - 1, (((mx + ORIGIN) / (2 * ORIGIN)) * n - tx0) * TILE_PX));
      const py = Math.max(0, Math.min(TILE_PX - 1, (((ORIGIN - my) / (2 * ORIGIN)) * n - ty0) * TILE_PX));
      const ele = sampleBilinear(tile, px, py);
      heights[gy * (gridSize + 1) + gx] = ele;
      if (ele < min) min = ele;
      if (ele > max) max = ele;
    }
  }
  return { heights, demBytes, min, max, demTiles: 1, demSrc: tile.src };
}

/** 在 worker 内装配几何：位置、UV（按图集槽位换算）、法线、索引（含裙边） */
function assembleGeometry(z, x, y, gridSize, heights, slot, frame, skirtDepth) {
  const N = gridSize + 1;
  const size = tileBoundsMeters(z, x, y);
  const stepX = (size.x1 - size.x0) / gridSize;
  const stepY = (size.y1 - size.y0) / gridSize;
  const wn = metersToLonLat(size.x0, size.y1);
  const es = metersToLonLat(size.x1, size.y0);
  const lon0 = frame.lon0, lat0 = frame.lat0;
  const mx = frame.mPerDegLon, my = frame.mPerDegLat;
  const c0x = (wn.lon - lon0) * mx, c0z = -(wn.lat - lat0) * my;
  const c1x = (es.lon - lon0) * mx, c1z = -(es.lat - lat0) * my;
  const cellLocal = Math.abs(c1x - c0x) / gridSize;

  const edgeVerts = 4 * N;
  const vTotal = N * N + edgeVerts * 2;
  const pos = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const nrm = new Float32Array(vTotal * 3);

  const u0 = slot.u0, u1 = slot.u1, v0 = slot.v0, v1 = slot.v1;
  for (let gy = 0; gy < N; gy++) {
    const fz = gy / gridSize;
    for (let gx = 0; gx < N; gx++) {
      const fx = gx / gridSize;
      const i = gy * N + gx;
      pos[i * 3] = c0x + (c1x - c0x) * fx;
      pos[i * 3 + 1] = heights[i];
      pos[i * 3 + 2] = c0z + (c1z - c0z) * fz;
      uv[i * 2] = u0 + (u1 - u0) * fx;
      uv[i * 2 + 1] = v0 + (v1 - v0) * fz;
      // 法线：对高程网格做中心差分
      const xm = gx > 0 ? i - 1 : i, xp = gx < gridSize ? i + 1 : i;
      const ym = gy > 0 ? i - N : i, yp = gy < gridSize ? i + N : i;
      const dsx = (gx > 0 && gx < gridSize ? 2 : 1) * cellLocal;
      const dsz = (gy > 0 && gy < gridSize ? 2 : 1) * cellLocal;
      const dhdx = (heights[xp] - heights[xm]) / dsx;
      const dhdz = (heights[yp] - heights[ym]) / dsz;
      const len = Math.hypot(dhdx, 1, dhdz) || 1;
      nrm[i * 3] = -dhdx / len;
      nrm[i * 3 + 1] = 1 / len;
      nrm[i * 3 + 2] = -dhdz / len;
    }
  }

  // 裙边：四条边各复制一排顶点并下沉
  let v = N * N;
  const edges = [
    { get: (i) => i, n: (i) => (i === 0 ? -1 : i === N - 1 ? 1 : 0) },
    { get: (i) => (N - 1) * N + i, n: () => 1 },
    { get: (i) => i * N, n: () => -1 },
    { get: (i) => i * N + (N - 1), n: () => 1 },
  ];
  const skirtStart = v;
  for (const e of edges) {
    for (let k = 0; k < N; k++) {
      const src = e.get(k);
      pos[v * 3] = pos[src * 3];
      pos[v * 3 + 1] = pos[src * 3 + 1] - skirtDepth;
      pos[v * 3 + 2] = pos[src * 3 + 2];
      uv[v * 2] = uv[src * 2];
      uv[v * 2 + 1] = uv[src * 2 + 1];
      nrm[v * 3] = nrm[src * 3];
      nrm[v * 3 + 1] = nrm[src * 3 + 1];
      nrm[v * 3 + 2] = nrm[src * 3 + 2];
      v++;
    }
  }

  const faceCount = gridSize * gridSize * 2 + 4 * gridSize * 2;
  const idx = new Uint32Array(faceCount * 3);
  let p = 0;
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const a = gy * N + gx, b = a + 1, c = a + N, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
  }
  for (let e = 0; e < 4; e++) {
    const base = skirtStart + e * N;
    for (let k = 0; k < N - 1; k++) {
      const a = base + k, b = a + 1, c = a + N, d = c + 1;
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
  }

  return { pos, uv, nrm, idx, vTotal, iTotal: p };
}

async function assemble(job) {
  const { id, z, x, y, gridSize, demZ, allowRemote, wantImagery, imgCap, useLocalDem, slot, frame, skirt, wid } = job;
  const out = { id, wid, z, x, y, gridSize, ok: true, transfer: [] };
  let heights;
  try {
    const dem = await elevationGrid(z, x, y, gridSize, demZ, allowRemote, useLocalDem);
    heights = dem.heights;
    out.demBytes = dem.demBytes;
    out.demTiles = dem.demTiles;
    out.elevMin = dem.min;
    out.elevMax = dem.max;
    out.demSrc = dem.demSrc;
  } catch (err) {
    out.ok = false;
    out.error = 'dem:' + String(err && err.message ? err.message : err);
    return out;
  }
  // 9×9 降采样高程，供相机贴地
  const gs = 9;
  const ground = new Float32Array(gs * gs);
  const N = gridSize + 1;
  for (let gy = 0; gy < gs; gy++) {
    for (let gx = 0; gx < gs; gx++) {
      const sx = Math.round((gx / (gs - 1)) * gridSize);
      const sy = Math.round((gy / (gs - 1)) * gridSize);
      ground[gy * gs + gx] = heights[sy * N + sx];
    }
  }
  out.ground = ground;
  out.transfer.push(ground.buffer);
  out.centerY = heights[Math.floor(heights.length / 2)];

  if (skirt !== false && slot && frame) {
    const geo = assembleGeometry(z, x, y, gridSize, heights, slot, frame, 26);
    out.pos = geo.pos;
    out.uv = geo.uv;
    out.nrm = geo.nrm;
    out.idx = geo.idx;
    out.vTotal = geo.vTotal;
    out.iTotal = geo.iTotal;
    out.transfer.push(geo.pos.buffer, geo.uv.buffer, geo.nrm.buffer, geo.idx.buffer);
  }
  if (wantImagery) {
    const iz = Math.min(z, imgCap);
    const n = 2 ** iz;
    const nb = tileBoundsMeters(z, x, y);
    const ix = Math.floor((((nb.x0 + nb.x1) / 2 + ORIGIN) / (2 * ORIGIN)) * n);
    const iy = Math.floor(((ORIGIN - (nb.y0 + nb.y1) / 2) / (2 * ORIGIN)) * n);
    try {
      const r = await fetch(IMG_REMOTE(iz, ix, iy));
      if (!r.ok) throw new Error('img-status-' + r.status);
      const blob = await r.blob();
      const bmp = await createImageBitmap(blob);
      out.bitmap = bmp;
      out.imgBytes = blob.size;
      out.imgZ = iz;
      out.transfer.push(bmp);
    } catch (err) {
      out.imgError = String(err && err.message ? err.message : err);
    }
  }
  return out;
}

self.onmessage = async (ev) => {
  const payload = await assemble(ev.data);
  self.postMessage(payload, payload.transfer || []);
};
