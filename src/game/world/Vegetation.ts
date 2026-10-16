import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import { attribute, float, instanceIndex, mix, positionLocal, positionWorld, sin, smoothstep, time, vec3 } from 'three/tsl';
import type { AssetTemplate } from '../../assets/pipeline/ModelLoader';
import type { MaterialLibrary } from '../../assets/procedural/MaterialLibrary';
import { RNG } from '../../assets/procedural/noise';
import { G, type Physics } from '../core/Physics';
import { distToPolyline, HALF, MAP_SIZE, type MapLayout } from './MapLayout';
import type { Terrain } from './Terrain';

/**
 * Windbreak tree lines and yard trees via GPU instancing: per tree type and material one
 * InstancedMesh for near (LOD0) and one for far (LOD2) → a few dozen draw calls for ~300 trees.
 * Trees can be felled by explosions / tanks (instance hidden, an animated falling copy spawned).
 * Grass tufts are scattered in a ring around the camera and recycled as it moves.
 */

interface Layer { geometry: THREE.BufferGeometry; material: THREE.Material }
interface TreeType { id: string; near: Layer[]; far: Layer[]; nearMeshes: THREE.InstancedMesh[]; farMeshes: THREE.InstancedMesh[]; height: number }
export interface Tree { type: TreeType; matrix: THREE.Matrix4; pos: THREE.Vector3; alive: boolean; collider?: RAPIER.Collider; index: number }

const NEAR = 75;
const GRASS_KEEP = 0.9;
interface GrassRing { mesh: THREE.InstancedMesh; r0: number; r1: number; cell: number; scale: number }
const FAR = 520;

export class Vegetation {
  readonly group = new THREE.Group();
  readonly trees: Tree[] = [];
  private types = new Map<string, TreeType>();
  private falling: { obj: THREE.Object3D; axis: THREE.Vector3; t: number; pivot: THREE.Vector3; base: THREE.Quaternion }[] = [];
  private timer = 0;
  private grassRings: GrassRing[] = [];
  private grassCenter = new THREE.Vector2(1e9, 1e9);
  /** per 0.5 m cell: 0 unknown, 1 grass allowed, 2 blocked (road / building) — filled lazily */
  private grassMask = new Uint8Array((MAP_SIZE * 2) * (MAP_SIZE * 2));

  constructor(private physics: Physics, private terrain: Terrain, private layout: MapLayout) {
    this.group.name = 'Vegetation';
  }

  registerType(id: string, t: AssetTemplate, maxInstances: number): void {
    const collect = (level: number): Layer[] => {
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      t.scene.updateMatrixWorld(true);
      t.scene.traverse((o) => {
        const lod = o as THREE.LOD;
        if (!lod.isLOD) return;
        const lv = lod.levels[Math.min(level, lod.levels.length - 1)].object as THREE.Mesh;
        if (!lv.isMesh) return;
        const g = lv.geometry.clone();
        lv.updateWorldMatrix(true, false);
        g.applyMatrix4(lv.matrixWorld);
        const list = byMat.get(lv.material as THREE.Material) ?? [];
        list.push(g);
        byMat.set(lv.material as THREE.Material, list);
      });
      return [...byMat].map(([material, geoms]) => ({ material, geometry: mergeIndexed(geoms) }));
    };
    const near = collect(0), far = collect(2);
    const mk = (l: Layer, shadow: boolean) => {
      const m = new THREE.InstancedMesh(l.geometry, l.material, maxInstances);
      m.count = 0;
      m.castShadow = shadow;
      // photo billboards self-shadow into black sheets when seen edge-on
      m.receiveShadow = (l.material as THREE.Material).name !== 'ref_tree_cut';
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    const box = new THREE.Box3().setFromObject(t.scene);
    this.types.set(id, { id, near, far, nearMeshes: near.map((l) => mk(l, true)), farMeshes: far.map((l) => mk(l, false)), height: box.max.y });
  }

  plant(): void {
    const rng = new RNG('trees');
    const add = (id: string, x: number, z: number, rot: number, scale: number) => {
      const type = this.types.get(id);
      if (!type) return;
      const y = this.terrain.heightAt(x, z) - 0.15;
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(scale, scale * rng.range(0.9, 1.15), scale));
      const tree: Tree = { type, matrix: m, pos: new THREE.Vector3(x, y, z), alive: true, index: this.trees.length };
      const desc = this.physics.R.ColliderDesc.cylinder(3, 0.32 * scale).setTranslation(x, y + 3, z);
      tree.collider = this.physics.fixed(desc, { kind: 'tree', ref: tree }, G.TREE);
      this.trees.push(tree);
    };
    for (const line of this.layout.treelines) {
      for (let s = 0; s < line.pts.length - 1; s++) {
        const [ax, az] = line.pts[s], [bx, bz] = line.pts[s + 1];
        const len = Math.hypot(bx - ax, bz - az);
        for (let d = 0; d < len; d += line.spacing * rng.range(0.8, 1.25)) {
          if (rng.chance(0.08)) continue; // gaps blown in the tree line
          const x = ax + ((bx - ax) * d) / len + rng.range(-1.5, 1.5);
          const z = az + ((bz - az) * d) / len + rng.range(-1.5, 1.5);
          add(rng.pick(line.kinds), x, z, rng.range(0, Math.PI * 2), rng.range(0.85, 1.15));
        }
      }
    }
    for (const t of this.layout.yardTrees) add(t.id, t.x, t.z, t.rot, rng.range(0.8, 1.05));
  }

