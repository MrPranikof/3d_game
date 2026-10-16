import * as THREE from 'three';
import { deg, type Kit, node, PartBuilder, T } from '../Kit';

/**
 * UAVs. Node contract:
 *   Frame ─┬─ Prop_FL / Prop_FR / Prop_RL / Prop_RR (spin about local Y)   [quadcopters]
 *          ├─ Prop_Main (spin about local Z), Aileron_L/R                   [wing]
 *          ├─ Camera_Gimbal (tilt about X) ── Cam_FPV
 *          └─ Payload (detachable munition; inherits drone velocity on release)
 */

function propeller(kit: Kit, diameter: number, blades: number, cw: boolean): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const r = diameter / 2;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    // blade: tapered, twisted airfoil approximated with an extruded planform
    const g = kit.extrude([[0.008, -0.009], [r * 0.55, -0.014], [r * 0.95, -0.008], [r, 0.0], [r * 0.95, 0.006], [r * 0.5, 0.01], [0.008, 0.008]], 0.0025, 0.0006);
    g.rotateX(-Math.PI / 2);
    g.rotateX(deg(cw ? 12 : -12)); // pitch
    g.rotateY(a);
    out.push(g);
  }
  out.push(kit.cyl(0.011, 0.011, 0.012, 10));
  return out;
}

export function buildFPV(kit: Kit): THREE.Group {
  const root = node('drone_fpv7', null);
  const frame = node('Frame', root);
  const p = new PartBuilder(kit);
  const arm = 0.18; // motor-to-centre distance (≈ 7" frame, 360 mm diagonal)
  const motors: [string, number, number, boolean][] = [['FL', -1, -1, false], ['FR', 1, -1, true], ['RL', -1, 1, true], ['RR', 1, 1, false]];
  // carbon plates + arms
  p.add(kit.box(0.09, 0.004, 0.16, 0.003), 'carbon_fiber', T(0, 0, 0));
  p.add(kit.box(0.08, 0.003, 0.14, 0.003), 'carbon_fiber', T(0, 0.032, 0));
  for (const [, sx, sz] of motors) {
    const len = arm;
    p.add(kit.box(0.024, 0.006, len, 0.003), 'carbon_fiber', T(sx * len / 2 * Math.SQRT1_2, 0, sz * len / 2 * Math.SQRT1_2, 0, Math.atan2(sx, sz)));
    // brushless motor: bell + stator windings + base
    const mx = sx * arm * Math.SQRT1_2, mz = sz * arm * Math.SQRT1_2;
    p.add(kit.cyl(0.016, 0.017, 0.006, 14), 'gunmetal', T(mx, 0.006, mz));
    p.add(kit.cyl(0.0145, 0.0145, 0.012, 14), 'copper_coil', T(mx, 0.015, mz));
    p.add(kit.cyl(0.0155, 0.0155, 0.014, 14, true), 'gunmetal', T(mx, 0.022, mz));
    // landing leg under each arm (cf. assets-src/refs/fpv_34.webp)
    p.add(kit.box(0.008, 0.075, 0.012, 0.002), 'polymer_black', T(mx * 0.62, -0.035, mz * 0.62, sz * deg(14), 0, -sx * deg(14)));
    p.add(kit.cyl(0.002, 0.002, 0.012, 6), 'steel_bare', T(mx, 0.034, mz));
  }
  // standoffs, stack (FC/ESC), VTX
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) p.add(kit.cyl(0.0035, 0.0035, 0.03, 6), 'gunmetal', T(sx * 0.03, 0.016, sz * 0.055));
  p.add(kit.box(0.036, 0.012, 0.036, 0.002), 'polymer_black', T(0, 0.012, 0));
  p.add(kit.box(0.03, 0.006, 0.03, 0.002), 'emissive_screen', T(0, 0.02, 0.0));
  // battery 6S strapped on top
  p.add(kit.box(0.045, 0.04, 0.11, 0.006), 'plastic_grey', T(0, 0.056, 0.005));
  p.add(kit.box(0.05, 0.003, 0.02), 'rubber_black', T(0, 0.077, -0.025));
  p.add(kit.box(0.05, 0.003, 0.02), 'rubber_black', T(0, 0.077, 0.035));
  // rear antenna (immortal-T / dipole) + RX whips
  p.add(kit.cyl(0.002, 0.002, 0.09, 5), 'polymer_black', T(0, 0.06, 0.09, deg(45)));
  p.add(kit.box(0.012, 0.004, 0.04), 'polymer_black', T(0, 0.095, 0.123, deg(45)));
  for (const sx of [-1, 1]) p.add(kit.cyl(0.0012, 0.0012, 0.08, 4), 'polymer_tan', T(sx * 0.03, 0.03, 0.1, deg(60), 0, sx * deg(30)));
  // payload release servo underneath
  p.add(kit.box(0.024, 0.016, 0.012, 0.002), 'polymer_black', T(0, -0.012, 0.0));
  p.add(kit.box(0.004, 0.02, 0.004), 'steel_bare', T(0, -0.024, 0.0));
  p.emit(frame);

  for (const [name, sx, sz, cw] of motors) {
    const pn = node(`Prop_${name}`, frame, sx * arm * Math.SQRT1_2, 0.042, sz * arm * Math.SQRT1_2);
    const pp = new PartBuilder(kit);
    for (const g of propeller(kit, 0.178, 3, cw)) pp.add(g, 'polymer_black');
    pp.emit(pn);
  }

  const gimbal = node('Camera_Gimbal', frame, 0, 0.016, -0.072, deg(-25));
  const gp = new PartBuilder(kit);
  gp.add(kit.box(0.02, 0.019, 0.019, 0.003), 'polymer_black');
  gp.add(kit.cylZ(0.008, 0.012, 12), 'gunmetal', T(0, 0, -0.014));
  gp.add(kit.cylZ(0.006, 0.002, 12), 'glass_optic', T(0, 0, -0.021));
  for (const sx of [-1, 1]) gp.add(kit.box(0.003, 0.025, 0.02), 'anodized_red', T(sx * 0.013, 0, 0));
  gp.emit(gimbal);
  node('Cam_FPV', gimbal, 0, 0, -0.022);

  // payload: PG-7V grenade strapped lengthwise under the frame (cf. fpv_top / fpv_34 refs):
  // ogive warhead forward, sustainer tube aft, two blue straps
  const payload = node('Payload', frame, 0.0, -0.05, -0.05);
  const pl = new PartBuilder(kit);
  pl.add(kit.lathe([[0.0, -0.36], [0.008, -0.355], [0.012, -0.33], [0.02, -0.3], [0.037, -0.2], [0.042, -0.12], [0.042, -0.07], [0.022, -0.04], [0.0, -0.04]], 18).rotateX(Math.PI / 2), 'warhead_olive');
  pl.add(kit.cylZ(0.004, 0.03, 8), 'steel_bare', T(0, 0, -0.37)); // piezo fuze tip
  pl.add(kit.cylZ(0.021, 0.42, 14), 'warhead_olive', T(0, 0, 0.17)); // sustainer motor tube
  pl.add(kit.cylZ(0.024, 0.04, 14), 'gunmetal', T(0, 0, 0.39)); // nozzle block
  pl.add(kit.cylZ(0.017, 0.012, 14, 0.012), 'polymer_black', T(0, 0, 0.415));
  for (const z of [-0.02, 0.1]) pl.add(kit.cylZ(0.0235, 0.022, 14), 'anodized_blue', T(0, 0, z)); // straps
  pl.emit(payload);
  return root;
}

