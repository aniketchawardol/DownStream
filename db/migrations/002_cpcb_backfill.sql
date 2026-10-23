-- Per-station history backfill from KISTERS week.json files runs once per station.
alter table cpcb_station add column backfilled_at timestamptz;
alter table cpcb_station add column site_no text;
alter table cpcb_station add column parameters jsonb;
