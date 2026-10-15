import * as THREE from 'three';
import { deg, type Kit, node, PartBuilder, T } from '../Kit';
import { applyRefProjection, hasRefTexture } from '../RefTexture';

/**
 * Tracked armour: Т-72Б3, Т-80БВМ, Т-64БВ, Leopard 2A4 / 2A6, БМП-2.
 *
 * Node contract (validated by the factory):
 *   Hull ─┬─ Turret (yaw, Y) ─┬─ Cannon (pitch X, recoil along +Z) ── Muzzle
 *         │                    ├─ Smoke_Launchers, Cage, Interior_Gunner, Cam_Gunner
 *         ├─ Track_L / Track_R (belt mesh with own material for UV scroll + Wheel_*, Sprocket_*, Idler_*)
 *         └─ Interior_Cockpit (driver station, inward-facing shell) ── Cam_Driver
 * Forward = −Z, ground at y = 0.
 */

type Variant = 't72b3' | 't80bvm' | 't64bv' | 'leo2a4' | 'leo2a6' | 'bmp2';

interface Cfg {
  L: number; // hull length
  W: number; // overall width incl. skirts
  trackW: number;
  belly: number;
  deck: number;
  wheelR: number;
  wheels: number;
  rollers: number;
  sprocketFront: boolean;
  turret: 'soviet' | 'leo' | 'bmp';
  turretZ: number;
  /** exposed barrel length forward of the trunnion, m */
  gunLen: number;
  gunR: number;
  era: 'k5' | 'relikt' | 'k1' | 'none';
  cage: boolean;
  paint: string;
  skirts: 'rubber' | 'armor' | 'none';
  driverX: number;
  /** optional fit to reference drawings (tools/refs/*.json); all in vehicle space, m */
  fit?: {
    glacisLen: number;
    noseY?: number;
    wheelZ: number[]; wheelY: number;
    idler: Circle; sprocket: Circle;
    skirt: [number, number]; // bottom, top
    sideEra: { z: number[]; y: number; w: number; h: number };
    drum: { y: number; r: number };
    turretScale: [number, number, number];
    rearBin: [number, number, number, number, number, number]; // w h d x y z
    trunnion: [number, number, number];
    cage: [number, number, number, number, number]; // w d baseY topY z
    leoTurret?: { front: number; rear: number; wedgeTip: number };
  };
}

const CFG: Record<Variant, Cfg> = {
  // fitted to assets-src/refs/t72b3_side.jpg / _top.webp (207 px/m side, 104 px/m top)
  t72b3: {
    L: 6.8, W: 3.6, trackW: 0.58, belly: 0.47, deck: 1.62, wheelR: 0.37, wheels: 6, rollers: 3, sprocketFront: false, turret: 'soviet', turretZ: 0.15, gunLen: 4.52, gunR: 0.085, era: 'k5', cage: true, paint: 'paint_ru_green', skirts: 'rubber', driverX: 0,
    fit: {
      glacisLen: 0.85,
      wheelZ: [-2.21, -1.36, -0.54, 0.28, 1.1, 1.94], wheelY: 0.47,
      idler: { z: -3.01, y: 0.84, r: 0.25 }, sprocket: { z: 2.72, y: 0.85, r: 0.28 },
      skirt: [0.9, 1.5],
      sideEra: { z: [-2.3, -1.64, -0.94], y: 1.17, w: 0.6, h: 0.5 },
      drum: { y: 1.72, r: 0.33 },
      turretScale: [1.05, 1.2, 1.08],
      rearBin: [1.7, 0.62, 0.95, 0, 0.32, 0.98],
      trunnion: [0, 0.33, -1.05],
      cage: [2.4, 3.2, 0.78, 1.95, 0.5],
    },
  },
  t80bvm: { L: 7.0, W: 3.6, trackW: 0.58, belly: 0.45, deck: 1.4, wheelR: 0.335, wheels: 6, rollers: 5, sprocketFront: false, turret: 'soviet', turretZ: -0.25, gunLen: 4.9, gunR: 0.085, era: 'relikt', cage: true, paint: 'paint_ru_green', skirts: 'rubber', driverX: 0 },
  t64bv: { L: 6.54, W: 3.42, trackW: 0.54, belly: 0.45, deck: 1.38, wheelR: 0.275, wheels: 6, rollers: 4, sprocketFront: false, turret: 'soviet', turretZ: -0.15, gunLen: 4.9, gunR: 0.085, era: 'k1', cage: true, paint: 'paint_ru_green', skirts: 'rubber', driverX: 0 },
  leo2a4: { L: 7.72, W: 3.75, trackW: 0.635, belly: 0.5, deck: 1.5, wheelR: 0.35, wheels: 7, rollers: 4, sprocketFront: false, turret: 'leo', turretZ: 0.6, gunLen: 5.3, gunR: 0.09, era: 'none', cage: false, paint: 'paint_nato3', skirts: 'armor', driverX: 0.55 },
  // fitted to assets-src/refs/leo2a6_side.webp / _top.webp (98.8 px/m side, 82.8 px/m top)
  leo2a6: {
    L: 7.72, W: 3.75, trackW: 0.635, belly: 0.5, deck: 1.85, wheelR: 0.35, wheels: 7, rollers: 4, sprocketFront: false, turret: 'leo', turretZ: -0.18, gunLen: 4.3, gunR: 0.09, era: 'none', cage: false, paint: 'paint_nato3', skirts: 'armor', driverX: 0.55,
    fit: {
      glacisLen: 2.2,
      wheelZ: [-2.41, -1.57, -0.8, -0.03, 0.77, 1.58, 2.43], wheelY: 0.45,
      idler: { z: -3.28, y: 0.86, r: 0.3 }, sprocket: { z: 3.15, y: 0.86, r: 0.36 },
      skirt: [0.94, 1.48],
      sideEra: { z: [], y: 0, w: 0, h: 0 },
      drum: { y: 0, r: 0 },
      turretScale: [1, 1, 1],
      rearBin: [0, 0, 0, 0, 0, 0],
      trunnion: [0, 0.37, -1.5],
      cage: [0, 0, 0, 0, 0],
      leoTurret: { front: -1.3, rear: 3.0, wedgeTip: -2.6 },
    },
  },
  // fitted to assets-src/refs/bmp2_side.webp / _top.webp (144.6 px/m side, 133 px/m top)
  bmp2: {
    L: 6.72, W: 3.3, trackW: 0.3, belly: 0.42, deck: 1.85, wheelR: 0.3, wheels: 6, rollers: 3, sprocketFront: true, turret: 'bmp', turretZ: 0.55, gunLen: 1.76, gunR: 0.035, era: 'none', cage: false, paint: 'paint_ru_green', skirts: 'none', driverX: -0.55,
    fit: {
      glacisLen: 1.95, noseY: 1.25,
      wheelZ: [-1.45, -0.78, -0.11, 0.57, 1.27, 1.99], wheelY: 0.36,
      sprocket: { z: -2.19, y: 0.73, r: 0.27 }, idler: { z: 2.71, y: 0.78, r: 0.3 },
      skirt: [0, 0], sideEra: { z: [], y: 0, w: 0, h: 0 }, drum: { y: 0, r: 0 },
      turretScale: [1.22, 0.82, 1.2],
      rearBin: [0, 0, 0, 0, 0, 0],
      trunnion: [0, 0.34, -0.85],
      cage: [0, 0, 0, 0, 0],
    },
  },
};

