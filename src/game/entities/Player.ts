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
    // ADS: eye on the sight line, just ahead of the stock comb (≈10 cm behind the collimator)
    if (aim) this.aimOffset.set(-aim.position.x, -aim.position.y, 0.02).multiplyScalar(0.62);
    // collimator lenses are see-through from behind: hide the opaque lens discs in first person
    rifle.nodes.get('Sight')?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.Material).name === 'glass_optic') { m.visible = false; if ((m.parent as THREE.LOD)?.isLOD) m.parent!.visible = false; }
    });
    this.vmEW = ctx.factory.instantiateTemplate(ctx.template('ew_gun')).root;
    this.vmGrenade = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8).scale(1, 1.25, 1), new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 0.6 }));
    this.vmRifle.add(buildScanArms(ctx, team) ?? buildArms(ctx, team, team === 'A' ? -0.33 : -0.36));
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
    const hip = new THREE.Vector3(0.15, -0.18, -0.3);
    const adsPos = this.aimOffset.clone();
    const p = hip.lerp(adsPos, this.ads);
    p.x += Math.sin(this.bob) * 0.012 * bobAmt + this.swayV.x * 0.04 * (1 - this.ads * 0.8);
    p.y += Math.abs(Math.cos(this.bob)) * 0.01 * bobAmt + this.swayV.y * 0.04 * (1 - this.ads * 0.8);
    p.z += this.kick * 0.035;
    let rx = this.kick * 0.05, ry = 0;
    if (s.sprinting) { p.add(new THREE.Vector3(-0.05, -0.06, 0.05)); rx -= 0.5; ry = 0.6; }
    if (s.weapon.reloading > 0) { const k = Math.sin((1 - s.weapon.reloading / s.weapon.reloadTime) * Math.PI); p.y -= 0.12 * k; rx -= 0.6 * k; }
    this.viewmodel.position.copy(p);
    this.viewmodel.rotation.set(rx, ry + 0.06 * (1 - this.ads), 0);
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
      this.ctx.input.droneStab = d.mode === 'stab';
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

/**
 * First-person arms holding the rifle: sleeves in the team camouflage with ID tape, gloved
 * hands on the pistol grip and the handguard. Built in rifle space from the same material
 * library as the soldier models.
 */
/**
 * First-person arms from the scanned soldier itself: the body in its motion-captured aiming pose
 * (head and legs collapsed), placed so its palms sit on the view-model rifle's grip and handguard —
 * the same palm-to-palm fit the bots use, inverted.
 */
function buildScanArms(ctx: GameContext, team: Team): THREE.Object3D | null {
  const tpl = ctx.template('soldier', team);
  const clip = tpl.animations.find((a) => a.name === 'IdleAim');
  if (!clip) return null;
  const inst = ctx.factory.instantiateTemplate(tpl);
  const root = inst.root;
  inst.nodes.get('Weapon')?.removeFromParent(); // the view model brings its own rifle
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  mixer.update(0.4);
  // keep only the arms: triangles whose vertices are all driven mainly by arm bones (the vest and
  // helmet would otherwise fill the lower half of the screen)
  // forearms + hands only: the view model sits ~0.45 m ahead of where the mocap body would put it,
  // so upper arms and shoulders would land in front of the camera
  const ARM = /^(Left|Right)(ForeArm|Hand)$/;
  const keepers: THREE.Object3D[] = [];
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) return;
    if (sm.parent && (sm.parent as THREE.LOD).isLOD && (sm.parent as THREE.LOD).levels[0].object !== sm) return;
    const g = sm.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    const armBone = sm.skeleton.bones.map((b) => ARM.test(b.name));
    const dominant = (v: number) => { let w = 0; for (let k = 0; k < 4; k++) if (armBone[si.getComponent(v, k)]) w += sw.getComponent(v, k); return w >= 0.5; };
    const idx = g.index!.array, keep: number[] = [];
    const P = g.attributes.position;
    const edge = (a: number, b: number) => Math.hypot(P.getX(a) - P.getX(b), P.getY(a) - P.getY(b), P.getZ(a) - P.getZ(b));
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      if (+dominant(a) + +dominant(b) + +dominant(c) < 2) continue;
      if (Math.max(edge(a, b), edge(b, c), edge(c, a)) > 0.07) continue; // stretched flaps at the cut
      keep.push(a, b, c);
    }
    if (!keep.length) return;
    const ng = g.clone();
    ng.setIndex(keep);
    const mat = (sm.material as THREE.Material).clone();
    mat.side = THREE.DoubleSide; // the cut sleeve is open at the shoulder
    const arms = new THREE.SkinnedMesh(ng, mat);
    arms.name = 'FP_Arms';
    arms.bind(sm.skeleton, sm.bindMatrix);
    keepers.push(arms);
  });
  if (!keepers.length) return null;
  const meshes: THREE.Object3D[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.LOD).isLOD) meshes.push(o); });
  for (const m of meshes) m.removeFromParent();
  for (const k of keepers) root.add(k);
  root.updateMatrixWorld(true);
  const pos = (n: string) => inst.nodes.get(n)!.getWorldPosition(new THREE.Vector3());
  const palm = (hand: string, fore: string) => { const h = pos(hand); return h.clone().addScaledVector(h.clone().sub(pos(fore)).normalize(), 0.075); };
  const grip = palm('RightHand', 'RightForeArm'), support = palm('LeftHand', 'LeftForeArm');
  // rifle frame in body space (barrel −Z from grip toward the support hand, kept upright)
  const z = grip.clone().sub(support).normalize();
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  // swing the left forearm down and back under the handguard so its cut elbow leaves the screen
  const fore = inst.nodes.get('LeftForeArm')!, hand = inst.nodes.get('LeftHand')!;
  const H = pos('LeftHand'), E0 = pos('LeftForeArm');
  const swing = new THREE.Vector3().addScaledVector(x, -0.15).addScaledVector(y, -0.55).addScaledVector(z, 0.85).normalize(); // toward the camera's lower edge
  const E1 = H.clone().addScaledVector(swing, H.distanceTo(E0)); // keep the forearm length so the hand stays put
  const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
  const R = new THREE.Quaternion().setFromUnitVectors(H.clone().sub(E0).normalize(), H.clone().sub(E1).normalize());
  const foreQ = R.multiply(fore.getWorldQuaternion(new THREE.Quaternion()));
  const parentInv = fore.parent!.matrixWorld.clone().invert();
  // + nudge toward the rifle: the visible palm sits beside the bone, not on it
  fore.position.copy(E1.clone().addScaledVector(x, 0.045).addScaledVector(y, 0.015).applyMatrix4(parentInv));
  fore.quaternion.copy(fore.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(foreQ));
  fore.updateMatrixWorld(true);
  hand.quaternion.copy(fore.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(handQ));
  root.updateMatrixWorld(true);
  // sleeve continuing past the cut elbow, off the bottom of the screen
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.06, 0.5, 14, 1, true), ctx.factory.materials.get(team === 'A' ? 'camo_mm14' : 'camo_emr'));
  (sleeve.material as THREE.Material).side = THREE.DoubleSide;
  sleeve.position.copy(E1).addScaledVector(swing, 0.22);
  sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), swing);
  sleeve.name = 'FP_Sleeve';
  root.add(sleeve);
  const rifle = new THREE.Matrix4().makeBasis(x, y, z).multiply(new THREE.Matrix4().makeRotationX(-0.09)).setPosition(grip);
  const holder = new THREE.Group();
  holder.name = 'Arms';
  holder.matrixAutoUpdate = false;
  holder.matrix.copy(rifle.invert()); // body placed in rifle space
  holder.add(root);
  root.traverse((o) => { o.castShadow = false; o.frustumCulled = false; });
  return holder;
}

