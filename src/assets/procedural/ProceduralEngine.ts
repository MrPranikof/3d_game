import * as THREE from 'three';
import type { AssetSpec } from '../AssetRegistry';
import type { QualitySettings, Team } from '../StylePreset';
import { Kit } from './Kit';
import { MaterialLibrary } from './MaterialLibrary';
import { buildFPV, buildMavic, buildWing } from './builders/drones';
import { buildDugout, buildFence, buildHangar, buildHedgehog, buildHouse, buildTrench, buildTree } from './builders/environment';
import { buildSoldier } from './builders/soldier';
import { buildTrackedVehicle, type VehicleVariant } from './builders/vehicles';
import { buildATGM, buildEWGun, buildMortar, buildRifle } from './builders/weapons';

/**
 * Built-in generator ("the same single AI" when no external engine is reachable):
 * dispatches an AssetSpec to its builder. All builders share one Kit + MaterialLibrary,
 * hence one scale, one texel density and one PBR material language.
 */
export class ProceduralEngine {
  readonly name = 'procedural';
  readonly materials: MaterialLibrary;
  readonly kit: Kit;

  constructor(quality: QualitySettings) {
    this.materials = new MaterialLibrary(quality);
    this.kit = new Kit(this.materials, quality);
  }

  build(spec: AssetSpec, team?: Team): { root: THREE.Group; animations: THREE.AnimationClip[] } {
    const k = this.kit;
    const id = spec.id;
    const p = spec.params ?? {};
    let root: THREE.Group;
    let animations: THREE.AnimationClip[] = [];
    switch (spec.category) {
      case 'infantry': {
        const r = buildSoldier(k, team ?? 'A');
        root = r.root;
        animations = r.animations;
        break;
      }
      case 'weapon':
        if (id === 'rifle_ar' || id === 'rifle_ak') root = buildRifle(k, p.kind as 'ar' | 'ak');
        else if (id === 'atgm_launcher') root = buildATGM(k);
        else if (id === 'mortar_82') root = buildMortar(k);
        else if (id === 'ew_gun') root = buildEWGun(k);
        else throw new Error(`No weapon builder for ${id}`);
        break;
      case 'vehicle':
        root = buildTrackedVehicle(k, p.variant as VehicleVariant, id);
        break;
      case 'drone':
        root = p.kind === 'fpv' ? buildFPV(k) : p.kind === 'mavic' ? buildMavic(k) : buildWing(k);
        break;
      case 'environment':
        if (id.startsWith('house_')) root = buildHouse(k, id, (p.damage as number) ?? 0);
        else if (id === 'hangar') root = buildHangar(k, id);
        else if (id === 'fence_concrete') root = buildFence(k, id);
        else if (id === 'trench_segment') root = buildTrench(k, id);
        else if (id === 'dugout') root = buildDugout(k, id);
        else if (id.startsWith('tree_')) root = buildTree(k, id, p.kind as 'poplar' | 'acacia' | 'scorched');
        else if (id === 'czech_hedgehog') root = buildHedgehog(k, id);
        else throw new Error(`No environment builder for ${id}`);
        break;
      default:
        throw new Error(`Unknown category for ${id}`);
    }
    return { root, animations };
  }

  dispose(): void {
    this.materials.dispose();
  }
}
