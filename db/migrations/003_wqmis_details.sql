-- Details learned in Phase 1 (docs/SOURCES.md): values arrive inline in the sample list, reports add
-- precise timestamps and printed limits, and per-area test counts make a cheap change detector.
alter table wq_area add column name_raw text;
alter table wq_area add column tested_counts jsonb;          -- { "<fy>": <tested count> } from Report/Labtestingdata

alter table wq_sample add column status_text text;
alter table wq_sample add column contaminated_text text;
alter table wq_sample add column remedial_remarks text;
alter table wq_sample add column report_lat double precision;
alter table wq_sample add column report_lng double precision;
alter table wq_sample add column worst_status text;
create index wq_sample_report_todo_idx on wq_sample (report_fetched_at) where report_fetched_at is null;

alter table wq_result add column label text;
alter table wq_result add column method text;
alter table wq_result add column nabl boolean;
alter table wq_result add column limits_source text check (limits_source in ('report', 'wqmis', 'bis'));

-- Limits as printed on WQMIS lab reports, learned from every report parsed. Applied to samples whose
-- own report hasn't been fetched yet (limits_source = 'wqmis').
create table wq_param_limit (
  parameter text primary key, label text, unit text,
  acceptable_limit text, permissible_limit text,
  seen_at timestamptz default now(), sample_id text
);
