import * as THREE from 'three';

/**
 * Motion-captured soldier animations (Mixamo rifle packs, baked by tools/mixamo-bake.mjs) mapped
 * onto the game's Humanoid rig.
 *
 * The file holds, per bone and frame, the world-space rotation delta from Mixamo's T-pose plus
 * each bone's rest direction. Our rig has identity bind rotations, so a bone's animated world
 * rotation is D(t)·A, where A turns our bone's rest direction (A-pose, scan proportions) onto
 * Mixamo's. Local rotations then follow from the parent chain, so the clips fit whatever bone
 * offsets the scanned body brought in.
 */

interface Baked {
  fps: number;
  restDir: Record<string, [number, number, number]>;
  clips: Record<string, { dur: number; loop: boolean; rot: Record<string, number[]>; hips: number[] }>;
}

// game bone → bone its rest direction points at (null: leaf, see LEAF_DIR)
const CHILD: Record<string, string | null> = {
  Pelvis: 'Spine', Spine: 'Chest', Chest: 'Neck', Neck: 'Head', Head: null,
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: null,
  RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: null,
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: null,
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: null,
};
// leaves: direction of the (virtual) end in our rig, character faces −Z
const LEAF_DIR: Record<string, [number, number, number] | 'parent'> = {
  Head: [0, 1, 0], LeftHand: 'parent', RightHand: 'parent', LeftFoot: [0, -0.45, -0.9], RightFoot: [0, -0.45, -0.9],
};
const ORDER = Object.keys(CHILD); // parents before children

let baked: Promise<Baked | null> | null = null;
export function loadMixamo(): Promise<Baked | null> {
  baked ??= fetch(`${import.meta.env.BASE_URL}models/anim/soldier_anims.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Baked>) : null))
    .catch(() => null);
  return baked;
}

/** Builds AnimationClips for the skeleton under `root` (bones in rest pose, identity rotations). */
export function buildMixamoClips(root: THREE.Object3D, data: Baked): THREE.AnimationClip[] {
  const bones = new Map<string, THREE.Object3D>();
  root.traverse((o) => { if ((o as THREE.Bone).isBone) bones.set(o.name, o); });
  root.updateMatrixWorld(true);
  const pos = (n: string) => bones.get(n)!.getWorldPosition(new THREE.Vector3());

  // A: our rest direction → Mixamo rest direction, per bone
  const A = new Map<string, THREE.Quaternion>();
  const dir = new Map<string, THREE.Vector3>();
  for (const b of ORDER) {
    const c = CHILD[b];
    let d: THREE.Vector3;
    if (c) d = pos(c).sub(pos(b)).normalize();
    else { const l = LEAF_DIR[b]; d = l === 'parent' ? dir.get(bones.get(b)!.parent!.name)!.clone() : new THREE.Vector3(...l); }
    dir.set(b, d);
    const m = new THREE.Vector3(...data.restDir[b]).normalize();
    A.set(b, new THREE.Quaternion().setFromUnitVectors(d.normalize(), m));
  }
  // Mixamo leaves the hand pointing along the forearm; keep ours consistent with its forearm
  const pelvis = bones.get('Pelvis')!;
  const pelvisRest = pelvis.position.clone();
  const hipH = pelvis.getWorldPosition(new THREE.Vector3()).y;

  const clips: THREE.AnimationClip[] = [];
  const W = new Map<string, THREE.Quaternion>();
  const q = new THREE.Quaternion(), inv = new THREE.Quaternion();
  for (const [name, c] of Object.entries(data.clips)) {
    const n = c.hips.length / 3;
    const frames = c.loop ? n + 1 : n; // loops: repeat frame 0 at the end for a seamless wrap
    const times = Float32Array.from({ length: frames }, (_, i) => i / data.fps);
    const tracks: THREE.KeyframeTrack[] = [];
    const out = new Map(ORDER.map((b) => [b, new Float32Array(frames * 4)]));
    for (let f = 0; f < frames; f++) {
      const src = f % n;
      W.clear();
      for (const b of ORDER) {
        const r = c.rot[b];
        const world = new THREE.Quaternion(r[src * 4], r[src * 4 + 1], r[src * 4 + 2], r[src * 4 + 3]).multiply(A.get(b)!);
        W.set(b, world);
        const parent = bones.get(b)!.parent!;
        const pw = W.get(parent.name);
        q.copy(world);
        if (pw) q.premultiply(inv.copy(pw).invert());
        if (f > 0) { // keep quaternion hemisphere continuous for clean interpolation
          const o = out.get(b)!, k = (f - 1) * 4;
          if (q.x * o[k] + q.y * o[k + 1] + q.z * o[k + 2] + q.w * o[k + 3] < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        }
        out.get(b)!.set([q.x, q.y, q.z, q.w], f * 4);
      }
    }
    for (const b of ORDER) tracks.push(new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times, out.get(b)!));
    const hp = new Float32Array(frames * 3);
    for (let f = 0; f < frames; f++) {
      const s = (f % n) * 3;
      hp[f * 3] = pelvisRest.x + c.hips[s] * hipH;
      hp[f * 3 + 1] = pelvisRest.y + c.hips[s + 1] * hipH;
      hp[f * 3 + 2] = pelvisRest.z + c.hips[s + 2] * hipH;
    }
    tracks.push(new THREE.VectorKeyframeTrack('Pelvis.position', times, hp));
    const clip = new THREE.AnimationClip(name, c.loop ? n / data.fps : c.dur, tracks);
    clip.userData = { loop: c.loop };
    clips.push(clip);
  }
  return clips;
}
