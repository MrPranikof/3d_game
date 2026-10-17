/**
 * Crash breadcrumbs + safe mode.
 * When iOS Safari's GPU or web-content process dies, the page silently reloads and no JS error
 * is ever reported. We therefore write the current stage to localStorage as we go; a stage that is
 * still "open" on the next load means the previous run died there. `pagehide` marks a clean exit.
 */
const KEY = 'tokmachka-crumb';

export const safeMode = { on: false };

export function crumb(stage: string): void {
  try { localStorage.setItem(KEY, JSON.stringify({ stage, t: Date.now(), open: true })); } catch { /* storage blocked */ }
}

export function closeCrumb(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(raw), open: false }));
  } catch { /* ignore */ }
}

/** The stage a previous run died in (null if it exited cleanly or never got past the menu). */
export function lastCrash(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as { stage: string; open: boolean };
    return c.open && c.stage !== 'menu' ? c.stage : null;
  } catch {
    return null;
  }
}

addEventListener('pagehide', closeCrumb);
