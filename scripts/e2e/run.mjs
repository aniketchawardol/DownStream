// @ts-check
// End-to-end UI checks and the Phase 7 screenshots, against the production build served by the api service.
//   docker compose --profile e2e run --rm e2e            (all checks + screenshots)
//   docker compose --profile e2e run --rm e2e shots      (screenshots only)
// Runs in the official Playwright image, so nothing is installed on the host.
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const MAILPIT = process.env.MAILPIT_URL || 'http://mailpit:8025';
const OUT = new URL('../../docs/screenshots/', import.meta.url);
const only = process.argv[2];
const results = [];

/** @param {string} name @param {() => Promise<void>} fn */
async function check(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`PASS  ${name}`); }
  catch (err) { results.push({ name, ok: false, error: String(/** @type {Error} */ (err).message).split('\n')[0] }); console.log(`FAIL  ${name}\n      ${/** @type {Error} */ (err).message.split('\n')[0]}`); }
}
/** @param {unknown} cond @param {string} msg */
function expect(cond, msg) { if (!cond) throw new Error(msg); }

const browser = await chromium.launch();
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

/** @param {import('playwright-core').Page} page */
async function ready(page) {
  // Desktop loads the interactive map at once; phones show the schematic until the reader asks for the map.
  await page.waitForSelector('.map-wrap.map-ready, .schematic', { timeout: 30_000 });
  await page.waitForFunction(() => !/What does India/.test(document.querySelector('#hero-sentence')?.textContent || ''), null, { timeout: 15_000 });
  await page.waitForTimeout(1600); // let the one-time ring animation finish and tiles settle
}

