// e2e-soak.mjs — 长时漫游 E2E：验证不再卡死，并记录内存/绘制/长任务
// 用法：先起本地服务（python3 -m http.server 8125），再执行
//   ego-browser nodejs < tools/e2e-soak.mjs
// 结果写入 work/e2e-soak.json（相对执行目录）。
import { writeFileSync } from 'node:fs';

const OUT = process.env.E2E_OUT || 'e2e-soak.json';
const URL = process.env.E2E_URL || 'http://127.0.0.1:8125/index.html';
const DURATION_S = Number(process.env.E2E_SECONDS || 200);
const INTERVAL_S = 5;

const task = await taskSpace('highway-corridor e2e');
const p = task.page('p1');
const out = { samples: [], checks: {} };
const log = (o) => writeFileSync(OUT, JSON.stringify(o, null, 1));

try {
  await p.cdp('Network.setCacheDisabled', { cacheDisabled: true });
  await p.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.goto(URL + '?e2e=' + Date.now());
  await p.waitForFunction(() => window.__lod && typeof window.__lod.sample === 'function', undefined, { timeout: 25000 });
  await p.waitForTimeout(8000);

  out.checks.initial = await p.evaluate(() => window.__lod.sample());

  // 结构物点选与工单
  await p.evaluate(() => document.querySelector('#assetList li').click());
  await p.waitForTimeout(600);
  out.checks.asset = await p.evaluate(() => ({
    name: document.querySelector('#dName').textContent,
    metrics: document.querySelectorAll('#dMetrics .metric').length,
  }));
  await p.evaluate(() => {
    document.querySelector('#woOpen').click();
    document.querySelector('#woNote').value = 'E2E：自动化巡检发现的异常';
    document.querySelector('#woForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  });
  await p.waitForTimeout(500);
  out.checks.orders = await p.evaluate(() => document.querySelectorAll('#woList .wo').length);

  // 提速漫游
  await p.evaluate(() => {
    const el = document.getElementById('speed');
    el.value = '900';
    el.dispatchEvent(new Event('input'));
    if (window.__lod.state.playing === false) document.getElementById('btnPlay').click();
  });

  const t0 = Date.now();
  const rounds = Math.ceil(DURATION_S / INTERVAL_S);
  for (let i = 0; i < rounds; i++) {
    await p.waitForTimeout(INTERVAL_S * 1000);
    const s = await p.evaluate(() => window.__lod.sample());
    out.samples.push({ ...s, wall: Math.round((Date.now() - t0) / 1000) });
    log({ stage: 'sampling', out });
  }
  out.checks.last = await p.evaluate(() => window.__lod.sample());
  log({ stage: 'done', out });
} catch (e) {
  out.error = String((e && e.message) || e);
  log({ stage: 'failed', out });
  process.exitCode = 1;
} finally {
  try { await task.finish({ keep: [] }); } catch (e) { /* 任务空间已关闭 */ }
}
