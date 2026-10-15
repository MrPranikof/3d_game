import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { type AssetSpec, fullPrompt, HUMANOID_BONES, pad } from '../AssetRegistry';
import { GLOBAL_STYLE_PREFIX, type Team } from '../StylePreset';

/**
 * Remote single-engine provider: Tripo3D API v2.5.
 *
 * The browser never sees the API key — it talks to a same-origin proxy (`server/tripo-proxy.mjs`,
 * exposed by Vite at /api/tripo) that injects `Authorization: Bearer $TRIPO_API_KEY`.
 *
 * Strategy that keeps the gameplay node contract with a "one mesh per prompt" generator:
 *   • specs with `parts`  → every part is generated separately by the SAME engine, normalised to
 *                           its metric size and mounted on its pivot (Hull/Turret/Cannon, Prop_FL…)
 *   • infantry            → text_to_model → animate_prerigcheck → animate_rig, bones retargeted
 *                           to the Humanoid names
 *   • environment         → whole model, then split into Foundation / Wall_Cluster / Roof_Cluster /
 *                           Crown_Cluster fragments by geometric region (see splitIntoClusters)
 */

const MODEL_VERSION = 'v2.5-20250123';
const NEGATIVE = 'low poly, cartoon, toy, stylized, blurry texture, floating parts, text, logo';

type TaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'unknown' | 'banned' | 'expired';

interface TaskResult {
  task_id: string;
  status: TaskStatus;
  progress: number;
  output?: { model?: string; base_model?: string; pbr_model?: string; rendered_image?: string };
}

export interface RemoteBuild {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
  taskIds: string[];
}

export class TripoProvider {
  readonly name = 'tripo3d-v2.5';
  private loader = new GLTFLoader();

