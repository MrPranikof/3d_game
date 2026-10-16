import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import refAtlases from './refAtlases.json';

/**
 * Reference-projected texturing for procedural vehicles.
 *
 * Orthographic side/top concept images (assets-src/refs, packed by tools/ref-atlas.mjs into one
 * atlas) are projected onto the procedural geometry in its bind pose: faces looking sideways get
 * the side view, faces looking up get the top view, front/back/bottom faces get a plain paint
 * patch cut from the same images. Road wheels share one geometry, so they are mapped around a
 * single reference wheel. UVs are baked, so turret yaw / gun pitch / wheel spin keep the paint.
 */

type Axis = 'x' | 'y' | 'z';
interface View { normal: Axis; u: Axis; v: Axis; u0: number; su: number; v0: number; sv: number; range?: [Axis, number, number]; minScore?: number }
export interface RefAtlas {
  w: number;
  h: number;
  /** faces pick the view whose `normal` axis their normal points along most */
  views: View[];
  /** plain paint for faces no view covers (fronts of tanks, undersides, interiors) */
  patch: { u: Axis | 'xz'; v: Axis; u0: number; su: number; v0: number; sv: number; vMin: number; vMax: number };
  /** reference road wheel centre (z, y) in vehicle space, for shared wheel geometry */
  wheel?: [number, number];
  /** atlas rows [y0, y1) of each view strip (debug) */
  strips?: [number, number][];
  /** buildings: faces pointing into the footprint (interior wall sides) get the plain patch */
  inward?: boolean;
  /** node names left with their procedural materials */
  skipNodes?: string[];
}

// written by tools/ref-atlas.mjs
export const REF_ATLASES = refAtlases as unknown as Record<string, RefAtlas>;

const NO_PROJECT_MATS = /^(track_links|glass_optic|cage_net|emissive|interior_shell|rust|brick_raw|bark_charred)/;
const NO_PROJECT_NODES = new Set(['Cage', 'Interior_Cockpit', 'Interior_Gunner', 'Partition', 'Floor']);

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

/** Dev aid (tools/preview.html?dbg=<id>): flat colour per atlas strip to see which view each face uses. */
export function debugRefStrips(id: string): void {
  const a = REF_ATLASES[id], t = textures.get(id);
  if (!a?.strips || !t) return;
  const cv = document.createElement('canvas');
  cv.width = a.w; cv.height = a.h;
  const g = cv.getContext('2d')!;
  ['#d33', '#3b3', '#36d', '#dd3', '#d3d'].forEach((c, i) => { const s = a.strips![i]; if (s) { g.fillStyle = c; g.fillRect(0, s[0], a.w, s[1] - s[0]); } });
  g.fillStyle = '#888'; g.fillRect(0, a.patch.vMin - 2, a.w, a.h);
  t.map.image = cv; t.map.needsUpdate = true;
}

// ── photo trees (tools/foliage-atlas.mjs) ──
let treeTex: { cut: THREE.Texture } | null = null;
let treePreload: Promise<void> | null = null;

export function preloadTreeTextures(): Promise<void> {
  treePreload ??= (async () => {
    try {
      const base = `${import.meta.env.BASE_URL}models/ref/`;
      const cut = new THREE.Texture(await loadImage(`${base}tree_acacia_cut.png`));
      cut.colorSpace = THREE.SRGBColorSpace; cut.anisotropy = 4; cut.needsUpdate = true;
      treeTex = { cut };
    } catch (e) {
      console.warn(e);
    }
  })();
  return treePreload;
}

export function hasTreeTextures(): boolean {
  return treeTex !== null;
}

let cutMat: THREE.MeshStandardMaterial | null = null;
/** Cut-out acacia photos (left/right halves of the texture) for crossed-billboard trees. */
export function treeCutMaterial(): THREE.MeshStandardMaterial {
  return (cutMat ??= new THREE.MeshStandardMaterial({ name: 'ref_tree_cut', map: treeTex!.cut, color: 0xb8b8b8, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 }));
}

// ── photo-silhouette rifles (tools/weapon-silhouette.mjs) ──
export interface WeaponRef {
  thickness: number;
  outer: [number, number][];
  holes: [number, number][][];
  uv: { u0: number; su: number; v0: number; sv: number };
  nodes: Record<string, [number, number, number]>;
  material: THREE.MeshStandardMaterial;
  edgeMaterial: THREE.MeshStandardMaterial;
}
const weapons = new Map<string, WeaponRef>();
let weaponPreload: Promise<void> | null = null;
export function preloadWeaponRefs(): Promise<void> {
  weaponPreload ??= Promise.all(['ak', 'ar'].map(async (id) => {
    try {
      const base = `${import.meta.env.BASE_URL}models/ref/weapon_${id}`;
      const [data, a, n] = await Promise.all([fetch(`${base}.json`).then((r) => r.json()), loadImage(`${base}_albedo.jpg`), loadImage(`${base}_normal.jpg`)]);
      const map = new THREE.Texture(a), normal = new THREE.Texture(n);
      map.colorSpace = THREE.SRGBColorSpace;
      for (const t of [map, normal]) { t.anisotropy = 8; t.needsUpdate = true; }
      const material = new THREE.MeshStandardMaterial({ name: `ref_weapon_${id}`, map, normalMap: normal, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.65, metalness: 0.2, envMapIntensity: 0.5 }); // grazing sky reflections read as blue streaks
      const edgeMaterial = new THREE.MeshStandardMaterial({ name: `ref_weapon_edge_${id}`, color: 0x232425, roughness: 0.85, metalness: 0.1, envMapIntensity: 0.35 });
      weapons.set(id, { ...data, material, edgeMaterial });
    } catch (e) {
      console.warn('weapon ref', id, e);
    }
  })).then(() => undefined);
  return weaponPreload;
}
export function weaponRef(id: string): WeaponRef | undefined {
  return weapons.get(id);
}

