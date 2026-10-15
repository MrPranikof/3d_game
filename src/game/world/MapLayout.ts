import { RNG } from '../../assets/procedural/noise';
import type { Team } from '../../assets/StylePreset';

/**
 * «Малая Токмачка» — stylised reconstruction of the village south-east of Orikhiv:
 * steppe fields split by windbreak tree lines, a village strung along two streets,
 * a collective farm with hangars in the east, the Tokmachka creek valley in the south,
 * and two opposing trench lines. Team A attacks from the north-west, Team B holds the south-east.
 * Coordinates: metres, +X east, +Z south, terrain centred at the origin.
 */

export const MAP_SIZE = 640;
export const HALF = MAP_SIZE / 2;

export type V2 = [number, number];

export interface Road { pts: V2[]; width: number; kind: 'asphalt' | 'dirt' }
export interface Placement { id: string; x: number; z: number; rot: number }
export interface Polyline { pts: V2[] }
export interface CapturePoint { id: 'A' | 'B' | 'C'; name: string; x: number; z: number; radius: number; owner: Team | null }
export interface FieldPatch { pts: V2[]; kind: 'plowed' | 'sunflower' | 'stubble' }

export interface MapLayout {
  roads: Road[];
  fields: FieldPatch[];
  buildings: Placement[];
  props: Placement[];
  trenches: Polyline[];
  treelines: { pts: V2[]; spacing: number; kinds: string[] }[];
  yardTrees: Placement[];
  craters: { x: number; z: number; r: number }[];
  points: CapturePoint[];
  spawns: Record<Team, V2[]>;
  vehicleSpawns: Record<Team, { id: string; x: number; z: number; rot: number }[]>;
  emplacements: { id: 'atgm_launcher' | 'mortar_82'; team: Team; x: number; z: number; rot: number }[];
  ewZones: { team: Team; x: number; z: number; r: number }[];
  creek: V2[];
}

const ASPHALT: V2[] = [[-320, -250], [-200, -150], [-90, -40], [-20, 10], [60, 60], [180, 150], [320, 250]];

export const MAIN_ROAD = ASPHALT;

