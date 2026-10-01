-- ===========================================================================
-- Cheques físicos y electrónicos (eCheq)
-- ===========================================================================
-- Migración sugerida: cheques_electronicos
--
-- Al cobrar, el cheque físico y el eCheq se eligen como dos medios distintos;
-- en la cartera y en los listados van todos juntos, con una marca que dice
-- cuál es cuál. Es la misma cartera: un eCheq se deposita, se acredita, se
-- endosa o se rechaza igual que uno de papel; lo que cambia es cómo se maneja
-- afuera (en el home banking y no en la mano), y eso hay que verlo de un
-- vistazo.

alter table third_party_checks add column if not exists electronico boolean not null default false;

-- Las dos funciones que dan de alta cheques pasan a guardar la marca. Se
-- regeneran desde la definición vigente con reemplazos exactos.
do $$
declare
  def text;
  nueva text;
begin
  -- Cobranza: el cheque llega como valor del recibo.
  select replace(pg_get_functiondef('public.save_receipt'::regproc), chr(13), '') into def;
  if def not like '%electronico%' then
    nueva := replace(def,
      'number, bank_name, drawer, issue_date, due_date, amount, status, created_by
      )',
      'number, bank_name, drawer, issue_date, due_date, amount, status, created_by, electronico
      )');
    nueva := replace(nueva,
      '''EN_CARTERA'', auth.uid()
      )
      returning third_party_checks.id into v_check_id;',
      '''EN_CARTERA'', auth.uid(), coalesce((v_value->>''check_electronico'')::boolean, false)
      )
      returning third_party_checks.id into v_check_id;');
    if nueva = def or nueva not like '%check_electronico%' then
      raise exception 'No encontré el alta del cheque en save_receipt';
    end if;
    execute nueva;
  end if;

  -- Alta suelta desde la pantalla de Cheques.
  select replace(pg_get_functiondef('public.receive_check'::regproc), chr(13), '') into def;
  if def not like '%electronico%' then
    nueva := replace(def,
      'status, received_movement_id, notes, created_by
  )',
      'status, received_movement_id, notes, created_by, electronico
  )');
    nueva := replace(nueva,
      'nullif(trim(coalesce(p_check->>''notes'', '''')), ''''), auth.uid()
  )',
      'nullif(trim(coalesce(p_check->>''notes'', '''')), ''''), auth.uid(),
    coalesce((p_check->>''electronico'')::boolean, false)
  )');
    nueva := replace(nueva,
      '''Cheque '' || (p_check->>''number'')',
      'case when coalesce((p_check->>''electronico'')::boolean, false) then ''eCheq '' else ''Cheque '' end || (p_check->>''number'')');
    if nueva = def or nueva not like '%(p_check->>''electronico'')::boolean, false)%' then
      raise exception 'No encontré el alta del cheque en receive_check';
    end if;
    execute nueva;
  end if;
end $$;

select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'third_party_checks' and column_name = 'electronico') as columna,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('save_receipt', 'receive_check')
      and p.prosrc like '%electronico%') as funciones;
