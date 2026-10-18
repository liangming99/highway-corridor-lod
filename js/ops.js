// ops.js — 结构物运行状态：实时数据模拟、健康评分、工单流程
import { COPY } from './copy.js';

/** 每个结构物的实时数据（演示用：按时间确定性波动，刷新可见变化） */
export function sampleTelemetry(asset, nowMs) {
  const t = nowMs / 1000;
  const seed = asset.id.charCodeAt(1) * 7.31 + asset.id.charCodeAt(2) * 3.17;
  const wave = (k, amp, base, period) =>
    base + amp * Math.sin(t / period + seed * k) + amp * 0.34 * Math.sin(t / (period * 0.37) + seed * k * 2.1);
  if (asset.type === 'bridge') {
    return [
      { key: 'deflection', label: COPY.asset.metric.deflection, value: wave(1, 1.6, 12.5, 11), unit: 'mm', limit: 20, warnAt: 0.8 },
      { key: 'vibration', label: COPY.asset.metric.vibration, value: wave(2, 0.35, 1.9, 5), unit: 'mm/s', limit: 4.5, warnAt: 0.78 },
      { key: 'cableForce', label: COPY.asset.metric.cableForce, value: wave(3, 180, 9240, 17), unit: 'kN', limit: 11000, warnAt: 0.88 },
      { key: 'temp', label: COPY.asset.metric.temp, value: wave(4, 0.42, 26.4, 23), unit: '°C', limit: null },
    ];
  }
  if (asset.type === 'tunnel') {
    return [
      { key: 'co', label: COPY.asset.metric.co, value: wave(1, 6, 28, 9), unit: 'ppm', limit: 70, warnAt: 0.75 },
      { key: 'visibility', label: COPY.asset.metric.visibility, value: wave(2, 12, 780, 13), unit: 'm', limit: 500, warnAt: 0.6, invert: true },
      { key: 'lux', label: COPY.asset.metric.lux, value: wave(3, 18, 214, 7), unit: 'lx', limit: null },
      { key: 'fan', label: COPY.asset.metric.fan, value: wave(4, 3.5, 42, 15), unit: 'Hz', limit: 50, warnAt: 0.9 },
    ];
  }
  if (asset.type === 'interchange') {
    return [
      { key: 'flow', label: COPY.asset.metric.flow, value: wave(1, 210, 2860, 21), unit: 'veh/h', limit: 4200, warnAt: 0.8 },
      { key: 'speed', label: COPY.asset.metric.speed, value: wave(2, 9, 82, 17), unit: 'km/h', limit: null },
      { key: 'queue', label: COPY.asset.metric.queue, value: wave(3, 22, 46, 9), unit: 'm', limit: 200, warnAt: 0.8 },
      { key: 'conflict', label: COPY.asset.metric.conflict, value: wave(4, 0.6, 1.4, 27), unit: COPY.asset.metric.unitCount, limit: 5, warnAt: 0.8 },
    ];
  }
  return [
    { key: 'parking', label: COPY.asset.metric.parking, value: wave(1, 26, 168, 31), unit: COPY.asset.metric.unitSpot, limit: 240, warnAt: 0.85 },
    { key: 'flow', label: COPY.asset.metric.flow, value: wave(2, 90, 1240, 19), unit: 'veh/h', limit: 3000, warnAt: 0.8 },
    { key: 'wait', label: COPY.asset.metric.wait, value: wave(3, 4, 11, 13), unit: 'min', limit: 30, warnAt: 0.8 },
    { key: 'temp', label: COPY.asset.metric.temp, value: wave(4, 0.6, 25.1, 29), unit: '°C', limit: null },
  ];
}

/** 把数据换算成“正常 / 关注 / 超限”等级与占比 */
export function gradeMetric(m) {
  if (m.limit == null) return { level: 'ok', ratio: null };
  const ratio = m.invert ? m.limit / Math.max(1e-6, m.value) : m.value / m.limit;
  const warnAt = m.warnAt || 0.8;
  if (ratio >= 1) return { level: 'alarm', ratio };
  if (ratio >= warnAt) return { level: 'warn', ratio };
  return { level: 'ok', ratio };
}

export function assetHealth(asset, metrics) {
  let worst = 'ok';
  for (const m of metrics) {
    const g = gradeMetric(m);
    if (g.level === 'alarm') worst = 'alarm';
    else if (g.level === 'warn' && worst !== 'alarm') worst = 'warn';
  }
  const score = worst === 'alarm' ? 62 : worst === 'warn' ? 84 : 97;
  return { level: worst, score };
}

const STORAGE_KEY = 'corridor-work-orders';

export function loadWorkOrders() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

export function saveWorkOrders(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    /* 存储不可用时不影响页面 */
  }
}

export function createWorkOrder(asset, { category, priority, note }, now = new Date()) {
  const seq = String(Math.floor(now.getTime() / 1000) % 100000).padStart(5, '0');
  return {
    id: 'WO-' + now.getFullYear() + seq,
    assetId: asset.id,
    assetName: asset.name,
    assetType: asset.type,
    category,
    priority,
    note,
    status: 'open',
    createdAt: now.toISOString(),
    history: [{ at: now.toISOString(), action: COPY.asset.wo.created, by: COPY.asset.wo.operator }],
  };
}

export function advanceWorkOrder(order, nextStatus, now = new Date()) {
  const history = [...(order.history || []), {
    at: now.toISOString(),
    action: COPY.asset.wo.status[order.status] + ' → ' + COPY.asset.wo.status[nextStatus],
    by: COPY.asset.wo.operator,
  }];
  return { ...order, status: nextStatus, history };
}
