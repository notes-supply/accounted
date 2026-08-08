-- The first VAT reporting period can begin after the fiscal period itself.
-- Keep the legal liability date explicit instead of inferring it from company
-- formation, the fiscal-year start, or the date the registration was issued.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS vat_liability_start_date date;

COMMENT ON COLUMN public.company_settings.vat_liability_start_date IS
  'First date covered by the company VAT registration decision. Clamps the first VAT reporting period.';

NOTIFY pgrst, 'reload schema';
