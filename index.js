const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'conversations.json');
app.use(cors());
app.use(express.json({ limit: '10mb' }));

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return { conversations: [], lastUpdated: null };
}

function saveData(d) {
  d.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

var db = loadData();

app.post('/webhook/treble', function(req, res) {
  res.status(200).json({ ok: true });
  var p = req.body;
  if (p.event_type !== 'session.close') return;
  var msgs = p.messages || [];
  var ma = msgs.filter(function(m) { return ['company','agent','COMPANY','AGENT'].indexOf(m.sender) > -1; });
  var mu = msgs.filter(function(m) { return ['user','USER'].indexOf(m.sender) > -1; });
  var pm = ma[0];
  var aN = (pm && pm.agent_name) || (pm && pm.name) || 'sin-asignar';
  var aI = (pm && pm.agent_id) || 'sin-asignar';
  var txt = msgs.filter(function(m) { return m.text && typeof m.text === 'string'; }).map(function(m) { return m.text; }).join(' ').toLowerCase();
  var tmap = { Precio: ['precio','costo','cuanto','descuento'], Soporte: ['error','falla','problema','ayuda'], Envio: ['envio','entrega','pedido'], Pago: ['pago','tarjeta','factura'], Saludo: ['hola','gracias'] };
  var temas = Object.keys(tmap).filter(function(t) { return tmap[t].some(function(k) { return txt.indexOf(k) > -1; }); });
  var sc = 100;
  if (msgs.length < 3) sc -= 30;
  if (ma.length === 0) sc -= 40;
  sc = Math.max(0, sc);
  var ini = (msgs[0] && msgs[0].created_at) || (p.session && p.session.closed_at);
  db.conversations.push({
    eventId: p.event_id,
    cerradoEl: p.session && p.session.closed_at,
    recibidoEl: new Date().toISOString(),
    hora: ini ? new Date(ini).getHours() : null,
    diaSemana: ini ? new Date(ini).getDay() : null,
    fecha: ini ? new Date(ini).toISOString().split('T')[0] : null,
    agenteId: aI, agenteName: aN,
    totalMensajes: msgs.length, msgsAgente: ma.length, msgsUsuario: mu.length,
    score: sc, temas: temas,
    textoResumen: txt.substring(0, 500),
    fraude: { convMuyCorta: msgs.length < 3, sinRespuesta: ma.length === 0 }
  });
  saveData(db);
  console.log('[OK] ' + aN + ' msgs:' + msgs.length + ' temas:' + temas.join(','));
});

function fi(c, q) {
  return c.filter(function(x) {
    if (q.from && x.fecha < q.from) return false;
    if (q.to && x.fecha > q.to) return false;
    return true;
  });
}

function pr(a) { return a.length ? a.reduce(function(s,v){return s+v;},0)/a.length : 0; }

app.get('/api/summary', function(req, res) {
  var c = fi(db.conversations, req.query);
  res.json({ totalConversaciones: c.length, scorePromedio: Math.round(pr(c.map(function(x){return x.score;}))), alertasFraude: c.filter(function(x){return Object.values(x.fraude).some(Boolean);}).length, ultimaActualizacion: db.lastUpdated });
});

app.get('/api/agents', function(req, res) {
  var c = fi(db.conversations, req.query), m = {};
  c.forEach(function(x) {
    if (!m[x.agenteId]) m[x.agenteId] = { id: x.agenteId, nombre: x.agenteName, conversaciones: 0, scores: [], temas: {} };
    var a = m[x.agenteId]; a.conversaciones++;
    a.scores.push(x.score);
    x.temas.forEach(function(t) { a.temas[t] = (a.temas[t]||0)+1; });
  });
  res.json(Object.values(m).map(function(a) { return { id: a.id, nombre: a.nombre, conversaciones: a.conversaciones, scoreProm: Math.round(pr(a.scores)), temasTop: Object.entries(a.temas).sort(function(x,y){return y[1]-x[1];}).slice(0,3).map(function(e){return e[0];})}; }).sort(function(a,b){return b.scoreProm-a.scoreProm;}));
});

app.get('/api/topics', function(req, res) {
  var c = fi(db.conversations, req.query), ct = {};
  c.forEach(function(x) { x.temas.forEach(function(t) { ct[t]=(ct[t]||0)+1; }); });
  var tot = c.length || 1;
  res.json(Object.entries(ct).sort(function(a,b){return b[1]-a[1];}).map(function(e){return {tema:e[0],cantidad:e[1],pct:Math.round(e[1]/tot*100)};}));
});

app.get('/api/conversations', function(req, res) {
  var c = fi(db.conversations, req.query);
  res.json(c.slice(-(parseInt(req.query.limit)||50)).reverse());
});

app.get('/api/agents/list', function(req, res) {
  var seen = {}, result = [];
  db.conversations.forEach(function(c) { if (!seen[c.agenteId]) { seen[c.agenteId]=1; result.push({id:c.agenteId,nombre:c.agenteName}); } });
  res.json(result);
});

app.get('/api/trend', function(req, res) {
  var c = fi(db.conversations, req.query), d = {};
  c.forEach(function(x) { if (!x.fecha) return; if (!d[x.fecha]) d[x.fecha]={cantidad:0,scores:[]}; d[x.fecha].cantidad++; d[x.fecha].scores.push(x.score); });
  res.json(Object.entries(d).sort().map(function(e){return {fecha:e[0],cantidad:e[1].cantidad,scorePromedio:Math.round(pr(e[1].scores))};}));
});

app.get('/api/heatmap', function(req, res) {
  var c = fi(db.conversations, req.query);
  var g = Array.from({length:7}, function(){return Array(24).fill(0);});
  c.forEach(function(x) { if (x.diaSemana!=null&&x.hora!=null) g[x.diaSemana][x.hora]++; });
  res.json({ grid: g, dias: ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'] });
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', conversations: db.conversations.length, lastUpdated: db.lastUpdated });
});

app.listen(PORT, function() {
  console.log('TREBLE SERVER corriendo en puerto ' + PORT);
  console.log('Conversaciones guardadas: ' + db.conversations.length);
});