  /**
   * Grass tufts around the camera: real blade geometry (no alpha cards), dark at the root and
   * sun-bleached at the tip, normals pointing up so they shade like the ground they grow from,
   * per-instance green/dry tint, and a wind sway in the vertex stage.
   * Two rings: dense fine tufts close by, sparser tufts of fewer/wider blades further out.
   */
  initGrass(_mats: MaterialLibrary, quality: 'mobile' | 'desktop' | 'ultra'): void {
    const mat = new THREE.MeshStandardNodeMaterial({ name: 'grass_blades', side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    const h = attribute('grassH', 'float'); // 0 at root … 1 at tip
    const seed = float(instanceIndex).mul(0.137);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node chains
    const sway: any = sin(time.mul(1.7).add(positionWorld.x.mul(0.35)).add(positionWorld.z.mul(0.27)).add(seed)).mul(0.07)
      .add(sin(time.mul(3.1).add(seed.mul(5))).mul(0.025)).mul(h.mul(h));
    mat.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6)));
    // late-summer steppe palette (linear): straw / ochre / olive per blade, dark at the root
    const c = attribute('grassC', 'float');
    const straw = vec3(0.62, 0.5, 0.16), ochre = vec3(0.5, 0.36, 0.09), olive = vec3(0.2, 0.3, 0.05); // sunlit WoT-like steppe
    const tip = mix(mix(olive, ochre, smoothstep(0.0, 0.5, c)), straw, smoothstep(0.5, 1.0, c));
    mat.colorNode = mix(vec3(0.06, 0.07, 0.02), tip, smoothstep(0.0, 0.6, h)); // instanceColor tint is applied by the renderer
    const cfg = {
      mobile: { near: 7, far: 20, nearBlades: 10, farBlades: 5 },
      desktop: { near: 11, far: 30, nearBlades: 14, farBlades: 6 },
      ultra: { near: 14, far: 36, nearBlades: 18, farBlades: 7 },
    }[quality];
    const ring = (r0: number, r1: number, cell: number, blades: number, widen: number, near: boolean): GrassRing => {
      const cap = Math.ceil((Math.PI * (r1 * r1 - r0 * r0) * GRASS_KEEP) / (cell * cell) * 1.08);
      const m = new THREE.InstancedMesh(grassTuftGeometry(blades, widen), mat, cap);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      m.count = 0;
      m.frustumCulled = false;
      m.receiveShadow = near; // far tufts skip shadow lookups
      this.group.add(m);
      return { mesh: m, r0, r1, cell, scale: near ? 1 : 1.25 };
    };
    this.grassRings = [ring(0, cfg.near, 0.5, cfg.nearBlades, 1, true), ring(cfg.near, cfg.far, 0.85, cfg.farBlades, 2.2, false)];
  }

  /** No grass through house / hangar floors (footprints in building-local axes, small margin). */
  private insideBuilding(x: number, z: number): boolean {
    for (const b of this.layout.buildings) {
      const half = b.id === 'hangar' ? [9.2, 15.2] : [3.8, 4.7];
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx) > 18 || Math.abs(dz) > 18) continue;
      const c = Math.cos(b.rot), s = Math.sin(b.rot);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < half[0] && Math.abs(lz) < half[1]) return true;
    }
    return false;
  }

  private grassAllowed(i: number, j: number, x: number, z: number): boolean {
    const gi = i + MAP_SIZE, gj = j + MAP_SIZE; // cell = 0.5 m, so ±HALF m → 0 … 2·MAP_SIZE
    if (gi < 0 || gj < 0 || gi >= MAP_SIZE * 2 || gj >= MAP_SIZE * 2) return false;
    const k = gj * MAP_SIZE * 2 + gi;
    let v = this.grassMask[k];
    if (!v) {
      const blocked = Math.abs(x) > HALF || this.layout.roads.some((r) => distToPolyline(x, z, r.pts) < r.width * 0.6) || this.insideBuilding(x, z);
      v = this.grassMask[k] = blocked ? 2 : 1;
    }
    return v === 1;
  }

  private scatterGrass(cx: number, cz: number): void {
    const col = new THREE.Color();
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const ring of this.grassRings) {
      const { mesh: m, r0, r1, cell } = ring;
      const cap = m.instanceMatrix.count;
      let k = 0;
      const i0 = Math.floor((cx - r1) / cell), i1 = Math.floor((cx + r1) / cell);
      const j0 = Math.floor((cz - r1) / cell), j1 = Math.floor((cz + r1) / cell);
      for (let j = j0; j <= j1 && k < cap; j++) {
        for (let i = i0; i <= i1 && k < cap; i++) {
          const h = hash2(i, j);
          if (h > GRASS_KEEP) continue;
          const x = (i + hash2(i + 7, j)) * cell, z = (j + hash2(i, j + 7)) * cell;
          const d2 = (x - cx) ** 2 + (z - cz) ** 2;
          if (d2 > r1 * r1 || d2 < r0 * r0) continue;
          if (!this.grassAllowed(Math.floor(x * 2), Math.floor(z * 2), x, z)) continue;
          p.set(x, this.terrain.heightAt(x, z) - 0.05, z);
          q.setFromAxisAngle(up, h * 40);
          const sc = (0.85 + hash2(j, i) * 0.5) * ring.scale;
          s.set(sc, sc * (0.7 + h * 0.9), sc);
          // patchy steppe: a little greener in places, brightness jitter per tuft
          const green = Math.min(1, Math.max(0, Math.sin(x * 0.045) * Math.cos(z * 0.038) * 0.8 + (hash2(i + 3, j + 5) - 0.5) * 0.4));
          const v = 0.85 + hash2(i + 11, j + 13) * 0.3;
          col.setRGB(v * (1 - green * 0.25), v, v * (1 - green * 0.1));
          m.setColorAt(k, col);
          m.setMatrixAt(k++, mat.compose(p, q, s));
        }
      }
      m.count = k;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  update(dt: number, camera: THREE.Camera): void {
    this.timer -= dt;
    const cp = camera.getWorldPosition(new THREE.Vector3());
    if (this.timer <= 0) {
      this.timer = 0.3;
      for (const type of this.types.values()) {
        let n = 0, f = 0;
        for (const t of this.trees) {
          if (t.type !== type || !t.alive) continue;
          const d = t.pos.distanceTo(cp);
          if (d < NEAR) { for (const m of type.nearMeshes) m.setMatrixAt(n, t.matrix); n++; }
          else if (d < FAR) { for (const m of type.farMeshes) m.setMatrixAt(f, t.matrix); f++; }
        }
        for (const m of type.nearMeshes) { m.count = n; m.instanceMatrix.needsUpdate = true; }
        for (const m of type.farMeshes) { m.count = f; m.instanceMatrix.needsUpdate = true; }
      }
    }
    if (this.grassRings.length && Math.hypot(cp.x - this.grassCenter.x, cp.z - this.grassCenter.y) > 4) {
      this.grassCenter.set(cp.x, cp.z);
      this.scatterGrass(cp.x, cp.z);
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t = Math.min(1, f.t + dt / 2.2);
      const ang = (Math.PI / 2 - 0.1) * f.t * f.t;
      const q = new THREE.Quaternion().setFromAxisAngle(f.axis, ang).multiply(f.base);
      f.obj.quaternion.copy(q);
      if (f.t >= 1) this.falling.splice(i, 1);
    }
  }

  /** Fell a tree away from `from`. */
  fell(tree: Tree, from: THREE.Vector3): void {
    if (!tree.alive) return;
    tree.alive = false;
    this.timer = 0;
    if (tree.collider) { this.physics.removeCollider(tree.collider); tree.collider = undefined; }
    const obj = new THREE.Group();
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    tree.matrix.decompose(pos, quat, scl);
    obj.position.copy(pos);
    obj.quaternion.copy(quat);
    obj.scale.copy(scl);
    for (const l of tree.type.near) {
      const m = new THREE.Mesh(l.geometry, l.material);
      m.castShadow = true;
      obj.add(m);
    }
    this.group.add(obj);
    const away = pos.clone().sub(from).setY(0).normalize();
    if (away.lengthSq() < 0.01) away.set(1, 0, 0);
    const axis = new THREE.Vector3(away.z, 0, -away.x).normalize();
    this.falling.push({ obj, axis, t: 0, pivot: pos.clone(), base: quat.clone() });
  }

  near(p: THREE.Vector3, r: number): Tree[] {
    return this.trees.filter((t) => t.alive && Math.hypot(t.pos.x - p.x, t.pos.z - p.z) < r);
  }
}

