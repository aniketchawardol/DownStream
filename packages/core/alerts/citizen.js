// @ts-check
// Citizen reports: a person who sees something wrong with their water (dead fish, sewage, a bad smell, people
// falling ill) warns their neighbours and the authorities. In this demo every report is simulated and placed
// exactly at the simulation test point (MOCK_LAT, MOCK_LNG), so anyone subscribed there receives it.
import { config } from '../config.js';

/** What the reporter noticed. `river`/`tap` give the words used for each kind of water. */
export const CITIZEN_ISSUES = /** @type {const} */ ({
  colour: { label: 'Unusual colour', river: 'unusual colour in the river', tap: 'unusual colour in the tap water' },
  smell: { label: 'Bad smell', river: 'a bad smell from the river', tap: 'a bad smell from the tap water' },
  dead_fish: { label: 'Dead fish', river: 'dead fish in the river', tap: 'dead fish in the water source' },
  sewage: { label: 'Sewage or waste flowing in', river: 'sewage or waste flowing into the river', tap: 'sewage or waste near the drinking-water source' },
  foam: { label: 'Foam or an oily film', river: 'foam or an oily film on the river', tap: 'foam or an oily film on the tap water' },
  illness: { label: 'People fell ill after drinking it', river: 'people falling ill after using the river water', tap: 'people falling ill after drinking the tap water' },
  other: { label: 'Something else', river: 'a problem with the river', tap: 'a problem with the tap water' },
});

export const CITIZEN_WATER = /** @type {const} */ ({ river: 'River', tap: 'Tap, handpump or well' });
export const DETAILS_MAX = 280;
export const SIM_POINT_ID = 'SIM-POINT';

/** Links are refused: a demo broadcast to real inboxes must not become a way to send someone a link. */
export const HAS_LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|org|net|io|xyz|ly|me|co)\b)/i;

/** Collapse whitespace and control characters; the text is shown escaped everywhere. @param {string} s */
export const cleanDetails = (s) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Build the alert for one report (not yet stored).
 * @param {{ issue: keyof typeof CITIZEN_ISSUES, water: 'river'|'tap', details?: string, urgent?: boolean }} r
 * @param {{ now?: Date, lat?: number, lng?: number }} [o]
 */
export function buildCitizenReport(r, o = {}) {
  const now = o.now ?? new Date();
  const issue = CITIZEN_ISSUES[r.issue] ?? CITIZEN_ISSUES.other;
  const details = cleanDetails(r.details ?? '').slice(0, DETAILS_MAX);
  const what = issue[r.water];
  return {
    kind: 'citizen_report',
    severity: /** @type {'urgent'|'notice'} */ (r.urgent ? 'urgent' : 'notice'),
    group: /** @type {'river'|'tap'} */ (r.water),
    source: 'citizen',
    title: `Citizen report: ${what} at the test point`,
    lat: o.lat ?? config.mockLat,
    lng: o.lng ?? config.mockLng,
    subject_ref: `sim:${SIM_POINT_ID}`,
    body: {
      citizen: true, simulated: true, water: r.water, issue: r.issue, issue_label: issue.label, what,
      details, urgent: !!r.urgent, reported_at: now.toISOString(), place: 'the simulation test point',
      site_path: `/?sim=${SIM_POINT_ID}`,
    },
  };
}
