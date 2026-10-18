// atlas.js — 共享图集：一张画布纹理承载所有层级的瓦片影像
// 使用 Canvas 上传路径（Three 自己管理 GL 状态），上传按时间限流，避免卡顿。
import * as THREE from 'three';

const SLOT_PX = 256;
const GUTTER = 4;
const PITCH = SLOT_PX + GUTTER;

export class SharedAtlas {
  constructor({ renderer, cols = 8 }) {
    this.renderer = renderer;
    this.cols = cols;
    this.rows = cols;
    this.slots = cols * cols;
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
    renderer.initTexture(tex);
    this.texture = tex;

    this.free = [];
    for (let i = this.slots - 1; i >= 0; i--) this.free.push(i);
    this.ownerOf = new Array(this.slots).fill(null);
    this.dirty = false;
    this.lastUpload = 0;
    this.uploadCount = 0;
  }

  get capacity() {
    return this.slots;
  }

  acquire(owner) {
    if (!this.free.length) return -1;
    const slot = this.free.pop();
    this.ownerOf[slot] = owner || null;
    return slot;
  }

  release(slot) {
    if (slot < 0 || slot >= this.slots) return;
    this.ownerOf[slot] = null;
    this.free.push(slot);
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

  /** 把瓦片影像画进槽位；不立即上传，等 flush() */
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

  /** 限流上传：默认最短 250 ms 一次，避免每帧重传整张图集 */
  flush(now, minIntervalMs = 250) {
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
