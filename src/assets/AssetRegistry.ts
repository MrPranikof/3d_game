import { GLOBAL_STYLE_PREFIX, type Team } from './StylePreset';

/**
 * Declarative catalogue of every 3D model in the game.
 *
 * Each spec is engine-agnostic: it holds the prompt (always GLOBAL_STYLE_PREFIX + body),
 * real-world dimensions for scale validation, the node hierarchy that gameplay code relies
 * on, and a per-part breakdown. The remote AI engine generates parts one by one from
 * `parts[].prompt` and the factory assembles them on `parts[].pivot`; the procedural
 * generator builds the same hierarchy directly.
 */

export type AssetCategory = 'infantry' | 'vehicle' | 'drone' | 'weapon' | 'environment';

export interface PartSpec {
  /** Node name in the final .glb (gameplay code looks nodes up by this name). */
  node: string;
  parent: string | null;
  /** Pivot in parent space, metres. */
  pivot: [number, number, number];
  /** Target bounding box of the part, metres (used to normalise remote meshes). */
  size?: [number, number, number];
  prompt?: string;
}

export interface AssetSpec {
  id: string;
  category: AssetCategory;
  displayName: string;
  /** Prompt body; final prompt = GLOBAL_STYLE_PREFIX + ' ' + body. */
  prompt: string;
  /** Expected axis-aligned extents (x, y, z) in metres; ±35% tolerance is enforced. */
  dimensions: [number, number, number];
  /** Node names that MUST exist in the result (validated after every generation). */
  requiredNodes: string[];
  /** Assets generated once per team. */
  teamVariants?: boolean;
  rigged?: boolean;
  /** Parameters passed to the procedural builder. */
  params?: Record<string, unknown>;
  parts?: PartSpec[];
  /** LOD switch distances in metres for LOD1..LOD3. */
  lodDistances: [number, number, number];
}

export const HUMANOID_BONES = [
  'Root', 'Pelvis', 'Spine', 'Chest', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot',
  'RightUpLeg', 'RightLeg', 'RightFoot',
  'WeaponMount_R',
] as const;

export type HumanoidBone = (typeof HUMANOID_BONES)[number];

const SOLDIER_PROMPT =
  'Modern tactical airsoft MilSim soldier, plate carrier vest with magazine pouches and radio, FAST tactical helmet with cover, ' +
  'ballistic goggles and headset, customized assault rifle with collimator sight, A-pose.';

const TANK_PROMPT =
  'Modern main battle tank with explosive reactive armor blocks, anti-drone roof cage armor, weathered camouflage paint, mud on tracks, detailed optics.';

const FPV_PROMPT =
  '7-inch tactical FPV quadcopter drone, carbon fiber frame, four brushless motors, front gimbal camera, strapped lithium battery, ' +
  'rear antenna, payload release mechanism underneath.';

const HOUSE_PROMPT =
  'Modular war-damaged rural brick house, concrete fence, trench dugout and scorched trees, Eastern European village style, ' +
  'broken roof tiles, destructible wall segments.';

const TANK_NODES = ['Hull', 'Turret', 'Cannon', 'Track_L', 'Track_R', 'Interior_Cockpit', 'Muzzle', 'Cam_Driver', 'Cam_Gunner', 'Smoke_Launchers'];

function tankParts(len: number, width: number, hullH: number, turretY: number, turretZ: number): PartSpec[] {
  return [
    { node: 'Hull', parent: null, pivot: [0, 0, 0], size: [width * 0.72, hullH, len], prompt: 'tank hull only, no turret, no tracks' },
    { node: 'Turret', parent: 'Hull', pivot: [0, turretY, turretZ], size: [width * 0.8, 0.9, len * 0.45], prompt: 'tank turret only, no gun barrel' },
    { node: 'Cannon', parent: 'Turret', pivot: [0, 0.35, -1.2], size: [0.5, 0.5, len * 0.75], prompt: 'tank main gun barrel with thermal sleeve and fume extractor' },
    { node: 'Track_L', parent: 'Hull', pivot: [-width / 2 + 0.3, 0, 0], size: [0.6, 1.0, len * 0.95], prompt: 'tank track assembly with road wheels, sprocket and idler' },
    { node: 'Track_R', parent: 'Hull', pivot: [width / 2 - 0.3, 0, 0], size: [0.6, 1.0, len * 0.95], prompt: 'tank track assembly with road wheels, sprocket and idler' },
    { node: 'Interior_Cockpit', parent: 'Hull', pivot: [0, 0.6, -len * 0.33], size: [1.0, 0.9, 1.2], prompt: 'tank driver station interior, seat, levers, periscopes' },
  ];
}

