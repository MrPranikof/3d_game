// Rifle from a single side photo (assets-src/refs/*_side.jpg, white background):
// traces the silhouette (outer contour + see-through holes such as the trigger guard), converts it
// to rifle space (metres, barrel along −Z, origin at the top of the pistol grip) and writes
//   public/models/ref/weapon_<id>.json        { outer, holes, uv } for an extruded body
//   public/models/ref/weapon_<id>_albedo.jpg  photo crop, background inpainted from the gun
//   public/models/ref/weapon_<id>_normal.jpg  normal map from luminance
// usage: node tools/weapon-silhouette.mjs tools/refs/weapon_ak.json
import fs from 'node:fs';
import sharp from 'sharp';

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { data, info } = await sharp(cfg.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const s = cfg.length / (cfg.butt - cfg.muzzle[0]); // m per px
const [gx, gy] = cfg.grip;

// ── mask (gun = 1), minus cut-outs (e.g. an optic we replace with our own) ──
let mask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) mask[i] = Math.min(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]) < 222 ? 1 : 0;
for (const [x0, y0, x1, y1] of cfg.cut ?? []) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = 0;
const morph = (m, grow) => {
  const o = m.slice();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const n = m[i - 1] + m[i + 1] + m[i - W] + m[i + W];
    if (grow ? !m[i] && n > 0 : m[i] && n < 4) o[i] = grow ? 1 : 0;
  }
  return o;
};
mask = morph(morph(mask, true), false); // close 1-px gaps

