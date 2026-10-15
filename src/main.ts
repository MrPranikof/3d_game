import type { Team } from './assets/StylePreset';
import { Game, reportError } from './game/Game';
import { enterFullscreen, showLoading, showMenu, type MenuResult } from './game/ui/Menu';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
let current: Game | null = null;
let last: MenuResult | null = null;

function menu(): void {
  const el = showMenu(ui, (r) => {
    el.remove();
    void play(r);
  });
}

async function play(r: MenuResult, team?: Team): Promise<void> {
  last = r;
  if (team) r.settings.playerTeam = team;
  if (r.settings.touch) await enterFullscreen();
  const loading = showLoading(ui);
  try {
    const g = await Game.create(r.settings, canvas, ui, loading.set);
    g.ctx.input.sensitivity.infantry = r.sens;
    g.ctx.input.sensitivity.tank = r.sens * 0.7;
    g.ctx.input.sensitivity.drone = r.sens;
    g.ctx.input.invertY = r.invertY;
    if (r.gyro) await g.ctx.input.enableGyro();
    loading.remove();
    current = g;
    g.onExit = () => { current = null; menu(); };
    g.onRestart = () => { current = null; if (last) void play(last); };
    showStart(g);
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as { __game: Game }).__game = g;
  } catch (e) {
    reportError(`Ошибка запуска: ${(e as Error).message}`);
    loading.set(1, `Ошибка: ${(e as Error).message}`);
  }
}

/** One tap/click to start: unlocks audio + pointer lock (browser user-gesture rules). */
function showStart(g: Game): void {
  const el = document.createElement('div');
  el.className = 'tap-start';
  el.innerHTML = `<div><b>${g.ctx.settings.touch ? 'Коснитесь' : 'Нажмите'}, чтобы начать бой</b><span>${g.ctx.settings.touch ? '' : 'Esc — пауза · Tab — счёт'}</span></div>`;
  ui.appendChild(el);
  el.addEventListener('click', () => { el.remove(); g.start(); }, { once: true });
  (window as unknown as { __startGame?: () => void }).__startGame = () => { el.remove(); g.start(); };
}

addEventListener('error', (e) => reportError(`${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
addEventListener('unhandledrejection', (e) => reportError(`Promise: ${(e.reason as Error)?.message ?? e.reason}`));

menu();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}
void current;
