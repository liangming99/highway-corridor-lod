import { writeFileSync } from 'node:fs';
const R = 6378137;
const a = { lon: 110.10, lat: 25.62 };
const b = { lon: 110.92, lat: 25.06 };
const pts = [];
const steps = 520;
for (let i = 0; i <= steps; i++) {
  const t = i / steps;
  const bend = Math.sin(t * Math.PI) * 0.02;
  const lon = a.lon + (b.lon - a.lon) * t + bend * 0.6;
  const lat = a.lat + (b.lat - a.lat) * t - bend * 0.25;
  pts.push([+lon.toFixed(6), +lat.toFixed(6), 200]);
}
const rad = Math.PI / 180;
let len = 0;
for (let i = 1; i < pts.length; i++) {
  const dLat = (pts[i][1] - pts[i - 1][1]) * rad;
  const dLon = (pts[i][0] - pts[i - 1][0]) * rad;
  const x = Math.cos(((pts[i][1] + pts[i - 1][1]) / 2) * rad) * dLon;
  len += R * Math.hypot(dLat, x);
}
const lons = pts.map((p) => p[0]);
const lats = pts.map((p) => p[1]);
const out = {
  name: '开发用直线走廊（占位）',
  ref: 'DEV',
  lengthKm: +(len / 1000).toFixed(2),
  bufferMeters: 2500,
  points: pts,
  bbox: { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) },
  junctions: [],
  places: [],
  sources: '占位数据，等待真实走廊替换',
};
writeFileSync('data/corridor.dev.json', JSON.stringify(out));
console.log('dev corridor lengthKm', out.lengthKm, 'points', pts.length);