export function buildMavic(kit: Kit): THREE.Group {
  const root = node('drone_mavic', null);
  const frame = node('Frame', root);
  const p = new PartBuilder(kit);
  p.add(kit.box(0.085, 0.065, 0.2, 0.025), 'plastic_grey', T(0, 0.0, 0));
  p.add(kit.box(0.07, 0.02, 0.09, 0.008), 'battery_wrap', T(0, 0.04, 0.03));
  p.add(kit.box(0.06, 0.012, 0.02, 0.004), 'polymer_black', T(0, 0.01, -0.1)); // obstacle sensors
  const arms: [string, number, number, number][] = [['FL', -1, -1, 0.0], ['FR', 1, -1, 0.0], ['RL', -1, 1, -0.012], ['RR', 1, 1, -0.012]];
  for (const [, sx, sz, dy] of arms) {
    const ex = sx * 0.13, ez = sz * 0.11;
    p.add(kit.box(0.016, 0.014, Math.hypot(ex, ez), 0.005), 'plastic_grey', T(ex / 2, dy, ez / 2, 0, Math.atan2(ex, ez)));
    p.add(kit.cyl(0.014, 0.016, 0.022, 12), 'plastic_grey', T(ex, dy + 0.008, ez));
    if (sz < 0) p.add(kit.cyl(0.005, 0.005, 0.03, 6), 'plastic_grey', T(ex, dy - 0.02, ez)); // landing leg
  }
  // improvised drop system (servo + claw + VOG hook)
  p.add(kit.box(0.03, 0.018, 0.03, 0.004), 'polymer_black', T(0, -0.042, 0.02));
  p.emit(frame);
  for (const [name, sx, sz, dy] of arms) {
    const pn = node(`Prop_${name}`, frame, sx * 0.13, dy + 0.022, sz * 0.11);
    const pp = new PartBuilder(kit);
    for (const g of propeller(kit, 0.24, 2, name === 'FR' || name === 'RL')) pp.add(g.scale(1, 0.6, 1), 'polymer_black');
    pp.emit(pn);
  }
  const gimbal = node('Camera_Gimbal', frame, 0, -0.03, -0.1);
  const gp = new PartBuilder(kit);
  gp.add(kit.box(0.035, 0.03, 0.03, 0.006), 'plastic_grey');
  gp.add(kit.cylZ(0.011, 0.004, 14), 'glass_optic', T(0, 0, -0.017));
  gp.add(kit.box(0.004, 0.032, 0.02), 'polymer_black', T(0.02, 0.0, 0.0));
  gp.emit(gimbal);
  node('Cam_FPV', gimbal, 0, 0, -0.02);
  // VOG-17 grenade with printed stabiliser
  const payload = node('Payload', frame, 0, -0.07, 0.02);
  const pl = new PartBuilder(kit);
  pl.add(kit.cyl(0.015, 0.015, 0.05, 12), 'warhead_olive');
  pl.add(kit.cyl(0.006, 0.015, 0.02, 12), 'steel_bare', T(0, -0.035, 0));
  pl.add(kit.cyl(0.018, 0.012, 0.04, 6), 'polymer_tan', T(0, 0.045, 0));
  pl.emit(payload);
  return root;
}

