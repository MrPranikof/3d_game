import * as THREE from 'three/webgpu';

/**
 * Unified input: keyboard + mouse (Pointer Lock), Gamepad API, multi-touch HUD and gyroscope
 * all feed one per-frame snapshot. Gameplay code only reads `InputFrame`.
 */

export type Action =
  | 'fire' | 'ads' | 'jump' | 'mouse' | 'crouch' | 'prone' | 'sprint' | 'reload' | 'interact' | 'leanL' | 'leanR'
  | 'weapon1' | 'weapon2' | 'weapon3' | 'drone' | 'smoke' | 'view' | 'lase' | 'ammo' | 'thermal' | 'drop'
  | 'droneMode' | 'exit' | 'zoomIn' | 'zoomOut' | 'pause' | 'scoreboard' | 'throttleUp' | 'throttleDown' | 'optic';

export type ControlMode = 'infantry' | 'tank' | 'drone' | 'emplacement' | 'dead' | 'menu';

export interface InputFrame {
  move: THREE.Vector2;
  look: THREE.Vector2;
  held: Set<Action>;
  pressed: Set<Action>;
  /** drone sticks, Mode 2: throttle 0..1 (absolute when from touch), yaw/pitch/roll −1..1 */
  stick: { throttle: number | null; throttleRate: number; yaw: number; pitch: number; roll: number };
  zoom: number;
  touch: boolean;
}

const KEYMAP: Record<string, Action[]> = {
  ShiftLeft: ['sprint', 'throttleDown'], ShiftRight: ['sprint'],
  Space: ['jump', 'throttleUp'], KeyC: ['crouch'], ControlLeft: ['crouch'], KeyZ: ['prone'],
  KeyR: ['reload'], KeyF: ['interact'], KeyQ: ['leanL'], KeyE: ['leanR'],
  Digit1: ['weapon1'], Digit2: ['weapon2'], Digit3: ['weapon3'], KeyG: ['drone'], KeyX: ['smoke'],
  KeyV: ['view'], KeyL: ['lase'], KeyB: ['ammo', 'drop'], KeyT: ['thermal'], KeyM: ['droneMode'],
  KeyH: ['optic'], AltLeft: ['mouse'], AltRight: ['mouse'], Escape: ['pause'], Tab: ['scoreboard'], Backspace: ['exit'],
};

export class Input {
  readonly frame: InputFrame = {
    move: new THREE.Vector2(), look: new THREE.Vector2(), held: new Set(), pressed: new Set(),
    stick: { throttle: null, throttleRate: 0, yaw: 0, pitch: 0, roll: 0 }, zoom: 0, touch: false,
  };
  mode: ControlMode = 'menu';
  locked = false;
  /** Pointer Lock refused (e.g. sandboxed iframe) → drag-to-look fallback */
  lockFailed = false;
  /** Alt-toggled: look follows the bare mouse when pointer lock is unavailable (sandboxed frames) */
  freeLook = false;
  /** set while we release the pointer on purpose, so the unlock doesn't open the pause menu */
  private releasing = false;
  sensitivity = { infantry: 1, tank: 0.7, drone: 1, gyroInfantry: 1, gyroTank: 0.6, gyroDrone: 0.8 };
  invertY = false;
  gyroEnabled = false;
  /** set by the drone each frame: Stabilize mode (touch throttle re-centres) */
  droneStab = true;

