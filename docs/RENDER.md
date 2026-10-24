# Deploying DownStream for free (Render + GitHub Actions)

**Status: not deployed yet.** Everything in the repo is ready; the steps need your GitHub and Render logins.
When it's live, fill in the "Deployed" table at the end.

## How it runs, and why it costs nothing

| Piece | Where | Plan | Role |
|---|---|---|---|
| `downstream-web` | Render web service (Docker, `services/api/Dockerfile`) | free | Serves the site and `/api/*`, runs migrations at boot, and (`WEB_JOBS=true`) runs the frequent jobs in-process: the mailer every minute, the simulator, CPCB every 15 minutes, a self keepalive |
| Email relay | Google Apps Script web app (`scripts/gmail-relay.gs`) on the sending Gmail account | free | Sends mail over HTTPS, because Render's free plan blocks SMTP ports |
| `downstream-db` | Render Postgres | free (deleted 30 days after creation) | All data. PostGIS and citext are enabled by the first migration |
| Long jobs | GitHub Actions (`.github/workflows/`) | free in a **public** repository | The WQMIS crawls, geocoding, digest and a backup wake-up, each with `node services/worker/run-once.js <job>` against the database's external URL |

There's no background worker on Render: Render has no free plan for workers. Locally, `docker compose up`
still runs every job in one `worker` container with node-cron, unchanged.

**The GitHub repository must be public.** The schedules below use about 25,000 runner-minutes a month,
because every run bills at least a minute. Standard runners are free and unlimited for public repositories.
Private repositories get 2,000 free minutes a month, after which the workflows stop. Public is safe here:
no credentials are in the code, `.env` files are gitignored, and secrets live in GitHub's encrypted
Actions secrets.

| Workflow | Job | Schedule | Notes |
|---|---|---|---|
| `tick.yml` | keepalive + `mailer` | every 10 minutes | Backup only: wakes the site if it slept, then sends anything pending. The web service does this work itself |
| `wqmis-hierarchy.yml` | `wqmis-hierarchy` | Sunday 01:00 IST | Districts, blocks, panchayats, villages |
| `geocode.yml` | `geocode` | Sunday 03:00 IST | OpenStreetMap locations for panchayats |
| `wqmis-samples.yml` | `wqmis-samples` | daily 02:00 IST | New lab samples, tap alerts |
| `wqmis-reports.yml` | `wqmis-reports` | hourly | Lab reports, 500 a run, only while a backlog exists |
| `wqmis-dashboard.yml` | `wqmis-dashboard` | daily 10:00 IST | National "yesterday" figures |
| `overdue.yml` | `overdue` | daily 07:00 IST | Panchayats overdue for testing |
| `digest.yml` | `digest` | Monday 08:00 IST | Weekly summary emails |
| `bootstrap.yml` | `bootstrap` | manual | Fills an empty database: run once after the first deploy |
| `heartbeat.yml` | (git) | 1st of each month | Empty commit; GitHub disables schedules after 60 days without activity |

Crons in the files are UTC; the comments give the IST times they correspond to.

**Why the frequent jobs run in the web service.** The first version ran the mailer, simulator, keepalive
and CPCB as separate 5–15 minute GitHub schedules: about 700 runs a day. GitHub's scheduler quietly dropped
most of them, so river data went stale, the site slept and alert emails waited hours. Hourly and daily
workflows were unaffected, so those stay on GitHub.

**Why mail goes through a relay.** Since September 2025 Render's free plan blocks outbound SMTP ports
(25, 465, 587), so the web service can't reach `smtp.gmail.com`. HTTPS isn't blocked. The site POSTs each
email to a small Google Apps Script web app running on the Gmail account, and Gmail sends it from that
address. Confirmation emails go out while the subscribe request is still open, and alert emails within a
minute. Without a relay the site falls back to queueing confirmations for the GitHub `tick` mailer, which
is slow and unreliable.

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
4. **Set up the email relay** (about 5 minutes, signed in to Google as the sending account,
   gazebot.alert@gmail.com):
   1. Open https://script.google.com and create a **New project**. Replace `Code.gs` with
      `scripts/gmail-relay.gs` from this repository, then save.
   2. **Project Settings** (gear icon) > **Script Properties** > **Add script property**: `SECRET` = a long
      random string (for example from `node -e "console.log(crypto.randomUUID())"`).
   3. **Deploy > New deployment** > select type **Web app**. Set *Execute as* to **Me** and *Who has access* to
      **Anyone**, then press **Deploy**. Approve the permission to send email as you. Google warns the app is
      unverified, because it's your own script: choose **Advanced > Go to project**.
   4. Copy the **Web app URL** (`https://script.google.com/macros/s/…/exec`). Opening it in a browser should
      show `{"ok":true,"service":"DownStream email relay",…}`.
   5. On Render, open **downstream-web > Environment** and set `EMAIL_RELAY_URL` to that URL and
      `EMAIL_RELAY_SECRET` to the same secret. Check that `WEB_JOBS` is `true`. Save; Render redeploys.

   The service log then shows `web jobs started … "mailer":true`. If you change the script later, use
   **Deploy > Manage deployments > edit > Version: New version**, or the URL keeps serving the old code.
