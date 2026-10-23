// @ts-check
// Subscribe: pin (map click or location), radius slider drawing the circle live, email, plain-word choices.
import { subscribe } from '../api.js';
import { esc, km, distanceKm } from '../format.js';
import { state, set, on } from '../state.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

/** @param {HTMLFormElement} form */
export function initSubscribe(form) {
  const radius = /** @type {HTMLInputElement} */ (form.querySelector('#radius'));
  const out = /** @type {HTMLOutputElement} */ (form.querySelector('#radius-out'));
  const pinLine = /** @type {HTMLElement} */ (form.querySelector('#pin-line'));
  const email = /** @type {HTMLInputElement} */ (form.querySelector('#email'));
  const statusEl = /** @type {HTMLElement} */ (form.querySelector('#subscribe-status'));
  const submit = /** @type {HTMLButtonElement} */ (form.querySelector('#subscribe-submit'));

  radius.addEventListener('input', () => set({ radius: Number(radius.value) }));
  on('radius', (s) => { out.value = `${s.radius} km`; radius.value = String(s.radius); });

  const describePin = () => {
    if (!state.pin) { pinLine.textContent = 'Click the map or use your location to drop a pin.'; pinLine.classList.remove('set'); return; }
    const { lat, lng } = state.pin;
    let near = '';
    let best = Infinity;
    for (const f of state.areas) {
      if (f.properties.approximate) continue;
      const d = distanceKm(lat, lng, f.geometry.coordinates[1], f.geometry.coordinates[0]);
      if (d < best) { best = d; near = f.properties.name; }
    }
    pinLine.innerHTML = `Pin at <span class="num">${lat.toFixed(4)}, ${lng.toFixed(4)}</span>${near && best < 60 ? `, ${esc(km(best))} from ${esc(near)} panchayat` : ''}. Click the map to move it.`;
    pinLine.classList.add('set');
  };
  on('pin', describePin);
  on('areas', describePin);

  const show = (/** @type {string} */ msg, /** @type {'error'|'done'|''} */ cls) => { statusEl.className = `form-status ${cls}`; statusEl.textContent = msg; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const kinds = [...form.querySelectorAll('input[name="kinds"]:checked')].map((i) => /** @type {HTMLInputElement} */ (i).value);
    if (!state.pin) { show('Drop a pin first: click the map, or use “Use my location”.', 'error'); pinLine.focus?.(); return; }
    if (!EMAIL_RE.test(email.value.trim())) { show('Enter an email address like name@example.com.', 'error'); email.focus(); email.setAttribute('aria-invalid', 'true'); return; }
    email.removeAttribute('aria-invalid');
    if (!kinds.length) { show('Choose at least one kind of alert.', 'error'); return; }
    submit.disabled = true;
    show('Sending the confirmation email.', '');
    try {
      const r = await subscribe({ email: email.value.trim(), lat: state.pin.lat, lng: state.pin.lng, radius_km: state.radius, kinds });
      show(`Confirmation sent to ${r.email}. Open it to start alerts.`, 'done');
      form.reset();
      out.value = `${state.radius} km`;
      radius.value = String(state.radius);
    } catch (err) {
      show(/** @type {Error} */ (err).message, 'error');
    } finally {
      submit.disabled = false;
    }
  });
}
