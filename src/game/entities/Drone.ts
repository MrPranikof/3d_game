import * as THREE from 'three/webgpu';
import type { AssetInstance } from '../../assets/pipeline/ModelLoader';
import type { Team } from '../../assets/StylePreset';
import { AMMO, type Attacker, type ProjectileSpec } from '../combat/Combat';
import type { Loop } from '../core/Audio';
import type { InputFrame } from '../core/Input';
import { G } from '../core/Physics';
import type { GameContext } from '../GameContext';
import type { Soldier } from './Soldier';
import type { Vehicle } from './Vehicle';

/**
 * FPV / UAV simulation.
 *  • player FPV: rigid-body-ish quadcopter with Stabilize (self-levelling, altitude-rate) and
 *    Acro (rate) modes, battery, video link quality (range, terrain masking, low altitude,
 *    enemy EW domes) feeding the analog-noise shader, thermal, payload drop with inherited
 *    velocity, contact / proximity fuze;
 *  • enemy kamikaze drones: cruise at altitude, then terminal dive on a target; jammable.
 */

const FPV_WARHEAD: ProjectileSpec = { ...AMMO.grenade, kind: 'fpv', explosive: { radius: 5, damage: 160, ap: 520, destroy: 3 } };
const MAX_THRUST = 9.81 * 2.6;
const HOVER = 1 / 2.6;

export type DroneMode = 'stab' | 'acro';

export class Drone implements Attacker {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  alive = true;
  armed = true;
  mode: DroneMode = 'stab';
  throttle = HOVER;
  battery = 240;
  noise = 0;
  signalLost = 0;
  jammed = 0;
  gimbal = 0.35;
  thermal = false;
  kills = 0;
  readonly name: string;
  readonly isPlayer: boolean;
  private yawRate = 0;
  private rates = new THREE.Vector3();
  private props: THREE.Object3D[] = [];
  private gimbalNode?: THREE.Object3D;
  private payloadNode?: THREE.Object3D;
  private camNode?: THREE.Object3D;
  private loop: Loop | null = null;
  // AI
  target: { pos: () => THREE.Vector3; alive: () => boolean } | null = null;
  private phase: 'cruise' | 'dive' = 'cruise';

  constructor(private ctx: GameContext, readonly team: Team, readonly operator: Soldier | null, readonly inst: AssetInstance, pos: THREE.Vector3, yaw: number) {
    this.isPlayer = !!operator?.isPlayer;
    this.name = this.isPlayer ? operator!.name : 'FPV';
    this.pos.copy(pos);
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    for (const k of ['Prop_FL', 'Prop_FR', 'Prop_RL', 'Prop_RR']) { const p = inst.nodes.get(k); if (p) this.props.push(p); }
    this.gimbalNode = inst.nodes.get('Camera_Gimbal');
    this.payloadNode = inst.nodes.get('Payload');
    this.camNode = inst.nodes.get('Cam_FPV');
    inst.root.scale.setScalar(this.isPlayer ? 1 : 1.4); // AI drones slightly larger for readability
    ctx.scene.add(inst.root);
    this.loop = ctx.audio.loop('drone');
  }

  /** Player flight model. */
  control(f: InputFrame, dt: number): void {
    if (!this.alive) return;
    const lost = this.signalLost > 0 || this.jammed > 0 || this.battery <= 0;
    let pitchIn = lost ? 0 : f.stick.pitch, rollIn = lost ? 0 : f.stick.roll, yawIn = lost ? 0 : f.stick.yaw;
    if (f.pressed.has('droneMode')) this.mode = this.mode === 'stab' ? 'acro' : 'stab';
    if (f.pressed.has('thermal')) { this.thermal = !this.thermal; this.ctx.thermal.set(this.thermal); }
    if (f.zoom) this.gimbal = THREE.MathUtils.clamp(this.gimbal - f.zoom * 0.08, -0.8, 0.6);
    if (f.pressed.has('drop') && this.armed && !lost) this.drop();

    // throttle: touch stick is absolute; keyboard/gamepad are rate inputs
    if (this.mode === 'stab') {
      const climb = f.stick.throttle !== null ? (f.stick.throttle - 0.5) * 14 : f.stick.throttleRate * 7;
      const err = (lost ? -3 : climb) - this.vel.y;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
      this.throttle = THREE.MathUtils.clamp((HOVER + err * 0.06) / Math.max(0.4, up.y), 0, 1);
      // self-levelling attitude from stick deflection (max 40°)
      const euler = new THREE.Euler().setFromQuaternion(this.quat, 'YXZ');
      const tp = -pitchIn * 0.7, tr = -rollIn * 0.7;
      this.rates.set((tp - euler.x) * 6, 0, (tr - euler.z) * 6);
      this.yawRate = yawIn * 2.4;
    } else {
      if (f.stick.throttle !== null) this.throttle = f.stick.throttle;
      else this.throttle = THREE.MathUtils.clamp(this.throttle + f.stick.throttleRate * dt * 0.9, 0, 1);
      if (lost) this.throttle *= 0.97;
      // expo rates (deg/s ~ 500)
      const expo = (v: number) => v * (0.3 + 0.7 * v * v) * 8.5;
      this.rates.set(-expo(pitchIn), 0, -expo(rollIn));
      this.yawRate = expo(yawIn) * 0.6;
    }
    if (lost) { this.rates.multiplyScalar(0.2); this.yawRate = 0; }
    this.integrate(dt);
  }

