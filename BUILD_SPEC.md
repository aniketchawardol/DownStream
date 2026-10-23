# DownStream — build specification

"DownStream" is a working name; rename it freely. It is a public website that shows what India's government water-quality data says about a place, how old that data is, and emails people when something new or worrying is published.

## How to use this file

Put this file in an empty folder as `BUILD_SPEC.md`, open Claude Code in that folder, and start with:

> Read BUILD_SPEC.md. Do Phase 0 and Phase 1, then stop and show me docs/SOURCES.md before writing any ingestion code.

Work phase by phase (section 13). Each phase ends with acceptance checks that must pass before the next one starts. The developer is on Windows with Docker Desktop. Everything must run with `docker compose up`, with nothing else installed on the host. Add a `.gitattributes` that forces LF line endings for `*.sh`, `*.sql`, `*.js`, `*.mjs` and `Dockerfile`.

---

## 1. What the product does

India publishes water-quality data at two very different speeds, and the product is built around that contrast instead of hiding it.

**Rivers (fast).** The Central Pollution Control Board (CPCB) runs 40 automatic stations in the Ganga basin that report roughly every 15–60 minutes. This is river water, not tap water, but it changes hour to hour, so it can drive near-real-time alerts.

**Taps (slow).** The Jal Jeevan Mission's Water Quality Management Information System (WQMIS) publishes laboratory test results for rural drinking-water sources, down to panchayat and village. Each source is tested once or twice a year at best. Across a whole district, though, new results land almost every day, and a national dashboard reports yesterday's test counts.

The site does four things:

1. It shows both sources on one map, with the age of every reading made visible.
2. It answers "what's near me" from a location or a dropped pin: the nearest river stations and the nearest tested panchayats, each with its distance and date.
3. It lets anyone subscribe by email to a pin and radius, and sends alerts when new data crosses a documented limit, when a place is overdue for testing, or as a weekly summary.
4. It has a simulation mode with a mock location that generates random alerts, so the whole alert pipeline can be demonstrated without waiting for real contamination.

Non-goals: no IoT or sensors, no login-required government APIs, no SMS in this version (India needs TRAI DLT registration for bulk SMS), and no predictions or claims about water between official tests.

---

## 2. Data sources

Everything in this section was verified live on 23 Oct 2026 from a residential connection in India, unless it is marked **UNVERIFIED**. Phase 1 must re-check everything, save raw responses as fixtures, and record the findings in `docs/SOURCES.md`.

### 2.1 CPCB real-time river stations

| Item | Value |
|---|---|
| URL | `https://rtwqmsdb1.cpcb.gov.in/data/internet/layers/10/index.json` (append `?t=<epoch ms>` to bust caches) |
| Access | Anonymous GET; no key, no cookies. This is the dashboard's own static data file (a KISTERS web-portal layout), not a documented API, so treat it as liable to change. |
| TLS | `curl -k` was used successfully. Try normal certificate verification first. If it fails, allow an insecure agent **for this host only**, behind `CPCB_INSECURE_TLS=true`, and log a warning. |
| Shape | JSON array, about 468 objects, roughly 485 KB. One object per station × parameter, holding the **latest value only**; there is no history in this file. |
| Coverage | 40 stations in Uttar Pradesh, Bihar, West Bengal, Uttarakhand, Jharkhand and Haryana |
| Freshness seen | 38 of 40 stations had a reading within the last 3 hours. Two were stale: BH75 (about 13 days) and WB90 (about 51 days). |

Fields per object (exact names):

```
station_no, station_id, station_name, station_longname, station_latitude, station_longitude,
territory_name, catchment_name, site_no, station_status_remark, station_diary_status,
stationparameter_name, stationparameter_longname, stationparameter_no,
ts_id, ts_name, ts_shortname, ts_unitsymbol, ts_value, timestamp (ISO UTC, e.g. 2026-10-23T04:30:00.000Z),
req_timestamp, MAX_RANGE, ObjectDescription
```

Parameter codes (`stationparameter_name`) and units (`ts_unitsymbol`):

| Code | Meaning | Unit |
|---|---|---|
| pH | pH | (none; source shows `---`) |
| DO | Dissolved oxygen | mg/l |
| BOD | Biochemical oxygen demand | mg/l |
| COD | Chemical oxygen demand | mg/l |
| TOC | Total organic carbon | mg/l |
| Nitrate | Nitrate | mg/l |
| CL | Chloride | mg/l |
| EC | Conductivity | mS/cm |
| WTb | Turbidity | NTU |
| WT | Water temperature | °C |
| Depth | Depth | m |
| S | River stage | m |

`station_diary_status` holds a log of outages ("technical issue" start/end entries). Parse it if it's easy; it explains gaps.

There is no history endpoint, so **we build history by polling every 15 minutes and storing every new (station, parameter, timestamp)**. Phase 1 should look for KISTERS per-station time-series files under the same `/data/internet/` tree (**UNVERIFIED**). If they exist, use them to backfill the last 7 days.

### 2.2 WQMIS (Jal Jeevan Mission water quality)

Base URL: `https://ejalshakti.gov.in/WQMIS`. It is an ASP.NET MVC site whose public reports need no login. Two protections must be handled, and both are things every browser does automatically. Neither is a login or a CAPTCHA:

1. **Anti-forgery token.** POST endpoints reject requests without `__RequestVerificationToken`. GET `Report/Report_L` with a cookie jar, then read the token from the hidden input:
   `/__RequestVerificationToken[^>]*?value="([^"]+)"/`. Send it as the form field `__RequestVerificationToken`, and also as the header `RequestVerificationToken`, together with the cookies from that same session.
2. **Encrypted parameters.** The site's own JavaScript encrypts parameter values with AES-128-CBC. Key and IV are both the ASCII string `8080808080808080`, padding is PKCS7, and the output is base64. The site ships this key in its public `aes.js`.

