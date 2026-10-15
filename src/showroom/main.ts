import { Showroom } from './Showroom';

// Asset factory showroom (showroom.html): inspects every model the game uses.
const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const showroom = new Showroom(canvas, ui);
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as { __showroom: Showroom }).__showroom = showroom;
showroom.start().catch((err) => {
  console.error(err);
  ui.innerHTML = `<div class="panel info" style="left:12px;right:12px;width:auto;color:var(--bad)">Ошибка запуска: ${String(err?.message ?? err)}</div>`;
});
