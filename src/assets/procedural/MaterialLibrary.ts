import * as THREE from 'three';
import { type QualitySettings, TEAM_STYLE, type Team } from '../StylePreset';
import { clamp01, lerp, mixRGB, type RecipeDef, setRGB, smoothstep, synthesize } from './TextureSynth';

/**
 * Unified PBR material library — the ONLY source of materials for procedural assets.
 * One weathering language (dust, mud, chipped paint, oily metal) is shared by all recipes,
 * which is what keeps infantry, armour, drones and buildings in the same visual style.
 */

export interface MaterialDef extends RecipeDef {
  /** Metres covered by one texture repeat (box-projected UVs are baked with this). */
  tile: number;
  side?: THREE.Side;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  /** Multiplier on the packed roughness channel. */
  roughness?: number;
  metalness?: number;
  /** Keep the UVs authored by the builder instead of box projection. */
  authoredUV?: boolean;
}

// Shared weathering layer: dust in cavities, mud from below, scratches.
function weather(u: number, v: number, t: { r: number; g: number; b: number; rough: number; h: number }, n: { fbm: (u: number, v: number, o?: number, f?: number) => number; ridged: (u: number, v: number, o?: number, f?: number) => number }, amount = 1) {
  const dust = smoothstep(0.55, 0.8, n.fbm(u, v, 4, 3)) * 0.45 * amount;
  t.r = lerp(t.r, 0.55, dust); t.g = lerp(t.g, 0.5, dust); t.b = lerp(t.b, 0.4, dust);
  t.rough = lerp(t.rough, 0.95, dust);
  const scratch = smoothstep(0.86, 0.95, n.ridged(u * 1.0, v * 0.25, 3, 8)) * amount;
  t.r = lerp(t.r, 0.42, scratch * 0.6); t.g = lerp(t.g, 0.42, scratch * 0.6); t.b = lerp(t.b, 0.4, scratch * 0.6);
  t.h -= scratch * 0.15;
}

const pixelCamo = (palette: number[], thresholds: number[], pixel: number, scale: number): RecipeDef['recipe'] =>
  (u, v, t, { n, n2 }) => {
    const qu = Math.floor(u * pixel) / pixel, qv = Math.floor(v * pixel) / pixel;
    const a = n.fbm(qu, qv, 4, scale);
    const b = n2.fbm(qu + 0.37, qv + 0.11, 4, scale * 2);
    let c = palette[0];
    if (a > thresholds[0]) c = palette[1];
    if (b > thresholds[1]) c = palette[2];
    if (a < thresholds[2] && b > 0.45) c = palette[3];
    setRGB(t, c);
    // woven fabric
    const weave = 0.5 + 0.5 * Math.sin(u * 900) * Math.sin(v * 900);
    t.h = 0.5 + weave * 0.08 + n.fbm(u, v, 3, 16) * 0.1;
    t.rough = 0.88 + weave * 0.06;
    const dirt = smoothstep(0.6, 0.85, n.fbm(u, v, 3, 2)) * 0.25;
    mixRGB(t, 0x6a5d48, dirt);
  };

