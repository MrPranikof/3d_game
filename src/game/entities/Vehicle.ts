import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { AssetInstance } from '../../assets/pipeline/ModelLoader';
import type { Team } from '../../assets/StylePreset';
import { AMMO, type Attacker, ballisticElevation, type Damageable, type DamageInfo, type ProjectileSpec } from '../combat/Combat';
import type { Loop } from '../core/Audio';
import type { InputFrame } from '../core/Input';
import { G, groups } from '../core/Physics';
import type { GameContext } from '../GameContext';
import { MAIN_ROAD } from '../world/MapLayout';
import type { Soldier } from './Soldier';

/**
 * Tracked armour (MBTs and the BMP-2). Kinematic simulation tuned for feel:
 *  • hull follows the terrain (4-point sampling) with pitch/roll inertia;
 *  • turret and cannon are independent, stabilised, rate-limited and can be jammed;
 *  • crushes walls, fences, trees and infantry; blocked by foundations, hedgehogs, vehicles;
 *  • laser rangefinder + ballistic computer (superelevation), APFSDS/HE, autocannon/ATGM on BMP;
 *  • smoke screen, three camera views (third person, gunner sight, driver's vision blocks);
 *  • modular damage: tracks, turret ring, optics, armour facing multipliers, ammo cook-off.
 */

export interface VehicleStats {
  name: string;
  hp: number;
  maxSpeed: number;
  reverse: number;
  accel: number;
  turn: number;
  traverse: number;
  elevate: number;
  minPitch: number;
  maxPitch: number;
  reload: number;
  guns: { label: string; spec: ProjectileSpec; ammo: number; interval?: number; guided?: boolean }[];
  smoke: number;
}

const STATS: Record<string, VehicleStats> = {
  tank_t72b3: { name: 'Т-72Б3', hp: 1000, maxSpeed: 16, reverse: 4.5, accel: 3.2, turn: 0.55, traverse: 0.7, elevate: 0.35, minPitch: -0.105, maxPitch: 0.24, reload: 7, smoke: 2,
    guns: [{ label: 'БОПС 3БМ60', spec: AMMO.apfsds, ammo: 22 }, { label: 'ОФС 3ОФ26', spec: AMMO.he, ammo: 18 }] },
  tank_t80bvm: { name: 'Т-80БВМ', hp: 1050, maxSpeed: 18, reverse: 5, accel: 3.8, turn: 0.6, traverse: 0.75, elevate: 0.35, minPitch: -0.09, maxPitch: 0.24, reload: 7, smoke: 2,
    guns: [{ label: 'БОПС 3БМ60', spec: AMMO.apfsds, ammo: 22 }, { label: 'ОФС 3ОФ26', spec: AMMO.he, ammo: 18 }] },
  tank_t64bv: { name: 'Т-64БВ', hp: 900, maxSpeed: 15, reverse: 4.5, accel: 3, turn: 0.55, traverse: 0.65, elevate: 0.33, minPitch: -0.105, maxPitch: 0.24, reload: 7.5, smoke: 2,
    guns: [{ label: 'БОПС 3БМ42', spec: AMMO.apfsds, ammo: 20 }, { label: 'ОФС 3ОФ26', spec: AMMO.he, ammo: 16 }] },
  tank_leo2a4: { name: 'Leopard 2A4', hp: 1050, maxSpeed: 18, reverse: 7, accel: 3.6, turn: 0.6, traverse: 0.9, elevate: 0.4, minPitch: -0.157, maxPitch: 0.35, reload: 5.5, smoke: 2,
    guns: [{ label: 'APFSDS DM53', spec: AMMO.apfsds, ammo: 27 }, { label: 'HE DM11', spec: AMMO.he, ammo: 15 }] },
  tank_leo2a6: { name: 'Leopard 2A6', hp: 1150, maxSpeed: 17, reverse: 7, accel: 3.4, turn: 0.58, traverse: 0.9, elevate: 0.4, minPitch: -0.157, maxPitch: 0.35, reload: 5.5, smoke: 2,
    guns: [{ label: 'APFSDS DM63', spec: AMMO.apfsds, ammo: 27 }, { label: 'HE DM11', spec: AMMO.he, ammo: 15 }] },
  ifv_bmp2: { name: 'БМП-2', hp: 600, maxSpeed: 17, reverse: 5, accel: 4.2, turn: 0.75, traverse: 1.1, elevate: 0.6, minPitch: -0.09, maxPitch: 1.05, reload: 0.15, smoke: 2,
    guns: [{ label: '30-мм 2А42', spec: AMMO.autocannon, ammo: 500, interval: 0.15 }, { label: 'ПТУР «Конкурс»', spec: AMMO.atgm, ammo: 4, guided: true }] },
};

export type View = 'third' | 'gunner' | 'driver';

