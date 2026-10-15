import type { Action, Input } from '../core/Input';
import type { HudMode } from './HUD';

/**
 * Multi-touch HUD with independent tracking of every finger by its Touch.identifier.
 *  • infantry: floating move stick (push to the top edge → auto-sprint lock), look zone,
 *    FIRE that also drags the view, 1-tap ADS+FIRE combo, ADS, lean L/R, stance, jump, reload …
 *  • tank: drive stick with the turret indicator in the HUD, zoom slider, ammo, rangefinder, smoke
 *  • drone: Mode 2 dual sticks (left: throttle — non-centring — and yaw; right: pitch/roll)
 *  • layouts for 2-finger, 3-finger and 4-finger "claw"; buttons can be dragged in edit mode.
 */

type Kind = 'hold' | 'tap' | 'fireLook' | 'combo';
interface Btn { id: string; label: string; action: Action; kind: Kind; r: number; b: number; size: number }

type Layout = 'two' | 'three' | 'claw';

const INF: Record<Layout, Btn[]> = {
  two: [
    { id: 'fire', label: 'ОГОНЬ', action: 'fire', kind: 'fireLook', r: 7, b: 26, size: 84 },
    { id: 'combo', label: 'ПРЦ+ОГ', action: 'fire', kind: 'combo', r: 20, b: 40, size: 62 },
    { id: 'ads', label: 'ПРИЦ', action: 'ads', kind: 'tap', r: 7, b: 50, size: 56 },
    { id: 'jump', label: '⤒', action: 'jump', kind: 'hold', r: 4, b: 8, size: 52 },
    { id: 'crouch', label: 'СЕСТЬ', action: 'crouch', kind: 'tap', r: 14, b: 6, size: 52 },
    { id: 'prone', label: 'ЛЕЧЬ', action: 'prone', kind: 'tap', r: 24, b: 6, size: 52 },
    { id: 'reload', label: '⟳', action: 'reload', kind: 'tap', r: 19, b: 22, size: 46 },
    { id: 'leanL', label: '◀', action: 'leanL', kind: 'hold', r: 34, b: 54, size: 46 },
    { id: 'leanR', label: '▶', action: 'leanR', kind: 'hold', r: 27, b: 54, size: 46 },
    { id: 'interact', label: 'F', action: 'interact', kind: 'tap', r: 32, b: 32, size: 52 },
    { id: 'w1', label: 'ОРУЖ', action: 'weapon1', kind: 'tap', r: 4, b: 70, size: 46 },
    { id: 'drone', label: 'FPV', action: 'drone', kind: 'tap', r: 11, b: 70, size: 46 },
    { id: 'optic', label: '4×', action: 'optic', kind: 'tap', r: 18, b: 70, size: 46 },
  ],
  three: [],
  claw: [
    { id: 'fire', label: 'ОГОНЬ', action: 'fire', kind: 'fireLook', r: 3, b: 74, size: 70 },
    { id: 'ads', label: 'ПРИЦ', action: 'ads', kind: 'tap', r: 12, b: 80, size: 56 },
    { id: 'fireL', label: 'ОГОНЬ', action: 'fire', kind: 'hold', r: 88, b: 74, size: 66 },
    { id: 'combo', label: 'ПРЦ+ОГ', action: 'fire', kind: 'combo', r: 9, b: 30, size: 66 },
    { id: 'jump', label: '⤒', action: 'jump', kind: 'hold', r: 4, b: 10, size: 52 },
    { id: 'crouch', label: 'СЕСТЬ', action: 'crouch', kind: 'tap', r: 14, b: 8, size: 52 },
    { id: 'prone', label: 'ЛЕЧЬ', action: 'prone', kind: 'tap', r: 24, b: 8, size: 52 },
    { id: 'reload', label: '⟳', action: 'reload', kind: 'tap', r: 20, b: 26, size: 46 },
    { id: 'leanL', label: '◀', action: 'leanL', kind: 'hold', r: 80, b: 60, size: 46 },
    { id: 'leanR', label: '▶', action: 'leanR', kind: 'hold', r: 73, b: 60, size: 46 },
    { id: 'interact', label: 'F', action: 'interact', kind: 'tap', r: 32, b: 32, size: 52 },
    { id: 'w1', label: 'ОРУЖ', action: 'weapon1', kind: 'tap', r: 21, b: 82, size: 46 },
    { id: 'drone', label: 'FPV', action: 'drone', kind: 'tap', r: 28, b: 82, size: 46 },
    { id: 'optic', label: '4×', action: 'optic', kind: 'tap', r: 35, b: 82, size: 46 },
  ],
};
INF.three = [...INF.two, { id: 'fireL', label: 'ОГОНЬ', action: 'fire', kind: 'hold', r: 88, b: 70, size: 64 }];

