import http from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=process.env.POINTPILOT_DATA_DIR?path.resolve(process.env.POINTPILOT_DATA_DIR):path.join(ROOT,'data');
const PUBLIC=path.join(ROOT,'public');
const PORT=Number(process.env.PORT||3000);
const providers=[['american','American Airlines AAdvantage','flight'],['united','United MileagePlus','flight'],['aeroplan','Air Canada Aeroplan','flight'],['flyingblue','Air France-KLM Flying Blue','flight'],['hyatt','World of Hyatt','hotel'],['hilton','Hilton Honors','hotel'],['marriott','Marriott Bonvoy','hotel']].map(([id,name,product])=>({id,name,product,mode:'restricted'}));
const files={user:'user.json',history:'price-history.json',awards:'award-cache.json',alerts:'alerts.json'};
async function read(name,fallback=[]){try{return JSON.parse(await readFile(path.join(DATA,files[name]),'utf8'))}catch{return fallback}}
async function write(name,v){await mkdir(DATA,{recursive:true});await writeFile(path.join(DATA,files[name]),JSON.stringify(v,null,2))}
function send(res,status,obj,type='application/json'){res.writeHead(status,{'Content-Type':type,'Access-Control-Allow-Origin':'*'});res.end(type.startsWith('application/json')?JSON.stringify(obj):obj)}
async function body(req){let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{}}
function n(v){const x=Number(String(v??'').replace(/[$,]/g,''));return Number.isFinite(x)?x:0}
function id(){return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8)}
function median(a){a=[...a].sort((x,y)=>x-y);if(!a.length)return null;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
async function addHistory(row){const h=await read('history',[]);h.unshift({...row,id:row.id||id(),observedAt:row.observedAt||new Date().toISOString()});await write('history',h.slice(0,50000));return h[0]}
async function optimize(awards,balances=[]){const b=Object.fromEntries(balances.map(x=>[x.code,n(x.balance)]));return awards.map(a=>{const need=n(a.mileageCost),direct=Math.min(need,b[a.source]||0),remain=need-direct;let sourcePoints=direct,sources=direct?[{from:a.source,points:direct}]:[];const bankOrder=balances.filter(x=>x.transferable!==false&&n(x.balance)>0).sort((x,y)=>n(x.cpp||1.5)-n(y.cpp||1.5));for(const x of bankOrder){if(!remain)break;const ratio=n(x.ratio||1),take=Math.min(Math.ceil(remain/ratio),n(x.balance));if(take){const target=take*ratio;sourcePoints+=take;sources.push({from:x.code,points:take,targetPoints:target});}}
const taxes=n(a.totalTaxes),cash=n(a.cashValue);return {...a,totalSourcePoints:sourcePoints,transfers:sources.length-(direct?1:0),sources,cpp:cash?(cash-taxes)/Math.max(1,sourcePoints)*100:null,bookable:sourcePoints>=need,explanation:sourcePoints>=need?`Use ${sources.map(x=>x.points.toLocaleString()+' '+x.from).join(' + ')} for ${need.toLocaleString()} ${a.program} points.`:'Insufficient portfolio balance.'}}).sort((a,b)=>(b.cpp||0)-(a.cpp||0))}
async function handle(req,res){if(req.method==='OPTIONS')return send(res,204,'');const u=new URL(req.url,'http://localhost');try{
if(req.method==='GET'&&u.pathname==='/api/health')return send(res,200,{ok:true,version:'0.5.0',history:(await read('history',[])).length});
if(req.method==='GET'&&u.pathname==='/api/providers')return send(res,200,{providers});
if(req.method==='GET'&&u.pathname==='/api/user')return send(res,200,await read('user',{balances:[],preferences:{}}));
if(req.method==='PUT'&&u.pathname==='/api/user'){const x=await body(req);await write('user',x);return send(res,200,{ok:true})}
if(req.method==='GET'&&u.pathname==='/api/history'){let h=await read('history',[]);for(const k of ['program','origin','destination','cabin'])if(u.searchParams.get(k))h=h.filter(x=>String(x[k]||'').toLowerCase()===u.searchParams.get(k).toLowerCase());return send(res,200,{rows:h.slice(0,1000),count:h.length})}
if(req.method==='GET'&&u.pathname==='/api/history/stats'){const q=Object.fromEntries(u.searchParams),h=await read('history',[]);const rows=h.filter(x=>(!q.program||String(x.program).toLowerCase()===q.program.toLowerCase())&&(!q.origin||x.origin===q.origin.toUpperCase())&&(!q.destination||x.destination===q.destination.toUpperCase())&&(!q.cabin||String(x.cabin).toLowerCase()===q.cabin.toLowerCase()));const pts=rows.map(x=>n(x.pointsCommon??x.mileageCost)).filter(Boolean);return send(res,200,{count:pts.length,min:pts.length?Math.min(...pts):null,median:median(pts),max:pts.length?Math.max(...pts):null})}
if(req.method==='POST'&&u.pathname==='/api/manual-award'){const x=await body(req),row={...x,id:id(),product:'flight',mileageCost:n(x.mileageCost),totalTaxes:n(x.totalTaxes),cashValue:n(x.cashValue),observedAt:new Date().toISOString(),sourceType:'manual_entry'};const a=await read('awards',[]);a.unshift(row);await write('awards',a);await addHistory({...row,pointsCommon:row.mileageCost});return send(res,201,{ok:true,row})}
if(req.method==='POST'&&u.pathname==='/api/manual-hotel'){const x=await body(req),row={...x,id:id(),product:'hotel',nightlyPoints:n(x.nightlyPoints),cashValue:n(x.cashValue),observedAt:new Date().toISOString(),sourceType:'manual_entry'};const a=await read('awards',[]);a.unshift(row);await write('awards',a);await addHistory({...row,pointsCommon:row.nightlyPoints});return send(res,201,{ok:true,row})}
if(req.method==='POST'&&u.pathname==='/api/optimize'){const x=await body(req);return send(res,200,{results:await optimize(x.awards||[],x.balances||[])})}
if(req.method==='POST'&&u.pathname==='/api/optimize-trip'){const x=await body(req),all=[];for(const leg of x.legs||[])all.push(...(leg.awards||[]));return send(res,200,{result:{legs:x.legs||[],recommendations:await optimize(all,x.balances||[])}})}
if(req.method==='GET'&&u.pathname==='/api/alerts')return send(res,200,await read('alerts',[]));
if(req.method==='POST'&&u.pathname==='/api/alerts'){const x=await body(req),a=await read('alerts',[]);const row={...x,id:id(),createdAt:new Date().toISOString(),active:true};a.unshift(row);await write('alerts',a);return send(res,201,row)}
if(req.method==='DELETE'&&u.pathname.startsWith('/api/alerts/')){const idv=u.pathname.split('/').pop();await write('alerts',(await read('alerts',[])).filter(x=>x.id!==idv));return send(res,200,{ok:true})}
if(req.method==='GET'){let f=u.pathname==='/'?path.join(PUBLIC,'index.html'):path.join(PUBLIC,u.pathname.slice(1));if(!existsSync(f))f=path.join(PUBLIC,'index.html');const ext=path.extname(f),mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'}[ext]||'text/plain';return send(res,200,await readFile(f,'utf8'),mime)}
return send(res,404,{error:'Not found'})}catch(e){return send(res,500,{error:e.message})}}
export function startServer({port=PORT,onReady}={}){const s=http.createServer(handle);s.listen(port,'127.0.0.1',()=>onReady?.(s.address().port));return s}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href)startServer();
