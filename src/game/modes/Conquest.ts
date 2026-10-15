import * as THREE from 'three/webgpu';
import type { Team } from '../../assets/StylePreset';
import { G } from '../core/Physics';
import type { GameContext } from '../GameContext';
import type { CapturePoint } from '../world/MapLayout';

export interface PointState extends CapturePoint {
  /** −1 = Team B, +1 = Team A */
  progress: number;
  contested: boolean;
  presence: Record<Team, number>;
}

/**
 * Conquest: three capture points, ticket bleed for the side holding fewer points,
 * −1 ticket per death, −5 per lost vehicle. First side at 0 tickets loses.
 */
export class Conquest {
  readonly points: PointState[];
  readonly tickets: Record<Team, number>;
  winner: Team | null = null;
  private bleed = 0;

  constructor(private ctx: GameContext, startTickets: number) {
    this.points = ctx.layout.points.map((p) => ({ ...p, progress: p.owner === 'A' ? 1 : p.owner === 'B' ? -1 : 0, contested: false, presence: { A: 0, B: 0 } }));
    this.tickets = { A: startTickets, B: startTickets };
  }

  update(dt: number): void {
    if (this.winner) return;
    const ctx = this.ctx;
    for (const p of this.points) {
      p.presence.A = p.presence.B = 0;
      for (const s of ctx.soldiers) {
        if (!s.alive) continue;
        const pos = s.vehicle ? s.vehicle.position : s.position;
        if (Math.hypot(pos.x - p.x, pos.z - p.z) < p.radius) p.presence[s.team]++;
      }
      for (const v of ctx.vehicles) if (v.alive && v.aiCrew && Math.hypot(v.position.x - p.x, v.position.z - p.z) < p.radius) p.presence[v.crewTeam]++;
      const net = Math.max(-3, Math.min(3, p.presence.A - p.presence.B));
      p.contested = p.presence.A > 0 && p.presence.B > 0;
      const before = p.owner;
      if (net !== 0) {
        p.progress = THREE.MathUtils.clamp(p.progress + (net / 14) * dt, -1, 1);
        if (p.progress >= 1) p.owner = 'A';
        else if (p.progress <= -1) p.owner = 'B';
        else if ((p.owner === 'A' && p.progress <= 0) || (p.owner === 'B' && p.progress >= 0)) p.owner = null;
      }
      if (before !== p.owner) {
        const mine = ctx.settings.playerTeam;
        if (p.owner) ctx.hud.message(`${p.owner === mine ? 'Захвачена' : 'Потеряна'} точка ${p.id} — «${p.name}»`, p.owner === mine ? 'good' : 'bad');
        else ctx.hud.message(`Точка ${p.id} нейтрализована`);
        ctx.audio.ui(p.owner === mine ? 'capture' : 'warn');
      }
    }
    // ticket bleed
    this.bleed += dt;
    if (this.bleed >= 4) {
      this.bleed = 0;
      const a = this.points.filter((p) => p.owner === 'A').length, b = this.points.filter((p) => p.owner === 'B').length;
      if (a > b) this.tickets.B -= a - b;
      if (b > a) this.tickets.A -= b - a;
    }
    for (const t of ['A', 'B'] as const) if (this.tickets[t] <= 0) { this.tickets[t] = 0; this.winner = t === 'A' ? 'B' : 'A'; }
  }

  onDeath(team: Team): void {
    if (!this.winner) this.tickets[team] = Math.max(0, this.tickets[team] - 1);
  }

  onVehicleLost(team: Team): void {
    if (!this.winner) this.tickets[team] = Math.max(0, this.tickets[team] - 5);
  }

  spawnOptions(team: Team): { id: string; label: string; pos: THREE.Vector3 }[] {
    const base = this.ctx.layout.spawns[team][0];
    const opts = [{ id: 'base', label: 'База', pos: new THREE.Vector3(base[0], 0, base[1]) }];
    for (const p of this.points) if (p.owner === team && !p.contested) opts.push({ id: p.id, label: `${p.id} · ${p.name}`, pos: new THREE.Vector3(p.x, 0, p.z) });
    return opts;
  }

  /** Random safe position around a spawn option. */
  spawnAt(team: Team, id: string): THREE.Vector3 {
    const opt = this.spawnOptions(team).find((o) => o.id === id) ?? this.spawnOptions(team)[0];
    const r = id === 'base' ? 14 : 18;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * r;
      const p = opt.pos.clone().add(new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d));
      p.y = this.ctx.terrain.heightAt(p.x, p.z);
      // avoid spawning inside buildings
      const hits = this.ctx.physics.overlapBall(p.clone().setY(p.y + 1), 0.6, G.STATIC | G.TREE);
      if (!hits.length) return p.setY(p.y + 0.2);
    }
    const p = opt.pos.clone();
    p.y = this.ctx.terrain.heightAt(p.x, p.z) + 0.2;
    return p;
  }

  /** Best spawn for a bot: owned point closest to the action, else base. */
  botSpawn(team: Team): THREE.Vector3 {
    const opts = this.spawnOptions(team);
    const front = opts.filter((o) => o.id !== 'base');
    const pick = front.length && Math.random() < 0.6 ? front[Math.floor(Math.random() * front.length)] : opts[0];
    return this.spawnAt(team, pick.id);
  }
}