5. **Add the GitHub secrets:** in the repository, **Settings > Secrets and variables > Actions > New
   repository secret**.

   | Secret | Value | Needed |
   |---|---|---|
   | `DATABASE_URL` | Render > `downstream-db` > **Connect** > **External** connection string. GitHub's runners aren't on Render's private network | yes |
   | `SMTP_URL` | same as on Render | yes |
   | `EMAIL_FROM` | `DownStream <gazebot.alert@gmail.com>` | yes |
   | `CONTACT_EMAIL` | `gazebot.alert@gmail.com` | yes |
   | `PUBLIC_BASE_URL` | the site's URL. Used in email links and by the `tick` wake-up | yes |
   | `CPCB_URL`, `WQMIS_STATES`, `WQMIS_DISTRICTS`, `MOCK_LAT`, `MOCK_LNG`, `MOCK_MODE` | only to change the defaults (CPCB layer 10; Karnataka 15; Bagalkote 187; 16.18, 75.70; `true`) | no |
   | `MOCK_EMAIL` | an address to pre-subscribe at the simulation point. Usually leave unset and subscribe from the site | no |

   The external URL is a `*.render.com` host; the jobs connect to it over TLS automatically.
6. **Fill the database:** **Actions > "bootstrap (fill an empty database)" > Run workflow.** It loads CPCB
   with history, the WQMIS hierarchy, panchayat locations, samples and the dashboard. From GitHub's US
   runners WQMIS is about 10× slower than from India (around 20 minutes per block, so 3–4 hours for
   Bagalkote's 9 blocks). The run has a time budget and stops cleanly before GitHub's limit, saving its
   place. If its log ends with `samples_incomplete`, run it again and it continues from where it
   stopped. After that the schedules keep the data current; daily runs only re-read panchayats whose
   test counts changed. Lab reports trickle in hourly.
7. **Check:**
   - `https://<url>/api/health` returns 200;
   - in **Actions**, each workflow's **Run workflow** button completes green;
   - the site's freshness ledger shows each source as "Working".

## Getting the simulated alerts

On the site, under **Get email alerts**, press **Use the simulation test point** (or search "testing"),
enter your email and press **Send confirmation email**. With the relay set up, the confirmation is sent
before the page answers, and usually lands within a few seconds. Click its link.

From then on the web service invents one simulated alert every 2–5 minutes (`MOCK_INTERVAL_MIN`..`MAX`);
every run fires, there's no coin flip. Alerts created before you clicked the link are never emailed.
Delivery follows the spec's anti-spam rules:

- **Urgent** alerts (contamination, a river reading past its limit) are emailed within a minute, always.
- **Notice** alerts are bundled: at most one email per 15 minutes, and at most `MAX_EMAILS_PER_DAY` (6) a
  day per address. Past the cap they go into the weekly summary.

Each email ends with an unsubscribe link. Mail sent through the relay has no `List-Unsubscribe` header,
because Apps Script can't set custom headers.

## Things to know

- **The Render free allowance is 750 instance-hours a month.** The service pings its own public URL every 10
  minutes (and the `tick` workflow pings it too), so `downstream-web` stays up around the clock, about
  720–744 hours. That's fine while it's the only free web service in the Render
  workspace; a second one would compete for the same hours.
- **GitHub's scheduler is best effort.** Frequent schedules are often delayed or skipped, which is why the
  mailer and simulator moved into the web service. The daily and weekly crawls tolerate delays. If the site
  ever does fall asleep, a free uptime pinger (cron-job.org, UptimeRobot) on `/api/health` every 5 minutes
  is a sturdier wake-up than GitHub.
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
- **Gmail limits.** Through Apps Script, a personal Gmail account can email about 100 recipients a day
  (`https://<relay url>` in a browser shows what's left). Each confirmation and each alert email counts.
  Past the limit the relay returns an error, and the mailer retries up to 5 times before giving up on that
  email.

## Deployed

| Item | Value |
|---|---|
| Live URL | (not deployed yet) |
| Region | singapore |
| Email | Gmail through the Apps Script relay on Render (SMTP ports are blocked there); Gmail SMTP (`smtp.gmail.com:465`, app password) locally and from GitHub Actions |
| Render services | `downstream-web` (free), `downstream-db` (free) |
| Scheduled jobs | GitHub Actions, public repository (free) |
