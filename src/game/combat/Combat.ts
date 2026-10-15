import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Team } from '../../assets/StylePreset';
import type { GameContext } from '../GameContext';
import { G } from '../core/Physics';
import { rnd } from '../fx/Particles';

/**
 * External ballistics + terminal effects.
 *  • projectiles integrate gravity, quadratic air drag (relative to wind) and are swept with
 *    Rapier raycasts every step, so fast rounds never tunnel;
 *  • guided rounds (SACLOS ATGM) steer towards the operator's line of sight;
 *  • explosions apply falloff damage, armour damage, cluster destruction, tree felling,
 *    drone kills and camera shake.
 */

export type DamageKind = 'bullet' | 'apfsds' | 'he' | 'fpv' | 'grenade' | 'mortar' | 'atgm' | 'crush' | 'fall';

export interface DamageInfo {
  kind: DamageKind;
  amount: number;
  /** anti-armour damage (vehicles) */
  ap: number;
  point: THREE.Vector3;
  dir: THREE.Vector3;
  attacker: Attacker | null;
  headshot?: boolean;
}

export interface Attacker {
  team: Team;
  name: string;
  isPlayer: boolean;
  kills: number;
}

export interface Damageable {
  team: Team;
  alive: boolean;
  applyDamage(d: DamageInfo): void;
}

export interface ProjectileSpec {
  kind: DamageKind;
  speed: number;
  /** quadratic drag coefficient k: a = −k·|v_rel|·v_rel */
  drag: number;
  gravity: number;
  damage: number;
  ap: number;
  explosive?: { radius: number; damage: number; ap: number; destroy: number };
  tracer?: [number, number, number] | null;
  life: number;
  radius?: number;
}

export const AMMO: Record<string, ProjectileSpec> = {
  rifle: { kind: 'bullet', speed: 880, drag: 0.0011, gravity: 1, damage: 34, ap: 0, life: 3, tracer: null },
  rifleTracer: { kind: 'bullet', speed: 880, drag: 0.0011, gravity: 1, damage: 34, ap: 0, life: 3, tracer: [5, 2.4, 0.9] },
  mg: { kind: 'bullet', speed: 830, drag: 0.0009, gravity: 1, damage: 40, ap: 2, life: 3, tracer: [5, 1.8, 0.7] },
  apfsds: { kind: 'apfsds', speed: 1650, drag: 0.00004, gravity: 1, damage: 250, ap: 420, life: 4, tracer: [6, 4, 2] },
  he: { kind: 'he', speed: 850, drag: 0.0002, gravity: 1, damage: 120, ap: 110, life: 6, tracer: [6, 3, 1.5], explosive: { radius: 9, damage: 140, ap: 90, destroy: 6 } },
  autocannon: { kind: 'he', speed: 960, drag: 0.0004, gravity: 1, damage: 60, ap: 45, life: 4, tracer: [6, 3, 1], explosive: { radius: 3, damage: 55, ap: 25, destroy: 1.5 } },
  mortar: { kind: 'mortar', speed: 105, drag: 0.00002, gravity: 1, damage: 120, ap: 60, life: 40, tracer: null, explosive: { radius: 11, damage: 150, ap: 70, destroy: 6 } },
  atgm: { kind: 'atgm', speed: 210, drag: 0, gravity: 0, damage: 200, ap: 650, life: 18, tracer: [6, 3, 1.2], explosive: { radius: 4, damage: 160, ap: 0, destroy: 4 } },
  grenade: { kind: 'grenade', speed: 0, drag: 0.004, gravity: 1, damage: 90, ap: 40, life: 20, tracer: null, explosive: { radius: 5, damage: 110, ap: 60, destroy: 2.5 } },
};

const solveCache = new Map<string, number>();

/**
 * Fire-control solution: launch elevation (rad, relative to the line of sight) that makes a
 * round of `spec` drop onto a target `range` metres away — integrated with the same gravity +
 * quadratic drag model the projectiles use (wind ignored, as on a real FCS without a wind sensor).
 */
export function ballisticElevation(spec: ProjectileSpec, range: number): number {
  if (range <= 0 || spec.gravity === 0) return 0;
  const key = `${spec.kind}|${spec.speed}|${Math.round(range / 5)}`;
  const cached = solveCache.get(key);
  if (cached !== undefined) return cached;
  let angle = 0;
  for (let iter = 0; iter < 6; iter++) {
    let x = 0, y = 0, vx = Math.cos(angle) * spec.speed, vy = Math.sin(angle) * spec.speed;
    const dt = 1 / 240;
    for (let t = 0; t < spec.life && x < range; t += dt) {
      const sp = Math.hypot(vx, vy);
      vx -= spec.drag * sp * vx * dt;
      vy -= (spec.drag * sp * vy + 9.81 * spec.gravity) * dt;
      x += vx * dt;
      y += vy * dt;
    }
    if (x < range) { angle = Math.PI / 4; break; } // out of range
    angle += Math.atan2(-y, range);
  }
  solveCache.set(key, angle);
  return angle;
}