export function buildTrackedVehicle(kit: Kit, variant: Variant, id: string): THREE.Group {
  const c = CFG[variant];
  const root = node(id, null);
  const hull = node('Hull', root);
  buildHull(kit, c, variant, hull);
  for (const side of ['L', 'R'] as const) buildTrack(kit, c, side, hull);
  buildDriverStation(kit, c, hull);

  const turret = node('Turret', hull, 0, c.deck, c.turretZ);
  if (c.turret === 'soviet') buildSovietTurret(kit, c, turret, variant);
  else if (c.turret === 'leo') buildLeoTurret(kit, c, turret, variant);
  else buildBmpTurret(kit, c, turret);
  if (hasRefTexture(variant)) applyRefProjection(root, variant);
  return root;
}

// ───────────────────────────── hull ─────────────────────────────

function glacisPlace(p: PartBuilder, kit: Kit, z0: number, y0: number, z1: number, y1: number, cols: number, rows: number, width: number, thick: number, mat: string, gap = 0.02) {
  const dz = z1 - z0, dy = y1 - y0;
  const len = Math.hypot(dz, dy);
  const ang = -Math.asin(dy / len);
  const nY = Math.cos(ang), nZ = Math.sin(ang);
  const bw = width / cols - gap, bl = len / rows - gap;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const t = (r + 0.5) / rows;
      const x = -width / 2 + (col + 0.5) * (width / cols);
      p.add(kit.box(bw, thick, bl, 0.01), mat, T(x, y0 + dy * t + nY * thick * 0.5, z0 + dz * t + nZ * thick * 0.5, ang));
    }
  }
}

