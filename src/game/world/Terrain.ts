import * as THREE from 'three/webgpu';
import { cameraPosition, float, mix, normalMap, positionWorld, smoothstep, texture, vec2, vec3 } from 'three/tsl';
import type RAPIER from '@dimforge/rapier3d-compat';
import { TileNoise } from '../../assets/procedural/noise';
import type { MaterialLibrary } from '../../assets/procedural/MaterialLibrary';
import { G, type Physics } from '../core/Physics';
import { distToPolyline, HALF, MAP_SIZE, type MapLayout, pointInPoly } from './MapLayout';

/**
 * Heightfield terrain: procedural steppe relief + authored features (creek valley, trench
 * channels, dugout pits, shell craters, flattened village and roads), a splat-mapped PBR
 * TSL material sharing the MaterialLibrary texture set, and a Rapier heightfield collider.
 */
export class Terrain {
  readonly n: number;
  readonly step: number;
  readonly heights: Float32Array;
  mesh!: THREE.Mesh;
  collider!: RAPIER.Collider;
  splatCanvas!: HTMLCanvasElement;

  constructor(private layout: MapLayout, resolution: number) {
    this.n = resolution;
    this.step = MAP_SIZE / (resolution - 1);
    this.heights = new Float32Array(resolution * resolution);
    this.generate();
  }

