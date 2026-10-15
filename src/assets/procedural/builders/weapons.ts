import * as THREE from 'three';
import { deg, type Kit, node, PartBuilder, T } from '../Kit';

/**
 * Infantry weapons & crew-served systems. Convention: origin = pistol grip / mount point,
 * barrel along −Z, +Y up. Nodes: Body, Magazine, Sight, Muzzle, Grip_Point, Aim_Point.
 */

export function buildRifle(kit: Kit, kind: 'ar' | 'ak'): THREE.Group {
  const root = node(kind === 'ar' ? 'rifle_ar' : 'rifle_ak', null);
  const body = node('Body', root);
  const magN = node('Magazine', root, 0, -0.035, kind === 'ar' ? -0.075 : -0.11);
  const sightN = node('Sight', root, 0, kind === 'ar' ? 0.1 : 0.105, kind === 'ar' ? -0.07 : -0.03);
  node('Grip_Point', root, 0, 0, 0);
  node('Support_Point', root, 0, 0.03, kind === 'ar' ? -0.33 : -0.36);

  const p = new PartBuilder(kit);
  const sp = new PartBuilder(kit);
  const mp = new PartBuilder(kit);
  const r = Math.max(8, kit.radial - 4);

  if (kind === 'ar') {
    // lower receiver + magwell
    p.add(kit.box(0.032, 0.055, 0.2, 0.006), 'gunmetal', T(0, 0.025, -0.06));
    p.add(kit.box(0.036, 0.04, 0.07, 0.004), 'gunmetal', T(0, -0.01, -0.075));
    // trigger guard
    p.add(kit.box(0.006, 0.006, 0.07), 'gunmetal', T(0, -0.012, -0.015));
    // upper receiver + top rail
    p.add(kit.box(0.034, 0.045, 0.24, 0.005), 'gunmetal', T(0, 0.072, -0.07));
    for (let i = 0; i < 14; i++) p.add(kit.box(0.022, 0.008, 0.008), 'gunmetal', T(0, 0.099, 0.04 - i * 0.017));
    // charging handle, forward assist, ejection port cover
    p.add(kit.box(0.04, 0.008, 0.03), 'gunmetal', T(0, 0.09, 0.055));
    p.add(kit.cylZ(0.008, 0.03, 8), 'gunmetal', T(0.022, 0.08, 0.0));
    // free-float M-LOK handguard (octagonal) + top rail continuation
    p.add(kit.cylZ(0.024, 0.34, 8), 'gunmetal', T(0, 0.074, -0.36, 0, 0, Math.PI / 8));
    for (let i = 0; i < 18; i++) p.add(kit.box(0.02, 0.007, 0.008), 'gunmetal', T(0, 0.099, -0.2 - i * 0.018));
    // barrel, gas block, muzzle brake
    p.add(kit.cylZ(0.0095, 0.14, r), 'gunmetal', T(0, 0.074, -0.6));
    p.add(kit.cylZ(0.014, 0.065, r), 'steel_bare', T(0, 0.074, -0.69));
    // pistol grip
    p.add(kit.box(0.03, 0.095, 0.035, 0.008), 'polymer_tan', T(0, -0.035, 0.02, deg(-22)));
    // buffer tube + adjustable stock
    p.add(kit.cylZ(0.015, 0.16, r), 'gunmetal', T(0, 0.07, 0.11));
    p.add(kit.profileX([[0.12, 0.1], [0.32, 0.1], [0.34, 0.07], [0.34, -0.02], [0.3, -0.03], [0.2, 0.04], [0.12, 0.05]], 0.04, 0.004), 'polymer_tan', T(0, 0, -0.08));
    p.add(kit.box(0.044, 0.13, 0.015, 0.004), 'rubber_black', T(0, 0.035, 0.265));
    // vertical foregrip + weapon light
    p.add(kit.cyl(0.015, 0.017, 0.09, r), 'polymer_tan', T(0, 0.01, -0.36));
    p.add(kit.cylZ(0.014, 0.1, r), 'polymer_black', T(0.032, 0.074, -0.47));
    p.add(kit.cylZ(0.009, 0.004, r), 'glass_optic', T(0.032, 0.074, -0.522));
    // PMAG (curved, polymer)
    mp.add(kit.profileX([[-0.03, 0], [0.03, 0], [0.042, -0.08], [0.055, -0.17], [-0.005, -0.18], [-0.012, -0.09]], 0.026, 0.003), 'polymer_black', T(0, 0, 0));
    for (let i = 0; i < 3; i++) mp.add(kit.box(0.028, 0.004, 0.05), 'polymer_black', T(0, -0.04 - i * 0.04, 0.005 + i * 0.006));
  } else {
    // AK receiver with dust cover
    p.add(kit.box(0.032, 0.06, 0.25, 0.004), 'gunmetal', T(0, 0.03, -0.06));
    p.add(kit.cylZ(0.017, 0.25, 12).scale(1, 0.6, 1), 'gunmetal', T(0, 0.06, -0.06));
    // side-rail mount (for collimator)
    p.add(kit.box(0.012, 0.03, 0.12), 'gunmetal', T(0.022, 0.05, -0.03));
    // trigger guard
    p.add(kit.box(0.006, 0.006, 0.08), 'gunmetal', T(0, -0.012, -0.03));
    // polymer handguard + gas tube
    p.add(kit.box(0.044, 0.05, 0.2, 0.012), 'polymer_black', T(0, 0.045, -0.3));
    p.add(kit.cylZ(0.012, 0.22, r), 'polymer_black', T(0, 0.085, -0.3));
    // barrel + front sight block + AK-74 muzzle brake
    p.add(kit.cylZ(0.0095, 0.3, r), 'gunmetal', T(0, 0.05, -0.5));
    p.add(kit.box(0.022, 0.05, 0.03), 'gunmetal', T(0, 0.06, -0.59));
    p.add(kit.cylZ(0.0135, 0.085, r), 'gunmetal', T(0, 0.05, -0.68));
    // pistol grip
    p.add(kit.box(0.03, 0.1, 0.036, 0.008), 'polymer_black', T(0, -0.04, 0.035, deg(-18)));
    // side-folding skeleton stock
    p.add(kit.profileX([[0.06, 0.06], [0.3, 0.05], [0.31, -0.07], [0.28, -0.08], [0.26, 0.0], [0.08, 0.02]], 0.03, 0.004), 'polymer_black', T(0, 0, 0));
    p.add(kit.box(0.04, 0.13, 0.015, 0.004), 'rubber_black', T(0, -0.005, 0.31));
    // foregrip
    p.add(kit.cyl(0.015, 0.017, 0.09, r), 'polymer_black', T(0, -0.02, -0.33));
    // plum-coloured curved mag (AK-74 style)
    mp.add(kit.profileX([[-0.04, 0], [0.04, 0], [0.07, -0.09], [0.11, -0.18], [0.04, -0.21], [0.0, -0.11]], 0.028, 0.003), 'polymer_black', T(0, 0, 0));
    for (let i = 0; i < 4; i++) mp.add(kit.box(0.03, 0.005, 0.05), 'polymer_black', T(0, -0.03 - i * 0.045, 0.012 + i * 0.022, deg(-20)));
  }

  // collimator (red dot) — shared design for both platforms
  sp.add(kit.box(0.03, 0.012, 0.05), 'gunmetal', T(0, -0.008, 0));
  sp.add(kit.cylZ(0.019, 0.07, kit.radial), 'gunmetal', T(0, 0.018, 0));
  sp.add(kit.cylZ(0.016, 0.004, kit.radial), 'glass_optic', T(0, 0.018, -0.034));
  sp.add(kit.cylZ(0.016, 0.004, kit.radial), 'glass_optic', T(0, 0.018, 0.034));
  sp.add(kit.box(0.012, 0.012, 0.015), 'gunmetal', T(0.02, 0.018, 0));
  sp.add(kit.sphere(0.0018, 6), 'emissive_red', T(0, 0.018, -0.02));

  p.emit(body);
  mp.emit(magN);
  sp.emit(sightN);
  // Muzzle / Aim anchors (empty nodes)
  node('Muzzle', root, 0, kind === 'ar' ? 0.074 : 0.05, kind === 'ar' ? -0.725 : -0.725);
  node('Aim_Point', root, 0, sightN.position.y + 0.018, 0.12);
  return root;
}

