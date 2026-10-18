// assets.js — 高速结构物：程序化模型（桥梁 / 隧道 / 互通 / 服务区）与本地业务数据
// 结构物沿走廊按里程分布，几何按类型程序化生成，避免外部模型依赖。
import * as THREE from 'three';

export const ASSET_TYPES = {
  bridge: { label: '桥梁', color: 0x8fa3ad, icon: 'B' },
  tunnel: { label: '隧道', color: 0x6b7280, icon: 'T' },
  interchange: { label: '互通', color: 0xd9a641, icon: 'J' },
  service: { label: '服务区', color: 0x5f9e6e, icon: 'S' },
};

/**
 * 生成长度沿路线方向的构件盒。
 * 局部坐标：x 向东、z 向南；roadBearing 为该段方位（度，正北为 0）。
 */
function orientedBox(w, h, d, color) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshLambertMaterial({ color });
  return new THREE.Mesh(geo, mat);
}

/** 桥：桥面 + 两个桥墩 + 护栏 */
export function buildBridge({ span = 240, width = 26, height = 28, bearing = 0 }) {
  const g = new THREE.Group();
  const deckH = 3;
  const deck = orientedBox(span, deckH, width, 0x9aa7ae);
  deck.position.y = height;
  g.add(deck);
  const railMat = new THREE.MeshLambertMaterial({ color: 0xd6dee2 });
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 1.6, 1.1), railMat);
    rail.position.set(0, height + deckH / 2 + 0.8, (side * width) / 2);
    g.add(rail);
  }
  const pierMat = new THREE.MeshLambertMaterial({ color: 0x7b8489 });
  const piers = Math.max(2, Math.round(span / 90));
  for (let i = 0; i < piers; i++) {
    const t = (i + 0.5) / piers - 0.5;
    const pier = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 5.6, height, 10), pierMat);
    pier.position.set(t * span * 0.86, height / 2, 0);
    g.add(pier);
  }
  g.rotation.y = bearing;
  return g;
}

/** 隧道：洞口门框 + 洞内暗块 */
export function buildTunnel({ length = 900, width = 24, height = 16, bearing = 0 }) {
  const g = new THREE.Group();
  const shellMat = new THREE.MeshLambertMaterial({ color: 0x5c646a });
  const tube = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), shellMat);
  tube.position.y = height / 2;
  g.add(tube);
  const portalMat = new THREE.MeshLambertMaterial({ color: 0xb8bfc4 });
  for (const s of [-1, 1]) {
    const portal = new THREE.Mesh(new THREE.BoxGeometry(6, height + 4, width + 6), portalMat);
    portal.position.set((s * length) / 2, (height + 4) / 2, 0);
    g.add(portal);
  }
  // 洞门内的暗色开口，强化“可进入”的观感
  const mouthMat = new THREE.MeshBasicMaterial({ color: 0x14181b });
  for (const s of [-1, 1]) {
    const mouth = new THREE.Mesh(new THREE.PlaneGeometry(width * 0.8, height * 0.8), mouthMat);
    mouth.position.set((s * length) / 2 + s * 3.1, height / 2, 0);
    mouth.rotation.y = s * Math.PI / 2;
    g.add(mouth);
  }
  g.rotation.y = bearing;
  return g;
}

/** 互通：四条匝道 + 中心环岛 */
export function buildInterchange({ radius = 150, bearing = 0 }) {
  const g = new THREE.Group();
  const roadMat = new THREE.MeshLambertMaterial({ color: 0x6f7a80 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 8, 8, 40), roadMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 1.5;
  g.add(ring);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(radius * 1.5, 2.4, 12), roadMat);
    ramp.position.set(Math.cos(a) * radius * 0.75, 2, Math.sin(a) * radius * 0.75);
    ramp.rotation.y = -a;
    g.add(ramp);
  }
  g.rotation.y = bearing;
  return g;
}

/** 服务区：两栋楼 + 停车坪 */
export function buildService({ size = 160, bearing = 0 }) {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(size, 1.2, size * 0.7),
    new THREE.MeshLambertMaterial({ color: 0x8d9499 }),
  );
  g.add(pad);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xd9d3c6 });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x8a5a45 });
  for (const s of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(size * 0.4, 16, size * 0.28), wallMat);
    b.position.set(s * size * 0.22, 8, -size * 0.1);
    g.add(b);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(size * 0.44, 2.5, size * 0.32), roofMat);
    roof.position.set(s * size * 0.22, 17, -size * 0.1);
    g.add(roof);
  }
  g.rotation.y = bearing;
  return g;
}

export function buildAsset(spec) {
  const opts = { bearing: spec.bearing || 0 };
  switch (spec.type) {
    case 'bridge':
      return buildBridge({ ...opts, span: spec.span || 240, width: spec.width || 26, height: spec.height || 30 });
    case 'tunnel':
      return buildTunnel({ ...opts, length: spec.length || 900, width: spec.width || 24, height: spec.height || 16 });
    case 'interchange':
      return buildInterchange({ ...opts, radius: spec.radius || 150 });
    case 'service':
      return buildService({ ...opts, size: spec.size || 160 });
    default:
      return new THREE.Group();
  }
}

/** 由走廊数据与固定种子生成结构物清单（里程、类型、净空、车道数等） */
export function makeAssetList(corridor) {
  const total = corridor.totalMeters;
  const specs = [
    { km: 6.2, type: 'bridge', name: '洛清江特大桥', span: 320, height: 34, lanes: 4 },
    { km: 17.8, type: 'interchange', name: '鹿寨北互通', radius: 160 },
    { km: 28.4, type: 'tunnel', name: '古亭山隧道', length: 1080, height: 16 },
    { km: 39.1, type: 'bridge', name: '黄冕高架桥', span: 260, height: 26, lanes: 4 },
    { km: 47.6, type: 'service', name: '黄冕服务区', size: 170 },
    { km: 58.9, type: 'tunnel', name: '雒容隧道', length: 760, height: 15 },
    { km: 67.3, type: 'interchange', name: '雒容北枢纽', radius: 180 },
    { km: 76.8, type: 'bridge', name: '柳江二桥', span: 420, height: 38, lanes: 6 },
    { km: 88.2, type: 'tunnel', name: '白山隧道', length: 620, height: 15 },
    { km: 94.5, type: 'service', name: '柳州东服务区', size: 150 },
  ];
  const out = [];
  for (const s of specs) {
    const dist = Math.min(total - 50, s.km * 1000);
    const p = corridor.sampleAt(dist);
    out.push({
      ...s,
      id: 'A' + String(out.length + 1).padStart(2, '0'),
      dist,
      x: p.x,
      z: p.z,
      ele: p.ele,
      bearing: (p.bearing * Math.PI) / 180,
    });
  }
  return out;
}
