import * as THREE from 'three/webgpu';
import type { AssetTemplate } from '../assets/pipeline/ModelLoader';
import { SingleAIModelFactory } from '../assets/SingleAIModelFactory';
import type { Team } from '../assets/StylePreset';
import { Combat } from './combat/Combat';
import { Audio } from './core/Audio';
import { Input } from './core/Input';
import { Physics } from './core/Physics';
import { Bot } from './entities/BotAI';
import { DroneSystem } from './entities/Drone';
import { Emplacement } from './entities/Emplacement';
import { Player } from './entities/Player';
import type { Soldier } from './entities/Soldier';
import { Vehicle } from './entities/Vehicle';
import { Particles } from './fx/Particles';
import { PostFX } from './fx/PostFX';
import { Thermal } from './fx/Thermal';
import type { GameContext, GameSettings } from './GameContext';
import { Conquest } from './modes/Conquest';
import { HUD } from './ui/HUD';
import { TouchControls } from './ui/TouchControls';
import { Environment } from './world/Environment';
import { buildLayout } from './world/MapLayout';
import { StaticWorld } from './world/StaticWorld';
import { Terrain } from './world/Terrain';
import { Vegetation } from './world/Vegetation';

const ASSET_IDS = [
  'rifle_ar', 'rifle_ak', 'ew_gun', 'drone_fpv7', 'atgm_launcher', 'mortar_82',
  'tank_leo2a6', 'tank_leo2a4', 'tank_t72b3', 'ifv_bmp2', 'tank_t64bv', 'tank_t80bvm',
  'house_brick', 'house_ruined', 'hangar', 'fence_concrete', 'trench_segment', 'dugout', 'czech_hedgehog',
  'tree_poplar', 'tree_acacia', 'tree_scorched',
];

/**
 * «Малая Токмачка» — session orchestrator: builds the world from the factory's models,
 * spawns both teams, runs the fixed update order and renders through the TSL pipeline.
 */
export class Game {
  ctx!: GameContext;
  private bots: Bot[] = [];
  private touch?: TouchControls;
  private env!: Environment;
  private running = true;
  private paused = false;
  private last = performance.now();
  private respawnQueue: { team: Team; id: string; x: number; z: number; rot: number; at: number }[] = [];
  private wrecks: { v: Vehicle; at: number }[] = [];
  private fpsAcc = 0;
  private fpsN = 0;
  fps = 0;
  backendName = '';
  onExit?: () => void;
  onRestart?: () => void;

  static async create(settings: GameSettings, canvas: HTMLCanvasElement, ui: HTMLElement, progress: (p: number, text: string) => void): Promise<Game> {
    const g = new Game();
    await g.init(settings, canvas, ui, progress);
    return g;
  }