```js
import crypto from 'node:crypto';
const K = Buffer.from('8080808080808080');
export const enc = (v) => { const c = crypto.createCipheriv('aes-128-cbc', K, K); return Buffer.concat([c.update(String(v), 'utf8'), c.final()]).toString('base64'); };
export const dec = (b) => { const d = crypto.createDecipheriv('aes-128-cbc', K, K); return Buffer.concat([d.update(Buffer.from(b, 'base64')), d.final()]).toString('utf8'); };
// test vectors (verified): enc('15') === 'n4y3XImHOT34OR3rSpPhoQ=='; enc('19365256') === 'wTFPbUYrtkpKCPa8pkatkA=='
```

Always URL-encode base64 values when they go into query strings, because `+`, `/` and `=` must be escaped.

Endpoints:

| Purpose | Request | Status |
|---|---|---|
| Session + token | `GET Report/Report_L` | Verified |
| Districts | `POST Common/District_Bind_without_session`; form: `state_id=enc(id)` + token | Verified: 31 Karnataka districts |
| Blocks | `POST Common/Block_Bind`; form: `state_id`, `district_id` (all `enc`) + token | Verified |
| Gram panchayats | `POST Common/GetGramPanchayat_Bind`; form: `state_id`, `District_id`, `Block_id` (all `enc`) + token | Verified |
| Villages | `Common/GetVillage_Bind_without_session/`; data: `state_id`, `District_id`, `Block_id`, `Grampanchayat_id` (all `enc`) | **UNVERIFIED**: the old name `GetVillage_Bind` now returns only the placeholder. Read the page JS to confirm the HTTP method (jQuery `$.ajax` defaults to GET unless `type` is set). |
| Lab samples for a whole panchayat | `GET Report/labtestingsamplelist?currentstatus=3&fy=enc('2025-2026')&stid=enc(st)&dtid=enc(dt)&blid=enc(bl)&gpid=enc(gp)&villid=enc(0)` | Verified: loads the real page (19 table rows for Adagal, FY 2025-26). `villid=enc(0)` returns the whole panchayat, so the village dropdown isn't needed for ingestion. **Column layout UNVERIFIED**: inspect the saved fixture. Meaning of `currentstatus` values also UNVERIFIED (3 likely means "tested"). |
| Single lab report | `GET Common/final_report_print?s_id=<urlencoded enc(numericSampleId)>` | Partly verified. One old sample (19365256) returns HTTP 500, "Object reference not set to an instance of an object". Test with fresh `s_id` links taken from sample lists. |
| National daily dashboard | `Main/GetMainDashboard` | **Method UNVERIFIED** (try GET, then POST + token). Fields seen in page JS: `total_tested_yesterday`, `contaminated_yesterday`, `ftk_testing_yesterday`, `ftk_testing`, `Villages_trained_ftk`, `total_village_ftk_test_complete` |
| State-wise daily numbers | `Main/GetMainDashboard_samples_tested_laboratories` | **Method UNVERIFIED**. Fields seen: `StateName`, `totallaboratories`, `sample_received_lab_yesterday`, `sample_received_lab`, `sample_tested_Yesterday`, `sample_tested`, `Number_FTK_test_done_yesterday`, `Number_FTK_test_done`, `total_village_ftk_test_complete` |
| Worth exploring later | `Report/Get_lab_source_list`, `Report/Get_lab_source_list_details`, `Report/Labtestingdata`, `Report/Get_rpt_ftk_testing_village_list` (village-level field-test-kit data, possibly more frequent) | UNVERIFIED |

Dropdown responses are JSON arrays whose first item is a placeholder (`"--Select--"`, with an empty, blank or `0` ID). Always filter it out. ID and name fields:

- districts: `JJM_DistrictId` / `DistrictName`
- blocks: `JJM_BlockId` / `BlockName`
- panchayats: `JJM_PanchayatId` / `PanchayatName`
- villages: `JJM_VillageId` / `VillageName`

State IDs use JJM's numbering, not Census or LGD codes:

| State | ID | State | ID | State | ID |
|---|---|---|---|---|---|
| Andaman & Nicobar | 1 | Haryana | 12 | Odisha | 24 |
| Andhra Pradesh | 2 | Himachal Pradesh | 13 | Puducherry | 25 |
| Arunachal Pradesh | 3 | Jammu & Kashmir | 14 | Punjab | 26 |
| Assam | 4 | Jharkhand | 34 | Rajasthan | 27 |
| Bihar | 5 | Karnataka | 15 (verified) | Sikkim | 28 |
| Chhattisgarh | 33 | Kerala | 16 | Tamil Nadu | 29 |
| Dadra & Nagar Haveli and Daman & Diu | 7 | Ladakh | 37 | Telangana | 36 |
| Goa | 10 | Lakshadweep | 19 | Tripura | 30 |
| Gujarat | 11 | Madhya Pradesh | 17 | Uttar Pradesh | 31 |
| | | Maharashtra | 18 | Uttarakhand | 35 |
| | | Manipur 20, Meghalaya 21, Mizoram 22, Nagaland 23 | | West Bengal | 32 |

Known-good test path: Karnataka (15) → Bagalkote (187) → Badami (2481) → Adagal (59783).

Testing cadence, for the UI copy and the overdue logic: JJM norms are at least one chemical/physical test per source per year and at least two bacteriological tests per year. Publication runs up to the last day of the current month.

**Do not use** the WQMIS mobile-app API (`/wqmis/api/apimobileA/...`). It requires a key tied to an official's login. Also do not use Odisha's JALAMANA dashboard, whose robots.txt disallows automated access.

### 2.3 Rules for touching government servers

- Space requests at least 500 ms apart per host, with one in-flight request per host. Use exponential backoff on 5xx responses or timeouts, and a circuit breaker that pauses a source for 1 hour after 5 consecutive failures.
- Send a descriptive `User-Agent` that includes `CONTACT_EMAIL` from env.
- Cache aggressively. Hierarchy (districts/blocks/panchayats) is crawled weekly, sample lists daily, CPCB every 15 minutes.
- Store raw responses for debugging: HTML/JSON goes to `data/raw/` as gzipped files, kept for 30 days. On Render, mount a small persistent disk on the worker service for this directory (see section 12); it's for debugging, not a system of record, so losing it is not a problem.
- Treat every parser as fragile. On a schema surprise, log it, record it in `source_health`, and keep serving the last good data. Never crash the worker.

