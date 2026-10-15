import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

/**
 * Object3D → hierarchical .glb → optimised .glb (EXT_meshopt_compression + quantisation).
 *
 * Image encoding is the expensive part of exporting, and the material library shares the same
 * texture set across dozens of assets. So every texture is encoded ONCE per session
 * (TextureEncodeCache); the exporter only sees tiny placeholders whose width encodes the
 * texture's slot, and the real bytes are spliced back in with gltf-transform.
 */

let ioPromise: Promise<WebIO> | null = null;

function getIO(): Promise<WebIO> {
  ioPromise ??= (async () => {
    await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
    return new WebIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  })();
  return ioPromise;
}

interface Encoded { bytes: Uint8Array; mime: string }

export class TextureEncodeCache {
  private map = new Map<string, Promise<Encoded>>();

  encode(tex: THREE.Texture, maxSize: number): Promise<Encoded> {
    const mime = (tex.userData.mimeType as string) ?? 'image/png';
    const key = `${tex.name || tex.uuid}|${mime}|${maxSize}`;
    let p = this.map.get(key);
    if (!p) {
      p = encodeImage(tex.image as CanvasImageSource & { width: number; height: number }, mime, maxSize);
      this.map.set(key, p);
    }
    return p;
  }

  get size(): number {
    return this.map.size;
  }
}

async function encodeImage(img: CanvasImageSource & { width: number; height: number }, mime: string, maxSize: number): Promise<Encoded> {
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if ((img instanceof HTMLCanvasElement || (typeof OffscreenCanvas !== 'undefined' && img instanceof OffscreenCanvas)) && img.width <= maxSize) {
    canvas = img;
  } else {
    const s = Math.min(maxSize, img.width);
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = s;
    (canvas.getContext('2d') as CanvasRenderingContext2D).drawImage(img, 0, 0, s, s);
  }
  const quality = mime === 'image/jpeg' ? 0.9 : undefined;
  const blob: Blob | null = canvas instanceof HTMLCanvasElement
    ? await new Promise((r) => canvas.toBlob(r, mime, quality))
    : await (canvas as OffscreenCanvas).convertToBlob({ type: mime, quality });
  if (!blob) throw new Error('texture encode failed');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
}

export async function exportGLB(root: THREE.Object3D, animations: THREE.AnimationClip[], maxTextureSize: number, cache: TextureEncodeCache): Promise<Uint8Array> {
  // collect textures and swap in slot placeholders (width = slot + 1, height = 1)
  const textures: THREE.Texture[] = [];
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!m || !(o as THREE.Mesh).isMesh) return;
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.emissiveMap, m.aoMap]) if (t && !textures.includes(t)) textures.push(t);
  });
  const encoded = await Promise.all(textures.map((t) => cache.encode(t, maxTextureSize)));
  const originals = textures.map((t) => ({ image: t.image, mime: t.userData.mimeType }));
  textures.forEach((t, i) => {
    const c = document.createElement('canvas');
    c.width = i + 1;
    c.height = 1;
    t.image = c;
    t.userData.mimeType = 'image/png';
  });

  let result: ArrayBuffer | object;
  try {
    result = await new GLTFExporter().parseAsync(root, { binary: true, animations, onlyVisible: false, maxTextureSize: 4096 });
  } finally {
    textures.forEach((t, i) => { t.image = originals[i].image; t.userData.mimeType = originals[i].mime; });
  }
  if (!(result instanceof ArrayBuffer)) throw new Error('GLTFExporter did not return binary output');

  if (!textures.length) return new Uint8Array(result);
  const io = await getIO();
  const doc = await io.readBinary(new Uint8Array(result));
  for (const tex of doc.getRoot().listTextures()) {
    const size = tex.getSize();
    const slot = size ? size[0] - 1 : -1;
    const enc = encoded[slot];
    if (!enc || size![1] !== 1) continue;
    tex.setImage(enc.bytes).setMimeType(enc.mime).setName(textures[slot].name);
  }
  return io.writeBinary(doc);
}

export interface OptimizeResult {
  bytes: Uint8Array;
  rawSize: number;
  optimizedSize: number;
}

export async function optimizeGLB(glb: Uint8Array, compress = true): Promise<OptimizeResult> {
  const io = await getIO();
  const doc = await io.readBinary(glb);
  const transforms = [
    dedup(),
    // keep empty anchor nodes (Muzzle, Cam_*, Grip_Point …) and authored extras
    prune({ keepLeaves: true, keepAttributes: true, keepExtras: true }),
  ];
  if (compress) transforms.push(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await doc.transform(...transforms);
  const bytes = await io.writeBinary(doc);
  return { bytes, rawSize: glb.byteLength, optimizedSize: bytes.byteLength };
}
