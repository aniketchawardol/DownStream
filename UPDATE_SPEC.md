# Update spec: move all scheduled jobs off the paid Render worker, onto free GitHub Actions

## Context

The app was already built end-to-end against `BUILD_SPEC.md`, which put every scheduled job (CPCB ingest, WQMIS crawl, alert engine, mailer, simulator, etc.) inside a single always-on `last-tested-worker` Render Background Worker. Render has no free tier for background workers, so that service is the only thing in the whole stack costing money — everything else (`last-tested-web`, `last-tested-db`) is already on Render's free plan.

This update removes that one paid service. **Job logic does not change at all.** Only *how* each job gets invoked changes: instead of one process looping forever with `node-cron`, GitHub Actions calls each job once, on a schedule, for free. A second, new workflow takes over the job the paid worker was incidentally also doing: keeping the free web service from cold-starting on every visit.

Net result: the whole deployment costs **$0/month**.

Do this work as a focused patch on top of the existing repo — don't restructure anything beyond what's listed below.

---

## Part 1 — One-shot entrypoints for existing jobs

Each job already lives in `services/worker/jobs/*.js`. If a job isn't already shaped as an exported `async function run() {...}` with no reliance on being inside a long-lived process (no module-level state that persists across calls, no assumption that `node-cron` is scheduling it), refactor it minimally so it is. This is the only change job logic itself may need, and only if it isn't already written this way.

Add a thin dispatcher that runs one named job and exits:

```js
// services/worker/run-once.js
const jobName = process.argv[2];
if (!jobName) {
  console.error('usage: node services/worker/run-once.js <job-name>');
  process.exit(1);
}
const { run } = await import(`./jobs/${jobName}.js`);
await run();
process.exit(0);
```

Verify each job name matches a file in `services/worker/jobs/`: `cpcb`, `wqmis-hierarchy`, `wqmis-samples`, `wqmis-dashboard`, `geocode`, `overdue`, `digest`, `mailer`, `simulator` (adjust to whatever the actual filenames are in the built repo).

Leave `services/worker/index.js` and the local Docker Compose `worker` container exactly as they are — they still run `node-cron` in a loop for local development, where it costs nothing and is more convenient to watch run. Only the production path changes.

---

## Part 2 — Adjust two cadences

GitHub Actions' minimum schedule interval is 5 minutes, not 1. Two jobs assumed sub-5-minute scheduling:

- **`mailer`**: change from every 1 minute to every 5 minutes. This only changes how promptly a *batched* email goes out — it does not change alert detection latency, and urgent alerts should still bypass batching entirely if that logic already exists.
- **`simulator`**: change from "random every 2–5 minutes" to a fixed 5-minute schedule, with the job itself rolling a coin (~50% chance) on whether to actually create an alert that run, so the demo still feels sporadic rather than metronomic.

---

## Part 3 — GitHub Actions workflows

Add `.github/workflows/`, one file per job. Example for the most frequent one:

```yaml
# .github/workflows/cpcb.yml
name: cpcb ingest
on:
  schedule: [{ cron: '*/15 * * * *' }]
  workflow_dispatch: {}
concurrency: { group: cpcb, cancel-in-progress: false }
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci --omit=dev
      - run: node services/worker/run-once.js cpcb
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          CONTACT_EMAIL: ${{ secrets.CONTACT_EMAIL }}
          CPCB_URL: ${{ secrets.CPCB_URL }}
```

Repeat the same shape for the rest, changing only the job name, the cron schedule, and which env vars that specific job needs:

| Workflow file | Job name | Schedule (UTC) | Needs |
|---|---|---|---|
| `cpcb.yml` | `cpcb` | `*/15 * * * *` | `DATABASE_URL`, `CONTACT_EMAIL`, `CPCB_URL` |
| `wqmis-hierarchy.yml` | `wqmis-hierarchy` | `0 1 * * 0` (weekly, Sun) | `DATABASE_URL`, `CONTACT_EMAIL`, `WQMIS_STATES`, `WQMIS_DISTRICTS` |
| `wqmis-samples.yml` | `wqmis-samples` | `0 2 * * *` (daily) | same as above |
| `wqmis-dashboard.yml` | `wqmis-dashboard` | `0 10 * * *` (daily) | `DATABASE_URL`, `CONTACT_EMAIL` |
| `geocode.yml` | `geocode` | `0 3 * * 0` (weekly, after hierarchy) | `DATABASE_URL`, `CONTACT_EMAIL` |
| `overdue.yml` | `overdue` | `0 7 * * *` (daily) | `DATABASE_URL` |
| `digest.yml` | `digest` | `0 8 * * 1` (weekly, Mon) | `DATABASE_URL`, `SMTP_URL`, `EMAIL_FROM` |
| `mailer.yml` | `mailer` | `*/5 * * * *` | `DATABASE_URL`, `SMTP_URL`, `EMAIL_FROM` |
| `simulator.yml` | `simulator` | `*/5 * * * *` | `DATABASE_URL`, `MOCK_EMAIL`, `MOCK_LAT`, `MOCK_LNG` (only meaningful while `MOCK_MODE=true`) |

