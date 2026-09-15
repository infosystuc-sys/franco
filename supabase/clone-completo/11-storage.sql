-- ===========================================================================
-- Buckets de Storage y sus políticas
-- ===========================================================================
-- Los 4 buckets son privados (public = false): todo pasa por RLS, nunca por
-- una URL pública. Corré esto conectado como owner del proyecto — insertar en
-- storage.buckets a mano funciona igual que crearlos desde el dashboard.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('purchase-invoice-drafts', 'purchase-invoice-drafts', false, null, null),
  ('vehicle-intakes', 'vehicle-intakes', false, null, null),
  ('vehicle-photos', 'vehicle-photos', false, null, null),
  ('work-order-photos', 'work-order-photos', false, null, null)
ON CONFLICT (id) DO NOTHING;

-- ── Políticas sobre storage.objects ────────────────────────────────────────
-- Un mismo patrón repetido por bucket: admin sube y borra; la lectura varía
-- según qué tan sensible es el contenido de cada uno.

CREATE POLICY "admin delete intake photos" ON storage.objects AS PERMISSIVE FOR DELETE TO public USING (((bucket_id = 'vehicle-intakes'::text) AND is_admin()));
CREATE POLICY "admin delete purchase drafts" ON storage.objects AS PERMISSIVE FOR DELETE TO public USING (((bucket_id = 'purchase-invoice-drafts'::text) AND is_admin()));
CREATE POLICY "admin delete vehicle photos" ON storage.objects AS PERMISSIVE FOR DELETE TO public USING (((bucket_id = 'vehicle-photos'::text) AND is_admin()));
CREATE POLICY "admin delete work order photos" ON storage.objects AS PERMISSIVE FOR DELETE TO public USING (((bucket_id = 'work-order-photos'::text) AND is_admin()));
CREATE POLICY "admin read intake photos" ON storage.objects AS PERMISSIVE FOR SELECT TO public USING (((bucket_id = 'vehicle-intakes'::text) AND is_admin()));
CREATE POLICY "admin read purchase drafts" ON storage.objects AS PERMISSIVE FOR SELECT TO public USING (((bucket_id = 'purchase-invoice-drafts'::text) AND is_admin()));
CREATE POLICY "admin upload intake photos" ON storage.objects AS PERMISSIVE FOR INSERT TO public WITH CHECK (((bucket_id = 'vehicle-intakes'::text) AND is_admin()));
CREATE POLICY "admin upload purchase drafts" ON storage.objects AS PERMISSIVE FOR INSERT TO public WITH CHECK (((bucket_id = 'purchase-invoice-drafts'::text) AND is_admin()));
CREATE POLICY "admin upload vehicle photos" ON storage.objects AS PERMISSIVE FOR INSERT TO public WITH CHECK (((bucket_id = 'vehicle-photos'::text) AND is_admin()));
CREATE POLICY "admin upload work order photos" ON storage.objects AS PERMISSIVE FOR INSERT TO public WITH CHECK (((bucket_id = 'work-order-photos'::text) AND is_admin()));
CREATE POLICY "lectura autenticada vehicle photos" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING ((bucket_id = 'vehicle-photos'::text));
CREATE POLICY "lectura segun rol" ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING (((bucket_id = 'work-order-photos'::text) AND (EXISTS ( SELECT 1
   FROM work_orders wo
  WHERE (((wo.id)::text = (storage.foldername(objects.name))[1]) AND (is_admin() OR (wo.employee_id = current_employee_id())))))));
