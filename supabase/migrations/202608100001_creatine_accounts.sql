begin;

create schema if not exists creatine_private;
revoke all on schema creatine_private from public;

create table public.tracker_profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  schema_version smallint not null default 2 check (schema_version = 2),
  model_version text not null check (char_length(model_version) between 1 and 100),
  weight_kg numeric(6, 2) not null check (weight_kg between 30 and 300),
  tracking_start_date date not null,
  tracker_timezone text not null check (char_length(tracker_timezone) between 1 and 100),
  default_dose_grams numeric(6, 2) not null default 5 check (default_dose_grams between 0.1 and 100),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tracker_profiles is
  'Factual creatine tracker settings. Modelled progress is derived by clients and is never persisted.';

create table public.dose_events (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 128 and id = btrim(id)),
  taken_at timestamptz not null,
  timezone text not null check (char_length(timezone) between 1 and 100),
  grams numeric(6, 2) not null check (grams between 0.1 and 100),
  entry_method text not null default 'unknown' check (entry_method ~ '^[a-z][a-z0-9_-]{0,39}$'),
  client_created_at timestamptz,
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

comment on table public.dose_events is
  'Factual supplement events only. No estimated loading percentage or biological measurement is stored.';

create index dose_events_user_taken_at_idx
  on public.dose_events (user_id, taken_at desc);

create table public.tracker_import_receipts (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  import_id uuid not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  source_schema_version integer not null check (source_schema_version in (1, 2)),
  source_model_version text not null check (char_length(source_model_version) between 1 and 100),
  dose_count integer not null check (dose_count between 0 and 20000),
  applied_at timestamptz not null default now(),
  primary key (user_id, import_id)
);

comment on table public.tracker_import_receipts is
  'Immutable idempotency receipts for explicit browser-to-account imports.';

create index tracker_import_receipts_user_applied_at_idx
  on public.tracker_import_receipts (user_id, applied_at desc);

create or replace function creatine_private.prepare_profile_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  local_today date;
begin
  if new.user_id is null then
    raise exception using errcode = '23502', message = 'CREATINE_USER_REQUIRED';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = new.tracker_timezone
  ) then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_TIMEZONE';
  end if;

  local_today := pg_catalog.timezone(new.tracker_timezone, pg_catalog.now())::date;
  if new.tracking_start_date > local_today
     or new.tracking_start_date < local_today - 3659 then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_TRACKING_START';
  end if;

  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := pg_catalog.now();
  else
    if new.user_id is distinct from old.user_id then
      raise exception using errcode = '22023', message = 'CREATINE_OWNER_IMMUTABLE';
    end if;
    new.revision := old.revision + 1;
    new.created_at := old.created_at;
  end if;

  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create trigger tracker_profiles_prepare_write
before insert or update on public.tracker_profiles
for each row execute function creatine_private.prepare_profile_write();

create or replace function creatine_private.prepare_dose_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is null then
    raise exception using errcode = '23502', message = 'CREATINE_USER_REQUIRED';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = new.timezone
  ) then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_TIMEZONE';
  end if;

  if new.taken_at > pg_catalog.now() + interval '5 minutes'
     or new.taken_at < pg_catalog.now() - interval '3661 days' then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_DOSE_TIME';
  end if;

  if new.client_created_at is not null
     and new.client_created_at > pg_catalog.now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_CLIENT_TIME';
  end if;

  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := pg_catalog.now();
  else
    if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
      raise exception using errcode = '22023', message = 'CREATINE_DOSE_IDENTITY_IMMUTABLE';
    end if;
    new.revision := old.revision + 1;
    new.created_at := old.created_at;
  end if;

  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create trigger dose_events_prepare_write
before insert or update on public.dose_events
for each row execute function creatine_private.prepare_dose_write();

alter table public.tracker_profiles enable row level security;
alter table public.dose_events enable row level security;
alter table public.tracker_import_receipts enable row level security;