interface Projectile {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spec: ProjectileSpec;
  age: number;
  team: Team;
  attacker: Attacker | null;
  exclude?: RAPIER.Collider;
  guide?: () => THREE.Ray | null;
  mesh?: THREE.Object3D;
  whizzed?: boolean;
}

export class Combat {
  readonly projectiles: Projectile[] = [];
  readonly wind = new THREE.Vector3(3.2, 0, -1.1);
  private time = 0;
  shake = 0;

  constructor(private ctx: GameContext) {}

  fire(spec: ProjectileSpec, origin: THREE.Vector3, dir: THREE.Vector3, team: Team, attacker: Attacker | null, opts: { exclude?: RAPIER.Collider; inheritVel?: THREE.Vector3; guide?: () => THREE.Ray | null; mesh?: THREE.Object3D; speed?: number } = {}): void {
    const vel = dir.clone().normalize().multiplyScalar(opts.speed ?? spec.speed);
    if (opts.inheritVel) vel.add(opts.inheritVel);
    const p: Projectile = { pos: origin.clone(), vel, spec, age: 0, team, attacker, exclude: opts.exclude, guide: opts.guide, mesh: opts.mesh };
    if (opts.mesh) this.ctx.scene.add(opts.mesh);
    this.projectiles.push(p);
    if (spec.tracer) this.ctx.particles.tracer(origin.clone().addScaledVector(vel, 0.004), vel, spec.tracer);
  }