const tank = (id: string, displayName: string, variant: string, dims: [number, number, number], extra: string): AssetSpec => ({
  id,
  category: 'vehicle',
  displayName,
  prompt: `${TANK_PROMPT} ${extra}`,
  dimensions: dims,
  requiredNodes: TANK_NODES,
  params: { variant },
  parts: tankParts(dims[2] * 0.7, dims[0], 1.1, 1.75, 0.3),
  lodDistances: [45, 110, 260],
});

export const ASSETS: AssetSpec[] = [
  // ───────────── Infantry ─────────────
  {
    id: 'soldier',
    category: 'infantry',
    displayName: 'Боец MilSim',
    prompt: SOLDIER_PROMPT,
    dimensions: [1.3, 1.85, 1.0], // A-pose incl. rifle carried forward
    requiredNodes: [...HUMANOID_BONES, 'Body', 'Weapon'],
    teamVariants: true,
    rigged: true,
    lodDistances: [12, 35, 90],
  },
  // ───────────── Weapons ─────────────
  {
    id: 'rifle_ar',
    category: 'weapon',
    displayName: 'Штурмовая винтовка (AR-платформа)',
    prompt: 'customized AR-15 pattern assault rifle, M-LOK handguard, collimator red dot sight, foregrip, weapon light, PMAG.',
    dimensions: [0.07, 0.33, 0.99],
    requiredNodes: ['Body', 'Magazine', 'Sight', 'Muzzle', 'Grip_Point', 'Aim_Point'],
    params: { kind: 'ar' },
    lodDistances: [6, 18, 40],
  },
  {
    id: 'rifle_ak',
    category: 'weapon',
    displayName: 'Штурмовая винтовка (AK-платформа)',
    prompt: 'customized AK-74M assault rifle, polymer furniture, side-rail collimator sight, foregrip, plum magazine.',
    dimensions: [0.06, 0.37, 1.03],
    requiredNodes: ['Body', 'Magazine', 'Sight', 'Muzzle', 'Grip_Point', 'Aim_Point'],
    params: { kind: 'ak' },
    lodDistances: [6, 18, 40],
  },
  {
    id: 'atgm_launcher',
    category: 'weapon',
    displayName: 'Стационарный ПТУР',
    prompt: 'tripod-mounted anti-tank guided missile launcher with sighting unit and missile container, olive drab.',
    dimensions: [1.1, 1.2, 1.6],
    requiredNodes: ['Tripod', 'Yaw', 'Pitch', 'Tube', 'Sight', 'Muzzle'],
    lodDistances: [20, 60, 150],
  },
  {
    id: 'mortar_82',
    category: 'weapon',
    displayName: 'Миномёт 82 мм',
    prompt: '82mm infantry mortar with baseplate, bipod and sight, worn olive paint.',
    dimensions: [0.6, 1.2, 1.3],
    requiredNodes: ['Baseplate', 'Yaw', 'Tube', 'Bipod', 'Muzzle'],
    lodDistances: [20, 60, 150],
  },
  {
    id: 'ew_gun',
    category: 'weapon',
    displayName: 'Антидроновое ружьё (РЭБ)',
    prompt: 'handheld anti-drone electronic warfare jammer rifle, directional antennas, battery pack, stock and optic.',
    dimensions: [0.35, 0.4, 1.05],
    requiredNodes: ['Body', 'Antenna', 'Grip_Point', 'Aim_Point', 'Emitter'],
    lodDistances: [8, 25, 60],
  },
  // ───────────── Armour ─────────────
  tank('tank_t72b3', 'Т-72Б3', 't72b3', [3.6, 2.95, 9.5], 'T-72B3 with Kontakt-5 ERA and roof cage.'),
  tank('tank_t80bvm', 'Т-80БВМ', 't80bvm', [3.6, 2.95, 9.6], 'T-80BVM with Relikt ERA, gas turbine rear deck and roof cage.'),
  tank('tank_t64bv', 'Т-64БВ', 't64bv', [3.5, 2.85, 9.2], 'T-64BV with Kontakt-1 ERA brick blocks and small road wheels.'),
  tank('tank_leo2a4', 'Leopard 2A4', 'leo2a4', [3.75, 2.8, 9.7], 'Leopard 2A4 with boxy vertical turret, NATO three-tone camouflage, side skirts.'),
  tank('tank_leo2a6', 'Leopard 2A6', 'leo2a6', [3.75, 2.8, 10.9], 'Leopard 2A6 with arrow-head wedge turret armour, long L55 gun, side skirts.'),
  {
    id: 'ifv_bmp2',
    category: 'vehicle',
    displayName: 'БМП-2',
    prompt: `${TANK_PROMPT} Tracked infantry fighting vehicle BMP-2, boat-shaped hull, small two-man turret with 30mm autocannon and ATGM launcher, rear troop doors.`,
    dimensions: [3.15, 2.9, 6.75], // incl. anti-drone cage
    requiredNodes: [...TANK_NODES, 'Door_RL', 'Door_RR'],
    params: { variant: 'bmp2' },
    parts: tankParts(6.7, 3.15, 1.2, 1.7, -0.3),
    lodDistances: [40, 100, 240],
  },
  // ───────────── UAV ─────────────
  {
    id: 'drone_fpv7',
    category: 'drone',
    displayName: 'FPV-дрон 7"',
    prompt: FPV_PROMPT,
    dimensions: [0.42, 0.21, 0.42], // incl. warhead underneath
    requiredNodes: ['Frame', 'Prop_FL', 'Prop_FR', 'Prop_RL', 'Prop_RR', 'Camera_Gimbal', 'Payload', 'Cam_FPV'],
    params: { kind: 'fpv' },
    parts: [
      { node: 'Frame', parent: null, pivot: [0, 0, 0], size: [0.36, 0.06, 0.32], prompt: '7-inch carbon X frame with motors, battery and antenna, no propellers' },
      { node: 'Prop_FL', parent: 'Frame', pivot: [-0.13, 0.04, -0.12], size: [0.178, 0.01, 0.178], prompt: 'single 7-inch tri-blade propeller' },
      { node: 'Prop_FR', parent: 'Frame', pivot: [0.13, 0.04, -0.12], size: [0.178, 0.01, 0.178], prompt: 'single 7-inch tri-blade propeller' },
      { node: 'Prop_RL', parent: 'Frame', pivot: [-0.13, 0.04, 0.12], size: [0.178, 0.01, 0.178], prompt: 'single 7-inch tri-blade propeller' },
      { node: 'Prop_RR', parent: 'Frame', pivot: [0.13, 0.04, 0.12], size: [0.178, 0.01, 0.178], prompt: 'single 7-inch tri-blade propeller' },
      { node: 'Camera_Gimbal', parent: 'Frame', pivot: [0, 0.01, -0.1], size: [0.03, 0.03, 0.03], prompt: 'FPV camera in tilting mount' },
      { node: 'Payload', parent: 'Frame', pivot: [0, -0.05, 0], size: [0.09, 0.09, 0.35], prompt: 'shaped-charge grenade warhead with fins' },
    ],
    lodDistances: [8, 25, 70],
  },
  {
    id: 'drone_mavic',
    category: 'drone',
    displayName: 'Разведывательный квадрокоптер',
    prompt: 'compact foldable reconnaissance quadcopter similar to consumer Mavic, grey shell, 3-axis gimbal camera, improvised drop release mechanism.',
    dimensions: [0.48, 0.15, 0.3], // props unfolded
    requiredNodes: ['Frame', 'Prop_FL', 'Prop_FR', 'Prop_RL', 'Prop_RR', 'Camera_Gimbal', 'Payload', 'Cam_FPV'],
    params: { kind: 'mavic' },
    lodDistances: [8, 25, 70],
  },
  {
    id: 'drone_wing',
    category: 'drone',
    displayName: 'Разведывательное крыло',
    prompt: 'fixed-wing reconnaissance UAV, high wing, twin tail booms, rear pusher propeller, belly gimbal camera.',
    dimensions: [2.6, 0.4, 1.5],
    requiredNodes: ['Frame', 'Prop_Main', 'Camera_Gimbal', 'Payload', 'Cam_FPV', 'Aileron_L', 'Aileron_R'],
    params: { kind: 'wing' },
    lodDistances: [20, 60, 180],
  },
  // ───────────── Environment («Малая Токмачка») ─────────────
  {
    id: 'house_brick',
    category: 'environment',
    displayName: 'Кирпичный дом',
    prompt: HOUSE_PROMPT,
    dimensions: [8.6, 6.6, 10.6],
    requiredNodes: ['Foundation', ...range(16, (i) => `Wall_Cluster_${pad(i)}`), ...range(8, (i) => `Roof_Cluster_${pad(i)}`)],
    params: { damage: 0.0 },
    lodDistances: [60, 150, 400],
  },
  {
    id: 'house_ruined',
    category: 'environment',
    displayName: 'Разрушенный дом',
    prompt: `${HOUSE_PROMPT} Heavily shelled, partially collapsed roof, shell holes in walls.`,
    dimensions: [8.6, 6.6, 10.6],
    requiredNodes: ['Foundation', ...range(16, (i) => `Wall_Cluster_${pad(i)}`), ...range(8, (i) => `Roof_Cluster_${pad(i)}`)],
    params: { damage: 0.65 },
    lodDistances: [60, 150, 400],
  },
  {
    id: 'hangar',
    category: 'environment',
    displayName: 'Колхозный ангар',
    prompt: 'collective-farm corrugated steel hangar with brick gable walls and arched roof, rusty, Eastern European.',
    dimensions: [18.4, 8.2, 30.4],
    requiredNodes: ['Foundation', ...range(16, (i) => `Wall_Cluster_${pad(i)}`), ...range(8, (i) => `Roof_Cluster_${pad(i)}`)],
    lodDistances: [90, 220, 600],
  },
  {
    id: 'fence_concrete',
    category: 'environment',
    displayName: 'Бетонный забор (секция)',
    prompt: 'Soviet decorative precast concrete fence section, two panels and posts, chipped, 6 metres long.',
    dimensions: [6.2, 2.6, 0.4],
    requiredNodes: ['Foundation', ...range(8, (i) => `Wall_Cluster_${pad(i)}`)],
    lodDistances: [40, 100, 250],
  },
  {
    id: 'trench_segment',
    category: 'environment',
    displayName: 'Окоп (сегмент)',
    prompt: 'zig-zag infantry trench segment with wooden revetment, sandbag parapet, firing step, 8 metres.',
    dimensions: [3.4, 1.6, 8.2],
    requiredNodes: ['Foundation', ...range(8, (i) => `Wall_Cluster_${pad(i)}`)],
    lodDistances: [40, 100, 250],
  },
  {
    id: 'dugout',
    category: 'environment',
    displayName: 'Блиндаж',
    prompt: 'log-covered field dugout bunker with earth roof, entrance stairs and firing slit.',
    dimensions: [5.4, 2.4, 6.4],
    requiredNodes: ['Foundation', ...range(8, (i) => `Roof_Cluster_${pad(i)}`), 'Entrance'],
    lodDistances: [50, 120, 300],
  },
  {
    id: 'tree_poplar',
    category: 'environment',
    displayName: 'Тополь (лесополоса)',
    prompt: 'tall poplar tree from a steppe windbreak tree line, dense columnar crown.',
    dimensions: [4.2, 16, 4.2],
    requiredNodes: ['Foundation', 'Trunk_Upper', ...range(4, (i) => `Crown_Cluster_${pad(i)}`)],
    params: { kind: 'poplar' },
    lodDistances: [50, 130, 350],
  },
  {
    id: 'tree_acacia',
    category: 'environment',
    displayName: 'Акация (лесополоса)',
    prompt: 'black locust acacia tree from a steppe tree line, broad irregular crown.',
    dimensions: [7.5, 10, 7.5],
    requiredNodes: ['Foundation', 'Trunk_Upper', ...range(4, (i) => `Crown_Cluster_${pad(i)}`)],
    params: { kind: 'acacia' },
    lodDistances: [50, 130, 350],
  },
  {
    id: 'tree_scorched',
    category: 'environment',
    displayName: 'Обгоревшее дерево',
    prompt: 'scorched shell-shocked dead tree, broken branches, charred bark.',
    dimensions: [3.2, 8, 3.2],
    requiredNodes: ['Foundation', 'Trunk_Upper', ...range(4, (i) => `Crown_Cluster_${pad(i)}`)],
    params: { kind: 'scorched' },
    lodDistances: [50, 130, 350],
  },
  {
    id: 'czech_hedgehog',
    category: 'environment',
    displayName: 'Противотанковый ёж',
    prompt: 'welded steel anti-tank hedgehog from rusty I-beams.',
    dimensions: [1.9, 1.5, 1.9],
    requiredNodes: ['Foundation'],
    lodDistances: [30, 80, 200],
  },
];

export const ASSET_MAP = new Map(ASSETS.map((a) => [a.id, a]));

export function getSpec(id: string): AssetSpec {
  const spec = ASSET_MAP.get(id);
  if (!spec) throw new Error(`Unknown asset id "${id}"`);
  return spec;
}

export function fullPrompt(spec: AssetSpec, team?: Team): string {
  const teamNote = team === 'A' ? ' MM-14 pixel camouflage uniform, yellow identification tape on arms and legs.' :
    team === 'B' ? ' EMR digital flora camouflage uniform, white identification tape on arms and legs.' : '';
  return `${GLOBAL_STYLE_PREFIX} ${spec.prompt}${spec.teamVariants ? teamNote : ''}`;
}

export function variantKey(id: string, team?: Team): string {
  return team ? `${id}__team${team}` : id;
}

function range<T>(n: number, f: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => f(i + 1));
}

export function pad(i: number): string {
  return String(i).padStart(2, '0');
}