---

## 3. Architecture

**Deployment target is Render, and only Render.** No AWS, no LocalStack, no S3, no SES. This decides the shape of the app: Render bills every always-on process as its own paid service, so the fewer long-running services, the cheaper and simpler the deploy. The whole app is **one web service + one background worker + one managed Postgres**, and the web service builds the frontend into static files and serves them itself rather than paying for a separate static site.

### Local development (Docker Compose — a mirror of the Render layout, for iteration speed only)

```
 browser ──▶ web (Vite dev server, proxies /api to api) ──▶ api (Fastify) ──▶ db (Postgres 16 + PostGIS)
                                                              worker (node-cron, same jobs as section 6) ──▶ db
                                                              worker ──▶ mailpit (dev inbox UI, http://localhost:8025)
```

| Service | Image / tech | Notes |
|---|---|---|
| `db` | `postgis/postgis:16-3.4` (PostgreSQL 16 + PostGIS extension) | The SQL database container. Named volume `pgdata`; host port 5433 (avoids clashing with any local Postgres on Windows) |
| `migrate` | Same Node image as `api` | One-shot container: applies `db/migrations/*.sql` in order, records them in a `schema_migrations` table, then exits |
| `adminer` | `adminer` | Browser SQL client at http://localhost:8081 (server `db`, user/password/db `water`) for inspecting tables during development and demos |
| `api` | Node 22, Fastify, `postgres` (porsager) client | REST API. In this dev compose it does **not** serve the frontend (that's what Vite's dev server is for); in production it does — see section 12. |
| `worker` | Node 22, `node-cron`, `undici` fetch + `fetch-cookie` + `tough-cookie`, `cheerio` | All schedules from section 6; never exposes a port |
| `web` | Vite, vanilla JavaScript (ES modules), MapLibre GL JS, `d3-scale`/`d3-shape`, GSAP | Dev server on 5173 with proxy to `api`, for hot reload. Not used in production — see section 12 for how the same `web/` source is built and served there. |
| `mailpit` | `axllent/mailpit` | SMTP 1025, inbox UI http://localhost:8025. Dev-only: lets you preview emails before the worker ever sends a real one. Production always uses a real SMTP provider (section 12). |

Language: JavaScript (ESM) with `// @ts-check` and JSDoc types. Use npm workspaces. Use `node:test` for tests to keep dependencies small.

### Database container (docker-compose excerpt)

All data lives in the SQL container. Nothing is stored in app containers or on the host apart from the named volume. Migrations run from a one-shot `migrate` service rather than `docker-entrypoint-initdb.d`, because init scripts only run when the volume is empty and would silently skip later migrations.

```yaml
services:
  db:
    image: postgis/postgis:16-3.4
    environment:
      POSTGRES_USER: water
      POSTGRES_PASSWORD: water
      POSTGRES_DB: water
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U water -d water"]
      interval: 5s
      timeout: 3s
      retries: 20

  migrate:
    build: { context: ., dockerfile: services/api/Dockerfile }
    command: ["node", "services/api/migrate.js"]
    env_file: .env
    depends_on:
      db: { condition: service_healthy }
    restart: "no"

  api:
    build: { context: ., dockerfile: services/api/Dockerfile }
    env_file: .env
    ports: ["8080:8080"]
    depends_on:
      migrate: { condition: service_completed_successfully }

  worker:
    build: { context: ., dockerfile: services/worker/Dockerfile }
    env_file: .env
    depends_on:
      migrate: { condition: service_completed_successfully }

  adminer:
    image: adminer
    ports: ["8081:8080"]
    depends_on: [db]

volumes:
  pgdata:
```

Inside Docker, services connect with `DATABASE_URL=postgres://water:water@db:5432/water`. From Windows tools (DBeaver, pgAdmin, psql), use `localhost:5433`. `docker compose down` keeps the data; `docker compose down -v` wipes it. Add `npm run db:reset` and `npm run db:psql` helper scripts that wrap these commands.

---

## 4. Repository layout

```
downstream/
├─ BUILD_SPEC.md
├─ docker-compose.yml
├─ .env.example
├─ .gitattributes
├─ db/migrations/            001_init.sql, ...
├─ fixtures/                 raw responses saved by probes; tests run against these
├─ scripts/probe/            probe-cpcb.mjs, probe-wqmis.mjs (live, manual)
├─ packages/core/            aes.js, thresholds.js, parsers/ (cpcb.js, wqmis-*.js), geo.js, time.js
├─ services/api/             server.js, routes/, email-templates/
├─ services/worker/          index.js, jobs/ (cpcb.js, wqmis-hierarchy.js, wqmis-samples.js,
│                            wqmis-dashboard.js, alerts.js, overdue.js, digest.js, simulator.js, mailer.js)
├─ web/                      index.html, src/ (main.js, map/, panels/, styles/), public/
└─ docs/                     SOURCES.md, DESIGN.md, RENDER.md
```

---

## 5. Database schema (starting point)

