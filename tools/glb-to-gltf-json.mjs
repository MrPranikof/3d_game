// Repack a .glb as a self-contained glTF JSON (buffers/images as data: URIs) so it can be served
// from hosts that only allow plain data types. GLTFLoader reads it like any .gltf.
// usage: node tools/glb-to-gltf-json.mjs in.glb out.json
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'node:fs';
const [, , inp, out] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const { json, resources } = await io.writeJSON(doc);
const mime = (u) => (/\.png$/i.test(u) ? 'image/png' : /\.jpe?g$/i.test(u) ? 'image/jpeg' : 'application/octet-stream');
for (const b of json.buffers ?? []) b.uri = `data:application/octet-stream;base64,${Buffer.from(resources[b.uri]).toString('base64')}`;
for (const im of json.images ?? []) if (im.uri && resources[im.uri]) im.uri = `data:${mime(im.uri)};base64,${Buffer.from(resources[im.uri]).toString('base64')}`;
fs.writeFileSync(out, JSON.stringify(json));
console.log(out, fs.statSync(out).size);
