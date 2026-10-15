// Step 1 of importing a Tripo GLB: decode, weld, simplify, downsize textures, normalise to
// 1 unit = 1 m with feet at y=0, centred, facing −Z.
// usage: node tools/tripo-prep.mjs in.glb out.glb --height 1.8 --tris 12000 --tex 1024 [--rot degY] [--flip]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, weld, simplify, textureCompress, prune, dedup, getBounds, unpartition } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const [, , inp, out, ...rest] = process.argv;
const arg = (k, d) => { const i = rest.indexOf('--' + k); return i < 0 ? d : (rest[i + 1] ?? true); };
const rot = (+arg('rot', 0) * Math.PI) / 180, cr = Math.cos(rot), sr = Math.sin(rot);
const height = +arg('height', 1.8), tris = +arg('tris', 12000), tex = +arg('tex', 1024), flip = rest.includes('--flip');
const length = arg('length', null); // for vehicles: normalise by longest horizontal extent

await MeshoptDecoder.ready; await MeshoptEncoder.ready; await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(inp);
for (const e of doc.getRoot().listExtensionsUsed()) if (/quantization|meshopt/.test(e.extensionName)) e.dispose();
await doc.transform(dequantize());

const countTris = () => doc.getRoot().listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((a, p) => a + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0), 0);
const before = countTris();
await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, tris / before), error: 0.05, lockBorder: false }));
console.log('tris', before, '->', countTris());

// bake node transforms + normalise
const scene = doc.getRoot().listScenes()[0];
const b = getBounds(scene);
const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
const s = length ? +length / Math.max(size[0], size[2]) : height / size[1];
const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2, y0 = b.min[1];
for (const node of doc.getRoot().listNodes()) {
  const m = node.getMesh(); if (!m) continue;
  const wm = node.getWorldMatrix();
  for (const p of m.listPrimitives()) {
    const pos = p.getAttribute('POSITION'), nor = p.getAttribute('NORMAL');
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      const x = wm[0] * v[0] + wm[4] * v[1] + wm[8] * v[2] + wm[12];
      const y = wm[1] * v[0] + wm[5] * v[1] + wm[9] * v[2] + wm[13];
      const z = wm[2] * v[0] + wm[6] * v[1] + wm[10] * v[2] + wm[14];
      const f = flip ? -1 : 1, px = f * (x - cx) * s, pz = f * (z - cz) * s;
      pos.setElement(i, [px * cr + pz * sr, (y - y0) * s, -px * sr + pz * cr]);
      if (nor) {
        nor.getElement(i, v);
        let nx = wm[0] * v[0] + wm[4] * v[1] + wm[8] * v[2], ny = wm[1] * v[0] + wm[5] * v[1] + wm[9] * v[2], nz = wm[2] * v[0] + wm[6] * v[1] + wm[10] * v[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        nx *= f / l; nz *= f / l;
        nor.setElement(i, [nx * cr + nz * sr, ny / l, -nx * sr + nz * cr]);
      }
    }
  }
  node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}
for (const n of doc.getRoot().listNodes()) if (!n.getMesh()) n.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [tex, tex], quality: 85, slots: /baseColor|metallicRoughness|occlusion/ }),
  textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [tex, tex], quality: 92, slots: /normal/ }),
  dedup(), prune(), unpartition(),
);
await io.write(out, doc);
console.log('scale', s.toFixed(4), 'size m', size.map((x) => (x * s).toFixed(2)).join(' x '));
