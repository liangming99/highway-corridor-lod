// assetpanel.js — 结构物的三维模型、点选、详情、实时数据与工单流程
import * as THREE from 'three';
import { COPY } from './copy.js';
import { ASSET_TYPES, buildAsset, makeAssetList } from './assets.js';
import { mergeGroupByColor } from './merge.js';
import {
  sampleTelemetry, gradeMetric, assetHealth,
  loadWorkOrders, saveWorkOrders, createWorkOrder, advanceWorkOrder,
} from './ops.js';

const TYPE_COLOR = {
  bridge: '#8fa3ad',
  tunnel: '#8b939b',
  interchange: '#d9a641',
  service: '#5f9e6e',
};

export class AssetPanel {
  constructor({ scene, camera, canvas, corridor, tiles, state, onLocate }) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.corridor = corridor;
    this.tiles = tiles;
    this.state = state;
    this.onLocate = onLocate || (() => {});

    this.assets = makeAssetList(corridor);
    this.group = new THREE.Group();
    this.group.name = 'assets';
    scene.add(this.group);
    this.pickTargets = [];
    this.meshById = new Map();
    this.selectedId = null;
    this.orders = loadWorkOrders();
    this.telemetryTimer = null;

    this._buildModels();
    this._bindUi();
    this._renderList();
    this._startTelemetry();
  }

  _buildModels() {
    const markerGeoms = [];
    const markerColors = [];
    for (const asset of this.assets) {
      const model = buildAsset(asset);
      const ground = this._safeGround(asset.x, asset.z);
      const baseY = ground != null ? ground : asset.ele;
      model.position.set(asset.x, baseY + 1.5, asset.z);
      model.userData.assetId = asset.id;
      // 合并为单网格：一个结构物只占 1 次绘制
      const merged = mergeGroupByColor(model);
      const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
      mesh.userData.assetId = asset.id;
      mesh.name = asset.id;
      this.group.add(mesh);
      this.pickTargets.push(mesh);
      this.meshById.set(asset.id, mesh);

      // 地面标记环：几何合并到一个带顶点色的网格
      const ringGeo = new THREE.RingGeometry(58, 74, 28);
      ringGeo.rotateX(-Math.PI / 2);
      ringGeo.translate(asset.x, baseY + 3, asset.z);
      const c = new THREE.Color(TYPE_COLOR[asset.type] || '#ffffff');
      const cnt = ringGeo.attributes.position.count;
      const col = new Float32Array(cnt * 3);
      for (let i = 0; i < cnt; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      ringGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      markerGeoms.push(ringGeo);
      markerColors.push(c);
    }
    // 合并所有标记环为 1 个网格
    if (markerGeoms.length) {
      const total = markerGeoms.reduce((s, g) => s + g.attributes.position.count, 0);
      const pos = new Float32Array(total * 3);
      const col = new Float32Array(total * 3);
      const idx = [];
      let vo = 0;
      for (const g of markerGeoms) {
        const p = g.attributes.position.array;
        pos.set(p, vo * 3);
        const c = g.attributes.color.array;
        col.set(c, vo * 3);
        const ix = g.index;
        if (ix) for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + vo);
        vo += g.attributes.position.count;
        g.dispose();
      }
      const merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
      merged.setIndex(idx);
      merged.computeBoundingSphere();
      const markers = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }));
      markers.name = 'asset-markers';
      this.group.add(markers);
    }
    // 结构物整体作为点选目标（合并后每个结构物一个网格）
    this.pickTargets = [...this.meshById.values()];
    // 选中高亮环
    this.highlight = new THREE.Mesh(
      new THREE.RingGeometry(88, 104, 40),
      new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.highlight.rotation.x = -Math.PI / 2;
    this.highlight.visible = false;
    this.scene.add(this.highlight);
  }

  _bindUi() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      list: $('assetList'), empty: $('assetEmpty'), body: $('detailBody'),
      name: $('dName'), type: $('dType'), health: $('dHealth'), fields: $('dFields'),
      metrics: $('dMetrics'), woList: $('woList'), woForm: $('woForm'),
      woCategory: $('woCategory'), woPriority: $('woPriority'), woNote: $('woNote'),
      woOpen: $('woOpen'), woCancel: $('woCancel'),
    };
    // 工单表单选项
    for (const [k, v] of Object.entries(COPY.asset.wo.categoryOpt)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = v;
      this.el.woCategory.appendChild(o);
    }
    for (const [k, v] of Object.entries(COPY.asset.wo.priorityOpt)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = v;
      if (k === 'normal') o.selected = true;
      this.el.woPriority.appendChild(o);
    }
    this.el.woNote.placeholder = COPY.asset.wo.notePlaceholder;

    this.el.woOpen.addEventListener('click', () => {
      this.el.woForm.hidden = !this.el.woForm.hidden;
    });
    this.el.woCancel.addEventListener('click', () => { this.el.woForm.hidden = true; });
    this.el.woForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this._submitOrder();
    });

    const collapse = document.getElementById('assetCollapse');
    const body = document.getElementById('assetBody');
    collapse?.addEventListener('click', () => {
      const hidden = body.hidden;
      body.hidden = !hidden;
      collapse.textContent = hidden ? '−' : '+';
    });

    // 场景点选
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    let down = null;
    this.canvas.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY }; });
    this.canvas.addEventListener('pointerup', (ev) => {
      if (!down) return;
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const hit = this._pick(ev.clientX, ev.clientY);
      if (hit) this.select(hit);
    });
  }

  _pick(cx, cy) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickTargets, false);
    if (!hits.length) return null;
    return hits[0].object.userData.assetId || null;
  }

  _renderList() {
    const ul = this.el.list;
    ul.innerHTML = '';
    for (const a of this.assets) {
      const li = document.createElement('li');
      li.dataset.id = a.id;
      const metrics = sampleTelemetry(a, Date.now());
      const health = assetHealth(a, metrics);
      li.innerHTML = `
        <span class="asset-type" style="background:${TYPE_COLOR[a.type]}">${ASSET_TYPES[a.type].icon}</span>
        <span><span class="asset-name">${a.name}</span></span>
        <span class="asset-meta"><i class="asset-dot" style="background:${health.level === 'ok' ? '#6bd08a' : health.level === 'warn' ? '#e0b23a' : '#e2481f'}"></i>${(a.dist / 1000).toFixed(1)} km</span>
      `;
      li.addEventListener('click', () => {
        this.select(a.id);
        this.onLocate(a);
      });
      ul.appendChild(li);
    }
  }

  select(id) {
    const asset = this.assets.find((a) => a.id === id);
    if (!asset) return;
    this.selectedId = id;
    [...this.el.list.children].forEach((li) => li.classList.toggle('active', li.dataset.id === id));
    this.el.empty.hidden = true;
    this.el.body.hidden = false;
    this._renderDetail();
    this._updateHighlight();
  }

  _updateHighlight() {
    const asset = this.assets.find((a) => a.id === this.selectedId);
    if (!asset) { this.highlight.visible = false; return; }
    const ground = this._safeGround(asset.x, asset.z);
    this.highlight.position.set(asset.x, (ground != null ? ground : asset.ele) + 4, asset.z);
    this.highlight.visible = true;
  }

  /** 瓦片尚未就绪时退回走廊高程，避免反复扫描常驻瓦片 */
  _safeGround(x, z) {
    try {
      if (!this.tiles || !this.tiles.resident || this.tiles.resident.size === 0) return null;
      return this.tiles.groundHeightAt(x, z);
    } catch (e) {
      return null;
    }
  }

  _renderDetail() {
    const asset = this.assets.find((a) => a.id === this.selectedId);
    if (!asset) return;
    const metrics = sampleTelemetry(asset, Date.now());
    const health = assetHealth(asset, metrics);
    const el = this.el;
    el.name.textContent = asset.name;
    el.type.textContent = COPY.asset.type[asset.type];
    el.health.textContent = COPY.asset.health + ' ' + health.score + ' · ' + COPY.asset.level[health.level];
    el.health.className = 'health ' + health.level;

    const ll = this.corridor.toLonLat ? this.corridor.toLonLat(asset.x, asset.z) : null;
    const rows = [
      [COPY.asset.field.id, asset.id],
      [COPY.asset.field.type, COPY.asset.type[asset.type]],
      [COPY.asset.field.dist, (asset.dist / 1000).toFixed(2) + ' km'],
      [COPY.asset.field.ele, Math.round(asset.ele) + ' m'],
      [COPY.asset.field.bearing, Math.round(((asset.bearing * 180) / Math.PI + 360) % 360) + '°'],
    ];
    if (asset.lanes) rows.push([COPY.asset.field.lanes, asset.lanes + ' 条']);
    if (asset.span) rows.push([COPY.asset.field.span, asset.span + ' m']);
    if (asset.length) rows.push([COPY.asset.field.length, asset.length + ' m']);
    if (asset.height) rows.push([COPY.asset.field.clearance, asset.height + ' m']);
    if (asset.radius) rows.push([COPY.asset.field.radius, asset.radius + ' m']);
    if (asset.size) rows.push([COPY.asset.field.size, asset.size + ' m']);
    if (ll) {
      const fmt = (v, pos, neg) => {
        const d = Math.abs(v), deg = Math.floor(d), min = ((d - deg) * 60).toFixed(2);
        return deg + '°' + min + '′' + (v >= 0 ? pos : neg);
      };
      rows.push([COPY.asset.field.lonlat, fmt(ll.lat, 'N', 'S') + ' ' + fmt(ll.lon, 'E', 'W')]);
    }
    el.fields.innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');

    el.metrics.innerHTML = metrics.map((m) => {
      const g = gradeMetric(m);
      const pct = g.ratio == null ? 0 : Math.min(100, Math.round(g.ratio * 100));
      const val = Math.abs(m.value) >= 1000 ? Math.round(m.value).toLocaleString('en-US') : m.value.toFixed(1);
      const limit = m.limit == null ? COPY.asset.noLimit : COPY.asset.limit + ' ' + (m.invert ? '≥ ' : '≤ ') + m.limit + ' ' + m.unit;
      return `
        <div class="metric ${g.level}">
          <div class="mk">${m.label}</div>
          <div><span class="mv">${val}</span><span class="mu">${m.unit}</span></div>
          <div class="bar"><i style="width:${g.ratio == null ? 0 : pct}%"></i></div>
          <div class="ml">${limit}</div>
        </div>`;
    }).join('');

    this._renderOrders();
  }

  _renderOrders() {
    const orders = this.orders.filter((o) => o.assetId === this.selectedId);
    if (!orders.length) {
      this.el.woList.innerHTML = '<li class="empty">' + COPY.asset.wo.empty + '</li>';
      return;
    }
    this.el.woList.innerHTML = '';
    for (const o of orders.slice().reverse()) {
      const li = document.createElement('li');
      li.className = 'wo';
      const next = o.status === 'open' ? 'assigned' : o.status === 'assigned' ? 'closed' : 'open';
      const nextLabel = next === 'assigned' ? COPY.asset.wo.escalate : next === 'closed' ? COPY.asset.wo.close : COPY.asset.wo.reopen;
      const when = new Date(o.createdAt);
      li.innerHTML = `
        <div class="wo-top">
          <span class="wo-id">${o.id}</span>
          <span class="wo-pri ${o.priority}">${COPY.asset.wo.priorityOpt[o.priority]}</span>
          <span class="wo-status">${COPY.asset.wo.status[o.status]}</span>
        </div>
        <div class="wo-body">${COPY.asset.wo.categoryOpt[o.category]} · ${escapeHtml(o.note)}</div>
        <div class="wo-meta">${when.toLocaleString('zh-CN', { hour12: false })}</div>
        <div class="wo-actions"><button type="button" data-wo="${o.id}" data-next="${next}">${nextLabel}</button></div>
      `;
      li.querySelector('button').addEventListener('click', (ev) => {
        const id = ev.currentTarget.dataset.wo;
        const to = ev.currentTarget.dataset.next;
        this.orders = this.orders.map((x) => (x.id === id ? advanceWorkOrder(x, to) : x));
        saveWorkOrders(this.orders);
        this._renderOrders();
        this.onToast?.(COPY.asset.wo.title + ' ' + COPY.asset.wo.status[to]);
      });
      this.el.woList.appendChild(li);
    }
  }

  _submitOrder() {
    const asset = this.assets.find((a) => a.id === this.selectedId);
    if (!asset) return;
    const note = this.el.woNote.value.trim();
    if (!note) {
      this.onToast?.(COPY.asset.wo.needNote);
      return;
    }
    const order = createWorkOrder(asset, {
      category: this.el.woCategory.value,
      priority: this.el.woPriority.value,
      note,
    });
    this.orders.push(order);
    saveWorkOrders(this.orders);
    this.el.woNote.value = '';
    this.el.woForm.hidden = true;
    this._renderOrders();
    this.onToast?.(COPY.asset.wo.created + ' ' + order.id);
  }

  _startTelemetry() {
    this.telemetryTimer = setInterval(() => {
      if (!this.selectedId) return;
      if (document.hidden) return;
      this._renderDetail();
    }, 2000);
  }

  /** 相机跟随时把里程跳到结构物位置 */
  locate(asset) {
    this.state.dist = asset.dist;
  }

  followSelection() {
    if (this.selectedId) this._updateHighlight();
  }

  dispose() {
    clearInterval(this.telemetryTimer);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