function buildHull(kit: Kit, c: Cfg, variant: Variant, hull: THREE.Group): void {
  const p = new PartBuilder(kit);
  const h = c.L / 2;
  const inner = c.W - c.trackW * 2 - 0.08;
  const yB = c.belly, yD = c.deck;
  const isBmp = variant === 'bmp2';
  const isLeo = c.turret === 'leo';
  const glacisLen = c.fit?.glacisLen ?? (isBmp ? 2.1 : isLeo ? 1.9 : 1.55);
  const noseY = c.fit?.noseY ?? (isBmp ? yB + 0.5 : yB + 0.55);

  // lower hull (between tracks)
  p.add(kit.profileX([[h, yB + 0.12], [h, yD - 0.06], [h - 0.08, yD], [-h + glacisLen, yD], [-h, noseY], [-h + 0.55, yB], [h - 0.3, yB]], inner, 0.03), c.paint);
  // sponsons over the tracks
  p.add(kit.profileX([[h - 0.02, yD - 0.38], [h - 0.02, yD - 0.02], [-h + glacisLen + 0.02, yD - 0.02], [-h + 0.55, yD - 0.38]], c.W - 0.1, 0.02), c.paint);
  // fenders (front mudguards + rear)
  for (const sx of [-1, 1]) {
    p.add(kit.box(c.trackW + 0.04, 0.03, 0.65), c.paint, T(sx * (c.W / 2 - c.trackW / 2 - 0.03), yD - 0.36, -h + 0.25, deg(-12)));
    p.add(kit.box(c.trackW + 0.04, 0.03, 0.35), c.paint, T(sx * (c.W / 2 - c.trackW / 2 - 0.03), yD - 0.36, h - 0.1, deg(10)));
  }
  // mud on the lower hull
  p.add(kit.profileX([[h - 0.25, yB + 0.02], [h + 0.01, yB + 0.14], [h + 0.01, yB + 0.32], [-h + 0.45, yB + 0.08], [-h + 0.55, yB - 0.01]], inner + 0.02, 0.0), 'mud');

  if (isBmp) {
    // ribbed glacis (BMP signature)
    for (let i = 0; i < 9; i++) {
      const t = (i + 0.5) / 9;
      p.add(kit.box(inner - 0.05, 0.04, 0.05), c.paint, T(0, noseY + (yD - noseY) * t + 0.02, -h + glacisLen * t, 0));
    }
    // roof hatches (troop compartment) + firing ports
    for (let i = 0; i < 4; i++) {
      p.add(kit.box(0.55, 0.05, 0.6, 0.02), c.paint, T(-0.42, yD + 0.025, 0.5 + i * 0.68));
      p.add(kit.box(0.55, 0.05, 0.6, 0.02), c.paint, T(0.42, yD + 0.025, 0.5 + i * 0.68));
    }
    for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) p.add(kit.cylX(0.06, 0.06), 'gunmetal', T(sx * (c.W / 2 - 0.08), yD - 0.18, 0.4 + i * 0.6));
    // trim vane on nose
    if (!c.fit) p.add(kit.box(inner - 0.2, 0.5, 0.04, 0.01), 'wood_planks', T(0, noseY + 0.3, -h + 0.25, deg(-40)));
  } else if (c.era === 'k5' || c.era === 'relikt') {
    glacisPlace(p, kit, -h + 0.02, noseY + 0.05, -h + glacisLen - 0.05, yD, 6, 2, inner - 0.05, 0.14, 'era_block');
  } else if (c.era === 'k1') {
    glacisPlace(p, kit, -h + 0.02, noseY + 0.05, -h + glacisLen - 0.05, yD, 8, 3, inner - 0.05, 0.12, 'era_block', 0.05);
  } else if (isLeo) {
    // Leopard: smooth glacis with spare track links
    for (let i = 0; i < 6; i++) p.add(kit.box(0.6, 0.08, 0.16, 0.02), 'track_links', T(-0.9 + (i % 3) * 0.6 + (i > 2 ? 0.3 : 0), noseY + 0.28 + (i > 2 ? 0.25 : 0), -h + 0.6 + (i > 2 ? 0.4 : 0), deg(-60)));
  }

  // side skirts
  if (c.skirts !== 'none') {
    const skL = c.L - 0.9;
    for (const sx of [-1, 1]) {
      if (c.skirts === 'rubber') {
        const panels = 7;
        for (let i = 0; i < panels; i++) {
          const z = -h + 0.6 + (i + 0.5) * (skL / panels);
          const [sb, st] = c.fit?.skirt ?? [yD - 0.935, yD - 0.385];
          p.add(kit.box(0.025, st - sb, skL / panels - 0.03, 0.005), 'rubber_black', T(sx * (c.W / 2 - 0.02), (sb + st) / 2, z, sx * deg(3)));
        }
        const se = c.fit?.sideEra;
        if (se) for (const z of se.z) p.add(kit.box(0.1, se.h, se.w, 0.01), 'era_block', T(sx * (c.W / 2 + 0.02), se.y, z));
        else if (c.era !== 'k1') for (let i = 0; i < 3; i++) p.add(kit.box(0.1, 0.4, 0.42, 0.01), 'era_block', T(sx * (c.W / 2 + 0.02), yD - 0.55, -h + 0.85 + i * 0.45));
      } else {
        p.add(kit.box(0.08, 0.6, skL * 0.35, 0.015), c.paint, T(sx * (c.W / 2 - 0.04), yD - 0.68, -h + 0.6 + skL * 0.175));
        p.add(kit.box(0.04, 0.55, skL * 0.65, 0.01), c.paint, T(sx * (c.W / 2 - 0.03), yD - 0.66, -h + 0.6 + skL * 0.35 + skL * 0.325));
        p.add(kit.box(0.045, 0.12, skL * 0.65, 0.01), 'mud', T(sx * (c.W / 2 - 0.03), yD - 0.92, -h + 0.6 + skL * 0.675));
      }
    }
  }

  // engine deck grilles
  const grill = kit.grid(inner * 0.75, 1.4, 14, 3, 0.03);
  p.add(grill, 'gunmetal', T(0, yD + 0.02, h - 0.95));
  // fender stowage boxes / fuel tanks
  for (const sx of [-1, 1]) {
    for (let i = 0; i < (isLeo ? 2 : 3); i++) p.add(kit.box(c.trackW - 0.06, 0.32, 0.75, 0.025), c.paint, T(sx * (c.W / 2 - c.trackW / 2 - 0.04), yD - 0.2 + 0.16, 0.6 + i * 0.85));
  }
  // headlights + tow hooks
  for (const sx of [-1, 1]) {
    p.add(kit.cylZ(0.08, 0.12), 'gunmetal', T(sx * (inner / 2 - 0.1), yD - 0.12, -h + glacisLen - 0.4));
    p.add(kit.cylZ(0.065, 0.01), 'glass_optic', T(sx * (inner / 2 - 0.1), yD - 0.12, -h + glacisLen - 0.465));
    p.add(kit.torus(0.07, 0.025, 10), 'gunmetal', T(sx * 0.6, noseY - 0.15, -h + 0.1, 0, Math.PI / 2));
    p.add(kit.torus(0.07, 0.025, 10), 'gunmetal', T(sx * 0.6, yB + 0.25, h + 0.02, 0, Math.PI / 2));
  }
  // rear details
  if (variant === 't72b3' || variant === 't64bv') {
    for (const sx of [-1, 1]) {
      const dr = c.fit?.drum ?? { y: yD - 0.25, r: 0.3 };
      p.add(kit.cylX(dr.r, 0.9), 'paint_ru_green', T(sx * 0.6, dr.y, h + dr.r + 0.02));
      p.add(kit.cylX(dr.r + 0.01, 0.04), 'gunmetal', T(sx * 0.6 + 0.3, dr.y, h + dr.r + 0.02));
    }
    p.add(kit.cylX(0.13, inner + 0.2), 'logs', T(0, yD + 0.18, h - 0.05)); // unditching log
    p.add(kit.box(0.25, 0.15, 0.35), 'rust', T(-c.W / 2 + 0.15, yD - 0.3, 0.5)); // exhaust
  } else if (variant === 't80bvm') {
    p.add(kit.box(inner - 0.1, 0.45, 0.08), 'gunmetal', T(0, yD - 0.3, h + 0.04));
    p.add(kit.grid(inner - 0.3, 0.4, 16, 1, 0.025).rotateX(Math.PI / 2), 'rust', T(0, yD - 0.3, h + 0.09));
  } else if (isLeo) {
    p.add(kit.box(inner, 0.35, 0.12, 0.02), c.paint, T(0, yD - 0.25, h + 0.04));
    for (const sx of [-1, 1]) p.add(kit.box(0.12, 0.08, 0.03), 'emissive_red', T(sx * (inner / 2 - 0.15), yD - 0.15, h + 0.105));
  }
  if (isBmp) {
    // rear doors with integrated fuel tanks (hinged nodes)
    for (const [name, sx] of [['Door_RL', -1], ['Door_RR', 1]] as const) {
      const hinge = node(name, hull, sx * 0.88, yB + 0.15, h + 0.02);
      const dp = new PartBuilder(kit);
      dp.add(kit.box(0.72, 0.95, 0.08, 0.02), c.paint, T(-sx * 0.36, 0.5, 0.04));
      dp.add(kit.box(0.6, 0.8, 0.12, 0.04), c.paint, T(-sx * 0.36, 0.5, 0.12));
      dp.add(kit.box(0.04, 0.12, 0.04), 'gunmetal', T(-sx * 0.6, 0.55, 0.2));
      dp.emit(hinge);
    }
  }
  // driver hatch + periscopes
  p.add(kit.cyl(0.32, 0.32, 0.06), c.paint, T(c.driverX, yD + 0.03, -h + glacisLen + 0.35));
  for (let i = -1; i <= 1; i++) p.add(kit.box(0.14, 0.06, 0.08), 'glass_optic', T(c.driverX + i * 0.15, yD + 0.05, -h + glacisLen + 0.05));
  p.emit(hull);
}