```sql
create extension if not exists postgis;
create extension if not exists citext;

create table cpcb_station (
  station_no text primary key, name text, state text,
  geom geography(Point,4326), last_reading_at timestamptz, diary jsonb
);
create table cpcb_reading (
  station_no text references cpcb_station, parameter text, value double precision, unit text,
  measured_at timestamptz, fetched_at timestamptz default now(),
  primary key (station_no, parameter, measured_at)
);

create table wq_area (
  id bigserial primary key, level text check (level in ('district','block','gp','village')),
  jjm_id text not null, parent_id bigint references wq_area, state_id int, name text,
  geom geography(Point,4326), geocode_source text, geocode_confidence real,
  unique (level, jjm_id)
);
create table wq_sample (
  sample_id text primary key, gp_area_id bigint references wq_area, village_name text, source_type text,
  collected_at timestamptz, received_at timestamptz, analysed_at timestamptz, reported_at timestamptz,
  first_seen_at timestamptz default now(), report_s_id text, raw jsonb
);
create table wq_result (
  sample_id text references wq_sample, parameter text, value_text text, value double precision, unit text,
  acceptable_limit text, permissible_limit text,
  status text check (status in ('ok','above_acceptable','above_permissible','unknown')),
  primary key (sample_id, parameter)
);
create table wq_daily_snapshot (snapshot_date date, scope text, payload jsonb, primary key (snapshot_date, scope));

create table subscription (
  id uuid primary key default gen_random_uuid(), email citext not null,
  geom geography(Point,4326) not null, radius_km real not null default 10, kinds text[] not null,
  confirm_token text, confirmed_at timestamptz, unsubscribe_token text not null,
  is_mock boolean not null default false, created_at timestamptz default now()
);
create table alert (
  id uuid primary key default gen_random_uuid(), kind text, severity text check (severity in ('urgent','notice','info')),
  source text, subject_ref text, geom geography(Point,4326), title text, body jsonb,
  is_mock boolean not null default false, dedupe_key text unique, created_at timestamptz default now()
);
create table delivery (
  alert_id uuid references alert, subscription_id uuid references subscription, channel text default 'email',
  status text, sent_at timestamptz, error text, primary key (alert_id, subscription_id, channel)
);
create table source_health (
  source text primary key, last_attempt_at timestamptz, last_success_at timestamptz,
  last_error text, records_last_run int
);
```

Store all times in UTC and display them in Asia/Kolkata. The `wq_daily_snapshot` table matters: "yesterday" figures roll over daily, so saving one snapshot per day builds a history that the source itself doesn't keep.

---

## 6. Ingestion jobs (worker)

| Job | Schedule (IST) | What it does |
|---|---|---|
| `cpcb` | every 15 min | Fetch the layer file, upsert stations, insert new readings (the primary key dedupes), update `last_reading_at`, then trigger river alert evaluation. |
| `wqmis-hierarchy` | weekly, Sun 01:00 | For each state in `WQMIS_STATES`, crawl districts → blocks → panchayats for the districts listed in `WQMIS_DISTRICTS` (start with Bagalkote, 187). Upsert into `wq_area`. |
| `wqmis-samples` | daily 02:00 | For every panchayat in scope, fetch the sample list for the current FY with `villid=enc(0)`. On the first run, and during April–June, also fetch the previous FY. Parse rows, decrypt `s_id` links into sample IDs, and insert new samples (`first_seen_at` = now). Fetch the report page for each new sample to get parameter results and printed limits. Then trigger tap alert evaluation. |
| `wqmis-dashboard` | daily 10:00 | Save the national and state-wise "yesterday" numbers to `wq_daily_snapshot`. |
| `geocode` | after hierarchy crawl | Geocode panchayats (and villages if available) with Nominatim: `"{name}, {block}, {district}, {state}, India"`, one request per second, with a User-Agent and email. Cache permanently in `wq_area`. Fall back to the block centroid and lower `geocode_confidence`. Support a manual override CSV at `data/geocode-overrides.csv`. |
| `overdue` | daily 07:00 | Find subscribed panchayats with no chemical test in 12 months or no bacteriological test in 6 months, and create `tap_overdue` alerts. |
| `digest` | Mon 08:00 | Weekly summary per subscription. |
| `mailer` | every minute | Send pending deliveries (section 9). |
| `simulator` | random every 2–5 min, only when `MOCK_MODE=true` | Section 8. |

The fiscal year format is `YYYY-YYYY`, and India's FY starts on 1 April.

---

## 7. Alert engine

Every alert gets a deterministic `dedupe_key` (for example `river_threshold:UT67:DO:2026-10-23T04`), so re-running a job never creates duplicates. Matching subscriptions are found with `ST_DWithin(subscription.geom, alert.geom, radius_km*1000)`. A delivery row is created for each match.

### Alert kinds

| Kind | Source | Trigger | Severity |
|---|---|---|---|
| `river_threshold` | CPCB | A parameter crosses into violation of the river criteria below. Use hysteresis: fire only on the transition from OK to violation, then a 6-hour cooldown per station + parameter. | urgent |
| `river_recovered` | CPCB | Back within criteria for 2 consecutive readings after a violation | info |
| `river_spike` | CPCB | Robust z-score above 4 against the 7-day median/MAD, for parameters without an official limit (turbidity, EC, COD, TOC, nitrate, chloride) | notice |
| `river_station_silent` | CPCB | No reading for 6 hours | info |
| `tap_contamination` | WQMIS | New sample with any parameter above its permissible limit, or E. coli / coliform detected | urgent |
| `tap_caution` | WQMIS | New sample above the acceptable limit but within the permissible limit | notice |
| `tap_all_clear` | WQMIS | New sample with everything within limits | info (goes into the digest) |
| `tap_overdue` | WQMIS | No chemical test in 12 months, or no bacteriological test in 6 months | notice |
| `regional_geogenic` | WQMIS | Fluoride, arsenic or nitrate above the permissible limit within the subscriber's radius. These contaminants come from rock and affect whole areas of groundwater. Never spread bacteriological results beyond their own panchayat. | notice |

### River criteria (CPCB "designated best use" primary criteria; verify in Phase 1 and cite the source URL in SOURCES.md)

| Class | Use | pH | DO (mg/l) | BOD (mg/l) |
|---|---|---|---|---|
| B | Outdoor bathing | 6.5–8.5 | ≥ 5 | ≤ 3 |
| C | Drinking-water source after conventional treatment | 6.0–9.0 | ≥ 4 | ≤ 3 |

Default to Class C, and make the class configurable per deployment.

### Tap limits

Always prefer the acceptable and permissible limits **printed on each lab report**. Use this BIS IS 10500:2012 table only as a fallback, and verify it against the standard in Phase 1:

| Parameter | Acceptable | Permissible (no alternate source) |
|---|---|---|
| pH | 6.5–8.5 | no relaxation |
| Turbidity (NTU) | 1 | 5 |
| TDS (mg/l) | 500 | 2000 |
| Total hardness as CaCO3 (mg/l) | 200 | 600 |
| Chloride (mg/l) | 250 | 1000 |
| Fluoride (mg/l) | 1.0 | 1.5 |
| Nitrate as NO3 (mg/l) | 45 | no relaxation |
| Iron (mg/l) | 1.0 | no relaxation |
| Arsenic (mg/l) | 0.01 | verify against the current amendment |
| Free residual chlorine (mg/l) | min 0.2 | 1 |
| E. coli / total coliform | not detectable in 100 ml | not detectable |

