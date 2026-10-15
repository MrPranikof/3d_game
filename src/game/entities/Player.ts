import * as THREE from 'three/webgpu';
import type { Team } from '../../assets/StylePreset';
import { AMMO, type DamageInfo } from '../combat/Combat';
import type { InputFrame } from '../core/Input';
import type { GameContext } from '../GameContext';
import type { Drone } from './Drone';
import type { Emplacement } from './Emplacement';
import { EYE_HEIGHT, Soldier } from './Soldier';
import type { Vehicle } from './Vehicle';

export type PlayerMode = 'infantry' | 'tank' | 'drone' | 'emplacement' | 'dead';
export type Slot = 'rifle' | 'grenade' | 'ew';

/**
 * The local player: first-person infantry controller (sprint / slide / lean / stances / ADS with
 * collimator or 4× magnifier, recoil, weapon sway), plus hand-off to vehicles, crew-served
 * weapons and the FPV drone. Owns the camera and the first-person view model.
 */
export class Player {
  readonly soldier: Soldier;
  mode: PlayerMode = 'infantry';
  vehicle: Vehicle | null = null;
  drone: Drone | null = null;
  emplacement: Emplacement | null = null;
  slot: Slot = 'rifle';
  grenades = 3;
  ads = 0;
  optic = false;
  ewActive = false;
  suppression = 0;
  damageFlash = 0;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private bob = 0;
  private slideT = 0;
  private slideDir = new THREE.Vector3();
  private crouchToggle = false;
  private proneToggle = false;
  private viewmodel = new THREE.Group();
  private vmRifle: THREE.Object3D;
  private vmEW: THREE.Object3D;
  private vmGrenade: THREE.Object3D;
  private vmMuzzle?: THREE.Object3D;
  private aimOffset = new THREE.Vector3();
  private swayV = new THREE.Vector2();
  private kick = 0;
  private ewLoop: ReturnType<GameContext['audio']['loop']> = null;
  private deathCam = new THREE.Vector3();
  autoSprint = false;
  interactTarget: { label: string; act: () => void } | null = null;

