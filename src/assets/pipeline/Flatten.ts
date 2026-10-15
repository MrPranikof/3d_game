import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Game-time draw-call reduction. Every rigid mesh is baked into its nearest "kept" ancestor
 * (an animated contract node such as Turret / Cannon / Track_L / Wall_Cluster_05) and merged
 * per material; skinned meshes sharing a skeleton are merged per material as well.
 * Optional material remap folds tiny details (lenses, rubber…) into a dominant material.
 */

export interface FlattenOptions {
  keep: (o: THREE.Object3D) => boolean;
  remap?: Record<string, string>;
  resolveMaterial?: (name: string) => THREE.Material;
}

export function flattenForGame(root: THREE.Object3D, opts: FlattenOptions): void {
  root.updateMatrixWorld(true);
  const buckets = new Map<THREE.Object3D, Map<string, { geoms: THREE.BufferGeometry[]; mat: THREE.Material }>>();
  const skinBuckets = new Map<string, { geoms: THREE.BufferGeometry[]; mat: THREE.Material; skeleton: THREE.Skeleton; parent: THREE.Object3D; bindMatrix: THREE.Matrix4 }>();
  const remove: THREE.Mesh[] = [];
  const inv = new THREE.Matrix4();

  const matFor = (m: THREE.Material): THREE.Material => {
    const target = opts.remap?.[m.name];
    return target && opts.resolveMaterial ? opts.resolveMaterial(target) : m;
  };

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const mat = matFor(mesh.material);
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      const sm = mesh as THREE.SkinnedMesh;
      const key = `${sm.skeleton.uuid}|${mat.uuid}`;
      let b = skinBuckets.get(key);
      if (!b) skinBuckets.set(key, (b = { geoms: [], mat, skeleton: sm.skeleton, parent: sm.parent!, bindMatrix: sm.bindMatrix.clone() }));
      b.geoms.push(sm.geometry.clone());
      remove.push(sm);
      return;
    }
    let anchor: THREE.Object3D = mesh.parent ?? root;
    while (anchor !== root && !opts.keep(anchor)) anchor = anchor.parent ?? root;
    inv.copy(anchor.matrixWorld).invert();
    const g = mesh.geometry.clone();
    g.applyMatrix4(inv.clone().multiply(mesh.matrixWorld));
    let byMat = buckets.get(anchor);
    if (!byMat) buckets.set(anchor, (byMat = new Map()));
    let b = byMat.get(mat.uuid);
    if (!b) byMat.set(mat.uuid, (b = { geoms: [], mat }));
    b.geoms.push(g);
    remove.push(mesh);
  });

  for (const m of remove) m.parent?.remove(m);

  for (const [anchor, byMat] of buckets) {
    for (const { geoms, mat } of byMat.values()) {
      const merged = mergeAll(geoms);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `${anchor.name}_m_${mat.name}`;
      mesh.castShadow = mesh.receiveShadow = true;
      anchor.add(mesh);
    }
  }
  for (const b of skinBuckets.values()) {
    const merged = mergeAll(b.geoms);
    if (!merged) continue;
    const sm = new THREE.SkinnedMesh(merged, b.mat);
    sm.name = `Body_m_${b.mat.name}`;
    sm.castShadow = sm.receiveShadow = true;
    sm.frustumCulled = false;
    b.parent.add(sm);
    sm.bind(b.skeleton, b.bindMatrix);
  }
}

function mergeAll(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geoms.length) return null;
  // keep only attributes present on every geometry; make all indexed
  const common = Object.keys(geoms[0].attributes).filter((n) => geoms.every((g) => g.attributes[n]));
  for (const g of geoms) {
    for (const n of Object.keys(g.attributes)) if (!common.includes(n)) g.deleteAttribute(n);
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    g.morphAttributes = {};
    g.clearGroups();
  }
  const m = mergeGeometries(geoms, false);
  if (m) { m.computeBoundingBox(); m.computeBoundingSphere(); }
  return m;
}