/** @param {string} to */
async function mailFor(to, subjectRe = /./, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=50`).then((x) => x.json());
    const m = (r.messages || []).find((/** @type {any} */ x) => subjectRe.test(x.Subject));
    if (m) return { ...m, full: await fetch(`${MAILPIT}/api/v1/message/${m.ID}`).then((x) => x.json()), headers: await fetch(`${MAILPIT}/api/v1/message/${m.ID}/headers`).then((x) => x.json()) };
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(`no email to ${to} matching ${subjectRe} within ${timeoutMs / 1000} s`);
}
/** Links in emails point at PUBLIC_BASE_URL; inside Docker the site is BASE. @param {string} url */
const local = (url) => url.replace(/^https?:\/\/[^/]+/, BASE);

const areaId = await fetch(`${BASE}/api/areas`).then((r) => r.json()).then((j) => {
  const fs_ = j.features.filter((/** @type {any} */ f) => f.properties.tests_12m > 0 && !f.properties.approximate);
  const bad = fs_.find((/** @type {any} */ f) => f.properties.latest_round_status === 'above_permissible');
  return (bad ?? fs_[0])?.properties.id;
});

// ---------------------------------------------------------------- screenshots
await check('screenshots: 1440 px and 390 px, light and dark', async () => {
  for (const scheme of /** @type {const} */ (['light', 'dark'])) {
    for (const [label, opts] of /** @type {const} */ ([['1440', DESKTOP], ['390', PHONE]])) {
      const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(BASE);
      await ready(page);
      await page.screenshot({ path: new URL(`home-${label}-${scheme}.png`, OUT).pathname });
      await page.goto(`${BASE}/?station=UK55`);
      await ready(page);
      await page.waitForSelector('.multiple .big');
      await page.waitForTimeout(800);
      await page.screenshot({ path: new URL(`station-${label}-${scheme}.png`, OUT).pathname });
      if (areaId) {
        await page.goto(`${BASE}/?area=${areaId}`);
        await ready(page);
        await page.waitForSelector('.ruler');
        await page.waitForTimeout(800);
        await page.screenshot({ path: new URL(`panchayat-${label}-${scheme}.png`, OUT).pathname });
      }
      if (label === '1440') {
        await page.goto(BASE);
        await ready(page);
        await page.locator('#journey').scrollIntoViewIfNeeded();
        await page.waitForTimeout(1200);
        await page.screenshot({ path: new URL(`journey-${label}-${scheme}.png`, OUT).pathname });
        await page.locator('#ledger').scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        await page.screenshot({ path: new URL(`ledger-${label}-${scheme}.png`, OUT).pathname });
      }
      await ctx.close();
    }
  }
});

if (only === 'shots') { await browser.close(); process.exit(results.every((r) => r.ok) ? 0 : 1); }

// ---------------------------------------------------------------- first paint and content rules
await check('hero sentence is live, dated and names its water', async () => {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  const hero = await page.textContent('#hero-sentence');
  expect(/was measured .+ ago\./.test(hero || ''), `hero: ${hero}`);
  expect(/Taps in .+ were last lab-tested .+ ago\./.test(hero || ''), `hero lacks tap clause: ${hero}`);
  expect(await page.isVisible('#sim-band'), 'simulation band visible in mock mode');
  expect(/Simulation mode is on\. Alerts marked as simulated are invented for testing\./.test(await page.textContent('#sim-band') || ''), 'sim band copy');
  const body = await page.textContent('body');
  expect(!/\bis safe\b|safe to drink\b(?! between)/i.test((body || '').replace(/whether water is safe to drink/gi, '').replace(/cannot tell you whether water is safe/gi, '')), 'never says water is safe');
  expect(!/[\u{1F300}-\u{1FAFF}]/u.test(body || ''), 'no emoji in the UI');
  expect((await page.locator('.mk-river').count()) === 40, 'all 40 river stations drawn');
  await ctx.close();
});

// ---------------------------------------------------------------- keyboard-only walkthrough
await check('keyboard only: skip link, list, station panel, alerts pin, subscribe', async () => {
  const ctx = await browser.newContext({ ...DESKTOP, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  await page.keyboard.press('Tab');
  expect(/Skip to the list of places/.test(await page.evaluate(() => document.activeElement?.textContent || '')), 'first Tab lands on the skip link');
  const ring = await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.activeElement)).outlineStyle);
  expect(ring === 'solid', `visible focus ring (outline ${ring})`);
  await page.keyboard.press('Enter');
  // Tab forward until a river-station row in the list has focus.
  let found = false;
  for (let i = 0; i < 25 && !found; i++) {
    await page.keyboard.press('Tab');
    found = await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.dataset?.kind === 'station');
  }
  expect(found, 'reached a river-station row by Tab');
  const name = await page.evaluate(() => document.activeElement?.querySelector('.name')?.textContent);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#selected .multiple', { timeout: 15_000 });
  expect(await page.evaluate(() => document.activeElement?.id === 'selected'), 'focus moves to the opened panel');
  expect((await page.textContent('#selected h2')) === name, 'panel shows the chosen station');
  // Close, then the alerts button, both reachable by Tab.
  let alertsBtn = false;
  for (let i = 0; i < 6 && !alertsBtn; i++) {
    await page.keyboard.press('Tab');
    alertsBtn = await page.evaluate(() => document.activeElement?.hasAttribute('data-alerts-here') ?? false);
  }
  expect(alertsBtn, 'Get alerts near here is reachable by Tab');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'email', null, { timeout: 5000 });
  expect(/Pin at/.test(await page.textContent('#pin-line') || ''), 'pin set from the panel');
  const email = `keyboard-${Date.now()}@example.com`;
  await page.keyboard.type(email);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.id === 'subscribe-submit')) break;
  }
  expect(await page.evaluate(() => document.activeElement?.id === 'subscribe-submit'), 'submit button reachable by Tab');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#subscribe-status.done', { timeout: 15_000 });
  expect((await page.textContent('#subscribe-status')) === `Confirmation sent to ${email}. Open it to start alerts.`, 'exact confirmation copy');
  await mailFor(email, /Confirm your DownStream water alerts/);
  await ctx.close();
});

await check('keyboard only: use my location, nearby list, panchayat rulers', async () => {
  const ctx = await browser.newContext({ ...DESKTOP, geolocation: { latitude: 16.18, longitude: 75.7, accuracy: 50 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  await page.focus('#btn-locate');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#nearby-body .place-row[data-kind="area"]', { timeout: 15_000 });
  expect(/Using your location/.test(await page.textContent('#locate-status') || ''), 'location status line');
  expect(/Pin at 16\.1800, 75\.7000/.test(await page.textContent('#pin-line') || ''), 'pin at the location');
  await page.focus('#nearby-body .place-row[data-kind="area"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#selected .ruler', { timeout: 15_000 });
  const seq = await page.textContent('#selected .sequence');
  expect(/Collected/.test(seq || '') && /First seen here/.test(seq || ''), 'dates sequence shown');
  expect(/Last lab test on/.test(await page.textContent('#selected .verdict') || ''), 'verdict copy');
  await ctx.close();
});

// ---------------------------------------------------------------- location refused -> search
await check('location refused: search for a place instead', async () => {
  const ctx = await browser.newContext(DESKTOP); // no geolocation permission
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  await page.click('#btn-locate');
  await page.waitForSelector('#place-search', { state: 'visible', timeout: 15_000 });
  expect(/Search for a district, block, panchayat, town or PIN code instead|Search for a place instead/.test(await page.textContent('#locate-status') || ''), 'asks for a place instead');
  await page.fill('#place-q', 'Badami');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#search-results button', { timeout: 15_000 });
  await page.click('#search-results button');
  await page.waitForFunction(() => /Pin at/.test(document.querySelector('#pin-line')?.textContent || ''));
  await ctx.close();
});

// ---------------------------------------------------------------- the simulation test point
await check('testing: "Use the simulation test point" and a "testing" search both pin the simulation point', async () => {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  const cfg = await fetch(`${BASE}/api/config`).then((r) => r.json());
  await page.click('#btn-testpoint');
  await page.waitForFunction((t) => (document.querySelector('#pin-line')?.textContent || '').includes(t), `${cfg.mock.lat.toFixed(4)}, ${cfg.mock.lng.toFixed(4)}`);
  expect(await page.evaluate(() => document.activeElement?.id === 'email'), 'focus moves to the email field');
  const r = await fetch(`${BASE}/api/search?q=testing`).then((x) => x.json());
  expect(r.results[0]?.name === 'Simulation test point', `search "testing" finds the test point (${r.results[0]?.name})`);
  await ctx.close();
});

// ---------------------------------------------------------------- place search is always on screen
/** The search bar is visible, near the top, centred on the map, and nothing is drawn over it. @param {import('playwright-core').Page} page @param {string} when */
async function searchOnTop(page, when) {
  const r = await page.evaluate(() => {
    const f = /** @type {HTMLElement} */ (document.querySelector('#place-search'));
    const b = f.getBoundingClientRect();
    const m = /** @type {HTMLElement} */ (document.querySelector('#map-wrap')).getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + 12, b.top + b.height / 2);
    return { top: b.top, mid: b.left + b.width / 2, mapMid: m.left + m.width / 2, w: b.width, uncovered: !!hit && f.contains(hit), shown: b.height > 0 && getComputedStyle(f).visibility !== 'hidden' };
  });
  expect(r.shown, `search visible ${when}`);
  expect(r.uncovered, `nothing covers the search ${when}`);
  expect(r.top >= 0 && r.top < 120, `search at the top ${when} (top ${Math.round(r.top)} px)`);
  expect(Math.abs(r.mid - r.mapMid) < 4, `search centred on the map ${when} (${Math.round(r.mid)} vs ${Math.round(r.mapMid)})`);
}

await check('place search stays at the top centre after a pin, a selection and a scroll (desktop and phone)', async () => {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  await searchOnTop(page, 'on load');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) * 0.55, (box?.y ?? 0) + (box?.height ?? 0) * 0.6);
  await page.waitForFunction(() => /Pin at/.test(document.querySelector('#pin-line')?.textContent || ''));
  await page.waitForTimeout(800);
  await searchOnTop(page, 'after a pin');
  await page.click('#btn-alerts');
  await page.waitForTimeout(900);
  await searchOnTop(page, 'after the panel scrolled to alerts');
  await page.fill('#place-q', 'Badami');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#search-results button', { timeout: 15_000 });
  await page.click('#search-results button');
  await page.waitForTimeout(800);
  await searchOnTop(page, 'after picking a search result');
  await page.screenshot({ path: new URL('search-desktop-after-pin.png', OUT).pathname });
  await ctx.close();

  const pctx = await browser.newContext(PHONE);
  const phone = await pctx.newPage();
  await phone.goto(BASE);
  await ready(phone);
  await searchOnTop(phone, 'on a phone');
  await phone.click('#btn-alerts');                 // snaps the sheet to full height
  await phone.waitForTimeout(900);
  await searchOnTop(phone, 'on a phone with the sheet at full height');
  await phone.fill('#place-q', 'Badami');
  await phone.keyboard.press('Enter');
  await phone.waitForSelector('#search-results button', { timeout: 15_000 });
  const covered = await phone.evaluate(() => {
    const b = /** @type {HTMLElement} */ (document.querySelector('#search-results button')).getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + 10, b.top + b.height / 2);
    return !document.querySelector('#search-results')?.contains(hit);
  });
  expect(!covered, 'phone: search results draw above the sheet');
  await phone.screenshot({ path: new URL('search-phone-sheet-full.png', OUT).pathname });
  await pctx.close();
});

// ---------------------------------------------------------------- map click, radius, form errors
await check('map click drops a pin; radius slider redraws; form errors explain what to do', async () => {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  await page.click('#subscribe-submit');
  expect(/Drop a pin first/.test(await page.textContent('#subscribe-status') || ''), 'no-pin error');
  const box = await page.locator('#map').boundingBox();
  await page.mouse.click((box?.x ?? 0) + (box?.width ?? 0) * 0.55, (box?.y ?? 0) + (box?.height ?? 0) * 0.6);
  await page.waitForFunction(() => /Pin at/.test(document.querySelector('#pin-line')?.textContent || ''));
  await page.locator('#radius').fill('35');
  expect((await page.textContent('#radius-out')) === '35 km', 'radius output updates');
  await page.fill('#email', 'not-an-email');
  await page.click('#subscribe-submit');
  expect(/Enter an email address like/.test(await page.textContent('#subscribe-status') || ''), 'bad email error');
  await ctx.close();
});

// ---------------------------------------------------------------- full alert loop through Mailpit
await check('double opt-in, simulated urgent alert within a minute, one-click unsubscribe', async () => {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  const email = `loop-${Date.now()}@example.com`;
  await page.goto(`${BASE}/?sim=SIM-GP-1`);
  await ready(page);
  expect(/Invented for testing/.test(await page.textContent('#selected') || ''), 'simulated subject labelled');
  await page.click('[data-alerts-here]');
  await page.fill('#email', email);
  await page.click('#subscribe-submit');
  await page.waitForSelector('#subscribe-status.done', { timeout: 15_000 });
  const confirm = await mailFor(email, /Confirm/);
  const link = (confirm.full.Text.match(/https?:\/\/\S+\/api\/subscriptions\/confirm\?token=\S+/) || [])[0];
  expect(link, 'confirmation link in email');
  expect(confirm.headers['List-Unsubscribe']?.[0], 'List-Unsubscribe header on the confirmation');
  await page.goto(local(link));
  await page.waitForSelector('#notice-band:not([hidden])');
  expect(/Alerts are on/.test(await page.textContent('#notice-band') || ''), 'success state after confirming');
  const sim = await fetch(`${BASE}/api/dev/simulate?kind=tap_contamination`, { method: 'POST' }).then((r) => r.json());
  expect(sim.simulated && sim.deliveries >= 1, `simulate reached subscribers (${JSON.stringify(sim)})`);
  const alert = await mailFor(email, /^\[Simulated\] /, 100_000);
  expect(/^This alert is simulated/.test(alert.full.Text.trim()), 'first line says it is invented');
  expect(/Source: the simulator/.test(alert.full.Text), 'never attributed to a real source');
  const unsub = (alert.full.Text.match(/https?:\/\/\S+\/api\/unsubscribe\?token=\S+/) || [])[0];
  expect(unsub && alert.headers['List-Unsubscribe-Post']?.[0] === 'List-Unsubscribe=One-Click', 'one-click unsubscribe link and header');
  await page.goto(local(unsub));
  await page.waitForSelector('#notice-band:not([hidden])');
  expect(/unsubscribed/i.test(await page.textContent('#notice-band') || ''), 'unsubscribed state');
  await ctx.close();
});

// ---------------------------------------------------------------- mobile sheet, reduced motion, ledger
await check('phone: map on top, bottom sheet snaps, place selection opens the sheet', async () => {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  const mapH = await page.evaluate(() => document.querySelector('.map-wrap')?.getBoundingClientRect().height ?? 0);
  expect(mapH > 300, 'map visible on phones');
  expect(await page.locator('.schematic .sch-station').count() === 40, 'schematic first paint shows every station');
  expect(!(await page.locator('.maplibregl-canvas').count()), 'interactive map not loaded before it is wanted');
  const y0 = await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('#sheet'))).getPropertyValue('--sheet-y'));
  await page.click('#sheet-handle');
  await page.waitForTimeout(400);
  const y1 = await page.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector('#sheet'))).getPropertyValue('--sheet-y'));
  expect(y0 !== y1 && parseFloat(y1) < parseFloat(y0), `handle expands the sheet (${y0} -> ${y1})`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow <= 0, `no horizontal page scroll (${overflow}px)`);
  await page.click('#sheet-handle'); // back to half so the map's button is visible
  await page.waitForTimeout(400);
  await page.click('.sch-open');
  await page.waitForSelector('.map-wrap.map-ready', { timeout: 30_000 });
  expect(await page.locator('.mk-river').count() === 40, 'interactive map loads on request');
  await page.click('.place-row[data-kind="station"]');
  await page.waitForSelector('#selected .multiple', { timeout: 15_000 });
  await ctx.close();
});

await check('reduced motion: no pinned scroll sequence, steps shown statically', async () => {
  const ctx = await browser.newContext({ ...DESKTOP, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  await page.locator('#journey').scrollIntoViewIfNeeded();
  await page.waitForSelector('#steps li.static', { timeout: 10_000 });
  expect(!(await page.locator('#journey.pinned').count()), 'not pinned');
  await ctx.close();
});

await check('freshness ledger lists each source with fetch time, newest data and records', async () => {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  const rows = await page.locator('#ledger-table tbody tr').allTextContents();
  expect(rows.some((r) => /CPCB river stations/.test(r) && /IST/.test(r)), 'CPCB row with IST time');
  expect(rows.some((r) => /WQMIS sample lists/.test(r)), 'WQMIS row');
  expect(/River data from \d\d:\d\d IST/.test(await page.textContent('#freshness') || ''), 'header freshness pill');
  await ctx.close();
});

await browser.close();
const failed = results.filter((r) => !r.ok);
await fs.writeFile(new URL('e2e-results.json', OUT), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
