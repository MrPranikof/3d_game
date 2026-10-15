import * as THREE from 'three';
import { pad } from '../../AssetRegistry';
import { type Kit, node, PartBuilder, T } from '../Kit';
import { RNG } from '../noise';

/**
 * «Малая Токмачка» environment set: rural brick houses, collective-farm hangar,
 * Soviet concrete fence, trench segments, log dugout, windbreak trees, AT hedgehogs.
 *
 * Destruction contract (Step 4 / Rapier): `Foundation` is static; every `Wall_Cluster_NN`,
 * `Roof_Cluster_NN`, `Crown_Cluster_NN` and `Trunk_Upper` is a separate node whose origin
 * sits at the fragment's centroid, so it can be detached into a dynamic rigid body as is.
 */

type P2 = [number, number];

function rectHole(cx: number, cy: number, w: number, h: number): P2[] {
  return [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
}

function blobHole(rng: RNG, cx: number, cy: number, r: number): P2[] {
  const pts: P2[] = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * rng.range(0.6, 1.15);
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}

interface WallSegment {
  u0: number; u1: number;
  top: (u: number) => number;
  holes: { hole: P2[]; kind: 'window' | 'door' | 'shell' }[];
  jagged?: number; // 0..1 how much of the top is broken away
}

/** Builds a wall cluster polygon (in wall-plane coords) with jagged breaks. */
function segmentOutline(rng: RNG, s: WallSegment, peakAt?: number): P2[] {
  const pts: P2[] = [[s.u0, 0], [s.u1, 0]];
  const steps = 6;
  const topPts: P2[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = s.u1 - ((s.u1 - s.u0) * i) / steps;
    let v = s.top(u);
    if (s.jagged) v = Math.max(0.5, v - rng.range(0.2, 1) * s.jagged * v);
    topPts.push([u, v]);
  }
  if (peakAt !== undefined && peakAt > s.u0 && peakAt < s.u1 && !s.jagged) {
    const idx = topPts.findIndex(([u]) => u < peakAt);
    topPts.splice(idx, 0, [peakAt, s.top(peakAt)]);
  }
  return pts.concat(topPts);
}

function pointInPoly(x: number, y: number, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface WallDef {
  len: number;
  thickness: number;
  /** maps wall-plane (u, v, w) → model space */
  place: THREE.Matrix4;
  segments: WallSegment[];
  peakAt?: number;
  mat: string;
}

/** Emits each wall segment as its own Wall_Cluster node, centred on the fragment. */
function emitWall(kit: Kit, rng: RNG, root: THREE.Object3D, wall: WallDef, counter: { i: number }): void {
  for (const s of wall.segments) {
    const outline = segmentOutline(rng, s, wall.peakAt);
    const keptHoles = s.holes.filter((h) => h.hole.every(([x, y]) => pointInPoly(x, y, outline)));
    const geom = kit.extrude(outline, wall.thickness, 0, keptHoles.map((h) => h.hole));
    // centroid of the fragment (bbox centre is good enough for a rigid body origin)
    geom.computeBoundingBox();
    const c = geom.boundingBox!.getCenter(new THREE.Vector3());
    const centreModel = c.clone().applyMatrix4(wall.place);
    const name = `Wall_Cluster_${pad(++counter.i)}`;
    const n = node(name, root, centreModel.x, centreModel.y, centreModel.z);
    const local = new THREE.Matrix4().makeTranslation(-centreModel.x, -centreModel.y, -centreModel.z).multiply(wall.place);
    const p = new PartBuilder(kit);
    p.add(geom, wall.mat, local);
    // window / door joinery inside this fragment
    for (const h of keptHoles) {
      if (h.kind === 'shell') continue;
      const xs = h.hole.map((q) => q[0]), ys = h.hole.map((q) => q[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, w = x1 - x0, hh = y1 - y0;
      const m = (g: THREE.BufferGeometry, mat: string, x: number, y: number, z = 0) => p.add(g, mat, local.clone().multiply(T(x, y, z)));
      const fd = wall.thickness * 0.6;
      m(kit.box(w, 0.06, fd), 'wood_planks', cx, y0 + 0.03);
      m(kit.box(w, 0.06, fd), 'wood_planks', cx, y1 - 0.03);
      m(kit.box(0.06, hh, fd), 'wood_planks', x0 + 0.03, cy);
      m(kit.box(0.06, hh, fd), 'wood_planks', x1 - 0.03, cy);
      if (h.kind === 'window') {
        m(kit.box(0.05, hh, 0.05), 'wood_planks', cx, cy);
        m(kit.box(w, 0.05, 0.05), 'wood_planks', cx, y0 + hh * 0.65);
        m(kit.box(w + 0.1, 0.04, wall.thickness + 0.1), 'concrete', cx, y0 - 0.02, 0);
        if (rng.chance(0.4)) m(kit.quad(w / 2 - 0.05, hh * 0.6), 'glass_window', cx - w / 4, cy - hh * 0.1, 0);
        // shutters (Ukrainian village style), one sometimes torn off
        if (rng.chance(0.7)) m(kit.box(w / 2, hh, 0.03), 'wood_planks', x0 - w / 4 - 0.02, cy, -wall.thickness / 2 - 0.03);
      } else if (rng.chance(0.5)) {
        m(kit.box(w - 0.12, hh - 0.06, 0.05), 'wood_planks', cx, cy - 0.03, 0);
      }
    }
    p.emit(n);
  }
}

// ─────────────────────────── rural brick house ───────────────────────────

export function buildHouse(kit: Kit, id: string, damage: number): THREE.Group {
  const rng = new RNG(id);
  const root = node(id, null);
  const W = 8, D = 10, H = 3.0, plinth = 0.5, t = 0.38, ridge = 2.4;
  const foundation = node('Foundation', root);
  const fp = new PartBuilder(kit);
  fp.add(kit.box(W + 0.12, plinth, D + 0.12), 'concrete', T(0, plinth / 2, 0));
  fp.add(kit.box(W - 2 * t, 0.06, D - 2 * t), 'wood_planks', T(0, plinth + 0.03, 0));
  fp.add(kit.box(1.8, 0.18, 1.0), 'concrete', T(-1.2, 0.09, -D / 2 - 0.55));
  fp.add(kit.box(1.8, 0.18, 0.6), 'concrete', T(-1.2, 0.27, -D / 2 - 0.35));
  // inner partition (indestructible core keeps building silhouette readable)
  fp.add(kit.box(0.12, H, D - 2 * t), 'plaster_brick', T(0.6, plinth + H / 2, 0));
  // rubble piles proportional to damage
  for (let i = 0; i < Math.round(damage * 30); i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(W / 2, W / 2 + 1.6);
    fp.add(kit.box(rng.range(0.15, 0.5), rng.range(0.08, 0.25), rng.range(0.15, 0.4), 0.02), rng.chance(0.7) ? 'brick_raw' : 'slate_roof', T(Math.cos(a) * r * 0.9, 0.1, Math.sin(a) * r * 1.1, rng.range(0, 1), rng.range(0, 3), rng.range(0, 1)));
  }
  fp.emit(foundation);

  const top = () => H;
  const gableTop = (u: number) => H + Math.max(0, ridge * (1 - Math.abs(u) / (W / 2)));
  const counter = { i: 0 };
  const seg = (len: number, i: number, topFn: (u: number) => number, holes: WallSegment['holes']): WallSegment => {
    const u0 = -len / 2 + (len * i) / 4, u1 = -len / 2 + (len * (i + 1)) / 4;
    const jag = rng.chance(damage) ? rng.range(0.3, 0.9) * damage : 0;
    const shell = rng.chance(damage * 0.8) ? [{ hole: blobHole(rng, (u0 + u1) / 2 + rng.range(-0.3, 0.3), rng.range(0.8, 1.8), rng.range(0.35, 0.6)), kind: 'shell' as const }] : [];
    return { u0, u1, top: topFn, holes: [...holes, ...(holes.length ? [] : shell)], jagged: jag };
  };
  const win = (len: number, i: number): WallSegment['holes'] => {
    const cu = -len / 2 + (len * (i + 0.5)) / 4;
    return [{ hole: rectHole(cu, 1.55, 1.1, 1.3), kind: 'window' }];
  };
  const door = (len: number, i: number): WallSegment['holes'] => {
    const cu = -len / 2 + (len * (i + 0.5)) / 4;
    return [{ hole: [[cu - 0.5, 0.0], [cu + 0.5, 0.0], [cu + 0.5, 2.1], [cu - 0.5, 2.1]] as P2[], kind: 'door' }];
  };
  // door hole starts at v=0 → outline must notch rather than hole; handled by keeping v slightly above 0
  const doorFix = (h: WallSegment['holes']) => h.map((x) => (x.kind === 'door' ? { ...x, hole: x.hole.map(([a, b]) => [a, Math.max(b, 0.02)] as P2) } : x));

  const walls: WallDef[] = [
    { len: W, thickness: t, place: T(0, plinth, -D / 2 + t / 2), peakAt: 0, mat: 'plaster_brick', segments: [0, 1, 2, 3].map((i) => seg(W, i, gableTop, i === 1 ? doorFix(door(W, i)) : i === 2 ? win(W, i) : [])) },
    { len: W, thickness: t, place: T(0, plinth, D / 2 - t / 2, 0, Math.PI), peakAt: 0, mat: 'plaster_brick', segments: [0, 1, 2, 3].map((i) => seg(W, i, gableTop, i === 1 || i === 2 ? win(W, i) : [])) },
    { len: D - 2 * t, thickness: t, place: T(-W / 2 + t / 2, plinth, 0, 0, Math.PI / 2), mat: 'plaster_brick', segments: [0, 1, 2, 3].map((i) => seg(D - 2 * t, i, top, i !== 2 ? win(D - 2 * t, i) : [])) },
    { len: D - 2 * t, thickness: t, place: T(W / 2 - t / 2, plinth, 0, 0, -Math.PI / 2), mat: 'plaster_brick', segments: [0, 1, 2, 3].map((i) => seg(D - 2 * t, i, top, i !== 1 ? win(D - 2 * t, i) : [])) },
  ];
  for (const w of walls) emitWall(kit, rng, root, w, counter);

  // gable roof: 2 slopes × 4 clusters along the ridge (Z)
  const overhang = 0.45;
  const half = W / 2 + overhang;
  const pitch = Math.atan2(ridge, W / 2);
  const slopeLen = half / Math.cos(pitch);
  const segD = (D + 2 * overhang) / 4;
  let rc = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -D / 2 - overhang + segD * (i + 0.5);
      const cx = side * half / 2;
      const cy = plinth + H + ridge - (ridge + overhang * Math.tan(pitch)) / 2;
      const name = `Roof_Cluster_${pad(++rc)}`;
      const n = node(name, root, cx, cy, z);
      const p = new PartBuilder(kit);
      const tilt = side * -pitch;
      const missing = rng.chance(damage * 0.7);
      const ridgeRel = plinth + H + ridge - cy;
      const downX = side * Math.cos(pitch), downY = -Math.sin(pitch);
      if (!missing) {
        const broken = rng.chance(damage) ? rng.range(0.45, 0.85) : 1;
        const shift = -(1 - broken) * slopeLen * 0.5; // keep the part attached near the ridge
        p.add(kit.box(slopeLen * broken, 0.05, segD - 0.02), 'slate_roof', T(downX * shift, 0.12 + downY * shift, 0, 0, 0, tilt));
        if (side === 1) p.add(kit.box(0.24, 0.06, segD), 'concrete', T(-cx, ridgeRel + 0.15, 0));
      }
      // rafters (charred when exposed)
      for (const dz of [-segD / 3, segD / 3]) p.add(kit.box(slopeLen, 0.14, 0.07), missing ? 'bark_charred' : 'logs', T(0, 0.02, dz, 0, 0, tilt));
      if (side === 1 && i === 2 && !missing) p.add(kit.box(0.5, 1.4, 0.5), 'brick_raw', T(-cx + 0.9, ridgeRel - 0.2, 0)); // chimney
      p.emit(n);
    }
  }
  return root;
}

// ─────────────────────────── collective-farm hangar ───────────────────────────

export function buildHangar(kit: Kit, id: string): THREE.Group {
  const rng = new RNG(id);
  const root = node(id, null);
  const W = 18, D = 30, Hs = 4.5, rise = 3.6, t = 0.25;
  const fp = new PartBuilder(kit);
  fp.add(kit.box(W + 0.4, 0.3, D + 0.4), 'concrete', T(0, 0.15, 0));
  for (let i = 0; i <= 6; i++) for (const sx of [-1, 1]) fp.add(kit.box(0.25, Hs, 0.25), 'rust', T(sx * (W / 2 - 0.2), 0.3 + Hs / 2, -D / 2 + (D * i) / 6));
  fp.emit(node('Foundation', root));
  const counter = { i: 0 };
  // long corrugated side walls: 6 clusters each
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const segLen = D / 6;
      const z = -D / 2 + segLen * (i + 0.5);
      const n = node(`Wall_Cluster_${pad(++counter.i)}`, root, sx * (W / 2 - 0.05), 0.3 + Hs / 2, z);
      const p = new PartBuilder(kit);
      const holed = rng.chance(0.3);
      const outline: P2[] = [[-segLen / 2, -Hs / 2], [segLen / 2, -Hs / 2], [segLen / 2, Hs / 2], [-segLen / 2, Hs / 2]];
      const holes = holed ? [blobHole(rng, rng.range(-1.5, 1.5), rng.range(-0.8, 1.0), rng.range(0.4, 0.9))] : [];
      p.add(kit.extrude(outline, 0.04, 0, holes), 'corrugated_rust', T(0, 0, 0, 0, Math.PI / 2));
      p.add(kit.box(0.06, 0.12, segLen), 'rust', T(0, Hs / 2 - 0.3, 0));
      p.emit(n);
    }
  }
  // brick gable ends: 2 halves each with door notch
  const arch = (x: number) => Hs + rise * Math.sqrt(Math.max(0, 1 - (x / (W / 2)) ** 2));
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const pts: P2[] = [[sx * 3.5, 0], [sx * (W / 2), 0]];
      for (let k = 0; k <= 10; k++) { const x = sx * (W / 2) * (1 - k / 10); pts.push([x, arch(x)]); }
      pts.push([0, 4.2], [sx * 3.5, 4.2]);
      const ordered = sx < 0 ? pts.reverse() : pts;
      const g = kit.extrude(ordered, t);
      g.computeBoundingBox();
      const c = g.boundingBox!.getCenter(new THREE.Vector3());
      const place = T(0, 0.3, sz * (D / 2 - t / 2));
      const cm = c.clone().applyMatrix4(place);
      const n = node(`Wall_Cluster_${pad(++counter.i)}`, root, cm.x, cm.y, cm.z);
      const p = new PartBuilder(kit);
      p.add(g, 'brick_raw', new THREE.Matrix4().makeTranslation(-cm.x, -cm.y, -cm.z).multiply(place));
      p.emit(n);
    }
  }
  // arched roof: 8 clusters along Z
  const segD = D / 8;
  for (let i = 0; i < 8; i++) {
    const z = -D / 2 + segD * (i + 0.5);
    const n = node(`Roof_Cluster_${pad(i + 1)}`, root, 0, 0.3 + Hs + rise * 0.6, z);
    const outer: P2[] = [], inner: P2[] = [];
    for (let k = 0; k <= 16; k++) {
      const a = Math.PI * (k / 16);
      outer.push([Math.cos(a) * (W / 2 + 0.3), Math.sin(a) * (rise + 0.1) - rise * 0.6]);
      inner.push([Math.cos(a) * (W / 2 + 0.2), Math.sin(a) * rise - rise * 0.6]);
    }
    const shape = outer.concat(inner.reverse());
    const p = new PartBuilder(kit);
    if (!rng.chance(0.2)) p.add(kit.extrude(shape, segD - 0.03), 'corrugated_rust');
    // steel truss arch
    p.add(kit.extrude(inner.map(([x, y]) => [x * 0.99, y - 0.02] as P2).concat(inner.map(([x, y]) => [x * 0.97, y - 0.22] as P2).reverse()), 0.15), 'rust');
    p.emit(n);
  }
  return root;
}