const TANK: Btn[] = [
  { id: 'tfire', label: 'ОГОНЬ', action: 'fire', kind: 'fireLook', r: 7, b: 24, size: 86 },
  { id: 'view', label: 'ВИД', action: 'view', kind: 'tap', r: 6, b: 56, size: 52 },
  { id: 'ammo', label: 'СНАР', action: 'ammo', kind: 'tap', r: 15, b: 46, size: 52 },
  { id: 'lase', label: 'ДАЛЬ', action: 'lase', kind: 'tap', r: 20, b: 26, size: 52 },
  { id: 'smoke', label: 'ДЫМ', action: 'smoke', kind: 'tap', r: 15, b: 8, size: 50 },
  { id: 'thermal', label: 'ТПВ', action: 'thermal', kind: 'tap', r: 5, b: 8, size: 50 },
  { id: 'exit', label: 'ВЫЙТИ', action: 'interact', kind: 'tap', r: 4, b: 82, size: 52 },
];
const DRONE: Btn[] = [
  { id: 'dthermal', label: 'ИК', action: 'thermal', kind: 'tap', r: 4, b: 80, size: 48 },
  { id: 'drop', label: 'СБРОС', action: 'drop', kind: 'tap', r: 12, b: 80, size: 54 },
  { id: 'mode', label: 'РЕЖИМ', action: 'droneMode', kind: 'tap', r: 20, b: 80, size: 50 },
  { id: 'dexit', label: 'ПОДРЫВ', action: 'drone', kind: 'tap', r: 88, b: 80, size: 54 },
  { id: 'gUp', label: 'КАМ▲', action: 'zoomIn', kind: 'hold', r: 80, b: 80, size: 46 },
  { id: 'gDn', label: 'КАМ▼', action: 'zoomOut', kind: 'hold', r: 73, b: 80, size: 46 },
];
const EMP: Btn[] = [
  { id: 'efire', label: 'ОГОНЬ', action: 'fire', kind: 'fireLook', r: 7, b: 24, size: 86 },
  { id: 'ethermal', label: 'ТПВ', action: 'thermal', kind: 'tap', r: 6, b: 56, size: 50 },
  { id: 'eexit', label: 'ВЫЙТИ', action: 'interact', kind: 'tap', r: 4, b: 82, size: 52 },
];

interface Track {
  kind: 'stick' | 'look' | 'btn' | 'dstickL' | 'dstickR';
  x0: number; y0: number; x: number; y: number;
  btn?: Btn; el?: HTMLElement;
}

export class TouchControls {
  readonly root: HTMLElement;
  private tracks = new Map<number, Track>();
  private stickEl: HTMLElement;
  private stickKnob: HTMLElement;
  private dL: HTMLElement;
  private dR: HTMLElement;
  private sprintTag: HTMLElement;
  private zoom: HTMLInputElement;
  private mode: HudMode = 'infantry';
  private editing = false;
  private throttle = 0.5;
  layout: Layout;
  onZoom?: (level: number) => void;

  constructor(private input: Input, parent: HTMLElement, layout: Layout) {
    this.layout = layout;
    const r = document.createElement('div');
    r.id = 'touch';
    r.innerHTML = `<div class="stick" data-k="stick"><i></i></div><div class="sprint-tag">СПРИНТ</div>
      <div class="dstick left"><i></i><span>ГАЗ / РЫСК</span></div><div class="dstick right"><i></i><span>ТАНГАЖ / КРЕН</span></div>
      <input class="zoom" type="range" min="0" max="2" step="1" value="0" orient="vertical">
      <div class="btns"></div>`;
    parent.appendChild(r);
    this.root = r;
    this.stickEl = r.querySelector('.stick')!;
    this.stickKnob = this.stickEl.querySelector('i')!;
    this.dL = r.querySelector('.dstick.left')!;
    this.dR = r.querySelector('.dstick.right')!;
    this.sprintTag = r.querySelector('.sprint-tag')!;
    this.zoom = r.querySelector('.zoom')!;
    this.zoom.addEventListener('input', () => this.onZoom?.(Number(this.zoom.value)));
    this.zoom.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    const opts = { passive: false } as AddEventListenerOptions;
    r.addEventListener('touchstart', (e) => this.start(e), opts);
    r.addEventListener('touchmove', (e) => this.move(e), opts);
    r.addEventListener('touchend', (e) => this.end(e), opts);
    r.addEventListener('touchcancel', (e) => this.end(e), opts);
    input.touchActive = true;
    this.setMode('infantry');
  }

