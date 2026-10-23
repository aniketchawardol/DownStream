// @ts-check
// WQMIS client: one cookie-jar session per crawl, the anti-forgery token on dropdown POSTs, AES-encrypted
// parameters, and polite pacing via politeFetch. Re-establishes the session once on an error redirect / 500.
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { fetch as undiciFetch } from 'undici';
import { enc, encq } from '@lt/core/aes.js';
import { config } from '@lt/core/config.js';
import { logger } from '@lt/core/log.js';
import { parseDropdown } from '@lt/core/parsers/wqmis-dropdown.js';
import { parseSampleListJson } from '@lt/core/parsers/wqmis-samplelist.js';
import { parseCounts } from '@lt/core/parsers/wqmis-counts.js';
import { parseMainDashboard, parseStateDashboard } from '@lt/core/parsers/wqmis-dashboard.js';
import { politeFetch, archiveRaw, HttpError } from './http.js';
import { SchemaError } from './source.js';

const log = logger('wqmis');
const FORM = 'application/x-www-form-urlencoded; charset=UTF-8';

/** The response WQMIS gives a request without a usable session. @param {any} j */
export const isBlankEnvelope = (j) => !!j && typeof j === 'object' && j.Labtestingdata == null && !j.FinancialYear && !Number(j.StateId);

export class WqmisClient {
  /** @param {{ base?: string, archive?: boolean }} [opts] */
  constructor(opts = {}) {
    this.base = opts.base ?? config.wqmisBase;
    this.archive = opts.archive ?? true;
    /** @type {string|null} */ this.token = null;
    /** @type {any} */ this.fetchImpl = null;
  }

