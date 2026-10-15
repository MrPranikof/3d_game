import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { QualitySettings } from '../StylePreset';
import type { MaterialLibrary } from './MaterialLibrary';

/**
 * Geometry kit for the built-in generator.
 *
 * Builders describe a model as named nodes (pivots that gameplay animates) holding parts.
 * Each PartBuilder collects primitives, bakes metre-scaled box-projected UVs (uniform texel
 * density across ALL assets), and merges everything that shares a material into one mesh —
 * so a whole tank turret is a handful of draw calls.
 */

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Translation + Euler rotation (radians, XYZ) + scale → Matrix4. */
export function T(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

export const deg = THREE.MathUtils.degToRad;

/** Create an empty pivot node and attach it. */
export function node(name: string, parent: THREE.Object3D | null, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  g.rotation.set(rx, ry, rz);
  parent?.add(g);
  return g;
}

interface Item {
  geom: THREE.BufferGeometry;
  mat: string;
  bone?: number;
  parentBone?: number;
  blend?: { head: THREE.Vector3; dir: THREE.Vector3; len: number };
}

export class Kit {
  constructor(readonly mats: MaterialLibrary, readonly q: QualitySettings) {}

  get radial(): number {
    return this.q.radial;
  }

  // ───────── primitives (all centred at origin) ─────────
  box(w: number, h: number, d: number, bevel = 0): THREE.BufferGeometry {
    if (bevel > 0) return new RoundedBoxGeometry(w, h, d, 1, Math.min(bevel, Math.min(w, h, d) * 0.49));
    return new THREE.BoxGeometry(w, h, d);
  }
  /** Cylinder along Y. */
  cyl(rTop: number, rBot: number, h: number, seg = this.radial, open = false): THREE.BufferGeometry {
    return new THREE.CylinderGeometry(rTop, rBot, h, Math.max(5, seg), 1, open);
  }
  /** Cylinder along Z (barrels, axles pointing forward). */
  cylZ(r: number, h: number, seg = this.radial, rEnd = r): THREE.BufferGeometry {
    return this.cyl(rEnd, r, h, seg).rotateX(-Math.PI / 2);
  }
  /** Cylinder along X (wheels, rollers). */
  cylX(r: number, h: number, seg = this.radial): THREE.BufferGeometry {
    return this.cyl(r, r, h, seg).rotateZ(Math.PI / 2);
  }
  sphere(r: number, seg = this.radial, phiLen = Math.PI * 2, thetaLen = Math.PI): THREE.BufferGeometry {
    return new THREE.SphereGeometry(r, Math.max(6, seg), Math.max(4, Math.floor(seg / 2)), 0, phiLen, 0, thetaLen);
  }
  capsule(r: number, len: number, seg = this.radial): THREE.BufferGeometry {
    return new THREE.CapsuleGeometry(r, len, Math.max(2, Math.floor(seg / 4)), Math.max(6, seg));
  }
  torus(r: number, tube: number, seg = this.radial, arc = Math.PI * 2): THREE.BufferGeometry {
    return new THREE.TorusGeometry(r, tube, Math.max(4, Math.floor(seg / 2)), Math.max(6, seg), arc);
  }
  /** Surface of revolution around Y; profile order is normalised so faces always point outward. */
  lathe(profile: [number, number][], seg = this.radial): THREE.BufferGeometry {
    const pts = profile[0][1] > profile[profile.length - 1][1] ? [...profile].reverse() : profile;
    return new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), Math.max(6, seg));
  }
  /** Extrude a 2D polygon (x,y) along +Z by depth, re-centred on Z. */
  extrude(points: [number, number][], depth: number, bevel = 0, holes: [number, number][][] = []): THREE.BufferGeometry {
    const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    const g = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 1,
      curveSegments: 6,
    });
    g.translate(0, 0, -depth / 2);
    return g;
  }
  /** Side-profile extrusion: polygon in (z, y) extruded across X — hulls, stocks, receivers. */
  profileX(pointsZY: [number, number][], width: number, bevel = 0): THREE.BufferGeometry {
    return this.extrude(pointsZY, width, bevel).rotateY(-Math.PI / 2);
  }
  /** Top-view extrusion: polygon in (x, z) extruded upward along Y from y=0. */
  profileY(pointsXZ: [number, number][], height: number, bevel = 0): THREE.BufferGeometry {
    return this.extrude(pointsXZ.map(([x, z]) => [x, -z] as [number, number]), height, bevel).rotateX(-Math.PI / 2).translate(0, height / 2, 0);
  }
  /** Tapered tube along a curve (trunks, branches, cables, straps). */
  tube(curve: THREE.Curve<THREE.Vector3>, r0: number, r1: number, segs = 8, radial = Math.max(5, Math.floor(this.radial / 2)), capEnd = true): THREE.BufferGeometry {
    const frames = curve.computeFrenetFrames(segs, false);
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    const length = curve.getLength();
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = curve.getPointAt(t);
      const r = THREE.MathUtils.lerp(r0, r1, t);
      const N = frames.normals[i], B = frames.binormals[i];
      for (let j = 0; j <= radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const cx = Math.cos(a), sx = Math.sin(a);
        const nx = cx * N.x + sx * B.x, ny = cx * N.y + sx * B.y, nz = cx * N.z + sx * B.z;
        pos.push(p.x + r * nx, p.y + r * ny, p.z + r * nz);
        nrm.push(nx, ny, nz);
        uv.push((j / radial) * Math.PI * 2 * Math.max(r0, 0.05), t * length);
      }
    }
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * (radial + 1) + j, b = a + radial + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    if (capEnd) {
      const end = curve.getPointAt(1);
      const c = pos.length / 3;
      const tng = curve.getTangentAt(1);
      pos.push(end.x, end.y, end.z); nrm.push(tng.x, tng.y, tng.z); uv.push(0.5, 0.5);
      const base = segs * (radial + 1);
      for (let j = 0; j < radial; j++) idx.push(base + j, c, base + j + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }
  /** Flat quad in XY facing +Z (cards, nets, decals). */
  quad(w: number, h: number): THREE.BufferGeometry {
    return new THREE.PlaneGeometry(w, h);
  }
  /** Lattice of thin bars spanning a rectangle in XZ (cages, grilles). */
  grid(w: number, d: number, nx: number, nz: number, bar: number): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    // nx/nz = number of cells; 0 means "no bars along that axis"
    if (nx > 0) for (let i = 0; i <= nx; i++) parts.push(new THREE.BoxGeometry(bar, bar, d).translate(-w / 2 + (w * i) / nx, 0, 0));
    if (nz > 0) for (let i = 0; i <= nz; i++) parts.push(new THREE.BoxGeometry(w, bar, bar).translate(0, 0, -d / 2 + (d * i) / nz));
    return merge(parts);
  }
}

