-- Upgrade-path fixture: a small but REAL company, seeded against the schema as
-- it stood BEFORE the pull request's migrations.
--
-- Why this exists
-- ---------------
-- The `pg-real` job applies all migrations to an EMPTY database. Empty means
-- zero rows, so a migration that adds a NOT NULL, adds a CHECK, creates a
-- unique index or backfills passes trivially in CI and can still fail (or
-- silently corrupt) on production, where the rows exist. This fixture gives the
-- new migrations something to break.
--
-- Deliberately narrow: only long-stable core tables, because this file has to
-- execute against an OLDER schema than the one in the working tree. Anything
-- newer than the merge-base does not exist yet. Adding a column reference here
-- to a recently-added column will make the job fail on every PR, not just the
-- bad ones. If a new table needs upgrade coverage, add it here only once it has
-- been in main long enough that the merge-base always has it.
--
-- CI FIXTURE ONLY. NEVER a template for real data.
-- ------------------------------------------------
-- The inserts below write `journal_entries` with status='posted' and their
-- lines directly, bypassing lib/bookkeeping/engine.ts and the atomic
-- commit_journal_entry RPC. That is legitimate here and ONLY here: this runs
-- against a throwaway CI database that is destroyed with the job, so there is
-- no verifikationsnummer sequence to keep gapless and no retention obligation
-- (BFL 5 kap 6-7 §). Seeding this way is the only way to hand the migrations
-- pre-existing posted rows to break.
--
-- Do not copy this pattern into a seed script, a migration, a repair script, or
-- anything that touches a real database. Every production journal write goes
-- through the engine (CLAUDE.md Hard Rule 2). If you need posted entries in a
-- real database, use the engine.
--
-- Fixed UUIDs so assert.sql can find the rows without threading state.

BEGIN;

INSERT INTO auth.users (id, email, instance_id)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'pg-upgrade@test.invalid',
  '00000000-0000-0000-0000-000000000000'::uuid
);

INSERT INTO public.companies (id, name, entity_type, created_by)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  'Uppgraderingsbolaget AB',
  'aktiebolag',
  '11111111-1111-1111-1111-111111111111'
);

INSERT INTO public.company_members (company_id, user_id, role)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'owner'
);

INSERT INTO public.fiscal_periods
  (id, user_id, company_id, name, period_start, period_end, is_closed)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '2026',
  '2026-01-01',
  '2026-12-31',
  FALSE
);

-- Minimal stable AP prerequisites for the pre-existing payment allocations
-- below. Every named column existed before the migration under test.
INSERT INTO public.suppliers
  (id, user_id, company_id, name)
VALUES (
  '55555555-5555-5555-5555-555555555555',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  'Uppgraderingsleverantören AB'
);

INSERT INTO public.supplier_invoices
  (id, user_id, company_id, supplier_id, arrival_number,
   supplier_invoice_number, invoice_date, due_date, received_date, status,
   currency, subtotal, vat_amount, total, paid_amount, remaining_amount,
   vat_treatment, reverse_charge, is_credit_note)
VALUES (
  '66666666-6666-6666-6666-666666666666',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '55555555-5555-5555-5555-555555555555',
  900001,
  'UPGRADE-LF-1',
  '2026-04-01',
  '2026-04-30',
  '2026-04-01',
  'paid',
  'SEK',
  123.45,
  0,
  123.45,
  123.45,
  0,
  'standard_25',
  FALSE,
  FALSE
);

-- Four posted verifikat with balanced lines. Posted (not draft) is the point:
-- these are the rows a careless migration corrupts, and the ones the
-- immutability triggers protect. Voucher 4 is a realistic supplier payment
-- anchor for the retained allocations.
INSERT INTO public.journal_entries
  (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
   entry_date, description, source_type, status)
VALUES
  ('44444444-4444-4444-4444-444444444401',
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333',
   1, 'A', '2026-03-01', 'Försäljning', 'manual', 'posted'),
  ('44444444-4444-4444-4444-444444444402',
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333',
   2, 'A', '2026-03-15', 'Lokalhyra', 'manual', 'posted'),
  ('44444444-4444-4444-4444-444444444403',
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333',
   3, 'A', '2026-04-01', 'Bankavgift', 'manual', 'posted'),
  ('44444444-4444-4444-4444-444444444404',
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333',
   4, 'A', '2026-04-15', 'Leverantörsbetalning',
   'supplier_invoice_paid', 'posted');

INSERT INTO public.journal_entry_lines
  (journal_entry_id, account_number, debit_amount, credit_amount)
VALUES
  ('44444444-4444-4444-4444-444444444401', '1930', 12500.00, 0),
  ('44444444-4444-4444-4444-444444444401', '3001', 0, 10000.00),
  ('44444444-4444-4444-4444-444444444401', '2611', 0, 2500.00),
  ('44444444-4444-4444-4444-444444444402', '5010', 8000.00, 0),
  ('44444444-4444-4444-4444-444444444402', '1930', 0, 8000.00),
  -- An öre-level amount, so a migration that rounds or retypes the money
  -- columns shows up in the assertion instead of passing on round numbers.
  ('44444444-4444-4444-4444-444444444403', '6570', 123.45, 0),
  ('44444444-4444-4444-4444-444444444403', '1930', 0, 123.45),
  ('44444444-4444-4444-4444-444444444404', '2440', 123.45, 0),
  ('44444444-4444-4444-4444-444444444404', '1930', 0, 123.45);

-- The old schema allowed multiple rows for the same journal-entry/invoice
-- pair. Preserve that legal history during upgrade rather than enforcing a new
-- unique index over existing rows. The new trigger prevents future active
-- duplicates without rewriting these allocations.
INSERT INTO public.supplier_invoice_payments
  (id, user_id, company_id, supplier_invoice_id, payment_date, amount,
   currency, exchange_rate, exchange_rate_difference, journal_entry_id,
   transaction_id, notes, created_at)
VALUES
  ('77777777-7777-7777-7777-777777777701',
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '66666666-6666-6666-6666-666666666666',
   '2026-04-15', 100.00, 'SEK', NULL, 0,
   '44444444-4444-4444-4444-444444444404',
   NULL, 'Upgrade allocation 1', '2026-04-15T12:00:00Z'),
  ('77777777-7777-7777-7777-777777777702',
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '66666666-6666-6666-6666-666666666666',
   '2026-04-15', 23.45, 'SEK', NULL, 0,
   '44444444-4444-4444-4444-444444444404',
   NULL, 'Upgrade allocation 2', '2026-04-15T12:01:00Z');

COMMIT;
