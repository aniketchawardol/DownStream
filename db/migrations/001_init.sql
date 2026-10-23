-- Section 5 schema, plus the state the alert engine and mailer need.
create extension if not exists postgis;
create extension if not exists citext;

create table cpcb_station (
  station_no text primary key, name text, state text,
  geom geography(Point,4326), last_reading_at timestamptz, diary jsonb,
  river text, catchment text, long_name text, updated_at timestamptz default now()
);
create table cpcb_reading (
  station_no text references cpcb_station, parameter text, value double precision, unit text,
  measured_at timestamptz, fetched_at timestamptz default now(),
  primary key (station_no, parameter, measured_at)
);
create index cpcb_reading_measured_idx on cpcb_reading (measured_at);

create table wq_area (
  id bigserial primary key, level text check (level in ('district','block','gp','village')),
  jjm_id text not null, parent_id bigint references wq_area, state_id int, name text,
  geom geography(Point,4326), geocode_source text, geocode_confidence real,
  geocoded_at timestamptz, samples_fetched_at timestamptz, crawled_at timestamptz default now(),
  unique (level, jjm_id)
);
create index wq_area_geom_idx on wq_area using gist (geom);
create index wq_area_parent_idx on wq_area (parent_id);

create table wq_sample (
  sample_id text primary key, gp_area_id bigint references wq_area, village_name text, source_type text,
  collected_at timestamptz, received_at timestamptz, analysed_at timestamptz, reported_at timestamptz,
  first_seen_at timestamptz default now(), report_s_id text, raw jsonb,
  fy text, lab_name text, source_name text, test_kinds text[],
  report_fetched_at timestamptz, report_error text, report_attempts int not null default 0,
  alerted_at timestamptz
);
create index wq_sample_gp_idx on wq_sample (gp_area_id, collected_at desc);

create table wq_result (
  sample_id text references wq_sample on delete cascade, parameter text, value_text text, value double precision, unit text,
  acceptable_limit text, permissible_limit text,
  status text check (status in ('ok','above_acceptable','above_permissible','unknown')),
  primary key (sample_id, parameter)
);
create table wq_daily_snapshot (snapshot_date date, scope text, payload jsonb, primary key (snapshot_date, scope));

create table subscription (
  id uuid primary key default gen_random_uuid(), email citext not null,
  geom geography(Point,4326) not null, radius_km real not null default 10, kinds text[] not null,
  confirm_token text, confirmed_at timestamptz, unsubscribe_token text not null,
  is_mock boolean not null default false, created_at timestamptz default now(),
  unsubscribed_at timestamptz, last_digest_at timestamptz
);
create index subscription_geom_idx on subscription using gist (geom);
create index subscription_email_idx on subscription (email, created_at);
create unique index subscription_confirm_token_idx on subscription (confirm_token);
create unique index subscription_unsub_token_idx on subscription (unsubscribe_token);

create table alert (
  id uuid primary key default gen_random_uuid(), kind text, severity text check (severity in ('urgent','notice','info')),
  source text, subject_ref text, geom geography(Point,4326), title text, body jsonb,
  is_mock boolean not null default false, dedupe_key text unique, created_at timestamptz default now()
);
create index alert_created_idx on alert (created_at desc);
create index alert_geom_idx on alert using gist (geom);

-- One row per email actually sent (or attempted); deliveries point at the email that carried them.
create table email_message (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscription on delete cascade,
  kind text check (kind in ('confirm','alerts','digest')), subject text, is_mock boolean not null default false,
  sent_at timestamptz default now(), error text
);
create index email_message_sub_idx on email_message (subscription_id, sent_at desc);

create table delivery (
  alert_id uuid references alert on delete cascade, subscription_id uuid references subscription on delete cascade,
  channel text default 'email',
  -- pending: waiting for the mailer; digest: held for the weekly summary; sent / failed / skipped
  status text, sent_at timestamptz, error text,
  created_at timestamptz default now(), message_id uuid references email_message,
  primary key (alert_id, subscription_id, channel)
);
create index delivery_pending_idx on delivery (status, subscription_id) where status in ('pending','digest');

create table source_health (
  source text primary key, last_attempt_at timestamptz, last_success_at timestamptz,
  last_error text, records_last_run int,
  newest_data_at timestamptz, consecutive_failures int not null default 0, circuit_open_until timestamptz,
  notes jsonb
);

-- Hysteresis state per station + parameter for river_threshold / river_recovered.
create table river_param_state (
  station_no text references cpcb_station, parameter text,
  in_violation boolean not null default false, ok_streak int not null default 0,
  last_measured_at timestamptz, last_value double precision,
  violation_since timestamptz, last_alert_at timestamptz,
  primary key (station_no, parameter)
);
