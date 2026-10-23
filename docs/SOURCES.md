# Data sources — confirmed behaviour

Probed live on **23 Oct 2026** from an Indian residential IP by `scripts/probe/probe-cpcb.mjs` and
`scripts/probe/probe-wqmis.mjs` (Node built-ins only; ≥600 ms between requests per host, one in flight,
User-Agent `DownStream/0.1 (...; +contact: <CONTACT_EMAIL>)`). Raw responses are in `fixtures/`; every
parser test runs against those files, never the network.

## What changed from BUILD_SPEC.md section 2

| Spec said | Confirmed |
|---|---|
| CPCB TLS: `curl -k` needed | Node verifies the chain fine (`node:22-slim` too). curl on Windows fails because Schannel checks revocation: the leaf `*.cpcb.gov.in` cert was **revoked (reason "superseded") on 19 Oct 2026** per eMudhra OCSP, but the server still serves it. Node/OpenSSL do no revocation check, so `CPCB_INSECURE_TLS=false` works. Keep the flag as a fallback only. |
| CPCB has no history endpoint (UNVERIFIED KISTERS files) | **History exists.** `stations/<site_no>/<station_no>/<param>/week.json` = hourly values for the last ~7 days; `.../year.json` = **daily means since Dec 2021** (+ aggregation accuracy %). Use week.json to backfill 7 days. |
| Villages: method UNVERIFIED | `POST Common/GetVillage_Bind_without_session/` + token. Works. |
| Sample-list columns UNVERIFIED | 15 columns, **parameter values are inline in the list** (see parser notes). |
| `currentstatus` meaning UNVERIFIED | Full code table below; `3` = tested in lab. |
| Sample IDs from "decrypting s_id links" | **There are no s_id links** in the sample list. Sample ID is `U<submitter>S<digits>`; the report's `s_id` is `enc(<digits>)`. |
| Report 19365256 returns HTTP 500 | It returns a full report **when the request carries the session cookie**. Without `ASP.NET_SessionId` every report returns 500 ("Object reference not set…"). That was the cause. |
| Dashboard methods UNVERIFIED | Both are `POST` with empty body; no token or cookie needed. `GET` → 404. |
| One sample list per GP | Also works per block (`gpid=enc(0)`) and per district (`blid=enc(0)&gpid=enc(0)`), but those are **paged 50 rows/page** and slow (~10–19 s per page server-side). Per-GP pages are fast (~1.3 s) and rarely exceed 50 rows. |
| Crawl size unknown | Bagalkote (187): **9 blocks, 196 GPs**. Karnataka: 31 districts. |

---

## 1. CPCB real-time water quality (KISTERS web-portal static export)

Host `https://rtwqmsdb1.cpcb.gov.in`. Everything is anonymous `GET` of static JSON. Directory listings are 403.
The portal SPA (`/assets/page-index-*.js`) only ever fetches `layers/10/index.json` (every 60 s) and
`stations/stations.json`; it draws no charts. Its config also names a KiWIS proxy
(`https://proxy.wiski-web.de/ds-kiwis/KiWIS/KiWIS`), which is a KISTERS-hosted demo endpoint and returned nothing
for CPCB ts_ids; **do not use it**.

### 1.1 `GET /data/internet/layers/10/index.json?t=<epoch ms>` — latest values
- JSON array, **468 objects, 40 stations**, ~485 KB. One object per station × parameter, latest value only.
- Keys (23): `ts_id, timestamp, req_timestamp, ts_value, station_latitude, station_longitude, ts_name,
  stationparameter_longname, ts_shortname, station_id, station_no, station_name, station_longname, ts_unitsymbol,
  stationparameter_name, stationparameter_no, site_no, catchment_name, territory_name, ObjectDescription,
  station_diary_status, station_status_remark, MAX_RANGE`.
- `timestamp`: ISO UTC, always at `:30` (= on the hour IST). All parameters of one station share one timestamp.
- `ts_value`: always a JSON number in this capture (no blanks/strings) — still guard for `null`/strings.
- `station_latitude/longitude`: numbers here (strings in stations.json).
- `station_name`: prefixed with the station number: `"UT67_Kheerveer Bridge,Kishundaspur Road,Pratapgarh"` → strip `^<no>_`.
- `territory_name`: Uttar Pradesh, Uttarakhand, Bihar, West Bengal, Jharkhand, Haryana.
- `site_no` always `DSP_SWAN`; `catchment_name` always `---`; `req_timestamp` always `null`; `ts_name` always
  `DSP.Cmd.Production` / `ts_shortname` `DSP.Cmd.P`; `MAX_RANGE` is `''`, `'500.0'` or `'1500.0'` (sensor range).
- Parameters (`stationparameter_name` = `stationparameter_no`): pH (40, unit `---`), WT °C (40), BOD mg/l (40),
  DO mg/l (40), COD mg/l (40), TOC mg/l (40), Nitrate mg/l (40), EC "mS/cm" (40), WTb NTU (40), CL mg/l (36),
  Depth m (36), S m (36). 4 stations lack CL/Depth/S.
