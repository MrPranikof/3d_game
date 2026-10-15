import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { ASSETS, type AssetSpec, fullPrompt, getSpec, variantKey } from './AssetRegistry';
import { detectQualityTier, FACTORY_VERSION, GLOBAL_STYLE_PREFIX, QUALITY, type QualityTier, STYLE_HASH, type Team } from './StylePreset';
import { validateAsset, type ValidationReport } from './pipeline/AssetValidator';
import { GLBCache } from './pipeline/GLBCache';
import { exportGLB, optimizeGLB, TextureEncodeCache } from './pipeline/GLBPipeline';
import { generateLODs } from './pipeline/LODBuilder';
import { type AssetInstance, type AssetTemplate, ModelLoader } from './pipeline/ModelLoader';
import { ProceduralEngine } from './procedural/ProceduralEngine';
import { TripoProvider } from './providers/TripoProvider';

/**
 * SingleAIModelFactory — the ONE place where 3D models come from.
 *
 *   request(id, team)
 *     └─ IndexedDB hit? ──yes──► parse .glb ─► fold LODs ─► template ─► clone instances
 *            │no
 *            ▼
 *     ENGINE (exactly one per session, locked at init):
 *        'tripo'       Tripo3D API v2.5 via key-holding proxy (parts / auto-rig / fragmenting)
 *        'procedural'  built-in generator (same prompts, same metric scale, same PBR library)
 *            ▼
 *     LOD1–3 (meshoptimizer) ─► validation (nodes, 1u = 1m, PBR) ─► GLTFExporter .glb
 *            ▼
 *     gltf-transform: dedup + prune + EXT_meshopt_compression (+ WebP textures) ─► IndexedDB
 *
 * Mixing engines is forbidden: the engine is part of every cache key, and a session never
 * falls back per-asset. If the remote engine fails, generation stops with an error and the
 * caller may explicitly rebuild the WHOLE library with the other engine (`switchEngine`).
 */

export type EngineId = 'procedural' | 'tripo';

export interface FactoryOptions {
  /** 'auto' → Tripo if the proxy has a key, else procedural. */
  engine?: EngineId | 'auto';
  quality?: QualityTier;
  useCache?: boolean;
  compress?: boolean;
  tripoEndpoint?: string;
}

export interface FactoryEvent {
  type: 'status' | 'asset-start' | 'asset-done' | 'error';
  id?: string;
  message: string;
  progress?: number;
}

export interface GeneratedAsset {
  key: string;
  id: string;
  team?: Team;
  bytes: ArrayBuffer;
  fromCache: boolean;
  engine: EngineId;
  ms: number;
  report?: ValidationReport;
  sizes?: { raw: number; optimized: number };
  lodTriangles?: number[];
}

