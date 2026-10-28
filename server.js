const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'shared-data.json');
const PROMPT_FILE = path.join(ROOT, 'agent-system-prompt.md');
const PORT = Number(process.env.PORT || 8080);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-astra';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

const now = () => new Date().toISOString();
const makeId = prefix => `${prefix}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

function seedTrace(id, type, text, visibility, encounters, tags) {
  const versionId = `${id}-V1`;
  return {
    trace: {
      id, type, text, visibility, owner: 'anonymous', originParticipantId: 'seed',
      currentVersionId: versionId, versionCount: 1, encounters, tags,
      state: 'alive', live: true, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z'
    },
    version: {
      id: versionId, traceId: id, parentVersionId: null, number: 1, text,
      participantId: 'seed', originType: 'seed', createdAt: '2026-10-28T00:00:00.000Z'
    }
  };
}

const seeded = [
  seedTrace('Q-001','question','Як зрозуміти, що думка справді твоя?','world',6,['авторство','думка','AI']),
  seedTrace('T-002','trace','Можна змінити думку і стати трохи іншим.','world',4,['зміна','увага']),
  seedTrace('Q-003','question','Що відкриває те, за чим ще немає готового світу?','world',7,['двері','простір','майбутнє']),
  seedTrace('T-004','trace','Двері важливі саме тому, що за ними ще нічого немає.','world',5,['двері','простір','незавершеність']),
  seedTrace('T-005','trace','Стару версію варто лишати видимою, щоб не стирати дорогу, якою сюди прийшли.','world',3,['версії','пам’ять','правило'])
];

const initialData = {
  version: 'v0.3',
  traces: seeded.map(x=>x.trace),
  traceVersions: seeded.map(x=>x.version),
  traceEvents: [],
  participantTraceState: [],
  spaceCandidate: {
    id:'SPACE-SEED-01', label:'поки без назви', traceIds:['Q-003','T-004'],
    hypothesis:'Можливо, тут збирається Місце навколо переходу в те, чого ще немає.',
    evidence:['образ дверей повернувся в кількох Слідах','обидва Сліди пережили більше ніж одну зустріч','у них повторюється незавершеність і наступний шар'],
    responses:[], status:'candidate'
  },
  spaces: [],
  traceLinks: [],
  agentChanges: [
    { version:'v0.1.1', title:'Пам’ять без досьє', body:'Я зберігаю спільні Сліди й питання, а не прихований психологічний профіль людини.', status:'діє' },
    { version:'v0.1.2', title:'Менше серійних питань', body:'Після корекції учасників я рідше ставлю кілька питань поспіль і частіше даю власну версію.', status:'перевіряється' },
    { version:'v0.2.1', title:'Proposal ≠ truth', body:'Коли я бачу Тяжіння між Слідами, я показую підстави й пропоную форму спільноті. Я не оголошую її істинною.', status:'діє' },
    { version:'v0.3.0', title:'Пам’ять отримала версії', body:'Слід більше не переписує минуле: кожне продовження створює нову видиму версію.', status:'нове' }
  ]
};

const responseSchema = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    attention_shift: { type: 'string' },
    trace_candidate: {
      type: 'object',
      properties: {
        should_offer: { type: 'boolean' },
        type: { type: 'string', enum: ['trace','question'] },
        text: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['should_offer','type','text','reason'],
      additionalProperties: false
    },
    possible_relations: {
      type: 'array', maxItems: 3,
      items: {
        type: 'object',
        properties: {
          trace_id: { type: 'string' },
          relation: { type: 'string', enum: ['continuation','contradiction','image','shared_worry','other'] },
          explanation: { type: 'string' }
        },
        required: ['trace_id','relation','explanation'], additionalProperties: false
      }
    },
    agent_change_candidate: {
      type: 'object',
      properties: {
        should_offer: { type: 'boolean' }, summary: { type: 'string' }, reason: { type: 'string' }
      },
      required: ['should_offer','summary','reason'], additionalProperties: false
    },
    safety: {
      type: 'object',
      properties: { level: { type: 'string', enum: ['none','watch','escalate'] }, note: { type: 'string' } },
      required: ['level','note'], additionalProperties: false
    }
  },
  required: ['message','attention_shift','trace_candidate','possible_relations','agent_change_candidate','safety'],
  additionalProperties: false
};

function ensureShape(data){
  data.version = 'v0.3';
  data.traces = Array.isArray(data.traces) ? data.traces : [];
  data.traceVersions = Array.isArray(data.traceVersions) ? data.traceVersions : [];
  data.traceEvents = Array.isArray(data.traceEvents) ? data.traceEvents : [];
  data.participantTraceState = Array.isArray(data.participantTraceState) ? data.participantTraceState : [];
  data.traceLinks = Array.isArray(data.traceLinks) ? data.traceLinks : [];
  data.spaces = Array.isArray(data.spaces) ? data.spaces : [];
  data.agentChanges = Array.isArray(data.agentChanges) ? data.agentChanges : [];
  for(const t of data.traces){
    if(!t.state) t.state = t.live === false ? 'released' : 'alive';
    t.live = t.state !== 'released';
    if(!t.versionCount) t.versionCount = 1;
    if(!t.currentVersionId){
      const vid = `${t.id}-V1`;
      t.currentVersionId = vid;
      if(!data.traceVersions.some(v=>v.id===vid)) data.traceVersions.push({id:vid,traceId:t.id,parentVersionId:null,number:1,text:t.text,participantId:t.originParticipantId||'legacy',originType:'legacy',createdAt:t.createdAt||now()});
    }
    if(!t.updatedAt) t.updatedAt = t.createdAt || now();
  }
  return data;
}
function ensureData(){
  if(!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify(initialData,null,2));
  else { const d=ensureShape(JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))); fs.writeFileSync(DATA_FILE,JSON.stringify(d,null,2)); }
}
function readData(){ ensureData(); return ensureShape(JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))); }
function writeData(data){ fs.writeFileSync(DATA_FILE, JSON.stringify(ensureShape(data),null,2)); }
function systemPrompt(){ return fs.readFileSync(PROMPT_FILE,'utf8'); }
function json(res,status,payload){ res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(payload)); }
function readBody(req){
  return new Promise((resolve,reject)=>{
    let body='';
    req.on('data',chunk=>{ body+=chunk; if(body.length>1_000_000) req.destroy(); });
    req.on('end',()=>{ try{ resolve(body?JSON.parse(body):{}); }catch(e){ reject(e); } });
    req.on('error',reject);
  });
}
function safeText(value,max=1600){ return String(value||'').replace(/[\u0000-\u001F\u007F]/g,' ').trim().slice(0,max); }
function safeTags(tags){ return Array.isArray(tags) ? tags.map(x=>safeText(x,40)).filter(Boolean).slice(0,8) : []; }
function safeParticipant(value){ return safeText(value,120).replace(/[^A-Za-z0-9_-]/g,'').slice(0,120) || 'anonymous'; }
function safeHistory(history){
  if(!Array.isArray(history)) return [];
  return history.slice(-16).map(item=>({ role:item && item.role==='agent'?'assistant':'user', content:safeText(item && item.text,1800) })).filter(x=>x.content);
}
function publicTraces(data){ return data.traces.filter(t=>t.state!=='released' && (t.visibility==='world'||t.visibility==='anonymous')); }
function traceVersions(data,traceId){ return data.traceVersions.filter(v=>v.traceId===traceId).sort((a,b)=>a.number-b.number || a.createdAt.localeCompare(b.createdAt)); }
function stateFor(data,participantId,traceId){ return data.participantTraceState.find(x=>x.participantId===participantId && x.traceId===traceId); }
function upsertParticipantState(data,participantId,traceId,patch={}){
  if(!participantId || participantId==='anonymous') return null;
  let item=stateFor(data,participantId,traceId);
  if(!item){ item={participantId,traceId,state:'seen',lastSeenVersionId:null,lastSeenAt:null,createdAt:now()}; data.participantTraceState.push(item); }
  Object.assign(item,patch,{updatedAt:now()});
  return item;
}
function addEvent(data,traceId,eventType,participantId,versionId=null,detail=''){
  const ev={id:makeId('E'),traceId,eventType,participantId:participantId||'anonymous',versionId,detail:safeText(detail,600),createdAt:now()};
  data.traceEvents.push(ev); return ev;
}
function selectSharedTraces(data,userText){
  const words=new Set(safeText(userText,1200).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x=>x.length>=4));
  return publicTraces(data).map(t=>{
    const hay=`${t.text} ${(t.tags||[]).join(' ')}`.toLowerCase();
    let score=Math.min(Number(t.encounters||0),10)*0.05;
    for(const w of words) if(hay.includes(w)) score+=1;
    return {t,score};
  }).sort((a,b)=>b.score-a.score).slice(0,8).map(x=>x.t);
}
function traceContext(traces){
  if(!traces.length) return 'Дозволених спільних Слідів для цієї зустрічі немає.';
  return 'Дозволені спільні Сліди. Можливі зв’язки можна пропонувати ЛИШЕ до цих ID:\n'+traces.map(t=>`- ${t.id} [${t.type}]: ${t.text} | версій: ${t.versionCount||1} | теги: ${(t.tags||[]).join(', ')}`).join('\n');
}
function extractOutputText(payload){
  for(const item of payload.output||[]){
    if(item.type!=='message') continue;
    for(const content of item.content||[]){
      if(content.type==='refusal') return {refusal:content.refusal||'Запит відхилено моделлю.'};
      if(content.type==='output_text') return {text:content.text};
    }
  }
  return {};
}
function normalizeModelOutput(out,allowedIds){
  const relations=Array.isArray(out.possible_relations)?out.possible_relations.filter(r=>allowedIds.has(r.trace_id)).slice(0,3):[];
  return {
    message:safeText(out.message,2600)||'Я зараз не зміг сформувати відповідь. Спробуймо ще раз.',
    attention_shift:safeText(out.attention_shift,700),
    trace_candidate:{
      should_offer:!!(out.trace_candidate&&out.trace_candidate.should_offer),
      type:out.trace_candidate&&out.trace_candidate.type==='question'?'question':'trace',
      text:safeText(out.trace_candidate&&out.trace_candidate.text,600),
      reason:safeText(out.trace_candidate&&out.trace_candidate.reason,600)
    },
    possible_relations:relations.map(r=>({trace_id:r.trace_id,relation:r.relation,explanation:safeText(r.explanation,600)})),
    agent_change_candidate:{
      should_offer:!!(out.agent_change_candidate&&out.agent_change_candidate.should_offer),
      summary:safeText(out.agent_change_candidate&&out.agent_change_candidate.summary,600),
      reason:safeText(out.agent_change_candidate&&out.agent_change_candidate.reason,600)
    },
    safety:{level:['none','watch','escalate'].includes(out.safety&&out.safety.level)?out.safety.level:'none',note:safeText(out.safety&&out.safety.note,500)}
  };
}
async function callOpenAI({history,userText,sharedTraces}){
  const input=[
    {role:'system',content:systemPrompt()},
    {role:'system',content:traceContext(sharedTraces)},
    ...safeHistory(history),
    {role:'user',content:safeText(userText,1800)}
  ];
  const body={model:OPENAI_MODEL,input,store:false,max_output_tokens:1100,text:{format:{type:'json_schema',name:'mythopoetic_agent_turn',strict:true,schema:responseSchema}}};
  const r=await fetch(`${OPENAI_BASE_URL}/responses`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}`},body:JSON.stringify(body),signal:AbortSignal.timeout(45_000)});
  const payload=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(`OpenAI ${r.status}: ${payload.error?.message||'request failed'}`);
  if(payload.status==='incomplete') throw new Error(`OpenAI response incomplete: ${payload.incomplete_details?.reason||'unknown'}`);
  const extracted=extractOutputText(payload);
  if(extracted.refusal) return {message:extracted.refusal,attention_shift:'',trace_candidate:{should_offer:false,type:'trace',text:'',reason:''},possible_relations:[],agent_change_candidate:{should_offer:false,summary:'',reason:''},safety:{level:'watch',note:'Модель відмовилася відповідати на запит.'}};
  if(!extracted.text) throw new Error('OpenAI returned no output_text');
  return normalizeModelOutput(JSON.parse(extracted.text),new Set(sharedTraces.map(t=>t.id)));
}
function fallbackTurn(userText,history,sharedTraces){
  const t=safeText(userText,1800); const lower=t.toLowerCase(); const userTurns=(history||[]).filter(m=>m.role==='user').length;
  let message='Я не хочу закривати це першою відповіддю. У твоїй фразі вже є рух. Що в ній для тебе змінилося після того, як ти її написав?';
  let shift='Я дивився на зміст відповіді, а тепер помічаю спосіб, яким вона була побудована.';
  if(lower.includes('не хочу')||lower.includes('не знаю')){ message='Добре. Нічого про тебе не вирішуємо. Можемо торкнутися того, що вже залишив хтось інший.'; shift='Замість пошуку відповіді я залишив місце для відмови.'; }
  else if(lower.includes('ai')||lower.includes('ші')||lower.includes('штуч')){ message='Я вже майже пішов у пояснення про AI, але тут живе інше питання: хто стає автором, коли на думку впливають двоє?'; shift='З результату моє Внимання змістилося до авторства.'; }
  else if(userTurns===0){ message='Добре. Я не буду цього припускати. Зараз замість «хто ти?» я бачу межу, яку ти вже поставив між нами. Що привело тебе сюди саме зараз?'; shift='Я перестав будувати першу версію людини з самого факту її входу.'; }
  const relations=[];
  for(const tr of sharedTraces){
    if((tr.tags||[]).some(tag=>lower.includes(String(tag).toLowerCase()))){ relations.push({trace_id:tr.id,relation:'shared_worry',explanation:'У поточній фразі повертається слово або Волнение, яке вже є в цьому Сліді.'}); if(relations.length===2) break; }
  }
  return {message,attention_shift:shift,trace_candidate:{should_offer:t.length>20,type:t.includes('?')?'question':'trace',text:t.slice(0,300),reason:'Ця фраза може пережити одну розмову й бути продовжена наступною людиною.'},possible_relations:relations,agent_change_candidate:{should_offer:false,summary:'',reason:''},safety:{level:'none',note:''}};
}