- Value ranges seen: pH 7.08–10.91, DO 2.22–9.21, BOD 0.5–10.93, COD 5–38, TOC 1–19, Nitrate 0.3–8, CL 5–200,
  EC 1–982, WTb 1.6–423, WT 15–31, Depth 0.33–3.98, S 12–641.
- **Unit quirk:** EC is labelled `mS/cm`, but values of 1–982 are only plausible as **µS/cm** (the portal's own
  display config formats `uS/cm`). Store the source unit and display µS/cm with a note.
- **Floor values:** CL and COD bottom out at exactly 5, TOC at 1, Nitrate at 0.3, EC at 1. These look like
  instrument floors / detection limits. Don't treat them as measurements for spike detection.
- **Staleness at probe time:** 38/40 stations had a reading within ~2 h. Stale: **BH75 (320 h ≈ 13 days)** and
  **WB90 (1231 h ≈ 51 days)**. This matches the spec.

`station_diary_status` (≤ 3.6 KB) is `<br>`-separated entries:
```
2023-11-05 15:00:00: FM Start: Technical issue<br>2024-10-20 16:00:00: FM End: Technical issue<br>...
```
Regex per entry: `/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): FM (Start|End): (.+)$/`. "FM" = force majeure.
Reasons seen: `Technical issue`, `Low water`, `Flood event`, `Vandalism`, `Reason` (literal placeholder).
Timestamps carry no zone; assume IST. Pair Start/End entries into outage intervals. A trailing Start means an ongoing outage.

`station_status_remark` is an internal code (e.g. `SDGAN-301`). It is not useful.

### 1.2 `GET /data/internet/stations/stations.json` — station metadata
40 objects: `station_id, station_no, station_name, site_no, site_name ("DSP SWAN"), station_latitude,
station_longitude (strings), object_type, catchment_name, territory_name, ObjectDescription, station_status_remark,
station_diary_status`. `object_type` is `General;Fixed Station;Force Majeure;Swan` or
`General;Floating Station;Force Majeure;Swan`. Distinguishing floating stations is useful UI copy.

### 1.3 History: `GET /data/internet/stations/<site_no>/<station_no>/<stationparameter_no>/<period>.json`
- Example: `/data/internet/stations/DSP_SWAN/UT67/DO/week.json`.
- `week.json`: array with **one** object: `station_name, station_no, stationparameter_name,
  stationparameter_longname, ts_name, ts_shortname, ts_unitsymbol, ts_precision ("DECI,2,0,0"), BODY_RESPONSIBLE,
  station_elevation, CATCHMENT_SIZE, WTO_OBJECT, ObjectDescription, rows ("152", a string), columns
  ("Timestamp,Value"), data: [["2026-10-17T00:30:00.000Z", 6.76], ...]`. **Hourly** (all steps 60 min), ~6.3 days,
  `null` values for gaps, and the last slot is often a `null` placeholder for the current hour. A stale station
  (WB90) returns `rows: "0", data: []`.
- `year.json`: same envelope, `columns: "Timestamp,Value,Aggregation Accuracy %"`, **daily** values (step 1440
  min) from **2021-12-21 to the day before yesterday** (1,766 rows, ~212 KB per series). Rows can have `null` values.
- 404: `day.json`, `month.json`, `complete.json`, `latest.json`; any path with `ts_shortname`.
- Backfill cost: 40 stations × 12 params = 480 week files ≈ 4–5 min at 600 ms. Do it once, then rely on 15-min polling.

### 1.4 Other layers
- `layers/20/index.json`: 441 objects, "Qualified Hours" per station × parameter per day (`ts_unitsymbol: "h"`,
  `ts_shortname` like `BOD.QH.Day.Total`). This is how many hours of the day passed QA. Optional data-quality signal.
- `layers/21/index.json`: 40 objects, "Station Coverage" % (`h.Total`). Timestamps can be very old (BH75: 2023).
- `layers/{1,2,9,11,12,30}` → 404.

---

## 2. JJM WQMIS (`https://ejalshakti.gov.in/WQMIS`)

ASP.NET MVC. Public reports, no login, no CAPTCHA. Use one cookie jar per crawl session.

### 2.1 Session and anti-forgery token — **required**
`GET Report/Report_L` sets cookies `ASP.NET_SessionId` and `__RequestVerificationToken_L1dRTUlT0`, and the page
contains `<input name="__RequestVerificationToken" ... value="...">` (regex from the spec works).

| Endpoint group | Needs session cookie | Needs token |
|---|---|---|
| `Common/*_Bind*` dropdowns (POST) | yes (anti-forgery cookie) | **yes**, as form field. Without it: HTTP 500 "The required anti-forgery form field…" |
| `Report/labtestingsamplelist` (GET) | **yes**. Without it: 302 to error | no |
| `Report/labtestingsamplelist_fil/` (POST) | **yes**. Without it: empty JSON envelope | no |
| `Report/Labtestingdata` (GET) | **yes**. Without it: 302 | no |
| `Common/final_report_print` (GET) | **yes**. Without it: HTTP 500 "Object reference not set…" | no |
| `Main/GetMainDashboard*` (POST) | no | no |

