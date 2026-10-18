// atlas.js — 每层一张小图集：槽位拼图 + 分帧限流上传
// 单张图集越小，整张上传的长任务越短；每帧最多上传一张。
import * as THREE from 'three';

const SLOT_PX = 256;
const GUTTER = 4;
const PITCH = SLOT_PX + GUTTER;

export class LevelAtlas {
  constructor({ renderer, slots, tier }) {
    this.renderer = renderer;
    this.tier = tier;
    const cols = Math.max(1, Math.ceil(Math.sqrt(slots)));
    this.cols = cols;
    this.rows = cols;
    this.slots = slots;
    this.width = cols * PITCH;
    this.height = cols * PITCH;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.ctx.fillStyle = '#3b4a3a';
    this.ctx.fillRect(0, 0, this.width, this.height);

    const tex = new THREE.CanvasTexture(this.canvas);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    try { renderer.initTexture(tex); } catch (e) { /* 已初始化 */ }
    this.texture = tex;

    this.free = [];
    for (let i = slots - 1; i >= 0; i--) this.free.push(i);
    this.dirty = false;
    this.uploadCount = 0;
    this.lastUpload = 0;
  }

  get capacity() {
    return this.slots;
  }

  acquire() {
    return this.free.length ? this.free.pop() : -1;
  }

  release(slot) {
    if (slot >= 0 && slot < this.slots) this.free.push(slot);
  }

  uvRect(slot) {
    const col = slot % this.cols;
    const row = Math.floor(slot / this.cols);
    const x = col * PITCH;
    const y = row * PITCH;
    const eps = 0.5;
    return {
      px: x, py: y,
      u0: (x + eps) / this.width,
      u1: (x + SLOT_PX - eps) / this.width,
      v0: (y + eps) / this.height,
      v1: (y + SLOT_PX - eps) / this.height,
    };
  }

  writeTile(slot, bitmap) {
    if (slot < 0 || slot >= this.slots) return false;
    const r = this.uvRect(slot);
    try {
      this.ctx.drawImage(bitmap, r.px, r.py, SLOT_PX, SLOT_PX);
    } catch (e) {
      return false;
    }
    bitmap.close?.();
    this.dirty = true;
    return true;
  }

  /** 由调度器按帧调用；单张图集最少间隔 minIntervalMs */
  flush(now, minIntervalMs = 180) {
    if (!this.dirty) return false;
    if (now - this.lastUpload < minIntervalMs) return false;
    this.texture.needsUpdate = true;
    this.dirty = false;
    this.lastUpload = now;
    this.uploadCount++;
    return true;
  }

  dispose() {
    this.texture.dispose();
  }
}