// ─────────────────────────── Soviet concrete fence ───────────────────────────

export function buildFence(kit: Kit, id: string): THREE.Group {
  const rng = new RNG(id);
  const root = node(id, null);
  const fp = new PartBuilder(kit);
  for (const x of [-3.05, 0, 3.05]) {
    fp.add(kit.box(0.26, 2.6, 0.26, 0.01), 'concrete', T(x, 1.3, 0));
    fp.add(kit.box(0.4, 0.1, 0.4), 'concrete', T(x, 0.05, 0));
  }
  fp.emit(node('Foundation', root));
  let k = 0;
  for (const px of [-1.525, 1.525]) {
    for (const [qx, qy] of [[-1, 0], [1, 0], [-1, 1], [1, 1]] as const) {
      const w = 1.43, h = 1.22;
      const cx = px + qx * (w / 2 + 0.005), cy = 0.12 + h / 2 + qy * (h + 0.01);
      const n = node(`Wall_Cluster_${pad(++k)}`, root, cx, cy, 0);
      const holes: P2[][] = [];
      if (qy === 1) {
        // decorative rhombus pattern (ПО-2 style) in the upper panel half
        for (let i = 0; i < 3; i++) {
          const hx = -w / 2 + 0.25 + i * 0.45, hy = 0;
          holes.push([[hx, hy - 0.22], [hx + 0.17, hy], [hx, hy + 0.22], [hx - 0.17, hy]]);
        }
      } else if (rng.chance(0.25)) holes.push(blobHole(rng, rng.range(-0.3, 0.3), rng.range(-0.2, 0.2), 0.22));
      const p = new PartBuilder(kit);
      p.add(kit.extrude([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], 0.12, 0.01, holes), 'concrete');
      if (qy === 0) for (let r = 0; r < 3; r++) p.add(kit.box(w - 0.1, 0.05, 0.03), 'concrete', T(0, -h / 2 + 0.25 + r * 0.35, -0.07));
      p.emit(n);
    }
  }
  return root;
}