  private generate(): void {
    const { n, step, layout } = this;
    // lattice periods chosen for real-world feature sizes: ~80 m rolling hills, ~10 m undulation
    const noise = new TileNoise(8, 'tokmachka-relief');
    const noise2 = new TileNoise(64, 'tokmachka-detail');
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = -HALF + ix * step, z = -HALF + iz * step;
        const u = ix / (n - 1), v = iz / (n - 1);
        const villageDist = Math.hypot(x - 10, z - 40);
        const calm = THREE.MathUtils.smoothstep(villageDist, 90, 200);
        let h = (noise.fbm(u, v, 4, 1) - 0.5) * 16 * (0.35 + 0.65 * calm) + (noise2.fbm(u, v, 2, 1) - 0.5) * 0.9;
        h += -z * 0.006; // gentle fall towards the creek
        const dc = distToPolyline(x, z, layout.creek);
        h -= 5.5 * Math.exp(-((dc / 34) ** 2));
        for (const r of layout.roads) {
          const d = distToPolyline(x, z, r.pts);
          if (d < r.width) h -= 0.15 * (1 - d / r.width);
        }
        this.heights[iz * n + ix] = h;
      }
    }
    // flatten building footprints / bases so foundations sit cleanly
    const flatten = (x: number, z: number, r: number) => {
      const target = this.heightAt(x, z);
      this.forCells(x, z, r + 6, (i, d) => {
        const k = 1 - THREE.MathUtils.smoothstep(d, r, r + 6);
        this.heights[i] = THREE.MathUtils.lerp(this.heights[i], target, k);
      });
    };
    for (const b of layout.buildings) flatten(b.x, b.z, b.id === 'hangar' ? 19 : 7);
    for (const t of ['A', 'B'] as const) flatten(layout.spawns[t][0][0], layout.spawns[t][0][1], 30);
    // trench channels
    for (const tr of layout.trenches) {
      for (let s = 0; s < tr.pts.length - 1; s++) {
        const [ax, az] = tr.pts[s], [bx, bz] = tr.pts[s + 1];
        const len = Math.hypot(bx - ax, bz - az);
        for (let d = 0; d <= len; d += this.step * 0.5) {
          const x = ax + ((bx - ax) * d) / len, z = az + ((bz - az) * d) / len;
          this.forCells(x, z, this.step * 1.6, (i, dd) => {
            const depth = 1.5 * (1 - THREE.MathUtils.smoothstep(dd, this.step * 0.6, this.step * 1.6));
            this.heights[i] = Math.min(this.heights[i], this.baseAt(i) - depth);
          });
        }
      }
    }
    for (const p of layout.props) if (p.id === 'dugout') this.forCells(p.x, p.z, 3, (i) => { this.heights[i] = this.baseAt(i) - 1.8; });
    for (const c of layout.craters) {
      this.forCells(c.x, c.z, c.r * 1.4, (i, d) => {
        const k = d / c.r;
        this.heights[i] += k < 1 ? -c.r * 0.28 * (1 - k * k) : 0.12 * c.r * (1 - (k - 1) / 0.4);
      });
    }
  }

  private baseCache = new Map<number, number>();
  /** Height before trench carving (so overlapping carve passes do not stack). */
  private baseAt(i: number): number {
    let h = this.baseCache.get(i);
    if (h === undefined) { h = this.heights[i]; this.baseCache.set(i, h); }
    return h;
  }

  private forCells(x: number, z: number, r: number, f: (index: number, dist: number) => void): void {
    const { n, step } = this;
    const i0 = Math.max(0, Math.floor((x - r + HALF) / step)), i1 = Math.min(n - 1, Math.ceil((x + r + HALF) / step));
    const j0 = Math.max(0, Math.floor((z - r + HALF) / step)), j1 = Math.min(n - 1, Math.ceil((z + r + HALF) / step));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(-HALF + i * step - x, -HALF + j * step - z);
      if (d <= r) f(j * n + i, d);
    }
  }

  heightAt(x: number, z: number): number {
    const { n, step } = this;
    const fx = THREE.MathUtils.clamp((x + HALF) / step, 0, n - 1.001);
    const fz = THREE.MathUtils.clamp((z + HALF) / step, 0, n - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h = this.heights;
    const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
    // match the triangle split used by the mesh/heightfield
    if (tx + tz <= 1) return a + (b - a) * tx + (c - a) * tz;
    return d + (c - d) * (1 - tx) + (b - d) * (1 - tz);
  }

  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = this.step;
    return out.set(this.heightAt(x - e, z) - this.heightAt(x + e, z), 2 * e, this.heightAt(x, z - e) - this.heightAt(x, z + e)).normalize();
  }

  buildMesh(mats: MaterialLibrary): THREE.Mesh {
    const { n, step } = this;
    const pos = new Float32Array(n * n * 3);
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
      const i = iz * n + ix;
      pos[i * 3] = -HALF + ix * step; pos[i * 3 + 1] = this.heights[i]; pos[i * 3 + 2] = -HALF + iz * step;
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let iz = 0; iz < n - 1; iz++) for (let ix = 0; ix < n - 1; ix++) {
      const a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b;
      idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    const uvs = new Float32Array(n * n * 2);
    for (let i = 0; i < n * n; i++) { uvs[i * 2] = pos[i * 3] / 4; uvs[i * 2 + 1] = pos[i * 3 + 2] / 4; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const splat = this.buildSplat();
    const L = (key: string) => mats.get(key);
    const tex = (key: string, tile: number, which: 'map' | 'normalMap' = 'map') => texture(L(key)[which]!, positionWorld.xz.div(tile));
    const sA = texture(splat.a, positionWorld.xz.div(MAP_SIZE).add(0.5));
    const sB = texture(splat.b, positionWorld.xz.div(MAP_SIZE).add(0.5));
    const macro = texture(L('soil').map!, positionWorld.xz.div(173)).r.mul(0.6).add(0.7);

    // two-scale grass to break visible tiling
    let col = mix(tex('grass_steppe', 9).rgb, tex('grass_steppe', 37).rgb, 0.5);
    // large patches of greener / sun-dried steppe so the field doesn't read as one flat colour
    const patch = smoothstep(0.35, 0.75, texture(L('soil').map!, positionWorld.xz.div(311)).g);
    // match the grass carpet's average tone (straw/ochre with olive patches) so the ring edge disappears
    col = mix(col.mul(vec3(0.95, 0.95, 0.72)), col.mul(vec3(1.22, 1.06, 0.72)), patch);
    col = mix(col, tex('stubble', 4).rgb, sB.r);
    col = mix(col, col.mul(vec3(0.9, 1.02, 0.85)), sB.g);
    col = mix(col, tex('plowed', 4).rgb, sA.r);
    col = mix(col, tex('road_dirt', 5).rgb, sA.g);
    col = mix(col, tex('asphalt', 4).rgb, sA.b);
    col = mix(col, tex('mud', 3).rgb, sB.b);
    col = mix(col, col.mul(0.35), sA.a.mul(0.85));
    col = col.mul(macro);
    // beyond the grass ring the field must read as the same carpet seen from afar
    const far = smoothstep(22, 60, positionWorld.xz.sub(cameraPosition.xz).length()).mul(sA.r.add(sA.g).add(sA.b).add(sB.b).oneMinus().clamp(0, 1));
    col = mix(col, mix(vec3(0.3, 0.25, 0.11), vec3(0.4, 0.32, 0.14), patch).mul(macro), far.mul(0.85));

    let nrm = tex('grass_steppe', 9, 'normalMap').rgb;
    nrm = mix(nrm, tex('plowed', 4, 'normalMap').rgb, sA.r);
    nrm = mix(nrm, tex('road_dirt', 5, 'normalMap').rgb, sA.g);
    nrm = mix(nrm, tex('asphalt', 4, 'normalMap').rgb, sA.b);

    const mat = new THREE.MeshStandardNodeMaterial({ name: 'terrain' });
    mat.colorNode = col;
    mat.normalNode = normalMap(vec3(nrm), vec2(0.45, 0.45));
    mat.roughnessNode = mix(float(0.95), float(0.8), sA.b.add(smoothstep(0.5, 1, sB.b).mul(0.6)));
    mat.metalnessNode = float(0);

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'Terrain';
    mesh.receiveShadow = true;
    this.mesh = mesh;
    return mesh;
  }

  /** Splat maps painted with Canvas2D: A = (plowed, dirt road, asphalt, scorch), B = (stubble, yard, creek mud). */
  private buildSplat(): { a: THREE.Texture; b: THREE.Texture } {
    const S = 1024;
    const L = this.layout;
    const toPx = (x: number) => ((x + HALF) / MAP_SIZE) * S;
    const layer = (draw: (g: CanvasRenderingContext2D) => void, blur = 2) => {
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, S, S);
      g.filter = `blur(${blur}px)`;
      g.fillStyle = g.strokeStyle = '#fff';
      g.lineCap = g.lineJoin = 'round';
      draw(g);
      return g.getImageData(0, 0, S, S).data;
    };
    const poly = (g: CanvasRenderingContext2D, pts: [number, number][]) => {
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(toPx(x), toPx(z)) : g.moveTo(toPx(x), toPx(z))));
      g.closePath();
      g.fill();
    };
    const line = (g: CanvasRenderingContext2D, pts: [number, number][], w: number) => {
      g.lineWidth = (w / MAP_SIZE) * S;
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(toPx(x), toPx(z)) : g.moveTo(toPx(x), toPx(z))));
      g.stroke();
    };
    const plowed = layer((g) => L.fields.filter((f) => f.kind === 'plowed' || f.kind === 'sunflower').forEach((f) => poly(g, f.pts)), 3);
    const dirt = layer((g) => {
      L.roads.filter((r) => r.kind === 'dirt').forEach((r) => line(g, r.pts, r.width));
      for (const t of L.trenches) line(g, t.pts, 5);
      for (const t of ['A', 'B'] as const) { const [x, z] = L.spawns[t][0]; g.beginPath(); g.arc(toPx(x), toPx(z), (34 / MAP_SIZE) * S, 0, 7); g.fill(); }
    }, 1.5);
    const asphalt = layer((g) => L.roads.filter((r) => r.kind === 'asphalt').forEach((r) => line(g, r.pts, r.width)), 0.8);
    const scorch = layer((g) => {
      for (const c of L.craters) { g.globalAlpha = 0.8; g.beginPath(); g.arc(toPx(c.x), toPx(c.z), (c.r * 1.6 / MAP_SIZE) * S, 0, 7); g.fill(); }
      g.globalAlpha = 0.35;
      for (const b of L.buildings) if (b.id === 'house_ruined') { g.beginPath(); g.arc(toPx(b.x), toPx(b.z), (9 / MAP_SIZE) * S, 0, 7); g.fill(); }
    }, 3);
    const stubble = layer((g) => L.fields.filter((f) => f.kind === 'stubble').forEach((f) => poly(g, f.pts)), 3);
    const yard = layer((g) => { for (const b of L.buildings) { g.beginPath(); g.arc(toPx(b.x), toPx(b.z), (16 / MAP_SIZE) * S, 0, 7); g.fill(); } }, 6);
    const creek = layer((g) => line(g, L.creek, 9), 4);

    const pack = (r: Uint8ClampedArray, gg: Uint8ClampedArray, b: Uint8ClampedArray, a?: Uint8ClampedArray) => {
      const out = new Uint8Array(S * S * 4);
      for (let i = 0; i < S * S; i++) {
        out[i * 4] = r[i * 4]; out[i * 4 + 1] = gg[i * 4]; out[i * 4 + 2] = b[i * 4]; out[i * 4 + 3] = a ? a[i * 4] : 0;
      }
      const t = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.needsUpdate = true;
      return t;
    };
    // minimap source
    const mm = document.createElement('canvas');
    mm.width = mm.height = 256;
    const mg = mm.getContext('2d')!;
    const img = mg.createImageData(256, 256);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const si = ((y * 4) * S + x * 4) * 4;
      const o = (y * 256 + x) * 4;
      const h = this.heightAt(-HALF + (x / 255) * MAP_SIZE, -HALF + (y / 255) * MAP_SIZE);
      const shade = 0.85 + h * 0.02;
      let r = 86, gg = 96, b = 52;
      if (stubble[si] > 128) { r = 140; gg = 128; b = 80; }
      if (plowed[si] > 128) { r = 72; gg = 58; b = 42; }
      if (creek[si] > 128) { r = 52; gg = 64; b = 60; }
      if (dirt[si] > 100) { r = 120; gg = 104; b = 80; }
      if (asphalt[si] > 100) { r = 70; gg = 70; b = 70; }
      img.data[o] = r * shade; img.data[o + 1] = gg * shade; img.data[o + 2] = b * shade; img.data[o + 3] = 255;
    }
    mg.putImageData(img, 0, 0);
    this.splatCanvas = mm;
    return { a: pack(plowed, dirt, asphalt, scorch), b: pack(stubble, yard, creek) };
  }

  buildCollider(physics: Physics): RAPIER.Collider {
    const { n } = this;
    // Rapier heightfield: (nrows+1)×(ncols+1) column-major matrix, rows along Z, columns along X
    const hf = new Float32Array(n * n);
    for (let ix = 0; ix < n; ix++) for (let iz = 0; iz < n; iz++) hf[ix * n + iz] = this.heights[iz * n + ix];
    const desc = physics.R.ColliderDesc.heightfield(n - 1, n - 1, hf, { x: MAP_SIZE, y: 1, z: MAP_SIZE });
    this.collider = physics.fixed(desc, { kind: 'terrain' }, G.TERRAIN);
    return this.collider;
  }

  inField(x: number, z: number): boolean {
    return this.layout.fields.some((f) => pointInPoly(x, z, f.pts));
  }
}