// ───────────────────────────── tracks ─────────────────────────────

interface Circle { z: number; y: number; r: number }

function hull2D(pts: [number, number][]): [number, number][] {
  const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of s) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Continuous track belt wrapped around the convex hull of all wheels; V runs along the belt. */
function trackBelt(circles: Circle[], width: number, thick: number, spacing: number): THREE.BufferGeometry {
  const pts: [number, number][] = [];
  for (const c of circles) for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push([c.z + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r]); }
  const hullPts = hull2D(pts);
  // resample by arc length
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < hullPts.length; i++) {
    const a = hullPts[i], b = hullPts[(i + 1) % hullPts.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segLen.push(l); total += l;
  }
  const n = Math.max(24, Math.round(total / spacing));
  const samples: [number, number][] = [];
  let seg = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (acc + segLen[seg] < target) { acc += segLen[seg]; seg++; }
    const a = hullPts[seg], b = hullPts[(seg + 1) % hullPts.length];
    const t = (target - acc) / (segLen[seg] || 1);
    samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  const vPer = 0.6; // metres per texture repeat (4 links × 15 cm)
  const hw = width / 2;
  // outward normals (hull is CCW in (z,y))
  const normals = samples.map((_, i) => {
    const a = samples[(i - 1 + n) % n], b = samples[(i + 1) % n];
    const tz = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tz, ty) || 1;
    return [ty / l, -tz / l] as [number, number];
  });
  const ring = (offset: number, x: number, nx: number, nScale: number, uCoord: number) => {
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const s = samples[i % n], nn = normals[i % n];
      pos.push(x, s[1] + nn[1] * offset, s[0] + nn[0] * offset);
      nrm.push(nx, nn[1] * nScale, nn[0] * nScale);
      uv.push(uCoord, ((i / n) * total) / vPer);
    }
    return base;
  };
  const strip = (a: number, b: number, flip: boolean) => {
    for (let i = 0; i < n; i++) {
      const a0 = a + i, a1 = a + i + 1, b0 = b + i, b1 = b + i + 1;
      if (flip) idx.push(a0, a1, b0, a1, b1, b0); else idx.push(a0, b0, a1, a1, b0, b1);
    }
  };
  // outer face (normal outward)
  const oL = ring(thick, -hw, 0, 1, 0), oR = ring(thick, hw, 0, 1, 1);
  strip(oL, oR, false);
  // inner face (normal inward)
  const iL = ring(0, -hw, 0, -1, 0), iR = ring(0, hw, 0, -1, 1);
  strip(iL, iR, true);
  // side walls
  const sLo = ring(0, -hw, -1, 0, 0), sLi = ring(thick, -hw, -1, 0, 0.1);
  strip(sLo, sLi, false);
  const sRo = ring(0, hw, 1, 0, 0), sRi = ring(thick, hw, 1, 0, 0.1);
  strip(sRo, sRi, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function buildTrack(kit: Kit, c: Cfg, side: 'L' | 'R', hull: THREE.Group): void {
  const sx = side === 'L' ? -1 : 1;
  const x = sx * (c.W / 2 - c.trackW / 2 - 0.04);
  const tn = node(`Track_${side}`, hull, x, 0, 0);
  const h = c.L / 2;
  const thick = 0.07;
  const rearZ = h - 0.38, frontZ = -h + 0.42;
  const sprocket: Circle = c.fit?.sprocket ?? { z: c.sprocketFront ? frontZ : rearZ, y: c.wheelR + 0.33, r: 0.32 };
  const idler: Circle = c.fit?.idler ?? { z: c.sprocketFront ? rearZ : frontZ, y: c.wheelR + 0.25, r: 0.27 };
  const wy = c.fit?.wheelY ?? c.wheelR + thick;
  const span = (rearZ - frontZ) - 1.25;
  const wheels: Circle[] = [];
  for (let i = 0; i < c.wheels; i++) wheels.push({ z: c.fit?.wheelZ[i] ?? frontZ + 0.62 + (span * i) / (c.wheels - 1), y: wy, r: c.wheelR });
  const rollerY = Math.max(sprocket.y + sprocket.r, idler.y + idler.r) - 0.1;
  const rollers: Circle[] = [];
  for (let i = 0; i < c.rollers; i++) rollers.push({ z: frontZ + 0.9 + ((span - 0.4) * i) / Math.max(1, c.rollers - 1), y: rollerY, r: 0.09 });

  // belt with its own material so left/right can scroll independently
  const belt = new PartBuilder(kit);
  belt.add(trackBelt([sprocket, idler, ...wheels, ...rollers], c.trackW, thick, 0.05), `track_links__${side}`);
  belt.emit(tn);

  // road wheel (shared geometry → one glTF mesh reused)
  const wheelProto = new THREE.Group();
  wheelProto.name = 'proto';
  const wp = new PartBuilder(kit);
  const tw = c.trackW * 0.38;
  for (const off of [-1, 1]) {
    wp.add(kit.cylX(c.wheelR, tw), 'rubber_black', T(off * (tw / 2 + 0.03), 0, 0));
    wp.add(kit.cylX(c.wheelR * 0.82, tw + 0.01), c.paint, T(off * (tw / 2 + 0.03), 0, 0));
  }
  wp.add(kit.cylX(c.wheelR * 0.3, c.trackW * 0.95, 10), 'gunmetal');
  for (let b = 0; b < 8; b++) {
    const a = (b / 8) * Math.PI * 2;
    wp.add(kit.cylX(0.022, c.trackW * 0.97, 6), 'gunmetal', T(0, Math.cos(a) * c.wheelR * 0.45, Math.sin(a) * c.wheelR * 0.45));
  }
  const protoMeshes = wp.emit(wheelProto);
  wheels.forEach((w, i) => {
    const wn = node(`Wheel_${side}_${String(i + 1).padStart(2, '0')}`, tn, 0, w.y, w.z);
    for (const m of protoMeshes) { const cl = m.clone(); cl.name = `${wn.name}_m_${(m.material as THREE.Material).name}`; wn.add(cl); }
  });
  const rp = new PartBuilder(kit);
  rp.add(kit.cylX(0.09, c.trackW * 0.6, 12), 'rubber_black');
  rp.add(kit.cylX(0.05, c.trackW * 0.7, 8), c.paint);
  const rollerProto = rp.emit(new THREE.Group());
  rollers.forEach((r, i) => {
    const rn = node(`Roller_${side}_${String(i + 1).padStart(2, '0')}`, tn, 0, r.y, r.z);
    for (const m of rollerProto) { const cl = m.clone(); cl.name = `${rn.name}_m_${(m.material as THREE.Material).name}`; rn.add(cl); }
  });
  // drive sprocket (toothed)
  const sn = node(`Sprocket_${side}`, tn, 0, sprocket.y, sprocket.z);
  const sp = new PartBuilder(kit);
  sp.add(kit.cylX(sprocket.r - 0.04, c.trackW * 0.5), c.paint);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    sp.add(kit.box(c.trackW * 0.5, 0.07, 0.06), 'gunmetal', T(0, Math.cos(a) * (sprocket.r - 0.02), Math.sin(a) * (sprocket.r - 0.02), a));
  }
  sp.add(kit.cylX(0.12, c.trackW * 0.9, 12), 'gunmetal');
  sp.emit(sn);
  // idler
  const inn = node(`Idler_${side}`, tn, 0, idler.y, idler.z);
  const ip = new PartBuilder(kit);
  ip.add(kit.cylX(idler.r, c.trackW * 0.45), c.paint);
  ip.add(kit.cylX(0.1, c.trackW * 0.9, 12), 'gunmetal');
  for (let i = 0; i < 6; i++) ip.add(kit.box(c.trackW * 0.47, 0.05, idler.r * 1.6), 'gunmetal', T(0, 0, 0, (i / 6) * Math.PI));
  ip.emit(inn);
}

