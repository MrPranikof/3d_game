import * as THREE from 'three/webgpu';
import type { Team } from '../../assets/StylePreset';
import type { GameContext } from '../GameContext';
import { HALF, MAP_SIZE } from '../world/MapLayout';

export type HudMode = 'infantry' | 'tank' | 'drone' | 'emplacement' | 'dead';

const TEAM_COLOR: Record<Team, string> = { A: '#e8c547', B: '#e0604f' };
const TEAM_NAME: Record<Team, string> = { A: 'Команда А', B: 'Команда Б' };

/** DOM HUD (desktop + mobile). Text updates are throttled; reticles update every frame. */
export class HUD {
  readonly root: HTMLElement;
  mode: HudMode = 'infantry';
  private el: Record<string, HTMLElement> = {};
  private feed: { node: HTMLElement; t: number }[] = [];
  private msgTimer = 0;
  private hitTimer = 0;
  private dmgArrows: { node: HTMLElement; t: number; at: THREE.Vector3 }[] = [];
  private textTimer = 0;
  private minimap: CanvasRenderingContext2D;
  private mmBg: HTMLCanvasElement | null = null;
  onDeploy?: (id: string) => void;
  onResume?: () => void;
  onQuit?: () => void;
  onRestart?: () => void;
  onSettings?: () => void;
  paused = false;