// ─────────────────────────── trench & dugout ───────────────────────────

function sandbag(kit: Kit): THREE.BufferGeometry {
  return kit.box(0.55, 0.16, 0.32, 0.07);
}

export function buildTrench(kit: Kit, id: string): THREE.Group {
  const rng = new RNG(id);
  const root = node(id, null);
  const L = 8, half = 0.55, depth = 1.45;
  const fp = new PartBuilder(kit);
  for (const sx of [-1, 1]) {
    const bank: P2[] = [[sx * half, -depth], [sx * 1.7, -depth], [sx * 1.7, 0], [sx * 1.25, 0.18], [sx * 0.75, 0.22], [sx * half, 0]];
    fp.add(kit.extrude(sx < 0 ? bank.reverse() : bank, L), 'soil');
  }
  fp.add(kit.box(half * 2, 0.1, L), 'mud', T(0, -depth - 0.05, 0));
  // duckboards
  for (let i = 0; i < 10; i++) fp.add(kit.box(0.7, 0.04, 0.6), 'wood_planks', T(0, -depth + 0.06, -L / 2 + 0.4 + i * 0.8, 0, rng.range(-0.04, 0.04)));
  fp.emit(node('Foundation', root));
  let k = 0;
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -L / 2 + 1 + i * 2;
      const n = node(`Wall_Cluster_${pad(++k)}`, root, sx * (half - 0.04), -depth / 2 + 0.1, z);
      const p = new PartBuilder(kit);
      p.add(kit.box(0.05, depth, 1.96), 'wood_planks', T(0, -0.1, 0));
      for (const dz of [-0.95, 0.95]) p.add(kit.cyl(0.07, 0.07, depth + 0.3, 8), 'logs', T(0, 0, dz));
      // sandbag parapet on top of this revetment bay
      for (let b = 0; b < 4; b++) p.add(sandbag(kit), 'sandbag', T(sx * 0.3, depth / 2 + 0.05 + (b % 2) * 0.15, -0.75 + b * 0.5, 0, Math.PI / 2 + rng.range(-0.15, 0.15)));
      p.emit(n);
    }
  }
  return root;
}

