import { Vec3 } from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

import type { ChunkDataPool, ChunkSource } from '../chunk';
import { computeWriteTransform } from '../data-table';
import { Transform } from '../utils';

import type { RenderCamera } from './camera';
import { SceneRenderer } from './scene-renderer';
import type { SceneTier } from './scene-renderer';

type Vec3Like = { x: number; y: number; z: number };

/** One viewpoint to score from, in the PlayCanvas default space (Y up). */
type ViewScoreCamera = {
    /** Eye position. */
    position: Vec3Like;
    /** Point the camera looks at. */
    target: Vec3Like;
    /** Up vector; default +Y. */
    up?: Vec3Like;
    /** Vertical field of view in degrees; default {@link ViewScoreOptions.fov}. */
    fov?: number;
};

type ViewScoreOptions = {
    /** Width of the scoring image in pixels; default 640. */
    width?: number;
    /** Height of the scoring image in pixels; default 360. */
    height?: number;
    /** Vertical field of view in degrees for cameras without their own; default 60. */
    fov?: number;
    /** Near clip distance in world units; default 0.2. */
    near?: number;
    /** Most GPU bytes the scene may hold; larger scenes are streamed from the source per view. Default: unlimited. */
    residentBudget?: number;
    /** Hold the scene in this tier regardless of fit (tests); default picks the first that fits. */
    tier?: SceneTier;
    /** Called after each view with the number of views done. */
    onProgress?: (done: number, total: number) => void;
};

/** Per-gaussian view scores, indexed by the source's LOD 0 row. */
type ViewScores = {
    /** Contribution summed over all views, in pixels of the scoring image. */
    sum: Float32Array;
    /** Contribution to the single view the gaussian matters most in, in pixels. */
    max: Float32Array;
    /** Views scored. */
    views: number;
    /** Pixels per scoring image, for normalizing. */
    pixels: number;
    /** How the scene was held while scoring. */
    tier: SceneTier;
};

/**
 * Score every gaussian of a scene by how much it contributes to a set of
 * views. A gaussian's contribution to one view is the sum over pixels of its
 * blending weight (transmittance × alpha): the number of pixels it
 * effectively paints. Gaussians that are behind the camera, outside the
 * frustum, hidden behind opaque geometry or too faint to register score 0.
 *
 * The scores are in pixels of the scoring image, so they scale with its
 * size; compare them against `pixels`, or keep the size fixed.
 *
 * A scene that fits the device is held resident on the GPU and costs one
 * render pass per view. A larger one is streamed from the source per view,
 * which is slow: seconds per view for tens of millions of gaussians. Only
 * LOD 0 is scored; view a multi-LOD source through `selectLod` first. The
 * source's pending transform is honoured.
 *
 * @param device - WebGPU graphics device.
 * @param source - The scene.
 * @param pool - Pool for the chunk read buffers.
 * @param cameras - The viewpoints.
 * @param options - Scoring image size, field of view and near plane.
 * @returns The scores by row.
 * @example
 * const scores = await computeViewScores(device, source, pool, [
 *     { position: { x: 0, y: 1, z: 4 }, target: { x: 0, y: 1, z: 0 } }
 * ]);
 * const hidden = scores.sum.filter(s => s === 0).length;
 */
const computeViewScores = async (
    device: GraphicsDevice,
    source: ChunkSource,
    pool: ChunkDataPool,
    cameras: ViewScoreCamera[],
    options: ViewScoreOptions = {}
): Promise<ViewScores> => {
    const width = options.width ?? 640;
    const height = options.height ?? 360;
    const defaultFov = options.fov ?? 60;
    let near = options.near ?? 0.2;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error(`computeViewScores: invalid image size ${width}x${height}`);
    }
    if (!(near > 0)) {
        throw new Error(`computeViewScores: near must be positive, got ${near}`);
    }
    for (const c of cameras) {
        const fov = c.fov ?? defaultFov;
        if (!(fov > 0 && fov < 180)) {
            throw new Error(`computeViewScores: invalid fov ${fov}°. Must be in (0, 180).`);
        }
    }

    // Cameras live in the PlayCanvas default space, the scene in its source
    // space: move the cameras into the scene's rather than baking the scene.
    const delta = computeWriteTransform(source.meta.transform, Transform.IDENTITY);
    const toData = delta ? delta.clone().invert() : null;
    const point = (p: Vec3Like): Vec3 => {
        const v = new Vec3(p.x, p.y, p.z);
        if (toData) toData.transformPoint(v, v);
        return v;
    };
    const dir = (d: Vec3Like): Vec3 => {
        const v = new Vec3(d.x, d.y, d.z);
        if (toData) toData.rotation.transformVector(v, v);
        return v;
    };
    if (toData) near *= toData.scale;

    const scene = new SceneRenderer(device, source, pool, {
        projection: 'pinhole',
        width,
        height,
        background: { r: 0, g: 0, b: 0, a: 0 },
        residentBudget: options.residentBudget,
        tier: options.tier,
        score: true
    });
    try {
        const tier = await scene.upload();
        for (let i = 0; i < cameras.length; i++) {
            const c = cameras[i];
            const camera: RenderCamera = {
                projection: 'pinhole',
                position: point(c.position),
                target: point(c.target),
                up: dir(c.up ?? { x: 0, y: 1, z: 0 }),
                fovY: ((c.fov ?? defaultFov) * Math.PI) / 180,
                width,
                height,
                near
            };
            await scene.accumulateScores([camera]);
            options.onProgress?.(i + 1, cameras.length);
        }
        const totals = await scene.readScores();
        const n = scene.numSplats;
        const sum = new Float32Array(n);
        const max = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            sum[i] = totals[i * 2];
            max[i] = totals[i * 2 + 1];
        }
        return { sum, max, views: cameras.length, pixels: width * height, tier };
    } finally {
        scene.destroy();
    }
};

/**
 * The rows of a scene worth keeping for a set of views: those whose
 * contribution to their best view exceeds `minPixels`. With the default of 0
 * only gaussians that contribute to no view at all are dropped, which leaves
 * every scored view unchanged; a higher threshold also drops faint and tiny
 * gaussians and changes the views slightly.
 *
 * @param device - WebGPU graphics device.
 * @param source - The scene (its LOD 0).
 * @param pool - Pool for the chunk read buffers.
 * @param cameras - The viewpoints.
 * @param options - Scoring options and the `minPixels` threshold.
 * @returns Ascending row indices to keep.
 */
const viewScoreRows = async (
    device: GraphicsDevice,
    source: ChunkSource,
    pool: ChunkDataPool,
    cameras: ViewScoreCamera[],
    options: ViewScoreOptions & { minPixels?: number } = {}
): Promise<Uint32Array> => {
    const minPixels = options.minPixels ?? 0;
    if (!Number.isFinite(minPixels) || minPixels < 0) {
        throw new Error(`filterViewScore: minPixels must be a non-negative finite number, got ${minPixels}`);
    }
    if (cameras.length === 0) {
        throw new Error('filterViewScore: at least one camera is required');
    }
    const { max } = await computeViewScores(device, source, pool, cameras, options);
    const rows = new Uint32Array(max.length);
    let kept = 0;
    for (let i = 0; i < max.length; i++) {
        if (max[i] > minPixels) rows[kept++] = i;
    }
    return rows.slice(0, kept);
};

export { computeViewScores, viewScoreRows, type ViewScoreCamera, type ViewScoreOptions, type ViewScores };
