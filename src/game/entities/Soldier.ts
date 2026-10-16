import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { AssetInstance } from '../../assets/pipeline/ModelLoader';
import type { Team } from '../../assets/StylePreset';
import { AMMO, type Attacker, type Damageable, type DamageInfo } from '../combat/Combat';
import { G, groups } from '../core/Physics';
import { HALF } from '../world/MapLayout';
import type { GameContext } from '../GameContext';
import type { Vehicle } from './Vehicle';

export type Stance = 'stand' | 'crouch' | 'prone';

export const STANCE_HEIGHT: Record<Stance, number> = { stand: 1.75, crouch: 1.2, prone: 0.55 };
export const EYE_HEIGHT: Record<Stance, number> = { stand: 1.62, crouch: 1.12, prone: 0.42 };

export interface WeaponState {
  id: 'rifle_ar' | 'rifle_ak';
  mag: number;
  magSize: number;
  reserve: number;
  interval: number;
  cooldown: number;
  reloading: number;
  reloadTime: number;
  spread: number;
}

const SPEED = { walk: 3.9, sprint: 6.6, crouch: 2.1, prone: 0.85 };
const RADIUS = 0.32;

let kcc: RAPIER.KinematicCharacterController | null = null;

/**
 * Infantryman shared by the player and the bots: Rapier kinematic capsule driven by a
 * character controller (steps, slopes, snapping), stance-dependent hit capsule, ballistic
 * rifle, health, and — for bots — the skinned model with locomotion clips and an aim pose.
 */
export class Soldier implements Damageable, Attacker {
  hp = 100;
  alive = true;
  kills = 0;
  deaths = 0;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  stance: Stance = 'stand';
  grounded = true;
  sprinting = false;
  lean = 0;
  vehicle: Vehicle | null = null;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  weapon: WeaponState;
  lastDamageTime = -99;
  lastAttacker: Attacker | null = null;
  deathTime = 0;
  model?: AssetInstance;
  private mixer?: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current?: THREE.AnimationAction;
  private weaponNode?: THREE.Object3D;
  private muzzleNode?: THREE.Object3D;
  private fallT = -1;
  /** motion-captured clip set (Mixamo) is available on this model */
  private mocap = false;
  private visibleState = true;
  private shadowState = true;