  update(dt: number): void {
    this.time += dt;
    this.wind.set(3.2 + Math.sin(this.time * 0.05) * 1.5, 0, -1.1 + Math.cos(this.time * 0.031) * 1.2);
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const camPos = this.ctx.camera.getWorldPosition(new THREE.Vector3());
    const rel = new THREE.Vector3();
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      if (p.age > p.spec.life || p.pos.y < -50) { this.remove(i); continue; }
      // guidance: steer velocity towards the operator's sight line (SACLOS)
      if (p.guide) {
        const ray = p.guide();
        if (ray) {
          const toLine = ray.closestPointToPoint(p.pos.clone().addScaledVector(p.vel, 0.35), new THREE.Vector3()).sub(p.pos);
          const desired = toLine.normalize().multiplyScalar(p.spec.speed);
          p.vel.lerp(desired, Math.min(1, dt * 3.5));
        }
        if (Math.random() < 0.6) this.ctx.particles.exhaust(p.pos.clone(), p.vel.clone().multiplyScalar(-0.05));
      }
      rel.copy(p.vel).sub(this.wind);
      const sp = rel.length();
      p.vel.addScaledVector(rel, -p.spec.drag * sp * dt);
      p.vel.y -= 9.81 * p.spec.gravity * dt;
      const step = p.vel.length() * dt;
      const dir = p.vel.clone().divideScalar(step / dt || 1);
      const hit = this.ctx.physics.raycast(p.pos, dir, step, { exclude: p.exclude, mask: G.TERRAIN | G.STATIC | G.CHAR | G.VEHICLE | G.TREE | G.DEBRIS });
      // drones are too small for the broadphase → analytic sphere test
      const droneHit = this.ctx.drones.findHit(p.pos, dir, hit ? hit.distance : step, p.team);
      if (droneHit) {
        droneHit.drone.kill(p.attacker);
        if (p.spec.explosive) this.explode(droneHit.point, p.spec, p.attacker, p.team);
        this.remove(i);
        continue;
      }
      if (hit) {
        this.onHit(p, hit.point, hit.normal, hit.tag?.kind, hit.tag?.ref, dir);
        this.remove(i);
        continue;
      }
      // near-miss crack for the player
      if (!p.whizzed && p.spec.kind === 'bullet' && p.attacker && !p.attacker.isPlayer) {
        const seg = new THREE.Line3(p.pos, p.pos.clone().addScaledVector(dir, step));
        if (seg.closestPointToPoint(camPos, true, new THREE.Vector3()).distanceTo(camPos) < 2.5) {
          p.whizzed = true;
          this.ctx.audio.whizz();
          this.ctx.player.suppress(0.25);
        }
      }
      p.pos.addScaledVector(dir, step);
      if (p.mesh) { p.mesh.position.copy(p.pos); p.mesh.lookAt(p.pos.clone().add(p.vel)); }
    }
  }

  private remove(i: number): void {
    this.projectiles[i].mesh?.removeFromParent();
    this.projectiles.splice(i, 1);
  }

  private onHit(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3, kind: string | undefined, ref: unknown, dir: THREE.Vector3): void {
    const s = p.spec;
    if (kind === 'soldier') {
      const target = ref as Damageable & { headY(): number };
      const head = point.y > target.headY();
      if (!p.attacker || target.team !== p.team) {
        target.applyDamage({ kind: s.kind, amount: s.damage * (head ? 2.6 : 1), ap: s.ap, point, dir, attacker: p.attacker, headshot: head });
      }
      this.ctx.particles.impact(point, dir.clone().negate(), 'dirt');
      for (let k = 0; k < 4; k++) this.ctx.particles.dust(point, rnd(1), 0.25);
    } else if (kind === 'vehicle') {
      const v = ref as Damageable & { hitAt(d: DamageInfo): void };
      if (s.kind !== 'bullet' || s.ap > 0) v.hitAt({ kind: s.kind, amount: s.damage, ap: s.ap, point, dir, attacker: p.attacker });
      this.ctx.particles.impact(point, normal, 'metal');
      this.ctx.audio.impact(point, true);
    } else if (kind === 'emplacement') {
      (ref as Damageable).applyDamage({ kind: s.kind, amount: s.damage, ap: s.ap, point, dir, attacker: p.attacker });
      this.ctx.particles.impact(point, normal, 'metal');
    } else {
      const mat = kind === 'terrain' ? 'dirt' : kind === 'tree' ? 'wood' : 'stone';
      this.ctx.particles.impact(point, normal, mat);
      if (s.kind === 'bullet') this.ctx.audio.impact(point);
      // AP rounds and HE crack weak masonry
      if (kind === 'cluster' && (s.kind === 'apfsds' || s.kind === 'atgm')) this.ctx.statics.destroy(ref as never, point.clone().sub(dir), 4);
    }
    if (s.explosive) this.explode(point.clone().addScaledVector(normal, 0.2), s, p.attacker, p.team);
  }

  explode(center: THREE.Vector3, spec: ProjectileSpec, attacker: Attacker | null, team: Team): void {
    const ex = spec.explosive!;
    const ctx = this.ctx;
    const scale = Math.min(2.2, ex.radius / 5);
    ctx.particles.explosion(center, scale);
    ctx.audio.explosion(center, scale);
    const camDist = ctx.camera.getWorldPosition(new THREE.Vector3()).distanceTo(center);
    this.shake = Math.max(this.shake, Math.min(1.2, (ex.radius * 3) / (camDist + 2)));

    for (const s of ctx.soldiers) {
      if (!s.alive) continue;
      const c = s.center();
      const d = c.distanceTo(center);
      if (d > ex.radius) continue;
      const fall = 1 - d / ex.radius;
      // cover check: masonry between blast and target absorbs most of it
      const dir = c.clone().sub(center);
      const covered = d > 1.2 && !!ctx.physics.raycast(center, dir.clone().normalize(), d - 0.4, { mask: G.STATIC | G.TERRAIN });
      s.applyDamage({ kind: spec.kind, amount: ex.damage * fall * fall * (covered ? 0.25 : 1) + (d < 1.5 ? ex.damage : 0), ap: 0, point: center, dir: dir.normalize(), attacker });
    }
    for (const v of ctx.vehicles) {
      if (!v.alive) continue;
      const d = v.distanceToSurface(center);
      if (d > ex.radius * 0.6) continue;
      const k = 1 - d / (ex.radius * 0.6);
      v.hitAt({ kind: spec.kind, amount: 0, ap: (ex.ap + (d < 0.6 ? spec.ap : 0)) * k, point: center, dir: v.position.clone().sub(center).normalize(), attacker });
    }
    for (const e of ctx.emplacements) if (e.alive && e.position.distanceTo(center) < ex.radius * 0.7) e.applyDamage({ kind: spec.kind, amount: 200, ap: 0, point: center, dir: new THREE.Vector3(), attacker });
    for (const c of ctx.statics.near(center, ex.destroy)) ctx.statics.destroy(c, center, 3 + ex.destroy);
    for (const t of ctx.vegetation.near(center, ex.destroy * 0.6)) ctx.vegetation.fell(t, center);
    ctx.drones.blast(center, ex.radius, attacker);
    void team;
  }
}
