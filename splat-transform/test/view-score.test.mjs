/**
 * View scores.
 *
 * `computeViewScores` gives each gaussian the pixels it effectively paints
 * over a set of views (the sum of its blending weights). The scenes here
 * have known visibility: an opaque wall facing the camera, gaussians in
 * front of it, behind it, behind the camera and outside the frustum.
 */

import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';

let device = null;

before(async () => {
    try {
        const { createDevice } = await import('../src/cli/node-device.js');
        device = await createDevice();
    } catch {
        device = null;
    }
});

after(() => {
    device?.destroy?.();
});

const logit = p => Math.log(p / (1 - p));

/**
 * Camera at z = 6 looking down -z. A wall of opaque gaussians fills the
 * plane z = 0; groups of small gaussians sit in front of it (z = 2), behind
 * it (z = -2), behind the camera (z = 9) and far off to the side (x = 60).
 *
 * @param {object} [transform] - Pending transform of the source; the stored
 * positions are moved through its inverse, so the scene looks the same.
 * @returns {Promise<object>} The scene and the row ranges of its groups.
 */
const makeScene = async (transform) => {
    const { Column, DataTable, dataTableToChunkSource } = await import('../src/lib/index.js');
    const { createChunkDataPool } = await import('../src/lib/chunk/index.js');
    const rows = [];
    const add = (x, y, z, logScale, alpha) => rows.push({ x, y, z, logScale, alpha });

    const groups = {};
    const group = (name, build) => {
        const start = rows.length;
        build();
        groups[name] = [start, rows.length];
    };
    // Wall: a 41 × 41 grid at 0.25 spacing, sigma 0.25, so it is opaque everywhere the camera looks.
    group('wall', () => {
        for (let j = -20; j <= 20; j++) for (let i = -20; i <= 20; i++) add(i * 0.25, j * 0.25, 0, Math.log(0.25), 0.999);
    });
    const cluster = (z, cx = 0) => () => {
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) add(cx + i * 0.3, j * 0.3, z, Math.log(0.05), 0.9);
    };
    group('front', cluster(2));
    group('hidden', cluster(-2));
    group('behindCamera', cluster(9));
    group('outside', cluster(2, 60));

    const n = rows.length;
    if (transform) {
        const { Vec3 } = await import('playcanvas');
        const inverse = transform.clone().invert();
        const v = new Vec3();
        for (const r of rows) {
            inverse.transformPoint(v.set(r.x, r.y, r.z), v);
            r.x = v.x;
            r.y = v.y;
            r.z = v.z;
        }
    }
    const col = fn => Float32Array.from(rows, fn);
    const one = new Float32Array(n).fill(1);
    const zero = new Float32Array(n);
    const dataTable = new DataTable([
        new Column('x', col(r => r.x)), new Column('y', col(r => r.y)), new Column('z', col(r => r.z)),
        new Column('rot_0', one), new Column('rot_1', zero), new Column('rot_2', zero), new Column('rot_3', zero),
        new Column('scale_0', col(r => r.logScale)), new Column('scale_1', col(r => r.logScale)), new Column('scale_2', col(r => r.logScale)),
        new Column('opacity', col(r => logit(r.alpha))),
        new Column('f_dc_0', one), new Column('f_dc_1', one), new Column('f_dc_2', one)
    ], transform);
    const chunkSize = 1024;
    return {
        source: dataTableToChunkSource(dataTable, chunkSize),
        pool: createChunkDataPool({ chunkSize }),
        groups,
        n
    };
};

const camera = { position: { x: 0, y: 0, z: 6 }, target: { x: 0, y: 0, z: 0 } };
const size = { width: 320, height: 192 };

const range = (array, [start, end]) => Array.from(array.subarray(start, end));