  constructor(private ctx: GameContext, readonly team: Team, readonly name: string, readonly isPlayer: boolean, spawn: THREE.Vector3) {
    const R = ctx.physics.R;
    if (!kcc) {
      kcc = ctx.physics.world.createCharacterController(0.03);
      kcc.enableAutostep(0.45, 0.2, false);
      kcc.enableSnapToGround(0.4);
      kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
      kcc.setApplyImpulsesToDynamicBodies(true);
    }
    this.body = ctx.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + 0.9, spawn.z));
    const desc = R.ColliderDesc.capsule(STANCE_HEIGHT.stand / 2 - RADIUS, RADIUS)
      .setCollisionGroups(groups(G.CHAR, G.TERRAIN | G.STATIC | G.VEHICLE | G.TREE | G.DEBRIS | G.CHAR));
    this.collider = ctx.physics.tag(ctx.physics.world.createCollider(desc, this.body), { kind: 'soldier', ref: this });
    this.position.copy(spawn);
    this.weapon = makeWeapon(team === 'A' ? 'rifle_ar' : 'rifle_ak');
    if (!isPlayer) this.attachModel();
  }

  private attachModel(): void {
    const inst = this.ctx.factory.instantiateTemplate(this.ctx.template('soldier', this.team));
    this.model = inst;
    this.ctx.scene.add(inst.root);
    this.mixer = new THREE.AnimationMixer(inst.root);
    for (const clip of inst.animations) {
      const a = this.mixer.clipAction(clip);
      if (clip.userData?.loop === false) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions.set(clip.name, a);
    }
    this.mocap = this.actions.has('IdleAim');
    this.play('Idle');
    this.weaponNode = inst.nodes.get('Weapon');
    this.muzzleNode = this.weaponNode?.getObjectByName('Muzzle');
  }

  private play(name: string, fade = 0.25): void {
    const a = this.actions.get(name);
    if (!a || a === this.current) return;
    a.reset().fadeIn(fade).play();
    this.current?.fadeOut(fade);
    this.current = a;
  }

  center(): THREE.Vector3 {
    return this.position.clone().setY(this.position.y + STANCE_HEIGHT[this.stance] * 0.55);
  }

  headY(): number {
    return this.position.y + STANCE_HEIGHT[this.stance] - 0.28;
  }

  eye(): THREE.Vector3 {
    const e = this.position.clone().setY(this.position.y + EYE_HEIGHT[this.stance]);
    if (this.lean) e.add(new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(this.lean * 0.4));
    return e;
  }

  aimDir(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  setStance(s: Stance): void {
    if (s === this.stance) return;
    // standing up needs headroom
    if (STANCE_HEIGHT[s] > STANCE_HEIGHT[this.stance]) {
      const hit = this.ctx.physics.raycast(this.position.clone().setY(this.position.y + STANCE_HEIGHT[this.stance]), new THREE.Vector3(0, 1, 0), STANCE_HEIGHT[s] - STANCE_HEIGHT[this.stance], { exclude: this.collider, mask: G.STATIC });
      if (hit) return;
    }
    this.stance = s;
    const shape = this.collider.shape as RAPIER.Capsule;
    shape.halfHeight = Math.max(0.02, STANCE_HEIGHT[s] / 2 - RADIUS);
    this.collider.setHalfHeight(shape.halfHeight);
  }

  /** Horizontal desired velocity in world space; gravity/jump handled here. */
  move(desired: THREE.Vector3, dt: number, jump = false): void {
    if (!this.alive || this.vehicle) return;
    const max = this.stance === 'prone' ? SPEED.prone : this.stance === 'crouch' ? SPEED.crouch : this.sprinting ? SPEED.sprint : SPEED.walk;
    const target = desired.clone().setY(0);
    if (target.lengthSq() > 1) target.normalize();
    target.multiplyScalar(max);
    const accel = this.grounded ? 14 : 3;
    this.velocity.x += (target.x - this.velocity.x) * Math.min(1, accel * dt);
    this.velocity.z += (target.z - this.velocity.z) * Math.min(1, accel * dt);
    if (this.grounded && jump && this.stance === 'stand') this.velocity.y = 4.6;
    this.velocity.y -= 9.81 * dt;
    if (this.grounded && this.velocity.y < 0) this.velocity.y = -1;
    this.applyMove(this.velocity.clone().multiplyScalar(dt));
  }

  applyMove(delta: THREE.Vector3): void {
    const half = STANCE_HEIGHT[this.stance] / 2;
    kcc!.computeColliderMovement(this.collider, delta, undefined, groups(G.CHAR, G.TERRAIN | G.STATIC | G.VEHICLE | G.TREE | G.DEBRIS));
    const m = kcc!.computedMovement();
    // Rapier reports "grounded" while the capsule merely touches a wall, which let a held jump climb
    // walls into the sky. Require real support under the feet: terrain or a walkable surface below.
    this.grounded = kcc!.computedGrounded() && this.velocity.y <= 0.5 && this.hasFooting(m);
    const t = this.body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    // map boundary
    const lim = HALF - 6;
    next.x = Math.max(-lim, Math.min(lim, next.x));
    next.z = Math.max(-lim, Math.min(lim, next.z));
    // safety nets: never sink below the terrain, never get launched into the sky
    // (nothing walkable on the map is higher than a roof)
    const ground = this.ctx.terrain.heightAt(next.x, next.z);
    if (next.y - half < ground - 0.3) { next.y = ground + half; this.velocity.y = 0; this.grounded = true; }
    if (next.y - half > ground + 40) { next.y = ground + half + 0.1; this.velocity.set(0, 0, 0); }
    this.body.setNextKinematicTranslation(next);
    this.position.set(next.x, next.y - half, next.z);
    if (this.grounded && this.velocity.y < -1) this.velocity.y = -1;
  }

  private hasFooting(m: { x: number; y: number; z: number }): boolean {
    const t = this.body.translation();
    const half = STANCE_HEIGHT[this.stance] / 2;
    const feet = new THREE.Vector3(t.x + m.x, t.y + m.y - half + 0.05, t.z + m.z);
    if (feet.y - this.ctx.terrain.heightAt(feet.x, feet.z) < 0.2) return true;
    const hit = this.ctx.physics.raycast(feet, new THREE.Vector3(0, -1, 0), 0.3, { exclude: this.collider, mask: G.TERRAIN | G.STATIC | G.VEHICLE | G.DEBRIS });
    return !!hit && hit.normal.y > 0.6;
  }

  teleport(p: THREE.Vector3): void {
    const half = STANCE_HEIGHT[this.stance] / 2;
    this.body.setTranslation({ x: p.x, y: p.y + half + 0.05, z: p.z }, true);
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + half + 0.05, z: p.z });
    this.position.copy(p);
    this.velocity.set(0, 0, 0);
  }

  /** Fire one round along `dir` from `origin`; returns false if empty / cooling down. */
  shoot(origin: THREE.Vector3, dir: THREE.Vector3, spreadMul = 1): boolean {
    const w = this.weapon;
    if (w.cooldown > 0 || w.reloading > 0 || !this.alive) return false;
    if (w.mag <= 0) { if (this.isPlayer) this.ctx.audio.ui('empty'); w.cooldown = 0.25; return false; }
    w.mag--;
    w.cooldown = w.interval;
    this.lastShot = this.ctx.time;
    const s = w.spread * spreadMul;
    const d = dir.clone().add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s)).normalize();
    const tracer = w.mag % 4 === 0;
    this.ctx.combat.fire(tracer ? AMMO.rifleTracer : AMMO.rifle, origin, d, this.team, this, { exclude: this.collider });
    const muzzle = this.isPlayer ? origin.clone().addScaledVector(dir, 0.6) : this.muzzleWorld() ?? origin;
    if (!this.isPlayer) this.ctx.particles.muzzleFlash(muzzle, d);
    this.ctx.audio.shot(this.isPlayer ? null : muzzle);
    return true;
  }

  muzzleWorld(): THREE.Vector3 | null {
    return this.muzzleNode ? this.muzzleNode.getWorldPosition(new THREE.Vector3()) : null;
  }

  reload(): void {
    const w = this.weapon;
    if (w.reloading > 0 || w.mag >= w.magSize || w.reserve <= 0) return;
    w.reloading = w.reloadTime;
    if (this.isPlayer) this.ctx.audio.ui('reload');
  }

  tickWeapon(dt: number): void {
    const w = this.weapon;
    w.cooldown = Math.max(0, w.cooldown - dt);
    if (w.reloading > 0) {
      w.reloading -= dt;
      if (w.reloading <= 0) {
        const take = Math.min(w.magSize - w.mag, w.reserve);
        w.mag += take;
        w.reserve -= take;
        w.reloading = 0;
      }
    }
  }

  applyDamage(d: DamageInfo): void {
    if (!this.alive) return;
    if (this.vehicle) return; // crew is protected by the vehicle's own damage model
    this.hp -= d.amount;
    this.lastDamageTime = this.ctx.time;
    if (d.attacker) this.lastAttacker = d.attacker;
    if (this.isPlayer) this.ctx.player.onDamaged(d);
    if (d.attacker?.isPlayer && d.attacker !== this) this.ctx.hud.hitMarker(this.hp <= 0, !!d.headshot);
    if (this.hp <= 0) this.die(d);
  }

  die(d: DamageInfo | null): void {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    this.deaths++;
    this.deathTime = this.ctx.time;
    const killer = d?.attacker ?? null;
    if (killer && killer !== this) killer.kills++;
    const weapon = d ? ({ bullet: d.headshot ? 'хедшот' : 'винтовка', apfsds: 'БОПС', he: 'ОФС', fpv: 'FPV', grenade: 'сброс', mortar: 'миномёт', atgm: 'ПТУР', crush: 'гусеницы', fall: 'падение' } as const)[d.kind] : '';
    this.ctx.killFeed(killer && killer !== this ? killer.name : '', this.name, weapon, killer ? killer.team : null, this.team);
    this.ctx.conquest.onDeath(this.team);
    // disable collisions, start fall animation
    this.collider.setCollisionGroups(groups(G.DEBRIS, 0));
    this.fallT = 0;
    if (this.mocap && this.model) {
      // fall the way the hit pushes: shot from behind → forward, headshot / crouched variants
      const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const dir = d?.dir ?? new THREE.Vector3();
      const clip = this.stance === 'crouch' ? 'DeathCrouch' : d?.headshot ? 'DeathHead'
        : dir.dot(fwd) > 0.5 ? 'DeathBack' : Math.abs(dir.dot(right)) > 0.6 ? 'DeathRight' : 'DeathFront';
      this.play(clip, 0.12);
      this.fallT = -1;
      return;
    }
    this.mixer?.stopAllAction();
    this.current = undefined;
  }

  respawn(p: THREE.Vector3): void {
    this.alive = true;
    this.hp = 100;
    this.stance = 'stand';
    this.setStanceForce();
    this.collider.setCollisionGroups(groups(G.CHAR, G.TERRAIN | G.STATIC | G.VEHICLE | G.TREE | G.DEBRIS | G.CHAR));
    this.weapon = makeWeapon(this.weapon.id);
    this.lean = 0;
    this.fallT = -1;
    this.vehicle = null;
    this.teleport(p);
    if (this.model) {
      this.model.root.rotation.set(0, this.yaw, 0);
      this.model.root.visible = true;
      this.play('Idle', 0);
    }
  }

  private setStanceForce(): void {
    this.collider.setHalfHeight(STANCE_HEIGHT.stand / 2 - RADIUS);
  }

  setVisible(v: boolean): void {
    if (this.model && v !== this.visibleState) { this.model.root.visible = v; this.visibleState = v; }
  }

  /** Bots: drive model transform + animation from simulation state. */
  updateModel(dt: number, aiming: boolean, camPos: THREE.Vector3): void {
    if (!this.model) return;
    const root = this.model.root;
    const dist = camPos.distanceTo(this.position);
    if (this.vehicle) { this.setVisible(false); return; }
    this.setVisible(dist < 650);
    if (!this.visibleState) return;
    // shadow casting only close to the camera (saves a shadow pass per far soldier)
    const shadow = dist < 45;
    if (shadow !== this.shadowState) { this.shadowState = shadow; root.traverse((o) => (o.castShadow = shadow)); }
    root.position.copy(this.position);
    if (!this.alive) {
      if (this.mocap) {
        root.rotation.set(0, this.yaw, 0);
        this.mixer!.update(dt);
      }
      if (this.fallT >= 0 && this.fallT < 1) {
        this.fallT = Math.min(1, this.fallT + dt * 2.2);
        const e = this.fallT * this.fallT;
        root.rotation.set(-Math.PI / 2 * e, this.yaw, 0, 'YXZ');
        root.position.y = this.position.y + 0.15 * e;
      }
      if (this.ctx.time - this.deathTime > 12) this.setVisible(false);
      return;
    }
    root.rotation.set(0, this.yaw, 0);
    const sp = Math.hypot(this.velocity.x, this.velocity.z);
    // animation LOD: far soldiers animate at reduced rate
    const rate = dist > 120 ? 0.25 : dist > 50 ? 0.5 : 1;
    this.animAcc = (this.animAcc ?? 0) + dt;
    if (this.mocap) this.chooseMocap(sp, aiming);
    else {
      if (this.stance !== 'stand') this.play('Crouch');
      else if (sp > 4.5) this.play('Run');
      else if (sp > 0.6) this.play('Walk');
      else this.play('Idle');
      if (this.current) this.current.timeScale = this.current.getClip().name === 'Walk' ? Math.max(0.6, sp / 3.6) : 1;
    }
    let updated = false;
    if (this.animAcc >= (1 / 60) / rate) {
      this.mixer!.update(this.animAcc);
      this.animAcc = 0;
      updated = true;
    }
    if (this.stance === 'prone') root.rotation.set(-Math.PI / 2 + 0.15, this.yaw, 0, 'YXZ');
    if (this.mocap) {
      // mocap holds the rifle itself: bend the spine to the aim pitch, then fit the rifle between the hands
      if (updated && dist < 140) { this.aimSpine(aiming ? this.pitch : 0); this.alignWeapon(); }
      return;
    }
    // weapon pose: rifle placed in world space along the aim line (or low-ready), arms solved by IK
    if (this.weaponNode && dist < 140 && this.stance !== 'prone') this.poseWeapon(aiming);
  }

  /** 8-way locomotion from the velocity in the soldier's own frame. */
  private chooseMocap(sp: number, aiming: boolean): void {
    const fwd = -(this.velocity.x * Math.sin(this.yaw) + this.velocity.z * Math.cos(this.yaw));
    const side = this.velocity.x * Math.cos(this.yaw) - this.velocity.z * Math.sin(this.yaw);
    const dirOf = (f: string, b: string, l: string, r: string) => (Math.abs(fwd) >= Math.abs(side) ? (fwd >= 0 ? f : b) : side >= 0 ? r : l);
    let name: string, nominal: number;
    if (this.stance !== 'stand') {
      if (sp < 0.4) { name = aiming ? 'CrouchAim' : 'CrouchIdle'; nominal = 0; }
      else { name = dirOf('CrouchWalk', 'CrouchBack', 'CrouchLeft', 'CrouchRight'); nominal = 1.4; }
    } else if (sp < 0.5) { name = aiming ? 'IdleAim' : 'Idle'; nominal = 0; }
    else if (sp > 5.0 && fwd > Math.abs(side)) { name = 'Sprint'; nominal = 6.0; }
    else if (sp > 2.6) { name = dirOf('Run', 'RunBack', 'RunLeft', 'RunRight'); nominal = 4.2; }
    else { name = dirOf('Walk', 'WalkBack', 'WalkLeft', 'WalkRight'); nominal = 1.7; }
    this.play(name, 0.2);
    if (this.current) this.current.timeScale = nominal ? THREE.MathUtils.clamp(sp / nominal, 0.65, 1.5) : 1;
  }

  private aimSpine(pitch: number): void {
    const n = this.model!.nodes;
    const axis = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); // character right
    for (const [name, k] of [['Spine', 0.45], ['Chest', 0.55]] as const) {
      const b = n.get(name);
      if (!b) continue;
      b.updateWorldMatrix(true, false);
      const world = b.getWorldQuaternion(new THREE.Quaternion());
      world.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, pitch * k));
      const parentQ = b.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
      b.quaternion.copy(parentQ.multiply(world));
    }
  }

  /** Rifle grip in the right palm, handguard toward the left palm, kept upright. */
  private alignWeapon(): void {
    const w = this.weaponNode;
    const n = this.model!.nodes;
    const rh = n.get('RightHand'), lh = n.get('LeftHand'), rf = n.get('RightForeArm'), lf = n.get('LeftForeArm');
    if (!w || !rh || !lh || !rf || !lf) return;
    this.model!.root.updateMatrixWorld(true);
    const palm = (hand: THREE.Object3D, fore: THREE.Object3D) => {
      const h = hand.getWorldPosition(new THREE.Vector3());
      return h.clone().addScaledVector(h.clone().sub(fore.getWorldPosition(new THREE.Vector3())).normalize(), 0.075);
    };
    const grip = palm(rh, rf), support = palm(lh, lf);
    const f = support.clone().sub(grip).normalize();
    const z = f.clone().negate();
    const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
    const y = z.clone().cross(x);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    // support point sits 3 cm above the barrel line in rifle space → tilt the muzzle down to match
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.09));
    const parent = w.parent!;
    const local = parent.matrixWorld.clone().invert().multiply(new THREE.Matrix4().compose(grip, q, new THREE.Vector3(1, 1, 1)));
    local.decompose(w.position, w.quaternion, w.scale);
  }

  private poseWeapon(aiming: boolean): void {
    const n = this.model!.nodes;
    const root = this.model!.root;
    const chest = n.get('Chest');
    root.updateMatrixWorld(true);
    const chestPos = chest!.getWorldPosition(new THREE.Vector3());
    const pitch = aiming ? this.pitch : -0.55;
    const rq = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, this.yaw, 0, 'YXZ'));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(rq);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rq);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rq);
    const grip = chestPos.clone().addScaledVector(right, 0.16).addScaledVector(up, aiming ? 0.12 : 0.0).addScaledVector(fwd, aiming ? 0.2 : 0.28);
    const support = grip.clone().addScaledVector(fwd, 0.31).addScaledVector(up, 0.03);
    const pole = new THREE.Vector3(0, -1, 0).addScaledVector(new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), 0.4);
    solveArm(n.get('RightArm')!, n.get('RightForeArm')!, n.get('RightHand')!, grip, pole, root.quaternion);
    const poleL = new THREE.Vector3(0, -1, 0).addScaledVector(new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)), -0.4);
    solveArm(n.get('LeftArm')!, n.get('LeftForeArm')!, n.get('LeftHand')!, support, poleL, root.quaternion);
    // rifle: world transform → local under the weapon mount
    const w = this.weaponNode!;
    const parent = w.parent!;
    parent.updateWorldMatrix(true, false);
    const world = new THREE.Matrix4().compose(grip, rq, new THREE.Vector3(1, 1, 1));
    const local = parent.matrixWorld.clone().invert().multiply(world);
    local.decompose(w.position, w.quaternion, w.scale);
  }

  private animAcc?: number;
  private lastShot = -99;
  /** used by the minimap: firing reveals enemies */
  lastShotTime(): number {
    return this.lastShot;
  }
}

