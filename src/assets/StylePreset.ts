/**
 * Unified style contract shared by EVERY asset in the game.
 *
 * Whatever engine produces a model (the single remote AI engine or the built-in
 * procedural generator), it must obey this contract:
 *  - 1 unit = 1 metre, +Y up, forward = -Z (glTF / three.js convention)
 *  - metal/roughness PBR: Albedo (sRGB), Normal (OpenGL, tangent space),
 *    packed ORM-style map (G = roughness, B = metallic)
 *  - one global prompt prefix, so the visual language never drifts between assets.
 */

export const GLOBAL_STYLE_PREFIX =
  'Battlefield 6 photorealistic military aesthetic, unified scale 1:1 meter, weathered PBR materials, ' +
  'realistic dirt and wear, 8k normal and roughness maps, clean game-ready topology, exported as hierarchical .glb:';

/** Bump whenever generator output changes — invalidates every IndexedDB cache entry. */
export const FACTORY_VERSION = '2.2.0';

export const UNIT_SCALE_METERS = 1;

/** Quality tiers drive texture size, curve tessellation and LOD aggressiveness. */
export type QualityTier = 'mobile' | 'desktop' | 'ultra';

export interface QualitySettings {
  textureSize: number;
  /** Radial segments for cylinders / lathes (wheels, barrels, trunks). */
  radial: number;
  /** Max meshopt-simplifier triangle ratio for LOD1..LOD3. */
  lodRatios: [number, number, number];
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  mobile: { textureSize: 512, radial: 14, lodRatios: [0.5, 0.25, 0.08] },
  desktop: { textureSize: 1024, radial: 22, lodRatios: [0.55, 0.28, 0.1] },
  ultra: { textureSize: 2048, radial: 32, lodRatios: [0.6, 0.32, 0.12] },
};

export function detectQualityTier(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1400);
  if (mobile) return 'mobile';
  if ((nav.deviceMemory ?? 8) >= 8 && navigator.hardwareConcurrency >= 8) return 'ultra';
  return 'desktop';
}

export type Team = 'A' | 'B';

/** Team identity: camouflage family + identification tape colour (no political symbols). */
export const TEAM_STYLE: Record<Team, { label: string; camo: 'camo_mm14' | 'camo_emr'; tape: number; tapeName: string }> = {
  A: { label: 'Команда А (Украина)', camo: 'camo_mm14', tape: 0xf2c200, tapeName: 'yellow' },
  B: { label: 'Команда Б (Россия)', camo: 'camo_emr', tape: 0xe8e8e8, tapeName: 'white' },
};

/** Cheap stable hash (FNV-1a) used for cache keys and deterministic seeds. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const STYLE_HASH = hashString(GLOBAL_STYLE_PREFIX + FACTORY_VERSION);