describe('computeViewScores', () => {
    it('scores visible gaussians and zeroes hidden ones', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { computeViewScores } = await import('../src/lib/index.js');
        const scene = await makeScene();
        const scores = await computeViewScores(device, scene.source, scene.pool, [camera], size);

        assert.strictEqual(scores.sum.length, scene.n);
        assert.strictEqual(scores.views, 1);
        assert.ok(range(scores.sum, scene.groups.front).every(s => s > 1), 'gaussians in front of the wall paint pixels');
        assert.ok(range(scores.sum, scene.groups.hidden).every(s => s === 0), 'gaussians behind the wall score 0');
        assert.ok(range(scores.sum, scene.groups.behindCamera).every(s => s === 0), 'gaussians behind the camera score 0');
        assert.ok(range(scores.sum, scene.groups.outside).every(s => s === 0), 'gaussians outside the frustum score 0');
        assert.ok(range(scores.sum, scene.groups.wall).some(s => s > 1), 'the wall is seen');
        // One view: the largest single view is the sum.
        assert.deepStrictEqual(Array.from(scores.max), Array.from(scores.sum));
    });

    it('sums to the coverage of the rendered image', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { computeViewScores } = await import('../src/lib/index.js');
        const { SceneRenderer } = await import('../src/lib/render/index.js');
        const { Vec3 } = await import('playcanvas');
        const scene = await makeScene();
        const scores = await computeViewScores(device, scene.source, scene.pool, [camera], size);

        // Every blend moves weight from the transmittance to a gaussian, so the
        // scores sum to the image's total alpha (1 - T per pixel).
        const renderer = new SceneRenderer(device, scene.source, scene.pool, {
            projection: 'pinhole', ...size, background: { r: 0, g: 0, b: 0, a: 0 }, tier: 'resident'
        });
        await renderer.upload();
        const image = await renderer.render({
            position: new Vec3(0, 0, 6), target: new Vec3(0, 0, 0), up: new Vec3(0, 1, 0),
            fovY: 60 * Math.PI / 180, ...size, near: 0.2
        });
        renderer.destroy();
        let coverage = 0;
        for (let i = 3; i < image.length; i += 4) coverage += image[i] / 255;
        const total = scores.sum.reduce((a, b) => a + b, 0);
        assert.ok(coverage > 1000, `the scene covers pixels (${coverage})`);
        assert.ok(Math.abs(total - coverage) / coverage < 0.01, `scores ${total} vs coverage ${coverage}`);
    });

    it('accumulates over views and tracks the best view', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { computeViewScores } = await import('../src/lib/index.js');
        const scene = await makeScene();
        // The second camera stands behind the wall: what was hidden is now in front.
        const back = { position: { x: 0, y: 0, z: -6 }, target: { x: 0, y: 0, z: 0 } };
        const one = await computeViewScores(device, scene.source, scene.pool, [camera], size);
        const two = await computeViewScores(device, scene.source, scene.pool, [camera, back], size);

        assert.ok(range(two.sum, scene.groups.hidden).every(s => s > 1), 'the back view sees the hidden group');
        const [start, end] = scene.groups.front;
        for (let i = start; i < end; i++) {
            assert.ok(Math.abs(two.sum[i] - one.sum[i]) < 1e-3, 'the front group gains nothing from the back view');
            assert.ok(Math.abs(two.max[i] - one.max[i]) < 1e-3);
        }
        for (let i = 0; i < scene.n; i++) assert.ok(two.max[i] <= two.sum[i] + 1e-3);
    });

    it('honours the source transform', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { computeViewScores, Transform } = await import('../src/lib/index.js');
        // Isotropic gaussians, so only the positions need the inverse transform.
        const plain = await makeScene();
        const moved = await makeScene(Transform.PLY);
        const a = await computeViewScores(device, plain.source, plain.pool, [camera], size);
        const b = await computeViewScores(device, moved.source, moved.pool, [camera], size);
        for (let i = 0; i < plain.n; i++) {
            assert.ok(Math.abs(a.sum[i] - b.sum[i]) <= 0.01 + 0.01 * a.sum[i], `row ${i}: ${a.sum[i]} vs ${b.sum[i]}`);
        }
        assert.ok(range(b.sum, moved.groups.hidden).every(s => s === 0));
    });

    it('scores the same across image groups', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { GpuSceneRasterizer } = await import('../src/lib/gpu/gpu-scene-rasterizer.js');
        const { buildCameraBasis } = await import('../src/lib/render/index.js');
        const { Vec3 } = await import('playcanvas');
        const scene = await makeScene();
        const view = {
            basis: buildCameraBasis({
                position: new Vec3(0, 0, 6), target: new Vec3(0, 0, 0), up: new Vec3(0, 1, 0),
                fovY: 60 * Math.PI / 180, ...size, near: 0.2
            }),
            near: 0.2,
            focusDistance: 0,
            apertureScale: 0
        };
        // The 20 × 12 tile image as one group, and as a 3 × 3 grid of groups.
        const score = async (groupTilesX, groupTilesY) => {
            const raster = new GpuSceneRasterizer(device, {
                numSHBands: 0, projection: 'pinhole', imageWidth: size.width, imageHeight: size.height,
                groupTilesX, groupTilesY, bgR: 0, bgG: 0, bgB: 0, bgA: 0, score: true
            });
            await raster.uploadScene(scene.source, scene.pool);
            await raster.score([view]);
            const totals = await raster.readScores();
            raster.destroy();
            return totals;
        };
        const whole = await score(20, 12);
        const split = await score(8, 5);
        for (let i = 0; i < scene.n; i++) {
            assert.ok(Math.abs(whole[i * 2] - split[i * 2]) <= 0.01 + 0.01 * whole[i * 2], `row ${i}: ${whole[i * 2]} vs ${split[i * 2]}`);
        }
    });

    it('scores the same in the streamed tiers', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { computeViewScores } = await import('../src/lib/index.js');
        const back = { position: { x: 0, y: 0, z: -6 }, target: { x: 0, y: 0, z: 0 } };
        const side = { position: { x: 7, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 } };
        const cameras = [camera, back, side];
        const score = async (tier) => {
            const scene = await makeScene();
            const scores = await computeViewScores(device, scene.source, scene.pool, cameras, { ...size, tier });
            assert.strictEqual(scores.tier, tier);
            return { scores, scene };
        };
        const { scores: resident, scene } = await score('resident');
        // The chunk size (1024) is below the scene's 1781 gaussians, so the
        // streamed tiers cross a range boundary within each view.
        for (const tier of ['streamed-gpu', 'streamed-cpu']) {
            const { scores } = await score(tier);
            for (let i = 0; i < scene.n; i++) {
                for (const key of ['sum', 'max']) {
                    const a = resident[key][i], b = scores[key][i];
                    assert.ok(Math.abs(a - b) <= 0.01 + 0.01 * a, `${tier} ${key} row ${i}: ${b} vs ${a}`);
                }
            }
        }
    });

    it('counts past 32 bits for a gaussian that fills a large image', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { Column, DataTable, dataTableToChunkSource, computeViewScores } = await import('../src/lib/index.js');
        const { createChunkDataPool } = await import('../src/lib/chunk/index.js');
        // One opaque gaussian far wider than the view: every pixel blends it at
        // nearly full weight, so its counter passes 2^32 (65536 pixels at scale 2^16)
        // and must carry into the high word.
        const col = v => new Float32Array([v]);
        const dataTable = new DataTable([
            new Column('x', col(0)), new Column('y', col(0)), new Column('z', col(0)),
            new Column('rot_0', col(1)), new Column('rot_1', col(0)), new Column('rot_2', col(0)), new Column('rot_3', col(0)),
            new Column('scale_0', col(Math.log(50))), new Column('scale_1', col(Math.log(50))), new Column('scale_2', col(Math.log(0.01))),
            new Column('opacity', col(logit(0.999))),
            new Column('f_dc_0', col(1)), new Column('f_dc_1', col(1)), new Column('f_dc_2', col(1))
        ]);
        const big = { width: 512, height: 512 };
        const source = dataTableToChunkSource(dataTable, 1024);
        const pool = createChunkDataPool({ chunkSize: 1024 });
        const scores = await computeViewScores(device, source, pool, [camera], big);

        // The renderer clamps a frame-filling gaussian's footprint, so it does
        // not paint the whole image; the image's own coverage is the reference.
        const { SceneRenderer } = await import('../src/lib/render/index.js');
        const { Vec3 } = await import('playcanvas');
        const renderer = new SceneRenderer(device, source, pool, {
            projection: 'pinhole', ...big, background: { r: 0, g: 0, b: 0, a: 0 }, tier: 'resident'
        });
        await renderer.upload();
        const image = await renderer.render({
            position: new Vec3(0, 0, 6), target: new Vec3(0, 0, 0), up: new Vec3(0, 1, 0),
            fovY: 60 * Math.PI / 180, ...big, near: 0.2
        });
        renderer.destroy();
        let coverage = 0;
        for (let i = 3; i < image.length; i += 4) coverage += image[i] / 255;

        assert.ok(scores.sum[0] > 65536, `the low word wrapped (${scores.sum[0]} pixels)`);
        assert.ok(Math.abs(scores.sum[0] - coverage) / coverage < 0.001, `score ${scores.sum[0]} vs coverage ${coverage}`);
    });

    it('rejects invalid options', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { computeViewScores } = await import('../src/lib/index.js');
        const scene = await makeScene();
        const run = options => computeViewScores(device, scene.source, scene.pool, [camera], options);
        await assert.rejects(run({ width: 0 }), /invalid image size/);
        await assert.rejects(run({ near: 0 }), /near must be positive/);
        await assert.rejects(run({ fov: 180 }), /invalid fov/);
    });
});