export class SingleAIModelFactory extends EventTarget {
  readonly quality: QualityTier;
  private engineId: EngineId | null = null;
  private procedural?: ProceduralEngine;
  private tripo?: TripoProvider;
  private readonly cache = new GLBCache();
  private readonly textureCache = new TextureEncodeCache();
  private readonly loader = new ModelLoader();
  private readonly templates = new Map<string, Promise<AssetTemplate>>();
  private readonly inflight = new Map<string, Promise<GeneratedAsset>>();
  private readonly results = new Map<string, GeneratedAsset>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: FactoryOptions = {}) {
    super();
    this.quality = opts.quality ?? detectQualityTier();
  }

  get engine(): EngineId {
    if (!this.engineId) throw new Error('SingleAIModelFactory.init() has not been called');
    return this.engineId;
  }

  get stylePrefix(): string {
    return GLOBAL_STYLE_PREFIX;
  }

  /** Locks the single engine for this session and prepares decoders. */
  async init(renderer?: unknown): Promise<EngineId> {
    const want = this.opts.engine ?? 'auto';
    this.tripo = new TripoProvider(this.opts.tripoEndpoint, (m) => this.emit({ type: 'status', message: m }));
    if (want === 'tripo' || (want === 'auto' && (await this.tripo.available()))) this.engineId = 'tripo';
    else this.engineId = 'procedural';
    if (renderer) await this.loader.attachRenderer(renderer);
    void this.cache.requestPersistence();
    this.emit({ type: 'status', message: `engine locked: ${this.engineId} · quality ${this.quality} · style ${STYLE_HASH}` });
    return this.engineId;
  }

  /** Rebuild-everything switch (never per asset): clears templates so nothing mixes. */
  async switchEngine(engine: EngineId): Promise<void> {
    this.engineId = engine;
    this.templates.clear();
    this.results.clear();
  }

  cacheKey(id: string, team?: Team): string {
    return `${variantKey(id, team)}|${this.engine}|${this.quality}|${STYLE_HASH}`;
  }

  /** Generate (or fetch from cache) the optimised .glb for an asset. */
  generate(id: string, team?: Team): Promise<GeneratedAsset> {
    const spec = getSpec(id);
    if (spec.teamVariants && !team) team = 'A';
    if (!spec.teamVariants) team = undefined;
    const key = this.cacheKey(id, team);
    let p = this.inflight.get(key);
    if (!p) {
      // serialise generation: texture synthesis + export are main-thread heavy, keep frames flowing
      p = (this.queue = this.queue.then(() => this.generateNow(spec, key, team))) as Promise<GeneratedAsset>;
      this.inflight.set(key, p);
      p.catch(() => this.inflight.delete(key));
    }
    return p;
  }

  private async generateNow(spec: AssetSpec, key: string, team?: Team): Promise<GeneratedAsset> {
    const t0 = performance.now();
    if (this.opts.useCache !== false) {
      const hit = await this.cache.get(key);
      if (hit) {
        const r: GeneratedAsset = { key, id: spec.id, team, bytes: hit.bytes, fromCache: true, engine: this.engine, ms: performance.now() - t0, report: hit.meta.report as ValidationReport, sizes: hit.meta.sizes as GeneratedAsset['sizes'], lodTriangles: hit.meta.lodTriangles as number[] };
        this.results.set(key, r);
        this.emit({ type: 'asset-done', id: spec.id, message: `${spec.id}${team ? `/${team}` : ''} ← cache (${kb(hit.size)})` });
        return r;
      }
    }
    this.emit({ type: 'asset-start', id: spec.id, message: `${spec.id}${team ? `/${team}` : ''}: generating with ${this.engine}` });
    await nextFrame();

    // 1) build with the single engine
    let root: THREE.Group, animations: THREE.AnimationClip[];
    if (this.engine === 'tripo') {
      const r = await this.tripo!.build(spec, team);
      root = r.root;
      animations = r.animations;
      ensureIndexed(root);
    } else {
      this.procedural ??= new ProceduralEngine(QUALITY[this.quality]);
      const r = this.procedural.build(spec, team);
      root = r.root;
      animations = r.animations;
    }
    await nextFrame();

    // 2) metadata travels inside the .glb (root extras)
    root.userData = {
      ...root.userData,
      assetId: spec.id,
      team: team ?? null,
      category: spec.category,
      engine: this.engine,
      prompt: fullPrompt(spec, team),
      styleHash: STYLE_HASH,
      factoryVersion: FACTORY_VERSION,
      unit: 'meter',
      lodDistances: spec.lodDistances,
    };

    // 3) validate the unified standard (before LODs so counts reflect LOD0)
    const report = validateAsset(root, spec);
    if (report.missingNodes.length) throw new Error(`${spec.id}: missing required nodes ${report.missingNodes.join(', ')}`);
    for (const w of report.warnings) console.warn(`[SingleAIModelFactory] ${spec.id}: ${w}`);

    // 4) LOD1–LOD3
    const lod = await generateLODs(root, QUALITY[this.quality].lodRatios);
    await nextFrame();

    // 5) export + optimise
    const raw = await exportGLB(root, animations, QUALITY[this.quality].textureSize, this.textureCache);
    const opt = await optimizeGLB(raw, this.opts.compress !== false);
    const bytes = opt.bytes.slice().buffer as ArrayBuffer;
    disposeTree(root);

    const result: GeneratedAsset = {
      key, id: spec.id, team, bytes, fromCache: false, engine: this.engine, ms: performance.now() - t0, report,
      sizes: { raw: opt.rawSize, optimized: opt.optimizedSize }, lodTriangles: lod.triangles.map(Math.round),
    };
    if (this.opts.useCache !== false) {
      await this.cache.put({ key, assetId: spec.id, bytes, meta: { report, sizes: result.sizes, lodTriangles: result.lodTriangles, engine: this.engine }, createdAt: Date.now(), size: bytes.byteLength });
    }
    this.results.set(key, result);
    this.emit({ type: 'asset-done', id: spec.id, message: `${spec.id}${team ? `/${team}` : ''}: ${report.triangles} tris, ${kb(opt.rawSize)} → ${kb(opt.optimizedSize)}, ${Math.round(result.ms)} ms` });
    return result;
  }

  /** Parsed, LOD-folded template (memoised). */
  load(id: string, team?: Team): Promise<AssetTemplate> {
    const spec = getSpec(id);
    const t = spec.teamVariants ? team ?? 'A' : undefined;
    const key = this.cacheKey(id, t);
    let p = this.templates.get(key);
    if (!p) {
      p = this.generate(id, t).then((g) => this.loader.parse(g.bytes));
      this.templates.set(key, p);
      p.catch(() => this.templates.delete(key));
    }
    return p;
  }

  /** Ready-to-add instance with node lookup map (Turret, Prop_FL, Wall_Cluster_05 …). */
  async instantiate(id: string, team?: Team): Promise<AssetInstance> {
    return this.loader.instantiate(await this.load(id, team));
  }

  /** Generate the full library (both team variants for infantry). */
  async generateAll(filter: (s: AssetSpec) => boolean = () => true): Promise<GeneratedAsset[]> {
    const jobs: [string, Team | undefined][] = [];
    for (const s of ASSETS.filter(filter)) {
      if (s.teamVariants) jobs.push([s.id, 'A'], [s.id, 'B']);
      else jobs.push([s.id, undefined]);
    }
    const out: GeneratedAsset[] = [];
    for (let i = 0; i < jobs.length; i++) {
      out.push(await this.generate(...jobs[i]));
      this.emit({ type: 'status', message: `library ${i + 1}/${jobs.length}`, progress: (i + 1) / jobs.length });
    }
    return out;
  }

  result(id: string, team?: Team): GeneratedAsset | undefined {
    const spec = getSpec(id);
    return this.results.get(this.cacheKey(id, spec.teamVariants ? team ?? 'A' : undefined));
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
    this.templates.clear();
    this.results.clear();
    this.inflight.clear();
  }

  cacheStats() {
    return this.cache.stats();
  }

  /** Download helper for artists / debugging. */
  downloadGLB(id: string, team?: Team): void {
    const r = this.result(id, team);
    if (!r) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.bytes], { type: 'model/gltf-binary' }));
    a.download = `${variantKey(id, r.team)}.glb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  private emit(e: FactoryEvent): void {
    this.dispatchEvent(new CustomEvent<FactoryEvent>('progress', { detail: e }));
  }
}

function ensureIndexed(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.geometry.index) m.geometry = mergeVertices(m.geometry, 1e-5);
  });
}

function disposeTree(root: THREE.Object3D): void {
  const geoms = new Set<THREE.BufferGeometry>();
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) geoms.add(m.geometry); });
  geoms.forEach((g) => g.dispose());
}

// yield to the event loop (setTimeout, not rAF: generation must continue in background tabs)
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