Every workflow keeps `concurrency` (so a slow run can't overlap the next one) and `timeout-minutes` (so a hung job doesn't burn Actions minutes indefinitely). `workflow_dispatch: {}` on each one is a manual "run now" button in the GitHub UI — useful for testing without waiting for the schedule.

### Heartbeat, so the schedules don't get auto-disabled

GitHub disables scheduled workflows in a repo that's had no commits for 60 days. Add one more workflow that pushes an empty commit monthly, which resets that clock:

```yaml
# .github/workflows/heartbeat.yml
name: heartbeat
on:
  schedule: [{ cron: '0 0 1 * *' }]   # 1st of every month
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          git config user.email "actions@github.com"
          git config user.name "github-actions"
          git commit --allow-empty -m "heartbeat"
          git push
```

---

## Part 4 — Keep the free web service from sleeping

`last-tested-web` is a free Render web service, so Render spins it down after 15 minutes with no inbound traffic, and the next real visitor eats a 30–60 second cold start. None of the jobs above touch the web service — they all talk to Postgres directly — so add one more, dedicated workflow whose only job is pinging it:

```yaml
# .github/workflows/keepalive.yml
name: keep render web awake
on:
  schedule: [{ cron: '*/10 * * * *' }]
  workflow_dispatch: {}
concurrency: { group: keepalive, cancel-in-progress: true }
jobs:
  ping:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - run: curl -fsS --max-time 20 https://last-tested-web.onrender.com/api/health
```

Use 10 minutes, not 15, as the interval. GitHub's scheduler can itself lag by several minutes under load — for the data jobs above, a late run is invisible, but here a ping that slips past the 15-minute mark arrives too late to prevent the cold start it exists to prevent. Ten minutes leaves enough slack to usually land inside the window.

One real limit to know about, not a bug to fix: Render's free workspace shares 750 free instance-hours a month across every free web service in that account. Pinging every 10 minutes keeps `last-tested-web` running close to 24/7 — about 720–744 hours in a month — which is nearly the entire free allowance. That's fine as long as this is the only free web service on the account. If another free web service is ever added to the same Render workspace for a different project, the two will compete for that same pool and one could start getting throttled. Nothing to change now; just worth remembering later.

---

## Part 5 — Secrets and config

In the Render dashboard, open `last-tested-db` → **Connect** → copy the **External** connection string (not the internal one — GitHub's runners aren't on Render's private network, and the external URL already includes the required `?sslmode=require`).

Add these as GitHub repo secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DATABASE_URL` | the External connection string from the Render dashboard |
| `CONTACT_EMAIL` | same value already used locally |
| `CPCB_URL` | same CPCB endpoint already in use |
| `WQMIS_STATES`, `WQMIS_DISTRICTS` | same values already in use |
| `SMTP_URL`, `EMAIL_FROM` | the real SMTP provider credentials already configured on `last-tested-web` |
| `MOCK_EMAIL`, `MOCK_LAT`, `MOCK_LNG` | same mock values already in use |

---

## Part 6 — Remove the paid worker

1. Delete the `last-tested-worker` service block from `render.yaml`.
2. Delete the `last-tested-worker` service in the Render dashboard.
3. Confirm `last-tested-web` and `last-tested-db` are both still on their free plans — nothing else needs to change on them.

---

## Acceptance checks

- ✅ `render.yaml` defines only `last-tested-web` and `last-tested-db`. No service in it is on a paid plan.
- ✅ Render's dashboard shows no `last-tested-worker` service, and the account's billing page shows $0 owed for this project.
- ✅ Manually triggering each workflow (`workflow_dispatch`) in the GitHub Actions tab completes successfully and the expected rows change in Postgres (check via Adminer locally against the same `DATABASE_URL`, or a one-off `psql` session).
- ✅ After leaving the schedules running for a few hours: `cpcb_reading` keeps growing, a subscribed test alert still arrives by email, and the simulator (with `MOCK_MODE=true`) produces at least one `[Simulated]` alert.
- ✅ Visiting `https://last-tested-web.onrender.com` responds immediately (no multi-second cold start) at a time more than 15 minutes after the last real visitor — proof the keepalive workflow is doing its job.
- ✅ The GitHub Actions tab shows `heartbeat` has a scheduled future run (not greyed out as disabled).