// ───────────────────────────── interiors ─────────────────────────────

function buildDriverStation(kit: Kit, c: Cfg, hull: THREE.Group): void {
  const h = c.L / 2;
  const glacis = c.turret === 'bmp' ? 2.1 : c.turret === 'leo' ? 1.9 : 1.55;
  const ic = node('Interior_Cockpit', hull, c.driverX, c.belly + 0.1, -h + glacis + 0.45);
  const p = new PartBuilder(kit);
  const sh = c.deck - c.belly - 0.2;
  // interior walls as thin panels; the upper front band stays open = the driver's vision blocks,
  // so from inside the camera sees the outside world through it (hull faces are back-face culled)
  const W = 1.0, D = 1.3, th = 0.02, slit = 0.22;
  p.add(kit.box(W, th, D), 'interior_shell', T(0, 0, 0.1));
  p.add(kit.box(W, th, D), 'interior_shell', T(0, sh, 0.1));
  p.add(kit.box(th, sh, D), 'interior_shell', T(-W / 2, sh / 2, 0.1));
  p.add(kit.box(th, sh, D), 'interior_shell', T(W / 2, sh / 2, 0.1));
  p.add(kit.box(W, sh, th), 'interior_shell', T(0, sh / 2, 0.1 + D / 2));
  p.add(kit.box(W, sh - slit - 0.08, th), 'interior_shell', T(0, (sh - slit - 0.08) / 2, 0.1 - D / 2));
  p.add(kit.box(W, 0.08, th), 'interior_shell', T(0, sh - 0.04, 0.1 - D / 2));
  // seat (reclined Soviet-style)
  p.add(kit.box(0.45, 0.1, 0.45, 0.03), 'fabric_olive', T(0, 0.2, 0.3));
  p.add(kit.box(0.45, 0.5, 0.1, 0.03), 'fabric_olive', T(0, 0.45, 0.55, deg(-25)));
  // tillers / yoke, pedals
  if (c.turret === 'leo') {
    p.add(kit.torus(0.16, 0.02, 12, Math.PI), 'polymer_black', T(0, 0.3, -0.2, deg(-70)));
  } else {
    for (const sx of [-1, 1]) p.add(kit.cyl(0.018, 0.018, 0.4, 8), 'gunmetal', T(sx * 0.22, 0.28, -0.1, deg(-25)));
  }
  for (const sx of [-1, 0, 1]) p.add(kit.box(0.08, 0.02, 0.14), 'gunmetal', T(sx * 0.15, 0.08, -0.45, deg(-40)));
  // dashboard + display
  p.add(kit.box(0.7, 0.16, 0.08), 'gunmetal', T(0, 0.3, -0.48, deg(-30)));
  p.add(kit.box(0.2, 0.1, 0.01), 'emissive_screen', T(0.15, 0.33, -0.43, deg(-30)));
  // vision blocks seen from inside
  for (let i = -1; i <= 1; i++) p.add(kit.box(0.04, slit, 0.04), 'gunmetal', T(i * 0.3, sh - 0.08 - slit / 2, 0.1 - D / 2));
  p.emit(ic);
  node('Cam_Driver', ic, 0, sh - 0.08 - slit / 2, 0.1 - D / 2 + 0.12);
}

