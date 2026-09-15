-- ===========================================================================
-- Datos de configuración imprescindibles para que la app arranque
-- ===========================================================================
-- Esto NO es un clon de los datos de negocio (clientes, vehículos, OT,
-- facturas...). Es solo lo que el código da por sentado que existe: los
-- estados de la OT (el circuito entero depende de ellos, varias funciones
-- los buscan por system_key), sus plantillas de mensaje, las alícuotas de
-- IVA/percepciones, y un puñado de preferencias en app_settings.
--
-- Lo que NO se incluye a propósito, porque es identidad de ESTE taller y no
-- del sistema: company_settings (razón social, CUIT, punto de venta),
-- bancos, medios de pago, conceptos de gasto, tipos de pieza. Se cargan
-- desde la propia app (Configuración, Tesorería, Inventario) la primera vez
-- que se usa cada pantalla — son un par de clics, no ameritan SQL.

-- ── Estados de la OT (se reusan los mismos UUID: no hay problema en que
--    dos proyectos de Supabase distintos tengan filas con el mismo id) ─────
INSERT INTO public.work_order_statuses
  (id, label, client_description, color, sort_order, active, is_initial, is_terminal, notifies_client, frees_yard, system_key)
VALUES
  ('f778f5bd-9885-4d3c-a307-8618f81946d7', 'Ingresado', 'Recibimos el vehículo en el taller.', '#4a6fa5', 1, true, true, false, false, false, 'INGRESADO'),
  ('c5d66bbd-a1fe-4a3b-94c3-71483ac5f87d', 'Cotizado', 'Te enviamos el presupuesto y esperamos tu respuesta.', '#e07b1a', 2, true, false, false, false, false, 'COTIZADO'),
  ('c6bfe8c5-e755-4ca9-8846-9127479799e7', 'Autorizada', 'El cliente autorizó el trabajo. Se procederá con la reparación.', '#2b6cb0', 3, true, false, false, false, false, 'AUTORIZADA'),
  ('d2c4ac91-3ad7-4f1f-b070-7b579fc0042f', 'Esp. Repuestos', 'Se están gestionando los repuestos necesarios.', '#e07b1a', 4, true, false, false, false, false, null),
  ('e720ea02-6c62-43ac-9ae7-a7174d8d2009', 'En Reparación', 'El componente está siendo reparado en el taller.', '#7b3fa0', 5, true, false, false, false, false, null),
  ('40e783ed-7d80-4f7b-813f-f1cdf86b740c', 'Calibración', 'Se está calibrando y probando el componente reparado.', '#c9a227', 6, true, false, false, false, false, null),
  ('deb84bea-1b20-4fbe-ab39-41860275d768', 'Terminado', 'El servicio finalizó. Listo para retirar.', '#2e7d32', 7, true, false, true, true, false, 'TERMINADO'),
  ('e94c16f9-45d1-4591-9e3e-8c92ff84756a', 'desarmado y evaluacion', 'desarmado y evaluacion', '#e28112', 8, true, false, false, false, false, null),
  ('71da435c-3f45-4253-bda4-41c20a7e4b49', 'Retirado', 'El vehículo fue retirado del taller.', '#5b6470', 9, true, false, true, false, true, 'RETIRADO'),
  ('76d5311c-3cc9-4eed-94b5-cc2d351cc928', 'Rechazada', 'El presupuesto no fue aceptado.', '#8a8f98', 10, true, false, false, false, true, 'RECHAZADA');

-- ── Plantillas de WhatsApp por estado (solo los que avisan al cliente) ─────
INSERT INTO public.notification_templates (status_id, body) VALUES
  ('c6bfe8c5-e755-4ca9-8846-9127479799e7', 'Su trabajo quedó autorizado y entró al taller. Le vamos a ir avisando cómo avanza.'),
  ('d2c4ac91-3ad7-4f1f-b070-7b579fc0042f', 'Estamos gestionando los repuestos necesarios para su reparación.'),
  ('e720ea02-6c62-43ac-9ae7-a7174d8d2009', 'Empezamos la reparación de su componente.'),
  ('40e783ed-7d80-4f7b-813f-f1cdf86b740c', 'Terminamos la reparación y estamos calibrando y probando el componente en banco.'),
  ('deb84bea-1b20-4fbe-ab39-41860275d768', 'Su componente está listo para retirar. Lo esperamos en el taller.');

-- ── Alícuotas de IVA y percepciones ────────────────────────────────────────
INSERT INTO public.tax_rates (kind, name, rate, base, jurisdiction, vat_treatment, active) VALUES
  ('IVA', 'Exento', 0.000, 'NETO', null, 'EXENTO', true),
  ('IVA', 'IVA 0%', 0.000, 'NETO', null, 'GRAVADO', true),
  ('IVA', 'IVA 10,5%', 10.500, 'NETO', null, 'GRAVADO', true),
  ('IVA', 'IVA 2,5%', 2.500, 'NETO', null, 'GRAVADO', true),
  ('IVA', 'IVA 21%', 21.000, 'NETO', null, 'GRAVADO', true),
  ('IVA', 'IVA 27%', 27.000, 'NETO', null, 'GRAVADO', true),
  ('IVA', 'IVA 5%', 5.000, 'NETO', null, 'GRAVADO', true),
  ('IVA', 'No gravado', 0.000, 'NETO', null, 'NO_GRAVADO', true),
  ('PERCEPCION', 'Perc.IB.Gral.Tucuman', 3.500, 'NETO', null, null, true);

-- ── Preferencias del sistema ────────────────────────────────────────────────
-- whatsapp_test_phone y public_base_url son propios de la instancia: se
-- dejan en blanco/placeholder a propósito. El resto son valores razonables
-- para arrancar.
INSERT INTO public.app_settings (key, value) VALUES
  ('ai_provider', 'GEMINI'),
  ('default_markup_percent', '40'),
  ('public_base_url', 'https://CAMBIAR-por-la-url-del-proyecto-nuevo.vercel.app'),
  ('whatsapp_enabled', 'false'),
  ('whatsapp_test_mode', 'true'),
  ('whatsapp_test_phone', ''),
  ('yard_cells', '0');
