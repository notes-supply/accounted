-- Keep the ignored-state transition inside the guarded categorization command.
-- The attachment RPC grants this capability only for its exact company and
-- transaction immediately around the compare-and-set update.

CREATE OR REPLACE FUNCTION public.normalize_categorization_attachment_ignored_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
     AND NEW.journal_entry_id IS NOT NULL
     AND accounting_private.has_accounting_command_capability(
       'transaction_categorization_attach', OLD.company_id, OLD.id
     ) THEN
    NEW.is_ignored := false;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER normalize_categorization_attachment_ignored_state
  BEFORE UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.normalize_categorization_attachment_ignored_state();

REVOKE ALL ON FUNCTION public.normalize_categorization_attachment_ignored_state()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.normalize_categorization_attachment_ignored_state() IS
  'Atomically clears is_ignored only while attach_transaction_categorization holds its exact scoped capability.';

NOTIFY pgrst, 'reload schema';
