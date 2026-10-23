// @ts-check
// Typed view of the environment. Every service reads config from here.

const env = process.env;

/** @param {string|undefined} v @param {boolean} d */
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v.trim()));
/** @param {string|undefined} v @param {number} d */
const num = (v, d) => { const n = Number(v); return v == null || v === '' || Number.isNaN(n) ? d : n; };
/** @param {string|undefined} v */
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  nodeEnv: env.NODE_ENV || 'development',
  databaseUrl: env.DATABASE_URL || 'postgres://water:water@localhost:5433/water',
  publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:5173').replace(/\/+$/, ''),
  contactEmail: env.CONTACT_EMAIL || 'you@example.com',
  port: num(env.PORT, 8080),

  cpcbUrl: env.CPCB_URL || 'https://rtwqmsdb1.cpcb.gov.in/data/internet/layers/10/index.json',
  cpcbInsecureTls: bool(env.CPCB_INSECURE_TLS, false),
  riverCriteriaClass: /** @type {'B'|'C'} */ ((env.RIVER_CRITERIA_CLASS || 'C').toUpperCase() === 'B' ? 'B' : 'C'),

  wqmisBase: (env.WQMIS_BASE || 'https://ejalshakti.gov.in/WQMIS').replace(/\/+$/, ''),
  wqmisStates: list(env.WQMIS_STATES || '15').map(Number),
  wqmisDistricts: list(env.WQMIS_DISTRICTS || '187'),
  wqmisMinIntervalMs: num(env.WQMIS_MIN_INTERVAL_MS, 500),

  emailDriver: env.EMAIL_DRIVER || 'smtp',
  smtpUrl: env.SMTP_URL || 'smtp://localhost:1025',
  smtpSinkUrl: env.SMTP_SINK_URL || null,
  emailFrom: env.EMAIL_FROM || 'DownStream <alerts@localhost>',
  maxEmailsPerDay: num(env.MAX_EMAILS_PER_DAY, 6),

  mockMode: bool(env.MOCK_MODE, false),
  mockEmail: (env.MOCK_EMAIL || '').trim(), // optional: a subscriber seeded at the simulation point
  mockLat: num(env.MOCK_LAT, 16.18),
  mockLng: num(env.MOCK_LNG, 75.7),
  mockIntervalMin: num(env.MOCK_INTERVAL_MIN, 2),
  mockIntervalMax: num(env.MOCK_INTERVAL_MAX, 5),

  mapStyleUrl: env.MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/positron',
  rawDir: env.RAW_DIR || 'data/raw',
  geocodeOverridesPath: env.GEOCODE_OVERRIDES || 'data/geocode-overrides.csv',
};

export const userAgent = () => `DownStream/0.1 (public water-data site; +mailto:${config.contactEmail})`;