export function buildDugout(kit: Kit, id: string): THREE.Group {
  const rng = new RNG(id);
  const root = node(id, null);
  const fp = new PartBuilder(kit);
  const Wd = 4.2, Dd = 4.8, depth = 2.0;
  // inner plank lining (inward facing) and floor
  fp.add(kit.box(Wd, depth, Dd), 'interior_shell', T(0, -depth / 2, 0));
  for (const sx of [-1, 1]) fp.add(kit.box(0.06, depth, Dd), 'logs', T(sx * Wd / 2, -depth / 2, 0));
  fp.add(kit.box(Wd, 0.06, Dd), 'wood_planks', T(0, -depth + 0.03, 0));
  // surrounding earth berm
  fp.add(kit.lathe([[0, 0.35], [2.6, 0.3], [3.3, 0.0], [3.3, -0.1], [0, -0.1]], 18).scale(0.85, 1, 1), 'soil', T(0, 0, 0));
  // bunks, stove
  fp.add(kit.box(0.8, 0.06, 2.0), 'wood_planks', T(-1.5, -depth + 0.6, -0.8));
  fp.add(kit.cyl(0.25, 0.25, 0.6, 12), 'rust', T(1.4, -depth + 0.3, -1.6));
  fp.add(kit.cyl(0.06, 0.06, 2.4, 8), 'rust', T(1.4, -0.8, -1.6));
  // firing slit on the front
  fp.add(kit.box(1.2, 0.2, 0.3), 'logs', T(0, -0.15, -Dd / 2 - 0.1));
  fp.emit(node('Foundation', root));
  // roof: 8 log bundles with earth cover
  const strip = Dd / 8;
  for (let i = 0; i < 8; i++) {
    const z = -Dd / 2 + strip * (i + 0.5);
    const n = node(`Roof_Cluster_${pad(i + 1)}`, root, 0, 0.1, z);
    const p = new PartBuilder(kit);
    for (let l = 0; l < 2; l++) p.add(kit.cylX(0.13, Wd + 0.8 + rng.range(-0.2, 0.2), 10), 'logs', T(rng.range(-0.1, 0.1), -0.05, -strip / 4 + l * (strip / 2)));
    p.add(kit.box(Wd + 0.6, 0.25, strip, 0.08), 'soil', T(0, 0.17, 0));
    p.emit(n);
  }
  // entrance with stairs
  const ent = node('Entrance', root, 0, 0, Dd / 2 + 0.9);
  const ep = new PartBuilder(kit);
  for (let s = 0; s < 6; s++) ep.add(kit.box(1.0, 0.06, 0.3), 'wood_planks', T(0, -0.25 - s * 0.3, -0.8 + s * 0.28 - 0.9));
  for (const sx of [-1, 1]) ep.add(kit.box(0.06, depth, 1.8), 'wood_planks', T(sx * 0.55, -depth / 2, -0.7));
  ep.add(kit.box(1.2, 0.15, 0.15), 'logs', T(0, -0.05, -1.55));
  ep.emit(ent);
  return root;
}

