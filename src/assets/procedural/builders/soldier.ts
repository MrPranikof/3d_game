import * as THREE from 'three';
import { HUMANOID_BONES, type HumanoidBone } from '../../AssetRegistry';
import type { Team } from '../../StylePreset';
import { deg, type Kit, node, SkinnedPartBuilder, T } from '../Kit';
import { buildRifle } from './weapons';

/**
 * Tactical MilSim soldier with a Humanoid rig (A-pose bind, 1.80 m).
 * Character faces −Z, its right side is +X. Bones carry identity rotations in bind pose,
 * so gameplay / animation code can treat local quaternions as pure deltas.
 */

type V3 = [number, number, number];

// Bone hierarchy: name → [parent, local offset]
const A = Math.SQRT1_2;
const RIG: Record<HumanoidBone, [HumanoidBone | null, V3]> = {
  Root: [null, [0, 0, 0]],
  Pelvis: ['Root', [0, 0.98, 0]],
  Spine: ['Pelvis', [0, 0.1, 0]],
  Chest: ['Spine', [0, 0.17, 0]],
  Neck: ['Chest', [0, 0.22, 0]],
  Head: ['Neck', [0, 0.1, 0]],
  LeftShoulder: ['Chest', [-0.04, 0.17, 0]],
  LeftArm: ['LeftShoulder', [-0.15, 0, 0]],
  LeftForeArm: ['LeftArm', [-0.28 * A, -0.28 * A, 0]],
  LeftHand: ['LeftForeArm', [-0.26 * A, -0.26 * A, 0]],
  RightShoulder: ['Chest', [0.04, 0.17, 0]],
  RightArm: ['RightShoulder', [0.15, 0, 0]],
  RightForeArm: ['RightArm', [0.28 * A, -0.28 * A, 0]],
  RightHand: ['RightForeArm', [0.26 * A, -0.26 * A, 0]],
  LeftUpLeg: ['Pelvis', [-0.1, -0.05, 0]],
  LeftLeg: ['LeftUpLeg', [0, -0.43, 0]],
  LeftFoot: ['LeftLeg', [0, -0.42, 0]],
  RightUpLeg: ['Pelvis', [0.1, -0.05, 0]],
  RightLeg: ['RightUpLeg', [0, -0.43, 0]],
  RightFoot: ['RightLeg', [0, -0.42, 0]],
  WeaponMount_R: ['RightHand', [0.06 * A, -0.06 * A, 0]],
};

export interface SoldierResult {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
}

