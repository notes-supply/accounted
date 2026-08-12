-- Mail connections contain live OAuth credentials. Credential changes and the
-- metadata-only audit row describing each control change must commit together.
-- These RPCs are callable only by service_role, validate the named actor's
-- current writable membership, and never copy tokens into audit_log.

CREATE OR REPLACE FUNCTION public.upsert_mail_connection_with_audit(
  p_company_id uuid,
  p_user_id uuid,
  p_provider text,
  p_email_address text,
  p_encrypted_refresh_token text,
  p_encrypted_access_token text,
  p_access_token_expires_at timestamptz,
  p_scopes text[],
  p_backfill_from date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_email text := lower(trim(p_email_address));
  v_connection_id uuid;
  v_old_state jsonb;
  v_action text;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = p_user_id
      AND cm.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'Writable company membership required' USING ERRCODE = '42501';
  END IF;

  IF p_provider NOT IN ('gmail', 'microsoft') OR v_email = '' THEN
    RAISE EXCEPTION 'Invalid mail connection metadata' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || ':' || p_provider || ':' || v_email, 0)
  );

  SELECT mc.id,
         pg_catalog.jsonb_build_object(
           'provider', mc.provider,
           'email_address', mc.email_address,
           'status', mc.status,
           'backfill_from', mc.backfill_from
         )
  INTO v_connection_id, v_old_state
  FROM public.mail_connections mc
  WHERE mc.company_id = p_company_id
    AND mc.provider = p_provider
    AND mc.email_address = v_email
  FOR UPDATE;

  IF v_connection_id IS NULL THEN
    INSERT INTO public.mail_connections (
      company_id,
      provider,
      email_address,
      connected_by,
      encrypted_refresh_token,
      encrypted_access_token,
      access_token_expires_at,
      scopes,
      backfill_from,
      status,
      last_error_code,
      last_error_at
    )
    VALUES (
      p_company_id,
      p_provider,
      v_email,
      p_user_id,
      p_encrypted_refresh_token,
      p_encrypted_access_token,
      p_access_token_expires_at,
      coalesce(p_scopes, ARRAY[]::text[]),
      p_backfill_from,
      'active',
      NULL,
      NULL
    )
    RETURNING id INTO v_connection_id;
    v_action := 'INSERT';
  ELSE
    UPDATE public.mail_connections
    SET connected_by = p_user_id,
        encrypted_refresh_token = p_encrypted_refresh_token,
        encrypted_access_token = p_encrypted_access_token,
        access_token_expires_at = p_access_token_expires_at,
        scopes = coalesce(p_scopes, ARRAY[]::text[]),
        backfill_from = p_backfill_from,
        status = 'active',
        last_error_code = NULL,
        last_error_at = NULL
    WHERE id = v_connection_id;
    v_action := 'UPDATE';
  END IF;

  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    old_state,
    new_state,
    description,
    actor_type,
    actor_label
  )
  VALUES (
    p_user_id,
    p_company_id,
    v_action,
    'mail_connections',
    v_connection_id,
    p_user_id,
    v_old_state,
    pg_catalog.jsonb_build_object(
      'provider', p_provider,
      'email_address', v_email,
      'status', 'active',
      'backfill_from', p_backfill_from
    ),
    CASE WHEN v_action = 'INSERT'
      THEN pg_catalog.format('Brevlåda ansluten: %s (%s)', v_email, p_provider)
      ELSE pg_catalog.format('Brevlåda återansluten: %s (%s)', v_email, p_provider)
    END,
    'user',
    NULL
  );

  RETURN v_connection_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_mail_connection_with_audit(uuid, uuid, text, text, text, text, timestamptz, text[], date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_mail_connection_with_audit(uuid, uuid, text, text, text, text, timestamptz, text[], date) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_mail_connection_with_audit(uuid, uuid, text, text, text, text, timestamptz, text[], date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_mail_connection_with_audit(uuid, uuid, text, text, text, text, timestamptz, text[], date) TO service_role;

CREATE OR REPLACE FUNCTION public.update_mail_connection_backfill_with_audit(
  p_company_id uuid,
  p_connection_id uuid,
  p_user_id uuid,
  p_backfill_from date
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_row public.mail_connections%ROWTYPE;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = p_user_id
      AND cm.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'Writable company membership required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.mail_connections mc
  WHERE mc.id = p_connection_id
    AND mc.company_id = p_company_id
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.mail_connections
  SET backfill_from = p_backfill_from
  WHERE id = v_row.id;

  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    old_state,
    new_state,
    description,
    actor_type,
    actor_label
  )
  VALUES (
    p_user_id,
    p_company_id,
    'UPDATE',
    'mail_connections',
    v_row.id,
    p_user_id,
    pg_catalog.jsonb_build_object(
      'provider', v_row.provider,
      'email_address', v_row.email_address,
      'status', v_row.status,
      'backfill_from', v_row.backfill_from
    ),
    pg_catalog.jsonb_build_object(
      'provider', v_row.provider,
      'email_address', v_row.email_address,
      'status', v_row.status,
      'backfill_from', p_backfill_from
    ),
    pg_catalog.format('Brevlådans sökfönster ändrat: %s (%s)', v_row.email_address, v_row.provider),
    'user',
    NULL
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.update_mail_connection_backfill_with_audit(uuid, uuid, uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_mail_connection_backfill_with_audit(uuid, uuid, uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.update_mail_connection_backfill_with_audit(uuid, uuid, uuid, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_mail_connection_backfill_with_audit(uuid, uuid, uuid, date) TO service_role;

CREATE OR REPLACE FUNCTION public.disconnect_mail_connection_with_audit(
  p_company_id uuid,
  p_connection_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_row public.mail_connections%ROWTYPE;
BEGIN
  IF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = p_user_id
      AND cm.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'Writable company membership required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.mail_connections mc
  WHERE mc.id = p_connection_id
    AND mc.company_id = p_company_id
  FOR UPDATE;

  IF v_row.id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.mail_connections
  WHERE id = v_row.id;

  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    old_state,
    new_state,
    description,
    actor_type,
    actor_label
  )
  VALUES (
    p_user_id,
    p_company_id,
    'DELETE',
    'mail_connections',
    v_row.id,
    p_user_id,
    pg_catalog.jsonb_build_object(
      'provider', v_row.provider,
      'email_address', v_row.email_address,
      'status', v_row.status,
      'backfill_from', v_row.backfill_from
    ),
    NULL,
    pg_catalog.format('Brevlåda frånkopplad: %s (%s)', v_row.email_address, v_row.provider),
    'user',
    NULL
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.disconnect_mail_connection_with_audit(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.disconnect_mail_connection_with_audit(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.disconnect_mail_connection_with_audit(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.disconnect_mail_connection_with_audit(uuid, uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
