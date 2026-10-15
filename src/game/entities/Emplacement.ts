import * as THREE from 'three/webgpu';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { AssetInstance } from '../../assets/pipeline/ModelLoader';
import type { Team } from '../../assets/StylePreset';
import { AMMO, type Damageable, type DamageInfo } from '../combat/Combat';
import type { InputFrame } from '../core/Input';
import { G, groups } from '../core/Physics';
import type { GameContext } from '../GameContext';
import type { Soldier } from './Soldier';

/**
 * Crew-served weapons the player can man: tripod ATGM (SACLOS — the missile flies along the
 * sight line, steer it with the crosshair) and the 82 mm mortar (indirect fire: set the range,
 * the computer solves the high-angle elevation).
 */
export class Emplacement implements Damageable {
  readonly kind: 'atgm_launcher' | 'mortar_82';
  readonly position = new THREE.Vector3();
  alive = true;
  user: Soldier | null = null;
  yaw: number;
  pitch = 0;
  ammo: number;
  reload = 0;
  range = 300;
  thermal = false;
  private inst: AssetInstance;
  private yawNode?: THREE.Object3D;
  private pitchNode?: THREE.Object3D;
  private collider: RAPIER.Collider;

  constructor(private ctx: GameContext, kind: 'atgm_launcher' | 'mortar_82', readonly team: Team, x: number, z: number, rot: number) {
    this.kind = kind;
    this.yaw = rot;
    this.ammo = kind === 'atgm_launcher' ? 6 : 24;
    this.position.set(x, ctx.terrain.heightAt(x, z), z);
    this.inst = ctx.factory.instantiateTemplate(ctx.template(kind));
    this.inst.root.position.copy(this.position);
    this.inst.root.rotation.y = rot;
    this.yawNode = this.inst.nodes.get('Yaw');
    this.pitchNode = this.inst.nodes.get(kind === 'atgm_launcher' ? 'Pitch' : 'Tube');
    ctx.scene.add(this.inst.root);
    const R = ctx.physics.R;
    this.collider = ctx.physics.fixed(R.ColliderDesc.cuboid(0.5, 0.6, 0.6).setTranslation(x, this.position.y + 0.6, z), { kind: 'emplacement', ref: this }, G.STATIC, 0xffff);
    void groups;
  }

  get label(): string {
    return this.kind === 'atgm_launcher' ? 'ПТУР' : 'Миномёт 82 мм';
  }

  applyDamage(d: DamageInfo): void {
    if (!this.alive || d.amount < 100) return;
    this.alive = false;
    this.ctx.particles.explosion(this.position.clone().setY(this.position.y + 0.8), 0.6);
    this.inst.root.visible = false;
    this.ctx.physics.removeCollider(this.collider);
    if (this.user) this.user.applyDamage({ ...d, amount: 80 });
  }

  aimDir(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  control(f: InputFrame, dt: number): void {
    this.reload = Math.max(0, this.reload - dt);
    const fovK = this.kind === 'atgm_launcher' ? 0.3 : 1;
    this.yaw += f.look.x * fovK;
    if (this.kind === 'atgm_launcher') this.pitch = THREE.MathUtils.clamp(this.pitch + f.look.y * fovK, -0.2, 0.3);
    else {
      this.range = THREE.MathUtils.clamp(this.range - f.look.y * 120 + f.zoom * -20, 80, 1100);
      // high-angle solution: R = v² sin(2θ)/g, θ in (45°, 85°)
      const v = AMMO.mortar.speed, s = Math.min(1, (9.81 * this.range) / (v * v));
      this.pitch = Math.PI / 2 - 0.5 * Math.asin(s);
    }
    if (f.pressed.has('thermal') && this.kind === 'atgm_launcher') { this.thermal = !this.thermal; this.ctx.thermal.set(this.thermal); }
    if (f.pressed.has('fire')) this.fire();
    if (this.yawNode) this.yawNode.rotation.y = this.yaw - this.inst.root.rotation.y;
    if (this.pitchNode) this.pitchNode.rotation.x = this.kind === 'atgm_launcher' ? this.pitch : -(Math.PI / 2 - this.pitch);
  }

  private fire(): void {
    if (this.reload > 0 || this.ammo <= 0 || !this.user) return;
    this.ammo--;
    this.inst.root.updateMatrixWorld(true);
    const dir = this.aimDir();
    if (this.kind === 'atgm_launcher') {
      this.reload = 4;
      const origin = this.eye().addScaledVector(dir, 1.2);
      const self = this;
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3d4430 }));
      this.ctx.combat.fire(AMMO.atgm, origin, dir, this.team, this.user, {
        speed: 80, mesh, exclude: this.collider,
        guide: () => (self.user && self.alive ? new THREE.Ray(self.eye(), self.aimDir()) : null),
      });
      this.ctx.particles.muzzleFlash(origin, dir, true);
      this.ctx.audio.cannon(null);
    } else {
      this.reload = 2.5;
      const origin = this.position.clone().setY(this.position.y + 1.1);
      this.ctx.combat.fire(AMMO.mortar, origin, dir, this.team, this.user, { exclude: this.collider });
      this.ctx.particles.muzzleFlash(origin, dir, false);
      this.ctx.audio.cannon(null);
    }
  }

  eye(): THREE.Vector3 {
    return this.position.clone().setY(this.position.y + (this.kind === 'atgm_launcher' ? 1.0 : 1.6));
  }

  updateCamera(cam: THREE.PerspectiveCamera): void {
    if (this.kind === 'atgm_launcher') {
      cam.position.copy(this.eye()).add(new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(-0.2));
      cam.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
      cam.fov = 12;
    } else {
      const back = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      cam.position.copy(this.position).addScaledVector(back, 2.2).setY(this.position.y + 1.7);
      cam.quaternion.setFromEuler(new THREE.Euler(-0.1, this.yaw, 0, 'YXZ'));
      cam.fov = 70;
    }
    cam.updateProjectionMatrix();
  }

  /** Predicted mortar impact (for the HUD map marker). */
  impactPoint(): THREE.Vector3 {
    const dir = this.aimDir().setY(0).normalize();
    const p = this.position.clone().addScaledVector(dir, this.range);
    p.y = this.ctx.terrain.heightAt(p.x, p.z);
    return p;
  }
}
