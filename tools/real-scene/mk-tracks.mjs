import { writeFileSync } from 'node:fs';
// scene: name, centre (world, y up), radius of the camera arc
const scenes = { biker: { c: [0.05, 1.6, 0], r: 4.5 }, guitar: { c: [-0.2, 2.1, -0.2], r: 6 } };
const arc = (c, r, from, to, n) => Array.from({ length: n }, (_, k) => {
    const a = (from + (to - from) * (n === 1 ? 0 : k / (n - 1))) * Math.PI / 180;
    return { position: [c[0] + r * Math.sin(a), c[1], c[2] + r * Math.cos(a)], target: c, fov: 50 };
});
for (const [name, { c, r }] of Object.entries(scenes)) {
    for (const base of [0, 180]) {
        // viewer restricted to a 120° arc on one side
        writeFileSync(`${name}-arc${base}.json`, JSON.stringify({ frames: arc(c, r, base - 60, base + 60, 13) }));
        // evaluation views inside the arc but between the scored ones, and one from the opposite side
        writeFileSync(`${name}-eval${base}.json`, JSON.stringify({ frames: [...arc(c, r, base - 55, base + 55, 6), ...arc(c, r, base + 180, base + 180, 1)] }));
    }
    writeFileSync(`${name}-orbit.json`, JSON.stringify({ frames: arc(c, r, 0, 330, 12) }));
}
