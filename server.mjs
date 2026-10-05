import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';
import { listProviders } from './scraper/provider-registry.mjs';
import { scrapeAuthorizedAwards, manualCapture } from './scraper/direct-scraper.mjs';
import { loadHistory, recordAwards, routeHistoryStats, getSources } from './scraper/price-history.mjs';
import { saveAwards } from './scraper/ingest.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.POINTPILOT_DATA_DIR ? path.resolve(process.env.POINTPILOT_DATA_DIR) : path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const FIXTURES = path.join(ROOT, 'fixtures');
const PORT = Number(process.env.PORT || 3000);
const WEBHOOK = process.env.ALERT_WEBHOOK_URL || '';
const MONITOR_MIN = Number(process.env.MONITOR_INTERVAL_MINUTES || 30);

const DESTINATIONS = {
  thailand: ['BKK','HKT','CNX','DMK'], japan: ['NRT','HND','KIX','NGO'],
  europe: ['LHR','CDG','AMS','FRA','FCO','MAD','BCN','LIS'],
  london: ['LHR','LGW'], paris: ['CDG','ORY'], rome: ['FCO'],
  bali: ['DPS'], singapore: ['SIN'], tokyo: ['NRT','HND'],
  bangkok: ['BKK'], phuket: ['HKT'], chiangmai: ['CNX']
};

const PROGRAM_NAMES = {
  aeroplan:'Air Canada Aeroplan', united:'United MileagePlus', american:'American Airlines AAdvantage',
  alaska:'Alaska Airlines Atmos Rewards', flyingblue:'Air France/KLM Flying Blue', lifemiles:'Avianca LifeMiles',
  singapore:'Singapore Airlines KrisFlyer', qatar:'Qatar Airways Privilege Club (Avios)', emirates:'Emirates Skywards',
  virginatlantic:'Virgin Atlantic Flying Club', ba:'British Airways Executive Club (Avios)', cathay:'Cathay Pacific Asia Miles',
  jetblue:'JetBlue TrueBlue'
};

async function json(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } }
async function save(file, value) { await mkdir(path.dirname(file), {recursive:true}); await writeFile(file, JSON.stringify(value, null, 2)); }

