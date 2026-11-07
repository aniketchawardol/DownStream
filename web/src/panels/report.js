// @ts-check
// "Report a problem there": a citizen report broadcast from the simulation test point. The form never asks
// for a location: the server places every report at the test point, where the simulated alerts are centred.
import { report } from '../api.js';
import { esc } from '../format.js';
import { state } from '../state.js';

const LINK = /(https?:\/\/|www\.)/i;

/**
 * @param {HTMLDialogElement} dialog
 * @param {{ opener: HTMLButtonElement, onBroadcast: () => void, onShow: () => void }} o
 *   onBroadcast: refresh lists that show alerts; onShow: open the test point on the map.
 */
export function initReport(dialog, o) {
  const form = /** @type {HTMLFormElement} */ (dialog.querySelector('#report-form'));
  const details = /** @type {HTMLTextAreaElement} */ (form.querySelector('#report-details'));
  const count = /** @type {HTMLElement} */ (form.querySelector('#report-count'));
  const statusEl = /** @type {HTMLElement} */ (form.querySelector('#report-status'));
  const submit = /** @type {HTMLButtonElement} */ (form.querySelector('#report-submit'));
  const where = /** @type {HTMLElement} */ (form.querySelector('#report-where'));
  const show = (/** @type {string} */ html, /** @type {'error'|'done'|''} */ cls) => { statusEl.className = `status-line form-status ${cls}`; statusEl.innerHTML = html; };

  o.opener.addEventListener('click', () => {
    const m = state.config?.mock;
    if (m) where.innerHTML = `Location: the simulation test point, <span class="num">${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}</span>. Every report is placed here.`;
    show('', '');
    submit.disabled = false;
    dialog.showModal();
    /** @type {HTMLElement} */ (form.querySelector('input[name="water"]:checked'))?.focus();
  });
  // Closing returns focus to the button that opened the form, except after "See it on the map", where the
  // test point's panel takes focus (focusing the button would scroll the column away from that panel).
  let returnFocus = true;
  dialog.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    // A click on the backdrop lands on the dialog element itself.
    if (t === dialog || t.closest('[data-report-close]')) dialog.close();
    if (t.closest('[data-report-show]')) { returnFocus = false; dialog.close(); o.onShow(); }
  });
  dialog.addEventListener('close', () => { if (returnFocus) o.opener.focus({ preventScroll: true }); returnFocus = true; });
  details.addEventListener('input', () => {
    count.textContent = `${details.value.length} of 280 characters`;
    if (statusEl.classList.contains('error')) show('', '');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const body = {
      water: String(data.get('water') || 'river'),
      issue: String(data.get('issue') || 'other'),
      details: details.value.trim(),
      urgent: data.get('urgent') === 'on',
    };
    if (LINK.test(body.details)) { show('Links and web addresses aren’t allowed in reports. Describe what you saw instead.', 'error'); details.focus(); return; }
    if (body.issue === 'other' && body.details.length < 10) { show('For “Something else”, describe what you saw in a few words.', 'error'); details.focus(); return; }
    submit.disabled = true;
    show('Broadcasting.', '');
    try {
      const r = await report(body);
      const who = r.deliveries === 1 ? '1 subscriber' : `${r.deliveries} subscribers`;
      const when = r.severity === 'urgent' ? 'within a minute' : 'in their next alert email';
      show(`Broadcast from the test point. ${esc(who)} near it will get it by email ${when}.${r.deliveries ? '' : ' Nobody has confirmed a subscription there yet: subscribe at the test point first to receive it.'}
        <button type="button" class="btn-text" data-report-show>See it on the map</button>`, 'done');
      form.reset();
      count.textContent = '0 of 280 characters';
      o.onBroadcast();
    } catch (err) {
      show(esc(/** @type {Error} */ (err).message), 'error');
    } finally {
      submit.disabled = false;
    }
  });
}