export function buildATGM(kit: Kit): THREE.Group {
  const root = node('atgm_launcher', null);
  const tripod = node('Tripod', root);
  const yaw = node('Yaw', root, 0, 0.75, 0);
  const pitch = node('Pitch', yaw, 0, 0.12, 0);
  const tube = node('Tube', pitch, 0.05, 0.12, -0.1);
  const sight = node('Sight', pitch, -0.16, 0.05, 0.05);
  node('Muzzle', tube, 0, 0, -0.62);
  node('Aim_Point', sight, 0, 0.02, 0.22);

  const tp = new PartBuilder(kit);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const leg = new THREE.LineCurve3(new THREE.Vector3(0, 0.72, 0), new THREE.Vector3(Math.cos(a) * 0.55, 0.02, Math.sin(a) * 0.55));
    tp.add(kit.tube(leg, 0.022, 0.018, 2, 8), 'gunmetal');
    tp.add(kit.cyl(0.04, 0.05, 0.03), 'rubber_black', T(Math.cos(a) * 0.55, 0.015, Math.sin(a) * 0.55));
  }
  tp.add(kit.cyl(0.06, 0.06, 0.1), 'warhead_olive', T(0, 0.72, 0));
  tp.emit(tripod);

  const yp = new PartBuilder(kit);
  yp.add(kit.box(0.24, 0.08, 0.2, 0.01), 'warhead_olive', T(0, 0.02, 0));
  yp.add(kit.box(0.04, 0.12, 0.1), 'warhead_olive', T(0.14, 0.07, 0));
  yp.add(kit.box(0.04, 0.12, 0.1), 'warhead_olive', T(-0.14, 0.07, 0));
  yp.emit(yaw);

  const tpp = new PartBuilder(kit);
  tpp.add(kit.cylZ(0.085, 1.24, kit.radial), 'warhead_olive', T(0, 0, 0));
  tpp.add(kit.cylZ(0.095, 0.06, kit.radial), 'rubber_black', T(0, 0, -0.6));
  tpp.add(kit.cylZ(0.095, 0.06, kit.radial), 'rubber_black', T(0, 0, 0.6));
  tpp.add(kit.box(0.03, 0.06, 0.12), 'polymer_black', T(0, 0.1, 0));
  tpp.emit(tube);

  const spp = new PartBuilder(kit);
  spp.add(kit.box(0.16, 0.2, 0.28, 0.015), 'warhead_olive', T(0, 0, 0));
  spp.add(kit.cylZ(0.04, 0.06), 'polymer_black', T(0, 0.02, 0.17));
  spp.add(kit.cylZ(0.05, 0.004), 'glass_optic', T(0, 0.03, -0.142));
  spp.add(kit.box(0.08, 0.04, 0.08), 'polymer_black', T(-0.05, -0.12, 0.08));
  spp.emit(sight);
  return root;
}

