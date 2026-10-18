// bridge.js — 柳江二桥 GLB 构件级加载、点选与视角聚焦
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js';
import { COPY } from './copy.js';

// 构件 → 业务属性（与台账编号一致）
export const BRIDGE_PARTS = {
  girder: { name: '主梁（钢箱梁）', zh: '主梁', group: '上部结构' },
  deck: { name: '桥面铺装', zh: '铺装', group: '附属工程' },
  markings: { name: '车道标线与分隔带', zh: '标线', group: '附属工程' },
  railings: { name: '防撞护栏', zh: '护栏', group: '附属工程' },
  pylonA: { name: '桥塔 A（左侧主塔）', zh: '桥塔A', group: '下部结构' },
  pylonB: { name: '桥塔 B（右侧主塔）', zh: '桥塔B', group: '下部结构' },
  cables: { name: '斜拉索（双索面）', zh: '斜拉索', group: '上部结构' },
  piers: { name: '桥墩、承台与桩基', zh: '墩台', group: '下部结构' },
  abutments: { name: '桥台', zh: '桥台', group: '下部结构' },
};

const PART_KEYS = Object.keys(BRIDGE_PARTS);
const PART_KEY = (name) => {
  const n = name.replace(/^BR0768_/, '');
  return PART_KEYS.includes(n) ? n : null;
};

