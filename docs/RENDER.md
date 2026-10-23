# Deploying DownStream for free (Render + GitHub Actions)

**Status: not deployed yet.** Everything in the repo is ready; the steps need your GitHub and Render logins.
When it's live, fill in the "Deployed" table at the end.

## How it runs, and why it costs nothing

| Piece | Where | Plan | Role |
|---|---|---|---|
| `downstream-web` | Render web service (Docker, `services/api/Dockerfile`) | free | Serves the site and `/api/*`, sends confirmation emails, runs migrations at boot |
| `downstream-db` | Render Postgres | free (deleted 30 days after creation) | All data. PostGIS and citext are enabled by the first migration |
| Scheduled jobs | GitHub Actions (`.github/workflows/`) | free in a **public** repository | Each workflow runs one job with `node services/worker/run-once.js <job>` against the database's external URL |

There's no background worker on Render: Render has no free plan for workers. Locally, `docker compose up`
still runs every job in one `worker` container with node-cron, unchanged.

**The GitHub repository must be public.** The schedules below use about 25,000 runner-minutes a month,
because every run bills at least a minute. Standard runners are free and unlimited for public repositories.
Private repositories get 2,000 free minutes a month, after which the workflows stop. Public is safe here:
no credentials are in the code, `.env` files are gitignored, and secrets live in GitHub's encrypted
Actions secrets.

