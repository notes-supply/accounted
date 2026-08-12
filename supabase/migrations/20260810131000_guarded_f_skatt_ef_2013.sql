-- Repair the two exact seeded EF F-tax identities. Company-authored rows are
-- excluded by authoritative provenance and every seeded field is shape-guarded.

DO $$
DECLARE
  matching_count INTEGER;
  old_lines JSONB := '[
    {"account": "2012", "label": "Egna skatter", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1630", "label": "Skattekonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb;
  new_lines JSONB := '[
    {"account": "2013", "label": "Egna skatter", "side": "debit", "type": "business", "ratio": 1.0},
    {"account": "1630", "label": "Skattekonto", "side": "credit", "type": "settlement", "ratio": 1.0}
  ]'::jsonb;
BEGIN
  SELECT count(*) INTO matching_count
  FROM public.booking_template_library
  WHERE is_system = true
    AND company_id IS NULL
    AND team_id IS NULL
    AND pack_slug = 'preliminar-f-skatt-ef'
    AND name = 'Preliminär F-skatt (EF)'
    AND description = 'Betalning av preliminär F-skatt från skattekontot (enskild firma).'
    AND category = 'tax_account'
    AND entity_type = 'enskild_firma'
    AND is_active = true
    AND lines IN (old_lines, new_lines);

  IF matching_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one guarded EF F-tax system template, found %', matching_count;
  END IF;

  UPDATE public.booking_template_library
  SET lines = new_lines
  WHERE is_system = true
    AND company_id IS NULL
    AND team_id IS NULL
    AND pack_slug = 'preliminar-f-skatt-ef'
    AND name = 'Preliminär F-skatt (EF)'
    AND description = 'Betalning av preliminär F-skatt från skattekontot (enskild firma).'
    AND category = 'tax_account'
    AND entity_type = 'enskild_firma'
    AND is_active = true
    AND lines = old_lines;
END;
$$;

DO $$
DECLARE
  matching_count INTEGER;
BEGIN
  SELECT count(*) INTO matching_count
  FROM public.skattekonto_rules
  WHERE company_id IS NULL
    AND priority = 20
    AND pattern = 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt'
    AND amount_min IS NULL
    AND amount_max IS NULL
    AND company_type = 'all'
    AND counter_account = '2510'
    AND counter_account_ef IN ('2012', '2013')
    AND label = 'Preliminär skatt'
    AND active = true;

  IF matching_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one guarded Skattekonto F-tax system rule, found %', matching_count;
  END IF;

  UPDATE public.skattekonto_rules
  SET counter_account_ef = '2013'
  WHERE company_id IS NULL
    AND priority = 20
    AND pattern = 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt'
    AND amount_min IS NULL
    AND amount_max IS NULL
    AND company_type = 'all'
    AND counter_account = '2510'
    AND counter_account_ef = '2012'
    AND label = 'Preliminär skatt'
    AND active = true;
END;
$$;
