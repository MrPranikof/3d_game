/**
 * Deterministic, tileable noise primitives for texture synthesis.
 * Everything is seeded so a given (asset, FACTORY_VERSION) always produces identical bytes,
 * which keeps the IndexedDB cache and multiplayer clients consistent.
 */

export class RNG {
  private s: number;
  constructor(seed: number | string) {
    this.s = typeof seed === 'number' ? seed >>> 0 : RNG.hash(seed);
    if (this.s === 0) this.s = 0x9e3779b9;
  }
  static hash(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  /** mulberry32 */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Tileable 2D value noise with a fixed lattice period. */
export class TileNoise {
  private readonly lattice: Float32Array;
  constructor(private readonly period: number, seed: number | string) {
    const rng = new RNG(seed);
    this.lattice = new Float32Array(period * period);
    for (let i = 0; i < this.lattice.length; i++) this.lattice[i] = rng.next();
  }
  /** u, v in [0,1) texture space; returns [0,1]. */
  sample(u: number, v: number, freq = 1): number {
    const p = this.period;
    const x = u * p * freq;
    const y = v * p * freq;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const wrap = (n: number) => ((n % p) + p) % p;
    const x0 = wrap(xi), x1 = wrap(xi + 1), y0 = wrap(yi), y1 = wrap(yi + 1);
    const l = this.lattice;
    const a = l[y0 * p + x0], b = l[y0 * p + x1], c = l[y1 * p + x0], d = l[y1 * p + x1];
    const sx = xf * xf * (3 - 2 * xf);
    const sy = yf * yf * (3 - 2 * yf);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  /** Fractal Brownian motion; integer frequencies keep it tileable. */
  fbm(u: number, v: number, octaves = 5, baseFreq = 1, gain = 0.5): number {
    let amp = 0.5, sum = 0, norm = 0, f = baseFreq;
    for (let o = 0; o < octaves; o++) {
      sum += this.sample(u, v, f) * amp;
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return sum / norm;
  }
  /** Ridged multifractal — cracks, scratches, bark grooves. */
  ridged(u: number, v: number, octaves = 4, baseFreq = 1): number {
    let amp = 0.5, sum = 0, norm = 0, f = baseFreq;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.sample(u, v, f) * 2 - 1);
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }
}

/** Tileable Worley (cellular) noise: returns distance to nearest feature point (0..~1). */
export class TileWorley {
  private readonly pts: Float32Array;
  constructor(private readonly cells: number, seed: number | string) {
    const rng = new RNG(seed);
    this.pts = new Float32Array(cells * cells * 2);
    for (let i = 0; i < this.pts.length; i++) this.pts[i] = rng.next();
  }
  sample(u: number, v: number): { f1: number; f2: number; id: number } {
    const c = this.cells;
    const x = u * c, y = v * c;
    const xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy;
        const wx = ((cx % c) + c) % c, wy = ((cy % c) + c) % c;
        const k = (wy * c + wx) * 2;
        const px = cx + this.pts[k], py = cy + this.pts[k + 1];
        const d = Math.hypot(px - x, py - y);
        if (d < f1) { f2 = f1; f1 = d; id = wy * c + wx; } else if (d < f2) f2 = d;
      }
    }
    return { f1, f2, id };
  }
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