// ── connected components (4-neighbour) ──
function components(m, val) {
  const lab = new Int32Array(W * H).fill(-1), comps = [];
  for (let i = 0; i < W * H; i++) {
    if (m[i] !== val || lab[i] >= 0) continue;
    const id = comps.length, st = [i], px = [];
    lab[i] = id;
    let border = false;
    while (st.length) {
      const k = st.pop(); px.push(k);
      const x = k % W, y = (k - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      for (const n of [k - 1, k + 1, k - W, k + W]) {
        if (n < 0 || n >= W * H || Math.abs((n % W) - x) > 1) continue;
        if (m[n] === val && lab[n] < 0) { lab[n] = id; st.push(n); }
      }
    }
    comps.push({ px, border });
  }
  return comps;
}
const fg = components(mask, 1).sort((a, b) => b.px.length - a.px.length);
const gun = new Uint8Array(W * H);
for (const k of fg[0].px) gun[k] = 1;
// small background islands inside the gun are noise → fill; big ones are real holes
const holesPx = [];
for (const c of components(gun, 0)) {
  if (c.border) continue;
  if (c.px.length < (cfg.minHole ?? 250)) { for (const k of c.px) gun[k] = 1; continue; }
  holesPx.push(c.px);
}

// ── marching squares: longest closed contour of a binary region (pixel-centre grid) ──
const SEG = { 1: [['l', 'b']], 2: [['b', 'r']], 3: [['l', 'r']], 4: [['r', 't']], 5: [['l', 't'], ['r', 'b']], 6: [['b', 't']], 7: [['l', 't']],
  8: [['t', 'l']], 9: [['t', 'b']], 10: [['t', 'r'], ['b', 'l']], 11: [['t', 'r']], 12: [['r', 'l']], 13: [['r', 'b']], 14: [['b', 'l']] };
function trace(region) {
  const v = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? region[y * W + x] : 0);
  const next = new Map();
  const mid = (x, y, e) => (e === 't' ? [2 * x + 1, 2 * y] : e === 'b' ? [2 * x + 1, 2 * y + 2] : e === 'l' ? [2 * x, 2 * y + 1] : [2 * x + 2, 2 * y + 1]);
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const c = v(x, y) * 8 + v(x + 1, y) * 4 + v(x + 1, y + 1) * 2 + v(x, y + 1);
    for (const [a, b] of SEG[c] ?? []) { const p = mid(x, y, a), q = mid(x, y, b); next.set(p.join(','), q); }
  }
  let best = [];
  const seen = new Set();
  for (const k of next.keys()) {
    if (seen.has(k)) continue;
    const loop = [];
    let cur = k;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const [px, py] = cur.split(',').map(Number);
      loop.push([px / 2, py / 2]);
      const n = next.get(cur);
      cur = n ? n.join(',') : null;
    }
    if (loop.length > best.length) best = loop;
  }
  best.push(best[0]);
  return best;
}
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    let best = -1, bd = 0;
    const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const dd = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (dd > bd) { bd = dd; best = i; }
    }
    if (bd > eps) { keep[best] = 1; st.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// closed loop: simplify the two halves separately (Douglas–Peucker needs distinct endpoints)
const simplifyLoop = (loop, eps) => { const h = Math.floor(loop.length / 2); return [...simplify(loop.slice(0, h + 1), eps).slice(0, -1), ...simplify(loop.slice(h), eps).slice(0, -1)]; };
const toRifle = ([x, y]) => [+((x - gx) * s).toFixed(5), +((gy - y) * s).toFixed(5)]; // [z, y]; contour points are in pixel-centre units
const outer = simplifyLoop(trace(gun), cfg.eps ?? 1.1).map(toRifle);
const holes = holesPx.map((px) => { const r = new Uint8Array(W * H); for (const k of px) r[k] = 1; return simplifyLoop(trace(r), cfg.eps ?? 1.1).map(toRifle); });

// ── texture: crop around the gun, background inpainted from the gun pixels ──
const xs = fg[0].px.map((k) => k % W), ys = fg[0].px.map((k) => (k - (k % W)) / W);
const pad = 6;
const X0 = Math.max(0, Math.min(...xs) - pad), X1 = Math.min(W, Math.max(...xs) + pad), Y0 = Math.max(0, Math.min(...ys) - pad), Y1 = Math.min(H, Math.max(...ys) + pad);
const cw = X1 - X0, ch = Y1 - Y0;
const img = Buffer.alloc(cw * ch * 3), known = new Uint8Array(cw * ch);
for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
  const si = ((y + Y0) * W + x + X0), o = y * cw + x;
  img[o * 3] = data[si * 3]; img[o * 3 + 1] = data[si * 3 + 1]; img[o * 3 + 2] = data[si * 3 + 2];
  known[o] = gun[si];
}
// shrink known by 1 px (anti-aliased white edge), then dilate colours outward
for (let pass = 0; pass < 2; pass++) {
  const k2 = known.slice();
  for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) { const o = y * cw + x; if (known[o] && (!known[o - 1] || !known[o + 1] || !known[o - cw] || !known[o + cw])) k2[o] = 0; }
  known.set(k2);
}
for (let changed = true; changed;) {
  changed = false;
  const add = [];
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const o = y * cw + x; if (known[o]) continue;
    let r = 0, g = 0, b = 0, n = 0;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue;
      const q = yy * cw + xx; if (known[q]) { r += img[q * 3]; g += img[q * 3 + 1]; b += img[q * 3 + 2]; n++; }
    }
    if (n) add.push([o, r / n, g / n, b / n]);
  }
  for (const [o, r, g, b] of add) { img[o * 3] = r; img[o * 3 + 1] = g; img[o * 3 + 2] = b; known[o] = 1; changed = true; }
}
const nrm = Buffer.alloc(cw * ch * 3);
const L = (x, y) => { const o = (Math.min(ch - 1, Math.max(0, y)) * cw + Math.min(cw - 1, Math.max(0, x))) * 3; return (0.3 * img[o] + 0.59 * img[o + 1] + 0.11 * img[o + 2]) / 255; };
for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
  const dx = (L(x + 1, y) - L(x - 1, y)) * 3, dy = (L(x, y + 1) - L(x, y - 1)) * 3, l = Math.hypot(dx, dy, 1), o = (y * cw + x) * 3;
  nrm[o] = (-dx / l * 0.5 + 0.5) * 255; nrm[o + 1] = (dy / l * 0.5 + 0.5) * 255; nrm[o + 2] = (1 / l * 0.5 + 0.5) * 255;
}
const out = `public/models/ref/weapon_${cfg.id}`;
await sharp(img, { raw: { width: cw, height: ch, channels: 3 } }).jpeg({ quality: 90 }).toFile(`${out}_albedo.jpg`);
await sharp(nrm, { raw: { width: cw, height: ch, channels: 3 } }).jpeg({ quality: 90 }).toFile(`${out}_normal.jpg`);
// uv: u = u0 + su·z, v = v0 + sv·y  (z, y in rifle metres)
const uv = { u0: (gx - X0) / cw, su: 1 / (s * cw), v0: 1 - (gy - Y0) / ch, sv: 1 / (s * ch) };
fs.writeFileSync(`${out}.json`, JSON.stringify({ id: cfg.id, thickness: cfg.thickness, outer, holes, uv, nodes: cfg.nodes }));
console.log(cfg.id, 'outer', outer.length, 'pts, holes', holes.map((h) => h.length).join('/'), `tex ${cw}×${ch}`, `scale ${(s * 1000).toFixed(3)} mm/px`);