---

## 8. Simulation mode (mock location)

When `MOCK_MODE=true`:

- On startup, seed one confirmed subscription with `is_mock=true` for `MOCK_EMAIL`, at `MOCK_LAT`/`MOCK_LNG` (default: a point in Bagalkote district, 16.18, 75.70), with a 15 km radius and all alert kinds.
- Every 2–5 minutes at random, the simulator creates one alert with `is_mock=true`. The kind is drawn at random, weighted towards urgent ones so the demo has drama, and the values are random but plausible.
- **Mock alerts must never name a real station, panchayat or village.** Use clearly fictional subjects such as "Test river station SIM-01" and "Test panchayat SIM-GP-1", placed within a few km of the mock point. A screenshot of a fake "contamination in Adagal" alert could mislead people.
- Mock emails have the subject prefix `[Simulated]` and a first line saying the alert is invented for testing.
- The map shows the mock point and mock subjects with a distinct dashed outline. A persistent turmeric-coloured band at the top of the page reads: "Simulation mode is on. Alerts marked as simulated are invented for testing."
- `POST /api/dev/simulate?kind=tap_contamination` fires one alert immediately. It only exists when `MOCK_MODE=true`.

---

## 9. Email

**Driver.** Nodemailer over plain SMTP, always. Dev points at Mailpit (`smtp://mailpit:1025`); production points at a real SMTP provider's credentials set as Render environment variables (Render has no built-in email service, so bring any provider with an SMTP endpoint — a free tier is enough for a demo volume of mail).

**Double opt-in.** Subscribing sends a confirmation link. Nothing else is sent until the subscriber confirms. Every email carries a one-click unsubscribe link and a `List-Unsubscribe` header.

**Batching.** The mailer bundles all pending deliveries for one subscription within a 15-minute window into a single email. Each address gets at most 6 emails a day, except urgent alerts, which always send.

**Templates.** Fixed templates with placeholders, so a future move to DLT-registered SMS is easy. Include a plain-text part. Every alert email states:
- what was measured, the value, and the limit;
- where, and the distance from the subscriber's pin;
- the source (CPCB river station or JJM lab test);
- for tap results, the collection date, the analysis date, and the date this site first saw the result;
- a link to the place on the site, and the government report link where one exists.

**Design.** Single column, max 600 px wide, survey-blue top rule, body set in the site's serif with system fallbacks. No images are required to read it.

---

## 10. API (Fastify, JSON, all under `/api`)

| Method & path | Returns |
|---|---|
| `GET /health` | Per-source `last_success_at`, `last_error`, and data age. Powers the freshness ledger. |
| `GET /stations` | GeoJSON FeatureCollection of CPCB stations: latest value per parameter, `last_reading_at`, status per parameter, `is_stale` |
| `GET /stations/:no/series?param=DO&hours=48` | Time series from `cpcb_reading` |
| `GET /areas?bbox=` | GeoJSON of geocoded panchayats: latest sample date, worst status, chemical/bacteriological test ages, `geocode_confidence` |
| `GET /areas/:id/samples` | Samples with results and limits |
| `GET /nearby?lat=&lng=&radius_km=` | Nearest stations and areas, with distance and data age |
| `GET /dashboard/daily?days=30` | `wq_daily_snapshot` history |
| `POST /subscriptions` | Body `{ email, lat, lng, radius_km, kinds }`. Creates the subscription and sends the confirmation. |
| `GET /subscriptions/confirm?token=` | Confirms the subscription, then redirects to the site with a success state |
| `GET /unsubscribe?token=` | Unsubscribes, then redirects to the site with a confirmation state |
| `GET /alerts?lat=&lng=&radius_km=&include_mock=` | Recent alerts for the map timeline |
| `POST /dev/simulate` | Only exists when `MOCK_MODE=true` |

Validate all inputs. Rate-limit `POST /subscriptions` per IP and per email.

---

## 11. Frontend and design

### Brief

The site is a public instrument for reading government water data honestly. Its subject is water, survey maps and lab tests, and its visual language should come from those materials. It must not look like an AI product or a SaaS template.

- **Audience:** residents, journalists, students and local officials, many on mid-range Android phones.
- **Primary job:** answer "what do we know about water near this point, and how old is it?" within five seconds of arriving.

### Tokens

**Colour.** Taken from Survey of India toposheet inks and field-test-kit reagent colours. The base is a cool mineral white, deliberately not warm cream.

| Name | Hex | Role |
|---|---|---|
| Limestone | `#E7ECEA` | Page background |
| Basalt | `#222A2D` | Text, ink, outlines (Deccan basalt) |
| Survey blue | `#1E5E8A` | Rivers, CPCB layer, links, focus rings |
| Contour umber | `#6F5B3E` | WQMIS / groundwater layer, secondary marks |
| Indicator green | `#2E7A57` | Within limits |
| Reagent yellow | `#D4A017` | Above acceptable, below permissible; simulation band |
| Reagent red | `#B1271C` | Above permissible / urgent |
| No recent data | Basalt at 30% opacity + diagonal hatch | Stale or never tested |

Night mode ("night survey"): page `#182022`, text `#DCE3E0`, survey blue `#7DB3D9`, umber `#B59A72`, status colours raised to keep AA contrast. Define everything as CSS custom properties on `:root`, overridden under `@media (prefers-color-scheme: dark)`.

**Type.**
- Anek Latin (variable weight and width, by the Indian foundry Ek Type) for headings, place names, numbers and UI.
- Source Serif 4 for body text, report notes and email.
- If Indic place names are added later, the Anek family has matching Kannada, Devanagari and Bangla cuts.
- Self-host via `@fontsource-variable/*` so Docker builds work offline.
- Use `font-variant-numeric: tabular-nums` for all data.
- Type scale (px): 12, 14, 16, 18, 21, 24, 36, 48, 60. Body 18/1.6 serif; UI 16/1.4 Anek. Measure under 72 characters.