function cors(res) { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS'); }
function send(res, code, payload, type='application/json') { cors(res); res.writeHead(code, {'Content-Type': type}); res.end(type==='application/json' ? JSON.stringify(payload) : payload); }
async function body(req) { let s=''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; }
function num(v, d=0){ const n=Number(v); return Number.isFinite(n)?n:d; }
function dateShift(date, days){ const d=new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function destinations(input){ const s=String(input||'').trim(); if (/^[A-Za-z]{3}(,[A-Za-z]{3})*$/.test(s)) return s.toUpperCase().split(','); return DESTINATIONS[s.toLowerCase()] || DESTINATIONS[s.toLowerCase().replace(/[^a-z]/g,'')] || ['BKK','HKT','CNX']; }
function airportList(s){ return String(s||'JFK,BOS').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean); }

function demoFlights(q){
  const origins=airportList(q.origin); const dests=destinations(q.destination); const travelers=Math.max(1,num(q.travelers,2));
  const cabin=(q.cabin||'business').toLowerCase(); const from=q.start_date; const to=q.end_date||from;
  const programs = cabin==='first' ? ['singapore','qatar','emirates','american'] : cabin==='business' ? ['aeroplan','flyingblue','lifemiles','united','qatar','virginatlantic','ba'] : ['aeroplan','flyingblue','united','ba'];
  const base={business:[70000,55000,60000,75000,70000,75000,62000],first:[115000,95000,100000,110000],economy:[45000,35000,40000,42000]}[cabin] || [45000];
  const out=[]; let i=0;
  for(const o of origins) for(const d of dests){ const day=dateShift(from, Math.min(3, Math.floor((new Date(to)-new Date(from))/86400000))); for(const p of programs.slice(0,7)){ const pts=(base[i%base.length] + (i%3)*5000); out.push({id:`demo-${o}-${d}-${p}-${i}`,source:p,program:PROGRAM_NAMES[p]||p,origin:o,destination:d,date:day,cabin,airlines:p==='qatar'?'QR':p==='aeroplan'?'AC':'Mixed',direct:i%3!==0,remainingSeats:Math.max(2,travelers+((i+2)%5)),mileageCost:pts,totalTaxes:(i%4)*1250+650,feesCurrency:'USD',cashValue:4200+(i%5)*400,availabilityQuality:i%3===0?'Good':'Great',dataSource:'demo',note:'Illustrative inventory'}); i++; }}
  return out;
}


async function cachedAwards() { return json(path.join(DATA,'award-cache.json'),[]); }

function dateInRange(date, start, end) {
  if (!date) return false;
  const x = new Date(`${date}T00:00:00Z`).getTime();
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end || start}T23:59:59Z`).getTime();
  return Number.isFinite(x) && x >= a && x <= b;
}

async function searchFlights(q){
  const origins=new Set(airportList(q.origin)); const dests=new Set(destinations(q.destination));
  const cabin=(q.cabin||'business').toLowerCase();
  const cache=(await cachedAwards()).filter(a => a.product !== 'hotel' && origins.has(String(a.origin||'').toUpperCase()) && dests.has(String(a.destination||'').toUpperCase()) && String(a.cabin||'').toLowerCase()===cabin && dateInRange(a.date,q.start_date,q.end_date||q.start_date));
  if (cache.length) {
    return {mode:'captured',source:'pointpilot-capture',rows:cache,meta:{count:cache.length,reason:'User-captured or authorized provider inventory'}};
  }
  return {mode:'manual',source:'manual-capture-required',rows:[],meta:{count:0,reason:'No captured inventory matched this search. Use Manual Capture or Manual Award Entry for restricted providers.'}};
}

async function searchHotels(q){
  const cache=(await cachedAwards()).filter(a => a.product === 'hotel' && String(a.location||'').toLowerCase().includes(String(q.destination||'').toLowerCase()) && dateInRange(a.checkIn,q.start_date,q.end_date||q.start_date));
  if(cache.length) return {mode:'captured',source:'pointpilot-capture',rows:cache,meta:{count:cache.length,reason:'User-captured or authorized provider inventory'}};
  return {mode:'manual',source:'manual-capture-required',rows:[],meta:{count:0,reason:'No captured hotel inventory matched this search.'}};
}

function demoHotels(q){
  const programs=[['hyatt','Park Hyatt Bangkok',18000,310],['marriott','The St. Regis Bangkok',45000,420],['ihg','InterContinental Bangkok',32000,270],['hilton','Conrad Bangkok',50000,240]];
  return programs.map((p,i)=>({id:`hotel-demo-${i}`,name:p[1],location:q.destination,program:p[1].includes('Park Hyatt')?'hyatt':p[0],source:p[0],checkIn:q.start_date,nightlyPoints:p[2],standardPoints:p[2],suitePoints:p[2]*2,cashValue:p[3],cpp:Math.round((p[3]*100/p[2])*100)/100,bookingUrl:null,dataSource:'demo'}));
}

function loadTransfer(){ return json(path.join(DATA,'transfer-partners.json'),{programs:{},banks:{}}); }
function loadUser(){ return json(path.join(DATA,'user.json'),{balances:[],preferences:{}}); }
function effectiveRatio(edge){ const [from,to]=edge.ratio; return (to/from)*(1+num(edge.bonusPct)); }

function optimize(awards, balances, prefs={}){
  const byCode=Object.fromEntries(balances.map(b=>[b.code,b])); const transferData=globalThis.__transfers||{programs:{}};
  const results=[];
  for(const a of awards){
    const target=transferData.programs[a.source]; if(!target) continue;
    const need=Math.round(num(a.mileageCost)); const direct=Math.min(num(byCode[a.source]?.balance),need); let remain=need-direct;
    const sources=[];
    if(direct) sources.push({from:a.source,fromPoints:direct,targetPoints:direct,reason:'Use existing target-program miles'});
    const edges=Object.entries(target.transfers||{}).map(([bank,e])=>({bank,e})).filter(x=>byCode[x.bank]?.balance>0).sort((x,y)=>byCode[x.bank].cpp-byCode[y.bank].cpp);
    for(const {bank,e} of edges){
      if(remain<=0) break;
      const ep=effectiveRatio(e); const maxTarget=byCode[bank].balance*ep; const targetTake=Math.min(remain,maxTarget); const sourceNeed=Math.ceil(targetTake/ep); const sourceUsed=Math.min(sourceNeed,byCode[bank].balance); const actualTarget=Math.floor(sourceUsed*ep); if(actualTarget<=0) continue;
      sources.push({from:bank,fromPoints:sourceUsed,targetPoints:actualTarget,ratio:e.ratio,bonusPct:e.bonusPct||0,days:e.days||0}); remain-=actualTarget;
    }
    if(remain>0) continue;
    const totalSourcePoints=sources.reduce((s,x)=>s+x.fromPoints,0); const econCost=sources.reduce((s,x)=>s + x.fromPoints*(byCode[x.from]?.cpp ?? prefs.defaultCpp ?? 1.5)/100,0) + num(a.totalTaxes)/100;
    const cashValue=num(a.cashValue); const cpp=cashValue>0 ? (cashValue - num(a.totalTaxes)/100) / Math.max(1,totalSourcePoints) * 100 : null;
    const flexibilityPenalty=totalSourcePoints * (sources.length>1 ? 0.0003 : 0) + sources.reduce((s,x)=>s+(byCode[x.from]?.transferable?0:0.2),0);
    const score=(cashValue?cashValue:0) - econCost - flexibilityPenalty + (a.direct?150:0) - ((a.direct?0:1)*20);
    results.push({...a,totalTargetPoints:need,totalSourcePoints,cpp,economicCost:econCost,score,sources,transfers:sources.filter(x=>x.from!==a.source).length,explanation:buildExplanation(a,sources,econCost,cashValue)});
  }
  return results.sort((x,y)=>y.score-x.score).slice(0,50);
}

function buildExplanation(a,sources,econCost,cashValue){
  const bits=sources.map(s=>s.fromPoints.toLocaleString() + ' ' + (s.from==='amex'?'Amex MR':s.from==='chase'?'Chase UR':s.from==='capitalone'?'Capital One Miles':s.from==='citi'?'Citi ThankYou':s.from==='bilt'?'Bilt':s.from==='aeroplan'?'Aeroplan':s.from)).join(' + ');
  return `Use ${bits} to reach ${a.program} for ${a.mileageCost.toLocaleString()} points. Estimated points opportunity cost + taxes: $${econCost.toFixed(0)}${cashValue?`; estimated fare value: $${cashValue.toFixed(0)}`:''}.`;
}


function historicalContext(leg, history){
  const stats = routeHistoryStats(history, { provider: leg.provider, program: leg.source || leg.program, origin: leg.origin, destination: leg.destination, cabin: leg.cabin });
  if (!stats.count || stats.median == null) return null;
  const current = Number(leg.mileageCost);
  const pct = stats.median ? ((stats.median-current)/stats.median)*100 : null;
  let label = 'Near historical median';
  if (stats.min != null && current <= stats.min) label = 'At historical low';
  else if (pct >= 10) label = `${Math.round(pct)}% below historical median`;
  else if (pct <= -10) label = `${Math.round(Math.abs(pct))}% above historical median`;
  return {...stats,current,percentVsMedian:pct,label};
}

function optimizeTrip(legs, balances, prefs={}, history=[]){
  const transferData=globalThis.__transfers||{programs:{}};
  const state=Object.fromEntries(balances.map(b=>[b.code,{...b,remaining:num(b.balance)}]));
  const reqs=[]; let totalCash=0, totalTaxes=0;
  for(const leg of legs){
    if(!leg) continue;
    const need=Math.round(num(leg.mileageCost)); if(!need) return null;
    reqs.push({leg,source:leg.source,need,remaining:need});
    totalCash += num(leg.cashValue); totalTaxes += num(leg.totalTaxes)/100;
  }
  const sources=[]; const directByProgram={};
  for(const r of reqs){
    const avail=state[r.source]?.remaining||0; const use=Math.min(avail,r.remaining); if(use){state[r.source].remaining-=use;r.remaining-=use;(directByProgram[r.source]??=[]).push({leg:r.leg,points:use}); sources.push({from:r.source,fromPoints:use,targetProgram:r.source,reason:'Existing target-program points'});} }
  const edges=[];
  for(const r of reqs){
    const target=transferData.programs[r.source]; if(!target) return null;
    for(const [bank,e] of Object.entries(target.transfers||{})){
      if(!state[bank] || state[bank].remaining<=0) continue;
      const ep=effectiveRatio(e); if(ep<=0) continue;
      const unitCost=(state[bank].cpp||prefs.defaultCpp||1.5)/ep;
      edges.push({bank,e,req:r,ep,unitCost});
    }
  }
  edges.sort((a,b)=>a.unitCost-b.unitCost);
  for(const edge of edges){
    if(edge.req.remaining<=0 || state[edge.bank].remaining<=0) continue;
    const maxTarget=state[edge.bank].remaining*edge.ep;
    const targetTake=Math.min(edge.req.remaining,maxTarget);
    const sourceNeed=Math.ceil(targetTake/edge.ep);
    const sourceUsed=Math.min(sourceNeed,state[edge.bank].remaining);
    const actualTarget=Math.floor(sourceUsed*edge.ep);
    if(actualTarget<=0) continue;
    state[edge.bank].remaining-=sourceUsed; edge.req.remaining-=actualTarget;
    sources.push({from:edge.bank,fromPoints:sourceUsed,targetProgram:edge.req.source,targetPoints:actualTarget,ratio:edge.e.ratio,bonusPct:edge.e.bonusPct||0,days:edge.e.days||0,leg:edge.req.leg.leg});
  }
  if(reqs.some(r=>r.remaining>0)) return null;
  const totalSourcePoints=sources.reduce((s,x)=>s+x.fromPoints,0);
  const economicCost=sources.reduce((s,x)=>s+x.fromPoints*((state[x.from]?.cpp ?? prefs.defaultCpp ?? 1.5)/100),0)+totalTaxes;
  const cpp=totalCash>0?(totalCash-totalTaxes)/Math.max(1,totalSourcePoints)*100:null;
  const transferCount=sources.filter(x=>x.from!==x.targetProgram).length;
  const flexibilityPenalty=sources.reduce((s,x)=>s+(state[x.from]?.transferable?0:0.1*x.fromPoints/1000),0)+(transferCount>1?75:0);
  const historyAwareBonus = reqs.reduce((s,r)=>{ const h=historicalContext(r.leg,history); return s + (h?.percentVsMedian>10 ? Math.min(40,h.percentVsMedian*1.5) : h?.percentVsMedian<-10 ? Math.max(-40,h.percentVsMedian*1.5) : 0); },0);
  const score=(totalCash||0)-economicCost-flexibilityPenalty+historyAwareBonus;
  const legsOut=reqs.map(r=>({leg:r.leg.leg,source:r.source,program:PROGRAM_NAMES[r.source]||r.source,points:r.need,date:r.leg.date,origin:r.leg.origin,destination:r.leg.destination,history:historicalContext(r.leg,history)}));
  const historyBits=legsOut.filter(l=>l.history?.label).map(l=>`${l.program}: ${l.history.label}`).join('; ');
  return {id:`trip-${Math.random().toString(36).slice(2)}`,legs:legsOut,sources,totalTargetPoints:reqs.reduce((s,r)=>s+r.need,0),totalSourcePoints,cashValue:totalCash,totalTaxes,economicCost,cpp,score,transfers:transferCount,explanation:`Across the full trip, use existing airline miles first, then the lowest-opportunity-cost transferable currency for the remaining award balances. This calculation treats each bank currency as a scarce portfolio asset.${historyBits?` Historical context: ${historyBits}.`:''}`};
}

async function notify(alert, matches){
  if(!WEBHOOK) return {sent:false,reason:'No webhook configured'};
  const payload={text:`PointPilot alert: ${alert.title}`,content:`${matches.length} award match(es) found.`,matches:matches.slice(0,5)};
  const r=await fetch(WEBHOOK,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  return {sent:r.ok,status:r.status};
}

async function handle(req,res){
  if(req.method==='OPTIONS') return send(res,204,'');
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`); const p=u.pathname;
  try{
    globalThis.__transfers=await loadTransfer();
    if(req.method==='GET' && p==='/api/health') { const h=await loadHistory(); return send(res,200,{ok:true,mode:'direct+manual',awardObservations:h.length,transferSource:globalThis.__transfers.source,lastTransferUpdate:globalThis.__transfers.lastUpdated}); }
    if(req.method==='GET' && p==='/api/user') return send(res,200,await loadUser());
    if(req.method==='PUT' && p==='/api/user'){ const b=await body(req); await save(path.join(DATA,'user.json'),b); return send(res,200,{ok:true}); }
    if(req.method==='GET' && p==='/api/transfer-partners') return send(res,200,globalThis.__transfers);
    if(req.method==='GET' && p==='/api/providers') return send(res,200,{providers:listProviders()});
    if(req.method==='POST' && p==='/api/direct-search'){
      const b=await body(req);
      try{ const rows=await scrapeAuthorizedAwards({providerId:b.providerId,url:b.url}); await saveAwards(rows,{sourceType:'authorized_direct',sourceId:b.providerId,provider:b.providerId,sourceUrl:b.url}); return send(res,200,{mode:'direct',provider:b.providerId,rows}); }
      catch(e){ const code=e.code||'DIRECT_SEARCH_FAILED'; return send(res,code==='PROVIDER_RESTRICTED'||code==='PROVIDER_NOT_AUTHORIZED'?403:502,{error:e.message,code}); }
    }
    if(req.method==='POST' && p==='/api/manual-capture'){
      const b=await body(req); const result=await manualCapture({providerId:b.providerId,url:b.url}); return send(res,200,{ok:true,mode:'manual',...result});
    }
    if(req.method==='POST' && p==='/api/browser-capture-html') {
      const b=await body(req);
      const provider=String(b.providerId||'unknown');
      const captureDir=path.join(DATA,'captures'); await mkdir(captureDir,{recursive:true});
      const safeProvider=provider.replace(/[^a-z0-9_-]/gi,'_');
      const stamp=Date.now();
      const html=String(b.html||'');
      if(!html) return send(res,400,{error:'No HTML supplied'});
      const file=path.join(captureDir,`${safeProvider}-desktop-${stamp}.html`);
      await writeFile(file,html,'utf8');
      return send(res,201,{ok:true,provider,sourceUrl:b.url||null,title:b.title||null,file});
    }
    if(req.method==='POST' && p==='/api/manual-award'){
      const b=await body(req);
      const row={...b,product:'flight',dataSource:'manual',provider:b.provider,source:b.source||b.program||b.provider,program:b.program||b.source||b.provider,mileageCost:num(b.mileageCost),totalTaxes:num(b.totalTaxes),cashValue:num(b.cashValue),remainingSeats:num(b.remainingSeats)};
      await saveAwards([row],{sourceType:'manual_entry',sourceId:'manual-entry',provider:row.provider}); return send(res,201,{ok:true,row});
    }
    if(req.method==='POST' && p==='/api/manual-hotel'){
      const b=await body(req);
      const row={...b,product:'hotel',dataSource:'manual',provider:b.provider,program:b.program,nightlyPoints:num(b.nightlyPoints),cashValue:num(b.cashValue),cpp:num(b.nightlyPoints)>0?num(b.cashValue)*100/num(b.nightlyPoints):null};
      await saveAwards([row],{sourceType:'manual_entry',sourceId:'manual-entry',provider:row.provider}); return send(res,201,{ok:true,row});
    }
    if(req.method==='GET' && p==='/api/history'){
      const q=Object.fromEntries(u.searchParams); const history=await loadHistory();
      const rows=history.filter(x=> (!q.program || String(x.program).toLowerCase()===String(q.program).toLowerCase()) && (!q.origin || String(x.origin||'').toUpperCase()===String(q.origin).toUpperCase()) && (!q.destination || String(x.destination||'').toUpperCase()===String(q.destination).toUpperCase()) && (!q.cabin || String(x.cabin||'').toLowerCase()===String(q.cabin).toLowerCase()));
      return send(res,200,{rows:rows.slice(0,500),count:rows.length,generatedAt:new Date().toISOString()});
    }
    if(req.method==='GET' && p==='/api/history/stats'){
      const q=Object.fromEntries(u.searchParams); const history=await loadHistory(); return send(res,200,routeHistoryStats(history,q));
    }
    if(req.method==='GET' && p==='/api/history/sources') return send(res,200,{sources:await getSources()});

    if(req.method==='GET' && p==='/api/search/flights'){
      const q=Object.fromEntries(u.searchParams); const r=await searchFlights(q); if (r.rows?.length) await recordAwards(r.rows, {sourceType:'search_observation', sourceId:q.search_id || 'pointpilot-search', provider:'pointpilot-capture', observationKey:q.search_id || null, notes:'Observed during a PointPilot user search'}); return send(res,200,r);
    }
    if(req.method==='GET' && p==='/api/search/hotels'){
      const q=Object.fromEntries(u.searchParams); const r=await searchHotels(q); if (r.rows?.length) await recordAwards(r.rows, {sourceType:'search_observation', sourceId:q.search_id || 'pointpilot-search', provider:'pointpilot-capture', observationKey:q.search_id || null, notes:'Observed during a PointPilot user search'}); return send(res,200,r);
    }
    if(req.method==='POST' && p==='/api/optimize'){
      const b=await body(req); const r=optimize(b.awards||[],b.balances||[],b.preferences||{}); return send(res,200,{results:r});
    }
    if(req.method==='POST' && p==='/api/optimize-trip'){
      const b=await body(req); const history=await loadHistory(); const result=optimizeTrip(b.legs||[],b.balances||[],b.preferences||{},history); return send(res,200,{result});
    }
    if(req.method==='GET' && p==='/api/alerts') return send(res,200,await json(path.join(DATA,'alerts.json'),[]));
    if(req.method==='POST' && p==='/api/alerts'){ const b=await body(req); const alerts=await json(path.join(DATA,'alerts.json'),[]); const a={...b,id:Date.now().toString(),createdAt:new Date().toISOString(),active:true}; alerts.unshift(a); await save(path.join(DATA,'alerts.json'),alerts); return send(res,201,a); }
    if(req.method==='DELETE' && p.startsWith('/api/alerts/')){ const id=p.split('/').pop(); const alerts=(await json(path.join(DATA,'alerts.json'),[])).filter(a=>a.id!==id); await save(path.join(DATA,'alerts.json'),alerts); return send(res,200,{ok:true}); }
    if(req.method==='POST' && p==='/api/monitor/run') return send(res,200,await runMonitor());
    if(req.method==='GET'){
      if(p.startsWith('/fixtures/')){
        const fixture=path.join(FIXTURES,p.slice('/fixtures/'.length));
        if(!existsSync(fixture)) return send(res,404,{error:'Fixture not found'});
        return send(res,200,await readFile(fixture,'utf8'),'text/html; charset=utf-8');
      }
      let file=p==='/'?path.join(PUBLIC,'index.html'):path.join(PUBLIC,p.replace(/^\//,''));
      if(!existsSync(file)) file=path.join(PUBLIC,'index.html');
      const ext=path.extname(file); const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'}[ext]||'text/plain'; return send(res,200,await readFile(file,'utf8'),mime);
    }
    return send(res,404,{error:'Not found'});
  }catch(e){ console.error(e); return send(res,e.status||500,{error:e.message,details:e.details||null}); }
}

async function runMonitor(){
  const alerts=await json(path.join(DATA,'alerts.json'),[]); const active=alerts.filter(a=>a.active); const hits=[];
  for(const a of active){
    try{
      const r=await searchFlights({origin:a.origin,destination:a.destination,start_date:a.start_date,end_date:a.end_date,cabin:a.cabin||'business',travelers:a.travelers||1});
      if (r.mode==='manual') { hits.push({alertId:a.id,title:a.title,mode:'manual_required',message:'No captured inventory. Run the provider search manually to refresh PointPilot data.'}); continue; }
      const bal=await loadUser(); const opt=optimize(r.rows,bal.balances,bal.preferences); const matching=opt.filter(x=>(!a.maxPoints||x.totalTargetPoints<=a.maxPoints*(a.travelers||1)) && (!a.minCpp||num(x.cpp)>=num(a.minCpp)));
      if(matching.length){ const notice=await notify(a,matching); hits.push({alertId:a.id,title:a.title,count:matching.length,notice}); }
    }catch(e){ hits.push({alertId:a.id,title:a.title,error:e.message}); }
  }
  return {ranAt:new Date().toISOString(),alertsChecked:active.length,hits};
}

export { runMonitor };
export function startServer({port=PORT,onReady}={}) {
  const server=http.createServer(handle);
  server.listen(port,'127.0.0.1',()=>{
    const address=server.address();
    const actualPort=typeof address==='object' && address ? address.port : port;
    console.log(`PointPilot running at http://127.0.0.1:${actualPort} · direct/manual award data mode`);
    onReady?.(actualPort);
  });
  if(MONITOR_MIN>0) setInterval(()=>runMonitor().then(r=>r.hits.length&&console.log('Monitor hits',r.hits)).catch(console.error),MONITOR_MIN*60*1000);
  return server;
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) startServer();