// ─────────────────────────── trees ───────────────────────────

function foliageCards(kit: Kit, p: PartBuilder, rng: RNG, center: THREE.Vector3, radius: THREE.Vector3, count: number, size: number): void {
  for (let i = 0; i < count; i++) {
    const dir = new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize();
    const r = Math.cbrt(rng.next());
    const pos = new THREE.Vector3(dir.x * radius.x * r, dir.y * radius.y * r, dir.z * radius.z * r).add(center);
    const g = kit.quad(size * rng.range(0.7, 1.3), size * rng.range(0.7, 1.3));
    g.applyMatrix4(T(pos.x, pos.y, pos.z, rng.range(0, Math.PI), rng.range(0, Math.PI * 2), rng.range(0, Math.PI)));
    // bend card normals outward from the crown centre → soft, volumetric shading
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    const out = pos.clone().sub(center).normalize().multiplyScalar(0.8).add(new THREE.Vector3(0, 0.4, 0)).normalize();
    for (let k = 0; k < nrm.count; k++) nrm.setXYZ(k, out.x, out.y, out.z);
    p.add(g, 'foliage');
  }
}

export function buildTree(kit: Kit, id: string, kind: 'poplar' | 'acacia' | 'scorched'): THREE.Group {
  const rng = new RNG(id);
  const root = node(id, null);
  const Ht = kind === 'poplar' ? 16 : kind === 'acacia' ? 10 : 9;
  const r0 = kind === 'poplar' ? 0.34 : kind === 'acacia' ? 0.3 : 0.28;
  const bark = kind === 'scorched' ? 'bark_charred' : 'bark';
  const lean = kind === 'acacia' ? 0.6 : kind === 'scorched' ? 0.3 : 0.15;
  const cut = 1.2;
  // trunk curve
  const pts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(lean * 0.2, Ht * 0.3, 0.05), new THREE.Vector3(lean * 0.6, Ht * 0.65, -lean * 0.2), new THREE.Vector3(lean, Ht * (kind === 'scorched' ? 0.82 : 0.95), 0)];
  const curve = new THREE.CatmullRomCurve3(pts);
  const fp = new PartBuilder(kit);
  const lower = new THREE.CatmullRomCurve3([curve.getPointAt(0), curve.getPointAt(0.04), curve.getPointAt(cut / Ht)]);
  fp.add(kit.tube(lower, r0 * 1.15, r0 * 0.95, 3, Math.max(8, kit.radial - 4), false), bark);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng.range(0, 1);
    fp.add(kit.tube(new THREE.LineCurve3(new THREE.Vector3(0, 0.25, 0), new THREE.Vector3(Math.cos(a) * 0.7, -0.1, Math.sin(a) * 0.7)), r0 * 0.45, 0.04, 2, 6), bark);
  }
  fp.emit(node('Foundation', root));

  const tPt = curve.getPointAt(cut / Ht);
  const up = node('Trunk_Upper', root, tPt.x, tPt.y, tPt.z);
  const up3 = (v: THREE.Vector3) => v.clone().sub(tPt);
  const tp = new PartBuilder(kit);
  const upperPts = [];
  for (let i = 0; i <= 6; i++) upperPts.push(up3(curve.getPointAt(cut / Ht + (1 - cut / Ht) * (i / 6))));
  tp.add(kit.tube(new THREE.CatmullRomCurve3(upperPts), r0 * 0.95, kind === 'scorched' ? r0 * 0.4 : 0.05, 10, Math.max(8, kit.radial - 4), true), bark);
  tp.emit(up);

  // crown clusters
  const crown: { c: THREE.Vector3; r: THREE.Vector3 }[] = [];
  if (kind === 'poplar') {
    for (let i = 0; i < 4; i++) crown.push({ c: new THREE.Vector3(lean * (0.3 + i * 0.2), 5 + i * 2.8, 0), r: new THREE.Vector3(1.9 - i * 0.25, 1.9, 1.9 - i * 0.25) });
  } else if (kind === 'acacia') {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      crown.push({ c: new THREE.Vector3(lean + Math.cos(a) * 1.7, 7 + (i % 2) * 0.8, Math.sin(a) * 1.7), r: new THREE.Vector3(2.0, 1.5, 2.0) });
    }
  } else {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.7;
      crown.push({ c: new THREE.Vector3(lean * 0.8 + Math.cos(a) * 0.6, 5.5 + i * 0.6, Math.sin(a) * 0.6), r: new THREE.Vector3(1.6, 1.4, 1.6) });
    }
  }
  const cards = Math.round(kit.q.radial * (kind === 'poplar' ? 4 : 5));
  crown.forEach(({ c, r }, i) => {
    const cl = node(`Crown_Cluster_${pad(i + 1)}`, up, c.x - tPt.x, c.y - tPt.y, c.z - tPt.z);
    const p = new PartBuilder(kit);
    const origin = new THREE.Vector3(0, 0, 0);
    const trunkAt = up3(curve.getPointAt(Math.min(0.95, c.y / Ht))).sub(cl.position);
    // branches from trunk into the cluster
    for (let b = 0; b < 4; b++) {
      const end = new THREE.Vector3(rng.range(-r.x, r.x) * 0.8, rng.range(-r.y, r.y) * 0.6, rng.range(-r.z, r.z) * 0.8);
      const mid = trunkAt.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 0.4, 0));
      const broken = kind === 'scorched' && rng.chance(0.5);
      const e = broken ? trunkAt.clone().lerp(end, rng.range(0.35, 0.7)) : end;
      p.add(kit.tube(new THREE.QuadraticBezierCurve3(trunkAt, mid, e), kind === 'scorched' ? 0.09 : 0.07, 0.015, 5, 6), bark);
    }
    if (kind !== 'scorched') foliageCards(kit, p, rng, origin, r, cards, kind === 'poplar' ? 1.1 : 1.3);
    p.emit(cl);
  });
  return root;
}