function hash2(i: number, j: number): number {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function mergeIndexed(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'uv'].filter((n) => geoms.every((g) => g.attributes[n]));
  let vcount = 0, icount = 0;
  for (const g of geoms) { vcount += g.attributes.position.count; icount += g.index ? g.index.count : g.attributes.position.count; }
  for (const n of names) {
    const size = geoms[0].attributes[n].itemSize;
    const arr = new Float32Array(vcount * size);
    let o = 0;
    for (const g of geoms) {
      const a = g.attributes[n];
      for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) arr[o++] = a.getComponent(i, c);
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  const idx = new Uint32Array(icount);
  let o = 0, base = 0;
  for (const g of geoms) {
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[o++] = g.index.getX(i) + base;
    else for (let i = 0; i < g.attributes.position.count; i++) idx[o++] = i + base;
    base += g.attributes.position.count;
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** One tuft of `blades` tapered, slightly curved blades (2 segments each); attributes grassH = 0…1 up the blade. */
function grassTuftGeometry(blades: number, widen = 1): THREE.BufferGeometry {
  const pos: number[] = [], hs: number[] = [], cs: number[] = [], idx: number[] = [];
  const rng = new RNG(1234);
  for (let b = 0; b < blades; b++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(0, 0.2);
    const tone = rng.next();
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const tall = rng.next() < 0.12; // occasional seed stems above the carpet
    const yaw = rng.range(0, Math.PI * 2), lean = rng.range(0.05, tall ? 0.15 : 0.45), len = tall ? rng.range(0.6, 0.9) : rng.range(0.25, 0.5), w = rng.range(0.005, 0.01) * widen;
    const dx = Math.cos(yaw), dz = Math.sin(yaw); // lean direction
    const px = -dz, pz = dx; // blade width direction
    const base = pos.length / 3;
    const segs = 2;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, y = len * t, off = lean * len * t * t, ww = w * (1 - t * 0.85);
      for (const sgn of [-1, 1]) {
        pos.push(bx + dx * off + px * ww * sgn, y * (1 - lean * 0.25 * t), bz + dz * off + pz * ww * sgn);
        hs.push(t);
        cs.push(tone);
      }
    }
    for (let i = 0; i < segs; i++) {
      const v = base + i * 2;
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('grassH', new THREE.Float32BufferAttribute(hs, 1));
  g.setAttribute('grassC', new THREE.Float32BufferAttribute(cs, 1));
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1; // up-facing normals: lit like the ground
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