export class Vehicle implements Damageable, Attacker {
  readonly stats: VehicleStats;
  readonly position = new THREE.Vector3();
  heading: number;
  speed = 0;
  turretYaw = 0;
  gunPitch = 0;
  hp: number;
  alive = true;
  kills = 0;
  crewTeam: Team;
  driver: Soldier | null = null;
  /** AI crew active when nobody (player) drives */
  aiCrew = true;
  view: View = 'third';
  zoomIndex = 0;
  readonly zooms = [3, 8, 12];
  thermal = false;
  gunIndex = 0;
  ammo: number[];
  reloadLeft = 0;
  smokeLeft: number;
  lasedRange = 0;
  tracksBroken = 0;
  turretJam = 0;
  opticsDamaged = false;
  destroyedAt = 0;
  readonly aimTarget = new THREE.Vector3();
  aimYaw = 0;
  aimPitch = 0;
  /** occupant's view direction (camera); the gun follows it via aimYaw/aimPitch */
  lookYaw = 0;
  lookPitch = 0;
  readonly inst: AssetInstance;
  readonly name: string;
  readonly isPlayer = false;
  private hull: THREE.Object3D;
  private turret: THREE.Object3D;
  private cannon: THREE.Object3D;
  private muzzle: THREE.Object3D;
  private camGunner: THREE.Object3D;
  private camDriver: THREE.Object3D;
  private interiors: THREE.Object3D[];
  private trackTex: { L: THREE.Texture[]; R: THREE.Texture[] } = { L: [], R: [] };
  private wheels: { L: THREE.Object3D[]; R: THREE.Object3D[] } = { L: [], R: [] };
  readonly half: THREE.Vector3;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  private pitch = 0;
  private roll = 0;
  private recoil = 0;
  private engine: Loop | null = null;
  private fireHeld = 0;
  ai: TankAI;
  private burnTime = 0;

