import * as THREE from 'three/webgpu';
import type { Team } from '../../assets/StylePreset';
import { G } from '../core/Physics';
import type { GameContext } from '../GameContext';
import type { Drone } from './Drone';
import { Soldier } from './Soldier';

const NAMES: Record<Team, string[]> = {
  A: ['Сокіл', 'Грач', 'Беркут', 'Тихий', 'Морпех', 'Кузя', 'Лис', 'Мадяр', 'Скіф', 'Док', 'Шульц', 'Рокер', 'Бандера', 'Вітер', 'Мольфар'],
  B: ['Шторм', 'Барс', 'Кедр', 'Урал', 'Гром', 'Скиф', 'Ворон', 'Север', 'Медведь', 'Таймыр', 'Алтай', 'Дон', 'Вятка', 'Беркут-2', 'Кама'],
};

/**
 * Infantry bot: objective-driven (capture/defend points), perception with field of view,
 * line of sight and smoke, human-like aim (reaction time, settling error, bursts), cover-ish
 * stance changes, obstacle steering, anti-drone fire.
 */
export class Bot {
  readonly soldier: Soldier;
  private think = Math.random() * 0.4;
  private target: Soldier | null = null;
  private droneTarget: Drone | null = null;
  private seenAt = 0;
  private aimErr = new THREE.Vector2();
  private burst = 0;
  private pause = 0;
  private goal = new THREE.Vector3();
  private goalPoint = -1;
  private detour = 0;
  private detourDir = 1;
  private stuckT = 0;
  private lastPos = new THREE.Vector3();
  private strafe = 0;
  private skill: number;

  constructor(private ctx: GameContext, team: Team, index: number, spawn: THREE.Vector3) {
    this.soldier = new Soldier(ctx, team, NAMES[team][index % NAMES[team].length], false, spawn);
    this.skill = 0.6 + Math.random() * 0.4;
  }

  update(dt: number): void {
    const s = this.soldier;
    if (!s.alive) { s.updateModel(dt, false, this.ctx.camera.position); return; }
    s.tickWeapon(dt);
    this.think -= dt;
    if (this.think <= 0) {
      this.think = 0.3 + Math.random() * 0.25;
      this.perceive();
      this.chooseGoal();
    }
    const engaging = !!(this.target || this.droneTarget);
    this.move(dt, engaging);
    this.aimAndShoot(dt);
    s.updateModel(dt, engaging, this.ctx.camera.position);
  }

  private perceive(): void {
    const s = this.soldier;
    const eye = s.eye();
    const fwd = s.aimDir();
    let best: Soldier | null = null, bestD = 230;
    // threat memory: whoever shot us recently
    const recent = this.ctx.time - s.lastDamageTime < 3 && s.lastAttacker instanceof Soldier ? s.lastAttacker : null;
    for (const o of this.ctx.soldiers) {
      if (!o.alive || o.team === s.team || o.vehicle) continue;
      const to = o.center().sub(eye);
      const d = to.length();
      if (d > bestD) continue;
      const inFov = to.normalize().dot(fwd) > 0.2 || d < 25 || o === recent;
      if (!inFov) continue;
      // prone / crouched targets are harder to spot at range
      const vis = o.stance === 'prone' ? 0.45 : o.stance === 'crouch' ? 0.75 : 1;
      if (d > 230 * vis) continue;
      if (!this.los(eye, o.center(), o)) continue;
      best = o;
      bestD = d;
    }
    if (best !== this.target) {
      this.target = best;
      this.seenAt = this.ctx.time;
      // fresh target → large initial aim error that settles over the reaction time
      const e = (1.2 - this.skill) * 0.12;
      this.aimErr.set((Math.random() - 0.5) * e, (Math.random() - 0.5) * e);
    }
    this.droneTarget = null;
    if (!best) {
      for (const d of this.ctx.drones.list) {
        if (!d.alive || d.team === s.team) continue;
        if (d.pos.distanceTo(eye) < 70 && this.losPoint(eye, d.pos)) { this.droneTarget = d; break; }
      }
    }
    if (best && s.weapon.mag === 0) s.reload();
    else if (!best && s.weapon.mag < 12) s.reload();
  }

  private los(a: THREE.Vector3, b: THREE.Vector3, target: Soldier): boolean {
    if (this.ctx.particles.blockedBySmoke(a, b)) return false;
    const d = b.clone().sub(a);
    const len = d.length();
    const hit = this.ctx.physics.raycast(a, d.divideScalar(len), len, { exclude: this.soldier.collider, mask: G.TERRAIN | G.STATIC | G.TREE | G.VEHICLE | G.CHAR });
    return !hit || hit.collider === target.collider;
  }

  private losPoint(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const d = b.clone().sub(a);
    const len = d.length();
    return !this.ctx.physics.raycast(a, d.divideScalar(len), len - 0.5, { exclude: this.soldier.collider, mask: G.TERRAIN | G.STATIC });
  }