export function buildMortar(kit: Kit): THREE.Group {
  const root = node('mortar_82', null);
  const base = node('Baseplate', root);
  const yaw = node('Yaw', root, 0, 0.08, 0.35);
  const tubeN = node('Tube', yaw, 0, 0, 0, deg(-55));
  const bipod = node('Bipod', root, 0, 0, -0.25);
  node('Muzzle', tubeN, 0, 1.2, 0);

  const bp = new PartBuilder(kit);
  bp.add(kit.cyl(0.3, 0.32, 0.05, kit.radial), 'gunmetal', T(0, 0.025, 0.35));
  for (let i = 0; i < 6; i++) bp.add(kit.box(0.02, 0.06, 0.28), 'gunmetal', T(0, 0.04, 0.35, 0, (i / 6) * Math.PI));
  bp.add(kit.sphere(0.06, 10), 'gunmetal', T(0, 0.08, 0.35));
  bp.emit(base);

  const tp = new PartBuilder(kit);
  tp.add(kit.cyl(0.048, 0.05, 1.22, kit.radial), 'warhead_olive', T(0, 0.61, 0));
  tp.add(kit.cyl(0.056, 0.056, 0.08, kit.radial), 'gunmetal', T(0, 0.03, 0));
  tp.add(kit.torus(0.05, 0.008, kit.radial), 'gunmetal', T(0, 1.2, 0, Math.PI / 2));
  tp.emit(tubeN);

  const bpd = new PartBuilder(kit);
  bpd.add(kit.tube(new THREE.LineCurve3(new THREE.Vector3(0, 0.62, 0), new THREE.Vector3(-0.35, 0, 0.05)), 0.018, 0.018, 2, 8), 'warhead_olive');
  bpd.add(kit.tube(new THREE.LineCurve3(new THREE.Vector3(0, 0.62, 0), new THREE.Vector3(0.35, 0, 0.05)), 0.018, 0.018, 2, 8), 'warhead_olive');
  bpd.add(kit.cylX(0.05, 0.12), 'gunmetal', T(0, 0.62, 0));
  bpd.add(kit.box(0.12, 0.1, 0.06), 'warhead_olive', T(-0.1, 0.66, 0.03));
  bpd.add(kit.cylZ(0.025, 0.08), 'polymer_black', T(-0.12, 0.74, 0.03));
  bpd.emit(bipod);
  return root;
}

