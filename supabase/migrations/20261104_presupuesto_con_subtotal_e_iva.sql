-- Presupuestos: el mensaje muestra subtotal, IVA y total.
--
-- El WhatsApp de "Enviar para autorizar" y los textos con que se manda el PDF
-- del presupuesto decían solo el total con IVA. Ahora llevan el subtotal, el
-- IVA y el total. Se agregan las variables {subtotal} e {iva}.
--
-- Los textos se tocan solo donde siguen diciendo lo de antes: si alguien ya
-- los cambió desde Configuración, se respeta lo suyo (las variables nuevas
-- quedan disponibles para agregarlas a mano).

-- ---------------------------------------------------------------------------
-- enviar_cotizacion_para_autorizar: pasa subtotal e IVA a la plantilla
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_nuevo text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'enviar_cotizacion_para_autorizar';
  v_def := replace(v_def, chr(13), '');
  if position('''subtotal''' in v_def) > 0 then
    return;
  end if;
  v_nuevo := replace(v_def,
    '''total'', to_char(v_total, ''FM999999990.00''),',
    '''subtotal'', to_char(round(v_total / 1.21, 2), ''FM999999990.00''),
    ''iva'', to_char(v_total - round(v_total / 1.21, 2), ''FM999999990.00''),
    ''total'', to_char(v_total, ''FM999999990.00''),');
  if v_nuevo = v_def then
    raise exception 'No se encontró el total en el mensaje de enviar_cotizacion_para_autorizar';
  end if;
  execute v_nuevo;
end $$;

-- ---------------------------------------------------------------------------
-- Los textos
-- ---------------------------------------------------------------------------
update plantillas_mensaje
   set cuerpo = replace(cuerpo, E'Total: $ {total}\n', E'Subtotal: $ {subtotal}\nIVA 21%: $ {iva}\nTotal: $ {total}\n')
 where clave = 'cotizacion_autorizar' and cuerpo not like '%{subtotal}%';
update plantillas_mensaje
   set cuerpo_original = replace(cuerpo_original, E'Total: $ {total}\n', E'Subtotal: $ {subtotal}\nIVA 21%: $ {iva}\nTotal: $ {total}\n')
 where clave = 'cotizacion_autorizar' and cuerpo_original not like '%{subtotal}%';

update plantillas_mensaje
   set cuerpo = case when cuerpo = cuerpo_original
                     then E'Adjuntamos el presupuesto {numero}.\n\nSubtotal: $ {subtotal}\nIVA 21%: $ {iva}\nTotal: $ {total}'
                     else cuerpo end,
       cuerpo_original = E'Adjuntamos el presupuesto {numero}.\n\nSubtotal: $ {subtotal}\nIVA 21%: $ {iva}\nTotal: $ {total}'
 where clave = 'presupuesto_mail' and cuerpo_original = 'Adjuntamos el presupuesto {numero} por $ {total}.';

update plantillas_mensaje
   set cuerpo = case when cuerpo = cuerpo_original
                     then E'Presupuesto {numero}\nSubtotal: $ {subtotal}\nIVA 21%: $ {iva}\nTotal: $ {total}'
                     else cuerpo end,
       cuerpo_original = E'Presupuesto {numero}\nSubtotal: $ {subtotal}\nIVA 21%: $ {iva}\nTotal: $ {total}'
 where clave = 'presupuesto_whatsapp' and cuerpo_original = 'Presupuesto {numero} — $ {total}';

select clave, cuerpo from plantillas_mensaje
 where clave in ('cotizacion_autorizar', 'presupuesto_mail', 'presupuesto_whatsapp');
