import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Reference-projected texturing for procedural vehicles.
 *
 * Orthographic side/top concept images (assets-src/refs, packed by tools/ref-atlas.mjs into one
 * atlas) are projected onto the procedural geometry in its bind pose: faces looking sideways get
 * the side view, faces looking up get the top view, front/back/bottom faces get a plain paint
 * patch cut from the same images. Road wheels share one geometry, so they are mapped around a
 * single reference wheel. UVs are baked, so turret yaw / gun pitch / wheel spin keep the paint.
 */

interface View { u0: number; su: number; v0: number; sv: number }
export interface RefAtlas {
  id: string;
  size: number;
  side: View; // u = u0 + su·z, v = v0 + sv·y
  top: View; // u = u0 + su·z, v = v0 + sv·x
  patch: View & { vMin: number; vMax: number }; // u = u0 + su·x, v = v0 + sv·y
  /** reference road wheel centre (z, y) in vehicle space, for shared wheel geometry */
  wheel?: [number, number];
}

// constants printed by tools/ref-atlas.mjs
export const REF_ATLASES: Record<string, RefAtlas> = {
  t72b3: {
    id: 't72b3', size: 2048,
    side: { u0: 1164.8, su: 211.97, v0: 801.79, sv: -211.97 },
    top: { u0: 892, su: -208, v0: 1235, sv: 208 },
    patch: { u0: 1024, su: 150, v0: 1853.5, sv: -150, vMin: 1661, vMax: 2046 },
    wheel: [-0.54, 0.5],
  },
  leo2a6: {
    id: 'leo2a6', size: 2048,
    side: { u0: 1213, su: 197.6, v0: 928, sv: -197.6 },
    top: { u0: 759, su: -165.6, v0: 1342, sv: 165.6 },
    patch: { u0: 1024, su: 150, v0: 1874, sv: -150, vMin: 1702, vMax: 2046 },
    wheel: [-0.8, 0.45],
  },
};

const NO_PROJECT_MATS = /^(track_links|glass_optic|cage_net|emissive|interior_shell|rust)/;
const NO_PROJECT_NODES = new Set(['Cage', 'Interior_Cockpit', 'Interior_Gunner']);

const textures = new Map<string, { map: THREE.Texture; normal: THREE.Texture }>();
let preload: Promise<void> | null = null;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`ref texture ${url} failed to load`));
    im.src = url;
  });
}

/** Load every atlas once; builders then use them synchronously. Missing files → plain paint. */
export function preloadRefTextures(): Promise<void> {
  preload ??= Promise.all(Object.keys(REF_ATLASES).map(async (id) => {
    try {
      const base = `${import.meta.env.BASE_URL}models/ref/${id}`;
      const [a, n] = await Promise.all([loadImage(`${base}_albedo.jpg`), loadImage(`${base}_normal.jpg`)]);
      const map = new THREE.Texture(a);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 8;
      const normal = new THREE.Texture(n);
      for (const t of [map, normal]) { t.flipY = true; t.generateMipmaps = true; t.needsUpdate = true; }
      textures.set(id, { map, normal });
    } catch (e) {
      console.warn(e);
    }
  })).then(() => undefined);
  return preload;
}

export function hasRefTexture(id: string): boolean {
  return textures.has(id);
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function refMaterial(id: string): THREE.MeshStandardMaterial {
  let m = matCache.get(id);
  if (!m) {
    const t = textures.get(id)!;
    m = new THREE.MeshStandardMaterial({ name: `ref_${id}`, map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.82, metalness: 0.15 });
    matCache.set(id, m);
  }
  return m;
}

/**
 * Re-material + UV-project every eligible mesh under `root` (vehicle space = root space, bind pose).
 * Call after the whole vehicle is assembled and before flattening.
 */
export function applyRefProjection(root: THREE.Object3D, id: string): void {
  const atlas = REF_ATLASES[id];
  if (!atlas || !textures.has(id)) return;
  const mat = refMaterial(id);
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const done = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();

  const skip = (o: THREE.Object3D): boolean => {
    for (let a: THREE.Object3D | null = o; a && a !== root; a = a.parent) if (NO_PROJECT_NODES.has(a.name)) return true;
    return false;
  };
  const wheelNode = (o: THREE.Object3D): THREE.Object3D | null => {
    for (let a: THREE.Object3D | null = o.parent; a && a !== root; a = a.parent) if (/^(Wheel|Roller)_/.test(a.name)) return a;
    return null;
  };

  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !Array.isArray(m.material) && !NO_PROJECT_MATS.test(m.material.name) && !skip(m)) meshes.push(m); });

  for (const mesh of meshes) {
    const wn = wheelNode(mesh);
    // shared wheel geometry: map around the node origin onto the reference wheel
    const toVehicle = new THREE.Matrix4();
    if (wn && atlas.wheel) {
      const local = new THREE.Matrix4().copy(wn.matrixWorld).invert().multiply(mesh.matrixWorld);
      toVehicle.makeTranslation(0, atlas.wheel[1], atlas.wheel[0]).multiply(local);
    } else {
      toVehicle.multiplyMatrices(rootInv, mesh.matrixWorld);
    }
    const cached = wn ? done.get(mesh.geometry) : undefined;
    if (cached) { mesh.geometry = cached; mesh.material = mat; continue; }
    const g = project(mesh.geometry, toVehicle, atlas);
    if (wn) done.set(mesh.geometry, g);
    mesh.geometry = g;
    mesh.material = mat;
  }
}

function project(src: THREE.BufferGeometry, m: THREE.Matrix4, a: RefAtlas): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const S = a.size;
  for (let t = 0; t < pos.count; t += 3) {
    for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(pos, t + k).applyMatrix4(m);
    n.crossVectors(e1.subVectors(p[1], p[0]), e2.subVectors(p[2], p[0]));
    if (n.lengthSq() < 1e-14) { // degenerate: use the stored normal if any
      if (g.attributes.normal) n.fromBufferAttribute(g.attributes.normal, t).applyMatrix3(nm);
      else n.set(0, 1, 0);
    }
    n.normalize();
    const ax = Math.abs(n.x), ay = Math.abs(n.y);
    for (let k = 0; k < 3; k++) {
      const { x, y, z } = p[k];
      let u: number, v: number;
      if (n.y > 0.55 && n.y >= ax) { u = a.top.u0 + a.top.su * z; v = a.top.v0 + a.top.sv * x; }
      else if (ax >= 0.45 && ax >= ay * 0.9) { u = a.side.u0 + a.side.su * z; v = a.side.v0 + a.side.sv * y; }
      else { u = a.patch.u0 + a.patch.su * x; v = Math.min(a.patch.vMax, Math.max(a.patch.vMin, a.patch.v0 + a.patch.sv * y)); }
      uv[(t + k) * 2] = u / S;
      uv[(t + k) * 2 + 1] = 1 - v / S;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  return mergeVertices(g, 1e-5);
}