export function buildSoldier(kit: Kit, team: Team): SoldierResult {
  const root = node(`soldier_team${team}`, null);
  const bones = new Map<string, THREE.Bone>();
  for (const name of HUMANOID_BONES) {
    const [parent, off] = RIG[name];
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...off);
    bones.set(name, b);
    (parent ? bones.get(parent)! : root).add(b);
  }
  root.updateMatrixWorld(true);
  const boneList = HUMANOID_BONES.map((n) => bones.get(n)!);
  const skeleton = new THREE.Skeleton(boneList);
  const body = node('Body', root);

  const camo = kit.mats.teamCamo(team);
  const gear = team === 'A' ? 'fabric_coyote' : 'fabric_olive';
  const tape = `tape_${team}`;
  const sp = new SkinnedPartBuilder(kit, boneList);
  const wpos = (n: HumanoidBone) => new THREE.Vector3().setFromMatrixPosition(bones.get(n)!.matrixWorld);

  /** Capsule limb between two bone heads, expressed in the first bone's space. */
  const limb = (from: HumanoidBone, to: HumanoidBone, r0: number, mat: string, blend = true, extend = 0) => {
    const a = wpos(from), b = wpos(to);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const g = kit.capsule(r0, Math.max(0.01, len - r0 * 0.6 + extend));
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    const mid = a.clone().addScaledVector(dir, 0.5);
    const world = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
    const local = bones.get(from)!.matrixWorld.clone().invert().multiply(world);
    sp.addToBone(g, mat, from, local, blend);
    return { a, b, dir, q, len };
  };
  /** Ring (tape band / cuff) around a limb at fraction t. */
  const band = (from: HumanoidBone, to: HumanoidBone, t: number, r: number, w: number, mat: string) => {
    const a = wpos(from), b = wpos(to);
    const dir = b.clone().sub(a).normalize();
    const pos = a.clone().lerp(b, t);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const world = new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
    const local = bones.get(from)!.matrixWorld.clone().invert().multiply(world);
    sp.addToBone(kit.cyl(r, r, w, kit.radial, true), mat, from, local);
  };

  // ── torso ──
  sp.addToBone(kit.box(0.34, 0.2, 0.22, 0.07), camo, 'Pelvis', T(0, 0.0, 0));
  sp.addToBone(kit.torus(0.17, 0.025, kit.radial).scale(1, 1, 0.7), gear, 'Pelvis', T(0, 0.07, 0, Math.PI / 2));
  sp.addToBone(kit.box(0.12, 0.1, 0.06, 0.02), gear, 'Pelvis', T(-0.14, 0.0, 0.08)); // dump pouch
  sp.addToBone(kit.box(0.31, 0.2, 0.2, 0.07), camo, 'Spine', T(0, 0.07, 0));
  sp.addToBone(kit.box(0.38, 0.3, 0.23, 0.09), camo, 'Chest', T(0, 0.09, 0));
  // plate carrier: front/back plates, cummerbund, shoulder straps
  sp.addToBone(kit.box(0.3, 0.33, 0.055, 0.02), gear, 'Chest', T(0, 0.07, -0.14));
  sp.addToBone(kit.box(0.3, 0.35, 0.05, 0.02), gear, 'Chest', T(0, 0.08, 0.135));
  sp.addToBone(kit.box(0.42, 0.14, 0.26, 0.04), gear, 'Chest', T(0, -0.04, 0));
  sp.addToBone(kit.box(0.06, 0.03, 0.28, 0.01), gear, 'Chest', T(-0.11, 0.24, 0));
  sp.addToBone(kit.box(0.06, 0.03, 0.28, 0.01), gear, 'Chest', T(0.11, 0.24, 0));
  // triple mag pouches with exposed magazines
  for (let i = -1; i <= 1; i++) {
    sp.addToBone(kit.box(0.08, 0.11, 0.055, 0.012), gear, 'Chest', T(i * 0.085, -0.02, -0.19));
    sp.addToBone(kit.box(0.025, 0.04, 0.06, 0.005), 'polymer_black', 'Chest', T(i * 0.085, 0.045, -0.19));
  }
  // admin pouch, radio + antenna, IFAK on back, hydration
  sp.addToBone(kit.box(0.16, 0.08, 0.03, 0.01), gear, 'Chest', T(0, 0.17, -0.18));
  sp.addToBone(kit.box(0.07, 0.15, 0.045, 0.01), 'polymer_black', 'Chest', T(-0.13, 0.1, 0.18));
  sp.addToBone(kit.cyl(0.004, 0.006, 0.45, 6), 'polymer_black', 'Chest', T(-0.14, 0.38, 0.18, deg(8)));
  sp.addToBone(kit.box(0.14, 0.18, 0.06, 0.02), gear, 'Chest', T(0.06, 0.06, 0.19));
  sp.addToBone(kit.box(0.12, 0.08, 0.06, 0.02), 'fabric_olive', 'Chest', T(0.15, -0.07, 0.08));

  // ── neck & head ──
  sp.addToBone(kit.cyl(0.055, 0.06, 0.1), 'skin', 'Neck', T(0, 0.04, 0));
  sp.addToBone(kit.sphere(0.1).scale(0.9, 1.1, 1.0), 'skin', 'Head', T(0, 0.1, 0));
  sp.addToBone(kit.box(0.05, 0.06, 0.04, 0.015), 'skin', 'Head', T(0, 0.07, -0.095)); // jaw/nose block
  // balaclava/shemagh around neck
  sp.addToBone(kit.torus(0.07, 0.03, kit.radial), gear, 'Neck', T(0, 0.02, 0, Math.PI / 2));
  // FAST helmet + cover, side rails, NVG shroud, counterweight
  sp.addToBone(kit.sphere(0.135, kit.radial, Math.PI * 2, Math.PI * 0.52).scale(0.95, 0.88, 1.05), camo, 'Head', T(0, 0.12, 0.005));
  sp.addToBone(kit.box(0.015, 0.03, 0.12, 0.004), 'polymer_black', 'Head', T(-0.125, 0.115, 0));
  sp.addToBone(kit.box(0.015, 0.03, 0.12, 0.004), 'polymer_black', 'Head', T(0.125, 0.115, 0));
  sp.addToBone(kit.box(0.05, 0.03, 0.02, 0.005), 'polymer_black', 'Head', T(0, 0.19, -0.13));
  sp.addToBone(kit.box(0.08, 0.06, 0.04, 0.015), gear, 'Head', T(0, 0.16, 0.14));
  // headset ear cups + headband
  sp.addToBone(kit.cylX(0.045, 0.04), 'polymer_black', 'Head', T(-0.12, 0.09, 0));
  sp.addToBone(kit.cylX(0.045, 0.04), 'polymer_black', 'Head', T(0.12, 0.09, 0));
  sp.addToBone(kit.box(0.02, 0.025, 0.04), 'polymer_black', 'Head', T(-0.13, 0.06, -0.06, 0, 0, 0));
  // ballistic goggles (strap + lens)
  sp.addToBone(kit.torus(0.12, 0.008, kit.radial).scale(0.9, 1, 1.05), 'rubber_black', 'Head', T(0, 0.12, 0, Math.PI / 2));
  sp.addToBone(kit.box(0.17, 0.05, 0.03, 0.012), 'polymer_black', 'Head', T(0, 0.12, -0.11));
  sp.addToBone(kit.box(0.155, 0.04, 0.01, 0.01), 'glass_optic', 'Head', T(0, 0.12, -0.127));

  // ── arms ──
  for (const s of ['Left', 'Right'] as const) {
    const sh = `${s}Shoulder` as HumanoidBone, arm = `${s}Arm` as HumanoidBone, fa = `${s}ForeArm` as HumanoidBone, hand = `${s}Hand` as HumanoidBone;
    const sx = s === 'Left' ? -1 : 1;
    sp.addToBone(kit.sphere(0.075).scale(1, 0.9, 1), camo, sh, T(sx * 0.09, -0.02, 0));
    limb(arm, fa, 0.058, camo, true, 0.03);
    limb(fa, hand, 0.05, camo, true, 0.0);
    band(arm, fa, 0.35, 0.064, 0.05, tape);
    band(fa, hand, 0.82, 0.055, 0.05, 'fabric_olive'); // sleeve cuff
    // elbow pad
    sp.addToBone(kit.sphere(0.05).scale(1, 1, 0.6), 'polymer_black', fa, T(0, 0, 0.035));
    // gloved hand
    sp.addToBone(kit.box(0.05, 0.11, 0.09, 0.02), 'rubber_black', hand, T(sx * 0.04 * A, -0.04 * A - 0.02, 0, 0, 0, sx * deg(45)));
    sp.addToBone(kit.box(0.03, 0.06, 0.03, 0.01), 'rubber_black', hand, T(sx * 0.02, -0.03, -0.05, 0, 0, sx * deg(45)));
  }

  // ── legs ──
  for (const s of ['Left', 'Right'] as const) {
    const up = `${s}UpLeg` as HumanoidBone, leg = `${s}Leg` as HumanoidBone, foot = `${s}Foot` as HumanoidBone;
    const sx = s === 'Left' ? -1 : 1;
    limb(up, leg, 0.085, camo, true, 0.05);
    limb(leg, foot, 0.065, camo, true, 0.0);
    band(up, leg, 0.3, 0.09, 0.05, tape);
    // thigh cargo pocket, knee pad
    sp.addToBone(kit.box(0.04, 0.14, 0.12, 0.02), camo, up, T(sx * 0.085, -0.22, 0));
    sp.addToBone(kit.box(0.11, 0.13, 0.05, 0.02), 'polymer_black', leg, T(0, -0.02, -0.065));
    // boot: shaft + upper + sole
    sp.addToBone(kit.cyl(0.07, 0.065, 0.16), 'fabric_coyote', leg, T(0, -0.34, 0));
    sp.addToBone(kit.box(0.11, 0.1, 0.27, 0.035), 'fabric_coyote', foot, T(0, 0.0, -0.06));
    sp.addToBone(kit.box(0.115, 0.03, 0.28, 0.01), 'rubber_black', foot, T(0, -0.06, -0.06));
  }

  sp.emitSkinned(body, skeleton);

  // ── weapon (rigid, follows WeaponMount_R) ──
  const rifle = buildRifle(kit, team === 'A' ? 'ar' : 'ak');
  rifle.name = 'Weapon';
  const mount = bones.get('WeaponMount_R')!;
  // Rifle hangs from the right hand, barrel pointing forward and slightly down (A-pose carry).
  rifle.rotation.set(deg(-25), 0, 0);
  mount.add(rifle);

  return { root, animations: buildLocomotionClips() };
}