export function hasRefTexture(id: string): boolean {
  return textures.has(id);
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function refMaterial(id: string): THREE.MeshStandardMaterial {
  let m = matCache.get(id);
  if (!m) {
    const t = textures.get(id)!;
    m = new THREE.MeshStandardMaterial({ name: `ref_${id}`, map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.85, metalness: 0.03 });
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
    for (let a: THREE.Object3D | null = o; a && a !== root; a = a.parent) if (NO_PROJECT_NODES.has(a.name) || atlas.skipNodes?.includes(a.name)) return true;
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
    const { g, interior } = project(mesh.geometry, toVehicle, atlas);
    if (wn) done.set(mesh.geometry, g);
    if (interior) {
      const inside = new THREE.Mesh(interior, mesh.material);
      inside.name = `${mesh.name}_inside`;
      inside.position.copy(mesh.position); inside.quaternion.copy(mesh.quaternion); inside.scale.copy(mesh.scale);
      inside.castShadow = mesh.castShadow; inside.receiveShadow = mesh.receiveShadow;
      mesh.parent?.add(inside);
    }
    mesh.geometry = g;
    mesh.material = mat;
  }
}

/** Returns the projected geometry and, for buildings, the interior-side triangles with their
 *  original UVs (they keep the procedural/photo material instead of the atlas patch). */
function project(src: THREE.BufferGeometry, m: THREE.Matrix4, a: RefAtlas): { g: THREE.BufferGeometry; interior: THREE.BufferGeometry | null } {
  const g = src.index ? src.toNonIndexed() : src.clone();
  const inner: number[] = [];
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3(), c = new THREE.Vector3();
  const pick = (q: THREE.Vector3, ax: Axis | 'xz') => (ax === 'xz' ? q.x + q.z : q[ax]);
  for (let t = 0; t < pos.count; t += 3) {
    for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(pos, t + k).applyMatrix4(m);
    // prefer authored normals: sliver triangles (extrusions with holes) give noisy cross products
    if (g.attributes.normal) {
      n.set(0, 0, 0);
      for (let k = 0; k < 3; k++) n.add(e1.fromBufferAttribute(g.attributes.normal, t + k));
      n.applyMatrix3(nm);
    } else n.crossVectors(e1.subVectors(p[1], p[0]), e2.subVectors(p[2], p[0]));
    if (n.lengthSq() < 1e-14) n.set(0, 1, 0);
    n.normalize();
    c.copy(p[0]).add(p[1]).add(p[2]).multiplyScalar(1 / 3);
    let best: View | null = null, score = -1;
    for (const v of a.views) {
      if (v.range && (c[v.range[0]] < v.range[1] || c[v.range[0]] > v.range[2])) continue;
      const sc = v.normal === 'y' ? (n.y > 0.55 ? n.y : 0) : Math.abs(n[v.normal]);
      if (sc >= (v.minScore ?? 0.45) && sc > score) { score = sc; best = v; }
    }
    if (best && a.inward) {
      // horizontal normal pointing back towards the footprint centre → interior side of a wall
      if (n.x * c.x + n.z * c.z < -0.05 && Math.abs(n.y) < 0.6) { inner.push(t); continue; }
    }
    for (let k = 0; k < 3; k++) {
      let u: number, v: number;
      if (best) { u = best.u0 + best.su * p[k][best.u]; v = best.v0 + best.sv * p[k][best.v]; }
      else { const P = a.patch; u = P.u0 + P.su * pick(p[k], P.u); v = Math.min(P.vMax, Math.max(P.vMin, P.v0 + P.sv * p[k][P.v])); }
      uv[(t + k) * 2] = u / a.w;
      uv[(t + k) * 2 + 1] = 1 - v / a.h;
    }
  }
  const srcUV = g.attributes.uv as THREE.BufferAttribute | undefined;
  let interior: THREE.BufferGeometry | null = null;
  if (inner.length && srcUV) {
    const take = (attr: THREE.BufferAttribute) => {
      const out = new Float32Array(inner.length * 3 * attr.itemSize);
      inner.forEach((t, i) => out.set((attr.array as Float32Array).subarray(t * attr.itemSize, (t + 3) * attr.itemSize), i * 3 * attr.itemSize));
      return new THREE.BufferAttribute(out, attr.itemSize);
    };
    interior = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) if (g.attributes[name]) interior.setAttribute(name, take(g.attributes[name] as THREE.BufferAttribute));
    interior = mergeVertices(interior, 1e-5);
    // drop those triangles from the projected geometry (degenerate them)
    const P = g.attributes.position as THREE.BufferAttribute;
    for (const t of inner) for (let k = 1; k < 3; k++) P.setXYZ(t + k, P.getX(t), P.getY(t), P.getZ(t));
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  return { g: mergeVertices(g, 1e-5), interior };
}
