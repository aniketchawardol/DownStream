// @ts-check
// Hourly: polite drip of lab-report fetches while a backlog exists (contaminated samples first).
// The logic lives with the sample crawl in ./wqmis-samples.js; this file is its one-shot entrypoint.
import { reportsJob } from './wqmis-samples.js';
import { oneShot } from '../lib/one-shot.js';

/** One-shot entrypoint (services/worker/run-once.js, used by GitHub Actions). */
export async function run() {
  return oneShot((sql) => reportsJob(sql));
}
