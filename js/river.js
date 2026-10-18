
import * as THREE from 'three';

/** 桥位处的河水与河岸：只在构件模式显示 */
export function buildRiver(center, bearingDeg) {
  const g = new THREE.Group();
  const size = 1500;
  const waterGeo = new THREE.PlaneGeometry(size, size, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d4a56, roughness: 0.22, metalness: 0.15,
    transparent: true, opacity: 0.9,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(center.x, center.y - 175, center.z);
  g.add(water);

  // 引道仅在桥端附近露出水面，避免大片硬边地形抢画面
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x2f3a2a, roughness: 0.96 });
  const rad = (-bearingDeg * Math.PI) / 180;
  for (const s of [-1, 1]) {
    const bank = new THREE.Mesh(new THREE.BoxGeometry(520, 8, 420), bankMat);
    const off = 1180 * s;
    bank.position.set(
      center.x + Math.cos(rad) * off,
      center.y - 168,
      center.z - Math.sin(rad) * off,
    );
    bank.rotation.y = rad;
    g.add(bank);
  }
  g.name = 'BR-0768 river';
  return { group: g, water };
}

