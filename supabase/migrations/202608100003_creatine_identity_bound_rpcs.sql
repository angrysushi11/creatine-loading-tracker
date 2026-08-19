begin;

create or replace function public.import_creatine_guest_state_bound(
  p_expected_user_id uuid,
  p_import_id uuid,
  p_payload_sha256 text,
  p_source_schema_version integer,
  p_source_model_version text,
  p_profile jsonb,
  p_doses jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then
    raise exception using errcode = '28000', message = 'CREATINE_AUTH_IDENTITY_CHANGED';
  end if;

  return public.import_creatine_guest_state(
    p_import_id,
    p_payload_sha256,
    p_source_schema_version,
    p_source_model_version,
    p_profile,
    p_doses
  );
end;
$$;

comment on function public.import_creatine_guest_state_bound(uuid, uuid, text, integer, text, jsonb, jsonb) is
  'Identity-bound entrypoint for atomic guest imports. Rejects a request if its authenticated user differs from the initiating browser account.';

create or replace function public.delete_current_creatine_tracker_data_bound(
  p_expected_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then
    raise exception using errcode = '28000', message = 'CREATINE_AUTH_IDENTITY_CHANGED';
  end if;

  return public.delete_current_creatine_tracker_data();
end;
$$;

comment on function public.delete_current_creatine_tracker_data_bound(uuid) is
  'Identity-bound entrypoint for tracker deletion. Rejects a request if its authenticated user differs from the initiating browser account.';

revoke all on function public.import_creatine_guest_state(uuid, text, integer, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_current_creatine_tracker_data() from public, anon, authenticated;
revoke all on function public.import_creatine_guest_state_bound(uuid, uuid, text, integer, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.delete_current_creatine_tracker_data_bound(uuid) from public, anon, authenticated;

grant execute on function public.import_creatine_guest_state_bound(uuid, uuid, text, integer, text, jsonb, jsonb) to authenticated;
grant execute on function public.delete_current_creatine_tracker_data_bound(uuid) to authenticated;

commit;