// ───────────────────────────── turrets ─────────────────────────────

function smokeLaunchers(kit: Kit, turret: THREE.Group, positions: [number, number, number, number][], mat: string): void {
  const sl = node('Smoke_Launchers', turret);
  const p = new PartBuilder(kit);
  for (const [x, y, z, yaw] of positions) {
    p.add(kit.cylZ(0.042, 0.28, 10), mat, T(x, y, z, deg(-25), yaw));
    p.add(kit.cylZ(0.032, 0.01, 10), 'gunmetal', T(x + Math.sin(yaw) * -0.14, y + 0.06, z - Math.cos(yaw) * 0.13, deg(-25), yaw));
  }
  p.emit(sl);
}

function cage(kit: Kit, turret: THREE.Group, w: number, d: number, baseY: number, topY: number, z: number): void {
  const cg = node('Cage', turret);
  const p = new PartBuilder(kit);
  const band = Math.min(0.5, (topY - baseY) * 0.45); // netted side band hanging from the roof frame
  // posts + diagonal braces down to the turret roof
  for (const [x, zz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]] as [number, number][]) {
    p.add(kit.cyl(0.025, 0.03, topY - baseY, 6), 'rust', T(x * 0.55, (baseY + topY) / 2, z + zz * 0.55));
    const bx = x * 0.78, bz = zz * 0.78, len = Math.hypot(x * 0.45, topY - band - baseY, zz * 0.45);
    p.add(kit.cyl(0.02, 0.02, len, 6), 'rust', T(bx, baseY + (topY - band - baseY) / 2, z + bz, Math.atan2(zz * 0.45, topY - band - baseY) * 0.9, 0, -Math.atan2(x * 0.45, topY - band - baseY) * 0.9));
  }
  // roof frame + net
  p.add(kit.grid(w, d, 3, 4, 0.035), 'rust', T(0, topY, z));
  p.add(kit.quad(w, d).rotateX(-Math.PI / 2), 'cage_net', T(0, topY + 0.01, z));
  // side bands: lower rail + net panels on all four sides
  for (const sx of [-1, 1]) {
    p.add(kit.box(0.035, 0.035, d), 'rust', T(sx * w / 2, topY - band, z));
    p.add(kit.quad(d, band).rotateY(Math.PI / 2), 'cage_net', T(sx * w / 2, topY - band / 2, z));
    for (let i = 0; i <= 4; i++) p.add(kit.box(0.03, band, 0.03), 'rust', T(sx * w / 2, topY - band / 2, z - d / 2 + (d * i) / 4));
  }
  for (const sz of [-1, 1]) {
    p.add(kit.box(w, 0.035, 0.035), 'rust', T(0, topY - band, z + sz * d / 2));
    p.add(kit.quad(w, band), 'cage_net', T(0, topY - band / 2, z + sz * d / 2));
  }
  p.emit(cg);
}

function buildCannon(kit: Kit, c: Cfg, turret: THREE.Group, trunnion: [number, number, number], style: 'soviet' | 'leo' | 'bmp'): void {
  const cannon = node('Cannon', turret, ...trunnion);
  const p = new PartBuilder(kit);
  const L = c.gunLen;
  const r = c.gunR;
  if (style === 'bmp') {
    p.add(kit.box(0.22, 0.2, 0.35, 0.03), c.paint, T(0, 0, -0.1));
    p.add(kit.cylZ(r, L, 12), 'gunmetal', T(0, 0, -L / 2 - 0.2));
    p.add(kit.cylZ(r * 1.6, 0.25, 12), 'gunmetal', T(0, 0, -L - 0.08));
    p.add(kit.cylZ(0.04, 0.5, 10), 'gunmetal', T(0.15, 0.02, -0.4)); // coax PKT
  } else {
    // mantlet
    if (style === 'leo') p.add(kit.box(0.75, 0.55, 0.45, 0.04), c.paint, T(0, 0, -0.15));
    else p.add(kit.sphere(0.32, kit.radial, Math.PI * 2, Math.PI).scale(1, 0.75, 0.8), c.paint, T(0, 0, -0.1));
    // tube with thermal sleeve sections and fume extractor
    p.add(kit.cylZ(r, L, kit.radial), 'gunmetal', T(0, 0, -L / 2));
    const sections = style === 'leo' ? 4 : 3;
    for (let i = 0; i < sections; i++) {
      const z = -0.45 - i * ((L - 0.9) / sections) - (L - 0.9) / sections / 2;
      p.add(kit.cylZ(r * 1.38, (L - 0.9) / sections - 0.05, kit.radial), c.paint, T(0, 0, z));
      p.add(kit.torus(r * 1.4, 0.012, kit.radial), 'gunmetal', T(0, 0, z - (L - 0.9) / sections / 2 + 0.02));
    }
    const fz = style === 'leo' ? -L * 0.42 : -L * 0.38;
    p.add(kit.cylZ(r * 2.05, 0.65, kit.radial, r * 1.6), c.paint, T(0, 0, fz));
    if (style === 'leo') p.add(kit.box(0.1, 0.1, 0.12, 0.01), 'gunmetal', T(0, r * 1.5 + 0.04, -L + 0.08)); // MRS
    p.add(kit.cylZ(r * 1.15, 0.12, kit.radial), 'gunmetal', T(0, 0, -L + 0.06));
    p.add(kit.cylZ(0.025, 0.6, 8), 'gunmetal', T(0.3, 0.05, -0.5)); // coax MG
  }
  p.emit(cannon);
  node('Muzzle', cannon, 0, 0, -L - (style === 'bmp' ? 0.25 : 0));
}