  constructor(private ctx: GameContext, readonly assetId: string, readonly team: Team, pos: THREE.Vector3, heading: number) {
    this.stats = STATS[assetId];
    this.name = this.stats.name;
    this.crewTeam = team;
    this.hp = this.stats.hp;
    this.heading = heading;
    this.ammo = this.stats.guns.map((g) => g.ammo);
    this.smokeLeft = this.stats.smoke;
    this.inst = ctx.factory.instantiateTemplate(ctx.template(assetId));
    const n = this.inst.nodes;
    this.hull = n.get('Hull')!;
    this.turret = n.get('Turret')!;
    this.cannon = n.get('Cannon')!;
    this.muzzle = n.get('Muzzle')!;
    this.camGunner = n.get('Cam_Gunner')!;
    this.camDriver = n.get('Cam_Driver')!;
    this.interiors = [n.get('Interior_Cockpit')!, n.get('Interior_Gunner')!].filter(Boolean);
    for (const i of this.interiors) i.visible = false;
    this.cannon.userData.baseZ = this.cannon.position.z;
    ctx.scene.add(this.inst.root);

    // per-instance track materials (independent UV scroll per side and per vehicle)
    this.inst.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      const side = mat.name.endsWith('__L') ? 'L' : mat.name.endsWith('__R') ? 'R' : null;
      if (!side) return;
      const key = `${side}_clone`;
      let clone = (this as unknown as Record<string, THREE.MeshStandardMaterial>)[key];
      if (!clone) {
        clone = mat.clone();
        clone.map = mat.map!.clone();
        clone.normalMap = mat.normalMap!.clone();
        clone.roughnessMap = clone.metalnessMap = mat.roughnessMap!.clone();
        this.trackTex[side].push(clone.map, clone.normalMap, clone.roughnessMap);
        (this as unknown as Record<string, THREE.MeshStandardMaterial>)[key] = clone;
      }
      m.material = clone;
    });
    for (const s of ['L', 'R'] as const) {
      this.inst.root.traverse((o) => { if (new RegExp(`^(Wheel|Roller|Sprocket|Idler)_${s}_?`).test(o.name) && !/_m_|_LOD/.test(o.name)) this.wheels[s].push(o); });
    }

    const box = new THREE.Box3().setFromObject(this.hull);
    const size = box.getSize(new THREE.Vector3());
    this.half = new THREE.Vector3(size.x / 2, Math.min(size.y, 2.2) / 2, Math.min(size.z, 7.5) / 2);
    const R = ctx.physics.R;
    this.body = ctx.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    this.collider = ctx.physics.tag(ctx.physics.world.createCollider(
      R.ColliderDesc.cuboid(this.half.x * 0.92, this.half.y * 0.75, this.half.z * 0.95).setTranslation(0, this.half.y * 0.8, 0)
        .setCollisionGroups(groups(G.VEHICLE, G.CHAR | G.DEBRIS | G.VEHICLE)), this.body), { kind: 'vehicle', ref: this });
    this.position.copy(pos);
    this.ai = new TankAI(ctx, this);
    this.place(0);
    this.aimYaw = heading;
  }

  get gun() { return this.stats.guns[this.gunIndex]; }

  // ───────────────────────── control ─────────────────────────

  enter(s: Soldier): void {
    this.driver = s;
    s.vehicle = this;
    this.aiCrew = false;
    this.crewTeam = s.team;
    this.view = 'third';
    this.lasedRange = 0;
    this.aimYaw = this.lookYaw = this.heading + this.turretYaw;
    this.aimPitch = this.lookPitch = this.gunPitch;
    if (!this.engine) this.engine = this.ctx.audio.loop('engine');
  }

  exit(): Soldier | null {
    const s = this.driver;
    if (!s) return null;
    this.driver = null;
    s.vehicle = null;
    this.aiCrew = false; // empty vehicle stays put until someone mounts it
    for (const i of this.interiors) i.visible = false;
    this.turret.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.LOD).isLOD) o.visible = true; });
    this.setThermal(false);
    // dismount on the left side
    const side = new THREE.Vector3(-Math.cos(this.heading), 0, Math.sin(this.heading)).multiplyScalar(this.half.x + 1.2);
    const p = this.position.clone().add(side);
    p.y = this.ctx.terrain.heightAt(p.x, p.z) + 0.1;
    s.teleport(p);
    return s;
  }

  setThermal(on: boolean): void {
    this.thermal = on;
    this.ctx.thermal.set(on);
  }

  /** Player control (driver + gunner). */
  control(f: InputFrame, dt: number): void {
    if (!this.alive) return;
    const throttle = f.move.y;
    const steer = -f.move.x;
    this.drive(throttle, steer, dt);
    const zoomFov = this.view === 'gunner' ? 1 / this.zooms[this.zoomIndex] : 1;
    this.lookYaw += f.look.x * zoomFov;
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch + f.look.y * zoomFov, -0.35, 0.6);
    if (f.pressed.has('view')) this.cycleView();
    if (f.pressed.has('thermal')) this.setThermal(!this.thermal);
    if (f.zoom && this.view === 'gunner') this.zoomIndex = THREE.MathUtils.clamp(this.zoomIndex - Math.sign(f.zoom), 0, this.zooms.length - 1);
    if (f.pressed.has('ads')) { if (this.view !== 'gunner') this.cycleView('gunner'); else this.zoomIndex = (this.zoomIndex + 1) % this.zooms.length; }
    if (f.pressed.has('ammo') && this.stats.guns.length > 1) { this.gunIndex = (this.gunIndex + 1) % this.stats.guns.length; this.reloadLeft = Math.max(this.reloadLeft, this.gun.interval ? 0.5 : this.stats.reload * 0.6); }
    if (f.pressed.has('lase')) this.lase();
    if (f.pressed.has('smoke')) this.launchSmoke();
    const auto = !!this.gun.interval;
    if (auto ? f.held.has('fire') : f.pressed.has('fire')) this.fire(this.driver);
    this.fireHeld = f.held.has('fire') ? this.fireHeld + dt : 0;
  }

  cycleView(to?: View): void {
    const order: View[] = ['third', 'gunner', 'driver'];
    this.view = to ?? order[(order.indexOf(this.view) + 1) % order.length];
    this.interiors[0] && (this.interiors[0].visible = this.view === 'driver');
    // through the sight the crew never sees its own turret / barrel
    this.turret.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.LOD).isLOD) o.visible = this.view !== 'gunner'; });
    if (this.view !== 'gunner' && this.thermal) this.setThermal(false);
  }

  drive(throttle: number, steer: number, dt: number): void {
    const st = this.stats;
    const immobile = this.tracksBroken > 0 || !this.alive;
    const target = immobile ? 0 : throttle > 0 ? throttle * st.maxSpeed : throttle * st.reverse;
    const a = Math.abs(target) < Math.abs(this.speed) || Math.sign(target) !== Math.sign(this.speed) ? st.accel * 2.2 : st.accel;
    this.speed += THREE.MathUtils.clamp(target - this.speed, -a * dt, a * dt);
    const turnRate = immobile ? 0 : steer * st.turn * (1 - Math.min(0.5, Math.abs(this.speed) / st.maxSpeed * 0.5)) * (this.speed < -0.5 ? -1 : 1);
    const newHeading = this.heading + turnRate * dt;
    const fwd = new THREE.Vector3(-Math.sin(newHeading), 0, -Math.cos(newHeading));
    const next = this.position.clone().addScaledVector(fwd, this.speed * dt);
    if (this.collide(next, newHeading)) {
      this.heading = newHeading;
      this.position.copy(next);
    } else {
      this.speed *= -0.2;
    }
    this.trackScroll(dt, turnRate);
  }

  /** Returns false if blocked; crushes soft obstacles on the way. */
  private collide(next: THREE.Vector3, heading: number): boolean {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    // probe only the leading half of the hull, so a vehicle can always back away from contact
    const lead = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading)).multiplyScalar(Math.sign(this.speed || 1) * this.half.z * 0.5);
    const c = next.clone().add(lead).setY(this.ctx.terrain.heightAt(next.x, next.z) + this.half.y + 0.25);
    const hits = this.ctx.physics.overlapBox(c, q, new THREE.Vector3(this.half.x * 0.95, this.half.y * 0.6, this.half.z * 0.5), G.STATIC | G.TREE | G.VEHICLE, this.collider);
    let blocked = false;
    for (const h of hits) {
      const t = h.tag;
      if (!t) continue;
      if (t.kind === 'tree') { this.ctx.vegetation.fell(t.ref, this.position); this.speed *= 0.75; }
      else if (t.kind === 'cluster' && t.ref.building?.passable) { /* revetments get flattened silently */ if (Math.random() < 0.05) this.ctx.statics.destroy(t.ref, this.position, 1); }
      else if (t.kind === 'cluster' && t.ref.soft) { this.ctx.statics.destroy(t.ref, this.position, 3); this.speed *= 0.6; this.ctx.audio.impact(c, true); }
      else if (t.kind === 'cluster') { this.ctx.statics.destroy(t.ref, this.position, 2); this.speed *= 0.4; }
      else if (t.kind === 'vehicle' && t.ref !== this) blocked = true;
      else if (t.kind === 'static' && !t.ref?.building?.passable) blocked = true;
    }
    // crush infantry in front
    if (Math.abs(this.speed) > 1.5) {
      const fwd = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading)).multiplyScalar(Math.sign(this.speed));
      for (const s of this.ctx.soldiers) {
        if (!s.alive || s.vehicle) continue;
        const rel = s.position.clone().sub(next);
        const along = rel.dot(fwd), lat = Math.abs(rel.x * fwd.z - rel.z * fwd.x);
        if (along > 0 && along < this.half.z + 0.6 && lat < this.half.x + 0.2 && Math.abs(rel.y) < 2) {
          s.applyDamage({ kind: 'crush', amount: 300, ap: 0, point: s.position, dir: fwd, attacker: this.driver ?? this });
        }
      }
    }
    return !blocked;
  }

  private trackScroll(dt: number, turnRate: number): void {
    const vL = this.speed + turnRate * this.half.x, vR = this.speed - turnRate * this.half.x;
    for (const t of this.trackTex.L) t.offset.y += (vL * dt) / 0.6;
    for (const t of this.trackTex.R) t.offset.y += (vR * dt) / 0.6;
    for (const w of this.wheels.L) w.rotation.x -= (vL * dt) / 0.35;
    for (const w of this.wheels.R) w.rotation.x -= (vR * dt) / 0.35;
  }

  // ───────────────────────── weapons ─────────────────────────

  private lase(): void {
    const origin = this.camGunner.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(-Math.sin(this.aimYaw) * Math.cos(this.aimPitch), Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * Math.cos(this.aimPitch));
    const hit = this.ctx.physics.raycast(origin, dir, 4000, { exclude: this.collider });
    this.lasedRange = hit ? Math.round(hit.distance) : 0;
    this.ctx.audio.ui('click');
  }

  /** Ballistic computer: superelevation (rad) for current ammo at lased range. */
  superelevation(): number {
    if (!this.lasedRange || this.gun.guided) return 0;
    return ballisticElevation(this.gun.spec, this.lasedRange);
  }

  private launchSmoke(): void {
    if (this.smokeLeft <= 0) return;
    this.smokeLeft--;
    const yaw = this.heading + this.turretYaw;
    for (const off of [-0.6, 0, 0.6]) {
      const d = new THREE.Vector3(-Math.sin(yaw + off), 0, -Math.cos(yaw + off)).multiplyScalar(32);
      const p = this.position.clone().add(d);
      p.y = this.ctx.terrain.heightAt(p.x, p.z) + 2;
      this.ctx.particles.smokeScreen(p, 9, 28);
    }
    this.ctx.audio.shot(this.position, true);
  }

  fire(by: Attacker | null): boolean {
    if (!this.alive || this.reloadLeft > 0 || this.ammo[this.gunIndex] <= 0) return false;
    const gun = this.gun;
    this.ammo[this.gunIndex]--;
    this.reloadLeft = gun.interval ?? this.stats.reload;
    this.inst.root.updateMatrixWorld(true);
    const origin = this.muzzle.getWorldPosition(new THREE.Vector3());
    const q = this.cannon.getWorldQuaternion(new THREE.Quaternion());
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const disp = gun.interval ? 0.003 : 0.0006;
    dir.add(new THREE.Vector3((Math.random() - 0.5) * disp, (Math.random() - 0.5) * disp, (Math.random() - 0.5) * disp)).normalize();
    const big = !gun.interval;
    let guide: (() => THREE.Ray | null) | undefined;
    let mesh: THREE.Object3D | undefined;
    if (gun.guided) {
      const self = this;
      guide = () => (self.alive ? new THREE.Ray(self.camGunner.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(-Math.sin(self.aimYaw) * Math.cos(self.aimPitch), Math.sin(self.aimPitch), -Math.cos(self.aimYaw) * Math.cos(self.aimPitch))) : null);
      mesh = missileMesh();
    }
    this.ctx.combat.fire(gun.spec, origin, dir, this.crewTeam, by ?? this, { exclude: this.collider, guide, mesh });
    this.ctx.particles.muzzleFlash(origin, dir, big);
    if (big) {
      this.ctx.audio.cannon(this.driver ? null : origin);
      this.recoil = 1;
      if (this.driver?.isPlayer) this.ctx.combat.shake = Math.max(this.ctx.combat.shake, 0.6);
      for (let i = 0; i < 6; i++) this.ctx.particles.dust(this.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0.3, (Math.random() - 0.5) * 6)), dir.clone().multiplyScalar(3), 3);
    } else this.ctx.audio.shot(this.driver ? null : origin, true);
    return true;
  }

  // ───────────────────────── damage ─────────────────────────

  distanceToSurface(p: THREE.Vector3): number {
    const local = this.hull.worldToLocal(p.clone());
    const dx = Math.max(0, Math.abs(local.x) - this.half.x), dy = Math.max(0, Math.abs(local.y - this.half.y) - this.half.y), dz = Math.max(0, Math.abs(local.z) - this.half.z);
    return Math.hypot(dx, dy, dz);
  }

  applyDamage(d: DamageInfo): void {
    this.hitAt(d);
  }

  hitAt(d: DamageInfo): void {
    if (!this.alive || d.ap <= 0) return;
    const local = this.hull.worldToLocal(d.point.clone());
    const q = this.hull.getWorldQuaternion(new THREE.Quaternion()).invert();
    const dir = d.dir.clone().applyQuaternion(q);
    let mult = 1;
    let zone = 'борт';
    if (dir.y < -0.55 && local.y > this.half.y * 1.2) { mult = 2.1; zone = 'крыша'; }
    else if (dir.z > 0.55) { mult = 0.45; zone = 'лоб'; }
    else if (dir.z < -0.55) { mult = 1.6; zone = 'корма'; }
    if (this.assetId === 'ifv_bmp2') mult *= 1.6;
    const turretLocal = this.turret.worldToLocal(d.point.clone());
    if (Math.abs(local.x) > this.half.x - 0.75 && local.y < 1.1 && d.ap > 40) { this.tracksBroken = 14; zone = 'гусеница'; mult *= 0.5; }
    else if (turretLocal.y > -0.1 && turretLocal.y < 0.15 && d.ap > 80 && Math.random() < 0.4) { this.turretJam = 10; zone = 'погон башни'; }
    if (turretLocal.x > 0.25 && turretLocal.y > 0.5 && turretLocal.z < -0.1 && d.ap > 30) { this.opticsDamaged = true; zone = 'прицел'; }
    const dmg = d.ap * mult * (0.85 + Math.random() * 0.3);
    this.hp -= dmg;
    if (d.attacker?.isPlayer) this.ctx.hud.hitMarker(this.hp <= 0, false, `${this.name}: ${zone} −${Math.round(dmg)}`);
    if (this.driver?.isPlayer) { this.ctx.hud.vehicleHit(zone); this.ctx.combat.shake = Math.max(this.ctx.combat.shake, 0.8); }
    if (this.hp <= 0) this.destroy(d.attacker);
  }

  private destroy(by: Attacker | null): void {
    this.alive = false;
    this.hp = 0;
    this.destroyedAt = this.ctx.time;
    this.speed = 0;
    if (by && by !== this) by.kills++;
    this.ctx.killFeed(by && by !== this ? by.name : '', this.name, 'уничтожен', by ? by.team : null, this.crewTeam);
    this.ctx.conquest.onVehicleLost(this.crewTeam);
    const center = this.position.clone().setY(this.position.y + 1.5);
    this.ctx.particles.explosion(center, 2.2);
    this.ctx.audio.explosion(center, 2);
    // crew
    const crew = this.driver;
    if (crew) { this.exit(); crew.die({ kind: 'he', amount: 999, ap: 0, point: center, dir: new THREE.Vector3(), attacker: by }); }
    // burnt look
    const burnt = new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.95, metalness: 0.2 });
    this.inst.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = burnt; });
    // turret toss (ammo cook-off) for MBTs
    if (this.assetId !== 'ifv_bmp2' && Math.random() < 0.6) {
      const R = this.ctx.physics.R;
      const tw = this.turret.getWorldPosition(new THREE.Vector3());
      const tq = this.turret.getWorldQuaternion(new THREE.Quaternion());
      this.ctx.scene.attach(this.turret);
      const body = this.ctx.physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(tw.x, tw.y + 0.4, tw.z).setRotation(tq));
      const col = R.ColliderDesc.cuboid(1.2, 0.4, 1.4).setTranslation(0, 0.35, 0).setDensity(800).setCollisionGroups(groups(G.DEBRIS, G.TERRAIN | G.STATIC | G.DEBRIS));
      this.ctx.physics.world.createCollider(col, body);
      body.applyImpulse({ x: (Math.random() - 0.5) * 4 * body.mass(), y: 9 * body.mass(), z: (Math.random() - 0.5) * 4 * body.mass() }, true);
      body.applyTorqueImpulse({ x: (Math.random() - 0.5) * body.mass() * 3, y: body.mass() * 2, z: (Math.random() - 0.5) * body.mass() * 3 }, true);
      this.ctx.physics.addDynamic(this.turret, body);
      this.turret.position.copy(tw);
    }
    this.engine?.stop();
    this.engine = null;
  }

  removeWreck(): void {
    this.inst.root.removeFromParent();
    this.ctx.physics.removeCollider(this.collider);
    this.ctx.physics.world.removeRigidBody(this.body);
    this.ctx.physics.removeDynamic(this.turret);
    this.turret.removeFromParent();
  }

  // ───────────────────────── per-frame ─────────────────────────

  update(dt: number): void {
    if (!this.alive) {
      this.burnTime += dt;
      if (this.burnTime < 60 && Math.random() < 0.5) this.ctx.particles.burning(this.position.clone().setY(this.position.y + 1.8));
      return;
    }
    this.reloadLeft = Math.max(0, this.reloadLeft - dt);
    this.tracksBroken = Math.max(0, this.tracksBroken - dt);
    this.turretJam = Math.max(0, this.turretJam - dt);
    if (this.aiCrew && !this.driver) this.ai.update(dt);
    else if (!this.driver) this.drive(0, 0, dt);

    // turret & gun servo towards the world-space aim
    if (this.turretJam <= 0) {
      const want = wrap(this.aimYaw - this.heading - this.turretYaw);
      this.turretYaw += THREE.MathUtils.clamp(want, -this.stats.traverse * dt, this.stats.traverse * dt);
    }
    const hullPitchAlong = this.pitch * Math.cos(this.turretYaw) - this.roll * Math.sin(this.turretYaw);
    const wantPitch = THREE.MathUtils.clamp(this.aimPitch + this.superelevation() - hullPitchAlong, this.stats.minPitch, this.stats.maxPitch);
    this.gunPitch += THREE.MathUtils.clamp(wantPitch - this.gunPitch, -this.stats.elevate * dt, this.stats.elevate * dt);
    this.recoil = Math.max(0, this.recoil - dt * 2.5);
    this.place(dt);

    if (Math.abs(this.speed) > 2 && Math.random() < 0.3) {
      const back = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading)).multiplyScalar(this.half.z);
      this.ctx.particles.dust(this.position.clone().add(back).setY(this.position.y + 0.4), new THREE.Vector3(0, 0.8, 0), 2.2);
    }
    if (this.engine) {
      const dist = this.driver?.isPlayer ? 0 : this.ctx.camera.position.distanceTo(this.position);
      this.engine.set(Math.min(1, Math.abs(this.speed) / this.stats.maxSpeed + 0.15), Math.max(0, 1 - dist / 150));
    } else if (this.ctx.camera.position.distanceTo(this.position) < 120) {
      this.engine = this.ctx.audio.loop('engine');
    }
  }

  /** Terrain-following placement of hull, turret, cannon and physics body. */
  place(dt: number): void {
    const t = this.ctx.terrain;
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    const L = this.half.z * 0.8, W = this.half.x * 0.8;
    const p = this.position;
    const hf = t.heightAt(p.x - sh * L, p.z - ch * L), hb = t.heightAt(p.x + sh * L, p.z + ch * L);
    const hl = t.heightAt(p.x - ch * W, p.z + sh * W), hr = t.heightAt(p.x + ch * W, p.z - sh * W);
    const targetY = Math.max((hf + hb + hl + hr) / 4, t.heightAt(p.x, p.z) - 0.2);
    const k = dt ? Math.min(1, dt * 6) : 1;
    p.y += (targetY - p.y) * k;
    this.pitch += (Math.atan2(hf - hb, 2 * L) - this.pitch) * k;
    this.roll += (Math.atan2(hr - hl, 2 * W) - this.roll) * k;
    const root = this.inst.root;
    root.position.copy(p);
    root.rotation.set(this.pitch, this.heading, this.roll, 'YXZ');
    this.turret.rotation.y = this.turretYaw;
    this.cannon.rotation.x = this.gunPitch;
    this.cannon.position.z = this.cannon.userData.baseZ + this.recoil * 0.35;
    this.body.setNextKinematicTranslation(p);
    this.body.setNextKinematicRotation(root.quaternion);
  }

  /** Camera placement for the occupant. */
  updateCamera(cam: THREE.PerspectiveCamera, dt: number): void {
    this.inst.root.updateMatrixWorld(true);
    if (this.view === 'gunner') {
      this.aimYaw = this.lookYaw;
      this.aimPitch = this.lookPitch;
      cam.position.copy(this.camGunner.getWorldPosition(new THREE.Vector3()));
      cam.quaternion.setFromEuler(new THREE.Euler(this.lookPitch, this.lookYaw, 0, 'YXZ'));
      cam.fov = 40 / this.zooms[this.zoomIndex];
      if (this.interiors[1]) this.interiors[1].visible = false;
    } else if (this.view === 'driver') {
      this.aimYaw = this.lookYaw;
      this.aimPitch = this.lookPitch;
      cam.position.copy(this.camDriver.getWorldPosition(new THREE.Vector3()));
      const hq = this.hull.getWorldQuaternion(new THREE.Quaternion());
      const look = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.clamp(this.lookPitch, -0.3, 0.3) * 0.5, THREE.MathUtils.clamp(wrap(this.lookYaw - this.heading), -0.6, 0.6), 0, 'YXZ'));
      cam.quaternion.copy(hq.multiply(look));
      cam.fov = 85;
    } else {
      const pivot = this.position.clone().setY(this.position.y + 2.6);
      const lookDir = new THREE.Vector3(-Math.sin(this.lookYaw) * Math.cos(this.lookPitch), Math.sin(this.lookPitch), -Math.cos(this.lookYaw) * Math.cos(this.lookPitch));
      const back = lookDir.clone().setY(0).normalize();
      const camPos = pivot.clone().addScaledVector(back, -10).setY(pivot.y + 2.2 - this.lookPitch * 6);
      const ground = this.ctx.terrain.heightAt(camPos.x, camPos.z) + 0.6;
      if (camPos.y < ground) camPos.y = ground;
      cam.position.lerp(camPos, dt ? Math.min(1, dt * 12) : 1);
      cam.lookAt(pivot.clone().addScaledVector(lookDir, 30));
      cam.fov = 70;
      // third person: the gun aims at whatever is under the screen centre
      const viewDir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const hit = this.ctx.physics.raycast(cam.position, viewDir, 2000, { exclude: this.collider });
      const point = hit ? hit.point : cam.position.clone().addScaledVector(viewDir, 2000);
      const from = this.cannon.getWorldPosition(new THREE.Vector3());
      const d = point.clone().sub(from);
      this.aimYaw = Math.atan2(-d.x, -d.z);
      this.aimPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      this.aimTarget.copy(point);
    }
    cam.updateProjectionMatrix();
  }

  /** World-space point the gun currently points at (for HUD reticle / impact prediction). */
  gunDir(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(this.cannon.getWorldQuaternion(new THREE.Quaternion()));
  }

  muzzlePos(): THREE.Vector3 {
    return this.muzzle.getWorldPosition(new THREE.Vector3());
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function missileMesh(): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3d4430, roughness: 0.6 }));
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffaa55 }));
  glow.position.z = 0.5;
  g.add(body, glow);
  return g;
}

