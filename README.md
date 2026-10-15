# «Малая Токмачка» — браузерный тактический MilSim

Браузерный тактический шутер (WebGPU с фоллбэком на WebGL2, Rapier3D, TSL-шейдеры) на карте «Малая Токмачка»:
одиночный режим «Захват» против ботов, пехота, танки, БМП, FPV-дроны, ПТУР, миномёт, РЭБ, разрушаемая застройка.
Работает на ПК (мышь/клавиатура, геймпад) и на смартфонах (мультитач-HUD + гироскоп).

```bash
npm install
npm run dev          # http://localhost:5173 — игра, /showroom.html — стенд 3D-моделей
npm run build        # tsc + vite build → dist/ (статический сайт, относительные пути)
```

## Игра

- **Режим «Захват»**: точки A «Посадка», B «Центр села», C «Ферма»; тикеты списываются за гибели (−1), потерю техники (−5)
  и за удержание противником большего числа точек. Высадка — на базе или на своих точках.
- **Пехота**: баллистика (гравитация, квадратичное сопротивление, ветер), спринт, подкат (C на бегу), наклоны Q/E,
  стоя/сидя/лёжа, коллиматор и оптика 4×, отдача и разброс, гранаты, антидроновое РЭБ-ружьё, регенерация здоровья.
- **Танки и БМП** (Leopard 2A6/2A4, Т-72Б3, БМП-2): независимые корпус и башня, вид снаружи / прицел наводчика (3–12×) /
  смотровые приборы мехвода, лазерный дальномер и баллистический вычислитель, БОПС/ОФС, автопушка и ПТУР «Конкурс» у БМП,
  дымовая завеса, тепловизор, модульные повреждения (гусеница, клин башни, прицел, зоны брони), давят стены, заборы, деревья и пехоту.
- **FPV-дрон** (G): режимы Stabilize/Acro, батарея, качество видеосигнала (дальность, рельеф, высота, купола РЭБ) →
  аналоговые помехи в пост-обработке, ИК, сброс боеприпаса с инерцией, подрыв. Вражеские дроны-камикадзе охотятся на игрока.
- **Стационарное вооружение**: ПТУР с наведением по лучу (ведите ракету перекрестием) и 82-мм миномёт с расчётом угла.
- **Разрушения**: кластеры стен и крыш превращаются в физические обломки Rapier, при потере половины стен рушится крыша;
  деревья валятся от взрывов и техники.
- **ИИ**: боты захватывают и обороняют точки, видят с учётом поля зрения, линии видимости и дыма, стреляют очередями
  со временем реакции и ошибкой прицела, стреляют по дронам. Экипажи танков едут по дороге к рубежу и ведут огонь.

Файлы игры — `src/game/*`: `Game.ts` (оркестратор), `core/` (Physics, Input, Audio), `world/` (MapLayout, Terrain,
StaticWorld, Vegetation, Environment), `entities/` (Player, Soldier, BotAI, Vehicle, Drone, Emplacement),
`combat/Combat.ts`, `fx/` (PostFX, Thermal, Particles), `modes/Conquest.ts`, `ui/` (HUD, TouchControls, Menu).

## Генератор моделей (SingleAIModelFactory)

**Шаг 2. `SingleAIModelFactory`: единый генератор и загрузчик 3D-моделей.**

Все модели игры — пехота обеих команд, оружие, бронетехника, БПЛА, постройки, окопы и деревья — проходят через
одну фабрику с одним стандартом:

- масштаб **1 unit = 1 м**, +Y вверх, вперёд = −Z;
- PBR metal/roughness: **Albedo (sRGB) + Normal (OpenGL) + упакованная карта G = roughness / B = metallic**;
- общий префикс стиля `GLOBAL_STYLE_PREFIX` (`src/assets/StylePreset.ts`) у каждого промпта;
- иерархия именованных узлов, к которой привязывается геймплей (башня, ствол, гусеницы, винты, кластеры разрушения, скелет).

URL-параметры стенда (`/showroom.html`): `?asset=tank_leo2a6`, `?quality=mobile|desktop|ultra`, `?engine=procedural|tripo`.

## Конвейер

```
factory.instantiate('tank_t72b3')
  └─ IndexedDB hit? ─да─► GLTFLoader (Meshopt/Draco/KTX2) ─► LOD-объекты ─► клон (SkeletonUtils)
         │нет
         ▼
  ДВИЖОК (ровно один на сессию, фиксируется в init()):
     tripo       Tripo3D API v2.5 через прокси с ключом (по частям / авто-риг / разбиение на кластеры)
     procedural  встроенный генератор (те же промпты-спеки, та же метрика, та же PBR-библиотека)
         ▼
  LOD1–LOD3 (meshoptimizer, общие вершинные буферы) ─► валидация стандарта
         ▼
  GLTFExporter .glb ─► gltf-transform: dedup + prune + EXT_meshopt_compression ─► IndexedDB
```

Смешивать движки нельзя: движок входит в ключ кэша, а при сбое удалённого движка генерация останавливается с ошибкой
(никакого «тихого» отката отдельной модели на другой движок). Сменить движок можно только для всей библиотеки —
`factory.switchEngine()`.

### Выбор движка

| Режим | Когда | Что делает |
|---|---|---|
| `tripo` | `server/tripo-proxy.mjs` запущен с `TRIPO_API_KEY` | `text_to_model` (v2.5, `pbr`, `auto_size`), для пехоты `animate_prerigcheck` → `animate_rig` с переименованием костей в Humanoid; техника и дроны генерируются **по частям** (`parts` в реестре) и собираются на опорах; здания и деревья разбиваются на `Foundation / Wall_Cluster / Roof_Cluster / Crown_Cluster` по геометрическим регионам |
| `procedural` | API недоступен (по умолчанию в этой среде) | Билдеры в `src/assets/procedural/builders/*` строят ту же иерархию узлов с процедурными PBR-текстурами |