  private integrate(dt: number): void {
    // attitude: body rates
    const dq = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.rates.x * dt, 0, this.rates.z * dt, 'XYZ'));
    this.quat.multiply(dq);
    this.quat.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yawRate * dt));
    this.quat.normalize();
    // forces
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    const acc = up.multiplyScalar(this.throttle * MAX_THRUST);
    acc.y -= 9.81;
    const sp = this.vel.length();
    acc.addScaledVector(this.vel, -0.25 - 0.012 * sp);
    acc.add(this.ctx.combat.wind.clone().multiplyScalar(0.05));
    this.vel.addScaledVector(acc, dt);
    this.moveAndCollide(dt);
    this.battery -= dt * (0.4 + this.throttle);
  }

  private moveAndCollide(dt: number): void {
    const step = this.vel.length() * dt;
    if (step > 1e-4) {
      const dir = this.vel.clone().divideScalar(step / dt);
      const hit = this.ctx.physics.raycast(this.pos, dir, step + 0.25, { mask: G.TERRAIN | G.STATIC | G.TREE | G.VEHICLE | G.CHAR | G.DEBRIS, exclude: this.operator?.collider });
      if (hit) {
        this.pos.copy(hit.point);
        this.impact(hit.tag?.kind === 'vehicle' || hit.tag?.kind === 'soldier');
        return;
      }
      this.pos.addScaledVector(dir, step);
    }
    const ground = this.ctx.terrain.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < ground + 0.08) { this.pos.y = ground + 0.08; this.impact(false); }
  }

  private impact(onTarget: boolean): void {
    const fast = this.vel.length() > 5;
    if (this.armed && (fast || onTarget)) this.detonate();
    else if (fast) this.kill(null);
    else { this.vel.set(0, 0, 0); if (!this.isPlayer) this.kill(null); }
  }

  detonate(): void {
    if (!this.alive) return;
    this.ctx.combat.explode(this.pos.clone(), FPV_WARHEAD, this.isPlayer ? this.operator : this, this.team);
    this.destroy();
  }

  private drop(): void {
    if (!this.armed) return;
    this.armed = false;
    if (this.payloadNode) this.payloadNode.visible = false;
    const p = this.pos.clone().add(new THREE.Vector3(0, -0.15, 0));
    this.ctx.combat.fire(AMMO.grenade, p, this.vel.clone().normalize(), this.team, this.operator, { speed: this.vel.length(), mesh: grenadeMesh() });
    this.ctx.audio.ui('click');
  }

  kill(by: Attacker | null): void {
    if (!this.alive) return;
    if (by && by !== this) by.kills++;
    this.ctx.particles.explosion(this.pos.clone(), 0.35);
    this.ctx.audio.explosion(this.pos.clone(), 0.4);
    if (this.armed && Math.random() < 0.5) this.ctx.combat.explode(this.pos.clone(), { ...FPV_WARHEAD, explosive: { radius: 3, damage: 80, ap: 120, destroy: 1 } }, this, this.team);
    this.destroy();
  }

  private destroy(): void {
    this.alive = false;
    this.loop?.stop();
    this.loop = null;
    this.inst.root.removeFromParent();
    if (this.thermal) this.ctx.thermal.set(false);
  }

  /** Link quality / interference 0..1 → analog noise intensity. */
  updateSignal(dt: number): void {
    let n = 0;
    if (this.operator) {
      const op = this.operator.eye();
      const d = op.distanceTo(this.pos);
      n += THREE.MathUtils.smoothstep(d, 350, 950);
      // terrain masking between operator and drone
      const dir = this.pos.clone().sub(op);
      const hit = this.ctx.physics.raycast(op, dir.normalize(), Math.max(0.1, d - 1), { mask: G.TERRAIN, exclude: this.operator.collider });
      if (hit) n += 0.35;
    }
    const agl = this.pos.y - this.ctx.terrain.heightAt(this.pos.x, this.pos.z);
    if (agl < 2) n += (2 - agl) * 0.12;
    for (const z of this.ctx.layout.ewZones) {
      if (z.team === this.team) continue;
      const d = Math.hypot(this.pos.x - z.x, this.pos.z - z.z);
      n += 1.2 * (1 - THREE.MathUtils.smoothstep(d, z.r * 0.4, z.r));
    }
    if (this.jammed > 0) n += 1;
    n += (Math.random() - 0.5) * 0.06;
    this.noise += (THREE.MathUtils.clamp(n, 0, 1) - this.noise) * Math.min(1, dt * 4);
    if (this.noise > 0.93) this.signalLost += dt; else this.signalLost = Math.max(0, this.signalLost - dt * 2);
    this.jammed = Math.max(0, this.jammed - dt);
  }

  updateVisual(dt: number): void {
    if (!this.alive) return;
    const root = this.inst.root;
    root.position.copy(this.pos);
    root.quaternion.copy(this.quat);
    const spin = 40 + this.throttle * 120;
    this.props.forEach((p, i) => (p.rotation.y += (i === 0 || i === 3 ? 1 : -1) * spin * dt));
    if (this.gimbalNode) this.gimbalNode.rotation.x = this.gimbal;
    if (this.loop) {
      const listener = this.ctx.camera.position;
      const d = this.isPlayer && this.ctx.player.mode === 'drone' ? 0 : listener.distanceTo(this.pos);
      this.loop.set(this.throttle, Math.max(0, 1 - d / 140));
    }
  }

  cameraPose(cam: THREE.PerspectiveCamera): void {
    this.inst.root.updateMatrixWorld(true);
    this.inst.root.visible = false; // the pilot doesn't see the airframe from the nose camera
    cam.position.copy(this.camNode ? this.camNode.getWorldPosition(new THREE.Vector3()) : this.pos);
    cam.quaternion.copy(this.quat).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.gimbal));
    cam.fov = 105;
    cam.updateProjectionMatrix();
  }

  /** Enemy kamikaze AI. */
  ai(dt: number): void {
    if (!this.alive) return;
    if (this.jammed > 0) {
      // lost link: tumble and fall
      this.vel.y -= 9.81 * dt;
      this.vel.multiplyScalar(1 - dt * 0.2);
      this.quat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(dt * 3, dt * 2, dt * 4)));
      this.jammed -= dt * 0.1;
      this.moveAndCollide(dt);
      return;
    }
    if (!this.target || !this.target.alive()) { this.retarget(); if (!this.target) { this.vel.multiplyScalar(0.98); this.moveAndCollide(dt); return; } }
    const tp = this.target.pos();
    const to = tp.clone().sub(this.pos);
    const horiz = Math.hypot(to.x, to.z);
    let desired: THREE.Vector3;
    if (this.phase === 'cruise') {
      const cruiseY = this.ctx.terrain.heightAt(this.pos.x, this.pos.z) + 32;
      desired = new THREE.Vector3(to.x, 0, to.z).normalize().multiplyScalar(17);
      desired.y = (cruiseY - this.pos.y) * 0.8;
      if (horiz < 55) this.phase = 'dive';
    } else {
      desired = to.clone().normalize().multiplyScalar(24);
    }
    const steer = desired.sub(this.vel).clampLength(0, 14 * dt);
    this.vel.add(steer);
    // bank into the turn
    const fwd = this.vel.clone().normalize();
    const look = new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd, new THREE.Vector3(0, 1, 0)); // −Z (nose) along velocity
    const q = new THREE.Quaternion().setFromRotationMatrix(look).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.5));
    this.quat.slerp(q, Math.min(1, dt * 4));
    this.throttle = 0.6;
    if (to.length() < 2.2) { this.detonate(); return; }
    this.moveAndCollide(dt);
  }

  private retarget(): void {
    const enemies: { pos: () => THREE.Vector3; alive: () => boolean; d: number }[] = [];
    const ctx = this.ctx;
    for (const v of ctx.vehicles) if (v.alive && v.crewTeam !== this.team && (v.driver || v.aiCrew)) enemies.push({ pos: () => v.position.clone().setY(v.position.y + 2.2), alive: () => v.alive, d: v.position.distanceTo(this.pos) * 0.7 });
    for (const s of ctx.soldiers) if (s.alive && s.team !== this.team && !s.vehicle) enemies.push({ pos: () => s.center(), alive: () => s.alive && !s.vehicle, d: s.position.distanceTo(this.pos) * (s.isPlayer ? 0.6 : 1) });
    enemies.sort((a, b) => a.d - b.d);
    this.target = enemies[Math.min(enemies.length - 1, Math.floor(Math.random() * 2))] ?? null;
    this.phase = 'cruise';
  }

  get targetsPlayer(): boolean {
    return !!this.target && this.ctx.player.soldier.alive && this.target.pos().distanceTo(this.ctx.player.focus()) < 3;
  }
}

