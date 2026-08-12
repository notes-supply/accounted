-- Reconcile the legacy message::attachment mail-hunt key with the current
-- provider::connection::message::attachment identity without collapsing two
-- connections that happen to reuse the same provider ids.

WITH legacy_rows AS (
  SELECT
    i.id,
    i.company_id,
    i.channel_context->>'mail_provider' AS provider,
    i.channel_context->>'mail_mailbox' AS mailbox,
    i.channel_context->>'mail_message_id' AS message_id,
    COALESCE(i.channel_context->>'mail_attachment_id', '') AS attachment_id
  FROM public.invoice_inbox_items i
  WHERE i.source = 'mail_hunt'
    AND i.channel_context ? 'mail_message_id'
    AND i.channel_context->>'mail_file_key' =
      (i.channel_context->>'mail_message_id') || '::' ||
      COALESCE(i.channel_context->>'mail_attachment_id', '')
), uniquely_resolved AS (
  SELECT
    legacy.id,
    legacy.provider,
    legacy.message_id,
    legacy.attachment_id,
    min(connection.id::text)::uuid AS connection_id
  FROM legacy_rows legacy
  JOIN public.mail_connections connection
    ON connection.company_id = legacy.company_id
   AND connection.provider = legacy.provider
   AND lower(connection.email_address) = lower(legacy.mailbox)
  GROUP BY legacy.id, legacy.provider, legacy.message_id, legacy.attachment_id
  HAVING count(*) = 1
)
UPDATE public.invoice_inbox_items inbox
SET channel_context = inbox.channel_context || jsonb_build_object(
      'mail_connection_id', resolved.connection_id::text,
      'mail_file_key',
        resolved.provider || '::' || resolved.connection_id::text || '::' ||
        resolved.message_id || '::' || resolved.attachment_id
    )
FROM uniquely_resolved resolved
WHERE inbox.id = resolved.id
  AND NOT EXISTS (
    SELECT 1
    FROM public.invoice_inbox_items current_row
    WHERE current_row.company_id = inbox.company_id
      AND current_row.source = 'mail_hunt'
      AND current_row.id <> inbox.id
      AND current_row.channel_context->>'mail_file_key' =
        resolved.provider || '::' || resolved.connection_id::text || '::' ||
        resolved.message_id || '::' || resolved.attachment_id
  );

-- Anything still carrying the imported legacy key could not be bound to one
-- exact tenant-scoped connection. Keep that key as a compatibility alias.
-- Current rows never receive this alias, so equal ids in two new connections
-- remain independent.
UPDATE public.invoice_inbox_items inbox
SET channel_context = inbox.channel_context || jsonb_build_object(
      'mail_legacy_file_key', inbox.channel_context->>'mail_file_key'
    )
WHERE inbox.source = 'mail_hunt'
  AND inbox.channel_context ? 'mail_message_id'
  AND inbox.channel_context->>'mail_file_key' =
    (inbox.channel_context->>'mail_message_id') || '::' ||
    COALESCE(inbox.channel_context->>'mail_attachment_id', '')
  AND NOT (inbox.channel_context ? 'mail_legacy_file_key');

CREATE INDEX IF NOT EXISTS idx_invoice_inbox_mail_legacy_file
  ON public.invoice_inbox_items (
    company_id,
    ((channel_context->>'mail_legacy_file_key'))
  )
  WHERE source = 'mail_hunt'
    AND channel_context ? 'mail_legacy_file_key';

NOTIFY pgrst, 'reload schema';