Sending the token as both form field and `RequestVerificationToken` header (as the spec says) is harmless. One session
served a whole probe run (~40 requests over ~2 min). Expiry time was not measured. Re-fetch `Report_L` on any 302/500 and retry once.

### 2.2 AES parameter encryption
AES-128-CBC, key = IV = ASCII `8080808080808080`, PKCS7, base64 (site's `/WQMIS/Scripts/aes.js`, called as
`enCriptedAES(v)` in page JS). Spec vectors verified: `enc('15') === 'n4y3XImHOT34OR3rSpPhoQ=='`,
`enc('19365256') === 'wTFPbUYrtkpKCPa8pkatkA=='`. Other handy values: `enc('2025-2026') = 'ni369euDLLUKADXqJfCMlA=='`,
`enc('0') = 'rVJO3lG/mOFqgnBQKfD4WA=='`, `enc('187') = 'n0aEfYhRFcsQq4GHwMv0ag=='`. Always `encodeURIComponent`
in query strings. `URLSearchParams` handles form bodies.

### 2.3 Hierarchy dropdowns — all `POST`, `application/x-www-form-urlencoded`, token in form

| Level | Path | Form fields (all `enc()` except token) | Item ID / name | Placeholder |
|---|---|---|---|---|
| Districts | `Common/District_Bind_without_session` | `state_id` | `JJM_DistrictId` (string) / `DistrictName` | ID `" "` (a space) |
| Blocks | `Common/Block_Bind_without_session/` | `state_id`, `District_id` | `JJM_BlockId` (string) / `BlockName` | ID `""` |
| GPs | `Common/GetGramPanchayat_Bind_without_session/` | `state_id`, `District_id`, `Block_id` | `JJM_PanchayatId` (string) / `PanchayatName` | ID `""` |
| Villages | `Common/GetVillage_Bind_without_session/` | `state_id`, `District_id`, `Block_id`, `Grampanchayat_id` | `JJM_VillageId` (**number**) / `VillageName`, plus `Flag` (1) | ID `0` |

The spec's names `Common/Block_Bind` and `Common/GetGramPanchayat_Bind` also work and return identical JSON. The
page itself uses the `_without_session` variants, so use those. Note the capitalisation: `District_id`, `Block_id`,
`Grampanchayat_id`. Filter placeholders with `!id || !String(id).trim() || String(id) === '0'`.
Responses are `application/json` (content-type header duplicated: `application/json; charset=utf-8,charset=utf-8`).
Names have inconsistent case (`ANAWAL`, `KULAGERI CROSS`, `GULEDAGUDDA`). Normalise for display, keep raw.

**State IDs:** the state-wise dashboard returns `StateId` for all 34 states/UTs and they match the spec's table exactly.

**Crawl size (Bagalkote, 187):** Badami 2481 (30 GPs), Bagalkot 2478 (29), Bilagi 2482 (24), GULEDAGUDDA 10267 (12),
Hungund 2483 (19), ILKAL 10268 (16), Jamkhandi 2479 (25), Mudhol 2480 (23), RABAKAVI BANAHATTI 10269 (18) =
**196 GPs**. The weekly hierarchy crawl is 1 (districts) + 1 (blocks) + 9 (GP lists) + 196 (village lists) =
207 requests (~2–3 min at 600 ms).

### 2.4 Sample list (HTML): `GET Report/labtestingsamplelist`
```
Report/labtestingsamplelist?currentstatus=<cs>&fy=enc('2025-2026')&stid=enc(st)&dtid=enc(dt)&blid=enc(bl)&gpid=enc(gp)&villid=enc(0)
```
- `currentstatus` accepts **both** a raw number (`3`) and `enc('3')`. The page's own JS sends `enc()`.
- `villid=enc(0)` → whole GP. `gpid=enc(0)` → whole block. `blid=enc(0)&gpid=enc(0)` → whole district.
- **Paging:** the HTML page shows at most **50 rows** (page 1). When more exist, a `<select id="ddlPageNo">` lists
  "Page No. N" options. Further pages come only from the JSON endpoint (2.5). Adagal (one GP): 16 rows FY 2025-26,
  37 rows FY 2026-27. Badami block, tested, FY 2025-26: 23 pages.
- Title: `Format L2. List of samples where samples tested (2025-2026)`.