  private buttons(): Btn[] {
    switch (this.mode) {
      case 'tank': return TANK;
      case 'drone': return DRONE;
      case 'emplacement': return EMP;
      case 'dead': return [];
      default: return INF[this.layout];
    }
  }

  setMode(m: HudMode): void {
    this.mode = m;
    this.releaseAll();
    const box = this.root.querySelector('.btns')!;
    box.innerHTML = '';
    const saved = loadPositions();
    for (const b of this.buttons()) {
      const el = document.createElement('div');
      el.className = `tbtn k-${b.kind} id-${b.id}`;
      el.dataset.id = b.id;
      el.textContent = b.label;
      const pos = saved[`${this.layout}:${b.id}`] ?? { r: b.r, b: b.b };
      Object.assign(el.style, { right: `${pos.r}%`, bottom: `${pos.b}%`, width: `${b.size}px`, height: `${b.size}px` });
      box.appendChild(el);
    }
    this.root.classList.toggle('drone', m === 'drone');
    this.root.classList.toggle('tank', m === 'tank');
    this.root.style.display = m === 'dead' ? 'none' : '';
    this.zoom.style.display = m === 'tank' ? '' : 'none';
    this.throttle = 0.5;
  }

  setLayout(l: Layout): void {
    this.layout = l;
    this.setMode(this.mode);
  }

  /** Drag buttons to customise; positions persist in localStorage. */
  toggleEdit(): boolean {
    this.editing = !this.editing;
    this.root.classList.toggle('editing', this.editing);
    return this.editing;
  }

  private btnFor(id: string): Btn | undefined {
    return this.buttons().find((b) => b.id === id);
  }

