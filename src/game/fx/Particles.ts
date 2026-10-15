import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, texture, uv, vec3, vec4 } from 'three/tsl';

/**
 * GPU-instanced billboard particles (one draw call per blend mode): smoke, dust, fire, sparks,
 * muzzle flashes and stretched tracers. Per-instance colour/alpha live in instanced attributes
 * read by TSL; billboarding/stretching is done on the CPU into instance matrices (cheap at
 * these counts and works identically on WebGPU and WebGL2).
 */

type Kind = 'smoke' | 'dust' | 'fire' | 'spark' | 'flash' | 'tracer' | 'debris';

interface Pool {
  mesh: THREE.InstancedMesh;
  color: THREE.InstancedBufferAttribute;
  alpha: THREE.InstancedBufferAttribute;
  cap: number;
  // SoA state
  alive: Uint8Array;
  kind: Kind[];
  pos: Float32Array; vel: Float32Array;
  life: Float32Array; age: Float32Array;
  size0: Float32Array; size1: Float32Array;
  rot: Float32Array; spin: Float32Array;
  col: Float32Array; a0: Float32Array;
  drag: Float32Array; grav: Float32Array;
  len: Float32Array;
  next: number;
}

function softTexture(kind: 'smoke' | 'glow'): THREE.CanvasTexture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x + 0.5) / S - 0.5, dy = (y + 0.5) / S - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    let a: number;
    if (kind === 'glow') a = Math.max(0, 1 - r) ** 2;
    else {
      const n = 0.5 + 0.25 * Math.sin(x * 0.31 + Math.sin(y * 0.17) * 3) + 0.25 * Math.sin(y * 0.27 + Math.cos(x * 0.13) * 4);
      a = Math.max(0, 1 - r) ** 1.5 * (0.55 + 0.45 * n);
    }
    const o = (y * S + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
    img.data[o + 3] = Math.min(255, a * 255);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Particles {
  readonly group = new THREE.Group();
  private alphaPool: Pool;
  private addPool: Pool;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  /** soft smoke volumes for line-of-sight blocking (centre, radius, remaining life) */
  readonly smokeVolumes: { c: THREE.Vector3; r: number; t: number }[] = [];
  hideSmoke = false;

  constructor(capacity = 900) {
    this.group.name = 'Particles';
    this.alphaPool = this.makePool(capacity, false, softTexture('smoke'));
    this.addPool = this.makePool(Math.floor(capacity * 0.7), true, softTexture('glow'));
  }

  private makePool(cap: number, additive: boolean, map: THREE.Texture): Pool {
    const geo = new THREE.PlaneGeometry(1, 1);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    color.setUsage(THREE.DynamicDrawUsage);
    alpha.setUsage(THREE.DynamicDrawUsage);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const tex = texture(map, uv());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = instancedBufferAttribute(color) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = instancedBufferAttribute(alpha) as any;
    mat.colorNode = vec4(vec3(c), float(1));
    mat.opacityNode = tex.a.mul(a);
    if (additive) mat.blending = THREE.AdditiveBlending;
    mat.fog = !additive;
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = additive ? 11 : 10;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    return {
      mesh, color, alpha, cap, next: 0,
      alive: new Uint8Array(cap), kind: new Array(cap).fill('smoke'),
      pos: new Float32Array(cap * 3), vel: new Float32Array(cap * 3),
      life: new Float32Array(cap), age: new Float32Array(cap),
      size0: new Float32Array(cap), size1: new Float32Array(cap),
      rot: new Float32Array(cap), spin: new Float32Array(cap),
      col: new Float32Array(cap * 3), a0: new Float32Array(cap),
      drag: new Float32Array(cap), grav: new Float32Array(cap), len: new Float32Array(cap),
    };
  }

  private spawn(pool: Pool, kind: Kind, p: THREE.Vector3, v: THREE.Vector3, life: number, s0: number, s1: number, col: [number, number, number], a: number, drag: number, grav: number, len = 0): void {
    // ring buffer: oldest particle gets recycled when full
    const i = pool.next;
    pool.next = (pool.next + 1) % pool.cap;
    pool.alive[i] = 1;
    pool.kind[i] = kind;
    pool.pos.set([p.x, p.y, p.z], i * 3);
    pool.vel.set([v.x, v.y, v.z], i * 3);
    pool.life[i] = life; pool.age[i] = 0;
    pool.size0[i] = s0; pool.size1[i] = s1;
    pool.rot[i] = Math.random() * Math.PI * 2;
    pool.spin[i] = (Math.random() - 0.5) * 1.2;
    pool.col.set(col, i * 3);
    pool.a0[i] = a; pool.drag[i] = drag; pool.grav[i] = grav; pool.len[i] = len;
  }

  // ───────── emitters ─────────
  muzzleFlash(p: THREE.Vector3, dir: THREE.Vector3, big = false): void {
    const k = big ? 4 : 1;
    this.spawn(this.addPool, 'flash', p, dir.clone().multiplyScalar(2), 0.05, 0.25 * k, 0.45 * k, [3.5, 2.2, 0.9], 1, 0, 0);
    this.spawn(this.addPool, 'flash', p.clone().addScaledVector(dir, 0.15 * k), dir.clone().multiplyScalar(4), 0.04, 0.18 * k, 0.3 * k, [4, 2.6, 1.2], 1, 0, 0);
    if (big) for (let i = 0; i < 14; i++) this.spawn(this.alphaPool, 'smoke', p, rnd(3).addScaledVector(dir, 6 + Math.random() * 6), 2.5 + Math.random() * 2, 1.5, 6, [0.55, 0.52, 0.48], 0.55, 1.2, -0.3);
    else this.spawn(this.alphaPool, 'smoke', p, dir.clone().multiplyScalar(1.5).add(rnd(0.3)), 0.6, 0.08, 0.5, [0.7, 0.7, 0.7], 0.25, 2, -0.2);
  }

  tracer(from: THREE.Vector3, vel: THREE.Vector3, color: [number, number, number] = [5, 2.2, 0.8]): void {
    this.spawn(this.addPool, 'tracer', from, vel, 0.5, 0.05, 0.05, color, 1, 0, 9.81, 7);
  }

  impact(p: THREE.Vector3, n: THREE.Vector3, material: 'dirt' | 'stone' | 'metal' | 'wood'): void {
    const col: [number, number, number] = material === 'dirt' ? [0.36, 0.3, 0.22] : material === 'metal' ? [0.6, 0.6, 0.6] : [0.65, 0.6, 0.55];
    for (let i = 0; i < 3; i++) this.spawn(this.alphaPool, 'dust', p, n.clone().multiplyScalar(1 + Math.random() * 2).add(rnd(0.8)), 0.6 + Math.random() * 0.6, 0.15, 0.9, col, 0.7, 2.5, 1);
    if (material === 'metal' || material === 'stone') for (let i = 0; i < 5; i++) this.spawn(this.addPool, 'spark', p, n.clone().multiplyScalar(4).add(rnd(4)), 0.25, 0.04, 0.02, [4, 2.5, 1], 1, 0.5, 9.81, 0.3);
  }

  explosion(p: THREE.Vector3, scale = 1): void {
    for (let i = 0; i < 10 * scale + 4; i++) this.spawn(this.addPool, 'fire', p, rnd(5 * scale).add(new THREE.Vector3(0, 3 * scale, 0)), 0.35 + Math.random() * 0.35, 1 * scale, 3.5 * scale, [6, 2.8, 0.8], 1, 3, -1);
    for (let i = 0; i < 18 * scale + 6; i++) this.spawn(this.alphaPool, 'smoke', p, rnd(4 * scale).add(new THREE.Vector3(0, 2 + Math.random() * 4 * scale, 0)), 3 + Math.random() * 4, 1.2 * scale, 7 * scale, [0.2, 0.18, 0.16], 0.8, 1.2, -0.25);
    for (let i = 0; i < 14 * scale; i++) this.spawn(this.alphaPool, 'debris', p, rnd(9 * scale).add(new THREE.Vector3(0, 7 * scale, 0)), 1.2 + Math.random(), 0.25, 0.15, [0.25, 0.2, 0.15], 1, 0.3, 9.81);
    for (let i = 0; i < 16 * scale; i++) this.spawn(this.addPool, 'spark', p, rnd(16 * scale).add(new THREE.Vector3(0, 6, 0)), 0.5 + Math.random() * 0.5, 0.08, 0.05, [5, 3, 1], 1, 0.5, 9.81, 0.5);
    this.spawn(this.addPool, 'flash', p, new THREE.Vector3(), 0.12, 4 * scale, 9 * scale, [6, 4, 2], 1, 0, 0);
  }

  smokeScreen(p: THREE.Vector3, r: number, duration = 28): void {
    for (let i = 0; i < 26; i++) {
      const o = rnd(r).setY(Math.random() * r * 0.4);
      this.spawn(this.alphaPool, 'smoke', p.clone().add(o), rnd(0.6).setY(0.3), duration * (0.7 + Math.random() * 0.3), r * 0.5, r * 1.1, [0.82, 0.82, 0.8], 0.85, 0.2, -0.02);
    }
    this.smokeVolumes.push({ c: p.clone().setY(p.y + r * 0.3), r: r * 1.05, t: duration });
  }

  burning(p: THREE.Vector3): void {
    this.spawn(this.addPool, 'fire', p.clone().add(rnd(0.6)), new THREE.Vector3(0, 2, 0).add(rnd(0.5)), 0.6, 0.6, 1.4, [5, 2.2, 0.6], 0.9, 1, -1);
    this.spawn(this.alphaPool, 'smoke', p.clone().add(rnd(0.5)), new THREE.Vector3(0.6, 3, 0.2).add(rnd(0.5)), 5, 0.8, 5, [0.08, 0.08, 0.08], 0.75, 0.3, -0.1);
  }

  dust(p: THREE.Vector3, v: THREE.Vector3, size = 1.2): void {
    this.spawn(this.alphaPool, 'dust', p, v, 1.6, size * 0.5, size * 2, [0.48, 0.42, 0.32], 0.35, 1.5, -0.1);
  }

  exhaust(p: THREE.Vector3, v: THREE.Vector3): void {
    this.spawn(this.alphaPool, 'smoke', p, v, 1.4, 0.3, 1.6, [0.15, 0.15, 0.15], 0.35, 1, -0.2);
  }

  /** True if the segment a→b passes through an active smoke screen. */
  blockedBySmoke(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const ab = this.tmpV.subVectors(b, a);
    const len2 = ab.lengthSq();
    for (const s of this.smokeVolumes) {
      const t = Math.max(0, Math.min(1, s.c.clone().sub(a).dot(ab) / len2));
      const closest = a.clone().addScaledVector(ab, t);
      if (closest.distanceToSquared(s.c) < s.r * s.r) return true;
    }
    return false;
  }

  update(dt: number, camera: THREE.Camera): void {
    for (let i = this.smokeVolumes.length - 1; i >= 0; i--) if ((this.smokeVolumes[i].t -= dt) <= 0) this.smokeVolumes.splice(i, 1);
    camera.getWorldQuaternion(this.tmpQ);
    const camPos = camera.getWorldPosition(new THREE.Vector3());
    this.updatePool(this.alphaPool, dt, camPos);
    this.updatePool(this.addPool, dt, camPos);
  }

  private updatePool(pool: Pool, dt: number, camPos: THREE.Vector3): void {
    let n = 0;
    const m = this.tmpM, s = this.tmpS, p = this.tmpV;
    const qz = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < pool.cap; i++) {
      if (!pool.alive[i]) continue;
      pool.age[i] += dt;
      const t = pool.age[i] / pool.life[i];
      if (t >= 1) { pool.alive[i] = 0; continue; }
      const k = Math.max(0, 1 - pool.drag[i] * dt);
      pool.vel[i * 3] *= k; pool.vel[i * 3 + 1] = pool.vel[i * 3 + 1] * k - pool.grav[i] * dt; pool.vel[i * 3 + 2] *= k;
      pool.pos[i * 3] += pool.vel[i * 3] * dt; pool.pos[i * 3 + 1] += pool.vel[i * 3 + 1] * dt; pool.pos[i * 3 + 2] += pool.vel[i * 3 + 2] * dt;
      pool.rot[i] += pool.spin[i] * dt;
      const kind = pool.kind[i];
      if (this.hideSmoke && kind === 'smoke') continue;
      p.set(pool.pos[i * 3], pool.pos[i * 3 + 1], pool.pos[i * 3 + 2]);
      const size = pool.size0[i] + (pool.size1[i] - pool.size0[i]) * Math.sqrt(t);
      if (kind === 'tracer' || (kind === 'spark' && pool.len[i] > 0)) {
        // stretched quad along velocity, facing the camera
        const v = new THREE.Vector3(pool.vel[i * 3], pool.vel[i * 3 + 1], pool.vel[i * 3 + 2]);
        const sp = v.length();
        const dir = v.divideScalar(sp || 1);
        const toCam = camPos.clone().sub(p).normalize();
        const side = new THREE.Vector3().crossVectors(dir, toCam).normalize();
        const nrm = new THREE.Vector3().crossVectors(side, dir);
        const L = kind === 'tracer' ? Math.min(pool.len[i], sp * 0.02) : sp * 0.03;
        m.makeBasis(dir.multiplyScalar(L), side.multiplyScalar(size), nrm);
        m.setPosition(p.x - dir.x * 0.5, p.y - dir.y * 0.5, p.z - dir.z * 0.5);
      } else {
        qz.setFromAxisAngle(zAxis, pool.rot[i]);
        s.set(size, size, size);
        m.compose(p, this.tmpQ.clone().multiply(qz), s);
      }
      pool.mesh.setMatrixAt(n, m);
      const fade = kind === 'smoke' || kind === 'dust' ? Math.min(1, t * 6) * (1 - t) : 1 - t;
      pool.alpha.array[n] = pool.a0[i] * fade;
      // fire cools to dark smoke colour over its life
      const cool = kind === 'fire' ? 1 - t * 0.7 : 1;
      pool.color.array[n * 3] = pool.col[i * 3] * cool;
      pool.color.array[n * 3 + 1] = pool.col[i * 3 + 1] * cool * cool;
      pool.color.array[n * 3 + 2] = pool.col[i * 3 + 2] * cool;
      n++;
    }
    pool.mesh.count = n;
    pool.mesh.instanceMatrix.needsUpdate = true;
    pool.color.needsUpdate = true;
    pool.alpha.needsUpdate = true;
  }
}

export function rnd(s: number): THREE.Vector3 {
  return new THREE.Vector3((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s);
}
