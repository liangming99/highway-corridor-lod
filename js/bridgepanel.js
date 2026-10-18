// bridgepanel.js — 构件级点选、监测详情与工单
import * as THREE from 'three';
import { COPY } from './copy.js';
import { BRIDGE_PARTS, BridgeModel } from './bridge.js';
import { gradeMetric, loadWorkOrders, saveWorkOrders, createWorkOrder, advanceWorkOrder } from './ops.js';

const GROUP_OF = {
  girder: 'superstructure', cables: 'superstructure',
  pylonA: 'substructure', pylonB: 'substructure', piers: 'substructure', abutments: 'substructure',
  deck: 'ancillary', markings: 'ancillary', railings: 'ancillary',
};

export class BridgePanel {
  constructor({ scene, camera, canvas, renderer, state, onChanged }) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.state = state;
    this.onChanged = onChanged || (() => {});
    this.model = new BridgeModel({ scene, renderer });
    this.orders = loadWorkOrders();
    this.selected = null;
    this.timer = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.visible = false;
  }

  async init({ position, bearingDeg }) {
    const ok = await this.model.load();
    if (!ok) return false;
    this.model.place(position, bearingDeg, 1);
    this.model.show(false);
    this._bind();
    this._renderList();
    this.timer = setInterval(() => {
      if (!this.visible || !this.selected || document.hidden) return;
      this._renderDetail();
    }, 2000);
    return true;
  }

  setVisible(v) {
    this.visible = v;
    this.model.show(v);
    const panel = document.getElementById('bridgePanel');
    if (panel) panel.hidden = !v;
    if (!v) this.model.clearSelection();
  }

  focus(camera, target, distance = 520) {
    const p = target.clone();
    const dir = new THREE.Vector3(1, 0.62, 1).normalize();
    camera.position.copy(p.clone().addScaledVector(dir, distance));
    camera.lookAt(p);
  }

  _bind() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      list: $('bridgePartList'), empty: $('bridgeEmpty'), body: $('bridgeBody'),
      name: $('bpName'), group: $('bpGroup'), health: $('bpHealth'),
      metrics: $('bpMetrics'), woTitle: $('bpWoTitle'), woList: $('bpWoList'),
      woForm: $('bpWoForm'), woCategory: $('bpWoCategory'), woPriority: $('bpWoPriority'),
      woNote: $('bpWoNote'), woOpen: $('bpWoOpen'), woCancel: $('bpWoCancel'),
    };
    if (!this.el.list) return;
    for (const [k, v] of Object.entries(COPY.asset.wo.categoryOpt)) {
      const o = document.createElement('option'); o.value = k; o.textContent = v;
      this.el.woCategory.appendChild(o);
    }
    for (const [k, v] of Object.entries(COPY.asset.wo.priorityOpt)) {
      const o = document.createElement('option'); o.value = k; o.textContent = v;
      if (k === 'normal') o.selected = true;
      this.el.woPriority.appendChild(o);
    }
    this.el.woNote.placeholder = COPY.asset.wo.notePlaceholder;
    this.el.woOpen.addEventListener('click', () => { this.el.woForm.hidden = !this.el.woForm.hidden; });
    this.el.woCancel.addEventListener('click', () => { this.el.woForm.hidden = true; });
    this.el.woForm.addEventListener('submit', (e) => { e.preventDefault(); this._submit(); });

    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || !this.visible) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const part = this._pick(e.clientX, e.clientY);
      if (part) this.select(part);
    });
  }

  _pick(cx, cy) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((cx - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((cy - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.model.pick(this.raycaster);
  }

  _renderList() {
    const ul = this.el.list;
    if (!ul) return;
    ul.innerHTML = '';
    const order = ['pylonA', 'pylonB', 'cables', 'girder', 'deck', 'railings', 'markings', 'piers', 'abutments'];
    for (const key of order) {
      const meta = BRIDGE_PARTS[key];
      if (!meta) continue;
      const li = document.createElement('li');
      li.dataset.part = key;
      li.innerHTML = '<span class="bp-dot bp-' + GROUP_OF[key] + '"></span><span class="bp-n">' + COPY.bridge.part[key] + '</span><span class="bp-g">' + COPY.bridge.group[GROUP_OF[key]] + '</span>';
      li.addEventListener('click', () => this.select(key));
      ul.appendChild(li);
    }
  }

  select(key) {
    if (!BRIDGE_PARTS[key]) return;
    this.selected = key;
    this.model.select(key);
    [...this.el.list.children].forEach((li) => li.classList.toggle('active', li.dataset.part === key));
    this.el.empty.hidden = true;
    this.el.body.hidden = false;
    this._renderDetail();
    const box = this.model.partBounds(key);
    if (box) {
      const c = box.getCenter(new THREE.Vector3());
      this.state.bridgeFocus = c;
      this.onChanged({ focus: c, part: key });
    }
  }

  _renderDetail() {
    const key = this.selected;
    if (!key) return;
    const metrics = this.model.partMetrics(key, Date.now());
    let worst = 'ok';
    for (const m of metrics) {
      const g = gradeMetric(m);
      if (g.level === 'alarm') worst = 'alarm';
      else if (g.level === 'warn' && worst !== 'alarm') worst = 'warn';
    }
    const score = worst === 'alarm' ? 61 : worst === 'warn' ? 83 : 96;
    this.el.name.textContent = COPY.bridge.part[key];
    this.el.group.textContent = COPY.bridge.group[GROUP_OF[key]];
    this.el.health.textContent = COPY.asset.health + ' ' + score + ' · ' + COPY.asset.level[worst];
    this.el.health.className = 'health ' + worst;

    this.el.metrics.innerHTML = metrics.map((m) => {
      const g = gradeMetric(m);
      const pct = g.ratio == null ? 0 : Math.min(100, Math.round(g.ratio * 100));
      const val = Math.abs(m.value) >= 1000 ? Math.round(m.value).toLocaleString('en-US') : m.value.toFixed(2);
      const limit = m.limit == null ? COPY.asset.noLimit : COPY.asset.limit + ' ' + (m.invert ? '≥ ' : '≤ ') + m.limit + ' ' + m.unit;
      return '<div class="metric ' + g.level + '"><div class="mk">' + m.label + '</div><div><span class="mv">' + val + '</span><span class="mu">' + m.unit + '</span></div><div class="bar"><i style="width:' + (g.ratio == null ? 0 : pct) + '%"></i></div><div class="ml">' + limit + '</div></div>';
    }).join('');
    this._renderOrders();
  }

  _renderOrders() {
    const list = this.orders.filter((o) => o.assetId === 'BR-0768:' + this.selected);
    if (!list.length) {
      this.el.woList.innerHTML = '<li class="empty">' + COPY.asset.wo.empty + '</li>';
      return;
    }
    this.el.woList.innerHTML = '';
    for (const o of list.slice().reverse()) {
      const li = document.createElement('li');
      li.className = 'wo';
      const next = o.status === 'open' ? 'assigned' : o.status === 'assigned' ? 'closed' : 'open';
      const label = next === 'assigned' ? COPY.asset.wo.escalate : next === 'closed' ? COPY.asset.wo.close : COPY.asset.wo.reopen;
      li.innerHTML = '<div class="wo-top"><span class="wo-id">' + o.id + '</span><span class="wo-pri ' + o.priority + '">' + COPY.asset.wo.priorityOpt[o.priority] + '</span><span class="wo-status">' + COPY.asset.wo.status[o.status] + '</span></div><div class="wo-body">' + COPY.asset.wo.categoryOpt[o.category] + ' · ' + escapeHtml(o.note) + '</div><div class="wo-meta">' + new Date(o.createdAt).toLocaleString('zh-CN', { hour12: false }) + '</div><div class="wo-actions"><button type="button" data-wo="' + o.id + '" data-next="' + next + '">' + label + '</button></div>';
      li.querySelector('button').addEventListener('click', (ev) => {
        const id = ev.currentTarget.dataset.wo;
        const to = ev.currentTarget.dataset.next;
        this.orders = this.orders.map((x) => (x.id === id ? advanceWorkOrder(x, to) : x));
        saveWorkOrders(this.orders);
        this._renderOrders();
      });
      this.el.woList.appendChild(li);
    }
  }

  _submit() {
    if (!this.selected) return;
    const note = this.el.woNote.value.trim();
    if (!note) { this.onChanged({ toast: COPY.asset.wo.needNote }); return; }
    const fakeAsset = { id: 'BR-0768:' + this.selected, name: COPY.bridge.part[this.selected], type: 'bridge' };
    const order = createWorkOrder(fakeAsset, {
      category: this.el.woCategory.value,
      priority: this.el.woPriority.value,
      note,
    });
    this.orders.push(order);
    saveWorkOrders(this.orders);
    this.el.woNote.value = '';
    this.el.woForm.hidden = true;
    this._renderOrders();
    this.onChanged({ toast: COPY.asset.wo.created + ' ' + order.id });
  }

  dispose() {
    clearInterval(this.timer);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

