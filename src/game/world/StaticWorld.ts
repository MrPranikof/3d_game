import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { AssetTemplate } from '../../assets/pipeline/ModelLoader';
import { G, type Physics } from '../core/Physics';

/**
 * All static architecture (houses, hangars, fences, trenches, dugouts, hedgehogs, wrecks) is
 * rendered through one BatchedMesh per material → the whole village is ~15 draw calls.
 * Every destruction cluster (Wall_Cluster_NN / Roof_Cluster_NN …) keeps its batch instance ids
 * and its own trimesh collider; destroying it hides the instances and spawns a Rapier debris body.
 */

const CLUSTER_RE = /^(Wall_Cluster|Roof_Cluster)_\d+$/;

interface Part { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }

export interface Cluster {
  id: number;
  building: Building;
  kind: 'wall' | 'roof' | 'static';
  parts: Part[];
  instances: { batch: THREE.BatchedMesh; id: number }[];
  collider?: RAPIER.Collider;
  center: THREE.Vector3;
  radius: number;
  alive: boolean;
  /** crushable by tanks (walls, fences) */
  soft: boolean;
}

export interface Building {
  assetId: string;
  /** tracked vehicles drive over it (trenches, dugouts) */
  passable: boolean;
  clusters: Cluster[];
  wallsLost: number;
  roofCollapsed: boolean;
}

export class StaticWorld {
  readonly clusters: Cluster[] = [];
  readonly buildings: Building[] = [];
  readonly group = new THREE.Group();
  private batches = new Map<THREE.Material, THREE.BatchedMesh>();
  private geoIds = new Map<THREE.BatchedMesh, Map<THREE.BufferGeometry, number>>();
  private debris: { mesh: THREE.Object3D; body: RAPIER.RigidBody; t: number }[] = [];
  onClusterDestroyed?: (c: Cluster) => void;

  constructor(private physics: Physics) {
    this.group.name = 'StaticWorld';
  }

