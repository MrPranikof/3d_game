// Builds a projection atlas for a reference-textured vehicle from orthographic side/top images
// (assets-src/refs/*). Layout (2048×2048): side view strip, top view strip, plain-paint patch.
// Background is inpainted from the object so projected faces that land slightly outside the
// silhouette never pick up white. Also writes a tangent-space normal map from luminance.
//
// usage: node tools/ref-atlas.mjs tools/refs/t72b3.json
// The config gives, for each view, the pixel crop and the image→vehicle mapping
//   side: px = a + b·z, py = c + d·y        top: px = a + b·z, py = c + d·x
// and the script prints the atlas-space constants for src/assets/procedural/RefTexture.ts.
import sharp from 'sharp';
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const S = 2048;

async function load(file, crop, width) {
  const [x0, y0, x1, y1] = crop;
  const k = width / (x1 - x0);
  const h = Math.round((y1 - y0) * k);
  const { data } = await sharp(file).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).resize(width, h).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: width, h, k };
}

/** Fill background (near-white) pixels from the nearest object pixels by iterative dilation. */
function inpaint(img) {
  const { data, w, h } = img;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = Math.min(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) < 222 ? 1 : 0;
  // erode the mask to drop the painted black outline and its anti-aliased halo
  for (let pass = 0; pass < (img.erode ?? 7); pass++) {
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

const side = inpaint(await load(cfg.side.file, cfg.side.crop, S));
const top = inpaint(await load(cfg.top.file, cfg.top.crop, S));
const patchH = S - side.h - top.h;
if (patchH < 160) throw new Error(`atlas overflow: side ${side.h} + top ${top.h}`);
const [px0, py0, px1, py1] = cfg.patch.crop; // plain paint region (source px of patch.file, default: top image)
const { data: patchData } = await sharp(cfg.patch.file ?? cfg.top.file).extract({ left: px0, top: py0, width: px1 - px0, height: py1 - py0 })
  .resize(S, patchH, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });

const atlas = Buffer.alloc(S * S * 3);
side.data.copy(atlas, 0);
top.data.copy(atlas, side.h * S * 3);
patchData.copy(atlas, (side.h + top.h) * S * 3);

// normal map from blurred luminance (painted outlines read as shallow grooves)
const lum = new Float32Array(S * S);
for (let i = 0; i < S * S; i++) lum[i] = (0.3 * atlas[i * 3] + 0.59 * atlas[i * 3 + 1] + 0.11 * atlas[i * 3 + 2]) / 255;
const nrm = Buffer.alloc(S * S * 3);
const st = cfg.normalStrength ?? 2.5;
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const L = (xx, yy) => lum[Math.min(S - 1, Math.max(0, yy)) * S + Math.min(S - 1, Math.max(0, xx))];
  const dx = (L(x + 1, y) - L(x - 1, y)) * st, dy = (L(x, y + 1) - L(x, y - 1)) * st;
  const l = Math.hypot(dx, dy, 1);
  const i = (y * S + x) * 3;
  nrm[i] = ((-dx / l) * 0.5 + 0.5) * 255; nrm[i + 1] = ((dy / l) * 0.5 + 0.5) * 255; nrm[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
}
fs.mkdirSync(cfg.outDir, { recursive: true });
await sharp(atlas, { raw: { width: S, height: S, channels: 3 } }).jpeg({ quality: 88 }).toFile(`${cfg.outDir}/${cfg.id}_albedo.jpg`);
await sharp(nrm, { raw: { width: S, height: S, channels: 3 } }).blur(0.6).jpeg({ quality: 90 }).toFile(`${cfg.outDir}/${cfg.id}_normal.jpg`);

// atlas-space constants: u = u0 + su·(z), v = v0 + sv·(y or x), in atlas pixels
const view = (v, img, vOff) => ({
  u0: (v.map[0] - v.crop[0]) * img.k, su: v.map[1] * img.k,
  v0: vOff + (v.map[2] - v.crop[1]) * img.k, sv: v.map[3] * img.k,
});
const out = {
  size: S,
  side: view(cfg.side, side, 0),
  top: view(cfg.top, top, side.h),
  patch: { u0: S / 2, su: cfg.patch.pxPerM, v0: side.h + top.h + patchH / 2, sv: -cfg.patch.pxPerM, vMin: side.h + top.h + 2, vMax: S - 2 },
};
const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(2) : r(v)]));
console.log(JSON.stringify(r(out)));
