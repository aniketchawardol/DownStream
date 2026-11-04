-- CPCB's long history: one row per station, parameter and IST day, from each station's year.json
-- (daily minimum, mean and maximum back to late 2021). Days newer than CPCB's file are derived from
-- cpcb_reading at query time. coverage is CPCB's "aggregation accuracy": the share of the day's
-- expected readings that arrived, in percent.
create table cpcb_daily (
  station_no text not null references cpcb_station(station_no),
  parameter  text not null,
  day        date not null,
  min        double precision,
  mean       double precision,
  max        double precision,
  coverage   real,
  primary key (station_no, parameter, day)
);

-- The Ganga view reads one parameter across many stations by day.
create index cpcb_daily_param_day_idx on cpcb_daily (parameter, day);

alter table cpcb_station add column history_at timestamptz;