function gunnerStation(kit: Kit, turret: THREE.Group, x: number, y: number, z: number): void {
  const ig = node('Interior_Gunner', turret, x, y, z);
  const p = new PartBuilder(kit);
  // inward-facing shell kept entirely inside the turret armour
  p.add(kit.box(0.8, 0.6, 0.9), 'interior_shell', T(0, 0.0, 0.1));
  p.add(kit.box(0.22, 0.18, 0.25, 0.02), 'gunmetal', T(0, 0.2, -0.3));
  p.add(kit.cylZ(0.04, 0.08), 'polymer_black', T(0, 0.22, -0.15));
  p.add(kit.box(0.24, 0.16, 0.02), 'emissive_screen', T(0.25, 0.12, -0.35, deg(-10)));
  for (const sx of [-1, 1]) p.add(kit.cyl(0.02, 0.02, 0.14, 8), 'polymer_black', T(sx * 0.12, -0.08, -0.3, deg(-30)));
  p.add(kit.box(0.35, 0.08, 0.35, 0.03), 'fabric_olive', T(0, -0.42, 0.25));
  p.emit(ig);
  node('Cam_Gunner', ig, 0, 0.22, -0.08);
}

function buildSovietTurret(kit: Kit, c: Cfg, turret: THREE.Group, variant: Variant): void {
  const p = new PartBuilder(kit);
  const P = c.paint;
  // cast dome (lathe) slightly elongated
  const ts = c.fit?.turretScale ?? [1, 1, 1.1];
  p.add(kit.lathe([[0, 0.66], [0.55, 0.64], [1.0, 0.52], [1.18, 0.32], [1.22, 0.1], [1.15, 0.0], [0.0, 0.0]], kit.radial + 8).scale(...ts), P, T(0, 0, 0.1));
  p.add(kit.cyl(1.05, 1.1, 0.08), 'gunmetal', T(0, 0.0, 0.1));
  // rear stowage bin
  const rb = c.fit?.rearBin ?? [1.6, 0.4, 0.45, 0, 0.3, 1.45];
  p.add(kit.box(rb[0], rb[1], rb[2], 0.04), P, T(rb[3], rb[4], rb[5]));
  // ERA package
  if (c.era === 'k5' || c.era === 'relikt') {
    for (const sx of [-1, 1]) {
      const poly: [number, number][] = [[sx * 0.28, -1.22], [sx * 1.15, -0.72], [sx * 1.28, -0.12], [sx * 1.05, -0.2], [sx * 0.95, -0.6], [sx * 0.32, -0.95]];
      p.add(kit.profileY(sx < 0 ? poly.slice().reverse() : poly, 0.42, 0.02), 'era_block', T(0, 0.12, 0));
      // roof plates
      p.add(kit.box(0.6, 0.08, 0.5, 0.015), 'era_block', T(sx * 0.6, 0.66, -0.55, deg(-6)));
    }
    if (c.era === 'relikt') {
      for (const sx of [-1, 1]) p.add(kit.box(0.08, 0.35, 1.2, 0.01), 'rubber_black', T(sx * 1.25, 0.25, 0.45));
    }
  } else if (c.era === 'k1') {
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 13; i++) {
        const a = -Math.PI * 0.85 + (i / 12) * Math.PI * 0.7;
        const rr = 1.2 - row * 0.25;
        if (Math.abs(Math.cos(a) * rr) < 0.3 && row === 0) continue;
        p.add(kit.box(0.26, 0.12, 0.14, 0.01), 'era_block', T(Math.cos(a) * rr, 0.42 + row * 0.18, Math.sin(a) * rr * 1.1 + 0.1, deg(-20), -a - Math.PI / 2));
      }
    }
  }
  // commander cupola + remote MG
  p.add(kit.cyl(0.33, 0.36, 0.14), P, T(-0.45, 0.72, 0.25));
  p.add(kit.cyl(0.28, 0.28, 0.05), P, T(-0.45, 0.81, 0.25));
  p.add(kit.box(0.18, 0.18, 0.4, 0.02), 'gunmetal', T(-0.45, 0.94, 0.15));
  p.add(kit.cylZ(0.03, 1.0, 8), 'gunmetal', T(-0.45, 0.97, -0.35));
  // gunner sight (Sosna-U / 1G46) + loader-side hatch
  p.add(kit.box(0.42, 0.34, 0.42, 0.03), P, T(0.55, 0.78, -0.35));
  p.add(kit.box(0.3, 0.2, 0.02), 'glass_optic', T(0.55, 0.8, -0.565));
  p.add(kit.cyl(0.3, 0.3, 0.06), P, T(0.45, 0.67, 0.4));
  // laser rangefinder / IR projector box, antenna
  p.add(kit.box(0.25, 0.22, 0.3, 0.02), P, T(0.95, 0.5, -0.55));
  p.add(kit.cyl(0.006, 0.01, 1.0, 5), 'gunmetal', T(-0.9, 1.15, 0.9, deg(-6)));
  p.emit(turret);
  smokeLaunchers(kit, turret, [0, 1, 2, 3].flatMap((i) => [[-0.9 - i * 0.07, 0.48, -0.72 + i * 0.16, deg(25 + i * 8)], [0.9 + i * 0.07, 0.48, -0.72 + i * 0.16, deg(-25 - i * 8)]] as [number, number, number, number][]), P);
  const cg = c.fit?.cage ?? [2.6, 3.2, 0.66, variant === 't64bv' ? 1.4 : 1.5, 0.3];
  if (c.cage) cage(kit, turret, ...cg);
  buildCannon(kit, c, turret, c.fit?.trunnion ?? [0, 0.38, -1.05], 'soviet');
  gunnerStation(kit, turret, 0.45, 0.25, -0.2);
}

