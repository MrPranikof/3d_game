import * as THREE from 'three/webgpu';
import { clamp, dot, float, max, mix, mx_fractal_noise_float, normalize, positionLocal, pow, smoothstep, time, uniform, vec2, vec3 } from 'three/tsl';

// linear-light palette of a clear late-summer afternoon (cf. the references: deep blue zenith, pale horizon)
const ZENITH = new THREE.Color().setRGB(0.1, 0.25, 0.68, THREE.LinearSRGBColorSpace);
const HORIZON = new THREE.Color().setRGB(0.52, 0.66, 0.84, THREE.LinearSRGBColorSpace);
const HAZE = new THREE.Color().setRGB(0.46, 0.58, 0.72, THREE.LinearSRGBColorSpace);

/**
 * Late-summer steppe afternoon: stylised blue sky with drifting cumulus, warm sun with a shadow
 * frustum that follows the camera (texel-snapped), sky-tinted fill, sky-based image lighting and
 * bluish aerial perspective.
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly sunDir = new THREE.Vector3();
  private sky: THREE.Mesh;
  private shadowSize: number;

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer, quality: 'mobile' | 'desktop' | 'ultra') {
    const elevation = 34, azimuth = 215;
    const phi = THREE.MathUtils.degToRad(90 - elevation), theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    this.sky = makeSky(this.sunDir, quality !== 'mobile', true);
    this.sky.userData.heat = 0.02;
    scene.add(this.sky);

    scene.fog = new THREE.Fog(HAZE, 220, quality === 'mobile' ? 900 : 1400);
    scene.background = HORIZON;

    try {
      const envScene = new THREE.Scene();
      envScene.add(makeSky(this.sunDir, false, false));
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(envScene, 0.02).texture;
      scene.environmentIntensity = 0.75;
    } catch (e) {
      console.warn('sky environment unavailable', e);
    }

    // generous sky fill: shaded slopes and backlit foliage must stay readable, not black
    scene.add(new THREE.HemisphereLight(0xa8c8ff, 0x7a6a44, 1.0));
    this.sun = new THREE.DirectionalLight(0xfff0d6, 3.4);
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

  private frame = 0;
  /** shadow map refresh interval in frames (1 = every frame) */
  shadowEvery = 1;

  update(focus: THREE.Vector3): void {
    this.sky.position.copy(focus);
    // the shadow map is re-rendered every `shadowEvery` frames; the light only moves on those
    // frames so lookups always match the map they sample
    const refresh = this.frame++ % this.shadowEvery === 0;
    this.sun.shadow.autoUpdate = false;
    if (!refresh) return;
    this.sun.shadow.needsUpdate = true;
    // snap the shadow frustum centre to shadow-map texels
    const texel = (this.shadowSize * 2) / this.sun.shadow.mapSize.x;
    const f = focus.clone();
    f.x = Math.round(f.x / texel) * texel;
    f.z = Math.round(f.z / texel) * texel;
    this.sun.target.position.copy(f);
    this.sun.position.copy(f).addScaledVector(this.sunDir, 300);
  }
}

/**
 * Sky dome centred on the camera: zenith→horizon gradient, sun glow, and (optionally) fbm cumulus
 * projected on a flat cloud layer, slowly drifting. Output stays in a moderate HDR range so bloom
 * and ACES don't wash it out.
 */
function makeSky(sunDir: THREE.Vector3, clouds: boolean, animated: boolean): THREE.Mesh {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const sun = uniform(sunDir.clone());
  const d = normalize(positionLocal);
  const up = clamp(d.y, 0, 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node chains
  let col: any = mix(vec3(HORIZON.r, HORIZON.g, HORIZON.b), vec3(ZENITH.r, ZENITH.g, ZENITH.b), pow(up, float(0.55)));
  // below the horizon: haze (hidden by terrain except at the map edge)
  col = mix(vec3(HAZE.r, HAZE.g, HAZE.b), col, smoothstep(-0.08, 0.02, d.y));
  const cs = max(dot(d, sun), 0);
  col = col.add(vec3(1.0, 0.85, 0.6).mul(pow(cs, float(8)).mul(0.25).add(pow(cs, float(400)).mul(6))));
  if (clouds) {
    const t = animated ? time.mul(0.004) : float(0);
    const uv = d.xz.div(d.y.add(0.12)).mul(0.9).add(vec2(t, t.mul(0.4)));
    const n = mx_fractal_noise_float(vec3(uv, 0), 5, 2.0, 0.5).mul(0.5).add(0.5);
    const cover = smoothstep(0.52, 0.72, n).mul(smoothstep(0.02, 0.18, d.y));
    // lit tops, slightly grey undersides; brighter towards the sun
    const shade = smoothstep(0.52, 0.85, n);
    const cloud = mix(vec3(0.62, 0.66, 0.72), vec3(1.05, 1.02, 0.98), shade).add(vec3(0.3, 0.25, 0.18).mul(pow(cs, float(4))));
    col = mix(col, cloud, cover.mul(0.92));
  }
  mat.colorNode = col;
  const m = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}
