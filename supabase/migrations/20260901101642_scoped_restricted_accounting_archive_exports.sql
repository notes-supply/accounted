-- Scoped read boundaries for accounting evidence tables whose direct table
-- privileges are intentionally revoked from every API role.

CREATE OR REPLACE FUNCTION public.export_supplier_payment_reversals(
  p_company_id uuid
)
RETURNS SETOF public.supplier_payment_reversals
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT reversal.*
  FROM public.supplier_payment_reversals reversal
  WHERE reversal.company_id = p_company_id;
$function$;

CREATE OR REPLACE FUNCTION public.export_transaction_categorization_compensations(
  p_company_id uuid
)
RETURNS SETOF public.transaction_categorization_compensations
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT compensation.*
  FROM public.transaction_categorization_compensations compensation
  WHERE compensation.company_id = p_company_id;
$function$;

CREATE OR REPLACE FUNCTION public.export_accounting_publications(
  p_company_id uuid
)
RETURNS SETOF public.accounting_publications
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT publication.*
  FROM public.accounting_publications publication
  WHERE publication.company_id = p_company_id;
$function$;

CREATE OR REPLACE FUNCTION public.export_accounting_publication_subscribers(
  p_company_id uuid
)
RETURNS SETOF public.accounting_publication_subscribers
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT subscriber.*
  FROM public.accounting_publication_subscribers subscriber
  WHERE subscriber.company_id = p_company_id;
$function$;

REVOKE ALL ON FUNCTION public.export_supplier_payment_reversals(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.export_transaction_categorization_compensations(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.export_accounting_publications(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.export_accounting_publication_subscribers(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.export_supplier_payment_reversals(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.export_transaction_categorization_compensations(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.export_accounting_publications(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.export_accounting_publication_subscribers(uuid)
  TO service_role;

COMMENT ON FUNCTION public.export_supplier_payment_reversals(uuid) IS
  'Service-only company-scoped archive export for immutable supplier payment reversal commands.';
COMMENT ON FUNCTION public.export_transaction_categorization_compensations(uuid) IS
  'Service-only company-scoped archive export for immutable transaction categorization compensations.';
COMMENT ON FUNCTION public.export_accounting_publications(uuid) IS
  'Service-only company-scoped archive export for durable accounting publication evidence.';
COMMENT ON FUNCTION public.export_accounting_publication_subscribers(uuid) IS
  'Service-only company-scoped archive export for durable accounting publication subscriber snapshots.';

NOTIFY pgrst, 'reload schema';
