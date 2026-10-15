import type * as THREE from 'three/webgpu';
import type { SingleAIModelFactory } from '../assets/SingleAIModelFactory';
import type { AssetTemplate } from '../assets/pipeline/ModelLoader';
import type { Team } from '../assets/StylePreset';
import type { Combat } from './combat/Combat';
import type { Audio } from './core/Audio';
import type { Input } from './core/Input';
import type { Physics } from './core/Physics';
import type { DroneSystem } from './entities/Drone';
import type { Emplacement } from './entities/Emplacement';
import type { Player } from './entities/Player';
import type { Soldier } from './entities/Soldier';
import type { Vehicle } from './entities/Vehicle';
import type { Particles } from './fx/Particles';
import type { PostFX } from './fx/PostFX';
import type { Thermal } from './fx/Thermal';
import type { Conquest } from './modes/Conquest';
import type { HUD } from './ui/HUD';
import type { MapLayout } from './world/MapLayout';
import type { StaticWorld } from './world/StaticWorld';
import type { Terrain } from './world/Terrain';
import type { Vegetation } from './world/Vegetation';

export interface GameSettings {
  quality: 'mobile' | 'desktop' | 'ultra';
  botsPerTeam: number;
  playerTeam: Team;
  touch: boolean;
  touchLayout: 'two' | 'three' | 'claw';
  /** graphics API: auto = WebGL2 on phones/tablets, WebGPU elsewhere */
  api: 'auto' | 'webgpu' | 'webgl';
}

export interface GameContext {
  settings: GameSettings;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGPURenderer;
  physics: Physics;
  terrain: Terrain;
  statics: StaticWorld;
  vegetation: Vegetation;
  particles: Particles;
  audio: Audio;
  input: Input;
  combat: Combat;
  postfx: PostFX;
  thermal: Thermal;
  hud: HUD;
  conquest: Conquest;
  layout: MapLayout;
  factory: SingleAIModelFactory;
  templates: Map<string, AssetTemplate>;
  soldiers: Soldier[];
  vehicles: Vehicle[];
  drones: DroneSystem;
  emplacements: Emplacement[];
  player: Player;
  time: number;
  template(id: string, team?: Team): AssetTemplate;
  killFeed(killer: string, victim: string, weapon: string, killerTeam: Team | null, victimTeam: Team): void;
}
