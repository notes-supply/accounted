-- Close viewer writes on extension connection state and mileage trips while
-- preserving the existing member read policies and service-role RLS bypass.
-- Every write is scoped to the caller's exact active company and an exact
-- writable membership. Matching UPDATE predicates prevent tenant row moves.

DROP POLICY IF EXISTS "members insert shopify_connections" ON public.shopify_connections;
CREATE POLICY "members insert shopify_connections"
  ON public.shopify_connections FOR INSERT TO authenticated
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS "members update shopify_connections" ON public.shopify_connections;
CREATE POLICY "members update shopify_connections"
  ON public.shopify_connections FOR UPDATE TO authenticated
  USING (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
  )
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
  );

DROP POLICY IF EXISTS "members insert woocommerce_connections" ON public.woocommerce_connections;
CREATE POLICY "members insert woocommerce_connections"
  ON public.woocommerce_connections FOR INSERT TO authenticated
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS "members update woocommerce_connections" ON public.woocommerce_connections;
CREATE POLICY "members update woocommerce_connections"
  ON public.woocommerce_connections FOR UPDATE TO authenticated
  USING (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
  )
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
  );

DROP POLICY IF EXISTS "insert own-company mileage_trips" ON public.mileage_trips;
CREATE POLICY "insert own-company mileage_trips"
  ON public.mileage_trips FOR INSERT TO authenticated
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
  );

DROP POLICY IF EXISTS "update own-company mileage_trips" ON public.mileage_trips;
CREATE POLICY "update own-company mileage_trips"
  ON public.mileage_trips FOR UPDATE TO authenticated
  USING (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
  )
  WITH CHECK (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
  );

DROP POLICY IF EXISTS "delete own-company mileage_trips" ON public.mileage_trips;
CREATE POLICY "delete own-company mileage_trips"
  ON public.mileage_trips FOR DELETE TO authenticated
  USING (
    company_id = public.current_active_company_id()
    AND public.caller_can_write_company(company_id)
  );

NOTIFY pgrst, 'reload schema';