export function buildLayout(seed = 'malaya-tokmachka'): MapLayout {
  const rng = new RNG(seed);
  const roads: Road[] = [
    // T-0408-style asphalt road Orikhiv → Tokmak running NW → SE through the village
    { kind: 'asphalt', width: 7, pts: ASPHALT },
    // village streets (dirt)
    { kind: 'dirt', width: 6, pts: [[-150, 0], [-80, 4], [0, 10], [80, 14], [150, 30]] },
    { kind: 'dirt', width: 5, pts: [[-70, 70], [0, 72], [70, 80], [110, 100]] },
    { kind: 'dirt', width: 5, pts: [[-40, -60], [-35, 0], [-30, 72]] },
    { kind: 'dirt', width: 5, pts: [[40, -40], [45, 12], [52, 80], [60, 140]] },
    // farm access + field tracks
    { kind: 'dirt', width: 5, pts: [[80, 14], [110, 60], [130, 95], [150, 110]] },
    { kind: 'dirt', width: 4, pts: [[-300, -120], [-150, -112], [0, -118], [150, -105], [300, -110]] },
    { kind: 'dirt', width: 4, pts: [[-250, -300], [-245, -120], [-260, 100], [-250, 300]] },
  ];

  const buildings: Placement[] = [];
  const along = (pts: V2[], spacing: number, offset: number, ruinChance: number, jitter = 3) => {
    for (let s = 0; s < pts.length - 1; s++) {
      const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      for (let d = spacing / 2; d < len; d += spacing + rng.range(-3, 5)) {
        for (const side of [-1, 1]) {
          if (rng.chance(0.18)) continue; // empty plots / gardens
          const x = ax + dx * d - dz * offset * side + rng.range(-jitter, jitter);
          const z = az + dz * d + dx * offset * side + rng.range(-jitter, jitter);
          // house front (door + gable, local −Z) faces the street
          const rot = Math.atan2(-side * dz, side * dx) + rng.range(-0.08, 0.08);
          if (buildings.some((b) => Math.hypot(b.x - x, b.z - z) < 14)) continue;
          if (distToPolyline(x, z, ASPHALT) < 11) continue;
          buildings.push({ id: rng.chance(ruinChance) ? 'house_ruined' : 'house_brick', x, z, rot });
        }
      }
    }
  };
  along([[-140, 0], [-80, 4], [0, 10], [80, 14], [140, 28]], 24, 17, 0.4);
  along([[-60, 70], [0, 72], [70, 80]], 26, 16, 0.35);

  // collective farm (point C)
  buildings.push({ id: 'hangar', x: 162, z: 92, rot: 0.15 });
  buildings.push({ id: 'hangar', x: 106, z: 142, rot: 0.15 + Math.PI / 2 });

  const props: Placement[] = [];
  // farm fence
  for (let i = 0; i < 8; i++) props.push({ id: 'fence_concrete', x: 86, z: 112 + i * 6.2, rot: Math.PI / 2 });
  for (let i = 0; i < 9; i++) if (i !== 4) props.push({ id: 'fence_concrete', x: 112 + i * 6.2, z: 170, rot: 0 });
  // yard fences along the main street
  for (let x = -130; x < 130; x += 6.5) if (rng.chance(0.45)) props.push({ id: 'fence_concrete', x, z: 10 + (x / 80) * 4 + (rng.chance(0.5) ? 7.5 : -7.5), rot: Math.atan2(4, 80) });
  // anti-tank hedgehogs on the approaches
  // hedgehog belts with lanes left open every third post (passable for tracked vehicles)
  for (let i = 0; i < 14; i++) if (i % 3 !== 2) props.push({ id: 'czech_hedgehog', x: -100 + i * 5 + rng.range(-0.5, 0.5), z: -70 + rng.range(-1.5, 1.5), rot: rng.range(0, 3) });
  for (let i = 0; i < 12; i++) if (i % 3 !== 2) props.push({ id: 'czech_hedgehog', x: 60 + i * 5.5, z: 175 + rng.range(-1.5, 1.5), rot: rng.range(0, 3) });
  // dugouts
  props.push({ id: 'dugout', x: -170, z: -100, rot: 0.2 });
  props.push({ id: 'dugout', x: -120, z: -96, rot: -0.1 });
  props.push({ id: 'dugout', x: 120, z: 200, rot: Math.PI });
  props.push({ id: 'dugout', x: 175, z: 196, rot: Math.PI + 0.2 });

  // zig-zag trench lines (Team A north-west of the village, Team B south-east)
  const zig = (x0: number, z0: number, x1: number, z1: number, amp: number): V2[] => {
    const pts: V2[] = [];
    const n = Math.round(Math.hypot(x1 - x0, z1 - z0) / 8);
    const nx = -(z1 - z0), nz = x1 - x0, nl = Math.hypot(nx, nz);
    for (let i = 0; i <= n; i++) {
      const t = i / n, o = (i % 2 === 0 ? -1 : 1) * amp;
      pts.push([x0 + (x1 - x0) * t + (nx / nl) * o, z0 + (z1 - z0) * t + (nz / nl) * o]);
    }
    return pts;
  };
  const trenches: Polyline[] = [
    { pts: zig(-205, -88, -95, -84, 2.2) },
    { pts: zig(85, 190, 205, 186, 2.2) },
  ];

  // windbreak tree lines ("посадки")
  const treelines = [
    { pts: [[-300, -130], [-60, -128]] as V2[], spacing: 7, kinds: ['tree_poplar', 'tree_acacia', 'tree_acacia'] },
    { pts: [[20, -130], [300, -126]] as V2[], spacing: 8, kinds: ['tree_poplar', 'tree_acacia'] },
    { pts: [[-215, -300], [-212, -150]] as V2[], spacing: 8, kinds: ['tree_acacia', 'tree_poplar'] },
    { pts: [[220, 300], [222, 160]] as V2[], spacing: 8, kinds: ['tree_acacia', 'tree_poplar'] },
    { pts: [[-300, 150], [-80, 150]] as V2[], spacing: 9, kinds: ['tree_acacia', 'tree_scorched'] },
    { pts: [[60, 205], [300, 210]] as V2[], spacing: 8, kinds: ['tree_poplar', 'tree_scorched', 'tree_acacia'] },
    { pts: [[-120, -70], [-60, -66]] as V2[], spacing: 9, kinds: ['tree_scorched'] },
    { pts: [[140, -110], [150, 40]] as V2[], spacing: 9, kinds: ['tree_acacia', 'tree_scorched'] },
  ];
  const yardTrees: Placement[] = [];
  for (const b of buildings) {
    if (b.id === 'hangar' || !rng.chance(0.55)) continue;
    const a = b.rot + rng.range(-0.5, 0.5);
    yardTrees.push({ id: rng.chance(0.25) ? 'tree_scorched' : 'tree_acacia', x: b.x + Math.sin(a) * 11, z: b.z + Math.cos(a) * 11, rot: rng.range(0, 6) });
  }

  // shell craters, densest in no-man's land
  const craters: MapLayout['craters'] = [];
  for (let i = 0; i < 150; i++) {
    const t = rng.next();
    const x = -200 + t * 400 + rng.range(-70, 70);
    const z = -80 + t * 260 + rng.range(-70, 70);
    craters.push({ x, z, r: rng.range(1.5, 4.2) });
  }

  const fields: FieldPatch[] = [
    { kind: 'plowed', pts: [[-300, -300], [-225, -300], [-225, -140], [-300, -140]] },
    { kind: 'sunflower', pts: [[-200, -300], [-20, -300], [-20, -140], [-200, -140]] },
    { kind: 'stubble', pts: [[30, -300], [300, -300], [300, -140], [30, -140]] },
    { kind: 'plowed', pts: [[-300, 160], [-90, 160], [-90, 300], [-300, 300]] },
    { kind: 'stubble', pts: [[230, 160], [300, 160], [300, 300], [230, 300]] },
    { kind: 'plowed', pts: [[160, -100], [300, -100], [300, 60], [160, 60]] },
  ];

  const points: CapturePoint[] = [
    { id: 'A', name: 'Посадка', x: -150, z: -90, radius: 26, owner: 'A' },
    { id: 'B', name: 'Центр села', x: -5, z: 30, radius: 30, owner: null },
    { id: 'C', name: 'Ферма', x: 132, z: 117, radius: 28, owner: 'B' },
  ];

  return {
    roads, fields, buildings, props, trenches, treelines, yardTrees, craters, points,
    spawns: {
      A: [[-255, -235], [-248, -228], [-262, -224], [-240, -240], [-268, -238]],
      B: [[255, 245], [248, 238], [262, 236], [240, 250], [266, 250]],
    },
    vehicleSpawns: {
      A: [{ id: 'tank_leo2a6', x: -242, z: -208, rot: Math.PI * 0.75 }, { id: 'tank_leo2a4', x: -228, z: -224, rot: Math.PI * 0.75 }],
      B: [{ id: 'tank_t72b3', x: 230, z: 220, rot: -Math.PI * 0.25 }, { id: 'ifv_bmp2', x: 215, z: 235, rot: -Math.PI * 0.25 }],
    },
    emplacements: [
      { id: 'atgm_launcher', team: 'A', x: -100, z: -92, rot: Math.PI * 0.8 },
      { id: 'mortar_82', team: 'A', x: -232, z: -200, rot: Math.PI * 0.75 },
      { id: 'atgm_launcher', team: 'B', x: 95, z: 182, rot: -Math.PI * 0.2 },
      { id: 'mortar_82', team: 'B', x: 232, z: 205, rot: -Math.PI * 0.25 },
    ],
    ewZones: [
      { team: 'A', x: -240, z: -230, r: 140 },
      { team: 'B', x: 240, z: 230, r: 140 },
    ],
    creek: [[-320, 250], [-180, 235], [-60, 255], [60, 245], [180, 270], [320, 262]],
  };
}

/** Distance from point to polyline + closest segment parameter. */
export function distToPolyline(x: number, z: number, pts: V2[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const vx = bx - ax, vz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)));
    const d = Math.hypot(ax + vx * t - x, az + vz * t - z);
    if (d < best) best = d;
  }
  return best;
}

export function pointInPoly(x: number, z: number, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
