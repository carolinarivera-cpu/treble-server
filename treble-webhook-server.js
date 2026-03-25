const express=require('express'),cors=require('cors'),fs=require('fs'),path=require('path'),app=express(),PORT=process.env.PORT||3001,DATA_FILE=path.join(__dirname,'conversations.json');
app.use(cors());
app.use(express.json({limit:'10mb'}));

function loadData(){
  try{if(fs.existsSync(DATA_FILE))return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))}
  catch(e){}
  return{conversations:[],lastUpdated:null,lastRawPayload:null};
}
function saveData(d){d.lastUpdated=new Date().toISOString();fs.writeFileSync(DATA_FILE,JSON.stringify(d,null,2));}
var db=loadData();

function getText(m){
  if(m.text&&typeof m.text==='string')return m.text;
  if(m.hsm&&m.hsm.message)return m.hsm.message;
  if(m.hsm&&m.hsm.text)return m.hsm.text;
  return '';
}

app.post('/webhook/treble',function(req,res){
  res.status(200).json({ok:true});
  var p=req.body;
  db.lastRawPayload={recibidoEl:new Date().toISOString(),event_type:p.event_type,session:p.session,user:p.user,user_session_keys:p.user_session_keys,totalMensajes:(p.messages||[]).length,primerosMensajes:(p.messages||[]).slice(0,3)};
  if(p.event_type!=='session.close'){saveData(db);return;}
  var msgs=p.messages||[];
  var esA=function(m){return['company','agent','ai','COMPANY','AGENT','AI'].indexOf(m.sender)>-1;};
  var esU=function(m){return['user','USER'].indexOf(m.sender)>-1;};
  var ma=msgs.filter(esA),mu=msgs.filter(esU);
  var tr=0,rc=0;
  for(var i=1;i<msgs.length;i++){
    var a=msgs[i-1],b=msgs[i];
    if(esU(a)&&esA(b)&&a.created_at&&b.created_at){
      var d=(new Date(b.created_at)-new Date(a.created_at))/60000;
      if(d>0&&d<120){tr+=d;rc++;}
    }
  }
  var pm=ma[0];
  var aN=(pm&&pm.agent_name)||(pm&&pm.name)||'Automatico';
  var aI=(pm&&pm.agent_id)||'automatico';
  var sessionKeys=p.user_session_keys||[];
  var txt=msgs.map(function(m){return getText(m);}).join(' ').toLowerCase();
  var tmap={Precio:['precio','costo','cuanto','descuento','oferta','promo','barato','caro','valor','paquete','combo'],Soporte:['error','falla','problema','no funciona','ayuda','soporte'],Envio:['envio','entrega','llega','pedido','despacho'],Devolucion:['devolver','reembolso','cambio','garantia'],Pago:['pago','pagar','tarjeta','efectivo','factura','transferencia'],Ventas:['ventas','vende','restaurante','activa','invierte','rappi','ads','publicidad'],Saludo:['hola','buenos','gracias','bienvenido','bye']};
  var temas=Object.keys(tmap).filter(function(t){return tmap[t].some(function(k){return txt.indexOf(k)>-1;});});
  var mc=ma.filter(function(m){var t=getText(m);return t&&t.length<15;}).length;
  var rc2=ma.length>0?mc/ma.length:0,ti=rc>0?tr/rc:999;
  var sc=100;
  if(msgs.length<3)sc-=30;
  if(ma.length===0)sc-=40;
  if(ti>30)sc-=20;else if(ti>10)sc-=10;
  if(rc2>0.7)sc-=25;else if(rc2>0.4)sc-=10;
  sc=Math.max(0,sc);
  var ini=(msgs[0]&&msgs[0].created_at)||(p.session&&p.session.closed_at);
  var fin=p.session&&p.session.closed_at;
  db.conversations.push({
    eventId:p.event_id,sessionId:p.session&&p.session.external_id,
    cerradoEl:p.session&&p.session.closed_at,recibidoEl:new Date().toISOString(),
    hora:ini?new Date(ini).getHours():null,diaSemana:ini?new Date(ini).getDay():null,
    fecha:ini?new Date(ini).toISOString().split('T')[0]:null,
    agenteId:aI,agenteName:aN,
    telefonoUsuario:((p.user&&p.user.country_code)||'')+((p.user&&p.user.cellphone)||''),
    totalMensajes:msgs.length,msgsAgente:ma.length,msgsUsuario:mu.length,
    tiempoRespMin:rc>0?Math.round(tr/rc*10)/10:null,
    duracionMin:ini&&fin?Math.round((new Date(fin)-new Date(ini))/60000):0,
    score:sc,temas:temas,textoResumen:txt.substring(0,500),
    fraude:{convMuyCorta:msgs.length<3,sinRespuestaAgente:ma.length===0,msgsDemasiadoCortos:rc2>0.8,respuestaMuyLenta:rc>0&&ti>60}
  });
  saveData(db);
  console.log('[OK] '+aN+' msgs:'+msgs.length+' temas:'+temas.join(','));
});

