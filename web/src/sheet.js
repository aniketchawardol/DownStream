// @ts-check
// Mobile bottom sheet with three snap points (peek, half, full). Dragged by its handle or the masthead;
// the handle is also a button that cycles through the snap points for keyboard and switch users.
import { isMobile } from './format.js';

/** @typedef {'peek'|'half'|'full'} Snap */

/**
 * @param {HTMLElement} sheet @param {HTMLButtonElement} handle @param {HTMLElement[]} grips
 * @param {(visiblePx: number) => void} onChange
 */
export function initSheet(sheet, handle, grips, onChange) {
  /** @type {Snap} */ let current = 'half';
  /** The sheet's untransformed top edge (CSS top: band height + 8 px). */
  const top = () => Number.parseFloat(getComputedStyle(sheet).top) || 0;
  const positions = () => {
    const h = window.innerHeight;
    const t = top();
    return { full: 0, half: Math.max(0, h * 0.55 - t), peek: Math.max(0, h - t - 132) };
  };
  const apply = (/** @type {Snap} */ name) => {
    if (!isMobile()) { sheet.style.removeProperty('--sheet-y'); return; }
    current = name;
    const y = positions()[name];
    sheet.style.setProperty('--sheet-y', `${y}px`);
    handle.setAttribute('aria-label', name === 'full' ? 'Shrink the panel' : 'Expand the panel');
    handle.setAttribute('aria-expanded', String(name === 'full'));
    onChange(window.innerHeight - top() - y);
  };

  let startY = 0, startOffset = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false, moved = false;
  /** @param {PointerEvent} e */
  const down = (e) => {
    if (!isMobile() || (e.target instanceof HTMLElement && e.target.closest('a, input, button:not(.sheet-handle)'))) return;
    dragging = true; moved = false;
    startY = lastY = e.clientY; lastT = performance.now();
    startOffset = positions()[current];
    sheet.classList.add('dragging');
    /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
  };
  /** @param {PointerEvent} e */
  const move = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    const now = performance.now();
    velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY; lastT = now;
    const p = positions();
    sheet.style.setProperty('--sheet-y', `${Math.min(p.peek, Math.max(0, startOffset + dy))}px`);
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    if (!moved) return;
    const y = Number.parseFloat(sheet.style.getPropertyValue('--sheet-y')) || 0;
    const p = positions();
    const projected = y + velocity * 180;
    /** @type {Snap[]} */ const order = ['full', 'half', 'peek'];
    const best = order.reduce((a, b) => (Math.abs(p[b] - projected) < Math.abs(p[a] - projected) ? b : a));
    apply(best);
  };
  for (const g of [handle, ...grips]) {
    g.addEventListener('pointerdown', down);
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  }
  handle.addEventListener('click', () => { if (!moved) apply(current === 'peek' ? 'half' : current === 'half' ? 'full' : 'half'); moved = false; });
  window.addEventListener('resize', () => apply(current));
  matchMedia('(max-width: 899px)').addEventListener('change', () => apply(current));
  apply('half');
  return { snapTo: apply, get current() { return current; } };
}
