// Cuts the acacia reference photos (assets-src/refs/acacia_*.webp, white background) out with
// alpha for the crossed-billboard trees: public/models/ref/tree_acacia_cut.png (a | b side by side).
// usage: node tools/foliage-atlas.mjs
import sharp from 'sharp';

const SRC = ['assets-src/refs/acacia_a.webp', 'assets-src/refs/acacia_b.webp'];
// whole-tree cut-outs for crossed-billboard trees: acacia_a | acacia_b side by side, 512×1024 each
const cut = async (file) => {
  const { data, info } = await sharp(file).resize(512, 1024, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const o = Buffer.alloc(512 * 1024 * 4);
  for (let i = 0; i < 512 * 1024; i++) {
    let r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
    const a = Math.max(0, Math.min(1, (232 - Math.min(r, g, b)) / 32));
    if (a > 0.05 && a < 1) { r = (r - (1 - a) * 245) / a; g = (g - (1 - a) * 245) / a; b = (b - (1 - a) * 245) / a; }
    const cl = (v) => Math.max(0, Math.min(255, v));
    o[i * 4] = cl(r); o[i * 4 + 1] = cl(g); o[i * 4 + 2] = cl(b); o[i * 4 + 3] = Math.round(a * 255);
  }
  void info;
  return sharp(o, { raw: { width: 512, height: 1024, channels: 4 } }).png().toBuffer();
};
const [ca, cb] = await Promise.all(SRC.map(cut));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: ca, left: 0, top: 0 }, { input: cb, left: 512, top: 0 }]).png({ compressionLevel: 9 }).toFile('public/models/ref/tree_acacia_cut.png');
console.log('tree cut-outs written');