`currentstatus` codes (from the `Labtestingdata` page's `labtestingsample('<cs>', id)` links, mapped to its columns):

| cs | Meaning |
|---|---|
| 1 | Samples submitted online (total) |
| 110 | Submitted online but not received in labs |
| 2 | Received in labs (total) |
| 22 | Received but not tested |
| **3** | **Tested in laboratory (total)** ← ingest this |
| 14 | Tested for chemical parameters |
| 15 | Tested for bacteriological parameters |
| 4 | Inconclusive testing results |
| 8 | Found contaminated (total) |
| 9 | Chemical contamination |
| 10 | Bacteriological contamination |
| 11 / 12 / 13 | Contaminated with remedial measures taken (total / chemical / bacteriological). These lists add `Remedial_chem_remarks` / `Remedial_bact_remarks` columns |

**FY assignment follows the tested date, not the collection date.** Samples collected 05–07/03/2026 (FY 25-26)
with tested date 02/04/2026 appear in the FY 2026-27 list. Keep the spec's rule of also fetching the previous FY
during April–June. Dedupe by sample ID.

### 2.5 Sample list (JSON, paged): `POST Report/labtestingsamplelist_fil/` — **recommended for ingestion**
Form (all `enc()`): `cpage, currentstatus, stid, dtid, blid, gpid, villid, fy`. Session cookie required, no token.
Response: an object with `Labtestingdata` (rows), `TotalPage`, `CurentPage` (sic), `currentstatus`, plus many unused
summary fields. Row fields used: `RowNo, State, District, Block, Grampanchayat, Village, sample_sourceName, SampleId,
labname, lab_id (number, e.g. 1509), sample_collection_time ("DD/MM/YYYY"), s_report_approval_action_time
("DD/MM/YYYY", shown as "Sample tested date"), Status, Contaminated_parameters, chemical_parameter, bact_parameter,
Remedial_chem_remarks, Remedial_bact_remarks`. Also `sampleDate_time` ("DD/MM/YYYY"). Its meaning is **unknown**:
it matches neither analysis nor report-generation dates. Don't use it.
Strings are not HTML-escaped here (`RDW&SD …`). Speed: ~1.3 s per GP page; block-wide ~10 s per page.

### 2.6 Count tables: `GET Report/Labtestingdata?fy=&stid=&dtid=&blid=&gpid=&viid=` (all `enc`)
Returns a table of counts for the **siblings of the deepest non-zero ID**. With `dtid` only → every district in the
state. With `blid` → every block in the district. With `gpid` → every GP in the block. 16 columns: S.No, name,
submitted, submitted-not-received, received, received-not-tested, **tested**, tested-chem, tested-bact, inconclusive,
contaminated, contaminated-chem, contaminated-bact, remedial, remedial-chem, remedial-bact, with a `Total` row.
Row IDs are in `onclick="labtestingsample('<cs>',<id>)"`.
**Use:** a cheap change detector. Compare each GP's "tested" count with yesterday's and only fetch sample lists for
GPs whose count changed. Bagalkote FY 2026-27 so far: 6,580 tested (2,328 of them bacteriological), 60 contaminated.

### 2.7 Lab report: `GET Common/final_report_print?s_id=<urlencoded enc(digits)>`
- `digits` = the part after `S` in the sample ID: `U1359972S35664446` → `enc('35664446')`.
- Session cookie required (else HTTP 500). Old sample `19365256` (Himachal, 2024) works with a session.
- Page fields, as `<label>Caption:</label>` followed by `<label class="form-control" ...>value</label>`:
  `Sample Id`, `Name`/`Mobile`/`Email`/`Pin Code` (all masked `xxxxxxxxxxxxxxxxxxx`; never store), `Full Address`
  (usually "Not available" for village/GP/block), `Source of Sample`, `Village`, `Gram Panchayat`, `Block`, `District`,
  `State`, `Address`, `Remarks` (e.g. "Department sample SI 5639710"), `Latitude`, `Longitude` (**sometimes present,
  2 decimals**: Adagal sample → 15.55, 75.56; often blank), and four timestamps (IST):
  `Date & time of sample collection` / `… received in lab` / `… analysed` / `… report generation`, formatted
  `"05.03.2026 | 12:30:00 PM"`.
- Lab name: `<div class="lab-address-panel ..."><h2 class="jal-red">RDW&amp;SD Water Quality Testing Lab Bagalakote</h2>`,
  then the address paragraph.
- Results table: the `<table class="table">` after `<h2>Test results</h2>`. 8 columns:
  `S. No. | Parameters tested | Unit of measurement | Requirement (acceptable limit) as per BIS 10500 |
  Permissible limit (in absence of alternate source) as per BIS 10500 | Test result value | Method of Analysis | Remarks`.
  Each `<td style="font-weight:normal;">`. **There is no styling for exceedances**, so status must be computed.
  Rows are alphabetical. Bagalkote labs report 16 parameters. The Himachal lab reported 12, including
  `Free residual Chlorine` and `Temperature`.
- Limit cell values seen: numbers (`250`, `0.2`, `1.5`), a range `6.5-8.5` (pH), `NA` (conductivity, temperature),
  `No Relaxation`, and `Shall not be detectable in any 100 ml sample` (E. coli, total coliform).
- Result values: decimal strings with 3 decimals (`"102.490"`). Bacteriological results are **numeric CFU/100 ml**
  (`0.000` = not detected, `5.000` = detected; methods "MPN" / "H2S vial test"). Still accept
  `Absent`/`Present`/`Detected` text defensively.
- `*` after a parameter name marks NABL-accredited. Strip it into a flag.

### 2.8 National dashboards — `POST`, empty body, no cookie/token
- `Main/GetMainDashboard` → object: `total_laboratories, total_laboratories_rural, total_laboratories_wtp,
  total_cgwblaboratories, total_cwclaboratories, total_tested, total_village_test_complete, contaminated, ftk_testing,
  total_village_ftk_test_complete, contaminated_ftk, users_trained_ftk, Villages_trained_ftk, total_tested_yesterday,
  contaminated_yesterday, ftk_testing_yesterday, contaminated_ftk_yesterday`. Sample: 3,890,360 tested; 4,005 tested
  yesterday; 27 contaminated yesterday. The spec's `ftk_testing_yesterday` is present. There is no
  `total_village_ftk_test_complete_yesterday`.
- `Main/GetMainDashboard_samples_tested_laboratories` → array of 34 states: `StateId, StateName, totallaboratories,
  sample_received_lab, sample_received_lab_yesterday, sample_tested, sample_tested_Yesterday (capital Y),
  sample_contaminated, remedial_action_taken, NABL_accredited_laboratories, total_village_ftk_test_complete,
  Number_FTK_test_done, Number_FTK_test_done_yesterday, Samples_found_contaminated,
  Samples_found_contaminated_yesterday, remedial_action_taken_ftk`. `StateName` contains JSON-escaped `&` (`&`).
- `GET` on either → 404 HTML.

### 2.9 Not usable without more work
`Report/Get_lab_source_list`, `Report/Get_lab_source_list_details`, `Report/Get_rpt_ftk_testing_village_list`:
`GET` and empty `POST` both 302 → `/WQMIS/Error/Error`. They need parameters from a page that loads them
(`Report/LoadRpt1` with `{type, subcat}`). Not explored further. The mobile API and JALAMANA are deliberately unused.

---

## 3. Parser notes (exact)

### Sample-list HTML (`Report/labtestingsamplelist`)
- Table: `<tbody class="tbllabtestingsample">`. Each row is `<tr>` with **15** `<td>` (first is plain `<td>`, the
  rest `<td class="txtcontent">`). An empty server-rendered page was not observed. The JSON path's JS renders
  `<td colspan='8'>No records available</td>`, so treat any row with fewer than 15 cells as "no rows".
- Header row (`<th class="headName">`), index → meaning:
  0 `S.No.` · 1 `State (2025-2026)` (FY embedded in the header) · 2 `District` · 3 `Block` · 4 `Gram panchayat` ·
  5 `Village` · 6 `Sample source` · 7 `Sample Id` · 8 `Lab name` · 9 `Sample Collection date` · 10 `Sample tested date` ·
  11 `Sample Status` · 12 `Contaminated parameters` · 13 `Chemical parameters` · 14 `Bacteriologial parameters` (sic).
  For `cs=14` or `cs=15` only one parameter column is rendered; for `cs=11–13` two remedial columns are added.
  **Map by header text, not index.**
- HTML entities: `RDW&amp;SD …`. Decode them.
- Dates `DD/MM/YYYY` (IST, no time). Inconclusive rows have tested date `--`, empty status, and empty parameter cells.
- Status values seen: `Tested in lab`, `''` (inconclusive).
- Sample ID regex: `/^U(\d+)S(\d+)$/` (the U part is the submitting user/lab login, e.g. `U1359972`, `U703822`; one GP
  is served by several). Use the **full string** as `sample_id`, and `enc(digits)` for the report.
- `Sample source` is free text: `Individual house tap water Location : in habitaiton [ Source type : Deep Tubewell ]
  [ schemeId : 5706386, scheme name : …, Type : PWS ]`, `Source Type : Deep Tubewell, location : Dewara South`,
  `School name : GOVT HIGH SCHOOL ADAGAL`, `Public tap water location : -----`, `Anganwadi Name : …`. Derive
  `source_type` with `/Source type\s*:\s*([^\],]+)/i`, else the leading category (`Individual house tap water`,
  `Public tap water`, `School`, `Anganwadi`). Keep the raw string.
- Parameter cells (`Chemical parameters`, `Bacteriologial parameters`, `Contaminated parameters`):
  ```
   Colour (Hazen units) : 1.000, Turbidity (NTU) : 0.800, pH (NA) : 7.350, TDS (mg/l) : 973.000, ...
  ```
  Split on `/,\s*/`, then each item on the **last** `' : '`. The name part is `Name (unit)`: take the unit from the
  final parenthesised group (`(NA)` = no unit). Don't split on capital letters, because `pH` would break.
  Values have no thousands separators. Chemistry-only samples have an empty bacteriological cell.
- `Contaminated parameters` lists only parameters **above the permissible limit** (or bacteria detected). Verified:
  TDS 1738 is not listed (< 2000), Total Hardness 676.6 is listed (> 600), E. coli 5 is listed.
- Parameter name variants seen across lists: `Colour (Hazen units)`, `Turbidity (NTU)`, `pH (NA)`, `TDS (mg/l)`,
  **`Total dissovled solids (mg/l)` (typo, a separate parameter from `TDS` in some labs)**, `Total Alkalinity (as
  Calcium Carbonate) (mg/l)`, `Chloride (as Cl) (mg/l)`, `Fluoride (as F) (mg/l)`, `Nitrate (as NO3) (mg/l)`,
  `Sulphate (as SO4) (mg/l)`, `Calcium (as Ca) (mg/l)`, `Magnesium (As Mg) (mg/l)`, `Total Hardness (As CaCO3) (mg/l)`,
  `Iron (As Fe) (mg/l)`, `Conductivity (micromhos per centimeter / microsiemens per centimeter)`,
  `Free residual Chlorine (mg/l)`, `E. coli (CFU/100 ml)`, `Total coliform (CFU/ 100 ml)`. Build a canonical key map
  (case-insensitive, strip `(as …)`, map both TDS spellings to `tds`).

### Report HTML (`Common/final_report_print`)
- Header fields: regex
  `/<label[^>]*>([^<]{2,80}?):?\s*<\/label>\s*(?:<div[^>]*>\s*)?<label[^>]*>([\s\S]*?)<\/label>/g`. Drop the masked
  personal fields.
- Timestamps: `/^(\d{2})\.(\d{2})\.(\d{4}) \| (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/`, IST (+05:30). Convert to UTC.
- Results: take the `<tbody>` after the text `Parameters tested`; 8 `<td>` per row; trim and decode entities.
- Limit parsing: number → numeric; `a-b` → range (pH); `No Relaxation` → permissible = acceptable; `NA` → none;
  `Shall not be detectable…` → bacteriological, the limit is "not detectable" (value > 0 = above permissible).
  `Free residual chlorine` acceptable is a **minimum** (0.2), permissible a maximum (1).

### Dropdown JSON
See 2.3. IDs are strings except villages (numbers). Placeholder first item has `" "`, `""` or `0`.

### CPCB
See 1.1–1.3. Primary key `(station_no, parameter, measured_at)` dedupes naturally because each poll returns the same
`timestamp` until the next hourly reading.

---

## 4. Thresholds — verified sources

### 4.1 CPCB primary water quality criteria (designated best use)
Source: CPCB, "Water Quality Criteria", Table 1 — https://cpcb.nic.in/water-quality-criteria/ (now redirects to
https://cpcb.gov.in/water-quality-criteria/; page "Updated On: 11 Oct 2019"). Fetched with curl because this host
has the same revoked certificate.

| Class | Designated best use | Total coliform (MPN/100 ml) | pH | DO (mg/l) | BOD 5 d 20 °C (mg/l) |
|---|---|---|---|---|---|
| A | Drinking water source without conventional treatment but after disinfection | ≤ 50 | 6.5–8.5 | ≥ 6 | ≤ 2 |
| **B** | Outdoor bathing (organised) | ≤ 500 | 6.5–8.5 | ≥ 5 | ≤ 3 |
| **C** | Drinking water source after conventional treatment and disinfection | ≤ 5000 | 6.0–9.0 | ≥ 4 | ≤ 3 |
| D | Propagation of wildlife and fisheries | — | 6.5–8.5 | ≥ 4 | — (free ammonia as N ≤ 1.2 mg/l) |
| E | Irrigation, industrial cooling, controlled waste disposal | — | 6.0–8.5 | — | — (EC ≤ 2250 µmhos/cm, SAR ≤ 26, boron ≤ 2 mg/l) |

The spec's B/C values for pH, DO and BOD are **confirmed**. The CPCB real-time stations don't measure coliform, so only
pH, DO and BOD are evaluable live. Note: the real-time BOD is a sensor estimate, not a 5-day lab BOD. Say so in the UI.

### 4.2 BIS IS 10500:2012 (drinking water) — fallback only
Sources: the IS 10500:2012 text incl. **Amendment No. 2 (Sept 2018)**, as published on the Government consumer helpline
https://consumerhelpline.gov.in/public/assets/docs/bis/IS10500-2012.pdf (Amendment 2 only changes Table 2 Sl (v), Boron
permissible 1.0 → 2.4, and a test-method reference). The official https://www.bis.gov.in/other/DrinWatIS10500.pdf
returned 403. Lok Sabha answer on arsenic (28 Apr 2015; seen via a search summary, not read directly):
https://eparlib.nic.in/bitstream/123456789/661168/1/15692.pdf.
**Most important source in practice: the limits WQMIS prints on every report** (fixtures/wqmis/report-*.html). They
are what the labs judged against. Always prefer them.

