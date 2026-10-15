import * as THREE from 'three';
import type { AssetSpec } from '../AssetRegistry';
import { LOD_SUFFIX } from './LODBuilder';

/**
 * Enforces the unified asset standard on EVERY generated model, regardless of engine:
 *  • required node hierarchy present (gameplay binds to names)
 *  • 1 unit = 1 m: extents within ±35 % of the real-world spec
 *  • metal/roughness PBR: every material is MeshStandardMaterial with albedo + normal + roughness maps
 */

export interface ValidationReport {
  ok: boolean;
  missingNodes: string[];
  extents: [number, number, number];
  scaleDeviation: [number, number, number];
  scaleOk: boolean;
  nonPbrMaterials: string[];
  triangles: number;
  meshes: number;
  materials: number;
  warnings: string[];
}

const TOLERANCE = 0.35;

export function validateAsset(root: THREE.Object3D, spec: AssetSpec): ValidationReport {
  const names = new Set<string>();
  root.traverse((o) => names.add(o.name));
  const missingNodes = spec.requiredNodes.filter((n) => !names.has(n));

  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let triangles = 0, meshes = 0;
  const mats = new Set<THREE.Material>();
  const nonPbr = new Set<string>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || o.name.includes(LOD_SUFFIX)) return;
    meshes++;
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (!g.boundingBox) g.computeBoundingBox();
    // skinned meshes are bound at identity → geometry space == model space in bind pose
    tmp.copy(g.boundingBox!).applyMatrix4((m as THREE.SkinnedMesh).isSkinnedMesh ? new THREE.Matrix4() : m.matrixWorld);
    box.union(tmp);
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      mats.add(mat);
      const s = mat as THREE.MeshStandardMaterial;
      if (!s.isMeshStandardMaterial || !s.map || !s.normalMap || !s.roughnessMap) nonPbr.add(mat.name || mat.type);
    }
  });
  const size = box.getSize(new THREE.Vector3());
  const extents: [number, number, number] = [round(size.x), round(size.y), round(size.z)];
  const dev = extents.map((e, i) => round(e / spec.dimensions[i] - 1)) as [number, number, number];
  const scaleOk = dev.every((d) => Math.abs(d) <= TOLERANCE);
  const warnings: string[] = [];
  if (!scaleOk) warnings.push(`scale: extents ${extents.join('×')} m vs spec ${spec.dimensions.join('×')} m`);
  if (nonPbr.size) warnings.push(`non-PBR materials: ${[...nonPbr].join(', ')}`);
  return {
    ok: missingNodes.length === 0 && scaleOk && nonPbr.size === 0,
    missingNodes,
    extents,
    scaleDeviation: dev,
    scaleOk,
    nonPbrMaterials: [...nonPbr],
    triangles: Math.round(triangles),
    meshes,
    materials: mats.size,
    warnings,
  };
}

const round = (x: number) => Math.round(x * 100) / 100;