function returnSummary(data,participantId){
  if(!participantId || participantId==='anonymous') return {count:0,changes:[]};
  const originated=data.traces.filter(t=>t.originParticipantId===participantId && t.state!=='released');
  const changes=[];
  for(const trace of originated){
    const versions=traceVersions(data,trace.id);
    const mine=versions.filter(v=>v.participantId===participantId);
    const others=versions.filter(v=>v.participantId!==participantId && v.participantId!=='seed');
    if(!others.length) continue;
    const ps=stateFor(data,participantId,trace.id);
    const lastSeenAt=ps&&ps.lastSeenAt?ps.lastSeenAt:trace.createdAt;
    const newOthers=others.filter(v=>v.createdAt>lastSeenAt);
    if(!newOthers.length) continue;
    changes.push({
      traceId:trace.id,
      type:trace.type,
      originalText:mine[0]?.text||versions[0]?.text||trace.text,
      currentText:trace.text,
      currentVersionId:trace.currentVersionId,
      versionCount:versions.length,
      newVersionCount:newOthers.length,
      latestOtherVersion:newOthers[newOthers.length-1],
      state:trace.state,
      updatedAt:trace.updatedAt
    });
  }
  return {count:changes.length,changes:changes.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))};
}
function publicState(data,participantId){
  const visibleTraces=data.traces.filter(t=>t.visibility!=='private');
  const visibleIds=new Set(visibleTraces.map(t=>t.id));
  return {
    version:data.version,
    traces:visibleTraces,
    traceVersions:data.traceVersions.filter(v=>visibleIds.has(v.traceId)),
    traceEvents:data.traceEvents.filter(e=>visibleIds.has(e.traceId)),
    participantTraceState:data.participantTraceState.filter(x=>x.participantId===participantId),
    spaceCandidate:data.spaceCandidate,
    spaces:data.spaces,
    traceLinks:data.traceLinks,
    agentChanges:data.agentChanges,
    returnSummary:returnSummary(data,participantId)
  };
}