export const MATERIAL_DEFS: Record<string, MaterialDef> = {
  // ───── uniforms & soft gear ─────
  camo_mm14: { tile: 0.6, normalStrength: 1.2, recipe: pixelCamo([0x7d7a5c, 0x4f5a3a, 0x6b5a40, 0xa59f7a], [0.52, 0.56, 0.42], 96, 3) },
  camo_emr: { tile: 0.6, normalStrength: 1.2, recipe: pixelCamo([0x6f7a55, 0x3e4d30, 0x2f2a22, 0x8b9168], [0.5, 0.58, 0.4], 128, 3) },
  fabric_coyote: {
    tile: 0.5, normalStrength: 1.6,
    recipe: (u, v, t, { n }) => {
      setRGB(t, 0x8a7656, 0.9 + n.fbm(u, v, 4, 4) * 0.2);
      const weave = Math.abs(Math.sin(u * 700)) * Math.abs(Math.sin(v * 700));
      t.h = 0.5 + weave * 0.15; t.rough = 0.9;
      weather(u, v, t, n, 0.6);
    },
  },
  fabric_olive: {
    tile: 0.5, normalStrength: 1.6,
    recipe: (u, v, t, { n }) => {
      setRGB(t, 0x4c5236, 0.88 + n.fbm(u, v, 4, 4) * 0.24);
      const molle = (Math.floor(v * 20) % 2 === 0 && (v * 20) % 1 < 0.35) ? 1 : 0; // MOLLE webbing rows
      t.h = 0.5 + molle * 0.25 + Math.abs(Math.sin(u * 600)) * 0.06; t.rough = 0.9 - molle * 0.05;
      weather(u, v, t, n, 0.5);
    },
  },
  tape_A: { tile: 0.3, normalStrength: 0.6, recipe: (u, v, t, { n }) => { setRGB(t, TEAM_STYLE.A.tape, 0.85 + n.fbm(u, v, 3, 6) * 0.2); t.rough = 0.6; mixRGB(t, 0x6a5d48, smoothstep(0.6, 0.8, n.fbm(u, v, 3, 3)) * 0.4); } },
  tape_B: { tile: 0.3, normalStrength: 0.6, recipe: (u, v, t, { n }) => { setRGB(t, TEAM_STYLE.B.tape, 0.85 + n.fbm(u, v, 3, 6) * 0.2); t.rough = 0.6; mixRGB(t, 0x6a5d48, smoothstep(0.6, 0.8, n.fbm(u, v, 3, 3)) * 0.4); } },
  skin: {
    tile: 0.25, normalStrength: 0.5,
    recipe: (u, v, t, { n }) => { setRGB(t, 0xc49a7c, 0.85 + n.fbm(u, v, 4, 8) * 0.2); t.rough = 0.55; t.h = n.fbm(u, v, 3, 32); mixRGB(t, 0x5d4a3a, smoothstep(0.62, 0.8, n.fbm(u, v, 3, 4)) * 0.4); },
  },
  rubber_black: {
    tile: 0.4, normalStrength: 1.0,
    recipe: (u, v, t, { n }) => { setRGB(t, 0x1d1d1c, 0.9 + n.fbm(u, v, 3, 8) * 0.25); t.rough = 0.85; t.h = n.fbm(u, v, 4, 16); weather(u, v, t, n, 0.8); },
  },
  // ───── hard surfaces ─────
  polymer_black: {
    tile: 0.3, normalStrength: 0.8,
    recipe: (u, v, t, { n }) => { setRGB(t, 0x232421, 0.9 + n.fbm(u, v, 3, 12) * 0.2); t.rough = 0.6 + n.fbm(u, v, 3, 30) * 0.2; t.h = n.fbm(u, v, 3, 60) * 0.3; weather(u, v, t, n, 0.5); },
  },
  polymer_tan: {
    tile: 0.3, normalStrength: 0.8,
    recipe: (u, v, t, { n }) => { setRGB(t, 0x9c8664, 0.9 + n.fbm(u, v, 3, 12) * 0.2); t.rough = 0.65; t.h = n.fbm(u, v, 3, 60) * 0.3; weather(u, v, t, n, 0.6); },
  },
  gunmetal: {
    tile: 0.4, normalStrength: 0.6,
    recipe: (u, v, t, { n }) => {
      setRGB(t, 0x2c2d2e, 0.85 + n.fbm(u, v, 3, 8) * 0.3);
      t.metal = 0.85; t.rough = 0.38 + n.fbm(u, v, 4, 6) * 0.25;
      const wear = smoothstep(0.75, 0.9, n.ridged(u, v, 3, 6));
      mixRGB(t, 0x8d8f91, wear * 0.6); t.rough -= wear * 0.15; t.h = 0.5 - wear * 0.1;
    },
  },
  steel_bare: {
    tile: 1.0,
    recipe: (u, v, t, { n }) => { setRGB(t, 0x6e7072, 0.8 + n.fbm(u, v, 4, 4) * 0.3); t.metal = 1; t.rough = 0.35 + n.fbm(u, v, 4, 10) * 0.3; t.h = n.fbm(u, v, 3, 20) * 0.2; },
  },
  rust: {
    tile: 1.5, normalStrength: 1.4,
    recipe: (u, v, t, { n, n2 }) => {
      const r = n.fbm(u, v, 5, 3);
      setRGB(t, 0x4a2c1c, 0.65 + r * 0.55);
      const steel = smoothstep(0.62, 0.7, n2.fbm(u, v, 4, 4));
      mixRGB(t, 0x5a5c5e, steel); t.metal = steel * 0.8; t.rough = lerp(0.95, 0.5, steel);
      t.h = r * 0.6 + n.fbm(u, v, 3, 30) * 0.4;
    },
  },
  corrugated_rust: {
    tile: 2.0, normalStrength: 4,
    recipe: (u, v, t, { n, n2 }) => {
      const wave = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 14);
      const r = n.fbm(u, v, 5, 2);
      setRGB(t, 0x7f8486, 0.8 + r * 0.3);
      const rust = smoothstep(0.45, 0.65, n2.fbm(u, v * 0.5, 5, 2) + (1 - v) * 0.15);
      mixRGB(t, 0x6a3418, rust); t.metal = lerp(0.85, 0.1, rust); t.rough = lerp(0.45, 0.92, rust);
      t.h = wave * 0.8 + r * 0.2;
    },
  },
  // ───── armour paint ─────
  paint_ru_green: {
    tile: 3.0, normalStrength: 1.6,
    recipe: (u, v, t, { n, n2 }) => {
      setRGB(t, 0x4a5130, 0.85 + n.fbm(u, v, 5, 2) * 0.3);
      t.rough = 0.72; t.h = 0.5 + n.fbm(u, v, 4, 24) * 0.1;
      const chip = smoothstep(0.78, 0.84, n2.ridged(u, v, 4, 6));
      mixRGB(t, 0x3a3631, chip * 0.8); t.metal = chip * 0.5; t.h -= chip * 0.2;
      const streak = smoothstep(0.6, 0.9, n.fbm(u * 6, v * 0.4, 3, 2)) * 0.3; // rain streaks
      mixRGB(t, 0x2d2a22, streak);
      weather(u, v, t, n, 1);
    },
  },
  paint_nato3: {
    tile: 6.0, normalStrength: 1.6, period: 32,
    recipe: (u, v, t, { n, n2 }) => {
      const a = n.fbm(u, v, 2, 2), b = n2.fbm(u + 0.3, v + 0.7, 2, 2); // large soft-edged NATO blotches
      let c = 0x3e4a2c; // green
      if (a > 0.56) c = 0x4d3c2c; // brown
      if (b > 0.6) c = 0x1f1f1d; // black
      setRGB(t, c, 0.9 + n.fbm(u, v, 4, 16) * 0.2);
      t.rough = 0.7; t.h = 0.5 + n.fbm(u, v, 4, 40) * 0.08;
      const chip = smoothstep(0.8, 0.86, n2.ridged(u, v, 4, 10));
      mixRGB(t, 0x3a3631, chip * 0.8); t.metal = chip * 0.5;
      weather(u, v, t, n, 1);
    },
  },
  era_block: {
    tile: 0.5, normalStrength: 2.2,
    recipe: (u, v, t, { n }) => {
      setRGB(t, 0x48502f, 0.8 + n.fbm(u, v, 4, 3) * 0.35);
      const bolt = (Math.hypot(((u * 2) % 1) - 0.15, ((v * 2) % 1) - 0.15) < 0.04) ? 1 : 0;
      t.h = 0.5 + bolt * 0.4; t.rough = 0.7 - bolt * 0.2; t.metal = bolt * 0.6;
      weather(u, v, t, n, 1.2);
    },
  },
  mud: {
    tile: 1.5, normalStrength: 3,
    recipe: (u, v, t, { n }) => { const m = n.fbm(u, v, 6, 3); setRGB(t, 0x3f3324, 0.75 + m * 0.5); t.rough = lerp(0.6, 0.98, m); t.h = m; },
  },
  track_links: {
    tile: 1, authoredUV: true, normalStrength: 6, period: 32,
    // v axis = along the track, 4 links per texture repeat; u axis = across the track
    recipe: (u, v, t, { n }) => {
      const lv = (v * 4) % 1;
      const pad = lv > 0.12 && lv < 0.88 ? 1 : 0;
      const grouser = lv > 0.42 && lv < 0.58 ? 1 : 0;
      const pin = (lv < 0.08 || lv > 0.92) ? 1 : 0;
      const guide = Math.abs(u - 0.5) < 0.06 && lv > 0.3 && lv < 0.7 ? 1 : 0;
      setRGB(t, 0x3b3a37, 0.8 + n.fbm(u, v, 4, 6) * 0.3);
      t.metal = 0.7; t.rough = 0.55;
      t.h = 0.3 + pad * 0.25 + grouser * 0.3 + guide * 0.3 - pin * 0.2;
      const polish = grouser * smoothstep(0.4, 0.7, n.fbm(u, v, 3, 8));
      mixRGB(t, 0x9a9895, polish * 0.6); t.rough -= polish * 0.25;
      const mud = smoothstep(0.45, 0.7, n.fbm(u, v * 0.5, 5, 3)) * (1 - grouser * 0.6);
      mixRGB(t, 0x3f3324, mud); t.metal *= 1 - mud; t.rough = lerp(t.rough, 0.95, mud);
    },
  },
  glass_optic: { tile: 0.2, metalness: 0.2, roughness: 0.1, recipe: (_u, _v, t) => { setRGB(t, 0x0d1a22); t.rough = 0.05; t.metal = 0.3; } },
  glass_window: { tile: 1, transparent: true, opacity: 0.35, recipe: (u, v, t, { n }) => { setRGB(t, 0x70878f); t.rough = 0.1 + n.fbm(u, v, 3, 4) * 0.4; t.metal = 0.1; } },
  interior_shell: {
    tile: 1.5, side: THREE.DoubleSide, normalStrength: 1.2,
    recipe: (u, v, t, { n }) => { setRGB(t, 0x9db3a2, 0.8 + n.fbm(u, v, 4, 4) * 0.25); t.rough = 0.65; t.h = n.fbm(u, v, 3, 20) * 0.2; mixRGB(t, 0x3a3631, smoothstep(0.65, 0.85, n.fbm(u, v, 3, 3)) * 0.5); },
  },
  emissive_red: { tile: 0.1, emissive: 0xff2010, emissiveIntensity: 4, recipe: (_u, _v, t) => { setRGB(t, 0x400000); t.rough = 0.2; } },
  emissive_screen: { tile: 0.3, emissive: 0x40ff90, emissiveIntensity: 1.6, recipe: (u, v, t, { n }) => { setRGB(t, 0x0a2a14, 0.6 + 0.4 * (Math.sin(v * 400) * 0.5 + 0.5)); t.rough = 0.2; t.h = n.fbm(u, v, 2, 4) * 0.05; } },
  // ───── drones ─────
  carbon_fiber: {
    tile: 0.12, normalStrength: 2.4,
    recipe: (u, v, t, { n }) => {
      const cu = Math.floor(u * 24), cv = Math.floor(v * 24);
      const dir = (cu + cv) % 2;
      const f = dir ? Math.sin(u * 24 * Math.PI * 2 * 6) : Math.sin(v * 24 * Math.PI * 2 * 6);
      setRGB(t, 0x18191b, 0.8 + 0.3 * (f * 0.5 + 0.5));
      t.rough = 0.32 + 0.1 * dir; t.metal = 0.1; t.h = 0.5 + f * 0.1;
      weather(u, v, t, n, 0.4);
    },
  },
  anodized_red: { tile: 0.1, recipe: (u, v, t, { n }) => { setRGB(t, 0x8a1d18, 0.85 + n.fbm(u, v, 3, 8) * 0.2); t.metal = 0.9; t.rough = 0.35; } },
  copper_coil: { tile: 0.05, recipe: (u, v, t, { n }) => { setRGB(t, 0xb06a32, 0.8 + 0.2 * Math.sin(v * 300)); t.metal = 1; t.rough = 0.3 + n.fbm(u, v, 2, 4) * 0.2; t.h = 0.5 + 0.3 * Math.sin(v * 300); } },
  battery_wrap: {
    tile: 0.15,
    recipe: (u, v, t, { n }) => { setRGB(t, v > 0.42 && v < 0.58 ? 0xd2a821 : 0x1f2224); t.rough = 0.45; t.h = n.fbm(u, v, 3, 12) * 0.1; weather(u, v, t, n, 0.4); },
  },
  plastic_grey: {
    tile: 0.2, normalStrength: 0.5,
    recipe: (u, v, t, { n }) => { setRGB(t, 0x6b6e70, 0.9 + n.fbm(u, v, 3, 8) * 0.15); t.rough = 0.5; t.h = n.fbm(u, v, 3, 40) * 0.2; weather(u, v, t, n, 0.4); },
  },
  foam_wing: {
    tile: 1.0, normalStrength: 0.8,
    recipe: (u, v, t, { n }) => { setRGB(t, 0x5c6248, 0.85 + n.fbm(u, v, 4, 4) * 0.25); t.rough = 0.8; t.h = n.fbm(u, v, 4, 20) * 0.2; weather(u, v, t, n, 0.7); },
  },
  warhead_olive: {
    tile: 0.3,
    recipe: (u, v, t, { n }) => { setRGB(t, 0x4d5432, 0.85 + n.fbm(u, v, 3, 6) * 0.25); t.metal = 0.4; t.rough = 0.55; weather(u, v, t, n, 0.6); },
  },
  // ───── buildings & terrain ─────
  plaster_brick: {
    tile: 3.0, normalStrength: 3, cells: 10,
    recipe: (u, v, t, { n, n2 }) => {
      // brick bond: 25 x 6.5 cm bricks (12 courses per 0.75 m) → per 3 m tile: 12 x 46
      const row = Math.floor(v * 46);
      const bu = u * 12 + (row % 2) * 0.5;
      const bv = (v * 46) % 1;
      const mortar = (bu % 1) < 0.04 || bv < 0.12 ? 1 : 0;
      const brickId = Math.floor(bu) * 31 + row * 17;
      const tint = ((brickId * 2654435761) >>> 0) / 4294967296;
      const brickCol = lerp(0.85, 1.1, tint);
      // whitewashed lime plaster with spalls exposing the brick
      const spall = smoothstep(0.6, 0.66, n.fbm(u, v, 5, 2) * 0.8 + n2.fbm(u, v, 3, 6) * 0.3);
      const plasterR = 0.6 + n.fbm(u, v, 4, 6) * 0.12;
      if (spall > 0.5) {
        if (mortar) { setRGB(t, 0x9b9483); t.h = 0.3; t.rough = 0.95; } else { setRGB(t, 0x8e4a33, brickCol); t.h = 0.55 + n.fbm(u, v, 3, 40) * 0.15; t.rough = 0.88; }
      } else {
        setRGB(t, [plasterR, plasterR * 0.97, plasterR * 0.9]);
        t.h = 0.8 + n.fbm(u, v, 4, 30) * 0.08; t.rough = 0.92;
      }
      const soot = smoothstep(0.62, 0.85, n2.fbm(u, v, 4, 2)) * 0.55;
      mixRGB(t, 0x1a1816, soot);
      const damp = smoothstep(0.75, 1.0, v) * smoothstep(0.4, 0.7, n.fbm(u, v, 3, 3)) * 0.35;
      mixRGB(t, 0x4a4436, damp);
    },
  },
  brick_raw: {
    tile: 3.0, normalStrength: 3,
    recipe: (u, v, t, { n }) => {
      const row = Math.floor(v * 46);
      const bu = u * 12 + (row % 2) * 0.5;
      const bv = (v * 46) % 1;
      const mortar = (bu % 1) < 0.04 || bv < 0.12;
      const tint = (((Math.floor(bu) * 31 + row * 17) * 2654435761) >>> 0) / 4294967296;
      if (mortar) { setRGB(t, 0x8d877a); t.h = 0.3; t.rough = 0.95; } else { setRGB(t, 0x8e4a33, lerp(0.8, 1.15, tint)); t.h = 0.6 + n.fbm(u, v, 3, 40) * 0.15; t.rough = 0.85; }
      mixRGB(t, 0x1a1816, smoothstep(0.6, 0.85, n.fbm(u, v, 4, 2)) * 0.5);
    },
  },
  concrete: {
    tile: 3.0, normalStrength: 2.5,
    recipe: (u, v, t, { n, n2 }) => {
      const b = n.fbm(u, v, 6, 3);
      setRGB(t, 0x8f8c84, 0.8 + b * 0.35);
      t.rough = 0.9; t.h = b * 0.6 + n2.fbm(u, v, 3, 50) * 0.3;
      const crack = smoothstep(0.92, 0.97, n2.ridged(u, v, 4, 3));
      mixRGB(t, 0x2a2826, crack); t.h -= crack * 0.4;
      mixRGB(t, 0x3d3a2c, smoothstep(0.65, 0.9, n.fbm(u, v, 3, 2)) * 0.4);
    },
  },
  slate_roof: {
    // Soviet corrugated asbestos-cement sheets ("шифер")
    tile: 2.0, normalStrength: 4,
    recipe: (u, v, t, { n, n2 }) => {
      // corrugations run down the slope (roof panels are box-projected on XZ, slope along X)
      const wave = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 12);
      const sheetEdge = (u * 2) % 1 < 0.03 ? 1 : 0;
      setRGB(t, 0x8b8b84, 0.8 + n.fbm(u, v, 4, 3) * 0.3);
      const lichen = smoothstep(0.6, 0.8, n2.fbm(u, v, 4, 4)) * 0.6;
      mixRGB(t, 0x56583a, lichen);
      mixRGB(t, 0x2a2826, sheetEdge * 0.5);
      t.rough = 0.9; t.h = wave * 0.7 - sheetEdge * 0.3 + n.fbm(u, v, 3, 30) * 0.1;
    },
  },
  wood_planks: {
    tile: 1.5, normalStrength: 2.5,
    recipe: (u, v, t, { n }) => {
      const plank = Math.floor(u * 8);
      const gap = (u * 8) % 1 < 0.04 ? 1 : 0;
      const grain = n.fbm(u * 0.3 + plank * 0.13, v * 3, 5, 4);
      setRGB(t, 0x6b5238, 0.65 + grain * 0.6 + ((plank * 37) % 7) * 0.02);
      t.h = 0.6 + grain * 0.2 - gap * 0.5; t.rough = 0.88;
      mixRGB(t, 0x2a241c, gap * 0.8 + smoothstep(0.6, 0.85, n.fbm(u, v, 3, 2)) * 0.3);
    },
  },
  logs: {
    tile: 1.2, normalStrength: 3,
    recipe: (u, v, t, { n }) => {
      const r = n.ridged(u * 4, v * 0.6, 4, 2);
      setRGB(t, 0x5a4632, 0.7 + n.fbm(u, v, 4, 4) * 0.4);
      t.h = r; t.rough = 0.92;
      mixRGB(t, 0x3a3428, smoothstep(0.5, 0.8, n.fbm(u, v, 3, 3)) * 0.5);
    },
  },
  bark: {
    tile: 1.0, normalStrength: 4, period: 32,
    recipe: (u, v, t, { n }) => {
      const groove = n.ridged(u * 3, v * 0.5, 5, 2);
      setRGB(t, 0x4e463b, 0.6 + groove * 0.6);
      t.h = groove; t.rough = 0.95;
      mixRGB(t, 0x5e6a3c, smoothstep(0.7, 0.9, n.fbm(u, v, 3, 3)) * 0.4);
    },
  },
  bark_charred: {
    tile: 1.0, normalStrength: 4, cells: 18,
    recipe: (u, v, t, { n, w }) => {
      const c = w.sample(u, v);
      const crack = smoothstep(0.0, 0.08, c.f2 - c.f1);
      setRGB(t, 0x141210, 0.6 + crack * 0.6);
      const ember = (1 - crack) * smoothstep(0.75, 0.9, n.fbm(u, v, 3, 4));
      mixRGB(t, 0x4a2a14, ember * 0.6);
      t.h = crack * 0.8; t.rough = lerp(0.98, 0.7, crack * 0.5);
    },
  },
  foliage: {
    tile: 1, authoredUV: true, alpha: true, side: THREE.DoubleSide, normalStrength: 1.5,
    // Leaf-cluster card: several elliptical leaves on a twig, alpha-tested.
    recipe: (u, v, t, { n, rng }) => {
      void rng;
      let a = 0, shade = 0;
      for (let i = 0; i < 9; i++) {
        const ang = (i / 9) * Math.PI * 2 + 0.3;
        const cx = 0.5 + Math.cos(ang) * 0.24 * (0.6 + (i % 3) * 0.2);
        const cy = 0.5 + Math.sin(ang) * 0.24 * (0.6 + ((i + 1) % 3) * 0.2);
        const dx = u - cx, dy = v - cy;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
        const d = (lx * lx) / 0.018 + (ly * ly) / 0.006;
        if (d < 1) { a = 1; shade = Math.max(shade, 1 - d); }
      }
      const center = Math.hypot(u - 0.5, v - 0.5) < 0.12 ? 1 : 0;
      if (center) { a = 1; shade = 0.6; }
      t.a = a;
      setRGB(t, 0x4a5e2a, 0.55 + shade * 0.5 + n.fbm(u, v, 3, 6) * 0.2);
      mixRGB(t, 0x7d7a3a, smoothstep(0.6, 0.85, n.fbm(u, v, 3, 2)) * 0.5); // late-summer yellowing
      t.h = shade; t.rough = 0.7;
    },
  },
  grass_tuft: {
    tile: 1, authoredUV: true, alpha: true, side: THREE.DoubleSide, normalStrength: 0.5,
    // vertical card with tapered blades, alpha-tested
    recipe: (u, v, t, { n }) => {
      let a = 0;
      for (let i = 0; i < 14; i++) {
        const x0 = ((i * 0.618) % 1) * 0.9 + 0.05;
        const lean = (((i * 0.377) % 1) - 0.5) * 0.25;
        const hgt = 0.55 + ((i * 0.731) % 1) * 0.42;
        const vy = 1 - v; // 0 at bottom
        if (vy > hgt) continue;
        const cx = x0 + lean * (vy / hgt) ** 2;
        const w = 0.025 * (1 - vy / hgt) + 0.003;
        if (Math.abs(u - cx) < w) a = 1;
      }
      t.a = a;
      setRGB(t, 0x6b7034, 0.55 + (1 - v) * 0.6 + n.fbm(u, v, 2, 4) * 0.2);
      mixRGB(t, 0xa39a5c, smoothstep(0.5, 0.8, n.fbm(u, v, 3, 2)) * 0.6);
      t.rough = 0.9; t.h = 0.5;
    },
  },
  soil: {
    tile: 2.5, normalStrength: 3,
    recipe: (u, v, t, { n, n2 }) => {
      const m = n.fbm(u, v, 6, 3);
      setRGB(t, 0x4a3b2a, 0.7 + m * 0.5); // chernozem
      const grass = smoothstep(0.55, 0.7, n2.fbm(u, v, 4, 4));
      mixRGB(t, 0x5d6234, grass * 0.6);
      const stone = smoothstep(0.82, 0.9, n2.fbm(u, v, 3, 24));
      mixRGB(t, 0x8a8478, stone * 0.7);
      t.h = m * 0.7 + stone * 0.3; t.rough = 0.95;
    },
  },
  // ───── terrain layers («Малая Токмачка» steppe) ─────
  grass_steppe: {
    tile: 6, normalStrength: 2.2, period: 64,
    recipe: (u, v, t, { n, n2 }) => {
      const blades = n.ridged(u * 2, v * 2, 4, 16);
      const patch = n2.fbm(u, v, 4, 3);
      setRGB(t, 0x56602f, 0.7 + blades * 0.45);
      mixRGB(t, 0x8a8248, smoothstep(0.45, 0.75, patch) * 0.7); // dry late-summer grass
      mixRGB(t, 0x4a3b2a, smoothstep(0.7, 0.85, n.fbm(u, v, 3, 8)) * 0.6); // bare soil
      t.h = blades * 0.7 + patch * 0.3; t.rough = 0.95;
    },
  },
  stubble: {
    tile: 4, normalStrength: 2.5,
    recipe: (u, v, t, { n }) => {
      const rows = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 18);
      const straw = n.ridged(u * 6, v, 3, 8);
      setRGB(t, 0x9c8a55, 0.75 + straw * 0.35);
      mixRGB(t, 0x5a4a32, (1 - rows) * 0.35);
      t.h = rows * 0.4 + straw * 0.4; t.rough = 0.95;
    },
  },
  plowed: {
    tile: 4, normalStrength: 4,
    recipe: (u, v, t, { n }) => {
      const furrow = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 10 + n.fbm(u, v, 2, 2) * 2);
      const clods = n.fbm(u, v, 5, 12);
      setRGB(t, 0x553a22, 0.6 + clods * 0.5 + furrow * 0.2);
      t.h = furrow * 0.6 + clods * 0.4; t.rough = 0.97;
    },
  },
  road_dirt: {
    tile: 5, normalStrength: 3,
    recipe: (u, v, t, { n, n2 }) => {
      const rut = Math.exp(-((((u * 2) % 1) - 0.3) ** 2) / 0.004) + Math.exp(-((((u * 2) % 1) - 0.7) ** 2) / 0.004);
      const m = n.fbm(u, v, 5, 4);
      setRGB(t, 0x7a6146, 0.75 + m * 0.4);
      mixRGB(t, 0x3f3324, rut * 0.5 + smoothstep(0.6, 0.8, n2.fbm(u, v, 4, 3)) * 0.4);
      t.h = m * 0.6 - rut * 0.3 + n2.fbm(u, v, 3, 30) * 0.2; t.rough = lerp(0.95, 0.6, rut * 0.5);
    },
  },
  asphalt: {
    tile: 4, normalStrength: 1.8,
    recipe: (u, v, t, { n, n2 }) => {
      const agg = n.fbm(u, v, 3, 60);
      setRGB(t, 0x3a3a38, 0.75 + agg * 0.4);
      const crack = smoothstep(0.9, 0.96, n2.ridged(u, v, 4, 3));
      mixRGB(t, 0x1a1a19, crack);
      mixRGB(t, 0x6a5d48, smoothstep(0.62, 0.85, n.fbm(u, v, 3, 2)) * 0.4); // dust/mud
      t.h = agg * 0.5 - crack * 0.4; t.rough = 0.85;
    },
  },
  sandbag: {
    tile: 0.6, normalStrength: 2.5,
    recipe: (u, v, t, { n }) => {
      const weave = Math.abs(Math.sin(u * 500)) * 0.5 + Math.abs(Math.sin(v * 500)) * 0.5;
      setRGB(t, 0x7e7457, 0.75 + n.fbm(u, v, 4, 4) * 0.35);
      mixRGB(t, 0x3f3324, smoothstep(0.5, 0.8, n.fbm(u, v, 4, 2)) * 0.5);
      t.h = weave * 0.3 + n.fbm(u, v, 4, 8) * 0.5; t.rough = 0.96;
    },
  },
  cage_net: {
    tile: 1, authoredUV: true, alpha: true, side: THREE.DoubleSide, normalStrength: 1,
    recipe: (u, v, t, { n }) => {
      const gx = Math.abs(((u * 10) % 1) - 0.5) > 0.44, gy = Math.abs(((v * 10) % 1) - 0.5) > 0.44;
      t.a = gx || gy ? 1 : 0;
      setRGB(t, 0x3c3e36, 0.8 + n.fbm(u, v, 3, 6) * 0.3); t.metal = 0.6; t.rough = 0.6; t.h = t.a;
    },
  },
};