export function buildEWGun(kit: Kit): THREE.Group {
  const root = node('ew_gun', null);
  const body = node('Body', root);
  const ant = node('Antenna', root, 0, 0.09, -0.45);
  node('Grip_Point', root);
  node('Aim_Point', root, 0, 0.13, 0.1);
  node('Emitter', ant, 0, 0, -0.1);

  const p = new PartBuilder(kit);
  p.add(kit.box(0.08, 0.1, 0.5, 0.01), 'polymer_black', T(0, 0.05, -0.15));
  p.add(kit.box(0.03, 0.1, 0.04, 0.008), 'polymer_black', T(0, -0.04, 0.02, deg(-15)));
  p.add(kit.profileX([[0.1, 0.08], [0.38, 0.06], [0.38, -0.08], [0.3, -0.06], [0.12, 0.0]], 0.04, 0.004), 'polymer_black');
  p.add(kit.box(0.1, 0.07, 0.18, 0.01), 'battery_wrap', T(0, -0.02, -0.18));
  p.add(kit.cylZ(0.02, 0.12), 'gunmetal', T(0, 0.12, -0.02));
  p.add(kit.cylZ(0.017, 0.004), 'glass_optic', T(0, 0.12, -0.081));
  p.add(kit.box(0.05, 0.03, 0.05), 'emissive_screen', T(0.045, 0.07, 0.0, 0, deg(90)));
  p.emit(body);

  const a = new PartBuilder(kit);
  // Yagi-style directional antennas (2 bands)
  a.add(kit.box(0.015, 0.015, 0.3), 'gunmetal', T(0, 0, -0.08));
  for (let i = 0; i < 6; i++) a.add(kit.box(0.24 - i * 0.02, 0.006, 0.006), 'gunmetal', T(0, 0, -0.2 + i * 0.045));
  for (let i = 0; i < 6; i++) a.add(kit.box(0.006, 0.22 - i * 0.02, 0.006), 'anodized_red', T(0, 0, -0.18 + i * 0.045));
  a.emit(ant);
  return root;
}
