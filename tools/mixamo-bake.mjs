// Bakes Mixamo FBX animations (assets-src/anim/mixamo/*) into a compact retargeting file for the
// game's Humanoid rig: public/models/anim/soldier_anims.json
//
// For every mapped bone and frame we store the WORLD-space rotation delta from the Mixamo rest
// pose, D(t) = W(t) · W_rest⁻¹, converted into game space (character faces −Z; Mixamo faces +Z),
// plus the rest direction of each bone. The game rig has identity bind rotations, so at load time
// (src/assets/pipeline/MixamoClips.ts) each bone's world rotation is D(t) · A, where A turns the
// game bone's own rest direction onto Mixamo's — this absorbs A-pose vs T-pose and per-scan
// proportions. Hips translation is stored relative to rest, in hip heights.
//
// usage: node tools/mixamo-bake.mjs
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const SRC = 'assets-src/anim/mixamo';
const OUT = 'public/models/anim/soldier_anims.json';
const FPS = 30;

// game bone ← Mixamo bone (Spine1 is folded into Chest by working in world space)
const MAP = {
  Pelvis: 'Hips', Spine: 'Spine', Chest: 'Spine2', Neck: 'Neck', Head: 'Head',
  LeftShoulder: 'LeftShoulder', LeftArm: 'LeftArm', LeftForeArm: 'LeftForeArm', LeftHand: 'LeftHand',
  RightShoulder: 'RightShoulder', RightArm: 'RightArm', RightForeArm: 'RightForeArm', RightHand: 'RightHand',
  LeftUpLeg: 'LeftUpLeg', LeftLeg: 'LeftLeg', LeftFoot: 'LeftFoot',
  RightUpLeg: 'RightUpLeg', RightLeg: 'RightLeg', RightFoot: 'RightFoot',
};
// child used for each bone's rest direction (Mixamo side)
const DIR_CHILD = {
  Hips: 'Spine', Spine: 'Spine1', Spine2: 'Neck', Neck: 'Head', Head: 'HeadTop_End',
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: 'LeftHandMiddle1',
  RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: 'RightHandMiddle1',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'LeftToeBase',
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase',
};
// clip name → [file, loop, keep root drift]
const CLIPS = {
  Idle: ['idle.fbx', true], IdleAim: ['idle aiming.fbx', true],
  CrouchIdle: ['idle crouching.fbx', true], CrouchAim: ['idle crouching aiming.fbx', true],
  Walk: ['walk forward.fbx', true], WalkBack: ['walk backward.fbx', true], WalkLeft: ['walk left.fbx', true], WalkRight: ['walk right.fbx', true],
  Run: ['run forward.fbx', true], RunBack: ['run backward.fbx', true], RunLeft: ['run left.fbx', true], RunRight: ['run right.fbx', true],
  Sprint: ['sprint forward.fbx', true],
  CrouchWalk: ['walk crouching forward.fbx', true], CrouchBack: ['walk crouching backward.fbx', true],
  CrouchLeft: ['walk crouching left.fbx', true], CrouchRight: ['walk crouching right.fbx', true],
  DeathFront: ['death from the front.fbx', false, true], DeathBack: ['death from the back.fbx', false, true],
  DeathRight: ['death from right.fbx', false, true], DeathHead: ['death from front headshot.fbx', false, true],
  DeathCrouch: ['death crouching headshot front.fbx', false, true],
  Reload: ['reloading.fbx', false], Fire: ['firing rifle.fbx', false], Grenade: ['toss grenade.fbx', false], Hit: ['hit reaction.fbx', false],
};

const loadFbx = (f) => { const b = fs.readFileSync(`${SRC}/${f}`); return new FBXLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), ''); };
const rig = loadFbx('X Bot.fbx');
const bone = (n) => rig.getObjectByName(`mixamorig${n}`);
rig.updateMatrixWorld(true);

// Mixamo (+Z forward) → game (−Z forward): 180° about Y
const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI), Ri = R.clone().invert();
const toGameQ = (q) => R.clone().multiply(q).multiply(Ri);
const toGameV = (v) => v.clone().applyQuaternion(R);

const restWorldQ = {}, restDir = {};
for (const [g, m] of Object.entries(MAP)) {
  restWorldQ[m] = bone(m).getWorldQuaternion(new THREE.Quaternion());
  const a = bone(m).getWorldPosition(new THREE.Vector3()), b = bone(DIR_CHILD[m]).getWorldPosition(new THREE.Vector3());
  restDir[g] = toGameV(b.sub(a).normalize()).toArray().map((x) => +x.toFixed(4));
}
const hipsRest = bone('Hips').getWorldPosition(new THREE.Vector3());
const hipH = hipsRest.y;

const restLocal = new Map();
rig.traverse((o) => { if (o.isBone) restLocal.set(o, [o.position.clone(), o.quaternion.clone()]); });
const out = { fps: FPS, restDir, clips: {} };
const mixer = new THREE.AnimationMixer(rig);
const r4 = (x) => Math.round(x * 1e4) / 1e4;
for (const [name, [file, loop, keepDrift]] of Object.entries(CLIPS)) {
  if (!fs.existsSync(`${SRC}/${file}`)) { console.warn('missing', file); continue; }
  const clip = loadFbx(file).animations[0];
  clip.tracks = clip.tracks.filter((t) => !/scale$/.test(t.name));
  for (const [o, [p, q]] of restLocal) { o.position.copy(p); o.quaternion.copy(q); }
  mixer.stopAllAction(); mixer.uncacheRoot(rig);
  const act = mixer.clipAction(clip); act.play();
  const n = Math.max(2, Math.round(clip.duration * FPS) + (loop ? 0 : 1));
  const rot = Object.fromEntries(Object.keys(MAP).map((g) => [g, []]));
  const hips = [];
  for (let f = 0; f < n; f++) {
    mixer.setTime(Math.min(clip.duration, f / FPS));
    rig.updateMatrixWorld(true);
    for (const [g, m] of Object.entries(MAP)) {
      const W = bone(m).getWorldQuaternion(new THREE.Quaternion());
      const D = toGameQ(W.multiply(restWorldQ[m].clone().invert()));
      rot[g].push(r4(D.x), r4(D.y), r4(D.z), r4(D.w));
    }
    const h = toGameV(bone('Hips').getWorldPosition(new THREE.Vector3()).sub(hipsRest)).divideScalar(hipH);
    hips.push(h.x, h.y, h.z);
  }
  // in-place: remove linear horizontal drift of the hips (keep sway); deaths keep a damped drift
  const x0 = hips[0], z0 = hips[2], x1 = hips[(n - 1) * 3], z1 = hips[(n - 1) * 3 + 2];
  for (let f = 0; f < n; f++) {
    const t = n > 1 ? f / (n - 1) : 0;
    hips[f * 3] -= keepDrift ? x0 + (x1 - x0) * t * 0.6 : x0 + (x1 - x0) * t;
    hips[f * 3 + 2] -= keepDrift ? z0 + (z1 - z0) * t * 0.6 : z0 + (z1 - z0) * t;
  }
  out.clips[name] = { dur: +(loop ? n / FPS : (n - 1) / FPS).toFixed(4), loop: !!loop, rot, hips: hips.map(r4) };
  console.log(name.padEnd(12), file.padEnd(34), `${n} frames`);
}
fs.mkdirSync('public/models/anim', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(OUT, (fs.statSync(OUT).size / 1024).toFixed(0), 'KB');
