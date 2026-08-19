begin;

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
     or p_source_model_version not in ('protocol-progress-v1', 'creatine-balance-v2') then
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
  'Atomically imports one validated browser tracker from either supported creatine estimate model into an empty authenticated account.';

revoke all on function public.import_creatine_guest_state(uuid, text, integer, text, jsonb, jsonb) from public, anon, authenticated;

commit;
