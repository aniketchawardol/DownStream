// @ts-check
// Accessible tabs (WAI-ARIA tabs pattern with automatic activation: panels are cheap to show).
// Arrow keys move between tabs and select them; Home and End jump to the ends.
import { esc } from './format.js';

let seq = 0;

/**
 * Markup for a tab list plus its one shared panel. Call wireTabs() after inserting it.
 * @param {{ id: string, label: string }[]} items @param {string} selected @param {string} label
 */
export function tabsHtml(items, selected, label) {
  const base = `tabs${++seq}`;
  return `<div class="tabs" role="tablist" aria-label="${esc(label)}" data-tabs="${base}">${items.map((t) => `
      <button type="button" role="tab" id="${base}-${esc(t.id)}" data-tab="${esc(t.id)}" aria-controls="${base}-panel"
        aria-selected="${t.id === selected}" tabindex="${t.id === selected ? 0 : -1}">${esc(t.label)}</button>`).join('')}
    </div><div class="tabpanel" role="tabpanel" id="${base}-panel" aria-labelledby="${base}-${esc(selected)}" tabindex="-1"></div>`;
}

/**
 * @param {HTMLElement} root containing tabsHtml() output
 * @param {(id: string, panel: HTMLElement) => void} onSelect called for the initial tab too
 * @returns {(id: string) => void} select a tab from code
 */
export function wireTabs(root, onSelect) {
  const list = /** @type {HTMLElement} */ (root.querySelector('[role="tablist"]'));
  const panel = /** @type {HTMLElement} */ (root.querySelector('[role="tabpanel"]'));
  const tabs = /** @type {HTMLButtonElement[]} */ ([...list.querySelectorAll('[role="tab"]')]);
  const select = (/** @type {string} */ id, focus = false) => {
    for (const t of tabs) {
      const on = t.dataset.tab === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on) { panel.setAttribute('aria-labelledby', t.id); if (focus) t.focus(); }
    }
    onSelect(id, panel);
  };
  list.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target).closest('[role="tab"]');
    if (t && t.getAttribute('aria-selected') !== 'true') select(/** @type {string} */ (/** @type {HTMLElement} */ (t).dataset.tab));
  });
  list.addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t === document.activeElement);
    if (i < 0) return;
    const j = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    select(/** @type {string} */ (tabs[j].dataset.tab), true);
  });
  const first = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
  select(/** @type {string} */ (first.dataset.tab));
  return (id) => select(id, true);
}
