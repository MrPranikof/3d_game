import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';

/**
 * Late-summer steppe afternoon: physical sky, warm low sun with a shadow frustum that follows
 * the camera (texel-snapped to avoid shimmering), hemisphere fill, sky-based image lighting and
 * distance haze.
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly sunDir = new THREE.Vector3();
  private sky: SkyMesh;
  private shadowSize: number;

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer, quality: 'mobile' | 'desktop' | 'ultra') {
    const elevation = 28, azimuth = 215;
    const phi = THREE.MathUtils.degToRad(90 - elevation), theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    this.sky = new SkyMesh();
    this.sky.scale.setScalar(4500);
    this.sky.turbidity.value = 6;
    this.sky.rayleigh.value = 1.6;
    this.sky.mieCoefficient.value = 0.006;
    this.sky.mieDirectionalG.value = 0.82;
    this.sky.sunPosition.value.copy(this.sunDir);
    this.sky.userData.heat = 0.02;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    const hazeColor = new THREE.Color(0xb7bcb4);
    scene.fog = new THREE.Fog(hazeColor, 140, quality === 'mobile' ? 650 : 900);
    scene.background = hazeColor;

    try {
      const envScene = new THREE.Scene();
      const sky2 = new SkyMesh();
      sky2.scale.setScalar(1000);
      sky2.sunPosition.value.copy(this.sunDir);
      sky2.turbidity.value = 6;
      sky2.rayleigh.value = 1.6;
      envScene.add(sky2);
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(envScene, 0.02).texture;
      scene.environmentIntensity = 0.45;
    } catch (e) {
      console.warn('sky environment unavailable', e);
    }

    scene.add(new THREE.HemisphereLight(0xc9d6e3, 0x5a5238, 0.55));
    this.sun = new THREE.DirectionalLight(0xffe6c4, 2.6);
    this.sun.castShadow = true;
    const ms = quality === 'mobile' ? 1024 : quality === 'ultra' ? 4096 : 2048;
    this.sun.shadow.mapSize.set(ms, ms);
    this.shadowSize = quality === 'mobile' ? 45 : 70;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -this.shadowSize;
    sc.right = sc.top = this.shadowSize;
    sc.near = 1;
    sc.far = 600;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);
  }

  update(focus: THREE.Vector3): void {
    // snap the shadow frustum centre to shadow-map texels
    const texel = (this.shadowSize * 2) / this.sun.shadow.mapSize.x;
    const f = focus.clone();
    f.x = Math.round(f.x / texel) * texel;
    f.z = Math.round(f.z / texel) * texel;
    this.sun.target.position.copy(f);
    this.sun.position.copy(f).addScaledVector(this.sunDir, 300);
    this.sky.position.copy(focus);
  }
}