async function handleApi(req,res,url){
  if(req.method==='GET'&&url.pathname==='/api/config') return json(res,200,{llmEnabled:!!OPENAI_API_KEY,model:OPENAI_MODEL,version:'v0.3'});
  if(req.method==='GET'&&url.pathname==='/api/state'){
    const participantId=safeParticipant(url.searchParams.get('participant_id'));
    return json(res,200,publicState(readData(),participantId));
  }
  if(req.method==='GET'&&url.pathname==='/api/return'){
    const participantId=safeParticipant(url.searchParams.get('participant_id'));
    return json(res,200,returnSummary(readData(),participantId));
  }
  if(req.method==='POST'&&url.pathname==='/api/chat'){
    const body=await readBody(req); const userText=safeText(body.message,1800); if(!userText) return json(res,400,{error:'empty_message'});
    const data=readData(); const sharedTraces=selectSharedTraces(data,userText);
    try{
      const turn=OPENAI_API_KEY?await callOpenAI({history:body.history,userText,sharedTraces}):fallbackTurn(userText,body.history,sharedTraces);
      return json(res,200,{mode:OPENAI_API_KEY?'llm':'fallback',model:OPENAI_API_KEY?OPENAI_MODEL:null,turn,sharedTraceIds:sharedTraces.map(t=>t.id)});
    }catch(err){ console.error('chat error',err); return json(res,200,{mode:'fallback-after-error',model:null,warning:'LLM тимчасово недоступний; використано локальний fallback.',turn:fallbackTurn(userText,body.history,sharedTraces),sharedTraceIds:sharedTraces.map(t=>t.id)}); }
  }
  if(req.method==='POST'&&url.pathname==='/api/traces'){
    const body=await readBody(req); const text=safeText(body.text,600); if(!text) return json(res,400,{error:'empty_trace'});
    const participantId=safeParticipant(body.participant_id); const visibility=['anonymous','world'].includes(body.visibility)?body.visibility:'anonymous'; const data=readData();
    const id=makeId(body.type==='question'?'Q':'T'); const versionId=makeId('TV'); const createdAt=now();
    const trace={id,type:body.type==='question'?'question':'trace',text,visibility,owner:'anonymous',originParticipantId:participantId,currentVersionId:versionId,versionCount:1,encounters:1,tags:safeTags(body.tags),state:'alive',live:true,createdAt,updatedAt:createdAt};
    const version={id:versionId,traceId:id,parentVersionId:null,number:1,text,participantId,originType:'created',createdAt};
    data.traces.push(trace); data.traceVersions.push(version); addEvent(data,id,'created',participantId,versionId,'Початкова версія Сліду'); addEvent(data,id,'confirmed',participantId,versionId,'Людина підтвердила Слід');
    if(visibility!=='private') addEvent(data,id,'shared',participantId,versionId,visibility);
    upsertParticipantState(data,participantId,id,{state:'created',lastSeenVersionId:versionId,lastSeenAt:createdAt,origin:true}); writeData(data);
    return json(res,201,{trace,version});
  }
  const traceMatch=url.pathname.match(/^\/api\/traces\/([^/]+)\/(encounter|continue|state|ack)$/);
  if(traceMatch&&req.method==='POST'){
    const traceId=safeText(decodeURIComponent(traceMatch[1]),140); const action=traceMatch[2]; const body=await readBody(req); const participantId=safeParticipant(body.participant_id); const data=readData(); const trace=data.traces.find(t=>t.id===traceId);
    if(!trace) return json(res,404,{error:'trace_not_found'});
    if(action==='encounter'){
      trace.encounters=Number(trace.encounters||0)+1; trace.updatedAt=now(); addEvent(data,traceId,'encountered',participantId,trace.currentVersionId,'Слід зустрінуто'); upsertParticipantState(data,participantId,traceId,{state:'seen',lastSeenVersionId:trace.currentVersionId,lastSeenAt:now()}); writeData(data); return json(res,200,{trace});
    }
    if(action==='continue'){
      const text=safeText(body.text,600); if(!text) return json(res,400,{error:'empty_version'}); if(trace.state==='released') return json(res,409,{error:'trace_released'});
      const versions=traceVersions(data,traceId); const parentId=safeText(body.parent_version_id,140)||trace.currentVersionId; if(!versions.some(v=>v.id===parentId)) return json(res,400,{error:'invalid_parent_version'});
      const versionId=makeId('TV'); const createdAt=now(); const version={id:versionId,traceId,parentVersionId:parentId,number:versions.length+1,text,participantId,originType:'continued',createdAt};
      data.traceVersions.push(version); trace.text=text; trace.currentVersionId=versionId; trace.versionCount=versions.length+1; trace.updatedAt=createdAt; trace.encounters=Number(trace.encounters||0)+1;
      addEvent(data,traceId,'continued',participantId,versionId,`Продовжено версію ${parentId}`); addEvent(data,traceId,'transformed',participantId,versionId,'Поточна форма Сліду змінилася'); upsertParticipantState(data,participantId,traceId,{state:'continued',lastSeenVersionId:versionId,lastSeenAt:createdAt}); writeData(data); return json(res,201,{trace,version,versions:traceVersions(data,traceId)});
    }
    if(action==='state'){
      if(trace.originParticipantId!==participantId) return json(res,403,{error:'only_origin_can_change_state'}); const next=['alive','sleeping','released'].includes(body.state)?body.state:'alive'; trace.state=next; trace.live=next!=='released'; trace.updatedAt=now(); addEvent(data,traceId,next==='released'?'released':next==='sleeping'?'slept':'reactivated',participantId,trace.currentVersionId,next); upsertParticipantState(data,participantId,traceId,{state:next,lastSeenVersionId:trace.currentVersionId,lastSeenAt:now()}); writeData(data); return json(res,200,{trace});
    }
    if(action==='ack'){
      upsertParticipantState(data,participantId,traceId,{state:'returned',lastSeenVersionId:trace.currentVersionId,lastSeenAt:now()}); addEvent(data,traceId,'returned',participantId,trace.currentVersionId,'Перший учасник повернувся до зміненого Сліду'); writeData(data); return json(res,200,{trace});
    }
  }
  if(req.method==='POST'&&url.pathname==='/api/trace-links'){
    const body=await readBody(req); const sourceId=safeText(body.source_id,140); const targetId=safeText(body.target_id,140); const relation=['continuation','contradiction','image','shared_worry','other'].includes(body.relation)?body.relation:'other'; const explanation=safeText(body.explanation,600); if(!sourceId||!targetId||sourceId===targetId) return json(res,400,{error:'invalid_link'});
    const data=readData(); if(!data.traces.find(t=>t.id===sourceId)||!data.traces.find(t=>t.id===targetId)) return json(res,404,{error:'trace_not_found'}); const exists=data.traceLinks.find(x=>x.source_id===sourceId&&x.target_id===targetId&&x.relation===relation); if(exists) return json(res,200,{link:exists}); const link={id:makeId('L'),source_id:sourceId,target_id:targetId,relation,explanation,status:'confirmed_by_participant',createdAt:now()}; data.traceLinks.push(link); writeData(data); return json(res,201,{link});
  }
  if(req.method==='POST'&&url.pathname==='/api/agent-changes'){
    const body=await readBody(req); const summary=safeText(body.summary,600); if(!summary) return json(res,400,{error:'empty_change'}); const data=readData(); const item={version:`v0.3.c${data.agentChanges.length+1}`,title:summary,body:safeText(body.reason,600)||'Корекцію запропоновано учасником після взаємодії з Агентом.',status:'кандидат',createdAt:now()}; data.agentChanges.push(item); writeData(data); return json(res,201,{change:item});
  }
  if(req.method==='POST'&&url.pathname==='/api/space-decision'){
    const body=await readBody(req); const decision=['confirm','different','hold','reject'].includes(body.decision)?body.decision:'hold'; const note=safeText(body.note,400); const data=readData(); data.spaceCandidate.responses.push({decision,note,at:now()}); if(decision==='different'&&note) data.spaceCandidate.hypothesis=`Спільнота бачить інше: ${note}`; if(decision==='reject') data.spaceCandidate.status='rejected'; if(decision==='confirm'&&data.spaceCandidate.status!=='born'){ const name=note||'Двері без кімнати'; data.spaceCandidate.status='born'; data.spaces.push({id:'SPACE-001',origin:data.spaceCandidate.id,name,worry:'Що відкриває те, за чим ще немає готового світу?',traceIds:[...data.spaceCandidate.traceIds],bornAt:now(),status:'alive',unfinished:['Що відбувається після другого входу?','Яке правило тут уже виникає, хоча ми його не назвали?']}); }
    writeData(data); return json(res,200,publicState(data,'anonymous'));
  }
  return json(res,404,{error:'not_found'});
}

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
function serveStatic(res,url){
  let rel=decodeURIComponent(url.pathname); if(rel==='/') rel='/index.html'; const file=path.normalize(path.join(ROOT,rel)); if(!file.startsWith(ROOT)){ res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file,(err,buf)=>{ if(err){ res.writeHead(404); return res.end('Not found'); } res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'}); res.end(buf); });
}

ensureData();
const server=http.createServer(async(req,res)=>{ const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); try{ if(url.pathname.startsWith('/api/')) return await handleApi(req,res,url); serveStatic(res,url); }catch(err){ console.error(err); json(res,500,{error:'server_error'}); } });
server.listen(PORT,'0.0.0.0',()=>{ console.log(`Міфопоетичний Агент v0.3: http://localhost:${PORT}`); console.log(OPENAI_API_KEY?`LLM: ${OPENAI_MODEL}`:'LLM: OFF — локальний fallback'); });
