// VOY Bot · Multi-grupo · Twilio + Supabase (v3)
// Las credenciales van SOLO como variables de entorno en Railway. Nunca en el código.
const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const {
  TWILIO_SID, TWILIO_TOKEN,
  TWILIO_NUM = 'whatsapp:+14155238886',
  SUPABASE_URL, SUPABASE_SECRET_KEY,   // clave "secret" (sb_secret_...) — solo en el servidor
  PUBLIC_URL,                          // opcional: https://tu-bot.up.railway.app (valida que los mensajes vengan de Twilio)
} = process.env;
if (!TWILIO_SID || !TWILIO_TOKEN || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Faltan variables: TWILIO_SID, TWILIO_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY');
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
const tw = twilio(TWILIO_SID, TWILIO_TOKEN);
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const SECTORES = {
  norte: ['norte', 'usaquén', 'usaquen', 'unicentro', 'cedritos', 'colina', '127', '140', '170', '190'],
  occidente: ['occidente', 'salitre', 'can', 'fontibón', 'fontibon', 'kennedy', 'aeropuerto', 'dorado'],
  centro: ['centro', 'candelaria', 'chapinero', 'teusaquillo', 'cra 7', 'calle 26'],
  sur: ['sur', 'bosa', 'soacha', 'perdomo', 'ciudad bolívar'],
};
const sectorDe = txt => {
  const t = txt.toLowerCase();
  for (const [s, ps] of Object.entries(SECTORES)) if (ps.some(p => t.includes(p))) return s;
  return 'otro';
};
const wa = (num, body) => tw.messages.create({ from: TWILIO_NUM, to: `whatsapp:${num}`, body })
  .catch(e => console.error('Twilio:', num, e.message));
const norm = n => (n.startsWith('+') ? n : '+' + n).replace(/\s/g, '');

// Cada 15 s: a quien fue aprobado (por WhatsApp o desde el panel) se le envía la bienvenida
async function enviarBienvenidas() {
  const { data } = await db.from('miembros').select('id, whatsapp, grupos(nombre)')
    .eq('estado', 'activo').eq('bienvenida_enviada', false).limit(20);
  for (const m of data || []) {
    await db.from('miembros').update({ bienvenida_enviada: true }).eq('id', m.id);
    await wa(m.whatsapp, `✅ ¡Bienvenido a *${m.grupos?.nombre || 'VOY'}*!\nYa puedes usar:\n🟢 CUPO | hora | destino\n🙋 NECESITO | hora | destino\nEscribe AYUDA para ver todo.`);
  }
}
setInterval(() => enviarBienvenidas().catch(e => console.error('Bienvenidas:', e.message)), 15000);

app.post('/webhook', async (req, res) => {
  if (PUBLIC_URL) {
    const ok = twilio.validateRequest(TWILIO_TOKEN, req.header('X-Twilio-Signature') || '', PUBLIC_URL + '/webhook', req.body);
    if (!ok) return res.sendStatus(403);
  }
  res.sendStatus(200);
  try { await procesar(req.body); } catch (e) { console.error('Error:', e); }
});

async function procesar(body) {
  const from = body.From.replace('whatsapp:', '');
  const txt = (body.Body || '').trim();
  const cmd = txt.toUpperCase();

  // ── UNIRME <código> (también acepta ENTRAR / JOIN) ──
  if (/^(UNIRME|ENTRAR|JOIN)\s+\S+/i.test(txt)) {
    const codigo = txt.split(/\s+/)[1].toLowerCase();
    const { data: g } = await db.from('grupos').select('*').eq('codigo_invitacion', codigo).eq('activo', true).maybeSingle();
    if (!g) return wa(from, '❌ No existe un grupo con ese código.');
    const { data: ya } = await db.from('miembros').select('*').eq('grupo_id', g.id).eq('whatsapp', from).maybeSingle();
    if (ya) return wa(from, ya.estado === 'activo' ? `✅ Ya eres parte de ${g.nombre}.`
      : ya.estado === 'suspendido' ? '⏸ Tu acceso está suspendido. Habla con el administrador.'
      : `⏳ Tu solicitud a ${g.nombre} está pendiente de aprobación.`);
    await db.from('miembros').insert({ grupo_id: g.id, whatsapp: from, nombre: 'Sin nombre', estado: 'pendiente' });
    return wa(from, `📝 Solicitud a *${g.nombre}* iniciada.\nResponde con tu nombre y unidad, así:\n*Juan Pérez - Torre 3 Apto 402*`);
  }

  // ── Administrador: APROBAR / RECHAZAR <número> ──
  if (/^(APROBAR|RECHAZAR)\s+\S+/.test(cmd)) {
    const { data: g } = await db.from('grupos').select('*').eq('admin_whatsapp', from).maybeSingle();
    if (!g) return;
    const [accion, numRaw] = txt.split(/\s+/);
    const num = norm(numRaw);
    const { data: m } = await db.from('miembros').select('*').eq('grupo_id', g.id).eq('whatsapp', num).eq('estado', 'pendiente').maybeSingle();
    if (!m) return wa(from, `No encontré una solicitud pendiente de ${num}.`);
    if (accion.toUpperCase() === 'APROBAR') {
      await db.from('miembros').update({ estado: 'activo' }).eq('id', m.id);
      return wa(from, `✅ ${m.nombre} aprobado. Le avisaré en unos segundos.`);
    }
    await db.from('miembros').delete().eq('id', m.id);
    return wa(from, `✕ Solicitud de ${m.nombre} rechazada.`);
  }

  // ── ¿Es miembro activo? ──
  const { data: m } = await db.from('miembros').select('*, grupos(*)').eq('whatsapp', from).eq('estado', 'activo').limit(1).maybeSingle();
  if (!m) {
    const { data: p } = await db.from('miembros').select('*, grupos(*)').eq('whatsapp', from).eq('estado', 'pendiente').limit(1).maybeSingle();
    if (p && p.nombre === 'Sin nombre') {            // capturar nombre y unidad
      const [nombre, ...resto] = txt.split(/\s*[-–]\s*/);
      const unidad = resto.join(' - ').trim();
      await db.from('miembros').update({ nombre: nombre.trim().slice(0, 80), unidad: unidad.slice(0, 80) || null }).eq('id', p.id);
      if (p.grupos.admin_whatsapp) await wa(p.grupos.admin_whatsapp,
        `🔔 Nueva solicitud en ${p.grupos.nombre}\n${nombre.trim()}${unidad ? ' — ' + unidad : ''}\n${from}\n\nResponde: APROBAR ${from}\n(o apruébala en el panel)`);
      return wa(from, '⏳ Listo, el administrador revisará tu solicitud.');
    }
    if (p) return wa(from, '⏳ Tu solicitud sigue pendiente de aprobación.');
    return wa(from, '👋 Para usar VOY únete primero a tu grupo:\nunirme [código de tu conjunto o empresa]');
  }

  const g = m.grupos;
  const parts = txt.split('|').map(s => s.trim());
  const hora = parts[1] || 'ahora';
  const destino = parts[2] || parts[1] || txt;
  const sec = sectorDe(txt);
  const quien = x => `${x.miembros.nombre}${x.miembros.unidad ? ' (' + x.miembros.unidad + ')' : ''} — ${x.hora}`;

  if (/^(CUPO|🟢)/.test(cmd) || /^(NECESITO|🙋)/.test(cmd)) {
    const esCupo = /^(CUPO|🟢)/.test(cmd);
    const tipo = esCupo ? 'cupo' : 'necesito', opuesto = esCupo ? 'necesito' : 'cupo';
    await db.from('disponibles').delete().eq('miembro_id', m.id).eq('tipo', tipo);
    await db.from('disponibles').insert({
      grupo_id: g.id, miembro_id: m.id, tipo, sector: sec, hora,
      destino_texto: destino.slice(0, 120), expira_en: new Date(Date.now() + 2 * 3600e3).toISOString(),
    });
    const { data: otros } = await db.from('disponibles').select('*, miembros(nombre, unidad, whatsapp)')
      .eq('grupo_id', g.id).eq('tipo', opuesto).eq('sector', sec).neq('miembro_id', m.id)
      .gt('expira_en', new Date().toISOString()).limit(3);
    await wa(from, esCupo
      ? `✅ Cupo registrado (${sec}, ${hora}).\n` + (otros?.length ? `🙋 Buscan viaje:\n${otros.map(o => '• ' + quien(o)).join('\n')}\nYa les avisé.` : '📡 Nadie busca por ahora. Te aviso si aparece alguien.')
      : `🔍 Búsqueda registrada (${sec}, ${hora}).\n` + (otros?.length ? `🟢 Con cupo:\n${otros.map(o => '• ' + quien(o)).join('\n')}\nYa les avisé.` : '📡 Sin cupos por ahora. Te aviso cuando aparezca uno.'));
    for (const o of otros || []) await wa(o.miembros.whatsapp,
      esCupo ? `🟢 *${m.nombre}*${m.unidad ? ' (' + m.unidad + ')' : ''} tiene cupo hacia ${sec} a las ${hora}.\nCoordina con él/ella.`
             : `🙋 *${m.nombre}*${m.unidad ? ' (' + m.unidad + ')' : ''} busca viaje hacia ${sec} a las ${hora}.\nSi puedes llevarle, coordina con él/ella.`);
    return;
  }
  if (cmd === 'CANCELAR') {
    await db.from('disponibles').delete().eq('miembro_id', m.id);
    return wa(from, '❌ Tu disponibilidad fue cancelada.');
  }
  if (cmd === 'STATS') {
    const ahora = new Date().toISOString();
    const c = async t => (await db.from('disponibles').select('*', { count: 'exact', head: true }).eq('grupo_id', g.id).eq('tipo', t).gt('expira_en', ahora)).count || 0;
    return wa(from, `📊 *${g.nombre}*\n🟢 Con cupo: ${await c('cupo')}\n🙋 Buscando: ${await c('necesito')}`);
  }
  return wa(from, `🚗 *VOY · ${g.nombre}*\n🟢 CUPO | hora | destino\n🙋 NECESITO | hora | destino\n📊 STATS\n❌ CANCELAR`);
}

app.get('/', (_, r) => r.send('VOY Bot activo'));
app.listen(process.env.PORT || 3000, () => console.log('🚗 VOY Bot multi-grupo activo'));
