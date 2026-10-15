import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { AssetTemplate } from '../../assets/pipeline/ModelLoader';
import type { MaterialLibrary } from '../../assets/procedural/MaterialLibrary';
import { RNG } from '../../assets/procedural/noise';
import { G, type Physics } from '../core/Physics';
import { distToPolyline, type MapLayout } from './MapLayout';
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
const FAR = 520;

export class Vegetation {
  readonly group = new THREE.Group();
  readonly trees: Tree[] = [];
  private types = new Map<string, TreeType>();
  private falling: { obj: THREE.Object3D; axis: THREE.Vector3; t: number; pivot: THREE.Vector3; base: THREE.Quaternion }[] = [];
  private timer = 0;
  private grass?: THREE.InstancedMesh;
  private grassCenter = new THREE.Vector2(1e9, 1e9);

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
      m.receiveShadow = true;
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

  /** Grass tufts (crossed cards) around the camera. */
  initGrass(mats: MaterialLibrary, count: number): void {
    const card = new THREE.PlaneGeometry(0.9, 0.55).translate(0, 0.27, 0);
    const card2 = card.clone().rotateY(Math.PI / 2);
    const g = mergeIndexed([card, card2]);
    // upward-ish normals → soft lighting
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const m = new THREE.InstancedMesh(g, mats.get('grass_tuft'), count);
    m.count = 0;
    m.frustumCulled = false;
    m.receiveShadow = true;
    this.grass = m;
    this.group.add(m);
  }

  private scatterGrass(cx: number, cz: number): void {
    const m = this.grass!;
    const cap = m.instanceMatrix.count;
    const R = 32, cell = 1.25;
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let k = 0;
    const i0 = Math.floor((cx - R) / cell), i1 = Math.floor((cx + R) / cell);
    const j0 = Math.floor((cz - R) / cell), j1 = Math.floor((cz + R) / cell);
    for (let j = j0; j <= j1 && k < cap; j++) {
      for (let i = i0; i <= i1 && k < cap; i++) {
        const h = hash2(i, j);
        if (h > 0.55) continue;
        const x = (i + hash2(i + 7, j)) * cell, z = (j + hash2(i, j + 7)) * cell;
        if ((x - cx) ** 2 + (z - cz) ** 2 > R * R) continue;
        if (this.layout.roads.some((r) => distToPolyline(x, z, r.pts) < r.width * 0.6)) continue;
        p.set(x, this.terrain.heightAt(x, z) - 0.05, z);
        q.setFromAxisAngle(up, h * 40);
        const sc = 0.7 + hash2(j, i) * 0.8;
        s.set(sc, sc * (0.7 + h), sc);
        m.setMatrixAt(k++, mat.compose(p, q, s));
      }
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
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
    if (this.grass && Math.hypot(cp.x - this.grassCenter.x, cp.z - this.grassCenter.y) > 6) {
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