| Workflow | Job | Schedule | Notes |
|---|---|---|---|
| `cpcb.yml` | `cpcb` | every 15 minutes | River readings, river alerts. The first run backfills 7 days (about 5 minutes) |
| `wqmis-hierarchy.yml` | `wqmis-hierarchy` | Sunday 01:00 IST | Districts, blocks, panchayats, villages |
| `geocode.yml` | `geocode` | Sunday 03:00 IST | OpenStreetMap locations for panchayats |
| `wqmis-samples.yml` | `wqmis-samples` | daily 02:00 IST | New lab samples, tap alerts |
| `wqmis-reports.yml` | `wqmis-reports` | hourly | Lab reports, 500 a run, only while a backlog exists |
| `wqmis-dashboard.yml` | `wqmis-dashboard` | daily 10:00 IST | National "yesterday" figures |
| `overdue.yml` | `overdue` | daily 07:00 IST | Panchayats overdue for testing |
| `digest.yml` | `digest` | Monday 08:00 IST | Weekly summary emails |
| `mailer.yml` | `mailer` | every 5 minutes | Sends pending alert emails (GitHub's minimum interval) |
| `simulator.yml` | `simulator` | every 5 minutes | Fires a simulated alert about half the time |
| `bootstrap.yml` | `bootstrap` | manual | Fills an empty database: run once after the first deploy |
| `keepalive.yml` | (curl) | every 10 minutes | Pings `/api/health` so the free web service never sleeps |
| `heartbeat.yml` | (git) | 1st of each month | Empty commit; GitHub disables schedules after 60 days without activity |

Crons in the files are UTC; the comments give the IST times they correspond to.

## Steps

1. **Create a public GitHub repository** (for example `downstream`), then push this folder:

   ```sh
   git add -A
   git status            # .env and .env.original-backup must NOT be listed
   git commit -m "DownStream"
   git branch -M main
   git remote add origin https://github.com/<you>/downstream.git
   git push -u origin main
   ```

2. **Create the Render Blueprint:** Render dashboard > **New > Blueprint** > pick the repository. It
   creates `downstream-web`, `downstream-db` and the `shared-config` group, all on free plans. When
   asked for values:

   | Key | Value |
   |---|---|
   | `SMTP_URL` | the `SMTP_URL` line from your local `.env` (`smtps://gazebot.alert%40gmail.com:…@smtp.gmail.com:465`) |
   | `EMAIL_FROM` | `DownStream <gazebot.alert@gmail.com>` |
   | `CONTACT_EMAIL` | `gazebot.alert@gmail.com` |
   | `PUBLIC_BASE_URL` | empty for now |

3. When the web service is live, set its `PUBLIC_BASE_URL` (**downstream-web > Environment**) to its URL,
   for example `https://downstream-web.onrender.com`.
4. **Add the GitHub secrets:** in the repository, **Settings > Secrets and variables > Actions > New
   repository secret**.

   | Secret | Value | Needed |
   |---|---|---|
   | `DATABASE_URL` | Render > `downstream-db` > **Connect** > **External** connection string. GitHub's runners aren't on Render's private network | yes |
   | `SMTP_URL` | same as on Render | yes |
   | `EMAIL_FROM` | `DownStream <gazebot.alert@gmail.com>` | yes |
   | `CONTACT_EMAIL` | `gazebot.alert@gmail.com` | yes |
   | `PUBLIC_BASE_URL` | the site's URL. Used in email links and by `keepalive` | yes |
   | `CPCB_URL`, `WQMIS_STATES`, `WQMIS_DISTRICTS`, `MOCK_LAT`, `MOCK_LNG`, `MOCK_MODE` | only to change the defaults (CPCB layer 10; Karnataka 15; Bagalkote 187; 16.18, 75.70; `true`) | no |
   | `MOCK_EMAIL` | an address to pre-subscribe at the simulation point. Usually leave unset and subscribe from the site | no |

   The external URL is a `*.render.com` host; the jobs connect to it over TLS automatically.
5. **Fill the database:** **Actions > "bootstrap (fill an empty database)" > Run workflow.** It takes about
   25 minutes: CPCB with history, the WQMIS hierarchy, panchayat locations, samples, the dashboard. After
   that the schedules keep it current. Lab reports trickle in hourly.
6. **Check:**
   - `https://<url>/api/health` returns 200;
   - in **Actions**, each workflow's **Run workflow** button completes green;
   - the site's freshness ledger shows each source as "Working".

## Getting the simulated alerts

On the site, under **Get email alerts**, press **Use the simulation test point** (or type "testing" in the
place search), enter your email, press **Send confirmation email** and click the link in the email. The
simulator workflow runs every 5 minutes and fires about half the time, so expect roughly one simulated
alert every 10 minutes (more spaced out when GitHub's scheduler is busy). Urgent ones always send; the
mailer workflow delivers within about 5 minutes. Each email carries a one-click unsubscribe link.

## Things to know

- **The Render free allowance is 750 instance-hours a month.** Keepalive keeps `downstream-web` up around
  the clock, about 720–744 hours. That's fine while it's the only free web service in the Render
  workspace; a second one would compete for the same hours.
- **GitHub's scheduler is best effort.** Five-minute schedules are often delayed, sometimes by tens of
  minutes, and occasionally skipped when GitHub is busy. Data jobs tolerate that. Alerts may arrive later
  than they would from an always-on worker.
- **GitHub's terms.** Actions is meant for building and testing software. Using it to run a service's
  scheduled jobs is a grey area of its terms: light use is commonly tolerated, but GitHub can disable
  workflows it considers abusive. If that happens, the same `run-once.js` jobs can run from any free cron
  host, or from this PC's Task Scheduler, against the same `DATABASE_URL`.
- **Database expiry.** The free Postgres instance is deleted 30 days after creation. Upgrading its plan
  keeps the data; no code change is needed.
- **Reachability.** GitHub's runners are in the US. On 23 Oct 2026, WQMIS loaded normally from outside
  India; CPCB's certificate check was rejected by one fetcher only because of the revoked certificate
  noted in docs/SOURCES.md, which Node doesn't check. If the `cpcb` workflow ever fails with timeouts or
  403s, CPCB has started refusing foreign IPs.
- **Gmail limits.** Personal Gmail allows about 500 messages a day. Many subscribers at the test point can
  reach it, and Gmail then pauses sending for up to a day.

## Deployed

| Item | Value |
|---|---|
| Live URL | (not deployed yet) |
| Region | singapore |
| SMTP provider | Gmail SMTP (`smtp.gmail.com:465`, app password); login verified and a real confirmation email delivered on 23 Oct 2026 |
| Render services | `downstream-web` (free), `downstream-db` (free) |
| Scheduled jobs | GitHub Actions, public repository (free) |