```bash
TRIPO_API_KEY=tsk_... npm run proxy:tripo   # :8787, Vite проксирует /api/tripo
npm run dev                                 # движок 'auto' выберет Tripo
```

Ключ API никогда не попадает в браузер: клиент обращается только к same-origin `/api/tripo/*`.

## Файлы

| Файл | Назначение |
|---|---|
| `src/assets/StylePreset.ts` | `GLOBAL_STYLE_PREFIX`, версия фабрики, уровни качества, стиль команд |
| `src/assets/AssetRegistry.ts` | Каталог всех моделей: промпт, реальные габариты, обязательные узлы, части, дистанции LOD |
| `src/assets/SingleAIModelFactory.ts` | Оркестратор: движок, кэш, LOD, валидация, экспорт, инстансы |
| `src/assets/procedural/TextureSynth.ts`, `noise.ts` | Синтез тайлящихся PBR-карт (шум, Ворлей, Собель → нормали) |
| `src/assets/procedural/MaterialLibrary.ts` | ~40 материалов единого стиля (камуфляжи MM-14 / ЭМР, краска ВС РФ, NATO 3-tone, ДЗ, кирпич, шифер…) |
| `src/assets/procedural/Kit.ts` | Примитивы, UV-проекция в метрах, слияние по материалам, скиннинг |
| `src/assets/procedural/builders/*.ts` | Бойцы, оружие, бронетехника, БПЛА, окружение |
| `src/assets/pipeline/LODBuilder.ts` | LOD1–3 на meshoptimizer (только новые индекс-буферы) |
| `src/assets/pipeline/AssetValidator.ts` | Проверка узлов, масштаба (±35 % от реальных габаритов) и PBR |
| `src/assets/pipeline/GLBPipeline.ts` | Экспорт .glb, кэш закодированных текстур, Meshopt-сжатие |
| `src/assets/pipeline/GLBCache.ts` | Кэш .glb в IndexedDB (+ `navigator.storage.persist()`) |
| `src/assets/pipeline/ModelLoader.ts` | Загрузка (Meshopt/Draco/KTX2), сборка `THREE.LOD`, клонирование |
| `src/assets/providers/TripoProvider.ts`, `server/tripo-proxy.mjs` | Удалённый движок Tripo3D v2.5 |
| `src/showroom/*` | Стенд проверки моделей (WebGPU → WebGL2 фоллбэк) |

## Контракт узлов (на него опираются шаги 3–4)

| Класс | Узлы |
|---|---|
| Боец (`soldier`, команды A/B) | Скелет `Root, Pelvis, Spine, Chest, Neck, Head, Left/Right Shoulder/Arm/ForeArm/Hand, Left/Right UpLeg/Leg/Foot, WeaponMount_R`; `Body` (skinned-меши), `Weapon` на `WeaponMount_R`; клипы `Idle, Walk, Run, Crouch` |
| Оружие | `Body, Magazine, Sight, Muzzle, Grip_Point, Aim_Point` (+ `Support_Point`); ПТУР: `Tripod, Yaw, Pitch, Tube`; миномёт: `Baseplate, Yaw, Tube, Bipod`; РЭБ: `Antenna, Emitter` |
| Танки / БМП | `Hull → Turret (Y) → Cannon (X, откат по +Z) → Muzzle`; `Track_L/Track_R` (лента с собственным материалом `track_links__L/R` для UV-скролла, `Wheel_*`, `Roller_*`, `Sprocket_*`, `Idler_*`); `Interior_Cockpit → Cam_Driver`; `Interior_Gunner → Cam_Gunner`; `Smoke_Launchers`, `Cage`; БМП: `Door_RL/RR` |
| БПЛА | `Frame`, `Prop_FL/FR/RL/RR` (вращение по Y) или `Prop_Main` + `Aileron_L/R` (крыло), `Camera_Gimbal → Cam_FPV`, `Payload` |
| Постройки | `Foundation` (статичное), `Wall_Cluster_01..16`, `Roof_Cluster_01..08` — начало координат каждого кластера в центре фрагмента, готово к превращению в динамическое тело Rapier |
| Деревья | `Foundation` (пень), `Trunk_Upper → Crown_Cluster_01..04` |

Пример использования в геймплее:

```ts
const factory = new SingleAIModelFactory();
await factory.init(renderer);
const tank = await factory.instantiate('tank_t72b3');
scene.add(tank.root);
tank.nodes.get('Turret')!.rotation.y = yaw;
tank.nodes.get('Cannon')!.rotation.x = -elevation;
```

## Ограничения текущей версии

- Процедурные модели — это детализированная составная геометрия с процедурными текстурами, а не скан-фотореализм;
  визуальный уровень Battlefield 6 достижим только с удалённым движком и пост-обработкой шага 3.
- Путь Tripo3D написан по публичному API v2.5, но в этой среде не проверялся: ключа API нет.
- Процедурные текстуры кодируются в JPEG/PNG. Перекодирование в KTX2 (Basis) в браузере не выполняется;
  загрузчик KTX2 подключён для моделей, которые уже содержат KTX2-текстуры.
- Генерация идёт в основном потоке с уступками event loop; перенос в Web Worker (OffscreenCanvas) — задача на потом.