| Parameter | Acceptable | Permissible (no alternate source) | IS 10500:2012 text | Printed on WQMIS reports (Oct 2026) |
|---|---|---|---|---|
| pH | 6.5–8.5 | no relaxation | same | `6.5-8.5` / `No Relaxation` |
| Turbidity (NTU) | 1 | 5 | same | 1 / 5 |
| TDS (mg/l) | 500 | 2000 | same | 500 / 2000 |
| Total hardness as CaCO3 (mg/l) | 200 | 600 | same | 200 / 600 |
| Chloride (mg/l) | 250 | 1000 | same | 250 / 1000 |
| Fluoride (mg/l) | 1.0 | 1.5 | same | 1 / 1.5 |
| Nitrate as NO3 (mg/l) | 45 | no relaxation | same | 45 / `No Relaxation` |
| **Iron (mg/l)** | **1.0** (reports) | no relaxation | **0.3** / no relaxation | **1 / `No Relaxation`** |
| **Arsenic (mg/l)** | 0.01 | **0.05** in the 2012 text (also cited in the 2015 Lok Sabha answer) | 0.01 / 0.05 | not on any report seen |
| Free residual chlorine (mg/l) | min 0.2 | 1 | same | 0.2 / 1 |
| Calcium (mg/l) | 75 | 200 | same | 75 / 200 |
| Magnesium (mg/l) | 30 | 100 | same | 30 / 100 |
| Sulphate (mg/l) | 200 | 400 | same | 200 / 400 |
| Total alkalinity as CaCO3 (mg/l) | 200 | 600 | same | 200 / 600 |
| Colour (Hazen) | 5 | 15 | same | 5 / 15 |
| E. coli / total coliform | not detectable in 100 ml | not detectable | same | `Shall not be detectable in any 100 ml sample` / `No Relaxation` |