export function makeWeapon(id: WeaponState['id']): WeaponState {
  return id === 'rifle_ar'
    ? { id, mag: 30, magSize: 30, reserve: 180, interval: 60 / 750, cooldown: 0, reloading: 0, reloadTime: 2.3, spread: 0.012 }
    : { id, mag: 30, magSize: 30, reserve: 180, interval: 60 / 650, cooldown: 0, reloading: 0, reloadTime: 2.5, spread: 0.013 };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/**
 * Analytic two-bone IK in world space for the A-pose rig (bind rotations are identity, so a
 * bone's rest direction is simply its child's local offset).
 */
function solveArm(upper: THREE.Object3D, fore: THREE.Object3D, hand: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3, rootQ: THREE.Quaternion): void {
  const S = upper.getWorldPosition(_a);
  const l1 = fore.position.length(), l2 = hand.position.length();
  const toT = target.clone().sub(S);
  const d = Math.min(toT.length(), (l1 + l2) * 0.999);
  const dir = toT.normalize();
  // elbow on the plane spanned by the target direction and the pole vector
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const a = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
  const bend = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  const elbow = S.clone().addScaledVector(dir, Math.cos(a) * l1).addScaledVector(bend, Math.sin(a) * l1);
  const T = S.clone().addScaledVector(dir, d);
  aimBone(upper, fore.position, elbow.clone().sub(S).normalize(), rootQ);
  upper.updateWorldMatrix(false, true);
  const E = fore.getWorldPosition(_b);
  aimBone(fore, hand.position, T.sub(E).normalize(), rootQ);
  fore.updateWorldMatrix(false, true);
  void _c;
}

function aimBone(bone: THREE.Object3D, childOffset: THREE.Vector3, worldDir: THREE.Vector3, rootQ: THREE.Quaternion): void {
  const rest = childOffset.clone().normalize().applyQuaternion(rootQ);
  const W = new THREE.Quaternion().setFromUnitVectors(rest, worldDir).multiply(rootQ);
  const parentQ = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentQ.invert().multiply(W));
}
