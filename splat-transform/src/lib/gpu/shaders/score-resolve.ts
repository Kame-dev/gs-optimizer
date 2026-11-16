/**
 * Fixed-point scale of the per-gaussian contribution counters: a blend of
 * weight `w` adds `round(w × SCORE_SCALE)`. 2¹⁶ resolves weights to 1/131072,
 * far below the faintest blend the rasterizer keeps.
 */
const SCORE_SCALE = 65536;

/**
 * Folds one pass's per-gaussian contribution counters into the running
 * totals. The rasterizer counts by depth rank (the index of its projection
 * records) in two words per rank, low then high; `order` maps a rank back to
 * the gaussian's row. Per row the totals hold two floats: the sum of the
 * contributions over all passes and the largest single pass. The counters
 * are zeroed for the next pass.
 *
 * @returns WGSL source for the score-resolve compute shader.
 */
const scoreResolveWgsl = (): string => /* wgsl */ `
#include "uniformsStruct"

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> order: array<u32>;
@group(0) @binding(2) var<storage, read_write> score: array<u32>;
@group(0) @binding(3) var<storage, read_write> scoreTotals: array<f32>;

@compute @workgroup_size(64)
fn main(
    @builtin(workgroup_id) wgId: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
    @builtin(num_workgroups) numWg: vec3<u32>
) {
    let i = (wgId.y * numWg.x + wgId.x) * 64u + lid.x;
    if (i >= uniforms.numSplats) { return; }
    let lo = score[i * 2u];
    let hi = score[i * 2u + 1u];
    if ((lo | hi) == 0u) { return; }
    score[i * 2u] = 0u;
    score[i * 2u + 1u] = 0u;
    let row = order[i];
    let value = (f32(hi) * 4294967296.0 + f32(lo)) / ${SCORE_SCALE.toFixed(1)};
    scoreTotals[row * 2u] = scoreTotals[row * 2u] + value;
    scoreTotals[row * 2u + 1u] = max(scoreTotals[row * 2u + 1u], value);
}
`;

export { SCORE_SCALE, scoreResolveWgsl };