  constructor(private ctx: GameContext, team: Team, spawn: THREE.Vector3) {
    this.soldier = new Soldier(ctx, team, 'Вы', true, spawn);
    const cam = ctx.camera;
    cam.add(this.viewmodel);
    this.viewmodel.scale.setScalar(0.62); // view-model scale (keeps the stock out of the near plane)
    this.viewmodel.userData.heat = 0.45;
    // view models come from the same factory as everything else
    const rifle = ctx.factory.instantiateTemplate(ctx.template(team === 'A' ? 'rifle_ar' : 'rifle_ak'));
    this.vmRifle = rifle.root;
    this.vmMuzzle = rifle.nodes.get('Muzzle');
    const aim = rifle.nodes.get('Aim_Point');
    if (aim) this.aimOffset.copy(aim.position).negate().multiplyScalar(0.62).add(new THREE.Vector3(0, 0, -0.05));
    this.vmEW = ctx.factory.instantiateTemplate(ctx.template('ew_gun')).root;
    this.vmGrenade = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8).scale(1, 1.25, 1), new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.6 }));
    const gloves = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.11), new THREE.MeshStandardMaterial({ color: 0x1d1d1c, roughness: 0.85 }));
    gloves.position.set(0, -0.03, 0.03);
    const glove2 = gloves.clone();
    glove2.position.set(0, -0.01, -0.33);
    this.vmRifle.add(gloves, glove2);
    for (const o of [this.vmRifle, this.vmEW, this.vmGrenade]) {
      o.traverse((m) => { m.castShadow = false; m.frustumCulled = false; });
      this.viewmodel.add(o);
    }
    this.selectSlot('rifle');
    this.soldier.yaw = team === 'A' ? -Math.PI * 0.75 + Math.PI : Math.PI * 0.25 - Math.PI;
  }

  /** Where enemies should aim at the player (soldier, vehicle or emplacement). */
  focus(): THREE.Vector3 {
    if (this.vehicle) return this.vehicle.position.clone().setY(this.vehicle.position.y + 2.2);
    return this.soldier.center();
  }

  selectSlot(s: Slot): void {
    this.slot = s;
    this.vmRifle.visible = s === 'rifle';
    this.vmEW.visible = s === 'ew';
    this.vmGrenade.visible = s === 'grenade' && this.grenades > 0;
  }

  suppress(k: number): void {
    this.suppression = Math.min(1, this.suppression + k);
  }

  onDamaged(d: DamageInfo): void {
    this.damageFlash = Math.min(1, this.damageFlash + d.amount / 60);
    this.ctx.hud.damageFrom(d.point);
  }

  // ───────────────────────── per-frame ─────────────────────────

  update(f: InputFrame, dt: number): void {
    const s = this.soldier;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.2);
    this.suppression = Math.max(0, this.suppression - dt * 0.6);
    if (!s.alive && this.mode !== 'dead') this.onDeath();
    switch (this.mode) {
      case 'dead': this.updateDead(dt); break;
      case 'tank': this.updateVehicle(f, dt); break;
      case 'drone': this.updateDrone(f, dt); break;
      case 'emplacement': this.updateEmplacement(f, dt); break;
      default: this.updateInfantry(f, dt);
    }
    // health regeneration out of combat
    if (s.alive && s.hp < 100 && this.ctx.time - s.lastDamageTime > 6) s.hp = Math.min(100, s.hp + dt * 12);
  }

  private updateInfantry(f: InputFrame, dt: number): void {
    const s = this.soldier;
    const ctx = this.ctx;
    this.viewmodel.visible = true;
    // look (+ recoil recovery)
    const adsK = 1 - this.ads * (this.optic ? 0.75 : 0.35);
    s.yaw += f.look.x * adsK;
    s.pitch = THREE.MathUtils.clamp(s.pitch + f.look.y * adsK, -1.45, 1.45);
    const rec = Math.min(1, dt * 7);
    s.pitch -= this.recoilPitch * rec;
    s.yaw -= this.recoilYaw * rec;
    this.recoilPitch -= this.recoilPitch * rec;
    this.recoilYaw -= this.recoilYaw * rec;

    // stance
    if (f.pressed.has('crouch')) {
      if (s.sprinting && s.grounded && s.stance === 'stand') { this.slideT = 0.75; this.slideDir.set(-Math.sin(s.yaw), 0, -Math.cos(s.yaw)); }
      this.crouchToggle = !this.crouchToggle; this.proneToggle = false;
    }
    if (f.pressed.has('prone')) { this.proneToggle = !this.proneToggle; this.crouchToggle = false; }
    if (f.pressed.has('jump') && s.stance !== 'stand') { this.crouchToggle = this.proneToggle = false; f.pressed.delete('jump'); }
    s.setStance(this.proneToggle ? 'prone' : this.crouchToggle || this.slideT > 0 ? 'crouch' : 'stand');

    // movement (auto-sprint when the touch stick is pushed to the top)
    const fwd = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
    const right = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
    const wish = fwd.multiplyScalar(f.move.y).addScaledVector(right, f.move.x);
    const wantSprint = (f.held.has('sprint') || this.autoSprint) && f.move.y > 0.5 && s.stance === 'stand' && this.ads < 0.3;
    s.sprinting = wantSprint && !f.held.has('fire');
    if (this.slideT > 0) {
      this.slideT -= dt;
      const k = this.slideT / 0.75;
      s.velocity.x = this.slideDir.x * (3 + 6 * k);
      s.velocity.z = this.slideDir.z * (3 + 6 * k);
      s.velocity.y -= 9.81 * dt;
      s.applyMove(s.velocity.clone().multiplyScalar(dt));
      if (Math.random() < 0.5) ctx.particles.dust(s.position.clone().setY(s.position.y + 0.1), new THREE.Vector3(0, 0.5, 0), 0.6);
    } else {
      s.move(wish, dt, f.pressed.has('jump'));
    }
    // lean (hold or toggle from touch)
    const leanWant = (f.held.has('leanR') ? 1 : 0) - (f.held.has('leanL') ? 1 : 0);
    s.lean += (leanWant - s.lean) * Math.min(1, dt * 8);

    // weapon slots
    if (f.pressed.has('weapon1')) this.selectSlot('rifle');
    if (f.pressed.has('weapon2')) this.selectSlot('grenade');
    if (f.pressed.has('weapon3')) this.selectSlot('ew');
    if (f.pressed.has('optic')) this.optic = !this.optic;
    s.tickWeapon(dt);
    const wantAds = f.held.has('ads') && !s.sprinting && this.slot === 'rifle';
    this.ads += ((wantAds ? 1 : 0) - this.ads) * Math.min(1, dt * 12);
    if (f.pressed.has('reload')) s.reload();
    if (this.slot === 'rifle') {
      if (f.held.has('fire') && !s.sprinting) {
        const eye = s.eye();
        const dir = s.aimDir();
        const moving = Math.hypot(s.velocity.x, s.velocity.z) > 0.5;
        const spread = (this.ads > 0.5 ? 0.25 : 1) * (moving ? 1.8 : 1) * (s.stance === 'prone' ? 0.5 : s.stance === 'crouch' ? 0.75 : 1) * (1 + this.suppression);
        if (s.shoot(eye, dir, spread)) {
          const k = s.stance === 'prone' ? 0.5 : 1;
          this.recoilPitch -= 0.011 * k * (this.ads > 0.5 ? 0.7 : 1);
          s.pitch += 0.011 * k * (this.ads > 0.5 ? 0.7 : 1);
          const ry = (Math.random() - 0.4) * 0.006 * k;
          s.yaw += ry;
          this.recoilYaw -= ry * 0.5;
          this.kick = 1;
          if (this.vmMuzzle) ctx.particles.muzzleFlash(this.vmMuzzle.getWorldPosition(new THREE.Vector3()), dir);
        } else if (s.weapon.mag === 0 && f.pressed.has('fire')) s.reload();
      }
    } else if (this.slot === 'grenade') {
      if (f.pressed.has('fire') && this.grenades > 0) {
        this.grenades--;
        const dir = s.aimDir().add(new THREE.Vector3(0, 0.25, 0)).normalize();
        ctx.combat.fire(AMMO.grenade, s.eye().addScaledVector(dir, 0.5), dir, s.team, s, { speed: 19, exclude: s.collider, inheritVel: s.velocity, mesh: new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), new THREE.MeshStandardMaterial({ color: 0x4a5236 })) });
        ctx.audio.ui('click');
        if (this.grenades <= 0) this.selectSlot('rifle'); else this.selectSlot('grenade');
      }
    } else if (this.slot === 'ew') {
      this.ewActive = f.held.has('fire');
      if (this.ewActive) {
        const jammed = ctx.drones.jam(s.eye(), s.aimDir(), s.team);
        if (!this.ewLoop) this.ewLoop = ctx.audio.loop('jammer');
        this.ewLoop?.set(1, 0.6 + Math.min(0.4, jammed * 0.2));
      }
    }
    if ((!this.ewActive || this.slot !== 'ew') && this.ewLoop) { this.ewLoop.stop(); this.ewLoop = null; }

    // interaction (vehicles, emplacements)
    this.interactTarget = this.findInteraction();
    if (f.pressed.has('interact') && this.interactTarget) this.interactTarget.act();
    if (f.pressed.has('drone')) this.launchDrone();

    this.placeCamera(dt, f);
  }

  private findInteraction(): Player['interactTarget'] {
    const s = this.soldier;
    let best: Player['interactTarget'] = null, bd = 6;
    for (const v of this.ctx.vehicles) {
      if (!v.alive || v.driver) continue;
      if (v.crewTeam !== s.team && v.aiCrew) continue; // can't hijack a crewed enemy vehicle
      const d = v.distanceToSurface(s.center());
      if (d < 2.2 && d < bd) { bd = d; best = { label: `Сесть: ${v.name}`, act: () => this.enterVehicle(v) }; }
    }
    for (const e of this.ctx.emplacements) {
      if (!e.alive || e.user || e.team !== s.team) continue;
      const d = e.position.distanceTo(s.position);
      if (d < 2.4 && d < bd) { bd = d; best = { label: `Занять: ${e.label}`, act: () => this.useEmplacement(e) }; }
    }
    return best;
  }

  private placeCamera(dt: number, f: InputFrame): void {
    const s = this.soldier;
    const cam = this.ctx.camera;
    const sp = Math.hypot(s.velocity.x, s.velocity.z);
    this.bob += sp * dt * (s.sprinting ? 1.6 : 1.9);
    const bobAmt = (s.grounded ? Math.min(1, sp / 4) : 0) * (1 - this.ads * 0.85);
    const eye = s.eye();
    if (this.slideT > 0) eye.y -= 0.35;
    eye.y += Math.sin(this.bob * 2) * 0.035 * bobAmt;
    cam.position.copy(eye);
    const shake = this.ctx.combat.shake;
    const sx = (Math.random() - 0.5) * shake * 0.03, sy = (Math.random() - 0.5) * shake * 0.03;
    cam.quaternion.setFromEuler(new THREE.Euler(s.pitch + sy, s.yaw + sx, -s.lean * 0.21 + Math.sin(this.bob) * 0.006 * bobAmt, 'YXZ'));
    const baseFov = 74;
    const targetFov = THREE.MathUtils.lerp(baseFov, this.optic ? 18 : 52, this.ads) + (s.sprinting ? 6 : 0);
    cam.fov += (targetFov - cam.fov) * Math.min(1, dt * 14);
    cam.updateProjectionMatrix();

    // view model: hip → ADS blend, sway, bob, recoil kick, sprint lowering, reload dip
    this.swayV.x += (-f.look.x * 2 - this.swayV.x) * Math.min(1, dt * 8);
    this.swayV.y += (-f.look.y * 2 - this.swayV.y) * Math.min(1, dt * 8);
    this.kick = Math.max(0, this.kick - dt * 14);
    const hip = new THREE.Vector3(0.13, -0.15, -0.34);
    const adsPos = this.aimOffset.clone();
    const p = hip.lerp(adsPos, this.ads);
    p.x += Math.sin(this.bob) * 0.012 * bobAmt + this.swayV.x * 0.04 * (1 - this.ads * 0.8);
    p.y += Math.abs(Math.cos(this.bob)) * 0.01 * bobAmt + this.swayV.y * 0.04 * (1 - this.ads * 0.8);
    p.z += this.kick * 0.035;
    let rx = this.kick * 0.05, ry = 0;
    if (s.sprinting) { p.add(new THREE.Vector3(-0.05, -0.06, 0.05)); rx -= 0.5; ry = 0.6; }
    if (s.weapon.reloading > 0) { const k = Math.sin((1 - s.weapon.reloading / s.weapon.reloadTime) * Math.PI); p.y -= 0.12 * k; rx -= 0.6 * k; }
    this.viewmodel.position.copy(p);
    this.viewmodel.rotation.set(rx, ry, 0);
    this.vmEW.position.set(0, 0.02, 0.05);
    this.vmGrenade.position.set(0.02, 0.04, -0.05);
  }

  // ───────────────────────── vehicles / drone / emplacements ─────────────────────────

  enterVehicle(v: Vehicle): void {
    v.enter(this.soldier);
    this.vehicle = v;
    this.mode = 'tank';
    this.viewmodel.visible = false;
    this.soldier.body.setEnabled(false);
    this.ctx.input.mode = 'tank';
    this.ctx.hud.setMode('tank');
  }

  private updateVehicle(f: InputFrame, dt: number): void {
    const v = this.vehicle!;
    this.viewmodel.visible = false;
    if (!v.alive || !this.soldier.alive) { this.leaveVehicle(); return; }
    if (f.pressed.has('interact') || f.pressed.has('exit')) { this.leaveVehicle(); return; }
    v.control(f, dt);
    v.updateCamera(this.ctx.camera, dt);
    const shake = this.ctx.combat.shake;
    if (shake > 0) this.ctx.camera.rotateZ((Math.random() - 0.5) * shake * 0.02);
    this.soldier.position.copy(v.position);
    this.soldier.body.setNextKinematicTranslation({ x: v.position.x, y: v.position.y + 1, z: v.position.z });
  }

  leaveVehicle(): void {
    const v = this.vehicle;
    this.vehicle = null;
    this.soldier.body.setEnabled(true);
    if (v && v.driver === this.soldier) v.exit();
    this.soldier.vehicle = null;
    this.mode = this.soldier.alive ? 'infantry' : 'dead';
    this.ctx.input.mode = this.soldier.alive ? 'infantry' : 'dead';
    this.ctx.hud.setMode(this.mode === 'dead' ? 'dead' : 'infantry');
    this.ctx.thermal.set(false);
    if (v) this.soldier.yaw = v.lookYaw;
    this.ctx.camera.fov = 74;
  }

  private launchDrone(): void {
    const d = this.ctx.drones.launchPlayer(this.soldier);
    if (!d) { this.ctx.hud.message('Дроны закончились'); return; }
    this.drone = d;
    this.mode = 'drone';
    this.ctx.input.mode = 'drone';
    this.ctx.hud.setMode('drone');
    this.viewmodel.visible = false;
    this.soldier.setStance('crouch');
  }

  private updateDrone(f: InputFrame, dt: number): void {
    const d = this.drone!;
    // operator stays crouched and vulnerable
    this.soldier.move(new THREE.Vector3(), dt);
    if (!this.soldier.alive) { d.kill(null); this.endDrone(); return; }
    if (f.pressed.has('exit') || f.pressed.has('drone') || f.pressed.has('interact')) { if (d.alive) d.armed ? d.detonate() : d.kill(null); }
    if (d.alive) {
      d.control(f, dt);
      d.cameraPose(this.ctx.camera);
      this.ctx.postfx.setNoise(d.noise, d.signalLost > 0 || d.battery <= 0);
    }
    if (!d.alive) this.endDrone();
  }

  private endDrone(): void {
    this.drone = null;
    this.mode = this.soldier.alive ? 'infantry' : 'dead';
    this.ctx.input.mode = this.mode === 'dead' ? 'dead' : 'infantry';
    this.ctx.hud.setMode(this.mode === 'dead' ? 'dead' : 'infantry');
    this.ctx.postfx.setNoise(0, false);
    this.ctx.postfx.flashStatic();
    this.ctx.thermal.set(false);
    this.ctx.camera.fov = 74;
  }

  useEmplacement(e: Emplacement): void {
    this.emplacement = e;
    e.user = this.soldier;
    this.mode = 'emplacement';
    this.ctx.input.mode = 'emplacement';
    this.ctx.hud.setMode('emplacement');
    this.viewmodel.visible = false;
  }

  private updateEmplacement(f: InputFrame, dt: number): void {
    const e = this.emplacement!;
    if (!e.alive || !this.soldier.alive || f.pressed.has('interact') || f.pressed.has('exit')) { this.leaveEmplacement(); return; }
    e.control(f, dt);
    e.updateCamera(this.ctx.camera);
  }

  private leaveEmplacement(): void {
    const e = this.emplacement;
    if (e) { e.user = null; if (e.thermal) { e.thermal = false; } }
    this.ctx.thermal.set(false);
    this.emplacement = null;
    this.mode = this.soldier.alive ? 'infantry' : 'dead';
    this.ctx.input.mode = this.mode === 'dead' ? 'dead' : 'infantry';
    this.ctx.hud.setMode(this.mode === 'dead' ? 'dead' : 'infantry');
    this.ctx.camera.fov = 74;
  }

  // ───────────────────────── death & deploy ─────────────────────────

  private onDeath(): void {
    if (this.vehicle) this.leaveVehicle();
    if (this.emplacement) this.leaveEmplacement();
    if (this.drone) { this.drone.kill(null); this.endDrone(); }
    this.mode = 'dead';
    this.ctx.input.mode = 'dead';
    this.viewmodel.visible = false;
    this.deathCam.copy(this.soldier.eye());
    this.ctx.hud.setMode('dead');
    this.ewLoop?.stop();
    this.ewLoop = null;
  }

  private updateDead(dt: number): void {
    const cam = this.ctx.camera;
    const t = this.ctx.time - this.soldier.deathTime;
    const target = this.soldier.position.clone().setY(this.soldier.position.y + 0.3);
    const orbit = new THREE.Vector3(Math.sin(t * 0.3) * 6, 3 + Math.min(4, t), Math.cos(t * 0.3) * 6);
    cam.position.lerp(target.clone().add(orbit), Math.min(1, dt * 2));
    cam.lookAt(target);
    cam.fov = 70;
    cam.updateProjectionMatrix();
  }

  canDeploy(): boolean {
    return this.ctx.time - this.soldier.deathTime > 4;
  }

  deploy(at: THREE.Vector3): void {
    const s = this.soldier;
    s.respawn(at);
    s.yaw = Math.atan2(at.x, at.z); // face the map centre
    s.pitch = 0;
    this.crouchToggle = this.proneToggle = false;
    this.grenades = 3;
    this.mode = 'infantry';
    this.ctx.input.mode = 'infantry';
    this.ctx.hud.setMode('infantry');
    this.selectSlot('rifle');
  }

  eyeHeight(): number {
    return EYE_HEIGHT[this.soldier.stance];
  }
}
