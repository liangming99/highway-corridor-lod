import { writeFileSync } from 'node:fs';
const OUT = '/Users/ming/Documents/Codex/2026-10-17/https-x-com-claudeai-status-2111177834127601902/work/lod-dev/final2-bench.json';
const log = (o) => writeFileSync(OUT, JSON.stringify(o, null, 1));
const task = await taskSpace("lod corridor dev");
const p = task.page("p1");
await p.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await p.goto("http://127.0.0.1:8125/");
await p.waitForFunction(() => window.__lod && window.__lod.state.tiles, undefined, { timeout: 25000 });
const meta = await p.evaluate(() => ({
  corridor: document.querySelector('#corridorName').textContent,
  length: document.querySelector('#corridorLen').textContent,
  gpu: (() => { const gl = window.__lod.state.renderer.getContext(); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })(),
  viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
}));
log({ stage: 'loaded', meta });
for (let i = 0; i < 30; i++) {
  const q = await p.evaluate(() => { const s = window.__lod.tiles().getStats(); return s.queue + s.inflight; });
  if (q === 0) break;
  await p.waitForTimeout(1500);
}
await p.waitForTimeout(6000);
const out = [];
const runOne = async (key, maxSec, builds) => {
  await p.evaluate((b) => { const el = document.getElementById('builds'); el.value = String(b); el.dispatchEvent(new Event('input')); }, builds);
  const before = await p.evaluate(() => window.__lod.bench().results.length);
  await p.evaluate((k) => window.__lod.startBench(k), key);
  for (let i = 0; i < maxSec; i++) {
    await p.waitForTimeout(1000);
    const now = await p.evaluate(() => window.__lod.bench().results.length);
    if (now > before) return p.evaluate(() => window.__lod.bench().results.at(-1));
  }
  return { name: key, timeout: true };
};
out.push(await runOne('A', 55, 3)); log({ stage: 'A', meta, out });
out.push(await runOne('B', 65, 3)); log({ stage: 'B', meta, out });
out.push(await runOne('C', 60, 3)); log({ stage: 'C', meta, out });
const shot = await p.screenshot({ path: '/Users/ming/Documents/Codex/2026-10-17/https-x-com-claudeai-status-2111177834127601902/work/lod-dev/final2-shot.png' });
log({ stage: 'done', meta, out, shot, json: await p.evaluate(() => window.__lod.bench().toJSON()) });