  private keys = new Set<string>();
  private keyPressed = new Set<Action>();
  private mouseDX = 0;
  private mouseDY = 0;
  private mouseButtons = new Set<number>();
  private wheel = 0;
  // touch HUD writes into these
  readonly virtualHeld = new Set<Action>();
  readonly virtualPressed = new Set<Action>();
  readonly touchMove = new THREE.Vector2();
  touchLookDX = 0;
  touchLookDY = 0;
  touchStick = { throttle: null as number | null, yaw: 0, pitch: 0, roll: 0 };
  touchActive = false;
  // gyro
  private gyroDX = 0;
  private gyroDY = 0;
  private prevPad = new Set<number>();

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      if (this.mode === 'menu') return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code === 'Backspace' || e.code === 'AltLeft' || e.code === 'AltRight') e.preventDefault();
      if (!this.keys.has(e.code)) for (const a of KEYMAP[e.code] ?? []) this.keyPressed.add(a);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouseButtons.clear(); });
    canvas.addEventListener('mousedown', (e) => {
      if (this.mode === 'menu' || this.touchActive) return;
      if (!this.locked && !this.lockFailed) { this.requestLock(); return; }
      this.mouseButtons.add(e.button);
      if (e.button === 0) this.keyPressed.add('fire');
      if (e.button === 2) this.keyPressed.add('ads');
    });
    addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked && !(this.lockFailed && (this.mouseButtons.size || this.freeLook))) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    addEventListener('wheel', (e) => { if (this.mode !== 'menu') this.wheel += Math.sign(e.deltaY); }, { passive: true });
    document.addEventListener('pointerlockerror', () => { this.lockFailed = true; });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked && this.mode !== 'menu' && !this.touchActive && !this.releasing) this.keyPressed.add('pause');
      this.releasing = false;
    });
  }

  requestLock(): void {
    if (this.touchActive || this.lockFailed) return;
    try {
      const r = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      r?.catch?.(() => { this.lockFailed = true; });
      if (!this.canvas.requestPointerLock) this.lockFailed = true;
    } catch { this.lockFailed = true; }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Alt: hand the cursor back to the OS / take it again (without opening the pause menu). */
  toggleMouse(): boolean {
    if (this.lockFailed) {
      this.freeLook = !this.freeLook;
      this.canvas.style.cursor = this.freeLook ? 'none' : '';
      return this.freeLook;
    }
    if (this.locked) { this.releasing = true; this.releaseLock(); return false; }
    this.requestLock();
    return true;
  }

  get captured(): boolean {
    return this.locked || this.freeLook;
  }

  /** iOS needs an explicit user gesture to grant motion sensors. */
  async enableGyro(): Promise<boolean> {
    try {
      const DM = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
      const DO = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
      if (DM.requestPermission && (await DM.requestPermission()) !== 'granted') return false;
      if (DO.requestPermission) await DO.requestPermission().catch(() => 'denied');
    } catch {
      return false;
    }
    if (!this.gyroEnabled) {
      addEventListener('devicemotion', (e) => {
        const r = e.rotationRate;
        if (!this.gyroEnabled || !r || r.alpha === null) return;
        const dt = (e.interval > 1 ? e.interval / 1000 : e.interval) || 1 / 60;
        const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
        const d2r = Math.PI / 180;
        const alpha = (r.alpha ?? 0) * d2r * dt, beta = (r.beta ?? 0) * d2r * dt, gamma = (r.gamma ?? 0) * d2r * dt;
        let yaw: number, pitch: number;
        if (angle === 90) { yaw = beta; pitch = -gamma; }
        else if (angle === 270 || angle === -90) { yaw = -beta; pitch = gamma; }
        else { yaw = gamma; pitch = beta; }
        void alpha;
        this.gyroDX += yaw;
        this.gyroDY += pitch;
      });
    }
    this.gyroEnabled = true;
    return true;
  }

  private pollGamepad(f: InputFrame): void {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = [...pads].find((p) => p && p.connected);
    if (!gp) return;
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    const lx = dz(gp.axes[0] ?? 0), ly = dz(gp.axes[1] ?? 0), rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
    const pressedNow = new Set<number>();
    gp.buttons.forEach((b, i) => { if (b.pressed) pressedNow.add(i); });
    const map: Record<number, Action> = { 0: 'jump', 1: 'crouch', 2: 'reload', 3: 'interact', 4: 'drone', 5: 'view', 6: 'ads', 7: 'fire', 9: 'pause', 8: 'scoreboard', 10: 'sprint', 11: 'prone', 12: 'thermal', 13: 'smoke', 14: 'lase', 15: 'ammo' };
    for (const [i, a] of Object.entries(map)) {
      const n = Number(i);
      if (pressedNow.has(n)) { f.held.add(a); if (!this.prevPad.has(n)) f.pressed.add(a); }
    }
    this.prevPad = pressedNow;
    if (this.mode === 'drone') {
      f.stick.throttleRate += -ly;
      f.stick.yaw += lx;
      f.stick.pitch += -ry;
      f.stick.roll += rx;
    } else {
      if (lx || ly) f.move.set(lx, -ly);
      const s = this.mode === 'tank' ? 2.2 : 3.2;
      f.look.x -= rx * s * (1 / 60);
      f.look.y -= ry * s * (1 / 60) * (this.invertY ? -1 : 1);
    }
  }

  /** Build this frame's snapshot (call once per frame before gameplay update). */
  poll(): InputFrame {
    const f = this.frame;
    f.held.clear();
    f.pressed.clear();
    f.move.set(0, 0);
    f.look.set(0, 0);
    f.stick.throttle = null;
    f.stick.throttleRate = 0;
    f.stick.yaw = f.stick.pitch = f.stick.roll = 0;
    f.zoom = this.wheel;
    f.touch = this.touchActive;
    this.wheel = 0;

    for (const code of this.keys) for (const a of KEYMAP[code] ?? []) f.held.add(a);
    for (const a of this.keyPressed) f.pressed.add(a);
    this.keyPressed.clear();
    if (this.mouseButtons.has(0)) f.held.add('fire');
    if (this.mouseButtons.has(2)) f.held.add('ads');

    const k = (c: string) => (this.keys.has(c) ? 1 : 0);
    const sens = this.mode === 'tank' || this.mode === 'emplacement' ? this.sensitivity.tank : this.mode === 'drone' ? this.sensitivity.drone : this.sensitivity.infantry;
    if (this.mode === 'drone') {
      f.stick.pitch = k('KeyW') - k('KeyS');
      f.stick.roll = k('KeyE') - k('KeyQ');
      f.stick.yaw = (k('KeyA') - k('KeyD')) + THREE.MathUtils.clamp(-this.mouseDX * 0.05, -1, 1);
      f.stick.throttleRate = k('Space') - k('ShiftLeft');
      f.stick.pitch += THREE.MathUtils.clamp(-this.mouseDY * 0.03, -1, 1) * (this.invertY ? -1 : 1);
    } else {
      f.move.set(k('KeyD') - k('KeyA'), k('KeyW') - k('KeyS'));
      f.look.set(-this.mouseDX * 0.0022 * sens, -this.mouseDY * 0.0022 * sens * (this.invertY ? -1 : 1));
    }
    this.mouseDX = this.mouseDY = 0;

    // touch HUD
    for (const a of this.virtualHeld) f.held.add(a);
    for (const a of this.virtualPressed) f.pressed.add(a);
    this.virtualPressed.clear();
    if (this.touchMove.lengthSq() > 0) f.move.copy(this.touchMove);
    f.look.x -= this.touchLookDX * 0.0045 * sens;
    f.look.y -= this.touchLookDY * 0.0045 * sens * (this.invertY ? -1 : 1);
    this.touchLookDX = this.touchLookDY = 0;
    if (this.mode === 'drone' && this.touchActive) {
      f.stick.throttle = this.touchStick.throttle;
      f.stick.yaw += this.touchStick.yaw;
      f.stick.pitch += this.touchStick.pitch;
      f.stick.roll += this.touchStick.roll;
    }

    // gyroscope (separate sensitivities per control mode)
    if (this.gyroEnabled) {
      const gs = this.mode === 'tank' || this.mode === 'emplacement' ? this.sensitivity.gyroTank : this.mode === 'drone' ? this.sensitivity.gyroDrone : this.sensitivity.gyroInfantry;
      if (this.mode === 'drone') {
        f.stick.yaw += THREE.MathUtils.clamp(this.gyroDX * 12 * gs, -1, 1);
      } else {
        f.look.x += this.gyroDX * gs;
        f.look.y += this.gyroDY * gs * (this.invertY ? -1 : 1);
      }
    }
    this.gyroDX = this.gyroDY = 0;

    this.pollGamepad(f);
    if (f.held.has('zoomIn')) f.zoom -= 0.15;
    if (f.held.has('zoomOut')) f.zoom += 0.15;
    for (const a of ['yaw', 'pitch', 'roll'] as const) f.stick[a] = THREE.MathUtils.clamp(f.stick[a], -1, 1);
    return f;
  }
}
