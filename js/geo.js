// geo.js — 墨卡托与瓦片数学、走廊局部坐标系
export const R = 6378137;
export const ORIGIN = Math.PI * R; // 20037508.342789244

export function lonLatToMeters(lon, lat) {
  const x = (lon * ORIGIN) / 180;
  const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * (ORIGIN / 180);
  return { x, y };
}

export function metersToLonLat(x, y) {
  const lon = (x / ORIGIN) * 180;
  const lat = (2 * Math.atan(Math.exp((y / ORIGIN) * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
  return { lon, lat };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function tileIndex(lon, lat, z) {
  const n = 2 ** z;
  const m = lonLatToMeters(lon, lat);
  const x = Math.floor(((m.x + ORIGIN) / (2 * ORIGIN)) * n);
  const y = Math.floor(((ORIGIN - m.y) / (2 * ORIGIN)) * n);
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) };
}

export const TILE_PX = 256;

/** 墨卡托下每瓦片边长（米，赤道） */
export function tileMeters(z) {
  return (2 * ORIGIN) / 2 ** z;
}

/** 指定纬度处每瓦片边长（米） */
export function tileMetersAt(z, lat) {
  return tileMeters(z) * Math.cos((lat * Math.PI) / 180);
}

export function tileBoundsMeters(z, x, y) {
  const size = tileMeters(z);
  return {
    x0: -ORIGIN + x * size,
    x1: -ORIGIN + (x + 1) * size,
    y0: ORIGIN - (y + 1) * size,
    y1: ORIGIN - y * size,
  };
}

export function haversine(lon1, lat1, lon2, lat2) {
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lon1, lat1, lon2, lat2) {
  const p = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * p) * Math.cos(lat2 * p);
  const x = Math.cos(lat1 * p) * Math.sin(lat2 * p) - Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos((lon2 - lon1) * p);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * 走廊局部坐标系：原点取走廊起点，X 向东，Z 向南（北为 -Z），Y 为高程。
 * 100 km 跨度在 float32 下精度约 0.01 m，够用。
 */
export function buildCorridor(raw) {
  const pts = raw.points.map((p) => ({ lon: p[0], lat: p[1], ele: p[2] ?? 0 }));
  const origin = pts[0];
  const mPerDegLon = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const mPerDegLat = 110540;
  let dist = 0;
  const nodes = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) dist += haversine(pts[i - 1].lon, pts[i - 1].lat, p.lon, p.lat);
    nodes.push({
      lon: p.lon,
      lat: p.lat,
      ele: p.ele,
      dist,
      x: (p.lon - origin.lon) * mPerDegLon,
      z: -(p.lat - origin.lat) * mPerDegLat,
    });
  }
  const stepDist = [];
  for (let i = 0; i < nodes.length; i++) stepDist.push(nodes[i].dist);

  function sampleAt(d) {
    const total = nodes[nodes.length - 1].dist;
    const dd = clamp(d, 0, total);
    let lo = 0,
      hi = nodes.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (nodes[mid].dist <= dd) lo = mid;
      else hi = mid;
    }
    const a = nodes[lo],
      b = nodes[Math.min(nodes.length - 1, lo + 1)];
    const span = Math.max(1e-6, b.dist - a.dist);
    const t = (dd - a.dist) / span;
    return {
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      ele: a.ele + (b.ele - a.ele) * t,
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
      bearing: bearingDeg(a.lon, a.lat, b.lon, b.lat),
      dist: dd,
    };
  }

  return {
    raw,
    nodes,
    stepDist,
    totalMeters: nodes[nodes.length - 1].dist,
    origin,
    mPerDegLon,
    mPerDegLat,
    sampleAt,
    toLocal(lon, lat) {
      return { x: (lon - origin.lon) * mPerDegLon, z: -(lat - origin.lat) * mPerDegLat };
    },
    toLonLat(x, z) {
      return { lon: origin.lon + x / mPerDegLon, lat: origin.lat - z / mPerDegLat };
    },
  };
}