// ───────────── procedural locomotion clips (bind rotations are identity) ─────────────

function qa(x: number, y = 0, z = 0): number[] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
  return [q.x, q.y, q.z, q.w];
}

function cyclic(name: string, dur: number, tracks: Record<string, (ph: number) => [number, number, number]>, steps = 8, pelvisY?: (ph: number) => number): THREE.AnimationClip {
  const times = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * dur);
  const out: THREE.KeyframeTrack[] = [];
  for (const [bone, f] of Object.entries(tracks)) {
    const values: number[] = [];
    for (const t of times) {
      const [x, y, z] = f((t / dur) * Math.PI * 2);
      values.push(...qa(x, y, z));
    }
    out.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  }
  if (pelvisY) {
    const values: number[] = [];
    for (const t of times) values.push(0, 0.98 + pelvisY((t / dur) * Math.PI * 2), 0);
    out.push(new THREE.VectorKeyframeTrack('Pelvis.position', times, values));
  }
  return new THREE.AnimationClip(name, dur, out);
}

function buildLocomotionClips(): THREE.AnimationClip[] {
  const s = Math.sin, c = Math.cos;
  const idle = cyclic('Idle', 3.2, {
    Chest: (p) => [s(p) * 0.02, 0, 0],
    Head: (p) => [s(p + 1) * 0.02, s(p * 0.5) * 0.05, 0],
    LeftArm: (p) => [s(p) * 0.03, 0, 0],
    RightArm: (p) => [deg(-30) + s(p) * 0.02, 0, deg(20)],
    RightForeArm: () => [deg(-45), 0, deg(-30)],
  });
  const walk = cyclic('Walk', 1.1, {
    LeftUpLeg: (p) => [s(p) * 0.45, 0, 0],
    RightUpLeg: (p) => [-s(p) * 0.45, 0, 0],
    LeftLeg: (p) => [-Math.max(0, -c(p)) * 0.7, 0, 0],
    RightLeg: (p) => [-Math.max(0, c(p)) * 0.7, 0, 0],
    LeftArm: (p) => [-s(p) * 0.35, 0, 0],
    RightArm: () => [deg(-30), 0, deg(20)],
    RightForeArm: () => [deg(-45), 0, deg(-30)],
    Spine: (p) => [0.05, s(p) * 0.06, 0],
  }, 12, (p) => -Math.abs(s(p)) * 0.03);
  const run = cyclic('Run', 0.7, {
    LeftUpLeg: (p) => [s(p) * 0.85, 0, 0],
    RightUpLeg: (p) => [-s(p) * 0.85, 0, 0],
    LeftLeg: (p) => [-(0.3 + Math.max(0, -c(p)) * 1.2), 0, 0],
    RightLeg: (p) => [-(0.3 + Math.max(0, c(p)) * 1.2), 0, 0],
    LeftArm: (p) => [-s(p) * 0.7, 0, deg(20)],
    LeftForeArm: () => [deg(-60), 0, 0],
    RightArm: (p) => [deg(-40) + s(p) * 0.15, 0, deg(25)],
    RightForeArm: () => [deg(-55), 0, deg(-30)],
    Spine: (p) => [0.22, s(p) * 0.1, 0],
  }, 12, (p) => -Math.abs(s(p)) * 0.06);
  const crouch = cyclic('Crouch', 2.4, {
    LeftUpLeg: () => [deg(75), 0, 0],
    RightUpLeg: () => [deg(20), 0, 0],
    LeftLeg: () => [deg(-110), 0, 0],
    RightLeg: () => [deg(-120), 0, 0],
    LeftFoot: () => [deg(35), 0, 0],
    RightFoot: () => [deg(-10), 0, 0],
    Spine: (p) => [deg(15) + s(p) * 0.02, 0, 0],
    RightArm: () => [deg(-30), 0, deg(20)],
    RightForeArm: () => [deg(-45), 0, deg(-30)],
  }, 6, () => -0.4);
  return [idle, walk, run, crouch];
}