export class BridgeModel {
  constructor({ scene, renderer }) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = 'BR-0768';
    this.group.visible = false;
    scene.add(this.group);
    this.parts = new Map();
    this.pickTargets = [];
    this.loaded = false;
    this.loading = null;
    this.selected = null;
    this.highlightMat = new THREE.MeshBasicMaterial({
      color: 0xff8a3d, transparent: true, opacity: 0.42, depthWrite: false,
    });
    this.highlightMesh = null;
  }

  /** 加载 GLB；失败时返回 false，调用方可退回示意模型 */
  async load(url = 'assets/bridge/liujiang_bridge.glb') {
    if (this.loaded) return true;
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          const rootOb = gltf.scene;
          rootOb.updateMatrixWorld(true);
          rootOb.traverse((o) => {
            if (!o.isMesh) return;
            const key = PART_KEY(o.name);
            if (!key) return;
            // 统一材质：保留 GLB 的 PBR，但补上环境反射
            o.material.envMapIntensity = 1.15;
            o.material.needsUpdate = true;
            o.userData.part = key;
            o.castShadow = true;
            o.receiveShadow = true;
            this.parts.set(key, o);
            this.pickTargets.push(o);
          });
          this.group.add(rootOb);
          this.root = rootOb;
          this.loaded = true;
          this.loading = null;
          resolve(true);
        },
        undefined,
        () => {
          this.loading = null;
          resolve(false);
        },
      );
    });
    return this.loading;
  }

  show(v) {
    this.group.visible = !!v;
  }

  /** 把模型摆到世界坐标：position 为中心，bearingDeg 为桥轴方位 */
  place(position, bearingDeg = 0, scale = 1) {
    this.group.position.copy(position);
    this.group.rotation.y = (-bearingDeg * Math.PI) / 180;
    this.group.scale.setScalar(scale);
  }

  /** 返回构件的世界包围盒（用于聚焦相机） */
  partBounds(key) {
    const ob = this.parts.get(key);
    if (!ob) return null;
    const box = new THREE.Box3().setFromObject(ob);
    return box.isEmpty() ? null : box;
  }

  pick(raycaster) {
    if (!this.group.visible) return null;
    const hits = raycaster.intersectObjects(this.pickTargets, false);
    if (!hits.length) return null;
    return hits[0].object.userData.part;
  }

  select(key) {
    this.selected = key;
    if (this.highlightMesh) {
      this.group.remove(this.highlightMesh);
      this.highlightMesh.geometry.dispose();
      this.highlightMesh = null;
    }
    const ob = this.parts.get(key);
    if (!ob) return;
    const clone = new THREE.Mesh(ob.geometry, this.highlightMat);
    clone.matrixAutoUpdate = false;
    clone.matrix.copy(ob.matrixWorld);
    clone.matrixWorldNeedsUpdate = true;
    this.highlightMesh = clone;
    this.scene.add(clone);
  }

  clearSelection() {
    this.selected = null;
    if (this.highlightMesh) {
      this.scene.remove(this.highlightMesh);
      this.highlightMesh.geometry.dispose();
      this.highlightMesh = null;
    }
  }

  /** 构件级实时指标：按构件类型给出不同量测 */
  partMetrics(key, nowMs) {
    const t = nowMs / 1000;
    const seed = key.charCodeAt(0) * 1.7 + key.length;
    const wave = (a, amp, base, p) => base + amp * Math.sin(t / p + seed) + amp * 0.3 * Math.sin(t / (p * 0.4) + seed * 3);
    switch (key) {
      case 'girder':
        return [
          { label: COPY.bridge.m.girderDeflect, value: wave(1, 2.1, 18.4, 13), unit: 'mm', limit: 32 },
          { label: COPY.bridge.m.girderStress, value: wave(2, 6.5, 148, 17), unit: 'MPa', limit: 210 },
          { label: COPY.bridge.m.girderTemp, value: wave(3, 1.1, 28.6, 29), unit: '°C', limit: null },
        ];
      case 'pylonA':
      case 'pylonB':
        return [
          { label: COPY.bridge.m.towerTilt, value: wave(1, 0.012, 0.031, 23), unit: '°', limit: 0.08 },
          { label: COPY.bridge.m.towerVib, value: wave(2, 0.22, 0.62, 9), unit: 'mm/s', limit: 1.6 },
          { label: COPY.bridge.m.towerTemp, value: wave(3, 1.4, 27.1, 31), unit: '°C', limit: null },
        ];
      case 'cables':
        return [
          { label: COPY.bridge.m.cableForce, value: wave(1, 210, 6420, 11), unit: 'kN', limit: 8200 },
          { label: COPY.bridge.m.cableFreq, value: wave(2, 0.07, 1.42, 7), unit: 'Hz', limit: null },
          { label: COPY.bridge.m.cableCorrosion, value: wave(3, 0.6, 2.4, 41), unit: '%', limit: 8 },
        ];
      case 'piers':
        return [
          { label: COPY.bridge.m.pierSettle, value: wave(1, 0.9, 3.2, 47), unit: 'mm', limit: 12 },
          { label: COPY.bridge.m.pierSway, value: wave(2, 0.3, 1.1, 15), unit: 'cm', limit: 3 },
          { label: COPY.bridge.m.pierScour, value: wave(3, 0.25, 0.8, 37), unit: 'm', limit: 2.5 },
        ];
      case 'deck':
        return [
          { label: COPY.bridge.m.deckIRI, value: wave(1, 0.35, 2.15, 19), unit: 'm/km', limit: 5 },
          { label: COPY.bridge.m.deckTemp, value: wave(2, 1.6, 31.2, 23), unit: '°C', limit: null },
          { label: COPY.bridge.m.deckSkid, value: wave(3, 3.5, 42, 31), unit: 'BPN', limit: 35, invert: true },
        ];
      case 'railings':
        return [
          { label: COPY.bridge.m.railImpact, value: wave(1, 1.4, 6.2, 43), unit: '次/月', limit: 12 },
          { label: COPY.bridge.m.railHeight, value: wave(2, 0.03, 1.12, 53), unit: 'm', limit: null },
        ];
      default:
        return [
          { label: COPY.bridge.m.defectIndex, value: wave(1, 1.2, 6.4, 29), unit: '', limit: 15 },
          { label: COPY.bridge.m.envTemp, value: wave(2, 1.2, 26.8, 27), unit: '°C', limit: null },
        ];
    }
  }
}
