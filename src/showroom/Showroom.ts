import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ASSETS, type AssetSpec, getSpec } from '../assets/AssetRegistry';
import { type FactoryEvent, SingleAIModelFactory } from '../assets/SingleAIModelFactory';
import { TEAM_STYLE, type Team } from '../assets/StylePreset';
import type { AssetInstance } from '../assets/pipeline/ModelLoader';

/**
 * Asset showroom: verifies every model produced by SingleAIModelFactory in the real renderer
 * (WebGPU with automatic WebGL2 fallback), exercises the node contract (turret / cannon / tracks,
 * propellers / gimbal, destruction clusters, skeletal clips) and shows the validation report.
 */

const CATEGORY_LABEL: Record<AssetSpec['category'], string> = {
  infantry: 'Пехота',
  weapon: 'Вооружение',
  vehicle: 'Бронетехника',
  drone: 'БПЛА',
  environment: 'Окружение «Малая Токмачка»',
};

interface Fragment { obj: THREE.Object3D; home: THREE.Vector3; homeQ: THREE.Quaternion; vel: THREE.Vector3; spin: THREE.Vector3 }

export class Showroom {
  private renderer!: THREE.WebGPURenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.02, 3000);
  private controls!: OrbitControls;
  private clock = new THREE.Timer();
  private factory: SingleAIModelFactory;
  private current?: { id: string; team?: Team; inst: AssetInstance; mixer?: THREE.AnimationMixer };
  private team: Team = 'A';
  private animate = true;
  private lodMode: 'auto' | 0 | 1 | 2 | 3 = 'auto';
  private fragments: Fragment[] = [];
  private blastTime = -1;
  private clip = 0;
  private ui: Record<string, HTMLElement> = {};
  private status = new Map<string, 'busy' | 'ok' | 'warn'>();
  private loadToken = 0;

  constructor(private canvas: HTMLCanvasElement, private root: HTMLElement) {
    const q = new URLSearchParams(location.search);
    this.factory = new SingleAIModelFactory({
      engine: (q.get('engine') as 'tripo' | 'procedural' | null) ?? 'auto',
      quality: (q.get('quality') as 'mobile' | 'desktop' | 'ultra' | null) ?? undefined,
    });
  }

  async start(): Promise<void> {
    this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: true });
    await this.renderer.init();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new THREE.Color(0x9aa3a6);
    this.scene.fog = new THREE.Fog(0x9aa3a6, 60, 600);

    const sun = new THREE.DirectionalLight(0xfff1dc, 3.2);
    sun.position.set(18, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);
    (this as unknown as { sun: THREE.DirectionalLight }).sun = sun;
    this.scene.add(new THREE.HemisphereLight(0xbcc8d0, 0x4a4436, 0.6));

    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: 0x5b5a3e, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.scene.add(ground);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);
    this.camera.position.set(6, 4, 8);

    this.buildUI();
    this.factory.addEventListener('progress', (e) => this.onFactory((e as CustomEvent<FactoryEvent>).detail));
    const engine = await this.factory.init(this.renderer);
    this.ui.engine.textContent = `Движок: ${engine === 'tripo' ? 'Tripo3D v2.5 (API)' : 'встроенный процедурный генератор'} · качество: ${this.factory.quality} · бэкенд: ${(this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`;

    addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
    const first = new URLSearchParams(location.search).get('asset') ?? 'tank_t72b3';
    await this.show(ASSETS.some((a) => a.id === first) ? first : 'tank_t72b3');
  }

  // ───────────────────────── UI ─────────────────────────

  private buildUI(): void {
    const side = el('div', 'panel side');
    side.innerHTML = `<header><h1>Single AI Model Factory</h1><div class="sub">Единый генератор ассетов · 1 unit = 1 m · PBR (Albedo / Normal / Roughness / Metallic)</div><div class="sub" data-k="engine">инициализация…</div><div class="progress"><i data-k="bar"></i></div></header><div class="list" data-k="list"></div>`;
    const list = side.querySelector('[data-k=list]') as HTMLElement;
    const cats = [...new Set(ASSETS.map((a) => a.category))];
    for (const c of cats) {
      list.append(el('div', 'cat', CATEGORY_LABEL[c]));
      for (const a of ASSETS.filter((x) => x.category === c)) {
        const b = el('button', 'item') as HTMLButtonElement;
        b.dataset.id = a.id;
        b.innerHTML = `<span>${a.displayName}</span><i class="dot"></i>`;
        b.onclick = () => { void this.show(a.id); if (innerWidth < 900) side.classList.add('collapsed'); };
        list.append(b);
      }
    }
    const menu = el('button', 'btn panel menu-btn', '☰');
    menu.onclick = () => side.classList.toggle('collapsed');
    if (innerWidth < 900) side.classList.add('collapsed');

    const bar = el('div', 'panel toolbar');
    const teamBtn = btn('Команда А', () => {
      this.team = this.team === 'A' ? 'B' : 'A';
      teamBtn.textContent = this.team === 'A' ? 'Команда А' : 'Команда Б';
      if (this.current && getSpec(this.current.id).teamVariants) void this.show(this.current.id);
    });
    teamBtn.title = `${TEAM_STYLE.A.label} / ${TEAM_STYLE.B.label}`;
    const animBtn = btn('Анимация ✓', () => { this.animate = !this.animate; animBtn.textContent = this.animate ? 'Анимация ✓' : 'Анимация ✗'; });
    const lodSel = el('select', 'btn') as HTMLSelectElement;
    lodSel.innerHTML = ['auto', '0', '1', '2', '3'].map((v) => `<option value="${v}">LOD ${v}</option>`).join('');
    lodSel.onchange = () => { this.lodMode = lodSel.value === 'auto' ? 'auto' : (Number(lodSel.value) as 0 | 1 | 2 | 3); this.applyLOD(); };
    const clipBtn = btn('Клип: Idle', () => {
      const cur = this.current;
      if (!cur?.mixer) return;
      this.clip = (this.clip + 1) % cur.inst.animations.length;
      this.playClip();
      clipBtn.textContent = `Клип: ${cur.inst.animations[this.clip].name}`;
    });
    this.ui.clip = clipBtn;
    bar.append(
      teamBtn, animBtn, lodSel, clipBtn,
      btn('Взрыв 💥', () => this.blast()),
      btn('Скачать .glb', () => this.current && this.factory.downloadGLB(this.current.id, this.current.team)),
      btn('Сгенерировать всё', () => void this.generateAll()),
      btn('Очистить кэш', async () => { await this.factory.clearCache(); this.status.clear(); this.refreshDots(); this.log('IndexedDB cache cleared'); }),
    );

    const info = el('div', 'panel info');
    const log = el('div', 'panel log');
    this.root.append(side, menu, bar, info, log);
    this.ui.side = side;
    this.ui.list = list;
    this.ui.info = info;
    this.ui.logBox = log;
    this.ui.engine = side.querySelector('[data-k=engine]') as HTMLElement;
    this.ui.bar = side.querySelector('[data-k=bar]') as HTMLElement;
  }

  private log(msg: string): void {
    const d = el('div', '', msg);
    this.ui.logBox.append(d);
    while (this.ui.logBox.children.length > 7) this.ui.logBox.firstChild!.remove();
    console.info('[factory]', msg);
  }

  private onFactory(e: FactoryEvent): void {
    this.log(e.message);
    if (e.id && e.type === 'asset-start') this.status.set(e.id, 'busy');
    if (e.id && e.type === 'asset-done') this.status.set(e.id, 'ok');
    if (e.progress !== undefined) (this.ui.bar as HTMLElement).style.width = `${Math.round(e.progress * 100)}%`;
    this.refreshDots();
  }

  private refreshDots(): void {
    this.ui.list.querySelectorAll<HTMLButtonElement>('.item').forEach((b) => {
      const s = this.status.get(b.dataset.id!);
      const r = this.factory.result(b.dataset.id!, this.team);
      const dot = b.querySelector('.dot')!;
      dot.className = `dot ${s === 'busy' ? 'busy' : r ? (r.report?.ok ? 'ok' : 'warn') : ''}`;
      b.classList.toggle('active', this.current?.id === b.dataset.id);
    });
  }

  private async generateAll(): Promise<void> {
    const t0 = performance.now();
    const res = await this.factory.generateAll();
    const stats = await this.factory.cacheStats();
    this.log(`library ready: ${res.length} models in ${((performance.now() - t0) / 1000).toFixed(1)} s · cache ${stats.entries} entries / ${(stats.bytes / 1048576).toFixed(1)} MB`);
    this.refreshDots();
  }

  // ───────────────────────── asset display ─────────────────────────

  async show(id: string): Promise<void> {
    const token = ++this.loadToken;
    const spec = getSpec(id);
    const team = spec.teamVariants ? this.team : undefined;
    this.ui.info.innerHTML = `<h2>${spec.displayName}</h2><div class="sub">генерация…</div>`;
    const inst = await this.factory.instantiate(id, team);
    if (token !== this.loadToken) return;
    if (this.current) this.scene.remove(this.current.inst.root);
    this.fragments = [];
    this.blastTime = -1;
    const mixer = inst.animations.length ? new THREE.AnimationMixer(inst.root) : undefined;
    this.current = { id, team, inst, mixer };
    this.clip = 0;
    if (mixer) this.playClip();
    (this.ui.clip as HTMLButtonElement).style.display = mixer ? '' : 'none';
    if (mixer) this.ui.clip.textContent = `Клип: ${inst.animations[0].name}`;
    this.scene.add(inst.root);
    this.frameCamera(inst.root);
    this.applyLOD();
    this.renderInfo(spec, team);
    this.refreshDots();
    const qs = new URLSearchParams(location.search);
    qs.set('asset', id);
    history.replaceState(null, '', `?${qs}`);
  }

  private playClip(): void {
    const c = this.current!;
    c.mixer!.stopAllAction();
    c.mixer!.clipAction(c.inst.animations[this.clip]).play();
  }

  private frameCamera(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    this.controls.target.copy(center);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    this.camera.position.copy(center).add(new THREE.Vector3(1.1, 0.55, -1.15).normalize().multiplyScalar(dist));
    this.camera.near = Math.max(0.005, dist / 500);
    this.camera.far = dist * 50 + 500;
    this.camera.updateProjectionMatrix();
    const sun = (this as unknown as { sun: THREE.DirectionalLight }).sun;
    const s = Math.max(r * 1.6, 2);
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.1, far: s * 8 + 60 });
    sun.position.copy(center).add(new THREE.Vector3(0.6, 1, 0.4).normalize().multiplyScalar(s * 3 + 10));
    sun.target.position.copy(center);
    sun.shadow.camera.updateProjectionMatrix();
  }

  private renderInfo(spec: AssetSpec, team?: Team): void {
    const r = this.factory.result(spec.id, team);
    const rep = r?.report;
    const nodes = spec.requiredNodes.length > 10 ? `${spec.requiredNodes.slice(0, 8).join(', ')} … (+${spec.requiredNodes.length - 8})` : spec.requiredNodes.join(', ');
    const dev = rep ? rep.scaleDeviation.map((d) => `${d >= 0 ? '+' : ''}${Math.round(d * 100)}%`).join(' / ') : '—';
    this.ui.info.innerHTML = `
      <h2>${spec.displayName}${team ? ` · ${TEAM_STYLE[team].label}` : ''}</h2>
      <table>
        <tr><td>Движок</td><td>${r?.engine ?? '—'} ${r?.fromCache ? '(IndexedDB кэш)' : ''}</td></tr>
        <tr><td>Валидация</td><td style="color:${rep?.ok ? 'var(--ok)' : 'var(--warn)'}">${rep ? (rep.ok ? 'OK — стандарт соблюдён' : rep.warnings.join('; ')) : '—'}</td></tr>
        <tr><td>Габариты, м</td><td>${rep?.extents.join(' × ') ?? '—'}<br><span class="sub">спец: ${spec.dimensions.join(' × ')} (${dev})</span></td></tr>
        <tr><td>Треугольники LOD0–3</td><td>${r?.lodTriangles?.join(' / ') ?? rep?.triangles ?? '—'}</td></tr>
        <tr><td>Меши / материалы</td><td>${rep ? `${rep.meshes} / ${rep.materials}` : '—'}</td></tr>
        <tr><td>.glb</td><td>${r?.sizes ? `${kb(r.sizes.raw)} → ${kb(r.sizes.optimized)} (Meshopt, JPEG/PNG)` : kb(r?.bytes.byteLength ?? 0)}</td></tr>
        <tr><td>Время</td><td>${r ? `${Math.round(r.ms)} мс` : '—'}</td></tr>
        <tr><td>Узлы-контракт</td><td><code>${nodes}</code></td></tr>
        <tr><td>Prompt</td><td><code>${escapeHtml(this.factory.stylePrefix)} ${escapeHtml(spec.prompt)}</code></td></tr>
      </table>`;
  }

  private applyLOD(): void {
    this.current?.inst.root.traverse((o) => {
      const lod = o as THREE.LOD;
      if (!lod.isLOD) return;
      if (this.lodMode === 'auto') {
        lod.autoUpdate = true;
        return;
      }
      lod.autoUpdate = false;
      const target = Math.min(this.lodMode, lod.levels.length - 1);
      lod.levels.forEach((l, i) => (l.object.visible = i === target));
    });
  }

  // ───────────────────────── node-contract demo ─────────────────────────

  private blast(): void {
    const cur = this.current;
    if (!cur) return;
    if (this.blastTime >= 0) { this.resetBlast(); return; }
    const center = new THREE.Box3().setFromObject(cur.inst.root).getCenter(new THREE.Vector3());
    this.fragments = [];
    cur.inst.root.traverse((o) => {
      if (/^(Wall_Cluster|Roof_Cluster|Crown_Cluster)_\d+$/.test(o.name) || o.name === 'Trunk_Upper' || o.name === 'Payload' || o.name === 'Cage' || o.name === 'Turret' || o.name === 'Magazine') {
        const wp = o.getWorldPosition(new THREE.Vector3());
        const dir = wp.sub(center).setY(0).normalize();
        const strength = o.name === 'Turret' ? 6 : o.name === 'Trunk_Upper' ? 2 : 4 + Math.random() * 4;
        this.fragments.push({
          obj: o, home: o.position.clone(), homeQ: o.quaternion.clone(),
          vel: dir.multiplyScalar(strength).add(new THREE.Vector3(0, 3 + Math.random() * 5, 0)),
          spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4),
        });
      }
    });
    this.blastTime = 0;
    if (!this.fragments.length) this.log('у этой модели нет отделяемых узлов');
  }

  private resetBlast(): void {
    for (const f of this.fragments) { f.obj.position.copy(f.home); f.obj.quaternion.copy(f.homeQ); }
    this.fragments = [];
    this.blastTime = -1;
  }

  private frame(): void {
    this.clock.update();
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.getElapsed();
    this.controls.update();
    const cur = this.current;
    if (cur && this.animate) {
      cur.mixer?.update(dt);
      const n = cur.inst.nodes;
      const turret = n.get('Turret');
      if (turret && this.blastTime < 0) turret.rotation.y = Math.sin(t * 0.4) * 1.2;
      const cannon = n.get('Cannon');
      if (cannon && this.blastTime < 0) cannon.rotation.x = Math.sin(t * 0.7) * 0.12 + 0.04;
      for (const k of ['Prop_FL', 'Prop_RR']) { const p = n.get(k); if (p) p.rotation.y += dt * 60; }
      for (const k of ['Prop_FR', 'Prop_RL']) { const p = n.get(k); if (p) p.rotation.y -= dt * 60; }
      const pm = n.get('Prop_Main'); if (pm) pm.rotation.z += dt * 50;
      const gim = n.get('Camera_Gimbal'); if (gim) gim.rotation.x = -0.3 + Math.sin(t) * 0.25;
      const yaw = n.get('Yaw'); if (yaw) yaw.rotation.y = Math.sin(t * 0.5) * 0.6;
      // tracks: scroll belt UVs, spin wheels / sprockets / idlers
      if (n.has('Track_L')) {
        cur.inst.root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && /track_links__/.test((m.material as THREE.Material).name)) {
            const mat = m.material as THREE.MeshStandardMaterial;
            for (const tex of [mat.map, mat.normalMap, mat.roughnessMap]) if (tex) tex.offset.y -= dt * 0.8;
          } else if (/^(Wheel|Roller|Sprocket|Idler)_[LR]/.test(o.name) && !/_m_|_LOD/.test(o.name)) {
            o.rotation.x -= dt * 3;
          }
        });
      }
    }
    if (this.blastTime >= 0) {
      this.blastTime += dt;
      for (const f of this.fragments) {
        f.vel.y -= 9.81 * dt;
        f.obj.position.addScaledVector(f.vel, dt);
        const wy = f.obj.getWorldPosition(new THREE.Vector3()).y;
        if (wy < 0.2 && f.vel.y < 0) { f.vel.multiplyScalar(0.3); f.vel.y = Math.abs(f.vel.y) * 0.3; f.spin.multiplyScalar(0.5); }
        f.obj.rotation.x += f.spin.x * dt; f.obj.rotation.y += f.spin.y * dt; f.obj.rotation.z += f.spin.z * dt;
      }
      if (this.blastTime > 4) this.resetBlast();
    }
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

function el(tag: string, cls = '', text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'btn', label) as HTMLButtonElement;
  b.onclick = onClick;
  return b;
}
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
