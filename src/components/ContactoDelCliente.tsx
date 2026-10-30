import { Mail, MessageCircle, Phone } from 'lucide-react';

/**
 * El número para un link de WhatsApp (wa.me): solo dígitos y con el 549 de
 * un celular argentino. Se cargan de muchas formas ("0381 15-412-3456",
 * "+54 9 381…", "3814123456"): se saca el 0 de larga distancia y el 15 del
 * celular, y se agrega lo que falte del prefijo del país.
 */
export function numeroDeWhatsapp(telefono: string): string | null {
  let d = telefono.replace(/\D/g, '');
  if (d.length < 8) return null;
  if (d.startsWith('549')) return d;
  if (d.startsWith('54')) return `549${d.slice(2)}`;
  if (d.startsWith('0')) d = d.slice(1);
  // Código de área de 2 a 4 cifras seguido del 15 del celular.
  const con15 = d.match(/^(\d{2,4})15(\d{6,8})$/);
  if (con15 && con15[1].length + con15[2].length === 10) d = con15[1] + con15[2];
  return d.length === 10 ? `549${d}` : d;
}

/**
 * Teléfono y mail de un contacto, listos para usar: llamar, abrir el chat de
 * WhatsApp o escribir un mail sin salir de la pantalla. Para cuando hay que
 * hablar con el cliente desde la orden o la composición de saldos.
 */
export function ContactoDelCliente({
  titulo,
  responsable,
  phone,
  email,
  className,
}: {
  titulo?: string;
  responsable?: string | null;
  phone: string | null;
  email: string | null;
  className?: string;
}) {
  if (!phone && !email && !responsable) return null;
  const wa = phone ? numeroDeWhatsapp(phone) : null;
  const enlace = 'inline-flex items-center gap-1 text-accent-deep hover:underline';
  return (
    <div className={className}>
      {titulo && (
        <span className="mb-0.5 block text-[12px] font-semibold uppercase tracking-[0.06em] text-text-faint">{titulo}</span>
      )}
      {responsable && <span className="block text-xs text-text">{responsable}</span>}
      {phone && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm">
          <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className={enlace} title="Llamar">
            <Phone size={13} /> {phone}
          </a>
          {wa && (
            <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className={enlace} title="Abrir el chat de WhatsApp">
              <MessageCircle size={13} /> WhatsApp
            </a>
          )}
        </span>
      )}
      {email && (
        <a href={`mailto:${email}`} className={`${enlace} break-all text-sm`} title="Escribir un mail">
          <Mail size={13} /> {email}
        </a>
      )}
    </div>
  );
}
