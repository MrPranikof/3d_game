import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';

/**
 * Automatic LOD0–LOD3 generation with meshoptimizer (WASM).
 *
 * For every mesh M a sibling `M__LOD1..3` is created that SHARES M's vertex attributes
 * (GLTFExporter writes them once) and only owns a simplified index buffer — so LODs cost
 * almost nothing in .glb size. Skinning attributes are preserved automatically.
 * At load time ModelLoader folds the siblings into a THREE.LOD per mesh.
 */

export const LOD_SUFFIX = '__LOD';
const MIN_TRIANGLES = 48;

export async function generateLODs(root: THREE.Object3D, ratios: [number, number, number]): Promise<{ created: number; triangles: number[] }> {
  await MeshoptSimplifier.ready;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.name.includes(LOD_SUFFIX)) meshes.push(o as THREE.Mesh);
  });
  const tris = [0, 0, 0, 0];
  let created = 0;
  for (const mesh of meshes) {
    const g = mesh.geometry;
    if (!g.index) continue;
    const base = g.index.count / 3;
    tris[0] += base;
    if (base < MIN_TRIANGLES) {
      for (let l = 1; l < 4; l++) tris[l] += base;
      continue;
    }
    const positions = toFloat32(g.attributes.position as THREE.BufferAttribute);
    const indices = new Uint32Array(g.index.array);
    let prev = base;
    for (let level = 1; level <= 3; level++) {
      const target = Math.max(12, Math.floor((indices.length * ratios[level - 1]) / 3) * 3);
      // error budget grows per level; 'LockBorder' keeps UV/material seams closed on LOD1
      const flags: ('LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize' | 'Permissive')[] = level === 1 ? ['LockBorder'] : ['Prune'];
      const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, target, [0.01, 0.04, 0.12][level - 1], flags);
      let finalIdx = simplified;
      if (simplified.length / 3 > prev * 0.92) {
        // topology resisted simplification (hard-surface boxes) → sloppy pass for far LODs
        if (level < 3) { tris[level] += prev; continue; }
        const [sloppy] = MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, target, 0.2);
        finalIdx = sloppy;
      }
      if (finalIdx.length < 3) { tris[level] += 0; continue; }
      const lg = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(g.attributes)) lg.setAttribute(name, attr); // shared, not copied
      lg.setIndex(new THREE.BufferAttribute(fitIndex(finalIdx, g.attributes.position.count), 1));
      lg.boundingBox = g.boundingBox;
      lg.boundingSphere = g.boundingSphere;
      const lm = makeLike(mesh, lg);
      lm.name = `${mesh.name}${LOD_SUFFIX}${level}`;
      lm.userData = { lod: level };
      mesh.parent!.add(lm);
      created++;
      prev = finalIdx.length / 3;
      tris[level] += prev;
    }
  }
  return { created, triangles: tris };
}

function makeLike(src: THREE.Mesh, geom: THREE.BufferGeometry): THREE.Mesh {
  let m: THREE.Mesh;
  if ((src as THREE.SkinnedMesh).isSkinnedMesh) {
    const s = src as THREE.SkinnedMesh;
    const sm = new THREE.SkinnedMesh(geom, s.material);
    sm.bind(s.skeleton, s.bindMatrix);
    sm.frustumCulled = false;
    m = sm;
  } else {
    m = new THREE.Mesh(geom, src.material);
  }
  m.position.copy(src.position);
  m.quaternion.copy(src.quaternion);
  m.scale.copy(src.scale);
  m.castShadow = src.castShadow;
  m.receiveShadow = src.receiveShadow;
  return m;
}

function toFloat32(attr: THREE.BufferAttribute): Float32Array {
  if (attr.array instanceof Float32Array && attr.itemSize === 3) return attr.array;
  const out = new Float32Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) { out[i * 3] = attr.getX(i); out[i * 3 + 1] = attr.getY(i); out[i * 3 + 2] = attr.getZ(i); }
  return out;
}

function fitIndex(idx: Uint32Array, vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount < 65535 ? new Uint16Array(idx) : idx;
}