**Shape.**
- Two radii only: 2 px for data elements (report rulers, table cells) and 999 px for pills and toggles.
- No drop shadows except one on the floating panel over the map on mobile.

### Layout

Desktop is map-dominant. A fixed left column (420 px) holds the reading content, left-aligned with a ragged right edge:

```
┌──────────────────────────┬───────────────────────────────────────────────┐
│ DownStream   [freshness]│                                               │
│                          │                                               │
│ Live sentence (hero)     │                  MAP                          │
│ [Use my location] [Get   │   river stations: circles, survey blue ring   │
│  alerts]                 │   panchayats: rounded squares, umber ring     │
│                          │   ring arc = how fresh the data is            │
│ Selected place:          │   fill = status colour                        │
│  report rulers / 48 h    │                                               │
│  small multiples         │                                               │
│ Subscribe form           │                                               │
└──────────────────────────┴───────────────────────────────────────────────┘
Below the fold: "How a tap sample becomes public" (a real sequence), "Sources and method", "Freshness ledger"
```

Mobile: the map takes the top 55vh, and the content sits in a draggable bottom sheet with three snap points. The map never hijacks page scroll; use `cooperativeGestures` on mobile.

### The one memorable thing: freshness rings

Every marker carries a ring whose arc length shows how fresh its data is.
- **River stations:** a full ring under 1 hour, emptying linearly to nothing at 24 hours.
- **Panchayats:** full under 30 days, empty at 12 months; the bacteriological ring empties at 6 months.
- **Stale data:** a dotted ring with the hatch fill.
- **Fill colour:** the status.
- **Shape:** the source (circle = river, rounded square = tap).

On first load, all rings draw once from empty to their true value. That is the page's single orchestrated animation: 900 ms, staggered by distance from the map centre, and skipped entirely under `prefers-reduced-motion`. Implement markers as SVG (fewer than about 1,500 of them) or as a custom MapLibre layer if there are more. Keep everything else on the page quiet so this reads clearly.

### Hero copy (live, computed from real data)

> The Ganga at {freshest station near the viewer, else the freshest overall} was measured {n} minutes ago. Taps in {nearest tested panchayat} were last lab-tested {n} months ago.

Set the sentence in Anek Latin at 48–60 px with tight leading, with no single word highlighted. Below it, two buttons: "Use my location" and "Get alerts". If geolocation is refused, ask for a district or pin instead.

### Components

- **Map.** MapLibre GL JS with OpenFreeMap tiles (free, no key, no registration). Fetch `https://tiles.openfreemap.org/styles/positron` at build time and recolour it to the palette:
  - land: Limestone
  - water bodies: Survey blue at 20%
  - waterways: Survey blue, with major rivers drawn heavier
  - roads: Basalt at 12–18%
  - POIs: hidden
  - labels: keep OpenFreeMap's glyph fonts

  Keep the attribution visible. Put the style URL in config so it can be self-hosted later.
- **Station panel.** 12 small multiples (48-hour sparklines, `d3-shape`), with the criteria band shaded and the latest value as a large Anek numeral. Show "Reading from 10:30 IST, 14 minutes ago" in plain text.
- **Lab report rulers.** One horizontal scale per parameter, with tick marks at the acceptable and permissible limits and the result as a reagent-coloured marker. The value and unit sit at the right edge in tabular figures. Collection, analysis and first-seen dates appear as a short sequence at the top. Link to the government report.
- **Subscribe.** Click the map or use your location to drop a pin. The radius slider (1–50 km) draws the circle live. Then email, then alert choices in plain words:
  - "A river reading crosses a safe limit"
  - "A new tap-water test fails"
  - "An area near me is overdue for testing"
  - "A weekly summary"

  The button reads "Send confirmation email". After it's pressed, show "Confirmation sent to {email}. Open it to start alerts."
- **Freshness ledger.** A table of each source: last successful fetch, newest data point, and records in the last run. This is the transparency page in miniature.
- **"How a tap sample becomes public".** A genuine sequence (collected → reached lab → analysed → report generated → first seen here). It shows median lags computed from our own data and is the one place where GSAP ScrollTrigger may pin and step through. Use the View Transitions API when switching panels.

### Copy rules

- Sentence case everywhere. Plain verbs. Buttons say exactly what happens.
- Always say what kind of water a number is about. CPCB is "river water at this station", never "your water".
- Never say a place's water "is safe". Say "Last lab test on {date}: all tested parameters within limits."
- Errors explain what happened and what to do, e.g. "River data couldn't be refreshed (CPCB didn't respond). Showing readings from 10:30 IST."
- Empty states invite action, e.g. "No lab tests published for this panchayat this year. Get an alert when one appears."

### Things to avoid (these read as generic or AI-made)

- Purple or blue-violet gradients, neon glows, glassmorphism, sparkle icons, "AI-powered" copy, emoji in the UI.
- Warm cream backgrounds with terracotta accents. A near-black page with a single acid accent.
- Identical rounded cards in a grid. The same soft grey shadow under everything.
- All-caps eyebrow labels above headings. Meta text joined with middle dots. "→" appended to buttons. Monospace for small labels.
- Fade-and-slide-up on every section. Custom cursors. Scroll-jacking.

### Quality floor

- WCAG AA contrast in both themes.
- Status is never shown by colour alone: shape, ring style and text label always accompany it.
- Full keyboard path, with a list view that mirrors the map.
- Visible focus rings in Survey blue.
- Responsive down to 360 px. `prefers-reduced-motion` respected.
- Lighthouse performance ≥ 85 on mobile; lazy-load the map below a static first paint of the hero sentence.

Write the final palette, type scale and component decisions into `docs/DESIGN.md`. Take screenshots during Phase 7 and critique them against this section before calling it done.

---

## 12. Deploying on Render

This is the only deployment target. There is no AWS, no multi-cloud abstraction, and no `docker compose up` on the server — Render runs each service from a `render.yaml` **Blueprint**, which is infrastructure-as-code committed to the repo. Three Render services, no more:

| Render service | Type | Repo entrypoint | Role |
|---|---|---|---|
| `downstream-web` | Web Service (Docker) | `services/api/Dockerfile` | Builds the frontend, then runs the Fastify API, which also serves the built frontend as static files. This is the one public URL. |
| `downstream-worker` | Background Worker (Docker) | `services/worker/Dockerfile` | Runs every job in section 6 in-process with `node-cron`, exactly like the local `worker` container. Never exposes a port, and Render doesn't give it a public URL. |
| `downstream-db` | Render Postgres | — | Managed PostgreSQL with the PostGIS extension enabled. Render's free Postgres instance is deleted (plan, data and backups) 30 days after creation — acceptable for this project, since it's a demo/testing deployment and not something that needs to stay up indefinitely. If the project later needs to persist past 30 days, it's a one-line plan upgrade in the Render dashboard, not a code change. |

### `render.yaml` (Blueprint — commit this at the repo root)

```yaml
databases:
  - name: downstream-db
    plan: free
    region: singapore          # closest Render region to India; change if a different one benchmarks faster

services:
  - type: web
    name: downstream-web
    runtime: docker
    dockerfilePath: services/api/Dockerfile
    dockerContext: .
    plan: free
    region: singapore
    healthCheckPath: /api/health
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: downstream-db, property: connectionString }
      - key: NODE_ENV
        value: production
      - key: MOCK_MODE
        value: "true"          # keep the simulator and its alert kind visible in the demo deployment
      - key: PUBLIC_BASE_URL
        sync: false            # set to the Render-assigned URL after first deploy, e.g. https://downstream-web.onrender.com
      - key: EMAIL_DRIVER
        value: smtp
      - key: SMTP_URL
        sync: false            # paste a real SMTP connection string in the Render dashboard; never commit it
      - key: EMAIL_FROM
        sync: false
      - fromGroup: shared-config   # MOCK_LAT, MOCK_LNG, WQMIS_STATES, etc. — see env group below

  - type: worker
    name: downstream-worker
    runtime: docker
    dockerfilePath: services/worker/Dockerfile
    dockerContext: .
    plan: starter               # Render has no free tier for background workers; this is the cheapest paid tier
    region: singapore
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: downstream-db, property: connectionString }
      - key: NODE_ENV
        value: production
      - fromGroup: shared-config

envVarGroups:
  - name: shared-config
    envVars:
      - key: CONTACT_EMAIL
        sync: false
      - key: MOCK_MODE
        value: "true"
      - key: MOCK_EMAIL
        sync: false
      - key: MOCK_LAT
        value: "16.18"
      - key: MOCK_LNG
        value: "75.70"
      - key: WQMIS_STATES
        value: "15"
      - key: WQMIS_DISTRICTS
        value: "187"
      - key: RIVER_CRITERIA_CLASS
        value: "C"
```

Create the env var group and the two `sync: false` secrets in the Render dashboard before the first deploy; `render.yaml` declares that they exist but deliberately doesn't commit their values.

### The web service builds the frontend and serves it — one process, one command

Render's web service runs a single container with a single public port, so the frontend is not a separate static site. `services/api/Dockerfile` does the frontend build as a build stage, then the Fastify server serves the output directory as static files for every route that isn't `/api/*`.

```dockerfile
# services/api/Dockerfile
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build --workspace web        # vite build -> web/dist

FROM node:22-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY services/api/package.json services/api/
RUN npm ci --omit=dev
COPY packages/core packages/core
COPY services/api services/api
COPY --from=build /repo/web/dist web/dist
EXPOSE 8080
CMD ["node", "services/api/server.js"]
```

In `services/api/server.js`, after every `/api/*` route is registered, add a static-file handler (Fastify: `@fastify/static` pointed at `web/dist`, with a catch-all that serves `index.html` for any non-API, non-file path, so the client-side router — if one is added later — still works). Health check: `GET /api/health` must return `200` quickly and without touching the database on every call (cache the DB check for a few seconds), because Render's health check polls it continuously and a slow check can flap the service.

Root `package.json` needs a single top-level build command Render can run:

```json
{
  "scripts": {
    "build": "npm run build --workspace web",
    "start": "node services/api/server.js",
    "start:worker": "node services/worker/index.js"
  }
}
```

Render's dashboard build/start commands for `downstream-web` (shown here for clarity; `render.yaml`'s `dockerfilePath` already encodes this, so these aren't separately configured when deploying from the Dockerfile):
- **Build command:** `npm run build` (builds the frontend; the Dockerfile above does this as a build stage instead, so with Docker-based deploy this row is informational only)
- **Start command:** `npm start`, i.e. `node services/api/server.js` — this is the one process that serves everything.

`downstream-worker` has no build command and starts with `node services/worker/index.js` (or `npm run start:worker`).

### Migrations on Render

There is no separate `migrate` service on Render (a one-shot Docker service isn't a natural fit for Render's always-on service types). Instead, `services/api/server.js` runs pending migrations from `db/migrations/` once at boot, before it starts listening, guarded by a Postgres advisory lock (`pg_advisory_lock`) so that a worker deploy and a web deploy racing each other at startup can't both try to migrate at once. This is the same `migrate.js` logic from local dev, just invoked automatically instead of as its own container.

### What's deliberately not on Render

- No Redis, no queue service — `node-cron` inside the single worker process is enough at this scale.
- No CDN or separate static-site service for the frontend — the web service serves it directly, which is why bundle size and caching headers on `web/dist` assets matter (set `Cache-Control: public, max-age=31536000, immutable` on hashed Vite output files).
- No S3-equivalent for the raw-response archive. If a persistent disk is wanted for `data/raw/`, attach a small Render Disk to `downstream-worker` (not the web service, which should stay stateless so it can restart freely); otherwise the archive just resets on every worker deploy, which is fine for a project whose whole point is that the live sources are re-fetched anyway.

Write what was actually deployed — service names, the Render region picked, the SMTP provider used, and the live URL — into `docs/RENDER.md` once Phase 8 is done.

---

## 13. Build phases

