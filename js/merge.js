// merge.js — 把一组多材质网格合并成单网格（顶点色），用于压 draw call
import * as THREE from 'three';

/**
 * 合并 group 下所有 Mesh 的几何到单个 BufferGeometry，颜色写入顶点色。
 * 返回 { geometry, assetIds }，assetIds 记录每个顶点所属的结构物编号。
 */
export function mergeGroupByColor(group) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let vOffset = 0;
  const tmpColor = new THREE.Color();

  group.updateMatrixWorld(true);
  group.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const geo = obj.geometry;
    const pos = geo.attributes.position;
    if (!pos) return;
    const nrm = geo.attributes.normal;
    const mat = obj.material;
    tmpColor.set(mat && mat.color ? mat.color : 0xffffff);
    const m = obj.matrixWorld;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      positions.push(v.x, v.y, v.z);
      if (nrm) {
        n.fromBufferAttribute(nrm, i).transformDirection(m);
        normals.push(n.x, n.y, n.z);
      } else {
        normals.push(0, 1, 0);
      }
      colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
    }
    const idx = geo.index;
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vOffset);
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(i + vOffset);
    }
    vOffset += pos.count;
  });

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  out.setIndex(indices);
  out.computeBoundingSphere();
  return out;
}