Discrepancies to carry into `thresholds.js` comments:
- **Iron:** the 2012 text says 0.3 mg/l, but WQMIS prints 1.0. The spec's table (1.0) matches the reports. Use 1.0 as
  the fallback with a comment citing both. Report-printed limits override anyway.
- **Arsenic:** the 2012 text gives a 0.05 permissible limit. I could not find the text of Amendment No. 1 (2015) to
  confirm the commonly repeated claim that it removed the relaxation. **Fallback: acceptable 0.01, permissible 0.05,
  `// UNVERIFIED: Amendment 1 (2015) may have set "no relaxation"`.** For the `regional_geogenic` alert, consider
  firing at > 0.01 (WHO guideline). Decide in Phase 5 and document it.

---

## 5. Fixtures index

| File | What it is |
|---|---|
| `fixtures/cpcb/layer10.json` | Latest value per station × parameter (468 objects, 40 stations; BH75 and WB90 stale) |
| `fixtures/cpcb/stations.json` | Station metadata incl. `object_type` (fixed/floating), diary |
| `fixtures/cpcb/layer20-qualified-hours.json` | Daily QA "qualified hours" per station × parameter |
| `fixtures/cpcb/layer21-station-coverage.json` | Station coverage % |
| `fixtures/cpcb/week-UT67-pH.json`, `week-UT67-DO.json` | 7-day hourly history (with null gaps / trailing null) |
| `fixtures/cpcb/week-WB90-DO-stale.json` | History file for a stale station: `rows "0"`, `data []` |
| `fixtures/cpcb/year-UT67-DO.json` | Daily means 2021-12-21 → 2026-10-21, with aggregation accuracy % |
| `fixtures/wqmis/districts-15.json` | Karnataka districts (31 + placeholder `" "`) |
| `fixtures/wqmis/blocks-187.json` | Bagalkote blocks (9 + placeholder) |
| `fixtures/wqmis/gps-2481.json` | Badami GPs (30 + placeholder) |
| `fixtures/wqmis/villages-59783.json` | Adagal villages (2 + placeholder ID 0; numeric IDs) |
| `fixtures/wqmis/samplelist-59783-2025-2026-tested.html` | Adagal, cs=3, FY 25-26: 16 rows, all within limits |
| `fixtures/wqmis/samplelist-59783-2026-2027-tested.html` | Adagal, cs=3, FY 26-27: 37 rows (incl. chemistry-only rows, March collections tested in April) |
| `fixtures/wqmis/samplelist-59783-2025-2026-inconclusive.html` | Adagal, cs=4: 3 rows with `--` tested date and empty cells |
| `fixtures/wqmis/samplelist-block-2481-2025-2026-contaminated.html` | Badami block-wide (`gpid=enc(0)`), cs=8: 19 contaminated rows (nitrate, fluoride) |
| `fixtures/wqmis/samplelist-fil-59783-2025-2026-tested.json` | JSON paged variant for Adagal (`TotalPage` 1) |
| `fixtures/wqmis/samplelist-fil-block-2481-2025-2026-contaminated.json` | JSON paged variant, block-wide contaminated |
| `fixtures/wqmis/labtestingdata-districts-15-2026-2027.html` | Count table per district of Karnataka |
| `fixtures/wqmis/labtestingdata-blocks-187-2026-2027.html` | Count table per block of Bagalkote |
| `fixtures/wqmis/labtestingdata-gps-2481-2025-2026.html` | Count table per GP of Badami (with all `labtestingsample('cs',id)` links) |
| `fixtures/wqmis/report-35664446-adagal-within-limits.html` | Report, all within limits, **has lat/lng** (15.55, 75.56) |
| `fixtures/wqmis/report-28606524-bagavati-ecoli-present.html` | **E. coli 5 + total coliform 5 CFU/100 ml**, hardness 676.6 > 600 |
| `fixtures/wqmis/report-35723920-herkal-tds-nitrate-chloride.html` | TDS 5960, chloride 1767, nitrate 48.3, hardness 1433, Mg 184.9 (multiple above permissible) |
| `fixtures/wqmis/report-30117289-kainakatti-nitrate-fluoride.html` | Nitrate 61.4 (> 45) and fluoride 1.93 (> 1.5): geogenic case |
| `fixtures/wqmis/report-19365256-old-himachal.html` | 2024 Himachal report (12 params incl. free residual chlorine 0.000 below min, temperature) |
| `fixtures/wqmis/dashboard-main.json` | National totals incl. `*_yesterday` |
| `fixtures/wqmis/dashboard-states.json` | 34 states, daily numbers |