  constructor(private readonly endpoint = '/api/tripo', private readonly onStatus?: (msg: string) => void) {
    this.loader.setDRACOLoader(new DRACOLoader());
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  /** True when the proxy is up AND has an API key configured. */
  async available(timeoutMs = 2500): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(`${this.endpoint}/health`, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) return false;
      const j = await r.json();
      return !!j.ok && !!j.hasKey;
    } catch {
      return false;
    }
  }

  async build(spec: AssetSpec, team?: Team): Promise<RemoteBuild> {
    const root = new THREE.Group();
    root.name = team ? `${spec.id}_team${team}` : spec.id;
    const taskIds: string[] = [];
    let animations: THREE.AnimationClip[] = [];

    if (spec.parts?.length) {
      const nodes = new Map<string, THREE.Object3D>();
      for (const part of spec.parts) {
        const pivot = new THREE.Group();
        pivot.name = part.node;
        pivot.position.set(...part.pivot);
        (part.parent ? nodes.get(part.parent)! : root).add(pivot);
        nodes.set(part.node, pivot);
        const prompt = `${GLOBAL_STYLE_PREFIX} ${spec.prompt} Isolated component: ${part.prompt ?? part.node}.`;
        const { scene, taskId } = await this.textToModel(prompt, 'part');
        taskIds.push(taskId);
        normaliseInto(scene, pivot, part.size);
      }
    } else if (spec.rigged) {
      const { taskId } = await this.textToModel(fullPrompt(spec, team), 'rig-src');
      taskIds.push(taskId);
      this.onStatus?.(`${spec.id}: auto-rigging`);
      const check = await this.runTask({ type: 'animate_prerigcheck', original_model_task_id: taskId });
      taskIds.push(check.task_id);
      const rig = await this.runTask({ type: 'animate_rig', original_model_task_id: taskId, out_format: 'glb', spec: 'mixamo' });
      taskIds.push(rig.task_id);
      const gltf = await this.loadUrl(rig.output?.model ?? '');
      retargetHumanoid(gltf.scene);
      normaliseInto(gltf.scene, root, spec.dimensions);
      animations = gltf.animations;
    } else {
      const { scene, taskId } = await this.textToModel(fullPrompt(spec, team), 'whole');
      taskIds.push(taskId);
      normaliseInto(scene, root, spec.dimensions);
      if (spec.category === 'environment') splitIntoClusters(root, spec);
    }
    // anchors the remote engine cannot know about (Muzzle, Cam_*, Grip_Point …) are added empty
    ensureAnchors(root, spec);
    root.userData.remoteTasks = taskIds;
    return { root, animations, taskIds };
  }

  // ───────────── REST helpers ─────────────

  private async textToModel(prompt: string, tag: string): Promise<{ scene: THREE.Group; taskId: string }> {
    this.onStatus?.(`tripo:${tag} → ${prompt.slice(GLOBAL_STYLE_PREFIX.length, GLOBAL_STYLE_PREFIX.length + 60)}…`);
    const task = await this.runTask({
      type: 'text_to_model',
      model_version: MODEL_VERSION,
      prompt,
      negative_prompt: NEGATIVE,
      texture: true,
      pbr: true,
      texture_quality: 'detailed',
      auto_size: true, // real-world metres
      face_limit: tag === 'part' ? 20000 : 60000,
    });
    const url = task.output?.pbr_model ?? task.output?.model;
    if (!url) throw new Error(`Tripo task ${task.task_id} returned no model`);
    const gltf = await this.loadUrl(url);
    return { scene: gltf.scene, taskId: task.task_id };
  }

  private async runTask(body: Record<string, unknown>): Promise<TaskResult> {
    const r = await fetch(`${this.endpoint}/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok || j.code !== 0) throw new Error(`Tripo create failed: ${JSON.stringify(j).slice(0, 300)}`);
    const id: string = j.data.task_id;
    const started = performance.now();
    let delay = 2000;
    for (;;) {
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 1.3, 8000);
      const s = await fetch(`${this.endpoint}/task/${encodeURIComponent(id)}`).then((x) => x.json());
      const data: TaskResult = s.data;
      this.onStatus?.(`tripo ${body.type} ${id.slice(0, 8)}: ${data.status} ${data.progress ?? 0}%`);
      if (data.status === 'success') return data;
      if (['failed', 'cancelled', 'unknown', 'banned', 'expired'].includes(data.status)) throw new Error(`Tripo task ${id} ${data.status}`);
      if (performance.now() - started > 10 * 60_000) throw new Error(`Tripo task ${id} timed out`);
    }
  }

  private async loadUrl(url: string) {
    // model URLs are signed CDN links without CORS → fetched through the proxy
    const bytes = await fetch(`${this.endpoint}/fetch?url=${encodeURIComponent(url)}`).then((r) => {
      if (!r.ok) throw new Error(`model download failed ${r.status}`);
      return r.arrayBuffer();
    });
    return this.loader.parseAsync(bytes, '');
  }
}

// ───────────── normalisation & fragmenting ─────────────

/** Uniformly scale `scene` to fit `size` (metres), centre XZ, sit on y=0, attach under `target`. */
function normaliseInto(scene: THREE.Object3D, target: THREE.Object3D, size?: [number, number, number]): void {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const s = box.getSize(new THREE.Vector3());
  let k = 1;
  if (size) {
    const ratios = [size[0] / (s.x || 1), size[1] / (s.y || 1), size[2] / (s.z || 1)];
    k = Math.min(...ratios);
  }
  const c = box.getCenter(new THREE.Vector3());
  const holder = new THREE.Group();
  holder.name = `${target.name}_geo`;
  holder.scale.setScalar(k);
  holder.position.set(-c.x * k, -box.min.y * k, -c.z * k);
  holder.add(scene);
  target.add(holder);
  // unified material contract: everything becomes metal/roughness PBR
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    if (!src.isMeshStandardMaterial) {
      const std = new THREE.MeshStandardMaterial({ map: (src as unknown as THREE.MeshBasicMaterial).map ?? null, roughness: 0.8, metalness: 0.1 });
      std.name = src.name;
      m.material = std;
    }
    m.castShadow = m.receiveShadow = true;
  });
}

const MIXAMO_MAP: Record<string, string> = {
  Hips: 'Pelvis', Spine: 'Spine', Spine1: 'Chest', Spine2: 'Chest', Neck: 'Neck', Head: 'Head',
  LeftShoulder: 'LeftShoulder', LeftArm: 'LeftArm', LeftForeArm: 'LeftForeArm', LeftHand: 'LeftHand',
  RightShoulder: 'RightShoulder', RightArm: 'RightArm', RightForeArm: 'RightForeArm', RightHand: 'RightHand',
  LeftUpLeg: 'LeftUpLeg', LeftLeg: 'LeftLeg', LeftFoot: 'LeftFoot', RightUpLeg: 'RightUpLeg', RightLeg: 'RightLeg', RightFoot: 'RightFoot',
};

/** Rename Mixamo/Tripo bones to the Humanoid contract; add Root and WeaponMount_R. */
function retargetHumanoid(scene: THREE.Object3D): void {
  const used = new Set<string>();
  scene.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    const key = o.name.replace(/^mixamorig[:_]?/i, '').replace(/^Bip\d*[_ ]?/i, '');
    const mapped = MIXAMO_MAP[key];
    if (mapped && !used.has(mapped)) { o.name = mapped; used.add(mapped); }
  });
  const hips = scene.getObjectByName('Pelvis');
  if (hips && hips.parent && !scene.getObjectByName('Root')) {
    const root = new THREE.Bone();
    root.name = 'Root';
    hips.parent.add(root);
    root.add(hips);
  }
  const hand = scene.getObjectByName('RightHand');
  if (hand && !scene.getObjectByName('WeaponMount_R')) {
    const mount = new THREE.Bone();
    mount.name = 'WeaponMount_R';
    mount.position.set(0, 0.06, 0);
    hand.add(mount);
  }
  for (const b of HUMANOID_BONES) if (!scene.getObjectByName(b)) console.warn(`[Tripo] rig is missing bone ${b}`);
}

/**
 * Splits a monolithic remote building/tree mesh into destruction clusters by region:
 * low band → Foundation, high band → Roof/Crown sectors, the rest → Wall sectors (by azimuth).
 */
function splitIntoClusters(root: THREE.Object3D, spec: AssetSpec): void {
  const want = (prefix: string) => spec.requiredNodes.filter((n) => n.startsWith(prefix)).length;
  const walls = want('Wall_Cluster_'), roofs = want('Roof_Cluster_'), crowns = want('Crown_Cluster_');
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const H = box.max.y - box.min.y;
  const buckets = new Map<string, { pos: number[]; nrm: number[]; uv: number[]; mat: THREE.Material }>();
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i + 2).applyMatrix4(mesh.matrixWorld);
      const cy = (a.y + b.y + c.y) / 3 - box.min.y;
      const cx = (a.x + b.x + c.x) / 3, cz = (a.z + b.z + c.z) / 3;
      n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      const az = (Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2);
      let name: string;
      if (cy < H * 0.08) name = 'Foundation';
      else if (crowns && cy > H * 0.35) name = `Crown_Cluster_${pad(1 + Math.min(crowns - 1, Math.floor(az * crowns)))}`;
      else if (crowns) name = cy < H * 0.12 ? 'Foundation' : 'Trunk_Upper';
      else if (roofs && cy > H * 0.6 && n.y > 0.25) name = `Roof_Cluster_${pad(1 + Math.min(roofs - 1, Math.floor(az * roofs)))}`;
      else if (walls) name = `Wall_Cluster_${pad(1 + Math.min(walls - 1, Math.floor(az * walls)))}`;
      else name = 'Foundation';
      const key = `${name}|${(mesh.material as THREE.Material).uuid}`;
      let bk = buckets.get(key);
      if (!bk) buckets.set(key, (bk = { pos: [], nrm: [], uv: [], mat: mesh.material as THREE.Material }));
      for (const [k, v] of [a, b, c].entries()) {
        bk.pos.push(v.x, v.y, v.z);
        bk.nrm.push(n.x, n.y, n.z);
        if (uv) bk.uv.push(uv.getX(i + k), uv.getY(i + k)); else bk.uv.push(0, 0);
      }
    }
  }
  root.clear();
  const nodes = new Map<string, THREE.Group>();
  for (const [key, bk] of buckets) {
    const name = key.split('|')[0];
    let nd = nodes.get(name);
    if (!nd) { nd = new THREE.Group(); nd.name = name; nodes.set(name, nd); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
    g.computeBoundingBox();
    const ctr = g.boundingBox!.getCenter(new THREE.Vector3());
    g.translate(-ctr.x, -ctr.y, -ctr.z);
    const m = new THREE.Mesh(g, bk.mat);
    m.name = `${name}_m_${bk.mat.name || 'mat'}`;
    m.position.copy(ctr);
    nd.add(m);
  }
  const trunk = nodes.get('Trunk_Upper');
  for (const [name, nd] of nodes) {
    if (name.startsWith('Crown_Cluster_') && trunk) trunk.add(nd); else root.add(nd);
  }
}

function ensureAnchors(root: THREE.Object3D, spec: AssetSpec): void {
  const box = new THREE.Box3().setFromObject(root);
  for (const name of spec.requiredNodes) {
    if (root.getObjectByName(name)) continue;
    const g = new THREE.Group();
    g.name = name;
    if (name === 'Muzzle') g.position.set(0, (box.min.y + box.max.y) / 2, box.min.z);
    else if (name.startsWith('Cam_')) g.position.set(0, box.max.y * 0.8, box.min.z * 0.5);
    const parent = name === 'Muzzle' ? root.getObjectByName('Cannon') ?? root : root;
    parent.add(g);
  }
}
