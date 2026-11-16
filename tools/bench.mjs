const ROOT = process.env.SPLAT_TRANSFORM ?? '/home/user/splat-transform';
const R = ROOT + '/src/lib/';
const { createDevice } = await import(ROOT + '/src/cli/node-device.js');
const { Column, DataTable, dataTableToChunkSource, computeViewScores } = await import(R + 'index.js');
const { createChunkDataPool } = await import(R + 'chunk/index.js');
const { SceneRenderer } = await import(R + 'render/index.js');
const { Vec3 } = await import(ROOT + '/node_modules/playcanvas/build/playcanvas.mjs');
const device = await createDevice();
const n = 300000;
let s = 1; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const f = (fn) => Float32Array.from({ length: n }, fn);
// a hollow shell (room walls) plus interior clutter: camera inside sees the inner surface only
const pos = Array.from({ length: n }, (_, i) => {
    const u = rnd() * 2 - 1, t = rnd() * 2 * Math.PI, r = Math.sqrt(1 - u * u);
    const rad = i % 3 === 0 ? 5 + rnd() * 3 : 5;      // a third lies outside/behind the shell
    return [rad * r * Math.cos(t), rad * u, rad * r * Math.sin(t)];
});
const one = new Float32Array(n).fill(1), zero = new Float32Array(n);
const sc = new Float32Array(n).fill(Math.log(0.04));
const dt = new DataTable([
    new Column('x', f((_, i) => pos[i][0])), new Column('y', f((_, i) => pos[i][1])), new Column('z', f((_, i) => pos[i][2])),
    new Column('rot_0', one), new Column('rot_1', zero), new Column('rot_2', zero), new Column('rot_3', zero),
    new Column('scale_0', sc), new Column('scale_1', sc), new Column('scale_2', sc),
    new Column('opacity', new Float32Array(n).fill(4)),
    new Column('f_dc_0', one), new Column('f_dc_1', one), new Column('f_dc_2', one)]);
const chunkSize = 65536;
const source = dataTableToChunkSource(dt, chunkSize), pool = createChunkDataPool({ chunkSize });
const V = 12, W = 640, H = 360;
const cams = Array.from({ length: V }, (_, k) => ({ position: { x: 0, y: 0, z: 0 }, target: { x: Math.cos(k * 2 * Math.PI / V), y: 0, z: Math.sin(k * 2 * Math.PI / V) } }));
let t0 = performance.now();
const scores = await computeViewScores(device, source, pool, cams, { width: W, height: H });
const tScore = performance.now() - t0;
const r = new SceneRenderer(device, source, pool, { projection: 'pinhole', width: W, height: H, background: { r: 0, g: 0, b: 0, a: 0 }, tier: 'resident' });
await r.upload();
t0 = performance.now();
for (const c of cams) await r.render({ position: new Vec3(0, 0, 0), target: new Vec3(c.target.x, 0, c.target.z), up: new Vec3(0, 1, 0), fovY: Math.PI / 3, width: W, height: H, near: 0.2 });
const tRender = performance.now() - t0;
r.destroy();
let zeroN = 0, low = 0; for (const v of scores.sum) { if (v === 0) zeroN++; else if (v < 0.5) low++; }
console.log(JSON.stringify({ n, views: V, scoreMsPerView: +(tScore / V).toFixed(0), renderMsPerView: +(tRender / V).toFixed(0), zeroScore: zeroN, below0_5px: low }));
process.exit(0);