---

## 6. Recommended ingestion design (from what was observed)

1. **CPCB:** poll `layers/10` every 15 min with TLS verification on. On first run (and after any outage > 1 h), backfill
   each station × parameter from `week.json` (480 files, once). Optionally keep `year.json` daily means for context charts.
2. **WQMIS hierarchy (weekly):** districts → blocks → GPs → villages via the four POSTs. 207 requests for Bagalkote.
3. **WQMIS samples (daily):**
   1. `GET Labtestingdata` per block (9 requests) for the current FY, plus the previous FY in April–June. Note each
      GP's "tested" count.
   2. For each GP whose count changed (or all GPs on the first run): `POST labtestingsamplelist_fil/` with `cs=3`,
      `gpid=<gp>`, looping `cpage` until `TotalPage`. Parse values from the `chemical_parameter` / `bact_parameter`
      strings. Insert unseen sample IDs.
   3. For each **new** sample, `GET final_report_print` to get the four timestamps, printed limits, lab, lat/lng and
      method. First-run backlog for Bagalkote is ~6.6k samples for FY 26-27 alone (~1.1 h at 600 ms). Process in
      batches across runs, prioritising samples whose list row has a non-empty `Contaminated_parameters`. Until
      a report is fetched, evaluate status with the fallback limits from the list values.
