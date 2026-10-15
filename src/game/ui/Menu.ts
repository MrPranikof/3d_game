import type { Team } from '../../assets/StylePreset';
import type { GameSettings } from '../GameContext';

export interface MenuResult {
  settings: GameSettings;
  sens: number;
  invertY: boolean;
  gyro: boolean;
}

const KEY = 'tokmachka-settings';

export function detectTouch(): boolean {
  return matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches);
}

function load(): Partial<MenuResult & GameSettings> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; }
}

/** Main menu: team choice, quality, bots, controls (incl. gyro permission for iOS Safari). */
export function showMenu(root: HTMLElement, onPlay: (r: MenuResult) => void): HTMLElement {
  const touch = detectTouch();
  const s = load();
  const defQuality = s.quality ?? (touch ? 'mobile' : 'desktop');
  const el = document.createElement('div');
  el.className = 'menu';
  el.innerHTML = `
    <div class="menu-bg"></div>
    <div class="menu-box">
      <div class="menu-title"><h1>МАЛАЯ ТОКМАЧКА</h1><p>Тактический MilSim · страйкбол · бронетехника · БПЛА</p></div>
      <div class="teams">
        <button class="team team-a" data-team="A"><b>Команда А</b><span>Украина · Leopard 2A6/2A4 · наступление с северо-запада</span></button>
        <button class="team team-b" data-team="B"><b>Команда Б</b><span>Россия · Т-72Б3, БМП-2 · оборона фермы на юго-востоке</span></button>
      </div>
      <details class="settings" ${touch ? '' : 'open'}>
        <summary>Настройки</summary>
        <label>Качество <select data-s="quality"><option value="mobile">Мобильное</option><option value="desktop">Высокое</option><option value="ultra">Ультра</option></select></label>
        <label>Ботов в команде <input data-s="bots" type="range" min="3" max="12" value="${s.botsPerTeam ?? (touch ? 6 : 9)}"><output></output></label>
        <label>Чувствительность <input data-s="sens" type="range" min="0.3" max="2.5" step="0.05" value="${s.sens ?? 1}"><output></output></label>
        <label><input data-s="invert" type="checkbox" ${s.invertY ? 'checked' : ''}> Инверсия по вертикали</label>
        <label class="touch-only">Раскладка <select data-s="layout"><option value="two">2 пальца</option><option value="three">3 пальца</option><option value="claw">4 пальца (Claw)</option></select></label>
        <button class="touch-only gyro" data-s="gyro">Включить гироскоп</button>
      </details>
      <details class="help">
        <summary>Управление</summary>
        <div class="cols">
          <div><h4>Пехота (ПК)</h4>WASD — движение · Shift — спринт · Space — прыжок · C — присесть (на бегу — подкат) · Z — лечь · Q/E — наклон · ЛКМ — огонь · ПКМ — прицел · H — оптика 4× · R — перезарядка · 1/2/3 — винтовка / гранаты / РЭБ-ружьё · F — сесть в технику / ПТУР / миномёт · G — FPV-дрон · Tab — счёт</div>
          <div><h4>Танк</h4>WS — газ/тормоз · AD — поворот корпуса · мышь — башня · ЛКМ — выстрел · ПКМ / V — прицел наводчика, вид мехвода · колесо — кратность · L — дальномер · B — тип снаряда · X — дымы · T — тепловизор · F — выйти</div>
          <div><h4>FPV-дрон</h4>Space/Shift — газ · W/S — тангаж · Q/E — крен · A/D и мышь — рыскание · M — Stabilize/Acro · B — сброс · T — ИК · колесо — наклон камеры · G — подрыв</div>
          <div><h4>Смартфон</h4>Левый джойстик (до упора вверх — авто-спринт), правая половина — обзор, «ОГОНЬ» тоже крутит камеру, «ПРЦ+ОГ» — прицел и огонь одним касанием. Дрон: два стика Mode 2.</div>
        </div>
      </details>
      <div class="menu-foot"><a href="./showroom.html" target="_blank">Стенд 3D-моделей (SingleAIModelFactory) ↗</a><span>WebGPU / WebGL2 · Rapier3D · TSL</span></div>
    </div>`;
  root.appendChild(el);
  const q = el.querySelector<HTMLSelectElement>('[data-s=quality]')!;
  q.value = defQuality;
  const lay = el.querySelector<HTMLSelectElement>('[data-s=layout]')!;
  lay.value = s.touchLayout ?? 'two';
  el.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((r) => {
    const out = r.nextElementSibling as HTMLOutputElement;
    const upd = () => (out.textContent = r.value);
    r.addEventListener('input', upd);
    upd();
  });
  if (!touch) el.querySelectorAll<HTMLElement>('.touch-only').forEach((n) => (n.style.display = 'none'));
  let gyro = false;
  const gb = el.querySelector<HTMLButtonElement>('[data-s=gyro]')!;
  gb.addEventListener('click', async () => {
    try {
      const DM = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
      if (DM.requestPermission) gyro = (await DM.requestPermission()) === 'granted';
      else gyro = true;
    } catch { gyro = false; }
    gb.textContent = gyro ? 'Гироскоп включён ✓' : 'Гироскоп недоступен';
  });
  el.querySelectorAll<HTMLButtonElement>('[data-team]').forEach((b) => b.addEventListener('click', () => {
    const r: MenuResult = {
      settings: {
        quality: q.value as GameSettings['quality'],
        botsPerTeam: Number(el.querySelector<HTMLInputElement>('[data-s=bots]')!.value),
        playerTeam: b.dataset.team as Team,
        touch,
        touchLayout: lay.value as GameSettings['touchLayout'],
      },
      sens: Number(el.querySelector<HTMLInputElement>('[data-s=sens]')!.value),
      invertY: el.querySelector<HTMLInputElement>('[data-s=invert]')!.checked,
      gyro,
    };
    try { localStorage.setItem(KEY, JSON.stringify({ quality: r.settings.quality, botsPerTeam: r.settings.botsPerTeam, touchLayout: r.settings.touchLayout, sens: r.sens, invertY: r.invertY })); } catch { /* ignore */ }
    onPlay(r);
  }));
  return el;
}

export function showLoading(root: HTMLElement): { set: (p: number, t: string) => void; remove: () => void } {
  const el = document.createElement('div');
  el.className = 'loading';
  el.innerHTML = `<div class="loading-box"><h2>МАЛАЯ ТОКМАЧКА</h2><div class="bar"><i></i></div><div class="lt">Подготовка…</div><p class="tip">Все модели — бойцы, техника, дроны, дома, окопы и деревья — генерируются на лету единым генератором SingleAIModelFactory в едином масштабе и PBR-стиле.</p></div>`;
  root.appendChild(el);
  const bar = el.querySelector<HTMLElement>('.bar i')!;
  const txt = el.querySelector<HTMLElement>('.lt')!;
  return {
    set: (p, t) => { bar.style.width = `${Math.round(p * 100)}%`; txt.textContent = t; },
    remove: () => el.remove(),
  };
}

export async function enterFullscreen(): Promise<void> {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o.lock?.('landscape').catch(() => undefined);
  } catch { /* iOS Safari: no fullscreen API for documents — PWA standalone mode covers it */ }
}