export function merge(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geoms.map(normalizeAttributes);
  const g = mergeGeometries(prepared, false);
  if (!g) throw new Error('Kit.merge: incompatible geometries');
  return g;
}

function normalizeAttributes(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(out.attributes)) {
    if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(name)) out.deleteAttribute(name);
  }
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2));
  out.morphAttributes = {};
  out.clearGroups();
  return out;
}

/** Overwrite UVs with box projection in metres / tile (per-triangle dominant axis). */
function boxProjectUV(g: THREE.BufferGeometry, tile: number): void {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const inv = 1 / tile;
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(b.clone().sub(a)).normalize();
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u: number, v: number;
      if (ax >= ay && ax >= az) { u = p.z * Math.sign(n.x || 1); v = p.y; }
      else if (ay >= az) { u = p.x; v = p.z; }
      else { u = -p.x * Math.sign(n.z || 1); v = p.y; }
      uv.setXY(i + k, u * inv, v * inv);
    }
  }
  uv.needsUpdate = true;
}

/**
 * Collects primitives for ONE animated node and emits merged meshes (one per material).
 * The produced meshes are always leaf children of the node so that the pivot itself never
 * carries geometry transforms (important for glTF quantisation and LOD siblings).
 */
export class PartBuilder {
  protected items: Item[] = [];
  constructor(protected readonly kit: Kit) {}

  add(geom: THREE.BufferGeometry, mat: string, m?: THREE.Matrix4): this {
    const g = normalizeAttributes(geom);
    if (m) g.applyMatrix4(m);
    this.items.push({ geom: g, mat });
    return this;
  }

