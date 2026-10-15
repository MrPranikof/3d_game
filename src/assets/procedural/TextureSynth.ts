import * as THREE from 'three';
import { clamp01, lerp, RNG, smoothstep, TileNoise, TileWorley } from './noise';

/**
 * Procedural PBR texture synthesiser.
 *
 * Every recipe writes, per texel: albedo RGB (sRGB), alpha, height (→ tangent-space normal
 * via Sobel), roughness and metalness. Output = three textures following the glTF
 * metal/roughness convention:
 *   map            Albedo (sRGB)
 *   normalMap      Normal (OpenGL +Y)
 *   ormMap         R = 1 (no AO), G = roughness, B = metalness  (shared by roughnessMap/metalnessMap)
 */

export interface Texel {
  r: number; g: number; b: number; a: number;
  h: number; rough: number; metal: number;
}

export type Recipe = (u: number, v: number, t: Texel, ctx: RecipeCtx) => void;

export interface RecipeCtx {
  n: TileNoise;
  n2: TileNoise;
  w: TileWorley;
  rng: RNG;
  size: number;
}

export interface PBRTextureSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  ormMap: THREE.CanvasTexture;
  hasAlpha: boolean;
}

export interface RecipeDef {
  recipe: Recipe;
  normalStrength?: number;
  alpha?: boolean;
  /** Worley cell count for the recipe's cellular noise. */
  cells?: number;
  /** Lattice period of the value noise (higher = finer detail available). */
  period?: number;
}

const hex = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

export function setRGB(t: Texel, c: number | [number, number, number], mul = 1): void {
  const [r, g, b] = typeof c === 'number' ? hex(c) : c;
  t.r = r * mul; t.g = g * mul; t.b = b * mul;
}

export function mixRGB(t: Texel, c: number, k: number): void {
  const [r, g, b] = hex(c);
  t.r = lerp(t.r, r, k); t.g = lerp(t.g, g, k); t.b = lerp(t.b, b, k);
}

export { hex, smoothstep, clamp01, lerp };

function makeCanvas(size: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }
  return new OffscreenCanvas(size, size);
}

function toTexture(canvas: HTMLCanvasElement | OffscreenCanvas, srgb: boolean, name: string, alpha = false): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.name = name;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  // core glTF image formats: JPEG for opaque maps, PNG when alpha matters (foliage, nets)
  tex.userData.mimeType = alpha ? 'image/png' : 'image/jpeg';
  tex.needsUpdate = true;
  return tex;
}

export function synthesize(name: string, def: RecipeDef, size: number): PBRTextureSet {
  const seed = RNG.hash(name);
  const ctx: RecipeCtx = {
    n: new TileNoise(def.period ?? 64, seed),
    n2: new TileNoise(def.period ?? 64, seed ^ 0x5bd1e995),
    w: new TileWorley(def.cells ?? 12, seed ^ 0x1234567),
    rng: new RNG(seed),
    size,
  };
  const N = size * size;
  const albedo = new Uint8ClampedArray(N * 4);
  const orm = new Uint8ClampedArray(N * 4);
  const height = new Float32Array(N);
  const t: Texel = { r: 0, g: 0, b: 0, a: 1, h: 0, rough: 0.8, metal: 0 };
  const inv = 1 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      t.r = t.g = t.b = 0.5; t.a = 1; t.h = 0.5; t.rough = 0.8; t.metal = 0;
      def.recipe((x + 0.5) * inv, (y + 0.5) * inv, t, ctx);
      const i = y * size + x;
      const o = i * 4;
      albedo[o] = t.r * 255; albedo[o + 1] = t.g * 255; albedo[o + 2] = t.b * 255; albedo[o + 3] = t.a * 255;
      orm[o] = 255; orm[o + 1] = clamp01(t.rough) * 255; orm[o + 2] = clamp01(t.metal) * 255; orm[o + 3] = 255;
      height[i] = t.h;
    }
  }

  // Sobel height → tangent-space normal (wrapping keeps the map tileable).
  const nrm = new Uint8ClampedArray(N * 4);
  // resolution-independent bump: Sobel slope is measured in texels of a 512² reference
  const s = (def.normalStrength ?? 2.0) * Math.sqrt(size / 512);
  const H = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      let nx = -dx * s, ny = dy * s, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * size + x) * 4;
      nrm[o] = (nx * 0.5 + 0.5) * 255; nrm[o + 1] = (ny * 0.5 + 0.5) * 255; nrm[o + 2] = (nz * 0.5 + 0.5) * 255; nrm[o + 3] = 255;
    }
  }

  // roughness/metalness are low-frequency → ORM at half resolution (2×2 box filter)
  const hs = Math.max(1, size >> 1);
  const ormHalf = new Uint8ClampedArray(hs * hs * 4);
  for (let y = 0; y < hs; y++) {
    for (let x = 0; x < hs; x++) {
      const o = (y * hs + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = ((2 * y) * size + 2 * x) * 4 + c;
        ormHalf[o + c] = (orm[a] + orm[a + 4] + orm[a + size * 4] + orm[a + size * 4 + 4]) >> 2;
      }
    }
  }

  const put = (data: Uint8ClampedArray, sz: number) => {
    const c = makeCanvas(sz);
    // CPU-backed canvas: the data is uploaded once and later read back for .glb encoding
    const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
    g.putImageData(new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, sz, sz), 0, 0);
    return c;
  };

  return {
    map: toTexture(put(albedo, size), true, `${name}_albedo`, !!def.alpha),
    normalMap: toTexture(put(nrm, size), false, `${name}_normal`),
    ormMap: toTexture(put(ormHalf, hs), false, `${name}_orm`),
    hasAlpha: !!def.alpha,
  };
}
