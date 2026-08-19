begin;

alter table public.tracker_profiles
  drop constraint if exists tracker_profiles_default_dose_grams_check;

alter table public.tracker_profiles
  add constraint tracker_profiles_default_dose_grams_check
  check (
    default_dose_grams between 0.1 and 100
    and default_dose_grams = pg_catalog.round(default_dose_grams, 1)
  );

alter table public.dose_events
  drop constraint if exists dose_events_grams_check;

alter table public.dose_events
  add constraint dose_events_grams_check
  check (
    grams between 0.1 and 100
    and grams = pg_catalog.round(grams, 1)
  );

commit;
