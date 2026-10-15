import * as THREE from 'three/webgpu';
import { float, hash, positionWorld, texture, uv, vec3 } from 'three/tsl';
import type { PostFX } from './PostFX';

/**
 * Thermal imaging: every mesh temporarily gets an emissive "heat" material
 * (people hot, running engines warm, ground/buildings cool, sky cold), then PostFX maps
 * luminance to a white-hot palette. Heat is read from `userData.heat` on the object or any
 * ancestor. Smoke particles are hidden (thermal sees through smoke).
 */
export class Thermal {
  active = false;
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private cache = new Map<string, THREE.Material>();
  onChange?: (on: boolean) => void;

  constructor(private scene: THREE.Scene, private post: PostFX) {}

  private material(heat: number, src: THREE.Material): THREE.Material {
    const map = (src as THREE.MeshStandardMaterial).map ?? null;
    const alpha = (src as THREE.MeshStandardMaterial).alphaTest > 0 && map;
    const key = `${heat.toFixed(2)}|${alpha ? map!.uuid : ''}|${src.side}`;
    let m = this.cache.get(key);
    if (m) return m;
    const mat = new THREE.MeshBasicNodeMaterial({ side: src.side });
    const noise = hash(positionWorld.x.mul(3.1).add(positionWorld.z.mul(7.7)).add(positionWorld.y.mul(1.3))).mul(0.05);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let col: any = vec3(float(heat).add(noise));
    if (map) col = col.add(texture(map, uv()).r.mul(0.08));
    mat.colorNode = col;
    if (alpha) { mat.opacityNode = texture(map!, uv()).a; mat.alphaTest = 0.5; }
    mat.fog = false;
    this.cache.set(key, (m = mat));
    return m;
  }

  set(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.post.uThermal.value = on ? 1 : 0;
    if (on) {
      this.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || o.userData.noThermal) return;
        let heat = 0.22, a: THREE.Object3D | null = o;
        while (a) { if (a.userData.heat !== undefined) { heat = a.userData.heat; break; } a = a.parent; }
        if (heat < 0) return;
        this.originals.set(mesh, mesh.material);
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => this.material(heat, m)) : this.material(heat, mesh.material);
      });
    } else {
      for (const [mesh, m] of this.originals) mesh.material = m;
      this.originals.clear();
    }
    this.onChange?.(on);
  }
}