export function buildWing(kit: Kit): THREE.Group {
  const root = node('drone_wing', null);
  const frame = node('Frame', root);
  const p = new PartBuilder(kit);
  // fuselage pod
  p.add(kit.lathe([[0, -0.55], [0.05, -0.5], [0.08, -0.35], [0.09, 0.0], [0.07, 0.2], [0.04, 0.3], [0, 0.31]], 16).rotateX(Math.PI / 2), 'foam_wing', T(0, 0.12, 0));
  // high wing with slight dihedral
  for (const sx of [-1, 1]) {
    const wing = kit.extrude([[0, 0.12], [1.3, 0.08], [1.3, -0.08], [0, -0.14]], 0.022, 0.006);
    wing.rotateX(Math.PI / 2);
    if (sx < 0) wing.scale(-1, 1, 1);
    p.add(wing, 'foam_wing', T(0, 0.22, -0.05, 0, 0, sx * deg(3)));
  }
  // tail booms + H tail
  for (const sx of [-1, 1]) {
    p.add(kit.cylZ(0.012, 0.85, 8), 'carbon_fiber', T(sx * 0.28, 0.2, 0.42));
    p.add(kit.box(0.01, 0.2, 0.16, 0.003), 'foam_wing', T(sx * 0.28, 0.28, 0.8));
  }
  p.add(kit.box(0.64, 0.01, 0.14, 0.003), 'foam_wing', T(0, 0.37, 0.8));
  // pusher motor
  p.add(kit.cylZ(0.022, 0.04, 12), 'gunmetal', T(0, 0.12, 0.33));
  p.emit(frame);
  for (const sx of [-1, 1]) {
    const ai = node(sx < 0 ? 'Aileron_L' : 'Aileron_R', frame, sx * 0.85, 0.22 + 0.85 * Math.sin(deg(3)), 0.06);
    const ap = new PartBuilder(kit);
    ap.add(kit.box(0.4, 0.012, 0.05, 0.003), 'foam_wing', T(0, 0, 0.025));
    ap.emit(ai);
  }
  const prop = node('Prop_Main', frame, 0, 0.12, 0.37);
  const pp = new PartBuilder(kit);
  for (const g of propeller(kit, 0.33, 2, true)) pp.add(g.rotateX(Math.PI / 2), 'polymer_black');
  pp.emit(prop);
  const gimbal = node('Camera_Gimbal', frame, 0, 0.03, -0.3);
  const gp = new PartBuilder(kit);
  gp.add(kit.sphere(0.045, 14), 'plastic_grey');
  gp.add(kit.cylZ(0.016, 0.01, 12), 'glass_optic', T(0, -0.01, -0.04));
  gp.emit(gimbal);
  node('Cam_FPV', gimbal, 0, -0.01, -0.05);
  const payload = node('Payload', frame, 0, 0.0, 0.0);
  const pl = new PartBuilder(kit);
  pl.add(kit.box(0.06, 0.04, 0.12, 0.01), 'polymer_black'); // datalink / relay pod
  pl.emit(payload);
  return root;
}