revoke all on table public.tracker_profiles from anon, authenticated;
revoke all on table public.dose_events from anon, authenticated;
revoke all on table public.tracker_import_receipts from anon, authenticated;

grant select, insert, update, delete on table public.tracker_profiles to authenticated;
grant select, insert, update, delete on table public.dose_events to authenticated;
grant select, insert, delete on table public.tracker_import_receipts to authenticated;

create policy tracker_profiles_select_own
on public.tracker_profiles
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy tracker_profiles_insert_own
on public.tracker_profiles
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy tracker_profiles_update_own
on public.tracker_profiles
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy tracker_profiles_delete_own
on public.tracker_profiles
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy dose_events_select_own
on public.dose_events
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy dose_events_insert_own
on public.dose_events
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy dose_events_update_own
on public.dose_events
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy dose_events_delete_own
on public.dose_events
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy tracker_import_receipts_select_own
on public.tracker_import_receipts
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy tracker_import_receipts_insert_own
on public.tracker_import_receipts
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy tracker_import_receipts_delete_own
on public.tracker_import_receipts
for delete
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.import_creatine_guest_state(
  p_import_id uuid,
  p_payload_sha256 text,
  p_source_schema_version integer,
  p_source_model_version text,
  p_profile jsonb,
  p_doses jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  existing_receipt public.tracker_import_receipts%rowtype;
  profile_weight numeric;
  profile_start date;
  profile_timezone text;
  profile_default_dose numeric;
  imported_dose_count integer;
begin
  if current_user_id is null then
    raise exception using errcode = '28000', message = 'CREATINE_AUTH_REQUIRED';
  end if;

  if p_import_id is null
     or p_payload_sha256 !~ '^[0-9a-f]{64}$'
     or p_source_schema_version not in (1, 2)
     or p_source_model_version <> 'protocol-progress-v1' then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_IMPORT_METADATA';
  end if;

  select *
  into existing_receipt
  from public.tracker_import_receipts
  where user_id = current_user_id and import_id = p_import_id;

  if found then
    if existing_receipt.payload_sha256 <> p_payload_sha256 then
      raise exception using errcode = '23505', message = 'CREATINE_IMPORT_ID_CONFLICT';
    end if;

    return pg_catalog.jsonb_build_object(
      'status', 'already_applied',
      'importId', p_import_id,
      'doseCount', existing_receipt.dose_count
    );
  end if;

  if exists (select 1 from public.tracker_profiles where user_id = current_user_id)
     or exists (select 1 from public.dose_events where user_id = current_user_id) then
    raise exception using errcode = 'P0001', message = 'CREATINE_CLOUD_NOT_EMPTY';
  end if;

  if pg_catalog.jsonb_typeof(p_profile) <> 'object'
     or pg_catalog.jsonb_typeof(p_doses) <> 'array'
     or pg_catalog.jsonb_array_length(p_doses) > 20000 then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_IMPORT_PAYLOAD';
  end if;

  if coalesce(p_profile->>'trackingStartDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_PROFILE';
  end if;

  begin
    profile_weight := (p_profile->>'weightKg')::numeric;
    profile_start := (p_profile->>'trackingStartDate')::date;
    profile_timezone := p_profile->>'trackerTimezone';
    profile_default_dose := coalesce((p_profile->>'defaultDoseGrams')::numeric, 5);
  exception when others then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_PROFILE';
  end;

  if profile_default_dose < 0.1
     or profile_default_dose > 100
     or (p_source_schema_version = 1 and profile_default_dose <> 5) then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_PROFILE';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_doses) as dose(value)
    where pg_catalog.jsonb_typeof(dose.value) <> 'object'
  ) then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_DOSE';
  end if;

  begin
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_doses) as dose(value)
      where coalesce(dose.value->>'id', '') = ''
         or char_length(dose.value->>'id') > 128
         or dose.value->>'id' <> btrim(dose.value->>'id')
         or nullif(dose.value->>'takenAt', '') is null
         or (dose.value->>'grams')::numeric < 0.1
         or (dose.value->>'grams')::numeric > 100
         or (p_source_schema_version = 1 and (dose.value->>'grams')::numeric <> 5)
    ) then
      raise exception using errcode = '22023', message = 'CREATINE_INVALID_DOSE';
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'CREATINE_INVALID_DOSE';
  end;

  select pg_catalog.jsonb_array_length(p_doses) into imported_dose_count;
  if imported_dose_count <> (
    select count(distinct dose.value->>'id')
    from pg_catalog.jsonb_array_elements(p_doses) as dose(value)
  ) then
    raise exception using errcode = '22023', message = 'CREATINE_DUPLICATE_DOSE_ID';
  end if;

  insert into public.tracker_profiles (
    user_id,
    schema_version,
    model_version,
    weight_kg,
    tracking_start_date,
    tracker_timezone,
    default_dose_grams
  ) values (
    current_user_id,
    2,
    p_source_model_version,
    profile_weight,
    profile_start,
    profile_timezone,
    profile_default_dose
  );

  insert into public.dose_events (
    user_id,
    id,
    taken_at,
    timezone,
    grams,
    entry_method,
    client_created_at
  )
  select
    current_user_id,
    dose.value->>'id',
    (dose.value->>'takenAt')::timestamptz,
    coalesce(nullif(dose.value->>'timezone', ''), profile_timezone),
    (dose.value->>'grams')::numeric,
    coalesce(nullif(dose.value->>'entryMethod', ''), 'import'),
    case
      when nullif(dose.value->>'createdAt', '') is null then null
      else (dose.value->>'createdAt')::timestamptz
    end
  from pg_catalog.jsonb_array_elements(p_doses) as dose(value);

  insert into public.tracker_import_receipts (
    user_id,
    import_id,
    payload_sha256,
    source_schema_version,
    source_model_version,
    dose_count
  ) values (
    current_user_id,
    p_import_id,
    p_payload_sha256,
    p_source_schema_version,
    p_source_model_version,
    imported_dose_count
  );

  return pg_catalog.jsonb_build_object(
    'status', 'applied',
    'importId', p_import_id,
    'doseCount', imported_dose_count,
    'profileRevision', 1
  );
