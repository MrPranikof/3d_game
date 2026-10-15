import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { LOD_SUFFIX } from './LODBuilder';

/**
 * Parses cached / generated .glb (Meshopt, Draco, KTX2, WebP aware), folds LOD siblings into
 * THREE.LOD objects and hands out cheap clones (SkeletonUtils keeps skinned rigs intact).
 */

export interface AssetTemplate {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  meta: Record<string, unknown>;
}

export interface AssetInstance {
  root: THREE.Object3D;
  animations: THREE.AnimationClip[];
  /** Fast lookup of contract nodes (Turret, Cannon, Prop_FL, Wall_Cluster_03 …). */
  nodes: Map<string, THREE.Object3D>;
}

export class ModelLoader {
  private gltf = new GLTFLoader();
  private ktx2?: KTX2Loader;

  constructor() {
    // three r186 loaders resolve their WASM decoders via import.meta.url → Vite bundles them
    this.gltf.setDRACOLoader(new DRACOLoader());
    this.gltf.setMeshoptDecoder(MeshoptDecoder);
  }

  /** Enables KTX2 (Basis) textures; call after `await renderer.init()` (detects ASTC/ETC2/BC). */
  async attachRenderer(renderer: unknown): Promise<void> {
    const k = new KTX2Loader();
    try {
      k.detectSupport(renderer as THREE.WebGLRenderer);
      this.ktx2 = k;
      this.gltf.setKTX2Loader(k);
    } catch (e) {
      console.warn('[ModelLoader] KTX2 unavailable:', e);
    }
  }

  async parse(bytes: ArrayBuffer): Promise<AssetTemplate> {
    const gltf: GLTF = await this.gltf.parseAsync(bytes, '');
    const scene = gltf.scene;
    const meta = (scene.children[0]?.userData ?? {}) as Record<string, unknown>;
    foldLODs(scene, (meta.lodDistances as [number, number, number]) ?? [30, 80, 200]);
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (mat.alphaTest > 0) mat.side = THREE.DoubleSide;
      }
    });
    return { scene, animations: gltf.animations, meta };
  }

  instantiate(t: AssetTemplate): AssetInstance {
    const root = SkeletonUtils.clone(t.scene);
    const nodes = new Map<string, THREE.Object3D>();
    root.traverse((o) => {
      if (o.name && !nodes.has(o.name)) nodes.set(o.name, o);
    });
    return { root, animations: t.animations, nodes };
  }

  dispose(): void {
    this.ktx2?.dispose();
  }
}

/** Mesh + Mesh__LOD1..3 siblings → one THREE.LOD (identity transform, levels keep theirs). */
export function foldLODs(scene: THREE.Object3D, distances: [number, number, number]): void {
  const sceneBox = new THREE.Box3().setFromObject(scene);
  const assetRadius = sceneBox.getSize(new THREE.Vector3()).length() / 2 || 1;
  const parents = new Set<THREE.Object3D>();
  scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.parent) parents.add(o.parent); });
  for (const parent of parents) {
    const meshes = parent.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
    const bases = meshes.filter((m) => !m.name.includes(LOD_SUFFIX));
    for (const base of bases) {
      const levels = [1, 2, 3].map((l) => meshes.find((m) => m.name === `${base.name}${LOD_SUFFIX}${l}`));
      const lod = new THREE.LOD();
      lod.name = `${base.name}_LOD`;
      parent.add(lod);
      parent.remove(base);
      lod.addLevel(base, 0);
      let last = base as THREE.Object3D;
      levels.forEach((lv, i) => {
        if (!lv) return;
        parent.remove(lv);
        lod.addLevel(lv, distances[i]);
        last = lv;
      });
      // small-detail culling: tiny parts vanish at the last LOD distance
      const g = base.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (g.boundingSphere!.radius < assetRadius * 0.03 && last === base) lod.addLevel(new THREE.Object3D(), distances[2]);
    }
  }
}