describe('filterViewScore', () => {
    const createDevice = () => Promise.resolve(device);
    const action = { kind: 'filterViewScore', cameras: [camera], ...size };

    // Rows of the makeScene groups that the front camera cannot see.
    const unseen = scene => ['hidden', 'behindCamera', 'outside'].reduce((n, g) => n + scene.groups[g][1] - scene.groups[g][0], 0);

    it('drops unseen gaussians from a source and leaves the view unchanged', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { processSourceBridged, materializeToDataTable } = await import('../src/lib/index.js');
        const { SceneRenderer } = await import('../src/lib/render/index.js');
        const { Vec3 } = await import('playcanvas');
        const scene = await makeScene();
        const render = async (source) => {
            const renderer = new SceneRenderer(device, source, scene.pool, {
                projection: 'pinhole', ...size, background: { r: 0, g: 0, b: 0, a: 1 }, tier: 'resident'
            });
            await renderer.upload();
            const image = await renderer.render({
                position: new Vec3(0, 0, 6), target: new Vec3(0, 0, 0), up: new Vec3(0, 1, 0),
                fovY: 60 * Math.PI / 180, ...size, near: 0.2
            });
            renderer.destroy();
            return image;
        };
        const before = await render(scene.source);
        const filtered = await processSourceBridged(scene.source, [action], scene.pool, { createDevice });
        const kept = filtered.meta.lodCounts[0];
        // Everything the camera cannot see goes; so do wall gaussians outside its frustum.
        assert.ok(kept <= scene.n - unseen(scene), `kept ${kept} of ${scene.n}`);
        assert.ok(kept >= scene.groups.front[1] - scene.groups.front[0]);
        const after = await render(filtered);
        assert.deepStrictEqual(after, before, 'removing zero-score gaussians leaves the scored view byte-identical');

        // The filtered source reads back as a consistent table.
        const table = await materializeToDataTable(filtered, scene.pool);
        assert.strictEqual(table.numRows, kept);
    });

    it('matches on the DataTable path', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { processSourceBridged, processDataTable, materializeToDataTable } = await import('../src/lib/index.js');
        const a = await makeScene();
        const b = await makeScene();
        const viaSource = await processSourceBridged(a.source, [action], a.pool, { createDevice });
        const table = await processDataTable(await materializeToDataTable(b.source, b.pool), [action], { createDevice });
        assert.strictEqual(table.numRows, viaSource.meta.lodCounts[0]);
    });

    it('removes more with a higher threshold', async (t) => {
        if (!device) return t.skip('no WebGPU device');
        const { processSourceBridged } = await import('../src/lib/index.js');
        const count = async (minPixels) => {
            const scene = await makeScene();
            const out = await processSourceBridged(scene.source, [{ ...action, minPixels }], scene.pool, { createDevice });
            return out.meta.lodCounts[0];
        };
        const none = await count(0);
        const some = await count(5);
        const all = await count(1e9);
        assert.ok(some < none, `${some} < ${none}`);
        assert.strictEqual(all, 0);
    });

    it('needs a device and valid parameters', async () => {
        const { processSourceBridged, processDataTable, materializeToDataTable } = await import('../src/lib/index.js');
        const scene = await makeScene();
        await assert.rejects(
            processSourceBridged(scene.source, [action], scene.pool),
            /filterViewScore requires a createDevice function/
        );
        await assert.rejects(
            processDataTable(await materializeToDataTable(scene.source, scene.pool), [action]),
            /filterViewScore requires a createDevice function/
        );
        if (!device) return;
        await assert.rejects(
            processSourceBridged(scene.source, [{ ...action, minPixels: -1 }], scene.pool, { createDevice }),
            /minPixels must be a non-negative finite number/
        );
        await assert.rejects(
            processSourceBridged(scene.source, [{ ...action, cameras: [] }], scene.pool, { createDevice }),
            /at least one camera is required/
        );
    });
});