  private start(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const target = (document.elementFromPoint(t.clientX, t.clientY) as HTMLElement | null)?.closest<HTMLElement>('.tbtn');
      const tr: Track = { kind: 'look', x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY };
      if (target) {
        tr.kind = 'btn';
        tr.btn = this.btnFor(target.dataset.id!);
        tr.el = target;
        target.classList.add('down');
        if (!this.editing && tr.btn) this.press(tr.btn, true);
      } else if (this.mode === 'drone') {
        tr.kind = t.clientX < innerWidth / 2 ? 'dstickL' : 'dstickR';
      } else if (t.clientX < innerWidth * 0.42 && ![...this.tracks.values()].some((x) => x.kind === 'stick')) {
        tr.kind = 'stick';
        this.cancelSprint();
        this.stickEl.style.left = `${t.clientX}px`;
        this.stickEl.style.top = `${t.clientY}px`;
        this.stickEl.classList.add('on');
      }
      this.tracks.set(t.identifier, tr);
    }
  }

  private move(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const tr = this.tracks.get(t.identifier);
      if (!tr) continue;
      const dx = t.clientX - tr.x, dy = t.clientY - tr.y;
      tr.x = t.clientX; tr.y = t.clientY;
      if (this.editing && tr.kind === 'btn' && tr.el) {
        tr.el.style.right = `${((innerWidth - t.clientX - tr.el.offsetWidth / 2) / innerWidth) * 100}%`;
        tr.el.style.bottom = `${((innerHeight - t.clientY - tr.el.offsetHeight / 2) / innerHeight) * 100}%`;
        continue;
      }
      if (tr.kind === 'look' || (tr.kind === 'btn' && tr.btn && (tr.btn.kind === 'fireLook' || tr.btn.kind === 'combo'))) {
        this.input.touchLookDX += dx;
        this.input.touchLookDY += dy;
      } else if (tr.kind === 'stick') {
        const R = 60;
        let ox = t.clientX - tr.x0, oy = t.clientY - tr.y0;
        // pulled well past the top edge → sprint lock
        if (oy < -R * 1.5) this.input.touchMove.set(0, 1);
        this.setAutoSprint(oy < -R * 1.35 ? true : oy > -R * 0.5 ? false : null);
        const l = Math.hypot(ox, oy);
        if (l > R) { ox *= R / l; oy *= R / l; }
        this.stickKnob.style.transform = `translate(${ox}px, ${oy}px)`;
        this.input.touchMove.set(ox / R, -oy / R);
      } else if (tr.kind === 'dstickL' || tr.kind === 'dstickR') {
        const R = 70;
        const ox = Math.max(-1, Math.min(1, (t.clientX - tr.x0) / R)), oy = Math.max(-1, Math.min(1, (t.clientY - tr.y0) / R));
        if (tr.kind === 'dstickL') {
          this.throttle = Math.max(0, Math.min(1, this.throttle - (dy / R) * 0.5));
          this.input.touchStick.throttle = this.throttle;
          this.input.touchStick.yaw = -ox;
          (this.dL.firstElementChild as HTMLElement).style.transform = `translate(${ox * 40}px, ${(0.5 - this.throttle) * 80}px)`;
        } else {
          this.input.touchStick.pitch = -oy;
          this.input.touchStick.roll = ox;
          (this.dR.firstElementChild as HTMLElement).style.transform = `translate(${ox * 40}px, ${oy * 40}px)`;
        }
      }
    }
  }

  private end(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const tr = this.tracks.get(t.identifier);
      if (!tr) continue;
      this.tracks.delete(t.identifier);
      if (tr.kind === 'btn' && tr.el) {
        tr.el.classList.remove('down');
        if (this.editing && tr.btn) savePosition(`${this.layout}:${tr.btn.id}`, parseFloat(tr.el.style.right), parseFloat(tr.el.style.bottom));
        else if (tr.btn) this.press(tr.btn, false);
      } else if (tr.kind === 'stick') {
        this.stickEl.classList.remove('on');
        this.stickKnob.style.transform = '';
        if (!this.autoSprint) this.input.touchMove.set(0, 0);
        else this.input.touchMove.set(0, 1);
      } else if (tr.kind === 'dstickL') {
        this.input.touchStick.yaw = 0;
        (this.dL.firstElementChild as HTMLElement).style.transform = `translate(0px, ${(0.5 - this.throttle) * 80}px)`;
      } else if (tr.kind === 'dstickR') {
        this.input.touchStick.pitch = this.input.touchStick.roll = 0;
        (this.dR.firstElementChild as HTMLElement).style.transform = '';
      }
    }
  }

  private autoSprint = false;
  private setAutoSprint(v: boolean | null): void {
    if (v === null) return;
    this.autoSprint = v;
    this.sprintTag.classList.toggle('on', v);
    this.onAutoSprint?.(v);
  }
  onAutoSprint?: (v: boolean) => void;

  /** Cancel auto-sprint when the player taps the stick zone again or stops. */
  cancelSprint(): void {
    if (this.autoSprint) { this.setAutoSprint(false); this.input.touchMove.set(0, 0); }
  }

  private press(b: Btn, down: boolean): void {
    const v = this.input;
    if (b.kind === 'tap') { if (down) v.virtualPressed.add(b.action); return; }
    if (b.kind === 'combo') {
      // 1-tap ADS+FIRE: aim and shoot while held
      if (down) { v.virtualHeld.add('ads'); v.virtualHeld.add('fire'); v.virtualPressed.add('fire'); }
      else { v.virtualHeld.delete('ads'); v.virtualHeld.delete('fire'); }
      return;
    }
    if (down) { v.virtualHeld.add(b.action); v.virtualPressed.add(b.action); } else v.virtualHeld.delete(b.action);
    if (b.action === 'fire' && down) this.cancelSprint();
  }

  private releaseAll(): void {
    this.tracks.clear();
    this.input.virtualHeld.clear();
    this.input.touchMove.set(0, 0);
    this.input.touchStick = { throttle: null, yaw: 0, pitch: 0, roll: 0 };
    this.stickEl?.classList.remove('on');
    this.setAutoSprint(false);
  }
}

function loadPositions(): Record<string, { r: number; b: number }> {
  try { return JSON.parse(localStorage.getItem('touch-layout') ?? '{}'); } catch { return {}; }
}

function savePosition(key: string, r: number, b: number): void {
  try {
    const all = loadPositions();
    all[key] = { r, b };
    localStorage.setItem('touch-layout', JSON.stringify(all));
  } catch { /* storage unavailable */ }
}