  private async init(settings: GameSettings, canvas: HTMLCanvasElement, ui: HTMLElement, progress: (p: number, text: string) => void): Promise<void> {
    progress(0.02, 'Инициализация WebGPU…');
    const mobile = settings.quality === 'mobile';
    // Mobile WebGPU (e.g. iOS 26 Safari) is still young; the WebGL2 backend is the proven path there.
    const forceWebGL = settings.api === 'webgl' || (settings.api !== 'webgpu' && settings.touch);
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance', forceWebGL });
    await renderer.init();
    this.backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    type Dev = { lost: Promise<{ message: string }>; addEventListener?: (t: string, f: (e: { error: { message: string } }) => void) => void };
    const dev = (renderer.backend as { device?: Dev }).device;
    if (dev) {
      void dev.lost.then((i) => reportError(`WebGPU device lost: ${i.message}. Выберите «WebGL2» в настройках.`));
      dev.addEventListener?.('uncapturederror', (e) => reportError(`WebGPU: ${e.error.message}`));
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.25 : 2));
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.05, 2500);
    scene.add(camera);

    progress(0.05, 'Физика Rapier3D (WASM)…');
    const physics = await Physics.create();
    const factory = new SingleAIModelFactory({ engine: 'auto', quality: settings.quality });
    await factory.init(renderer);
    const layout = buildLayout();

    progress(0.08, 'Рельеф «Малой Токмачки»…');
    await tick();
    const terrain = new Terrain(layout, mobile ? 201 : 321);
    const audio = new Audio();
    const input = new Input(canvas);
    const particles = new Particles(mobile ? 600 : 1000);
    particles.group.userData.heat = -1;
    const postfx = new PostFX(renderer, scene, camera, !mobile);
    const thermal = new Thermal(scene, postfx);
    thermal.onChange = (on) => (particles.hideSmoke = on);
    const templates = new Map<string, AssetTemplate>();

    const ctx = {
      settings, scene, camera, renderer, physics, terrain, particles, audio, input, postfx, thermal, layout, factory, templates,
      soldiers: [] as Soldier[], vehicles: [] as Vehicle[], emplacements: [] as Emplacement[], time: 0,
      template: (id: string, team?: Team) => {
        const t = templates.get(team ? `${id}:${team}` : id);
        if (!t) throw new Error(`template ${id} not loaded`);
        return t;
      },
      killFeed: (k: string, v: string, w: string, kt: Team | null, vt: Team) => ctx.hud.killFeed(k, v, w, kt, vt),
    } as unknown as GameContext;
    this.ctx = ctx;

    // ── models: every asset comes from the single factory ──
    const jobs: [string, Team | undefined][] = [['soldier', 'A'], ['soldier', 'B'], ...ASSET_IDS.map((id) => [id, undefined] as [string, undefined])];
    for (let i = 0; i < jobs.length; i++) {
      const [id, team] = jobs[i];
      progress(0.1 + (i / jobs.length) * 0.6, `Генерация моделей: ${id}${team ? ` (${team})` : ''}  ${i + 1}/${jobs.length}`);
      templates.set(team ? `${id}:${team}` : id, await factory.loadForGame(id, team));
    }

    progress(0.72, 'Материалы рельефа…');
    await tick();
    scene.add(terrain.buildMesh(factory.materials));
    terrain.mesh.userData.heat = 0.17;
    terrain.buildCollider(physics);

    progress(0.78, 'Застройка, окопы, лесополосы…');
    await tick();
    const statics = new StaticWorld(physics);
    ctx.statics = statics;
    statics.group.userData.heat = 0.24;
    this.placeStatics();
    statics.build();
    scene.add(statics.group);
    const veg = new Vegetation(physics, terrain, layout);
    ctx.vegetation = veg;
    veg.group.userData.heat = 0.2;
    for (const id of ['tree_poplar', 'tree_acacia', 'tree_scorched']) veg.registerType(id, ctx.template(id), 260);
    veg.plant();
    veg.initGrass(factory.materials, mobile ? 1600 : 4500);
    scene.add(veg.group, particles.group);

    progress(0.86, 'Освещение и небо…');
    await tick();
    this.env = new Environment(scene, renderer, settings.quality);

    progress(0.9, 'Расстановка сил…');
    ctx.combat = new Combat(ctx);
    ctx.drones = new DroneSystem(ctx);
    ctx.hud = new HUD(ctx, ui);
    ctx.hud.setMinimapSource(terrain.splatCanvas);
    ctx.conquest = new Conquest(ctx, mobile ? 150 : 200);
    const team = settings.playerTeam;
    const sp = ctx.conquest.spawnAt(team, 'base');
    ctx.player = new Player(ctx, team, sp);
    ctx.player.soldier.yaw = Math.atan2(sp.x, sp.z);
    ctx.soldiers.push(ctx.player.soldier);
    for (const t of ['A', 'B'] as const) {
      const n = settings.botsPerTeam - (t === team ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const b = new Bot(ctx, t, i, ctx.conquest.spawnAt(t, 'base'));
        b.soldier.model!.root.userData.heat = 0.95;
        this.bots.push(b);
        ctx.soldiers.push(b.soldier);
      }
    }
    for (const t of ['A', 'B'] as const) for (const v of layout.vehicleSpawns[t]) this.spawnVehicle(t, v.id, v.x, v.z, v.rot);
    for (const e of layout.emplacements) ctx.emplacements.push(new Emplacement(ctx, e.id, e.team, e.x, e.z, e.rot));

    if (settings.touch) {
      this.touch = new TouchControls(input, ui, settings.touchLayout);
      this.touch.onAutoSprint = (v) => (ctx.player.autoSprint = v);
      this.touch.onZoom = (z) => { if (ctx.player.vehicle) ctx.player.vehicle.zoomIndex = z; };
    }
    ctx.hud.onModeChange = (m) => this.touch?.setMode(m);
    ctx.hud.onDeploy = (id) => ctx.player.deploy(ctx.conquest.spawnAt(team, id));
    ctx.hud.onResume = () => this.setPaused(false);
    ctx.hud.onQuit = () => { this.dispose(); this.onExit?.(); };
    ctx.hud.onRestart = () => { this.dispose(); this.onRestart?.(); };
    input.mode = 'infantry';
    ctx.hud.setMode('infantry');
    ctx.hud.message('Захватите и удерживайте точки A, B, C', 'good');

    progress(0.96, 'Компиляция шейдеров…');
    await renderer.compileAsync(scene, camera).catch(() => undefined);
    addEventListener('resize', this.onResize);
    this.onResize();
    progress(1, 'Готово');
  }

  private placeStatics(): void {
    const { ctx } = this;
    const { layout, terrain, statics } = ctx;
    const place = (id: string, x: number, z: number, rot: number, y = terrain.heightAt(x, z), opts: { soft?: boolean; passable?: boolean } = {}) => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(1, 1, 1));
      statics.add(ctx.template(id), m, opts);
    };
    for (const b of layout.buildings) place(b.id, b.x, b.z, b.rot, terrain.heightAt(b.x, b.z) - 0.1);
    for (const p of layout.props) {
      if (p.id === 'dugout') place(p.id, p.x, p.z, p.rot, terrain.heightAt(p.x + 6, p.z + 6), { passable: true });
      else place(p.id, p.x, p.z, p.rot, terrain.heightAt(p.x, p.z) - 0.05, { soft: p.id === 'fence_concrete' });
    }
    // trench segments along the zig-zag lines; height from the uncarved ground beside the trench
    for (const tr of layout.trenches) {
      for (let i = 0; i < tr.pts.length - 1; i++) {
        const [ax, az] = tr.pts[i], [bx, bz] = tr.pts[i + 1];
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const rot = Math.atan2(bx - ax, bz - az);
        const nx = Math.cos(rot) * 4, nz = -Math.sin(rot) * 4;
        const y = Math.max(terrain.heightAt(mx + nx, mz + nz), terrain.heightAt(mx - nx, mz - nz)) - 0.1;
        place('trench_segment', mx, mz, rot, y, { passable: true });
      }
    }
    // burnt wrecks from earlier fighting
    const burnt = new THREE.MeshStandardMaterial({ color: 0x1c1a17, roughness: 0.95, metalness: 0.25, name: 'burnt' });
    for (const [id, x, z, rot] of [['tank_t64bv', 30, 120, 2.2], ['tank_t80bvm', -60, -20, 0.6], ['ifv_bmp2', 95, 60, -1.1]] as [string, number, number, number][]) {
      const inst = ctx.factory.instantiateTemplate(ctx.template(id));
      inst.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = burnt; });
      const t = inst.nodes.get('Turret');
      if (t) { t.rotation.y = 1.3; t.position.y -= 0.15; }
      inst.root.updateMatrixWorld(true);
      const wrap = new THREE.Group();
      wrap.add(inst.root);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, terrain.heightAt(x, z) - 0.25, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.04, rot, 0.06)), new THREE.Vector3(1, 1, 1));
      statics.add({ scene: wrap, animations: [], meta: { assetId: id } }, m);
    }
  }

  private spawnVehicle(team: Team, id: string, x: number, z: number, rot: number): Vehicle {
    const v = new Vehicle(this.ctx, id, team, new THREE.Vector3(x, this.ctx.terrain.heightAt(x, z), z), rot);
    v.inst.root.userData.heat = 0.6;
    this.ctx.vehicles.push(v);
    return v;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.ctx.hud.showPause(p);
    if (!p) this.ctx.input.requestLock();
    else this.ctx.input.releaseLock();
  }

  private onResize = (): void => {
    const { renderer, camera } = this.ctx;
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };

  start(): void {
    this.ctx.audio.unlock();
    this.ctx.input.requestLock();
    this.last = performance.now();
    this.ctx.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 1) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
    const ctx = this.ctx;
    const f = ctx.input.poll();
    if (f.pressed.has('pause') && !ctx.conquest.winner) this.setPaused(!this.paused);
    if (!this.paused && !ctx.conquest.winner) this.update(dt, f);
    ctx.postfx.update(dt, innerWidth, innerHeight);
    ctx.postfx.uDamage.value = Math.max(ctx.player.damageFlash, ctx.player.soldier.alive ? Math.max(0, (40 - ctx.player.soldier.hp) / 60) : 0);
    ctx.postfx.uSuppress.value = ctx.player.suppression;
    ctx.postfx.render();
  }

  private update(dt: number, f: ReturnType<Input['poll']>): void {
    const ctx = this.ctx;
    ctx.time += dt;
    ctx.player.update(f, dt);
    for (const b of this.bots) b.update(dt);
    for (const v of ctx.vehicles) v.update(dt);
    ctx.drones.update(dt);
    ctx.combat.update(dt);
    ctx.physics.step(dt);
    ctx.statics.update(dt);
    ctx.vegetation.update(dt, ctx.camera);
    ctx.particles.update(dt, ctx.camera);
    ctx.conquest.update(dt);
    this.respawns();
    const focus = ctx.player.drone?.pos ?? ctx.player.vehicle?.position ?? ctx.player.soldier.position;
    this.env.update(focus);
    ctx.audio.setListener(ctx.camera);
    ctx.hud.update(dt);
    if (ctx.conquest.winner) {
      ctx.input.releaseLock();
      ctx.hud.showEnd(ctx.conquest.winner);
    }
  }

  private respawns(): void {
    const ctx = this.ctx;
    for (const b of this.bots) {
      const s = b.soldier;
      if (!s.alive && ctx.time - s.deathTime > 7) s.respawn(ctx.conquest.botSpawn(s.team));
    }
    for (const v of ctx.vehicles) {
      if (v.alive || this.wrecks.some((w) => w.v === v)) continue;
      this.wrecks.push({ v, at: ctx.time });
      const spawn = ctx.layout.vehicleSpawns[v.team].find((s) => s.id === v.assetId);
      if (spawn) this.respawnQueue.push({ team: v.team, ...spawn, at: ctx.time + 50 });
    }
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      const r = this.respawnQueue[i];
      if (ctx.time < r.at) continue;
      this.respawnQueue.splice(i, 1);
      this.spawnVehicle(r.team, r.id, r.x, r.z, r.rot);
    }
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      if (ctx.time - this.wrecks[i].at < 90) continue;
      const v = this.wrecks[i].v;
      v.removeWreck();
      ctx.vehicles.splice(ctx.vehicles.indexOf(v), 1);
      this.wrecks.splice(i, 1);
    }
  }

  dispose(): void {
    this.running = false;
    const ctx = this.ctx;
    ctx.renderer.setAnimationLoop(null);
    ctx.input.releaseLock();
    ctx.input.mode = 'menu';
    removeEventListener('resize', this.onResize);
    ctx.hud.root.remove();
    this.touch?.root.remove();
    void ctx.audio.ctx?.close();
    ctx.renderer.dispose();
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Visible error panel (mobile has no console). */
export function reportError(msg: string): void {
  console.error(msg);
  let el = document.getElementById('err-panel');
  if (!el) {
    el = document.createElement('div');
    el.id = 'err-panel';
    el.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:200;max-height:30vh;overflow:auto;background:rgba(60,10,10,.92);color:#fff;font:12px/1.4 ui-monospace,monospace;padding:8px 10px;border-radius:6px;pointer-events:auto;white-space:pre-wrap';
    el.addEventListener('click', () => el!.remove());
    document.body.appendChild(el);
  }
  el.textContent = `${el.textContent ? el.textContent + '\n' : ''}${msg}`.slice(-3000);
}
