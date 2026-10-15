import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/**
 * Shipped Tripo-generated character bodies (prepared offline by tools/tripo-prep.mjs +
 * tools/tripo-skin.mjs). Each GLB carries one skinned mesh bound to the game's Humanoid rig
 * (same bone names, identity bind rotations) fitted to the scan's proportions.
 *
 * At load time the procedural soldier keeps its skeleton, locomotion clips and weapon; only the
 * fitted bone offsets are copied over and the procedural body mesh is replaced by the scan.
 */
const BODIES: Record<string, string> = {
  'soldier:A': 'models/tripo/soldier_A.gltf.json',
  'soldier:B': 'models/tripo/soldier_B.gltf.json',
};

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

export function scannedBodyUrl(id: string, team?: string): string | null {
  const rel = BODIES[team ? `${id}:${team}` : id];
  return rel ? import.meta.env.BASE_URL + rel : null;
}

export async function applyScannedBody(root: THREE.Object3D, url: string): Promise<void> {
  const gltf = await loader.loadAsync(url);
  const scan = gltf.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh | undefined;
  if (!scan) throw new Error(`${url}: no skinned mesh`);

  // 1. move procedural bones to the fitted rest offsets
  const procBones = new Map<string, THREE.Bone>();
  root.traverse((o) => { if ((o as THREE.Bone).isBone) procBones.set(o.name, o as THREE.Bone); });
  for (const b of scan.skeleton.bones) procBones.get(b.name)?.position.copy(b.position);
  root.updateMatrixWorld(true);

  // 2. drop the procedural body meshes
  // direct child only: the rifle under WeaponMount_R has its own 'Body' node
  const body = root.children.find((c) => c.name === 'Body');
  if (!body) throw new Error('soldier template has no Body node');
  const old: THREE.Object3D[] = [];
  body.traverse((o) => { if ((o as THREE.Mesh).isMesh) old.push(o); });
  for (const o of old) o.parent?.remove(o);

  // 3. rebind the scan to the procedural skeleton (bone order of the scan's skin)
  const bones = scan.skeleton.bones.map((b) => {
    const pb = procBones.get(b.name);
    if (!pb) throw new Error(`${url}: bone ${b.name} missing in rig`);
    return pb;
  });
  const mesh = new THREE.SkinnedMesh(scan.geometry, scan.material);
  mesh.name = 'Body_scan';
  (mesh.material as THREE.Material).name ||= 'scan';
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  body.add(mesh);
  mesh.bind(new THREE.Skeleton(bones, scan.skeleton.boneInverses), new THREE.Matrix4());
}