  /** Register one placed asset (collect phase). */
  add(template: AssetTemplate, matrix: THREE.Matrix4, opts: { soft?: boolean; passable?: boolean } = {}): Building {
    const building: Building = { assetId: String(template.meta.assetId ?? ''), passable: !!opts.passable, clusters: [], wallsLost: 0, roofCollapsed: false };
    const root = template.scene;
    root.updateMatrixWorld(true);
    const byNode = new Map<THREE.Object3D, Cluster>();
    const staticCluster = (): Cluster => {
      const c: Cluster = { id: this.clusters.length, building, kind: 'static', parts: [], instances: [], center: new THREE.Vector3(), radius: 0, alive: true, soft: false };
      this.clusters.push(c);
      building.clusters.push(c);
      return c;
    };
    let base: Cluster | null = null;
    root.traverse((o) => {
      // use LOD0 only: architecture is cheap and batched
      if ((o as THREE.LOD).isLOD) return;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.parent && (mesh.parent as THREE.LOD).isLOD && (mesh.parent as THREE.LOD).levels[0].object !== mesh) return;
      let a: THREE.Object3D | null = mesh.parent;
      while (a && !CLUSTER_RE.test(a.name)) a = a.parent;
      let cluster: Cluster;
      if (a) {
        cluster = byNode.get(a) ?? (() => {
          const c: Cluster = { id: this.clusters.length, building, kind: a!.name.startsWith('Roof') ? 'roof' : 'wall', parts: [], instances: [], center: new THREE.Vector3(), radius: 0, alive: true, soft: !!opts.soft || a!.name.startsWith('Wall') };
          this.clusters.push(c);
          building.clusters.push(c);
          byNode.set(a!, c);
          return c;
        })();
      } else {
        cluster = base ??= staticCluster();
      }
      cluster.parts.push({ geometry: mesh.geometry, material: mesh.material as THREE.Material, matrix: matrix.clone().multiply(mesh.matrixWorld) });
    });
    this.buildings.push(building);
    return building;
  }

  /** Create batches, instances and colliders (build phase). */
  build(): void {
    // capacity per material
    const need = new Map<THREE.Material, { verts: number; idx: number; inst: number; geos: Set<THREE.BufferGeometry> }>();
    for (const c of this.clusters) for (const p of c.parts) {
      let n = need.get(p.material);
      if (!n) need.set(p.material, (n = { verts: 0, idx: 0, inst: 0, geos: new Set() }));
      n.inst++;
      if (!n.geos.has(p.geometry)) {
        n.geos.add(p.geometry);
        n.verts += p.geometry.attributes.position.count;
        n.idx += p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count;
      }
    }
    for (const [mat, n] of need) {
      const b = new THREE.BatchedMesh(n.inst, n.verts, n.idx, mat);
      b.name = `batch_${mat.name}`;
      b.castShadow = b.receiveShadow = true;
      this.batches.set(mat, b);
      this.geoIds.set(b, new Map());
      this.group.add(b);
    }
    const tmpBox = new THREE.Box3();
    for (const c of this.clusters) {
      const box = new THREE.Box3();
      const verts: number[] = [], indices: number[] = [];
      for (const p of c.parts) {
        const b = this.batches.get(p.material)!;
        const ids = this.geoIds.get(b)!;
        let gid = ids.get(p.geometry);
        if (gid === undefined) { gid = b.addGeometry(stripAttributes(p.geometry)); ids.set(p.geometry, gid); }
        const iid = b.addInstance(gid);
        b.setMatrixAt(iid, p.matrix);
        c.instances.push({ batch: b, id: iid });
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
        tmpBox.copy(p.geometry.boundingBox!).applyMatrix4(p.matrix);
        box.union(tmpBox);
        // collider geometry (skip glass / thin decorative parts)
        if (/glass|foliage|cage_net/.test(p.material.name)) continue;
        appendTransformed(p.geometry, p.matrix, verts, indices);
      }
      box.getCenter(c.center);
      c.radius = box.getSize(new THREE.Vector3()).length() / 2;
      if (indices.length >= 3) {
        const desc = this.physics.R.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(indices));
        c.collider = this.physics.fixed(desc, { kind: c.kind === 'static' ? 'static' : 'cluster', ref: c }, G.STATIC);
      }
    }
  }

  /** Destroy a cluster: hide its batch instances, remove its collider, spawn a debris body. */
  destroy(c: Cluster, impulseFrom?: THREE.Vector3, power = 6): void {
    if (!c.alive || c.kind === 'static') return;
    c.alive = false;
    for (const { batch, id } of c.instances) batch.setVisibleAt(id, false);
    if (c.collider) { this.physics.removeCollider(c.collider); c.collider = undefined; }

    // debris: one rigid body for the fragment, meshes keep their batch materials
    const R = this.physics.R;
    const grp = new THREE.Group();
    grp.position.copy(c.center);
    const inv = new THREE.Matrix4().makeTranslation(-c.center.x, -c.center.y, -c.center.z);
    const pts: number[] = [];
    for (const p of c.parts) {
      const m = new THREE.Mesh(p.geometry, p.material);
      m.matrixAutoUpdate = false;
      m.matrix.copy(inv.clone().multiply(p.matrix));
      m.castShadow = true;
      grp.add(m);
      const pos = p.geometry.attributes.position;
      const stride = Math.max(1, Math.floor(pos.count / 40));
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i += stride) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrix); pts.push(v.x, v.y, v.z); }
    }
    this.group.add(grp);
    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(c.center.x, c.center.y, c.center.z).setLinearDamping(0.2).setAngularDamping(0.4));
    const hull = R.ColliderDesc.convexHull(new Float32Array(pts)) ?? R.ColliderDesc.ball(Math.max(0.3, c.radius * 0.5));
    hull.setDensity(600).setFriction(0.9).setCollisionGroups((G.DEBRIS << 16) | (G.TERRAIN | G.STATIC | G.DEBRIS | G.VEHICLE)).setSolverGroups((G.DEBRIS << 16) | (G.TERRAIN | G.STATIC | G.DEBRIS | G.VEHICLE));
    this.physics.tag(this.physics.world.createCollider(hull, body), { kind: 'debris' });
    if (impulseFrom) {
      const dir = c.center.clone().sub(impulseFrom).normalize();
      dir.y = Math.abs(dir.y) + 0.35;
      dir.normalize().multiplyScalar(power * body.mass());
      body.applyImpulse(dir, true);
      body.applyTorqueImpulse({ x: (Math.random() - 0.5) * body.mass() * 2, y: (Math.random() - 0.5) * body.mass(), z: (Math.random() - 0.5) * body.mass() * 2 }, true);
    }
    this.physics.addDynamic(grp, body);
    this.debris.push({ mesh: grp, body, t: 0 });
    if (this.debris.length > 70) this.removeDebris(0);

    const b = c.building;
    if (c.kind === 'wall') {
      b.wallsLost++;
      // structural collapse: losing half the walls brings the roof down
      if (!b.roofCollapsed && b.wallsLost >= Math.max(4, b.clusters.filter((x) => x.kind === 'wall').length * 0.5)) {
        b.roofCollapsed = true;
        for (const r of b.clusters) if (r.kind === 'roof' && r.alive) this.destroy(r, r.center.clone().add(new THREE.Vector3(0, 3, 0)), 1);
      }
    }
    this.onClusterDestroyed?.(c);
  }

  private removeDebris(i: number): void {
    const d = this.debris[i];
    this.physics.removeDynamic(d.mesh);
    d.mesh.removeFromParent();
    this.debris.splice(i, 1);
  }

  update(dt: number): void {
    for (const d of this.debris) {
      d.t += dt;
      // freeze settled debris to keep the solver cheap
      if (d.t > 12 && d.body.isDynamic()) d.body.setBodyType(this.physics.R.RigidBodyType.Fixed, false);
    }
  }

  /** Clusters within radius (for explosions). */
  near(p: THREE.Vector3, r: number): Cluster[] {
    return this.clusters.filter((c) => c.alive && c.kind !== 'static' && c.center.distanceTo(p) < r + c.radius * 0.6);
  }

  get drawCalls(): number {
    return this.batches.size;
  }
}

function stripAttributes(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const n of ['position', 'normal', 'uv']) if (g.attributes[n]) out.setAttribute(n, g.attributes[n]);
  if (g.index) out.setIndex(g.index);
  return out;
}

function appendTransformed(g: THREE.BufferGeometry, m: THREE.Matrix4, verts: number[], indices: number[]): void {
  const base = verts.length / 3;
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); verts.push(v.x, v.y, v.z); }
  if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(base + g.index.getX(i));
  else for (let i = 0; i < pos.count; i++) indices.push(base + i);
}
