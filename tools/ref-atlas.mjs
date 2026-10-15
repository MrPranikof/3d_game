// Builds a projection atlas for a reference-textured asset from orthographic concept images
// (assets-src/refs/*) and records its mapping in src/assets/procedural/refAtlases.json.
//
// usage: node tools/ref-atlas.mjs tools/refs/<id>.json
//
// Config: { id, outDir, views: [View], patch: { file?, crop, pxPerM, u, v }, wheel?, inward?, normalStrength? }
//   View = { file, crop: [x0,y0,x1,y1], normal: 'x'|'y'|'z', u: axis, v: axis, map: [a, b, c, d], range?: [axis, min, max] }
//   meaning: faces whose normal points mostly along `normal` sample this view at
//   px = a + b·(model `u` coordinate), py = c + d·(model `v` coordinate)   (source image pixels, metres);
//   `range` limits a view to faces whose centroid lies in [min, max] along an axis (piecewise fits).
// Views are stacked as horizontal strips (each scaled to the atlas width), the plain-paint patch
// goes last. Background is inpainted from the object so faces that land slightly outside the
// painted silhouette never pick up white. Also writes a tangent-space normal map from luminance.
import sharp from 'sharp';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const W = 2048, PATCH_H = cfg.patch.height ?? 256;

async function load(file, crop, width) {
  const [x0, y0, x1, y1] = crop;
  const k = width / (x1 - x0);
  const h = Math.round((y1 - y0) * k);
  const { data } = await sharp(file).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).resize(width, h).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: width, h, k };
}

/** Fill background (near-white) pixels from the nearest object pixels by iterative dilation. */
function inpaint(img, erode) {
  const { data, w, h } = img;
  // background = near-white pixels connected to the image border (white plaster inside the
  // silhouette is not background)
  const known = new Uint8Array(w * h).fill(1);
  const white = (i) => Math.min(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) >= 222;
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (!known[i] || !white(i)) continue;
    known[i] = 0;
    const x = i % w, y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  // erode the mask to drop the painted black outline and its anti-aliased halo
  for (let pass = 0; pass < erode; pass++) {
    const k2 = known.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (known[i] && (!known[i - 1] || !known[i + 1] || !known[i - w] || !known[i + w])) k2[i] = 0;
    }
    known.set(k2);
  }
  let frontier = true;
  while (frontier) {
    frontier = false;
    const add = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (known[j]) { r += data[j * 3]; g += data[j * 3 + 1]; b += data[j * 3 + 2]; n++; }
      }
      if (n) add.push([i, r / n, g / n, b / n]);
    }
    for (const [i, r, g, b] of add) { data[i * 3] = r; data[i * 3 + 1] = g; data[i * 3 + 2] = b; known[i] = 1; frontier = true; }
  }
  return img;
}

const strips = [];
// a strip is at most 2.5× its source width (narrow crops stay narrow and short)
for (const v of cfg.views) strips.push(inpaint(await load(v.file, v.crop, Math.min(W, Math.round((v.crop[2] - v.crop[0]) * 2.5))), cfg.erode ?? 7));
const H = Math.ceil((strips.reduce((s, x) => s + x.h, 0) + PATCH_H) / 4) * 4;
const patchH = H - strips.reduce((s, x) => s + x.h, 0);
const [px0, py0, px1, py1] = cfg.patch.crop;
const { data: patchData } = await sharp(cfg.patch.file ?? cfg.views[0].file).extract({ left: px0, top: py0, width: px1 - px0, height: py1 - py0 })
  .resize(W, patchH, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });

const atlas = Buffer.alloc(W * H * 3);
let off = 0;
const views = [], stripRows = [];
cfg.views.forEach((v, i) => {
  const s = strips[i];
  for (let y = 0; y < s.h; y++) s.data.copy(atlas, ((off + y) * W) * 3, y * s.w * 3, (y + 1) * s.w * 3);
  views.push({ normal: v.normal, u: v.u, v: v.v, u0: (v.map[0] - v.crop[0]) * s.k, su: v.map[1] * s.k, v0: off + (v.map[2] - v.crop[1]) * s.k, sv: v.map[3] * s.k, ...(v.range ? { range: v.range } : {}), ...(v.minScore !== undefined ? { minScore: v.minScore } : {}) });
  stripRows.push([off, off + s.h]);
  off += s.h;
});
patchData.copy(atlas, off * W * 3);

// normal map from luminance (painted outlines read as shallow grooves)
const lum = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) lum[i] = (0.3 * atlas[i * 3] + 0.59 * atlas[i * 3 + 1] + 0.11 * atlas[i * 3 + 2]) / 255;
const nrm = Buffer.alloc(W * H * 3);
const st = cfg.normalStrength ?? 2.5;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const L = (xx, yy) => lum[Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx))];
  const dx = (L(x + 1, y) - L(x - 1, y)) * st, dy = (L(x, y + 1) - L(x, y - 1)) * st;
  const l = Math.hypot(dx, dy, 1);
  const i = (y * W + x) * 3;
  nrm[i] = ((-dx / l) * 0.5 + 0.5) * 255; nrm[i + 1] = ((dy / l) * 0.5 + 0.5) * 255; nrm[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
}
fs.mkdirSync(cfg.outDir, { recursive: true });
await sharp(atlas, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 88 }).toFile(`${cfg.outDir}/${cfg.id}_albedo.jpg`);
await sharp(nrm, { raw: { width: W, height: H, channels: 3 } }).blur(0.6).jpeg({ quality: 90 }).toFile(`${cfg.outDir}/${cfg.id}_normal.jpg`);

const r2 = (o) => (typeof o === 'number' ? +o.toFixed(2) : Array.isArray(o) ? o.map(r2) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)])) : o);
const entry = r2({
  w: W, h: H, views, strips: stripRows,
  patch: { u: cfg.patch.u ?? 'x', v: cfg.patch.v ?? 'y', u0: W / 2, su: cfg.patch.pxPerM, v0: off + patchH / 2, sv: -cfg.patch.pxPerM, vMin: off + 2, vMax: H - 2 },
  ...(cfg.wheel ? { wheel: cfg.wheel } : {}),
  ...(cfg.inward ? { inward: true } : {}),
  ...(cfg.skipNodes ? { skipNodes: cfg.skipNodes } : {}),
});
const registry = 'src/assets/procedural/refAtlases.json';
const all = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, 'utf8')) : {};
all[cfg.id] = entry;
fs.writeFileSync(registry, JSON.stringify(Object.fromEntries(Object.entries(all).sort()), null, 1) + '\n');
console.log(cfg.id, JSON.stringify(entry));
