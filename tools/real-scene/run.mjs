import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
// Pfade über Umgebungsvariablen: SPLAT_TRANSFORM (gebautes Repo), SAMPLE_DATA (Ordner mit <name>.compressed.ply)
const ROOT = process.env.SPLAT_TRANSFORM ?? '/home/user/splat-transform';
const DATA = process.env.SAMPLE_DATA ?? '/home/user/sample-data';
const { WebPCodec } = await import(ROOT + '/dist/index.mjs');
const codec = await WebPCodec.create();
const cli = (args) => execFileSync(process.execPath, [ROOT + '/bin/cli.mjs', '-w', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const count = (file) => +readFileSync(file).subarray(0, 4096).toString('latin1').match(/element vertex (\d+)/)[1];
const psnr = (a, b) => { let se = 0; for (let i = 0; i < a.length; i++) { if (i % 4 === 3) continue; const d = a[i] - b[i]; se += d * d; } const mse = se / (a.length * 3 / 4); return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse); };
const frames = (prefix) => readdirSync('.').filter(f => f.startsWith(prefix + '.') && f.endsWith('.webp')).sort().map(f => codec.decodeRGBA(new Uint8Array(readFileSync(f))).rgba);
const render = (file, track, prefix) => { cli(['-q', file, '--camera-track', track, '--resolution', '640x360', prefix + '.webp']); return frames(prefix); };
const out = [];
for (const name of process.argv.slice(2)) {
    const input = `${DATA}/${name}.compressed.ply`;
    const ref = render(input, `${name}-eval0.json`, `ref-${name}`);
    const n0 = statSync(input).size;
    for (const [track, px] of [['arc0', 0], ['arc0', 0.25], ['arc0', 1], ['orbit', 0]]) {
        const tag = `${name}-${track}-${px}`;
        const t0 = Date.now();
        cli(['-q', input, '--camera-track', `${name}-${track}.json`, '--filter-view-score', String(px), `${tag}.compressed.ply`]);
        const secs = (Date.now() - t0) / 1000;
        const test = render(`${tag}.compressed.ply`, `${name}-eval0.json`, `out-${tag}`);
        const p = ref.map((r, i) => psnr(r, test[i]));
        out.push({ scene: name, views: track, minPixels: px, gaussians: count(`${tag}.compressed.ply`), of: count(input), bytes: statSync(`${tag}.compressed.ply`).size, ofBytes: n0,
            psnrInside: p.slice(0, 6).map(v => +v.toFixed(1)), psnrOpposite: +p[6].toFixed(1), secs: +secs.toFixed(0) });
        console.log(JSON.stringify(out.at(-1)));
    }
}