  /** Mirror-symmetric placement helper: adds at (x, …) and (−x, …). */
  addMirrored(geom: THREE.BufferGeometry, mat: string, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    this.add(geom, mat, T(x, y, z, rx, ry, rz));
    this.add(geom, mat, T(-x, y, z, rx, -ry, -rz));
    return this;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  protected mergedByMaterial(): Map<string, THREE.BufferGeometry> {
    const byMat = new Map<string, THREE.BufferGeometry[]>();
    for (const it of this.items) {
      const def = this.kit.mats.def(it.mat);
      if (!def.authoredUV) boxProjectUV(it.geom, def.tile);
      const list = byMat.get(it.mat) ?? [];
      list.push(it.geom);
      byMat.set(it.mat, list);
    }
    const out = new Map<string, THREE.BufferGeometry>();
    for (const [mat, list] of byMat) {
      const merged = mergeGeometries(list, false);
      if (!merged) throw new Error(`PartBuilder: failed to merge material ${mat}`);
      const indexed = mergeVertices(merged, 1e-5);
      indexed.computeBoundingBox();
      indexed.computeBoundingSphere();
      out.set(mat, indexed);
    }
    return out;
  }

  /** Emit meshes into `target` (a pivot node). */
  emit(target: THREE.Object3D, opts: { castShadow?: boolean; receiveShadow?: boolean } = {}): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [mat, geom] of this.mergedByMaterial()) {
      const mesh = new THREE.Mesh(geom, this.kit.mats.get(mat));
      mesh.name = `${target.name}_m_${mat}`;
      mesh.castShadow = opts.castShadow ?? true;
      mesh.receiveShadow = opts.receiveShadow ?? true;
      target.add(mesh);
      meshes.push(mesh);
    }
    this.items = [];
    return meshes;
  }
}

/**
 * Skinned variant for the humanoid rig: each primitive is bound to a bone; limb segments
 * blend smoothly into their parent bone near the joint.
 */
export class SkinnedPartBuilder extends PartBuilder {
  constructor(kit: Kit, private readonly bones: THREE.Bone[]) {
    super(kit);
  }

  private boneIndex(name: string): number {
    const i = this.bones.findIndex((b) => b.name === name);
    if (i < 0) throw new Error(`SkinnedPartBuilder: unknown bone ${name}`);
    return i;
  }

  /** Add geometry expressed in the bone's local space (bind pose). */
  addToBone(geom: THREE.BufferGeometry, mat: string, bone: string, local?: THREE.Matrix4, blendWithParent = false): this {
    const bi = this.boneIndex(bone);
    const b = this.bones[bi];
    b.updateWorldMatrix(true, false);
    const m = b.matrixWorld.clone();
    if (local) m.multiply(local);
    const g = normalizeAttributes(geom);
    g.applyMatrix4(m);
    const item: Item = { geom: g, mat, bone: bi };
    if (blendWithParent && b.parent instanceof THREE.Bone) {
      item.parentBone = this.bones.indexOf(b.parent);
      const head = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
      const child = b.children.find((c) => c instanceof THREE.Bone) as THREE.Bone | undefined;
      const tail = child ? new THREE.Vector3().setFromMatrixPosition(child.matrixWorld) : head.clone().add(new THREE.Vector3(0, -0.2, 0));
      const dir = tail.clone().sub(head);
      const len = dir.length() || 0.2;
      item.blend = { head, dir: dir.normalize(), len };
    }
    this.items.push(item);
    return this;
  }

  private applySkin(): void {
    const v = new THREE.Vector3();
    for (const it of this.items) {
      const count = it.geom.attributes.position.count;
      const si = new Uint16Array(count * 4);
      const sw = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        si[i * 4] = it.bone ?? 0;
        sw[i * 4] = 1;
        if (it.blend && it.parentBone !== undefined && it.parentBone >= 0) {
          v.fromBufferAttribute(it.geom.attributes.position as THREE.BufferAttribute, i).sub(it.blend.head);
          const t = v.dot(it.blend.dir) / it.blend.len;
          const wp = THREE.MathUtils.clamp(0.5 - t / 0.3, 0, 0.5);
          if (wp > 0) {
            si[i * 4 + 1] = it.parentBone;
            sw[i * 4] = 1 - wp;
            sw[i * 4 + 1] = wp;
          }
        }
      }
      it.geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      it.geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    }
  }

  emitSkinned(target: THREE.Object3D, skeleton: THREE.Skeleton): THREE.SkinnedMesh[] {
    this.applySkin();
    const meshes: THREE.SkinnedMesh[] = [];
    for (const [mat, geom] of this.mergedByMaterial()) {
      const mesh = new THREE.SkinnedMesh(geom, this.kit.mats.get(mat));
      mesh.name = `${target.name}_m_${mat}`;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      target.add(mesh);
      mesh.bind(skeleton, new THREE.Matrix4());
      meshes.push(mesh);
    }
    this.items = [];
    return meshes;
  }
}

export function quickBuild(kit: Kit, target: THREE.Object3D, fn: (p: PartBuilder) => void): THREE.Mesh[] {
  const p = new PartBuilder(kit);
  fn(p);
  return p.emit(target);
}
