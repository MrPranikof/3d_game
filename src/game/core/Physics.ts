import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';

/**
 * Rapier3D (WASM) world. Rapier runs on the main thread here: the game uses it for queries
 * (rays, shape overlaps, character controllers) every frame, and a worker round-trip would
 * add a frame of latency to every shot. Dynamic simulation is limited to debris.
 */

export const G = {
  TERRAIN: 1 << 0,
  STATIC: 1 << 1,
  CHAR: 1 << 2,
  VEHICLE: 1 << 3,
  DEBRIS: 1 << 4,
  TREE: 1 << 5,
} as const;

export const groups = (member: number, filter: number) => (member << 16) | filter;

export type ColliderKind = 'terrain' | 'static' | 'cluster' | 'soldier' | 'vehicle' | 'debris' | 'tree' | 'emplacement';

export interface ColliderTag {
  kind: ColliderKind;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ref?: any;
}

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  collider: RAPIER.Collider;
  tag?: ColliderTag;
}

export class Physics {
  readonly world: RAPIER.World;
  readonly R = RAPIER;
  private tags = new Map<number, ColliderTag>();
  private acc = 0;
  readonly dynamic: { body: RAPIER.RigidBody; obj: THREE.Object3D }[] = [];

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
  }

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  tag(c: RAPIER.Collider, t: ColliderTag): RAPIER.Collider {
    this.tags.set(c.handle, t);
    return c;
  }

  tagOf(c: RAPIER.Collider): ColliderTag | undefined {
    return this.tags.get(c.handle);
  }

  removeCollider(c: RAPIER.Collider): void {
    this.tags.delete(c.handle);
    this.world.removeCollider(c, true);
  }

  fixed(desc: RAPIER.ColliderDesc, tag: ColliderTag, group: number, filter = 0xffff): RAPIER.Collider {
    desc.setCollisionGroups(groups(group, filter)).setSolverGroups(groups(group, filter));
    return this.tag(this.world.createCollider(desc), tag);
  }

  /** Raycast; `dir` must be normalised. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, opts: { exclude?: RAPIER.Collider; mask?: number; predicate?: (t: ColliderTag | undefined) => boolean } = {}): RayHit | null {
    const ray = new RAPIER.Ray(origin, dir);
    const filterGroups = opts.mask !== undefined ? groups(0xffff, opts.mask) : undefined;
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, filterGroups, opts.exclude, undefined,
      opts.predicate ? (c: RAPIER.Collider) => opts.predicate!(this.tags.get(c.handle)) : undefined);
    if (!hit) return null;
    const d = hit.timeOfImpact;
    return {
      point: new THREE.Vector3(origin.x + dir.x * d, origin.y + dir.y * d, origin.z + dir.z * d),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: d,
      collider: hit.collider,
      tag: this.tags.get(hit.collider.handle),
    };
  }

  /** All tagged colliders overlapping a ball. */
  overlapBall(center: THREE.Vector3, radius: number, mask = 0xffff): { collider: RAPIER.Collider; tag?: ColliderTag }[] {
    const out: { collider: RAPIER.Collider; tag?: ColliderTag }[] = [];
    this.world.intersectionsWithShape(center, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(radius), (c) => {
      out.push({ collider: c, tag: this.tags.get(c.handle) });
      return true;
    }, undefined, groups(0xffff, mask));
    return out;
  }

  overlapBox(center: THREE.Vector3, rot: THREE.Quaternion, half: THREE.Vector3, mask: number, exclude?: RAPIER.Collider): { collider: RAPIER.Collider; tag?: ColliderTag }[] {
    const out: { collider: RAPIER.Collider; tag?: ColliderTag }[] = [];
    this.world.intersectionsWithShape(center, rot, new RAPIER.Cuboid(half.x, half.y, half.z), (c) => {
      out.push({ collider: c, tag: this.tags.get(c.handle) });
      return true;
    }, undefined, groups(0xffff, mask), exclude);
    return out;
  }

  addDynamic(obj: THREE.Object3D, body: RAPIER.RigidBody): void {
    this.dynamic.push({ body, obj });
  }

  removeDynamic(obj: THREE.Object3D): void {
    const i = this.dynamic.findIndex((d) => d.obj === obj);
    if (i < 0) return;
    const d = this.dynamic[i];
    for (let k = 0; k < d.body.numColliders(); k++) this.tags.delete(d.body.collider(k).handle);
    this.world.removeRigidBody(d.body);
    this.dynamic.splice(i, 1);
  }

  step(dt: number): void {
    this.acc = Math.min(this.acc + dt, 3 / 60);
    while (this.acc >= 1 / 60) {
      this.world.step();
      this.acc -= 1 / 60;
    }
    for (const d of this.dynamic) {
      if (d.body.isSleeping()) continue;
      const t = d.body.translation(), r = d.body.rotation();
      d.obj.position.set(t.x, t.y, t.z);
      d.obj.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}

export type { RAPIER };