// ───────────────────────────── AI crew ─────────────────────────────

/** Tank crew AI: advance to an overwatch position near a contested point, scan, engage. */
export class TankAI {
  private think = 0;
  private target: { pos: () => THREE.Vector3; alive: () => boolean; vehicle: boolean } | null = null;
  private dest: THREE.Vector3 | null = null;
  private stuck = 0;
  private lastPos = new THREE.Vector3();
  private reverseT = 0;

  constructor(private ctx: GameContext, private v: Vehicle) {}

  update(dt: number): void {
    const v = this.v;
    this.think -= dt;
    if (this.think <= 0) {
      this.think = 0.5 + Math.random() * 0.3;
      this.pickDestination();
      this.scan();
    }
    // movement
    let throttle = 0, steer = 0;
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      throttle = -0.6;
      steer = 0.8;
    } else if (this.dest) {
      const to = this.waypoint().sub(v.position);
      const dist = Math.hypot(to.x, to.z);
      if (dist > 12) {
        let want = Math.atan2(-to.x, -to.z);
        // obstacle feelers: hedgehogs, foundations, other vehicles
        const free = (a: number) => !this.blockedAhead(a);
        if (!free(v.heading) || !free(want)) {
          for (const d of [0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6]) if (free(want + d)) { want += d; break; }
        }
        const err = wrap(want - v.heading);
        steer = THREE.MathUtils.clamp(err * 1.5, -1, 1);
        throttle = Math.abs(err) > 1.2 ? 0.15 : this.target ? 0.35 : 0.75;
      }
    }
    v.drive(throttle, steer, dt);
    // stuck detection → back up and turn
    this.stuck += dt;
    if (this.stuck > 3) {
      if (throttle > 0.3 && v.position.distanceTo(this.lastPos) < 2) this.reverseT = 2.5;
      this.lastPos.copy(v.position);
      this.stuck = 0;
    }
    // aiming & firing
    if (this.target && this.target.alive()) {
      const tp = this.target.pos();
      const from = v.muzzlePos();
      const d = tp.clone().sub(from);
      const range = d.length();
      v.aimYaw = Math.atan2(-d.x, -d.z);
      v.aimPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      v.lasedRange = Math.round(range);
      // choose ammo
      const wantGun = this.target.vehicle ? 0 : v.stats.guns.length > 1 && !v.stats.guns[1].guided ? 1 : 0;
      if (v.gunIndex !== wantGun && v.ammo[wantGun] > 0) v.gunIndex = wantGun;
      const aligned = Math.abs(wrap(v.aimYaw - v.heading - v.turretYaw)) < 0.02;
      if (aligned && range < (this.target.vehicle ? 900 : 450) && Math.random() < (v.gun.interval ? 0.5 : 0.04)) v.fire(v);
    } else {
      v.aimYaw = v.heading + Math.sin(this.ctx.time * 0.3) * 0.6;
      v.aimPitch = 0;
      v.lasedRange = 0;
    }
  }

  private routeIdx: number | null = null;
  private routeGoal = -1;

  /** Long hauls follow the main road (kept clear of buildings); the last stretch is direct. */
  private waypoint(): THREE.Vector3 {
    const v = this.v, dest = this.dest!;
    if (Math.hypot(dest.x - v.position.x, dest.z - v.position.z) < 110) { this.routeIdx = null; return dest.clone(); }
    const R = MAIN_ROAD;
    const dist = (k: number) => Math.hypot(R[k][0] - v.position.x, R[k][1] - v.position.z);
    const nearest = (x: number, z: number) => R.reduce((bi, p, i) => (Math.hypot(p[0] - x, p[1] - z) < Math.hypot(R[bi][0] - x, R[bi][1] - z) ? i : bi), 0);
    const j = nearest(dest.x, dest.z);
    if (this.routeIdx === null || this.routeGoal !== j) {
      let k = nearest(v.position.x, v.position.z);
      const step = j >= k ? 1 : -1;
      // already between k and the next vertex → start from the next one
      if (k !== j && dist(k + step) < Math.hypot(R[k][0] - R[k + step][0], R[k][1] - R[k + step][1])) k += step;
      this.routeIdx = k;
      this.routeGoal = j;
    }
    const step = j >= this.routeIdx ? 1 : -1;
    if (dist(this.routeIdx) < 20 && this.routeIdx !== j) this.routeIdx += step;
    if (this.routeIdx === j && dist(j) < 20) return dest.clone();
    return new THREE.Vector3(R[this.routeIdx][0], 0, R[this.routeIdx][1]);
  }

  private blockedAhead(heading: number): boolean {
    const v = this.v;
    const dir = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    for (const side of [-1, 0, 1]) {
      const o = v.position.clone().addScaledVector(dir, v.half.z * 0.9).add(new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(side * v.half.x * 0.9));
      o.y = this.ctx.terrain.heightAt(o.x, o.z) + 1.0;
      const hit = this.ctx.physics.raycast(o, dir, 14, { exclude: v.collider, mask: G.STATIC | G.VEHICLE, predicate: (t) => !(t?.kind === 'cluster' && t.ref?.soft) && !t?.ref?.building?.passable });
      if (hit) return true;
    }
    return false;
  }

  private pickDestination(): void {
    const v = this.v;
    const pts = this.ctx.conquest.points;
    const ours = (p: { owner: Team | null }) => p.owner === v.crewTeam;
    // closest point not held by us, else the most contested one we hold
    const sorted = [...pts].sort((a, b) => v.position.distanceTo(new THREE.Vector3(a.x, 0, a.z)) - v.position.distanceTo(new THREE.Vector3(b.x, 0, b.z)));
    const goal = sorted.find((p) => !ours(p)) ?? sorted[0];
    // overwatch: stop ~70 m short of the objective on our side
    const base = this.ctx.layout.spawns[v.crewTeam][0];
    const dir = new THREE.Vector3(base[0] - goal.x, 0, base[1] - goal.z).normalize();
    this.dest = new THREE.Vector3(goal.x + dir.x * 70, 0, goal.z + dir.z * 70);
  }

  private scan(): void {
    const v = this.v;
    const eye = v.muzzlePos();
    let best: TankAI['target'] = null;
    let bestScore = Infinity;
    for (const o of this.ctx.vehicles) {
      if (!o.alive || o === v || o.crewTeam === v.crewTeam || (o.aiCrew === false && !o.driver)) continue;
      const d = o.position.distanceTo(v.position);
      if (d > 900) continue;
      const tp = o.position.clone().setY(o.position.y + 1.4);
      if (!this.los(eye, tp, o.collider)) continue;
      if (d * 0.5 < bestScore) { bestScore = d * 0.5; best = { pos: () => o.position.clone().setY(o.position.y + 1.3), alive: () => o.alive, vehicle: true }; }
    }
    for (const s of this.ctx.soldiers) {
      if (!s.alive || s.team === v.crewTeam || s.vehicle) continue;
      const d = s.position.distanceTo(v.position);
      if (d > 420 || d > bestScore) continue;
      if (!this.los(eye, s.center(), s.collider)) continue;
      bestScore = d;
      best = { pos: () => s.center(), alive: () => s.alive && !s.vehicle, vehicle: false };
    }
    this.target = best;
  }

  private los(a: THREE.Vector3, b: THREE.Vector3, targetCollider: RAPIER.Collider): boolean {
    if (this.ctx.particles.blockedBySmoke(a, b)) return false;
    const d = b.clone().sub(a);
    const len = d.length();
    const hit = this.ctx.physics.raycast(a, d.divideScalar(len), len, { exclude: this.v.collider, mask: G.TERRAIN | G.STATIC | G.TREE | G.VEHICLE | G.CHAR });
    return !hit || hit.collider === targetCollider || hit.distance > len - 1;
  }
}