export type MaterialKey = keyof typeof MATERIAL_DEFS & string;

export class MaterialLibrary {
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  constructor(private readonly quality: QualitySettings) {}

  def(key: string): MaterialDef {
    const d = MATERIAL_DEFS[key.split('__')[0]];
    if (!d) throw new Error(`MaterialLibrary: unknown material "${key}"`);
    return d;
  }

  get(key: string): THREE.MeshStandardMaterial {
    let m = this.cache.get(key);
    if (m) return m;
    if (key.includes('__')) {
      const [base, suffix] = key.split('__');
      return this.unique(base, suffix);
    }
    const d = this.def(key);
    const size = d.authoredUV || key.startsWith('emissive') || key.startsWith('glass') ? Math.min(this.quality.textureSize, 512) : this.quality.textureSize;
    const tex = synthesize(key, d, size);
    m = new THREE.MeshStandardMaterial({
      name: key,
      map: tex.map,
      normalMap: tex.normalMap,
      roughnessMap: tex.ormMap,
      metalnessMap: tex.ormMap,
      roughness: d.roughness ?? 1,
      metalness: d.metalness ?? 1,
      side: d.side ?? THREE.FrontSide,
      transparent: !!d.transparent,
      opacity: d.opacity ?? 1,
      alphaTest: tex.hasAlpha ? 0.5 : 0,
    });
    if (d.emissive !== undefined) {
      m.emissive = new THREE.Color(d.emissive);
      m.emissiveIntensity = d.emissiveIntensity ?? 1;
    }
    this.cache.set(key, m);
    return m;
  }

  /** Independent clone (e.g. per-track material so left/right belts scroll separately). */
  unique(key: string, suffix: string): THREE.MeshStandardMaterial {
    const id = `${key}__${suffix}`;
    let m = this.cache.get(id);
    if (m) return m;
    m = this.get(key).clone();
    m.name = id;
    this.cache.set(id, m);
    return m;
  }

  teamCamo(team: Team): string {
    return TEAM_STYLE[team].camo;
  }

  dispose(): void {
    for (const m of this.cache.values()) {
      m.map?.dispose(); m.normalMap?.dispose(); m.roughnessMap?.dispose();
      m.dispose();
    }
    this.cache.clear();
  }
}

export { clamp01 };