  private chooseGoal(): void {
    const s = this.soldier;
    const pts = this.ctx.conquest.points;
    if (this.goalPoint >= 0 && Math.random() > 0.08) {
      const p = pts[this.goalPoint];
      // keep the goal while it's not ours, or we are defending it
      if (p.owner !== s.team || p.contested) return;
    }
    // weight: enemy/neutral points close by, occasional defenders
    let bestI = 0, bestScore = Infinity;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.x - s.position.x, p.z - s.position.z);
      let score = d;
      if (p.owner === s.team) score += p.contested ? -80 : 260 + Math.random() * 200;
      score += Math.random() * 90;
      if (score < bestScore) { bestScore = score; bestI = i; }
    });
    this.goalPoint = bestI;
    const p = pts[bestI];
    const a = Math.random() * Math.PI * 2, r = Math.random() * p.radius * 0.8;
    this.goal.set(p.x + Math.cos(a) * r, 0, p.z + Math.sin(a) * r);
  }

  private move(dt: number, engaging: boolean): void {
    const s = this.soldier;
    const to = this.goal.clone().sub(s.position).setY(0);
    const dist = to.length();
    let wish = new THREE.Vector3();
    if (engaging && this.target) {
      const d = this.target.position.distanceTo(s.position);
      // fight: crouch / prone at range, strafe up close
      s.setStance(d > 110 && this.skill > 0.8 ? 'prone' : d > 35 ? 'crouch' : 'stand');
      this.strafe -= dt;
      if (this.strafe <= 0) { this.strafe = 0.8 + Math.random() * 1.5; this.detourDir = Math.random() < 0.5 ? -1 : 1; }
      if (d < 40) wish = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw)).multiplyScalar(this.detourDir * 0.7);
      s.sprinting = false;
    } else {
      s.setStance('stand');
      if (dist > 3) {
        wish = to.normalize();
        s.sprinting = dist > 40;
        // obstacle steering with knee-height feelers
        const eye = s.position.clone().setY(s.position.y + 0.6);
        const blocked = (dir: THREE.Vector3) => !!this.ctx.physics.raycast(eye, dir, 2.6, { exclude: s.collider, mask: G.STATIC | G.TREE | G.VEHICLE });
        if (this.detour > 0) {
          this.detour -= dt;
          wish.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.detourDir * 1.2);
        } else if (blocked(wish)) {
          for (const ang of [0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
            const w = wish.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
            if (!blocked(w)) { wish = w; break; }
          }
        }
        const look = Math.atan2(-wish.x, -wish.z);
        s.yaw += wrap(look - s.yaw) * Math.min(1, dt * 6);
        s.pitch *= 0.9;
      } else {
        s.sprinting = false;
        if (Math.random() < dt * 0.3) this.chooseGoal();
      }
    }
    // separation from friendlies
    for (const o of this.ctx.soldiers) {
      if (o === s || !o.alive || o.team !== s.team) continue;
      const d = s.position.distanceTo(o.position);
      if (d < 1.8 && d > 0.01) wish.add(s.position.clone().sub(o.position).setY(0).multiplyScalar((1.8 - d) / d));
    }
    s.move(wish, dt);
    // stuck → random detour
    this.stuckT += dt;
    if (this.stuckT > 2) {
      if (!engaging && dist > 4 && s.position.distanceTo(this.lastPos) < 1) { this.detour = 1.6; this.detourDir = Math.random() < 0.5 ? -1 : 1; }
      this.lastPos.copy(s.position);
      this.stuckT = 0;
    }
  }

  private aimAndShoot(dt: number): void {
    const s = this.soldier;
    let aimPoint: THREE.Vector3 | null = null;
    if (this.target && this.target.alive) {
      aimPoint = this.target.center();
      if (Math.random() < 0.35) aimPoint.y = this.target.headY() - 0.05;
      // lead moving targets
      const d = aimPoint.distanceTo(s.eye());
      aimPoint.addScaledVector(this.target.velocity, d / 880);
    } else if (this.droneTarget?.alive) {
      aimPoint = this.droneTarget.pos.clone().addScaledVector(this.droneTarget.vel, this.droneTarget.pos.distanceTo(s.eye()) / 880);
    }
    if (!aimPoint) return;
    const to = aimPoint.sub(s.eye());
    const wantYaw = Math.atan2(-to.x, -to.z), wantPitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
    // settle aim error over the reaction time
    this.aimErr.multiplyScalar(Math.max(0, 1 - dt * (1.5 + this.skill * 2)));
    const turn = Math.min(1, dt * 9);
    s.yaw += wrap(wantYaw + this.aimErr.x - s.yaw) * turn;
    s.pitch += (wantPitch + this.aimErr.y - s.pitch) * turn;
    const react = 0.45 + (1 - this.skill) * 0.5;
    if (this.ctx.time - this.seenAt < react) return;
    if (this.pause > 0) { this.pause -= dt; return; }
    const dist = to.length();
    const spread = 1.6 + dist / 60 + (this.droneTarget ? 1.5 : 0);
    if (s.shoot(s.eye(), s.aimDir(), spread * (1.3 - this.skill * 0.5))) {
      this.burst++;
      if (this.burst >= 2 + Math.floor(Math.random() * (dist > 80 ? 2 : 5))) { this.burst = 0; this.pause = 0.35 + Math.random() * 0.7 + dist / 300; }
    }
  }
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