  constructor(private ctx: GameContext, parent: HTMLElement) {
    const r = document.createElement('div');
    r.id = 'hud';
    r.innerHTML = `
      <div class="hud-top">
        <div class="tickets"><span class="tk tkA"><i></i><b data-k="tA">0</b></span><div class="pts" data-k="pts"></div><span class="tk tkB"><b data-k="tB">0</b><i></i></span></div>
        <div class="compass"><div class="compass-strip" data-k="compass"></div><div class="compass-mark"></div></div>
      </div>
      <div class="feed" data-k="feed"></div>
      <div class="msg" data-k="msg"></div>
      <div class="threat" data-k="threat">⚠ FPV-ДРОН ПРОТИВНИКА</div>
      <div class="reticle-inf" data-k="cross"><i class="c-t"></i><i class="c-b"></i><i class="c-l"></i><i class="c-r"></i><i class="c-d"></i></div>
      <div class="hitmark" data-k="hit"><i></i><i></i><i></i><i></i></div>
      <div class="hit-text" data-k="hitText"></div>
      <div class="dmg-ring" data-k="dmgRing"></div>
      <div class="prompt" data-k="prompt"></div>
      <div class="bl">
        <canvas class="minimap" width="180" height="180" data-k="mm"></canvas>
        <div class="hp"><div class="hp-bar"><i data-k="hp"></i></div><span data-k="stance">СТОЯ</span></div>
      </div>
      <div class="br" data-k="ammoBox">
        <div class="wname" data-k="wname"></div>
        <div class="ammo"><b data-k="mag">30</b><span data-k="res">/ 180</span></div>
        <div class="inv" data-k="inv"></div>
      </div>
      <div class="tank-hud" data-k="tank">
        <svg class="tank-reticle" viewBox="-100 -100 200 200" data-k="tankRet"><path d="M-60 0 H-8 M8 0 H60 M0 8 V40" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M-4 0 H4 M0 -4 V4" stroke="currentColor" stroke-width="1"/><g data-k="ticks"></g></svg>
        <div class="tank-third" data-k="tankThird"><i></i></div>
        <div class="tank-info"><div data-k="tName"></div><div data-k="tAmmo"></div><div class="reload"><i data-k="tReload"></i></div><div data-k="tRange"></div><div data-k="tSpeed"></div><div data-k="tState"></div></div>
        <svg class="turret-ind" viewBox="-50 -50 100 100"><g data-k="hullG"><rect x="-14" y="-26" width="28" height="52" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M-6 -26 L0 -33 L6 -26" fill="none" stroke="currentColor" stroke-width="2"/></g><g data-k="turG"><circle r="9" fill="none" stroke="#f3d36b" stroke-width="2"/><path d="M0 -9 V-40" stroke="#f3d36b" stroke-width="3"/></g></svg>
      </div>
      <div class="drone-hud" data-k="drone">
        <div class="osd tl" data-k="oTL"></div><div class="osd tr" data-k="oTR"></div><div class="osd bl2" data-k="oBL"></div><div class="osd br2" data-k="oBR"></div>
        <div class="osd-cross">+</div><div class="osd-horizon" data-k="horizon"></div><div class="osd-lost" data-k="lost">СИГНАЛ ПОТЕРЯН</div>
      </div>
      <div class="emp-hud" data-k="emp"><div class="emp-ret"></div><div class="emp-info" data-k="empInfo"></div></div>
      <div class="dead" data-k="dead"><h2 data-k="deadTitle">Вы погибли</h2><div data-k="deadSub"></div><div class="spawns" data-k="spawns"></div></div>
      <div class="board" data-k="board"></div>
      <div class="pause" data-k="pause"><div class="pause-box"><h2>Пауза</h2><button data-act="resume">Продолжить</button><button data-act="settings">Настройки</button><button data-act="quit">Выйти в меню</button></div></div>
      <div class="end" data-k="end"><div class="end-box"><h1 data-k="endTitle"></h1><div data-k="endStats"></div><button data-act="restart">Играть снова</button><button data-act="quit">В меню</button></div></div>
    `;
    parent.appendChild(r);
    this.root = r;
    r.querySelectorAll<HTMLElement>('[data-k]').forEach((n) => (this.el[n.dataset.k!] = n));
    r.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'resume') this.onResume?.();
        if (a === 'quit') this.onQuit?.();
        if (a === 'restart') this.onRestart?.();
        if (a === 'settings') this.onSettings?.();
      });
    });
    this.minimap = (this.el.mm as HTMLCanvasElement).getContext('2d')!;
    // compass strip
    const marks: string[] = [];
    const names: Record<number, string> = { 0: 'С', 45: 'СВ', 90: 'В', 135: 'ЮВ', 180: 'Ю', 225: 'ЮЗ', 270: 'З', 315: 'СЗ' };
    for (let k = -1; k <= 1; k++) for (let d = 0; d < 360; d += 15) marks.push(`<span style="left:${(k * 360 + d) * 4}px">${names[d] ?? (d % 45 ? '·' : d)}</span>`);
    this.el.compass.innerHTML = marks.join('');
    this.setMode('infantry');
  }

  setMinimapSource(c: HTMLCanvasElement): void {
    this.mmBg = c;
  }

  onModeChange?: (m: HudMode) => void;

  setMode(m: HudMode): void {
    this.mode = m;
    this.onModeChange?.(m);
    const show = (k: string, v: boolean) => (this.el[k].style.display = v ? '' : 'none');
    show('cross', m === 'infantry');
    show('ammoBox', m === 'infantry');
    show('tank', m === 'tank');
    show('drone', m === 'drone');
    show('emp', m === 'emplacement');
    show('dead', m === 'dead');
    this.root.classList.toggle('mode-drone', m === 'drone');
    if (m === 'dead') this.el.spawns.innerHTML = '';
    this.ctx.postfx.uScope.value = 0;
  }

  message(text: string, kind: 'good' | 'bad' | '' = ''): void {
    this.el.msg.textContent = text;
    this.el.msg.className = `msg show ${kind}`;
    this.msgTimer = 3.5;
  }

  hitMarker(kill: boolean, head: boolean, text?: string): void {
    this.el.hit.className = `hitmark show${kill ? ' kill' : ''}${head ? ' head' : ''}`;
    this.hitTimer = kill ? 0.45 : 0.18;
    this.ctx.audio.ui(kill ? 'kill' : 'hit');
    if (text) { this.el.hitText.textContent = text; this.el.hitText.classList.add('show'); setTimeout(() => this.el.hitText.classList.remove('show'), 1500); }
  }

  vehicleHit(zone: string): void {
    this.message(`Попадание: ${zone}`, 'bad');
  }

  damageFrom(p: THREE.Vector3): void {
    const n = document.createElement('div');
    n.className = 'dmg-arrow';
    this.el.dmgRing.appendChild(n);
    this.dmgArrows.push({ node: n, t: 1.4, at: p.clone() });
  }

  killFeed(killer: string, victim: string, weapon: string, kt: Team | null, vt: Team): void {
    const n = document.createElement('div');
    n.className = 'kf';
    const k = killer ? `<b style="color:${kt ? TEAM_COLOR[kt] : '#ddd'}">${esc(killer)}</b>` : '';
    n.innerHTML = `${k} <span class="kw">[${esc(weapon)}]</span> <b style="color:${TEAM_COLOR[vt]}">${esc(victim)}</b>`;
    this.el.feed.prepend(n);
    this.feed.push({ node: n, t: 6 });
    if (this.feed.length > 6) { const o = this.feed.shift()!; o.node.remove(); }
  }

  showPause(on: boolean): void {
    this.paused = on;
    this.el.pause.style.display = on ? 'flex' : 'none';
  }

  showEnd(winner: Team): void {
    const mine = this.ctx.settings.playerTeam;
    const p = this.ctx.player.soldier;
    this.el.endTitle.textContent = winner === mine ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
    this.el.endTitle.style.color = winner === mine ? '#9fd36f' : '#e0604f';
    this.el.endStats.innerHTML = `<p>${TEAM_NAME[winner]} удержала «Малую Токмачку».</p><p>Уничтожено: <b>${p.kills}</b> · Гибелей: <b>${p.deaths}</b></p>`;
    this.el.end.style.display = 'flex';
  }

  private updateDeploy(): void {
    const ctx = this.ctx;
    const pl = ctx.player;
    const left = Math.max(0, 4 - (ctx.time - pl.soldier.deathTime));
    const killer = pl.soldier.lastAttacker;
    this.el.deadSub.textContent = killer && killer !== pl.soldier ? `Вас уничтожил: ${killer.name}` : '';
    const opts = ctx.conquest.spawnOptions(ctx.settings.playerTeam);
    const sig = opts.map((o) => o.id).join() + (left > 0 ? Math.ceil(left) : 'r');
    if (this.el.spawns.dataset.sig === sig) return;
    this.el.spawns.dataset.sig = sig;
    this.el.spawns.innerHTML = '';
    for (const o of opts) {
      const b = document.createElement('button');
      b.textContent = left > 0 ? `${o.label} (${Math.ceil(left)})` : `Высадка: ${o.label}`;
      b.disabled = left > 0;
      b.addEventListener('click', () => this.onDeploy?.(o.id));
      this.el.spawns.appendChild(b);
    }
  }

  // ───────────────────────── per frame ─────────────────────────

  update(dt: number): void {
    const ctx = this.ctx;
    const pl = ctx.player;
    const s = pl.soldier;
    const cam = ctx.camera;
    this.msgTimer -= dt;
    if (this.msgTimer <= 0) this.el.msg.classList.remove('show');
    this.hitTimer -= dt;
    if (this.hitTimer <= 0) this.el.hit.className = 'hitmark';
    for (const f of this.feed) { f.t -= dt; f.node.style.opacity = String(Math.min(1, f.t)); }
    const camYaw = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ').y;
    for (let i = this.dmgArrows.length - 1; i >= 0; i--) {
      const a = this.dmgArrows[i];
      a.t -= dt;
      if (a.t <= 0) { a.node.remove(); this.dmgArrows.splice(i, 1); continue; }
      const to = a.at.clone().sub(cam.position);
      const ang = Math.atan2(-to.x, -to.z) - camYaw;
      a.node.style.transform = `rotate(${-ang}rad)`;
      a.node.style.opacity = String(Math.min(1, a.t));
    }

    // compass (bearing: 0 = north = −Z)
    const bearing = ((-camYaw * 180) / Math.PI + 360) % 360;
    this.el.compass.style.transform = `translateX(${-(bearing * 4 + 1440) + 0}px)`;

    // crosshair spread
    if (this.mode === 'infantry') {
      const moving = Math.hypot(s.velocity.x, s.velocity.z);
      const spread = 10 + moving * 3 + (s.weapon.cooldown > 0 ? 6 : 0) + pl.suppression * 12;
      this.el.cross.style.setProperty('--spread', `${spread}px`);
      this.el.cross.style.opacity = pl.ads > 0.5 || s.sprinting ? '0' : '1';
      this.ctx.postfx.uScope.value = pl.optic && pl.ads > 0.8 ? 1 : 0;
    }
    if (this.mode === 'tank' && pl.vehicle) this.updateTank(pl.vehicle);
    if (this.mode === 'drone' && pl.drone) this.updateDrone();
    if (this.mode === 'emplacement' && pl.emplacement) this.updateEmplacement();
    if (this.mode === 'dead') this.updateDeploy();

    const threat = ctx.drones.threats().some((d) => d.targetsPlayer && d.pos.distanceTo(pl.focus()) < 160);
    this.el.threat.classList.toggle('show', threat);
    if (threat && Math.random() < dt * 0.7) ctx.audio.ui('warn');

    this.textTimer -= dt;
    if (this.textTimer > 0) return;
    this.textTimer = 0.1;
    // tickets & points
    const c = ctx.conquest;
    this.el.tA.textContent = String(c.tickets.A);
    this.el.tB.textContent = String(c.tickets.B);
    this.el.pts.innerHTML = c.points.map((p) => {
      const col = p.owner ? TEAM_COLOR[p.owner] : '#bbb';
      const prog = Math.abs(p.progress);
      const fill = p.progress >= 0 ? TEAM_COLOR.A : TEAM_COLOR.B;
      return `<span class="pt${p.contested ? ' contested' : ''}" style="--c:${col};--f:${fill};--p:${prog * 360}deg">${p.id}</span>`;
    }).join('');
    // health / ammo
    (this.el.hp as HTMLElement).style.width = `${Math.max(0, s.hp)}%`;
    this.el.hp.style.background = s.hp > 50 ? '#cfd8c4' : s.hp > 25 ? '#e0b048' : '#e0604f';
    this.el.stance.textContent = ({ stand: 'СТОЯ', crouch: 'СИДЯ', prone: 'ЛЁЖА' } as const)[s.stance] + (s.lean ? (s.lean > 0 ? ' · НАКЛОН ▶' : ' · ◀ НАКЛОН') : '');
    if (this.mode === 'infantry') {
      const w = s.weapon;
      if (pl.slot === 'rifle') {
        this.el.wname.textContent = `${w.id === 'rifle_ar' ? 'AR-15 (5,56)' : 'АК-74М (5,45)'}${pl.optic ? ' · 4×' : ' · коллиматор'}`;
        this.el.mag.textContent = w.reloading > 0 ? '…' : String(w.mag);
        this.el.res.textContent = `/ ${w.reserve}`;
      } else if (pl.slot === 'grenade') {
        this.el.wname.textContent = 'Граната РГН (ударная)';
        this.el.mag.textContent = String(pl.grenades);
        this.el.res.textContent = '';
      } else {
        this.el.wname.textContent = 'Антидроновое ружьё (РЭБ)';
        this.el.mag.textContent = pl.ewActive ? 'ПОДАВЛЕНИЕ' : 'ГОТОВ';
        this.el.res.textContent = '';
      }
      this.el.inv.textContent = `[1] винтовка  [2] гранаты ×${pl.grenades}  [3] РЭБ  [G] FPV ×${ctx.drones.playerDrones}`;
    }
    this.el.prompt.textContent = this.mode === 'infantry' && pl.interactTarget ? `${ctx.settings.touch ? '' : '[F] '}${pl.interactTarget.label}` : this.mode === 'tank' ? (ctx.settings.touch ? '' : '[F] выйти · [V] вид · [T] тепловизор · [L] дальномер · [B] снаряд · [X] дым') : this.mode === 'drone' ? (ctx.settings.touch ? '' : 'Space/Shift газ · W/S тангаж · Q/E крен · A/D рыскание · [B] сброс · [M] режим · [T] ИК · [G] подрыв') : this.mode === 'emplacement' ? (ctx.settings.touch ? '' : '[F] покинуть · ЛКМ огонь') : '';
    this.drawMinimap(camYaw);
    if (ctx.input.frame.held.has('scoreboard')) this.drawBoard(); else this.el.board.style.display = 'none';
  }

  private updateTank(v: NonNullable<GameContext['player']['vehicle']>): void {
    const gunner = v.view === 'gunner';
    this.el.tankRet.style.display = gunner ? '' : 'none';
    this.el.tankThird.style.display = gunner ? 'none' : '';
    this.ctx.postfx.uScope.value = 0;
    this.ctx.postfx.uSightNoise.value = gunner && v.opticsDamaged ? 0.55 : 0;
    // third-person reticle at the predicted gun line
    if (!gunner) {
      const p = v.muzzlePos().addScaledVector(v.gunDir(), 300).project(this.ctx.camera);
      (this.el.tankThird.firstElementChild as HTMLElement).style.transform = `translate(${p.x * 50}vw, ${-p.y * 50}vh)`;
    }
    const gun = v.gun;
    this.el.tName.textContent = `${v.name} · ${v.view === 'third' ? 'внешний вид' : v.view === 'gunner' ? `прицел ${v.zooms[v.zoomIndex]}×` : 'мехвод'}${v.thermal ? ' · ТПВ' : ''}`;
    this.el.tAmmo.textContent = `${gun.label}: ${v.ammo[v.gunIndex]}${v.stats.guns.length > 1 ? `  ·  ${v.stats.guns[(v.gunIndex + 1) % v.stats.guns.length].label}: ${v.ammo[(v.gunIndex + 1) % v.ammo.length]}` : ''}`;
    const total = gun.interval ?? v.stats.reload;
    (this.el.tReload as HTMLElement).style.width = `${(1 - v.reloadLeft / total) * 100}%`;
    this.el.tRange.textContent = `Дальность: ${v.lasedRange ? `${v.lasedRange} м` : '—'}  ·  Дым: ${v.smokeLeft}`;
    this.el.tSpeed.textContent = `${Math.round(Math.abs(v.speed) * 3.6)} км/ч  ·  Броня ${Math.max(0, Math.round((v.hp / v.stats.hp) * 100))}%`;
    const st: string[] = [];
    if (v.tracksBroken > 0) st.push(`гусеница ${Math.ceil(v.tracksBroken)}с`);
    if (v.turretJam > 0) st.push(`клин башни ${Math.ceil(v.turretJam)}с`);
    if (v.opticsDamaged) st.push('прицел повреждён');
    this.el.tState.textContent = st.length ? `⚠ ${st.join(' · ')}` : '';
    this.el.tState.style.color = '#e0604f';
    // turret vs hull indicator (relative to camera)
    const camYaw = new THREE.Euler().setFromQuaternion(this.ctx.camera.quaternion, 'YXZ').y;
    this.el.hullG.setAttribute('transform', `rotate(${(-(v.heading - camYaw) * 180) / Math.PI})`);
    this.el.turG.setAttribute('transform', `rotate(${(-(v.heading + v.turretYaw - camYaw) * 180) / Math.PI})`);
    // range ticks of the ballistic reticle
    if (gunner && !this.el.ticks.childElementCount) {
      this.el.ticks.innerHTML = [4, 8, 12, 16, 20].map((m, i) => `<path d="M-3 ${10 + i * 6} H3" stroke="currentColor" stroke-width="0.8"/><text x="6" y="${12 + i * 6}" font-size="4" fill="currentColor">${m}</text>`).join('');
    }
  }

  private updateDrone(): void {
    const d = this.ctx.player.drone!;
    const agl = d.pos.y - this.ctx.terrain.heightAt(d.pos.x, d.pos.z);
    const home = this.ctx.player.soldier.position.distanceTo(d.pos);
    const lq = Math.max(0, Math.round((1 - d.noise) * 100));
    this.el.oTL.innerHTML = `${d.mode === 'stab' ? 'STAB' : 'ACRO'}<br>${d.armed ? '<span class="armed">ARMED</span>' : 'DISARMED'}${d.thermal ? '<br>IR' : ''}`;
    this.el.oTR.innerHTML = `LQ ${lq}%<br>RSSI ${Math.round(-40 - d.noise * 60)}dBm`;
    this.el.oBL.innerHTML = `ALT ${agl.toFixed(1)}m<br>SPD ${Math.round(d.vel.length() * 3.6)}km/h`;
    this.el.oBR.innerHTML = `BAT ${Math.max(0, Math.round((d.battery / 240) * 100))}%  ${(14.8 + (d.battery / 240) * 10).toFixed(1)}V<br>HOME ${Math.round(home)}m`;
    this.el.lost.style.display = d.signalLost > 0 || d.battery <= 0 ? '' : 'none';
    const e = new THREE.Euler().setFromQuaternion(d.quat, 'YXZ');
    this.el.horizon.style.transform = `translate(-50%, ${e.x * 120}px) rotate(${-e.z}rad)`;
  }

  private updateEmplacement(): void {
    const e = this.ctx.player.emplacement!;
    this.ctx.postfx.uScope.value = e.kind === 'atgm_launcher' ? 1 : 0;
    this.el.emp.classList.toggle('atgm', e.kind === 'atgm_launcher');
    this.el.empInfo.innerHTML = e.kind === 'atgm_launcher'
      ? `ПТУР · ракет: ${e.ammo}${e.reload > 0 ? ` · перезарядка ${e.reload.toFixed(1)}с` : ''}<br>Ведите ракету перекрестием до попадания${e.thermal ? '<br>ТПВ' : ''}`
      : `Миномёт 82 мм · мин: ${e.ammo}<br>Дальность: <b>${Math.round(e.range)} м</b> (мышь/свайп ↕) · азимут ${Math.round(((-(e.yaw) * 180) / Math.PI + 360) % 360)}°${e.reload > 0 ? ` · ${e.reload.toFixed(1)}с` : ''}`;
  }

  private drawMinimap(camYaw: number): void {
    const g = this.minimap;
    const W = 180, scale = 0.6; // px per metre
    const ctx = this.ctx;
    const pp = ctx.player.vehicle ? ctx.player.vehicle.position : ctx.player.drone ? ctx.player.drone.pos : ctx.player.soldier.position;
    g.save();
    g.clearRect(0, 0, W, W);
    g.beginPath();
    g.arc(W / 2, W / 2, W / 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#2b2f24';
    g.fillRect(0, 0, W, W);
    g.translate(W / 2, W / 2);
    g.rotate(camYaw);
    if (this.mmBg) {
      const px = (MAP_SIZE / this.mmBg.width);
      g.drawImage(this.mmBg, (-HALF - pp.x) * scale, (-HALF - pp.z) * scale, this.mmBg.width * px * scale, this.mmBg.height * px * scale);
    }
    const toMap = (x: number, z: number): [number, number] => [(x - pp.x) * scale, (z - pp.z) * scale];
    for (const p of ctx.conquest.points) {
      const [x, y] = toMap(p.x, p.z);
      g.strokeStyle = p.owner ? TEAM_COLOR[p.owner] : '#ccc';
      g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, p.radius * scale, 0, Math.PI * 2); g.stroke();
      g.save(); g.translate(x, y); g.rotate(-camYaw);
      g.fillStyle = g.strokeStyle; g.font = 'bold 11px sans-serif'; g.textAlign = 'center'; g.fillText(p.id, 0, 4);
      g.restore();
    }
    const mine = ctx.settings.playerTeam;
    for (const s of ctx.soldiers) {
      if (!s.alive || s.isPlayer || s.vehicle) continue;
      const enemySpotted = s.team !== mine && ctx.time - s.lastShotTime() < 2.5;
      if (s.team !== mine && !enemySpotted) continue;
      const [x, y] = toMap(s.position.x, s.position.z);
      g.fillStyle = s.team === mine ? '#7fb8e8' : '#e0604f';
      g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
    }
    for (const v of ctx.vehicles) {
      if (!v.alive) continue;
      const [x, y] = toMap(v.position.x, v.position.z);
      g.save(); g.translate(x, y); g.rotate(-v.heading);
      g.fillStyle = v.crewTeam === mine ? '#7fb8e8' : '#e0604f';
      g.fillRect(-3, -5, 6, 10);
      g.restore();
    }
    for (const d of ctx.drones.list) {
      if (!d.alive) continue;
      const [x, y] = toMap(d.pos.x, d.pos.z);
      g.fillStyle = d.team === mine ? '#7fb8e8' : '#ff3b30';
      g.fillRect(x - 2, y - 2, 4, 4);
    }
    g.restore();
    // player arrow (map rotates, arrow points up)
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(W / 2, W / 2 - 7); g.lineTo(W / 2 - 5, W / 2 + 5); g.lineTo(W / 2 + 5, W / 2 + 5); g.closePath(); g.fill();
  }

  private drawBoard(): void {
    const ctx = this.ctx;
    const row = (t: Team) => ctx.soldiers.filter((s) => s.team === t).sort((a, b) => b.kills - a.kills)
      .map((s) => `<tr class="${s.isPlayer ? 'me' : ''}"><td>${esc(s.name)}</td><td>${s.kills}</td><td>${s.deaths}</td><td>${s.alive ? '' : '✝'}</td></tr>`).join('');
    this.el.board.innerHTML = (['A', 'B'] as Team[]).map((t) => `<div><h3 style="color:${TEAM_COLOR[t]}">${TEAM_NAME[t]} · ${ctx.conquest.tickets[t]}</h3><table><tr><th>Позывной</th><th>У</th><th>С</th><th></th></tr>${row(t)}</table></div>`).join('');
    this.el.board.style.display = 'flex';
  }
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