  async session() {
    const jar = new CookieJar();
    this.fetchImpl = makeFetchCookie(/** @type {any} */ (undiciFetch), jar);
    const res = await politeFetch(`${this.base}/Report/Report_L`, { fetchImpl: this.fetchImpl, accept: 'text/html' });
    const token = res.text.match(/__RequestVerificationToken[^>]*?value="([^"]+)"/)?.[1];
    if (!token) throw new SchemaError('Report_L page has no __RequestVerificationToken');
    this.token = token;
    log.info('session established');
  }

  /**
   * @param {'GET'|'POST'} method @param {string} path @param {Record<string, string>|null} form
   * @param {{ token?: boolean, accept?: string, timeoutMs?: number, archiveAs?: string }} [opts]
   */
  async request(method, path, form, opts = {}) {
    if (!this.fetchImpl) await this.session();
    for (let attempt = 1; ; attempt++) {
      try {
        /** @type {Record<string, string>} */
        const headers = { 'X-Requested-With': 'XMLHttpRequest', Referer: `${this.base}/Report/Report_L` };
        let body;
        if (method === 'POST') {
          headers['Content-Type'] = FORM;
          const fields = { ...(form || {}) };
          if (opts.token) { fields.__RequestVerificationToken = /** @type {string} */ (this.token); headers.RequestVerificationToken = /** @type {string} */ (this.token); }
          body = new URLSearchParams(fields).toString();
        }
        const res = await politeFetch(`${this.base}/${path}`, { method, headers, body, fetchImpl: this.fetchImpl, accept: opts.accept, timeoutMs: opts.timeoutMs ?? 90_000 });
        if (/\/Error(\/|$)/i.test(res.url)) throw new HttpError('redirected to the WQMIS error page (session expired?)', 302);
        if (this.archive && opts.archiveAs) await archiveRaw('wqmis', opts.archiveAs, res.text);
        return res.text;
      } catch (err) {
        const status = /** @type {any} */ (err).status;
        if (attempt >= 2 || !(status === 302 || status >= 500)) throw err;
        log.warn('re-establishing session after error', { path: path.split('?')[0], status });
        await this.session();
      }
    }
  }

  /** @param {string} path @param {Record<string, string>} form */
  async postJson(path, form, opts = {}) {
    const text = await this.request('POST', path, form, { ...opts, accept: 'application/json' });
    try { return JSON.parse(text); } catch { throw new SchemaError(`${path} did not return JSON`); }
  }

  /** @param {number} st */
  async districts(st) {
    return parseDropdown(await this.postJson('Common/District_Bind_without_session', { state_id: enc(st) }, { token: true, archiveAs: `districts-${st}.json` }), 'district');
  }

  /** @param {number} st @param {string} dt */
  async blocks(st, dt) {
    return parseDropdown(await this.postJson('Common/Block_Bind_without_session/', { state_id: enc(st), District_id: enc(dt) }, { token: true, archiveAs: `blocks-${dt}.json` }), 'block');
  }

  /** @param {number} st @param {string} dt @param {string} bl */
  async gps(st, dt, bl) {
    return parseDropdown(await this.postJson('Common/GetGramPanchayat_Bind_without_session/', { state_id: enc(st), District_id: enc(dt), Block_id: enc(bl) }, { token: true, archiveAs: `gps-${bl}.json` }), 'gp');
  }

  /** @param {number} st @param {string} dt @param {string} bl @param {string} gp */
  async villages(st, dt, bl, gp) {
    return parseDropdown(await this.postJson('Common/GetVillage_Bind_without_session/', { state_id: enc(st), District_id: enc(dt), Block_id: enc(bl), Grampanchayat_id: enc(gp) }, { token: true }), 'village');
  }

  /** Per-GP counts for every GP in a block (siblings of the given GP). @param {{ fy: string, st: number, dt: string, bl: string, gp: string }} p */
  async gpCounts(p) {
    const text = await this.request('GET', `Report/Labtestingdata?fy=${encq(p.fy)}&stid=${encq(p.st)}&dtid=${encq(p.dt)}&blid=${encq(p.bl)}&gpid=${encq(p.gp)}&viid=${encq(0)}`, null, { accept: 'text/html', timeoutMs: 120_000, archiveAs: `counts-${p.bl}-${p.fy}.html` });
    return parseCounts(text);
  }

  /**
   * Every tested sample (currentstatus 3) for one GP and FY, across pages.
   * @param {{ fy: string, st: number, dt: string, bl: string, gp: string, cs?: number }} p
   */
  async sampleList(p) {
    /** @type {import('@lt/core/parsers/wqmis-samplelist.js').SampleRow[]} */
    const rows = [];
    /** @type {string[]} */
    const warnings = [];
    for (let page = 1, total = 1; page <= total && page <= 200; page++) {
      const form = { cpage: enc(page), currentstatus: enc(p.cs ?? 3), stid: enc(p.st), dtid: enc(p.dt), blid: enc(p.bl), gpid: enc(p.gp), villid: enc(0), fy: enc(p.fy) };
      let json = await this.postJson('Report/labtestingsamplelist_fil/', form, { archiveAs: `samples-${p.gp}-${p.fy}-p${page}.json`, timeoutMs: 120_000 });
      // A lost session doesn't error: WQMIS answers with a blank envelope that echoes none of the request
      // (FinancialYear null, StateId 0). A genuinely empty list echoes the FY and IDs. Re-establish and retry.
      for (let retry = 0; isBlankEnvelope(json) && retry < 2; retry++) {
        log.warn('blank sample-list envelope; re-establishing the session', { gp: p.gp, fy: p.fy, retry });
        await new Promise((r) => setTimeout(r, 5000 * (retry + 1)));
        await this.session();
        json = await this.postJson('Report/labtestingsamplelist_fil/', form, { archiveAs: `samples-${p.gp}-${p.fy}-p${page}-retry${retry}.json`, timeoutMs: 120_000 });
      }
      if (isBlankEnvelope(json)) throw new SchemaError(`WQMIS kept returning a blank sample-list envelope for GP ${p.gp} (session lost)`);
      const parsed = parseSampleListJson(json);
      warnings.push(...parsed.warnings);
      rows.push(...parsed.rows);
      total = parsed.totalPages || 1;
    }
    return { rows, warnings };
  }

  /** @param {string} digits the part of the sample ID after "S" */
  async report(digits) {
    return this.request('GET', `Common/final_report_print?s_id=${encq(digits)}`, null, { accept: 'text/html', archiveAs: `report-${digits}.html` });
  }

  async dashboards() {
    const main = parseMainDashboard(await this.postJson('Main/GetMainDashboard', {}, { archiveAs: 'dashboard-main.json' }));
    const states = parseStateDashboard(await this.postJson('Main/GetMainDashboard_samples_tested_laboratories', {}, { archiveAs: 'dashboard-states.json' }));
    return { main, states };
  }
}
