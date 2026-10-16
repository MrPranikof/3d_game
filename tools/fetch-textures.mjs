// Downloads CC0 photoscanned PBR textures from Poly Haven (polyhaven.com, CC0) for the procedural
// material keys and writes web-sized copies + a manifest:
//   public/textures/<key>_diff.jpg, _nor.jpg, _rough.jpg      public/textures/photo.json
// The manifest gives each key's real-world size (m per texture repeat) so box-projected UVs and
// terrain tiling stay physically scaled.
// usage: node tools/fetch-textures.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

// material key → [Poly Haven id, metres per repeat override (else asset dimensions)]
const PICK = {
  grass_steppe: ['dry_ground_rocks', 3],
  stubble: ['dry_ground_01', 3],
  plowed: ['farm_soil', 2],
  road_dirt: ['park_dirt', 3],
  mud: ['brown_mud_02', 1.3],
  asphalt: ['asphalt_02', 3],
  concrete: ['concrete_floor_worn_001', 3],
  wood_planks: ['old_planks_02', 2],
  bark: ['bark_brown_02', 1],
  brick_raw: ['brick_wall_02', 2],
  slate_roof: ['grey_roof_tiles_02', 1.5],
  plaster_brick: ['white_rough_plaster', 2],
  rust: ['rusty_metal_02', 1],
  corrugated_rust: ['rusty_corrugated_iron', 2],
  logs: ['bark_willow', 1],
  soil: ['brown_mud_dry', 1.3],
};
const RAW = 'assets-src/tex';
const OUT = 'public/textures';
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// curl honours the environment's HTTPS proxy (Node's fetch does not)
const curl = (url, file) => execFileSync('curl', ['-sSfL', '--retry', '5', '--retry-all-errors', '-o', file, url]);
async function get(url, file) {
  if (!fs.existsSync(file)) curl(url, file);
}
const json = (url) => JSON.parse(execFileSync('curl', ['-sSfL', '--retry', '5', '--retry-all-errors', url]).toString());

const manifest = {};
for (const [key, [id, size]] of Object.entries(PICK)) {
  const files = json(`https://api.polyhaven.com/files/${id}`);
  const pick = (names) => { for (const n of names) if (files[n]?.['1k']?.jpg?.url) return files[n]['1k'].jpg.url; return null; };
  const urls = { diff: pick(['Diffuse', 'diff']), nor: pick(['nor_gl', 'Normal']), rough: pick(['Rough', 'rough', 'arm']) };
  for (const [k, u] of Object.entries(urls)) {
    if (!u) { console.warn(key, id, 'no', k); continue; }
    const raw = `${RAW}/${id}_${k}.jpg`;
    await get(u, raw);
    // roughness: Poly Haven "arm" packs AO/rough/metal; plain rough is greyscale
    const img = sharp(raw).resize(k === 'rough' ? 512 : 1024, k === 'rough' ? 512 : 1024);
    const ch = (await sharp(raw).metadata()).channels;
    await (k === 'rough' && /arm/.test(u) && ch >= 3 ? img.extractChannel(1).toColourspace('b-w') : img).jpeg({ quality: k === 'diff' ? 82 : 86, mozjpeg: true }).toFile(`${OUT}/${key}_${k}.jpg`);
  }
  manifest[key] = { id, size, maps: Object.keys(urls).filter((k) => urls[k]) };
  console.log(key.padEnd(16), id.padEnd(26), `${size} m`, manifest[key].maps.join('+'));
}
fs.writeFileSync(`${OUT}/photo.json`, JSON.stringify(manifest, null, 1));
const total = fs.readdirSync(OUT).reduce((s, f) => s + fs.statSync(`${OUT}/${f}`).size, 0);
console.log('total', (total / 1048576).toFixed(1), 'MB — Poly Haven assets are CC0 (polyhaven.com/license)');