function grenadeMesh(): THREE.Object3D {
  return new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3d4430 }));
}

export class DroneSystem {
  readonly list: Drone[] = [];
  private spawnTimer: Record<Team, number> = { A: 50, B: 35 };
  playerDrones = 3;

  constructor(private ctx: GameContext) {}

  launchPlayer(op: Soldier): Drone | null {
    if (this.playerDrones <= 0) return null;
    this.playerDrones--;
    const inst = this.ctx.factory.instantiateTemplate(this.ctx.template('drone_fpv7'));
    const fwd = new THREE.Vector3(-Math.sin(op.yaw), 0, -Math.cos(op.yaw));
    const p = op.eye().addScaledVector(fwd, 1.2);
    const d = new Drone(this.ctx, op.team, op, inst, p, op.yaw);
    d.vel.set(0, 2.5, 0);
    this.list.push(d);
    return d;
  }

  private spawnEnemy(team: Team): void {
    const base = this.ctx.layout.spawns[team][0];
    const inst = this.ctx.factory.instantiateTemplate(this.ctx.template('drone_fpv7'));
    const p = new THREE.Vector3(base[0] + (Math.random() - 0.5) * 40, 0, base[1] + (Math.random() - 0.5) * 40);
    p.y = this.ctx.terrain.heightAt(p.x, p.z) + 25;
    const d = new Drone(this.ctx, team, null, inst, p, 0);
    this.list.push(d);
  }

