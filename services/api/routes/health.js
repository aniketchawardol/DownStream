// @ts-check
// GET /api/health: fast enough for Render's continuous health checks. The DB read is cached for 5 s.

const CACHE_MS = 5_000;

/** @param {import('fastify').FastifyInstance} app @param {{ sql: import('@lt/core/db.js').Sql, config: typeof import('@lt/core/config.js').config }} opts */
export default async function health(app, { sql, config }) {
  /** @type {{ at: number, body: any } | null} */
  let cache = null;
  /** @type {Promise<any> | null} */
  let inflight = null;

  async function check() {
    const now = Date.now();
    try {
      const rows = await sql`
        select source, last_attempt_at, last_success_at, last_error, records_last_run,
               newest_data_at, consecutive_failures, circuit_open_until
        from source_health order by source`;
      return {
        ok: true,
        db: 'up',
        mock_mode: config.mockMode,
        checked_at: new Date(now).toISOString(),
        sources: rows.map((r) => ({
          ...r,
          data_age_seconds: r.newest_data_at ? Math.round((now - r.newest_data_at.getTime()) / 1000) : null,
          circuit_open: !!(r.circuit_open_until && r.circuit_open_until.getTime() > now),
        })),
      };
    } catch (err) {
      return { ok: true, db: 'down', error: String(/** @type {Error} */ (err).message), mock_mode: config.mockMode, checked_at: new Date(now).toISOString(), sources: [] };
    }
  }

  app.get('/health', async (_req, reply) => {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      inflight ??= check().then((body) => { cache = { at: Date.now(), body }; return body; }).finally(() => { inflight = null; });
      await inflight;
    }
    reply.header('cache-control', 'no-store');
    return cache?.body;
  });
}