4. **Dashboards (daily 10:00):** two POSTs; store both payloads in `wq_daily_snapshot`.
5. Re-establish the WQMIS session (GET `Report_L`) at the start of every job and after any 302/500.

---

## 7. Findings during ingestion (Phases 2–4)

These came up when the jobs ran for real, after the probes above.

- **WQMIS sessions go bad without an error.** After about 60 `labtestingsamplelist_fil/` requests in two
  minutes, the session started returning a blank envelope: `Labtestingdata: null`, `FinancialYear: null`
  and `StateId: 0`, still with HTTP 200. A genuinely empty list echoes the FY and IDs, so the two can be
  told apart (`isBlankEnvelope()` in `services/worker/lib/wqmis.js`). The client re-establishes the
  session, waits 5–10 s and retries twice. The samples job also refuses to record a GP's "tested" count
  when the count table says there are tests but the list is empty. Otherwise the change detector would
  skip that GP forever.
- **The count tables agree with the lists.** Bagalkote FY 2026-27: the `Labtestingdata` total says
  6,580 tested, and the database holds exactly 6,580 samples for that FY after the crawl.
- **Coordinates printed on lab reports are not sample locations.** Where present, they repeat a handful
  of 2-decimal values across different panchayats (for example 15.77, 75.11 on 17 samples from
  several GPs), 45–65 km from the named villages. They are stored (`wq_sample.report_lat/lng`) but not
  used for geocoding.
- **Geocoding.** Nominatim free-text search placed 64 of 196 Bagalkote GPs. A single Overpass request
  for every OSM `place=village|town|hamlet|…` node in the district's bounding box (3,672 settlements),
  fuzzy-matched with transliteration folding (ee/i, oo/u, aspirates, w/v, f/ph, -halli/-hal,
  -keri/-kere, doubled letters) within 35 km of the GP's block, placed 128 more. Where both sources
  placed a GP, 54 agreed within 3 km. The 8 that disagreed are namesake villages, now
  `nominatim-disputed` with confidence 0.4 and shown as approximate. Result: 182 of 196 (93%) at
  confidence 0.5 or more; 4 remain at their block's position.
- **CPCB values sit on instrument floors** (CL 5, COD 5, TOC 1, nitrate 0.3, EC 1). Spike detection
  ignores floor values. It fires only on rises (z > 4 *and* at least 25% above the 7-day median), once
  per episode, with a 6-hour cooldown. The first version of the detector, without these rules, raised
  25 "spikes" on the first live cycle, most of them falls in turbidity.
- **Live river readings swing.** Haridwar (UK55) pH went from 7.34 to 5.93 in four hours, then to 10.2
  later the same day. The site shows these as published, with their times. It doesn't smooth them.
- **Report links need a WQMIS session in the reader's browser too.** A reader who opens a
  `final_report_print` link without having visited WQMIS gets HTTP 500, as the probe did. The site says
  so next to every report link and links to WQMIS's report page, which opens a session.