  update(dt: number): void {
    // each side launches kamikaze drones periodically (more often against the player's side)
    for (const t of ['A', 'B'] as const) {
      this.spawnTimer[t] -= dt;
      if (this.spawnTimer[t] <= 0) {
        this.spawnTimer[t] = (t === this.ctx.settings.playerTeam ? 75 : 55) + Math.random() * 30;
        if (this.list.filter((d) => d.alive && !d.isPlayer && d.team === t).length < 2) this.spawnEnemy(t);
      }
    }
    for (const d of this.list) {
      if (!d.alive) continue;
      if (!d.isPlayer) {
        // friendly EW domes jam incoming drones
        for (const z of this.ctx.layout.ewZones) {
          if (z.team === d.team) continue;
          if (Math.hypot(d.pos.x - z.x, d.pos.z - z.z) < z.r * 0.6 && Math.random() < dt * 0.5) d.jammed = 4;
        }
        d.ai(dt);
      } else if (this.ctx.player.drone !== d) {
        d.vel.y -= 9.81 * dt;
      }
      if (d.isPlayer) d.updateSignal(dt);
      d.updateVisual(dt);
    }
    for (let i = this.list.length - 1; i >= 0; i--) if (!this.list[i].alive) this.list.splice(i, 1);
  }

  /** Analytic bullet-vs-drone test. */
  findHit(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, shooterTeam: Team): { drone: Drone; point: THREE.Vector3 } | null {
    for (const d of this.list) {
      if (!d.alive || d.team === shooterTeam) continue;
      const oc = d.pos.clone().sub(origin);
      const t = oc.dot(dir);
      if (t < 0 || t > maxDist) continue;
      const closest = origin.clone().addScaledVector(dir, t);
      if (closest.distanceToSquared(d.pos) < 0.45 * 0.45) return { drone: d, point: closest };
    }
    return null;
  }

  blast(center: THREE.Vector3, r: number, by: Attacker | null): void {
    for (const d of this.list) if (d.alive && d.pos.distanceTo(center) < r * 0.8 && !(d.isPlayer && d.pos.distanceTo(center) < 0.01)) d.kill(by);
  }

  /** Directional EW gun: jams enemy drones inside the cone. */
  jam(origin: THREE.Vector3, dir: THREE.Vector3, team: Team, range = 90, cos = Math.cos(0.3)): number {
    let n = 0;
    for (const d of this.list) {
      if (!d.alive || d.team === team) continue;
      const to = d.pos.clone().sub(origin);
      const dist = to.length();
      if (dist > range || to.normalize().dot(dir) < cos) continue;
      d.jammed = Math.max(d.jammed, 3);
      n++;
    }
    return n;
  }

  threats(): Drone[] {
    return this.list.filter((d) => d.alive && !d.isPlayer && d.team !== this.ctx.settings.playerTeam);
  }
}

export type { Vehicle };
