-- WP5 M1 VAT liability-start identity.
-- Symbolic draft: allocate a numeric migration version only at candidate freeze.

ALTER TABLE public.company_settings
  ADD COLUMN vat_liability_start_date date;

COMMENT ON COLUMN public.company_settings.vat_liability_start_date IS
  'Authoritative evidenced date from which the company is liable to report Swedish VAT. NULL means no liability-start date has been recorded.';

NOTIFY pgrst, 'reload schema';
