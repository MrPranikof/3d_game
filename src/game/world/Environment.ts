import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { min, vec3, vec4 } from 'three/tsl';

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
    tameSky(this.sky);
    this.sky.sunPosition.value.copy(this.sunDir);
    this.sky.userData.heat = 0.02;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // haze matches the (tamed) sky near the horizon so distant terrain melts into it instead of a white wall
    const hazeColor = new THREE.Color(0xb3bdbb);
    scene.fog = new THREE.Fog(hazeColor, 260, quality === 'mobile' ? 800 : 1300);
    scene.background = hazeColor;

    try {
      const envScene = new THREE.Scene();
      const sky2 = new SkyMesh();
      sky2.scale.setScalar(1000);
      tameSky(sky2);
      sky2.sunPosition.value.copy(this.sunDir);
      envScene.add(sky2);
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(envScene, 0.02).texture;
      scene.environmentIntensity = 0.55;
    } catch (e) {
      console.warn('sky environment unavailable', e);
    }

    scene.add(new THREE.HemisphereLight(0xbfd0e0, 0x4d4632, 0.6));
    this.sun = new THREE.DirectionalLight(0xffe9cc, 2.2);
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

/**
 * The physical sky is HDR (horizon and sun disc far above 1.0), which washed the screen out
 * through bloom. Bluer, clearer atmosphere, no sun disc, and output capped near display white.
 */
function tameSky(sky: SkyMesh): void {
  sky.turbidity.value = 2.6;
  sky.rayleigh.value = 3.0;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.8;
  sky.showSunDisc.value = 0;
  sky.cloudCoverage.value = 0.3;
  const mat = sky.material as THREE.NodeMaterial;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node chains
  const base = mat.colorNode as any;
  mat.colorNode = vec4(min(base.rgb.mul(0.62), vec3(0.95)), 1);
}
