// Step 2 for characters: fit the game's Humanoid rig (same bone names/hierarchy as
// src/assets/procedural/builders/soldier.ts, identity bind rotations) to a prepped A-pose mesh
// and bake skin weights. The runtime copies the fitted bone offsets onto the procedural skeleton,
// so locomotion clips, aim IK and the weapon mount keep working unchanged.
// usage: node tools/tripo-skin.mjs prepped.glb out.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const [, , inp, out] = process.argv;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
const root = doc.getRoot();
const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
const all = [];
for (const p of prims) { const a = p.getAttribute('POSITION'), v = [0, 0, 0]; for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); all.push([...v]); } }

// ── fit joints (character faces −Z, right side = +X, feet at y=0) ──
const H = Math.max(...all.map((v) => v[1]));
const k = H / 1.8;
const tip = (s) => all.filter((v) => v[1] > 0.33 * H && v[1] < 0.78 * H).reduce((b, v) => (s * v[0] > s * b[0] ? v : b));
const meanX = (s, y0, y1) => { const b = all.filter((v) => s * v[0] > 0.02 && v[1] > y0 && v[1] < y1 && s * v[0] < 0.3 * k); return b.reduce((a, v) => a + v[0], 0) / b.length; };
const J = {};
J.Root = [0, 0, 0];
J.Pelvis = [0, 0.98 * k, 0];
J.Spine = [0, 1.08 * k, 0];
J.Chest = [0, 1.25 * k, 0];
J.Neck = [0, 1.47 * k, 0];
J.Head = [0, 1.57 * k, 0];
for (const [s, side] of [[-1, 'Left'], [1, 'Right']]) {
  const S = [s * 0.19 * k, 1.4 * k, -0.02 * k];
  const F = tip(s);
  const d = F.map((x, i) => x - S[i]), L = Math.hypot(...d), u = d.map((x) => x / L);
  const at = (t) => S.map((x, i) => x + u[i] * L * t);
  J[`${side}Shoulder`] = [s * 0.04 * k, 1.42 * k, -0.02 * k];
  J[`${side}Arm`] = S;
  J[`${side}ForeArm`] = at(0.46);
  J[`${side}Hand`] = at(0.8);
  J[`${side}_tip`] = F;
  if (s > 0) J.WeaponMount_R = at(0.88);
  const kx = meanX(s, 0.4 * H, 0.55 * H), ax = meanX(s, 0.08 * H, 0.18 * H);
  J[`${side}UpLeg`] = [s * 0.1 * k, 0.93 * k, 0];
  J[`${side}Leg`] = [kx, 0.5 * k, 0];
  J[`${side}Foot`] = [ax, 0.08 * k, 0];
  J[`${side}_toe`] = [ax, 0.03 * k, -0.16 * k];
}
const PARENT = {
  Root: null, Pelvis: 'Root', Spine: 'Pelvis', Chest: 'Spine', Neck: 'Chest', Head: 'Neck',
  LeftShoulder: 'Chest', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Chest', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
  LeftUpLeg: 'Pelvis', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg',
  RightUpLeg: 'Pelvis', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg',
  WeaponMount_R: 'RightHand',
};
const BONES = Object.keys(PARENT);

// segments + limb radii for normalised distance
const SEG = {
  Pelvis: [J.Pelvis, J.Spine, 0.16], Spine: [J.Spine, J.Chest, 0.17], Chest: [J.Chest, J.Neck, 0.18],
  Neck: [J.Neck, J.Head, 0.07], Head: [J.Head, [0, H, 0], 0.11],
};
for (const side of ['Left', 'Right']) {
  SEG[`${side}Shoulder`] = [J[`${side}Shoulder`], J[`${side}Arm`], 0.07];
  SEG[`${side}Arm`] = [J[`${side}Arm`], J[`${side}ForeArm`], 0.055];
  SEG[`${side}ForeArm`] = [J[`${side}ForeArm`], J[`${side}Hand`], 0.055];
  SEG[`${side}Hand`] = [J[`${side}Hand`], J[`${side}_tip`], 0.05];
  SEG[`${side}UpLeg`] = [J[`${side}UpLeg`], J[`${side}Leg`], 0.09];
  SEG[`${side}Leg`] = [J[`${side}Leg`], J[`${side}Foot`], 0.07];
  SEG[`${side}Foot`] = [J[`${side}Foot`], J[`${side}_toe`], 0.06];
}
const segDist = (p, [a, b]) => {
  const ab = b.map((x, i) => x - a[i]), ap = p.map((x, i) => x - a[i]);
  const t = Math.max(0, Math.min(1, ap.reduce((s, x, i) => s + x * ab[i], 0) / (ab.reduce((s, x) => s + x * x, 0) || 1)));
  return Math.hypot(...p.map((x, i) => x - (a[i] + ab[i] * t)));
};
const segNames = Object.keys(SEG);
function weightsFor(p) {
  const side = p[0] >= 0 ? 'Right' : 'Left', other = side === 'Right' ? 'Left' : 'Right';
  const c = [];
  for (const n of segNames) {
    if (n.startsWith(other) && Math.abs(p[0]) > 0.03 * k) continue; // never bind across the midline
    const d = segDist(p, SEG[n]) / (SEG[n][2] * k);
    c.push([n, d]);
  }
  c.sort((a, b) => a[1] - b[1]);
  const top = c.slice(0, 3).map(([n, d]) => [n, 1 / Math.pow(Math.max(d, 0.05), 6)]);
  const sum = top.reduce((s, x) => s + x[1], 0);
  return top.map(([n, w]) => [BONES.indexOf(n), w / sum]); // [boneIndex, share], strongest first
}

