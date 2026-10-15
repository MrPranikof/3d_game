import * as THREE from 'three/webgpu';
import { abs, clamp, float, floor, fract, hash, length, luminance, mix, pass, pow, screenUV, sin, smoothstep, step, time, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

/**
 * Post-processing graph in TSL (compiles to WGSL on WebGPU and GLSL on WebGL2):
 *  • analog FPV video link: line jitter, rolling bar, chroma bleed, grain, signal-loss static
 *    (driven by range / terrain masking / EW interference);
 *  • thermal imaging palette (white-hot) on top of the thermal material swap;
 *  • scope / sight vignettes, damage & suppression vignette, battlefield colour grade, bloom.
 * Tone mapping (ACES Filmic) is applied by the pipeline's output transform.
 */
export class PostFX {
  readonly pipeline: THREE.RenderPipeline;
  readonly uNoise = uniform(0);
  readonly uLost = uniform(0);
  readonly uThermal = uniform(0);
  readonly uDamage = uniform(0);
  readonly uScope = uniform(0);
  readonly uStatic = uniform(0);
  readonly uSuppress = uniform(0);
  readonly uAspect = uniform(1);
  readonly uSightNoise = uniform(0);
  private staticFlash = 0;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, withBloom: boolean) {
    this.pipeline = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    const uv0 = screenUV;
    const n = clamp(this.uNoise.add(this.uSightNoise), 0, 1);
    const t = time;

    // ── analog link distortion ──
    const line = floor(uv0.y.mul(240));
    const frame = floor(t.mul(30));
    const jitter = hash(line.add(frame.mul(613))).sub(0.5).mul(n.mul(n).mul(0.035));
    const bar = smoothstep(0.0, 0.08, abs(fract(uv0.y.add(t.mul(0.37))).sub(0.5)).sub(0.38)).oneMinus().mul(n.mul(0.012));
    const uvd = vec2(uv0.x.add(jitter).add(bar), uv0.y);
    const base = color.sample(uvd);
    const shifted = color.sample(uvd.add(vec2(n.mul(0.006), 0)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node chains are re-typed at every step
    let c: any = vec3(mix(base.r, shifted.r, n), base.g, mix(base.b, color.sample(uvd.sub(vec2(n.mul(0.004), 0))).b, n));
    if (withBloom) c = c.add(bloom(color, 0.12, 0.3, 1.1).rgb);

    // ── colour grade: slightly desaturated, cool shadows / warm highlights ──
    const lum = luminance(c);
    c = mix(vec3(lum), c, 0.88);
    c = c.mul(mix(vec3(0.93, 0.98, 1.05), vec3(1.05, 1.0, 0.94), smoothstep(0.05, 0.6, lum)));

    // ── thermal (white-hot) ──
    const th = pow(clamp(luminance(c).mul(1.4), 0, 1), float(0.85));
    const thermalCol = vec3(th.mul(0.95).add(0.02), th, th.mul(0.97));
    c = mix(c, thermalCol, this.uThermal);

    // ── grain & static ──
    const seed = uv0.x.mul(1913.7).add(uv0.y.mul(7919.3)).add(fract(t.mul(13.1)).mul(9973));
    const grain = hash(seed);
    c = c.add(grain.sub(0.5).mul(n.mul(0.5).add(this.uThermal.mul(0.06)).add(0.012)));
    const snow = vec3(hash(seed.add(17)).mul(0.8));
    c = mix(c, snow, clamp(this.uLost.add(this.uStatic), 0, 1));
    // scanline darkening at high interference
    c = c.mul(sin(uv0.y.mul(900)).mul(n.mul(0.08)).add(1));

    // ── vignettes ──
    const centred = uv0.sub(0.5).mul(vec2(this.uAspect, 1));
    const r = length(centred);
    c = c.mul(smoothstep(0.95, 0.35, r).mul(0.25).add(0.75)); // lens vignette
    const scopeMask = step(r, 0.44);
    c = mix(c, c.mul(scopeMask), this.uScope);
    const edge = smoothstep(0.3, 0.85, r);
    c = mix(c, vec3(0.35, 0.0, 0.0), edge.mul(this.uDamage).mul(0.75));
    c = c.mul(edge.mul(this.uSuppress).mul(-0.45).add(1));

    this.pipeline.outputNode = vec4(c, 1);
  }

  setNoise(v: number, lost: boolean): void {
    this.uNoise.value = v;
    this.uLost.value = lost ? 1 : 0;
  }

  flashStatic(): void {
    this.staticFlash = 0.45;
  }

  update(dt: number, w: number, h: number): void {
    this.staticFlash = Math.max(0, this.staticFlash - dt);
    this.uStatic.value = this.staticFlash > 0 ? 1 : 0;
    this.uAspect.value = w / h;
  }

  render(): void {
    this.pipeline.render();
  }
}