function fi(c,q){return c.filter(function(x){if(q.from&&x.fecha<q.from)return false;if(q.to&&x.fecha>q.to)return false;if(q.agente&&x.agenteId!==q.agente&&x.agenteName!==q.agente)return false;return true;});}
function pr(a){return a.length?a.reduce(function(s,v){return s+v;},0)/a.length:0;}

app.get('/api/summary',function(req,res){var c=fi(db.conversations,req.query);res.json({totalConversaciones:c.length,tiempoRespPromMin:Math.round(pr(c.map(function(x){return x.tiempoRespMin;}).filter(Boolean))*10)/10,scorePromedio:Math.round(pr(c.map(function(x){return x.score;}))),alertasFraude:c.filter(function(x){return Object.values(x.fraude).some(Boolean);}).length,ultimaActualizacion:db.lastUpdated,totalGuardadas:db.conversations.length});});
app.get('/api/agents',function(req,res){var c=fi(db.conversations,req.query),m={};c.forEach(function(x){if(!m[x.agenteId])m[x.agenteId]={id:x.agenteId,nombre:x.agenteName,conversaciones:0,mensajes:0,tiempos:[],scores:[],fraudes:0,temas:{}};var a=m[x.agenteId];a.conversaciones++;a.mensajes+=x.totalMensajes;if(x.tiempoRespMin)a.tiempos.push(x.tiempoRespMin);a.scores.push(x.score);if(Object.values(x.fraude).some(Boolean))a.fraudes++;x.temas.forEach(function(t){a.temas[t]=(a.temas[t]||0)+1;});});res.json(Object.values(m).map(function(a){return{id:a.id,nombre:a.nombre,conversaciones:a.conversaciones,mensajes:a.mensajes,tiempoRespProm:Math.round(pr(a.tiempos)*10)/10,scoreProm:Math.round(pr(a.scores)),alertasFraude:a.fraudes,temasTop:Object.entries(a.temas).sort(function(x,y){return y[1]-x[1];}).slice(0,3).map(function(e){return e[0];})};}).sort(function(a,b){return b.scoreProm-a.scoreProm;}));});
app.get('/api/topics',function(req,res){var c=fi(db.conversations,req.query),ct={};c.forEach(function(x){x.temas.forEach(function(t){ct[t]=(ct[t]||0)+1;});});var tot=c.length||1;res.json(Object.entries(ct).sort(function(a,b){return b[1]-a[1];}).map(function(e){return{tema:e[0],cantidad:e[1],pct:Math.round(e[1]/tot*100)};}));});
app.get('/api/heatmap',function(req,res){var c=fi(db.conversations,req.query),g=Array.from({length:7},function(){return Array(24).fill(0);});c.forEach(function(x){if(x.diaSemana!=null&&x.hora!=null)g[x.diaSemana][x.hora]++;});res.json({grid:g,dias:['Dom','Lun','Mar','Mie','Jue','Vie','Sab']});});
app.get('/api/trend',function(req,res){var c=fi(db.conversations,req.query),d={};c.forEach(function(x){if(!x.fecha)return;if(!d[x.fecha])d[x.fecha]={cantidad:0,scores:[],tiempos:[]};d[x.fecha].cantidad++;d[x.fecha].scores.push(x.score);if(x.tiempoRespMin)d[x.fecha].tiempos.push(x.tiempoRespMin);});res.json(Object.entries(d).sort().map(function(e){return{fecha:e[0],cantidad:e[1].cantidad,scorePromedio:Math.round(pr(e[1].scores)),tiempoRespProm:Math.round(pr(e[1].tiempos)*10)/10};}));});
app.get('/api/conversations',function(req,res){var lim=parseInt(req.query.limit)||50,c=fi(db.conversations,req.query);if(req.query.fraude==='true')c=c.filter(function(x){return Object.values(x.fraude).some(Boolean);});res.json(c.slice(-lim).reverse());});
app.get('/api/agents/list',function(req,res){var seen={},r=[];db.conversations.forEach(function(c){if(!seen[c.agenteId]){seen[c.agenteId]=1;r.push({id:c.agenteId,nombre:c.agenteName});}});res.json(r);});
app.get('/health',function(req,res){res.json({status:'ok',conversations:db.conversations.length,lastUpdated:db.lastUpdated});});
app.get('/api/debug/last',function(req,res){res.json(db.lastRawPayload||{mensaje:'Sin webhooks aun'});});
app.listen(PORT,function(){console.log('TREBLE SERVER en puerto '+PORT);console.log('Conversaciones: '+db.conversations.length);});