// ── weights: geodesic (surface) distance from each bone's core vertices, so an arm hanging
// next to the vest never drags torso vertices along. Then light Laplacian smoothing. ──
for (const p of prims) {
  const pos = p.getAttribute('POSITION'), n = pos.getCount(), v = [0, 0, 0];
  const key = (i) => { pos.getElement(i, v); return v.map((x) => Math.round(x * 2000)).join(','); };
  const weldId = new Map(), wid = new Int32Array(n);
  for (let i = 0; i < n; i++) { const kk = key(i); if (!weldId.has(kk)) weldId.set(kk, weldId.size); wid[i] = weldId.get(kk); }
  const N = weldId.size, P = new Array(N);
  for (let i = 0; i < n; i++) { pos.getElement(i, v); P[wid[i]] = [...v]; }
  const adj = Array.from({ length: N }, () => new Map());
  const idx = p.getIndices().getArray();
  for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = wid[idx[t + e]], b = wid[idx[t + (e + 1) % 3]];
    if (a === b) continue;
    const d = Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]);
    adj[a].set(b, d); adj[b].set(a, d);
  }
  // per-vertex euclidean ranking (also the fallback for detached shells)
  const eu = P.map((q) => weightsFor(q));
  // seeds: vertices whose nearest bone (normalised) is clearly this one and close to its axis
  const D = {};
  for (const name of segNames) {
    const bi = BONES.indexOf(name), r = SEG[name][2] * k;
    const dist = new Float64Array(N).fill(Infinity);
    const heap = [];
    const push = (i, d) => { heap.push([d, i]); let c = heap.length - 1; while (c > 0) { const pa = (c - 1) >> 1; if (heap[pa][0] <= heap[c][0]) break; [heap[pa], heap[c]] = [heap[c], heap[pa]]; c = pa; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, rr = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    for (let i = 0; i < N; i++) {
      const e = eu[i][0];
      if (e[0] === bi && e[1] > 0.6 && segDist(P[i], SEG[name]) < r * 1.2) { dist[i] = segDist(P[i], SEG[name]); push(i, dist[i]); }
    }
    while (heap.length) {
      const [d, i] = pop(); if (d > dist[i]) continue;
      for (const [j, w] of adj[i]) { const nd = d + w; if (nd < dist[j]) { dist[j] = nd; push(j, nd); } }
    }
    D[name] = dist;
  }
  let WW = new Array(N);
  for (let i = 0; i < N; i++) {
    const c = [];
    for (const name of segNames) if (Number.isFinite(D[name][i])) c.push([BONES.indexOf(name), 1 / Math.pow(D[name][i] / (SEG[name][2] * k) + 0.35, 6)]);
    if (!c.length) { WW[i] = new Map(eu[i]); continue; }
    c.sort((a, b) => b[1] - a[1]);
    const top = c.slice(0, 3), sum = top.reduce((a, x) => a + x[1], 0);
    WW[i] = new Map(top.map(([b, w]) => [b, w / sum]));
  }
  for (let it = 0; it < 2; it++) {
    WW = WW.map((m, i) => {
      const nb = [...adj[i].keys()]; if (!nb.length) return m;
      const r = new Map(); for (const [b, w] of m) r.set(b, w * 0.6);
      for (const j of nb) for (const [b, w] of WW[j]) r.set(b, (r.get(b) ?? 0) + (0.4 * w) / nb.length);
      return r;
    });
  }
  const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const top = [...WW[wid[i]]].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const s = top.reduce((a, x) => a + x[1], 0);
    top.forEach(([b, w], j) => { joints[i * 4 + j] = b; weights[i * 4 + j] = w / s; });
  }
  const buf = root.listBuffers()[0];
  p.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(joints).setBuffer(buf));
  p.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(weights).setBuffer(buf));
}

// ── skeleton nodes + skin ──
const scene = root.listScenes()[0];
const nodes = {};
for (const b of BONES) {
  const par = PARENT[b];
  const pw = par ? J[par] : [0, 0, 0];
  nodes[b] = doc.createNode(b).setTranslation(J[b].map((x, i) => x - pw[i]));
  if (par) nodes[par].addChild(nodes[b]); else scene.addChild(nodes[b]);
}
const ibm = new Float32Array(BONES.length * 16);
BONES.forEach((b, i) => { ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -J[b][0], -J[b][1], -J[b][2], 1], i * 16); });
const skin = doc.createSkin('Humanoid').setSkeleton(nodes.Root).setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(ibm).setBuffer(root.listBuffers()[0]));
for (const b of BONES) skin.addJoint(nodes[b]);
for (const node of root.listNodes()) if (node.getMesh()) { node.setSkin(skin).setName('Body'); }
await io.write(out, doc);
console.log('joints', Object.fromEntries(BONES.map((b) => [b, J[b].map((x) => +x.toFixed(3))])));