end;
$$;

comment on function public.import_creatine_guest_state(uuid, text, integer, text, jsonb, jsonb) is
  'Atomically imports one validated browser tracker into an empty authenticated account. Reusing the same import ID and hash is idempotent.';

revoke all on function public.import_creatine_guest_state(uuid, text, integer, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_creatine_guest_state(uuid, text, integer, text, jsonb, jsonb) to authenticated;

create or replace function public.delete_current_creatine_tracker_data()
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  deleted_dose_count integer;
  deleted_receipt_count integer;
  deleted_profile_count integer;
begin
  if current_user_id is null then
    raise exception using errcode = '28000', message = 'CREATINE_AUTH_REQUIRED';
  end if;

  delete from public.dose_events where user_id = current_user_id;
  get diagnostics deleted_dose_count = row_count;

  delete from public.tracker_import_receipts where user_id = current_user_id;
  get diagnostics deleted_receipt_count = row_count;

  delete from public.tracker_profiles where user_id = current_user_id;
  get diagnostics deleted_profile_count = row_count;

  return pg_catalog.jsonb_build_object(
    'status', 'deleted',
    'doseCount', deleted_dose_count,
    'receiptCount', deleted_receipt_count,
    'profileCount', deleted_profile_count
  );
end;
$$;

comment on function public.delete_current_creatine_tracker_data() is
  'Atomically deletes the authenticated caller''s tracker data while retaining their authentication account.';

revoke all on function public.delete_current_creatine_tracker_data() from public, anon, authenticated;
grant execute on function public.delete_current_creatine_tracker_data() to authenticated;

commit;