**Phase 0: scaffold.**
- npm workspaces, compose file with `db`, `mailpit`, `api`, `worker`, `web`, `migrate`, `adminer`, `.env.example`, migrations, and `/api/health` returning 200. Add `render.yaml` and both Dockerfiles from section 12 at the same time, even though they aren't used until Phase 8, so the app is built against the real production shape (one process serving API + frontend) from day one instead of retrofitted later.
- ✅ `docker compose up` brings everything up on Windows, http://localhost:5173 shows a placeholder, and http://localhost:8025 shows Mailpit.
- ✅ The `migrate` container exits 0, http://localhost:8081 (Adminer) lists every table from section 5, and data survives `docker compose down` followed by `up`.

**Phase 1: discovery (live).**
- Write `scripts/probe/probe-cpcb.mjs` and `probe-wqmis.mjs`. They walk every endpoint in section 2, save raw responses to `fixtures/`, and resolve each UNVERIFIED item: village endpoint method, sample-list columns, `currentstatus` values, report page fields, dashboard methods, KISTERS history files, CPCB criteria and BIS limits.
- Write `docs/SOURCES.md` with the confirmed request/response for each endpoint.
- ✅ Fixtures exist for the CPCB layer, every dropdown level, one sample list with rows, one lab report, and both dashboard endpoints. **Stop here and show SOURCES.md to the developer.**

**Phase 2: CPCB ingest.**
- Parser and job, with tests against the fixture.
- ✅ After two cycles, `cpcb_reading` grows only by new timestamps, and stale stations are flagged.

**Phase 3: WQMIS client.**
- Session, token, AES, dropdown crawling, sample-list and report parsers, dashboard snapshot, polite request queue.
- ✅ The Bagalkote crawl completes, `wq_sample` holds rows with dates, `wq_result` holds limits, re-running inserts nothing new, and AES tests pass the vectors in 2.2.

**Phase 4: geocoding.**
- ✅ At least 80% of Bagalkote panchayats have coordinates with a confidence score, and overrides work.

**Phase 5: alerts, email, simulator.**
- ✅ With `MOCK_MODE=true`, subscribing with an email sends a confirmation to Mailpit. After confirming, `[Simulated]` alerts arrive every few minutes, bundled correctly, each with a working unsubscribe link.
- ✅ A unit test proves a fixture with DO = 3.2 mg/l raises exactly one `river_threshold` alert, and a repeat run raises none.

**Phase 6: API.**
- Every route in section 10, with input validation and rate limits.
- ✅ The tests pass.

**Phase 7: frontend.**
- Everything in section 11.
- ✅ Screenshots at 1440 px and 390 px in both themes, a self-critique written into DESIGN.md, and a keyboard-only walkthrough that works end to end.

**Phase 8: deploy to Render.**
- Push `render.yaml`, create the Blueprint in the Render dashboard, create the `shared-config` env var group and the two `sync: false` secrets (`PUBLIC_BASE_URL` once the URL is known, and `SMTP_URL`/`EMAIL_FROM` from a real SMTP provider), then deploy.
- ✅ `https://downstream-web.onrender.com/api/health` returns 200. The site loads at the root URL and is the same build that ran locally. The worker service's logs show the CPCB and WQMIS jobs running on schedule. Subscribing with a real email sends a real email through the configured SMTP provider. `docs/RENDER.md` records the service names, region, SMTP provider, and live URL.

**Phase 9: hardening.**
- Circuit breakers, `source_health` surfaced in the UI, README with run instructions and screenshots.
- ✅ Killing the network for 10 minutes degrades gracefully, and recovery is automatic.

### Final demo script

1. `docker compose up`, then open the site.
2. The map shows the CPCB stations with freshness rings and the Bagalkote panchayats.
3. Click a station to see its 48-hour charts. Click a panchayat to see its lab report rulers.
4. Subscribe at the mock point with an email and confirm the subscription in Mailpit.
5. Watch the simulated alerts arrive.
6. Run `POST /api/dev/simulate?kind=tap_contamination` and see the urgent email arrive within a minute.

---

## 14. Testing

- `node:test` unit tests run against fixtures for every parser, AES, thresholds, hysteresis, dedupe keys, batching and overdue logic. No live network in tests.
- One integration test spins up the db and runs CPCB ingest, then alerts, then the mailer against Mailpit's API (`GET /api/v1/messages`).
- Probe scripts are the only code that hits government servers manually; they are never run in CI.

---

## 15. Environment variables (`.env.example`)

```
NODE_ENV=development
DATABASE_URL=postgres://water:water@db:5432/water
PUBLIC_BASE_URL=http://localhost:5173
CONTACT_EMAIL=you@example.com          # sent in User-Agent to government sites and Nominatim

CPCB_URL=https://rtwqmsdb1.cpcb.gov.in/data/internet/layers/10/index.json
CPCB_INSECURE_TLS=false
RIVER_CRITERIA_CLASS=C

WQMIS_BASE=https://ejalshakti.gov.in/WQMIS
WQMIS_STATES=15
WQMIS_DISTRICTS=187
WQMIS_MIN_INTERVAL_MS=500

EMAIL_DRIVER=smtp
SMTP_URL=smtp://mailpit:1025           # on Render, a real provider's SMTP URL, set as a dashboard secret
EMAIL_FROM="DownStream <alerts@localhost>"
MAX_EMAILS_PER_DAY=6

MOCK_MODE=true
MOCK_EMAIL=demo@example.com
MOCK_LAT=16.18
MOCK_LNG=75.70
MOCK_INTERVAL_MIN=2
MOCK_INTERVAL_MAX=5

MAP_STYLE_URL=https://tiles.openfreemap.org/styles/positron
```

---

## 16. Honesty rules

These rules are part of the product, not legal boilerplate.

- Every number on screen and in email carries its date, its source, and what kind of water it describes.
- Tap results show three dates where available: collected, analysed, and first seen here. The gap between them is information.
- Stale data is shown as stale and never silently dropped.
- Simulated data is always labelled. It is never attributed to real places, and it is never mixed into real statistics.
- No claim about water quality between official tests, and no "safe to drink" verdicts.