function buildArms(ctx: GameContext, team: Team, supportZ: number): THREE.Group {
  const mats = ctx.factory.materials;
  const camo = mats.get(team === 'A' ? 'camo_mm14' : 'camo_emr');
  const glove = mats.get('rubber_black');
  const tape = mats.get(`tape_${team}`);
  const g = new THREE.Group();
  g.name = 'Arms';
  const seg = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
    const d = b.clone().sub(a);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, d.length() - r), 4, 10), mat);
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    g.add(m);
    return m;
  };
  const hand = (p: THREE.Vector3, rotZ: number, rotX: number) => {
    const palm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.085, 0.095), glove);
    palm.position.copy(p);
    palm.rotation.set(rotX, 0, rotZ);
    g.add(palm);
    const fingers = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.06, 3, 8), glove);
    fingers.rotation.set(0, 0, Math.PI / 2);
    fingers.position.set(0.0, -0.035, -0.02);
    palm.add(fingers);
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.04, 3, 8), glove);
    thumb.rotation.set(Math.PI / 2.5, 0, 0);
    thumb.position.set(-0.03, 0.02, -0.03);
    palm.add(thumb);
  };
  // right: pistol grip → elbow → shoulder (off screen)
  const rH = new THREE.Vector3(0.0, -0.045, 0.035), rE = new THREE.Vector3(0.17, -0.26, 0.33), rS = new THREE.Vector3(0.24, -0.34, 0.75);
  hand(rH, 0.15, -0.35);
  seg(rH.clone().add(new THREE.Vector3(0.01, -0.02, 0.05)), rE, 0.045, camo);
  seg(rE, rS, 0.058, camo);
  seg(rE.clone().lerp(rS, 0.3), rE.clone().lerp(rS, 0.38), 0.062, tape);
  seg(rH.clone().add(new THREE.Vector3(0.01, -0.02, 0.05)), rH.clone().add(new THREE.Vector3(0.015, -0.03, 0.09)), 0.047, glove); // cuff
  // left: handguard → elbow → shoulder
  const lH = new THREE.Vector3(-0.005, -0.02, supportZ), lE = new THREE.Vector3(-0.21, -0.25, -0.05), lS = new THREE.Vector3(-0.28, -0.34, 0.55);
  hand(lH, -0.5, 0.2);
  seg(lH.clone().add(new THREE.Vector3(-0.03, -0.03, 0.03)), lE, 0.045, camo);
  seg(lE, lS, 0.058, camo);
  seg(lE.clone().lerp(lS, 0.3), lE.clone().lerp(lS, 0.38), 0.062, tape);
  g.traverse((o) => { o.castShadow = false; o.frustumCulled = false; });
  return g;
}
