// batch.js — 每层一个合批网格：固定容量顶点缓冲 + 槽位分配 + 局部上传
import * as THREE from 'three';

export class LevelBatch {
  /**
   * vertsPerTile / indexPerTile: 单瓦片（含裙边）的顶点与索引数量
   * capacity: 该层最多同时驻留的瓦片数
   */
  constructor({ scene, capacity, vertsPerTile, indexPerTile, atlas, material, tier }) {
    this.capacity = capacity;
    this.vertsPerTile = vertsPerTile;
    this.indexPerTile = indexPerTile;
    this.atlas = atlas;
    this.tier = tier;
    this.slotTiles = new Array(capacity).fill(null);
    this.pending = { vMin: Infinity, vMax: -Infinity, iMin: Infinity, iMax: -Infinity };

    const vTotal = capacity * vertsPerTile;
    this.position = new Float32Array(vTotal * 3);
    this.uv = new Float32Array(vTotal * 2);
    this.normal = new Float32Array(vTotal * 3);
    this.index = new Uint32Array(capacity * indexPerTile);

    const geo = new THREE.BufferGeometry();
    this.attrPos = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrUv = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.attrNrm = new THREE.BufferAttribute(this.normal, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrIdx = new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.attrPos);
    geo.setAttribute('uv', this.attrUv);
    geo.setAttribute('normal', this.attrNrm);
    geo.setIndex(this.attrIdx);
    geo.setDrawRange(0, 0);
    // 包围球一次性给足：整层始终参与绘制，不做视锥剔除
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e7);
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'batch-' + tier;
    scene.add(this.mesh);
    this.free = [];
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
    this.dirty = false;
    this.used = 0;
  }

  acquire() {
    return this.free.length ? this.free.pop() : -1;
  }

  release(slotIdx) {
    if (slotIdx < 0 || slotIdx >= this.capacity) return;
    const i0 = slotIdx * this.indexPerTile;
    this.index.fill(0, i0, i0 + this.indexPerTile);
    this.slotTiles[slotIdx] = null;
    this.free.push(slotIdx);
    this._markIndex(i0, i0 + this.indexPerTile);
    this.dirty = true;
  }

  _markVertex(vStart, vEnd) {
    if (vStart < this.pending.vMin) this.pending.vMin = vStart;
    if (vEnd > this.pending.vMax) this.pending.vMax = vEnd;
  }

  _markIndex(iStart, iEnd) {
    if (iStart < this.pending.iMin) this.pending.iMin = iStart;
    if (iEnd > this.pending.iMax) this.pending.iMax = iEnd;
  }

  /** 写入一块瓦片的几何；返回是否成功 */
  write(slotIdx, { pos, uv, nrm, idx, vTotal, iTotal }) {
    if (slotIdx < 0 || slotIdx >= this.capacity) return false;
    if (vTotal > this.vertsPerTile || iTotal > this.indexPerTile) return false;
    const v0 = slotIdx * this.vertsPerTile;
    const base = v0 * 3;
    this.position.set(pos, base);
    this.normal.set(nrm, base);
    this.uv.set(uv, v0 * 2);
    const i0 = slotIdx * this.indexPerTile;
    for (let k = 0; k < iTotal; k++) this.index[i0 + k] = idx[k] + v0;
    this.index.fill(0, i0 + iTotal, i0 + this.indexPerTile);
    this.slotTiles[slotIdx] = true;
    // 只登记本次改动涉及的顶点与索引区间
    this._markVertex(v0, v0 + this.vertsPerTile);
    this._markIndex(i0, i0 + this.indexPerTile);
    this.dirty = true;
    return true;
  }

  /** 只上传改动过的区间：避免整层缓冲重传 */
  flush() {
    if (!this.dirty) return;
    const p = this.pending;
    if (p.vMin !== Infinity) {
      const vCount = p.vMax - p.vMin;
      this.attrPos.addUpdateRange(p.vMin * 3, vCount * 3);
      this.attrNrm.addUpdateRange(p.vMin * 3, vCount * 3);
      this.attrUv.addUpdateRange(p.vMin * 2, vCount * 2);
      this.attrPos.needsUpdate = true;
      this.attrNrm.needsUpdate = true;
      this.attrUv.needsUpdate = true;
    }
    if (p.iMin !== Infinity) {
      this.attrIdx.addUpdateRange(p.iMin, p.iMax - p.iMin);
      this.attrIdx.needsUpdate = true;
    }
    this.pending = { vMin: Infinity, vMax: -Infinity, iMin: Infinity, iMax: -Infinity };
    const used = this.capacity - this.free.length;
    if (used !== this.used) {
      this.used = used;
      this.geometry.setDrawRange(0, this.capacity * this.indexPerTile);
    }
    this.dirty = false;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.geometry.dispose();
  }
}