// ─────────────────────────── anti-tank hedgehog ───────────────────────────

export function buildHedgehog(kit: Kit, id: string): THREE.Group {
  const root = node(id, null);
  const p = new PartBuilder(kit);
  const ibeam = () => {
    const f = 0.16, w = 0.012, hgt = 0.16;
    const sec: P2[] = [[-f / 2, -hgt / 2], [f / 2, -hgt / 2], [f / 2, -hgt / 2 + w * 1.5], [w / 2, -hgt / 2 + w * 1.5], [w / 2, hgt / 2 - w * 1.5], [f / 2, hgt / 2 - w * 1.5], [f / 2, hgt / 2], [-f / 2, hgt / 2], [-f / 2, hgt / 2 - w * 1.5], [-w / 2, hgt / 2 - w * 1.5], [-w / 2, -hgt / 2 + w * 1.5], [-f / 2, -hgt / 2 + w * 1.5]];
    return kit.extrude(sec, 2.0);
  };
  // three mutually perpendicular beams, the whole star tilted so it rests on three tips
  // body diagonal (1,1,1) → vertical: each beam sits at 54.7° and the three lower tips touch the ground
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 1, 1).normalize(), new THREE.Vector3(0, 1, 0));
  const star = new THREE.Matrix4().compose(new THREE.Vector3(0, 1.0 / Math.sqrt(3) + 0.06, 0), q, new THREE.Vector3(1, 1, 1));
  p.add(ibeam(), 'rust', star.clone().multiply(T(0, 0, 0, 0, Math.PI / 2, 0)));
  p.add(ibeam(), 'rust', star.clone().multiply(T(0, 0, 0, Math.PI / 2, 0, 0)));
  p.add(ibeam(), 'rust', star.clone());
  p.add(kit.box(0.3, 0.3, 0.3), 'rust', star.clone());
  p.emit(node('Foundation', root));
  return root;
}