function buildLeoTurret(kit: Kit, c: Cfg, turret: THREE.Group, variant: Variant): void {
  const p = new PartBuilder(kit);
  const P = c.paint;
  const lt = c.fit?.leoTurret ?? { front: -1.55, rear: 2.15, wedgeTip: -2.25 };
  const F = lt.front, R = lt.rear;
  const outline: [number, number][] = [[-0.85, F], [0.85, F], [1.32, F + 0.55], [1.35, R - 0.55], [1.05, R], [-1.05, R], [-1.35, R - 0.55], [-1.32, F + 0.55]];
  p.add(kit.profileY(outline, 0.78, 0.03), P, T(0, 0.02, 0));
  p.add(kit.cyl(1.05, 1.1, 0.08), 'gunmetal');
  if (variant === 'leo2a6') {
    for (const sx of [-1, 1]) {
      const w: [number, number][] = [[sx * 0.4, F - 0.01], [sx * 0.95, lt.wedgeTip], [sx * 1.34, F + 0.5], [sx * 1.3, F + 0.55]];
      p.add(kit.profileY(sx < 0 ? w.slice().reverse() : w, 0.74, 0.02), P, T(0, 0.04, 0));
    }
  }
  // EMES sight doghouse (gunner, right) + PERI (commander, left)
  p.add(kit.box(0.45, 0.32, 0.6, 0.03), P, T(0.6, 0.94, -0.95));
  p.add(kit.box(0.34, 0.2, 0.02), 'glass_optic', T(0.6, 0.96, -1.26));
  p.add(kit.cyl(0.14, 0.16, 0.45, 12), P, T(-0.55, 1.0, -0.35));
  p.add(kit.box(0.24, 0.16, 0.24), 'gunmetal', T(-0.55, 1.28, -0.35));
  p.add(kit.box(0.18, 0.1, 0.01), 'glass_optic', T(-0.55, 1.28, -0.475));
  // hatches + MG3 at loader station
  p.add(kit.cyl(0.32, 0.32, 0.05), P, T(-0.5, 0.82, 0.55));
  p.add(kit.cyl(0.3, 0.3, 0.05), P, T(0.5, 0.82, 0.6));
  p.add(kit.cylZ(0.025, 1.1, 8), 'gunmetal', T(0.5, 1.0, 0.2));
  p.add(kit.box(0.08, 0.14, 0.3), 'gunmetal', T(0.5, 0.94, 0.55));
  // rear bustle stowage basket
  const basket = kit.grid(2.2, 0.55, 8, 2, 0.03);
  if (!c.fit?.leoTurret) { // a fitted turret already includes the bustle basket in its outline
    p.add(basket, 'gunmetal', T(0, 0.45, R + 0.3));
    p.add(kit.box(2.0, 0.35, 0.45, 0.06), 'fabric_olive', T(0, 0.62, R + 0.27));
  }
  p.add(kit.cyl(0.006, 0.01, 1.0, 5), 'gunmetal', T(1.1, 1.3, 1.8, deg(-6)));
  p.emit(turret);
  smokeLaunchers(kit, turret, [0, 1, 2, 3].flatMap((i) => [[-1.32, 0.86, 0.9 + i * 0.16, deg(80)], [1.32, 0.86, 0.9 + i * 0.16, deg(-80)]] as [number, number, number, number][]), 'gunmetal');
  buildCannon(kit, c, turret, [0, 0.42, -1.35], 'leo');
  gunnerStation(kit, turret, 0.55, 0.3, -0.5);
}

function buildBmpTurret(kit: Kit, c: Cfg, turret: THREE.Group): void {
  const p = new PartBuilder(kit);
  const P = c.paint;
  p.add(kit.lathe([[0, 0.6], [0.45, 0.58], [0.82, 0.32], [0.9, 0.08], [0.88, 0], [0, 0]], kit.radial + 4).scale(...(c.fit?.turretScale ?? [1, 1, 1.05])), P);
  p.add(kit.cyl(0.8, 0.82, 0.06), 'gunmetal');
  // commander + gunner hatches, periscopes
  p.add(kit.cyl(0.26, 0.26, 0.06), P, T(-0.32, 0.62, 0.15));
  p.add(kit.cyl(0.24, 0.24, 0.06), P, T(0.32, 0.62, 0.15));
  p.add(kit.box(0.22, 0.2, 0.25, 0.02), P, T(0.35, 0.7, -0.25));
  p.add(kit.box(0.16, 0.12, 0.01), 'glass_optic', T(0.35, 0.72, -0.38));
  // IR searchlight
  p.add(kit.cylZ(0.11, 0.2, 12), 'gunmetal', T(-0.55, 0.62, -0.35));
  p.add(kit.cylZ(0.1, 0.01, 12), 'glass_optic', T(-0.55, 0.62, -0.455));
  // Konkurs ATGM launcher on roof
  p.add(kit.box(0.08, 0.2, 0.08), 'gunmetal', T(0, 0.7, 0.05));
  p.add(kit.cylZ(0.075, 1.2, 12), 'warhead_olive', T(0, 0.86, -0.05));
  p.add(kit.cyl(0.006, 0.01, 1.0, 5), 'gunmetal', T(-0.6, 1.1, 0.55));
  p.emit(turret);
  smokeLaunchers(kit, turret, [0, 1, 2].flatMap((i) => [[-0.55 - i * 0.08, 0.42, 0.45 + i * 0.12, deg(110)], [0.55 + i * 0.08, 0.42, 0.45 + i * 0.12, deg(-110)]] as [number, number, number, number][]), P);
  if (c.cage) cage(kit, turret, 2.0, 2.2, 0.6, 1.2, 0.1);
  buildCannon(kit, c, turret, c.fit?.trunnion ?? [0, 0.36, -0.75], 'bmp');
  gunnerStation(kit, turret, 0.3, 0.1, 0.0);
}

export type { Variant as VehicleVariant };
