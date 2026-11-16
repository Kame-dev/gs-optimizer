// side-by-side crops (2x) of reference and filtered frames, written as PNG via playwright-free raw PPM->webp using the codec
import { readFileSync, writeFileSync } from 'node:fs';
const { WebPCodec } = await import((process.env.SPLAT_TRANSFORM ?? '/home/user/splat-transform') + '/dist/index.mjs');
const codec = await WebPCodec.create();
const [, , out, ...files] = process.argv;
const imgs = files.map(f => codec.decodeRGBA(new Uint8Array(readFileSync(f))));
const x0 = 230, y0 = 20, w = 180, h = 320, s = 2;
const W = w * s * imgs.length, H = h * s;
const rgba = new Uint8Array(W * H * 4);
imgs.forEach((im, k) => { for (let y = 0; y < H; y++) for (let x = 0; x < w * s; x++) { const sx = x0 + (x / s | 0), sy = y0 + (y / s | 0); const si = (sy * im.width + sx) * 4, di = (y * W + k * w * s + x) * 4; rgba.set(im.rgba.subarray(si, si + 4), di); } });
writeFileSync(out, await codec.encodeLosslessRGBA(rgba, W, H));
