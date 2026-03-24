/**
 * ============================================================
 * TREBLE WEBHOOK SERVER v2 — CORREGIDO
 * ============================================================
 * Recibe automaticamente TODAS las conversaciones cuando
 * un agente cierra un chat en sales.treble.ai
 *
 * INSTALACION:
 *   1. npm install express cors
 *   2. node treble-webhook-server.js
 *
 * CONFIGURAR EN TREBLE:
 *   app.treble.ai -> Settings -> Webhooks
 *   URL: https://TU-URL-NGROK.ngrok-free.app/webhook/treble
 *   Activar: "Close Session Update" -> Save
 * ============================================================
 */

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app       = express();
const PORT      = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'conversations.json');

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('Error cargando datos:', e.message); }
  return { conversations: [], lastUpdated: null, lastRawPayload: null };
}

function saveData(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

app.post('/webhook/treble', (req, res) => {
  res.status(200).json({ ok: true });

  const payload = req.body;

  db.lastRawPayload = {
    recibidoEl:        new Date().toISOString(),
    event_type:        payload.event_type,
    session:           payload.session,
    user:              payload.user,
    user_session_keys: payload.user_session_keys,
    totalMensajes:     (payload.messages || []).length,
    primerosMensajes:  (payload.messages || []).slice(0, 3),
  };

  if (payload.event_type !== 'session.close') {
    console.log('[SKIP] Evento ignorado: ' + payload.event_type);
    saveData(db);
    return;
  }

  const conv = procesarConversacion(payload);
  db.conversations.push(conv);
  saveData(db);

  console.log('[OK] Chat guardado | Agente: ' + conv.agenteName + ' | Mensajes: ' + conv.totalMensajes + ' | Temas: ' + (conv.temas.join(', ') || 'ninguno'));
});

function procesarConversacion(payload) {
  const mensajes = payload.messages || [];

  const esAgente  = m => ['company','agent','ai','COMPANY','AGENT','AI'].includes(m.sender);
  const esUsuario = m => ['user','USER','cliente','CLIENTE'].includes(m.sender);

  const msgsAgente  = mensajes.filter(esAgente);
  const msgsUsuario = mensajes.filter(esUsuario);

  let totalRespTime = 0, respCount = 0;
  for (let i = 1; i < mensajes.length; i++) {
    const ant = mensajes[i - 1];
    const act = mensajes[i];
    if (esUsuario(ant) && esAgente(act) && ant.created_at && act.created_at) {
      const diff = (new Date(act.created_at) - new Date(ant.created_at)) / 60000;
      if (diff > 0 && diff < 120) { totalRespTime += diff; respCount++; }
    }
  }

  const primerMsgAgente = msgsAgente[0];
  const sessionKeys     = payload.user_session_keys || [];
  const keyAgente       = sessionKeys.find(k =>
    k.key && /agent|vendor|asesor|vendedor|seller/i.test(k.key)
  );

  const agenteId = (primerMsgAgente && primerMsgAgente.agent_id)
    || (primerMsgAgente && primerMsgAgente.sender_id)
    || (payload.session && payload.session.agent_id)
    || (keyAgente && keyAgente.value)
    || 'sin-asignar';

  const agenteName = (primerMsgAgente && primerMsgAgente.agent_name)
    || (primerMsgAgente && primerMsgAgente.name)
    || (primerMsgAgente && primerMsgAgente.sender_name)
    || (payload.session && payload.session.agent_name)
    || (keyAgente && keyAgente.value)
    || agenteId;

  const senders = [...new Set(mensajes.map(m => m.sender))];
  console.log('[DEBUG] Senders: ' + senders.join(', ') + ' | Keys: ' + sessionKeys.map(k => k.key).join(', '));

  const textoCompleto = mensajes
    .filter(m => m.text && typeof m.text === 'string')
    .map(m => m.text)
    .join(' ')
    .toLowerCase();

  const temas = detectarTemas(textoCompleto);

  const msgsCortos  = msgsAgente.filter(m => m.text && m.text.length < 15).length;
  const ratioCortos = msgsAgente.length > 0 ? msgsCortos / msgsAgente.length : 0;
  const tiempoResp  = respCount > 0 ? totalRespTime / respCount : 999;
  let score = 100;
  if (mensajes.length < 3)     score -= 30;
  if (msgsAgente.length === 0) score -= 40;
  if (tiempoResp > 30)         score -= 20;
  else if (tiempoResp > 10)    score -= 10;
  if (ratioCortos > 0.7)       score -= 25;
  else if (ratioCortos > 0.4)  score -= 10;
  score = Math.max(0, score);

  const inicio   = (mensajes[0] && mensajes[0].created_at) || (payload.session && payload.session.closed_at);
  const fin      = payload.session && payload.session.closed_at;
  const duracion = inicio && fin ? Math.round((new Date(fin) - new Date(inicio)) / 60000) : 0;

  return {
    eventId:         payload.event_id,
    sessionId:       payload.session && payload.session.external_id,
    cerradoEl:       payload.session && payload.session.closed_at,
    recibidoEl:      new Date().toISOString(),
    hora:            inicio ? new Date(inicio).getHours() : null,
    diaSemana:       inicio ? new Date(inicio).getDay()   : null,
    fecha:           inicio ? new Date(inicio).toISOString().split('T')[0] : null,
    agenteId,
    agenteName,
    telefonoUsuario: ((payload.user && payload.user.country_code) || '') + ((payload.user && payload.user.cellphone) || ''),
    totalMensajes:   mensajes.length,
    msgsAgente:      msgsAgente.length,
    msgsUsuario:     msgsUsuario.length,
    tiempoRespMin:   respCount > 0 ? Math.round(tiempoResp * 10) / 10 : null,
    duracionMin:     duracion,
    score,
    temas,
    textoResumen:    textoCompleto.substring(0, 2000),
    fraude: {
      convMuyCorta:        mensajes.length < 3,
      sinRespuestaAgente:  msgsAgente.length === 0,
      msgsDemasiadoCortos: ratioCortos > 0.8,
      respuestaMuyLenta:   respCount > 0 && tiempoResp > 60,
    },
  };
}

function detectarTemas(texto) {
  const mapa = {
    'Precio / Descuento':    ['precio','costo','cuanto','descuento','oferta','promo','barato','caro','valor'],
    'Soporte Tecnico':       ['error','falla','problema','no funciona','ayuda','soporte','bug'],
    'Envio / Entrega':       ['envio','entrega','llega','despacho','tracking','pedido','llego'],
    'Devolucion / Garantia': ['devolver','devolucion','cambio','reembolso','garantia'],
    'Disponibilidad':        ['disponible','stock','agotado','existe','tienen','hay'],
    'Pago / Factura':        ['pago','pagar','tarjeta','efectivo','transferencia','factura','cobro'],
    'Cuenta / Registro':     ['cuenta','registro','login','contrasena','usuario','acceso'],
    'Saludo / Cierre':       ['hola','buenos dias','buenas','gracias','hasta luego','bye','chao'],
  };
  return Object.entries(mapa)
    .filter(function(entry) { return entry[1].some(function(k) { return texto.includes(k); }); })
    .map(function(entry) { return entry[0]; });
}

function filtrar(convs, query) {
  const from   = query.from;
  const to     = query.to;
  const agente = query.agente;
  return convs.filter(function(c) {
    if (from   && c.fecha < from) return false;
    if (to     && c.fecha > to)   return false;
    if (agente && c.agenteId !== agente && c.agenteName !== agente) return false;
    return true;
  });
}

function prom(arr) {
  return arr.length ? arr.reduce(function(s, v) { return s + v; }, 0) / arr.length : 0;
}

app.get('/api/summary', function(req, res) {
  const convs    = filtrar(db.conversations, req.query);
  const avgResp  = prom(convs.map(function(c) { return c.tiempoRespMin; }).filter(Boolean));
  const avgScore = prom(convs.map(function(c) { return c.score; }));
  const fraudes  = convs.filter(function(c) { return Object.values(c.fraude).some(Boolean); }).length;
  res.json({
    totalConversaciones: convs.length,
    tiempoRespPromMin:   Math.round(avgResp * 10) / 10,
    scorePromedio:       Math.round(avgScore),
    alertasFraude:       fraudes,
    ultimaActualizacion: db.lastUpdated,
    totalGuardadas:      db.conversations.length,
  });
});

app.get('/api/agents', function(req, res) {
  const convs = filtrar(db.conversations, req.query);
  const mapa  = {};
  convs.forEach(function(c) {
    if (!mapa[c.agenteId]) mapa[c.agenteId] = {
      id: c.agenteId, nombre: c.agenteName,
      conversaciones: 0, mensajes: 0,
      tiempos: [], scores: [], fraudes: 0, temas: {},
    };
    const a = mapa[c.agenteId];
    a.conversaciones++;
    a.mensajes += c.totalMensajes;
    if (c.tiempoRespMin) a.tiempos.push(c.tiempoRespMin);
    a.scores.push(c.score);
    if (Object.values(c.fraude).some(Boolean)) a.fraudes++;
    c.temas.forEach(function(t) { a.temas[t] = (a.temas[t] || 0) + 1; });
  });
  res.json(Object.values(mapa).map(function(a) {
    return {
      id:             a.id,
      nombre:         a.nombre,
      conversaciones: a.conversaciones,
      mensajes:       a.mensajes,
      tiempoRespProm: Math.round(prom(a.tiempos) * 10) / 10,
      scoreProm:      Math.round(prom(a.scores)),
      alertasFraude:  a.fraudes,
      temasTop:       Object.entries(a.temas).sort(function(x,y){ return y[1]-x[1]; }).slice(0,3).map(function(e){ return e[0]; }),
    };
  }).sort(function(a, b) { return b.scoreProm - a.scoreProm; }));
});

app.get('/api/topics', function(req, res) {
  const convs  = filtrar(db.conversations, req.query);
  const conteo = {};
  convs.forEach(function(c) { c.temas.forEach(function(t) { conteo[t] = (conteo[t] || 0) + 1; }); });
  const total = convs.length || 1;
  res.json(Object.entries(conteo)
    .sort(function(a, b) { return b[1] - a[1]; })
    .map(function(e) { return { tema: e[0], cantidad: e[1], pct: Math.round(e[1] / total * 100) }; }));
});

app.get('/api/heatmap', function(req, res) {
  const convs = filtrar(db.conversations, req.query);
  const grid  = Array.from({ length: 7 }, function() { return Array(24).fill(0); });
  convs.forEach(function(c) {
    if (c.diaSemana != null && c.hora != null) grid[c.diaSemana][c.hora]++;
  });
  res.json({ grid: grid, dias: ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'] });
});

app.get('/api/trend', function(req, res) {
  const convs  = filtrar(db.conversations, req.query);
  const diario = {};
  convs.forEach(function(c) {
    if (!c.fecha) return;
    if (!diario[c.fecha]) diario[c.fecha] = { cantidad: 0, scores: [], tiempos: [] };
    diario[c.fecha].cantidad++;
    diario[c.fecha].scores.push(c.score);
    if (c.tiempoRespMin) diario[c.fecha].tiempos.push(c.tiempoRespMin);
  });
  res.json(Object.entries(diario).sort().map(function(e) {
    return {
      fecha:          e[0],
      cantidad:       e[1].cantidad,
      scorePromedio:  Math.round(prom(e[1].scores)),
      tiempoRespProm: Math.round(prom(e[1].tiempos) * 10) / 10,
    };
  }));
});

app.get('/api/conversations', function(req, res) {
  const limit  = parseInt(req.query.limit) || 50;
  const fraude = req.query.fraude;
  let convs = filtrar(db.conversations, req.query);
  if (fraude === 'true') convs = convs.filter(function(c) { return Object.values(c.fraude).some(Boolean); });
  res.json(convs.slice(-limit).reverse());
});

app.get('/api/agents/list', function(req, res) {
  const agentes = [...new Map(
    db.conversations.map(function(c) { return [c.agenteId, { id: c.agenteId, nombre: c.agenteName }]; })
  ).values()];
  res.json(agentes);
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', conversations: db.conversations.length, lastUpdated: db.lastUpdated });
});

app.get('/api/debug/last', function(req, res) {
  res.json(db.lastRawPayload || { mensaje: 'Aun no ha llegado ningun webhook de Treble' });
});

app.listen(PORT, function() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   TREBLE WEBHOOK SERVER v2 — Puerto ' + PORT + '      ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log('║  Webhook:     POST /webhook/treble            ║');
  console.log('║  Diagnostico: GET  /api/debug/last            ║');
  console.log('║  Health:      GET  /health                    ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log('║  Conversaciones guardadas: ' + db.conversations.length);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
});
