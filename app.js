const KEY = 'mythopoetic-agent-v03';
const OLD_KEY = 'mythopoetic-agent-v02';

function makeParticipantId(){
  return (crypto.randomUUID ? crypto.randomUUID() : `P-${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g,'');
}
function migratedParticipant(){
  try{
    const old=JSON.parse(localStorage.getItem(OLD_KEY)||'{}');
    if(old.participant?.localId) return String(old.participant.localId);
  }catch{}
  return makeParticipantId();
}

const seedState = {
  participant:{localId:migratedParticipant()},
  conversations:[], currentConversation:null,
  traces:[], traceVersions:[], traceEvents:[], participantTraceState:[],
  spaceCandidate:null, spaces:[], traceLinks:[], agentChanges:[],
  returnSummary:{count:0,changes:[]},
  firstRun:true
};

let state=loadState();
let pendingTrace=null;
let pendingAgentChange=null;
let pendingContinuation=null;
let chatBusy=false;
let runtimeConfig={llmEnabled:false,model:null,version:'v0.3'};

function cloneSeed(){ return JSON.parse(JSON.stringify(seedState)); }
function loadState(){
  const saved=localStorage.getItem(KEY);
  if(!saved) return cloneSeed();
  try{
    const parsed=JSON.parse(saved);
    const merged={...cloneSeed(),...parsed};
    if(!merged.participant?.localId) merged.participant={localId:migratedParticipant()};
    return merged;
  }catch{ return cloneSeed(); }
}
function saveState(){ localStorage.setItem(KEY,JSON.stringify(state)); }
function escapeHtml(s){ return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function participantId(){ return state.participant.localId; }
function localPrivateTraces(){ return state.traces.filter(t=>t.owner==='local'&&t.visibility==='private'); }
function versionsFor(traceId){ return (state.traceVersions||[]).filter(v=>v.traceId===traceId).sort((a,b)=>a.number-b.number||String(a.createdAt).localeCompare(String(b.createdAt))); }
function myTrace(t){ return (t.owner==='local'&&t.visibility==='private') || t.originParticipantId===participantId(); }

async function loadConfig(){
  if(location.protocol==='file:'){ runtimeConfig={llmEnabled:false,model:null,version:'v0.3'}; return renderRuntimeStatus(); }
  try{ const r=await fetch('/api/config',{cache:'no-store'}); if(r.ok) runtimeConfig=await r.json(); }catch{}
  renderRuntimeStatus();
}
function renderRuntimeStatus(){
  const badge=document.getElementById('runtimeBadge'); if(!badge) return;
  badge.textContent=runtimeConfig.llmEnabled?`LLM · ${runtimeConfig.model}`:'DEMO · fallback';
  badge.classList.toggle('live',!!runtimeConfig.llmEnabled);
}

async function syncSharedState(){
  if(location.protocol==='file:') return false;
  try{
    const r=await fetch(`/api/state?participant_id=${encodeURIComponent(participantId())}`,{cache:'no-store'}); if(!r.ok) return false;
    const shared=await r.json();
    const privateTraces=localPrivateTraces();
    const privateIds=new Set(privateTraces.map(t=>t.id));
    const privateVersions=(state.traceVersions||[]).filter(v=>privateIds.has(v.traceId));
    const privateEvents=(state.traceEvents||[]).filter(e=>privateIds.has(e.traceId));
    state.traces=[...privateTraces,...(shared.traces||[])];
    state.traceVersions=[...privateVersions,...(shared.traceVersions||[])];
    state.traceEvents=[...privateEvents,...(shared.traceEvents||[])];
    state.participantTraceState=shared.participantTraceState||[];
    state.spaceCandidate=shared.spaceCandidate; state.spaces=shared.spaces||[]; state.traceLinks=shared.traceLinks||[]; state.agentChanges=shared.agentChanges||[];
    state.returnSummary=shared.returnSummary||{count:0,changes:[]};
    saveState(); renderReturnBadge(); return true;
  }catch{ return false; }
}

async function publishTrace(trace){
  if(location.protocol==='file:'||trace.visibility==='private') return null;
  try{
    const r=await fetch('/api/traces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participant_id:participantId(),text:trace.text,visibility:trace.visibility,type:trace.type,tags:trace.tags})});
    if(!r.ok) return null; const data=await r.json(); trace.sharedId=data.trace.id; saveState(); await syncSharedState(); return data.trace;
  }catch{ return null; }
}
async function publishTraceLink(sourceId,link){
  if(location.protocol==='file:'||!sourceId) return false;
  try{ const r=await fetch('/api/trace-links',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source_id:sourceId,target_id:link.target_id,relation:link.relation,explanation:link.explanation})}); return r.ok; }catch{ return false; }
}
async function encounterTrace(traceId){
  if(location.protocol==='file:') return true;
  try{ const r=await fetch(`/api/traces/${encodeURIComponent(traceId)}/encounter`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participant_id:participantId()})}); if(!r.ok) return false; await syncSharedState(); return true; }catch{ return false; }
}
async function continueTrace(traceId,text,parentVersionId){
  if(location.protocol==='file:') return false;
  try{
    const r=await fetch(`/api/traces/${encodeURIComponent(traceId)}/continue`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participant_id:participantId(),text,parent_version_id:parentVersionId})});
    if(!r.ok) return false; await syncSharedState(); return true;
  }catch{ return false; }
}
async function setTraceState(traceId,nextState){
  if(location.protocol==='file:') return false;
  try{ const r=await fetch(`/api/traces/${encodeURIComponent(traceId)}/state`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participant_id:participantId(),state:nextState})}); if(!r.ok) return false; await syncSharedState(); return true; }catch{ return false; }
}
async function acknowledgeReturn(traceId){
  if(location.protocol==='file:') return false;
  try{ const r=await fetch(`/api/traces/${encodeURIComponent(traceId)}/ack`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({participant_id:participantId()})}); if(!r.ok) return false; await syncSharedState(); return true; }catch{ return false; }
}
async function publishAgentChange(summary,reason){
  if(location.protocol==='file:'){ state.agentChanges.push({version:'v0.3.local',title:summary,body:reason,status:'кандидат'}); saveState(); return true; }
  try{ const r=await fetch('/api/agent-changes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({summary,reason})}); if(!r.ok) return false; await syncSharedState(); return true; }catch{ return false; }
}
async function publishSpaceDecision(decision,note){
  if(location.protocol==='file:') return false;
  try{ const r=await fetch('/api/space-decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,note})}); if(!r.ok) return false; await syncSharedState(); return true; }catch{ return false; }
}

const views=[...document.querySelectorAll('.view')];
const navButtons=[...document.querySelectorAll('[data-view]')];
function showView(name){
  views.forEach(v=>v.hidden=v.id!==`view-${name}`);
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  if(name==='return') renderReturn();
  if(name==='traces') renderMyTraces();
  if(name==='archive') renderArchive();
  if(name==='gravity') renderGravity();
  if(name==='changes') renderChanges();
  if(name==='chat') renderChat();
  window.scrollTo({top:0,behavior:'smooth'});
}
navButtons.forEach(btn=>btn.addEventListener('click',()=>showView(btn.dataset.view)));

document.getElementById('enterBtn').addEventListener('click',()=>{ ensureConversation(); showView(state.returnSummary?.count?'return':'chat'); });
document.getElementById('newFoldBtn').addEventListener('click',()=>startNewConversation(true));
document.getElementById('skipBtn').addEventListener('click',()=>handleUserMessage('Я поки не хочу відповідати.'));
document.getElementById('composer').addEventListener('submit',e=>{ e.preventDefault(); if(chatBusy) return; const input=document.getElementById('messageInput'); const text=input.value.trim(); if(!text) return; input.value=''; handleUserMessage(text); });
document.getElementById('exportBtn').addEventListener('click',exportJson);

function ensureConversation(){ if(!state.currentConversation) startNewConversation(false); }
function startNewConversation(render=true){
  const id=`C-${Date.now()}`;
  const convo={id,createdAt:new Date().toISOString(),messages:[
    {role:'agent',text:'Тут уже були люди. Деякі залишили питання. Деякі — дивні слова. Деякі нічого не залишили.'},
    {role:'agent',text:'Я — AI-Агент. Я можу помилятися, а довготривалий Слід з’являється тільки після твого вибору.'},
    {role:'agent',text:'Про тебе я поки нічого не знаю.\n\nЩо мені точно не варто про тебе припускати?'}
  ]};
  state.conversations.push(convo); state.currentConversation=id; state.firstRun=false; saveState(); if(render){renderChat();showView('chat');}
}
function currentConversation(){ return state.conversations.find(c=>c.id===state.currentConversation); }

function renderChat(){
  ensureConversation(); const box=document.getElementById('messages'); box.innerHTML='';
  if(state.returnSummary?.count){
    const notice=document.createElement('div'); notice.className='return-chat-notice'; notice.innerHTML=`<strong>Поки тебе не було</strong><span>${state.returnSummary.count} твоїх Слідів змінилися.</span>`;
    const btn=document.createElement('button'); btn.className='secondary-btn compact'; btn.textContent='Побачити'; btn.addEventListener('click',()=>showView('return')); notice.appendChild(btn); box.appendChild(notice);
  }
  for(const m of currentConversation().messages){
    const wrap=document.createElement('div'); wrap.className=`message-wrap ${m.role}`; const el=document.createElement('div'); el.className=`message ${m.role}`; el.textContent=m.text; wrap.appendChild(el);
    if(m.role==='agent'&&m.meta){
      const hasMeta=m.meta.attention_shift||(m.meta.possible_relations||[]).length||(m.meta.agent_change_candidate&&m.meta.agent_change_candidate.should_offer);
      if(hasMeta){
        const why=document.createElement('button'); why.className='why-btn'; why.type='button'; why.textContent='Чому?'; const details=document.createElement('div'); details.className='message-meta'; details.hidden=true;
        if(m.meta.attention_shift) details.innerHTML+=`<p><strong>Зміна Уваги Агента</strong><br>${escapeHtml(m.meta.attention_shift)}</p>`;
        if((m.meta.possible_relations||[]).length){ details.innerHTML+='<p><strong>Можливе Тяжіння</strong></p>'; for(const rel of m.meta.possible_relations){ const trace=state.traces.find(t=>t.id===rel.trace_id); details.innerHTML+=`<div class="relation-card"><span>${escapeHtml(rel.trace_id)} · ${escapeHtml(rel.relation)}</span><p>${escapeHtml(rel.explanation)}</p>${trace?`<small>«${escapeHtml(trace.text)}»</small>`:''}</div>`; } details.innerHTML+='<p class="meta-note">Це гіпотези Агента, а не запис у Архів.</p>'; }
        const change=m.meta.agent_change_candidate; if(change&&change.should_offer){ const box2=document.createElement('div'); box2.className='change-proposal'; box2.innerHTML=`<strong>Можлива корекція Агента</strong><p>${escapeHtml(change.summary)}</p><small>${escapeHtml(change.reason)}</small>`; const b=document.createElement('button'); b.type='button'; b.className='secondary-btn compact'; b.textContent='Розглянути корекцію'; b.addEventListener('click',()=>openAgentChangeDialog(change)); box2.appendChild(b); details.appendChild(box2); }
        why.addEventListener('click',()=>{details.hidden=!details.hidden;why.textContent=details.hidden?'Чому?':'Сховати';}); wrap.append(why,details);
      }
    }
    box.appendChild(wrap);
  }
  if(chatBusy){ const wait=document.createElement('div'); wait.className='message agent typing'; wait.textContent='…'; box.appendChild(wait); }
  box.scrollTop=box.scrollHeight; renderLivingPreview();
}

async function handleUserMessage(text){
  if(chatBusy) return; ensureConversation(); const convo=currentConversation(); const historyBefore=convo.messages.filter(m=>m.role==='user'||m.role==='agent').map(m=>({role:m.role,text:m.text})); convo.messages.push({role:'user',text}); saveState(); chatBusy=true; renderChat(); toggleComposer(false);
  try{
    let payload;
    if(location.protocol==='file:') payload={mode:'browser-fallback',turn:browserFallback(text)};
    else { const r=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,history:historyBefore,participant_id:participantId()})}); if(!r.ok) throw new Error(`chat_${r.status}`); payload=await r.json(); }
    const turn=payload.turn; convo.messages.push({role:'agent',text:turn.message,meta:{mode:payload.mode,attention_shift:turn.attention_shift,possible_relations:turn.possible_relations||[],agent_change_candidate:turn.agent_change_candidate||null,safety:turn.safety||{level:'none',note:''}}});
    if(payload.warning) convo.messages.push({role:'system',text:payload.warning});
    if(turn.safety?.level==='escalate') convo.messages.push({role:'system',text:'Міфопоетичний режим призупинено для теми безпеки. Тут важливі пряма допомога й надійний дорослий.'});
    saveState(); chatBusy=false; renderChat(); toggleComposer(true);
    if(turn.trace_candidate?.should_offer&&turn.trace_candidate.text){ pendingTrace={...turn.trace_candidate,relations:turn.possible_relations||[]}; setTimeout(openTraceDialog,300); }
  }catch(err){ console.error(err); convo.messages.push({role:'system',text:'Живий Агент зараз недоступний. Ця невдала спроба не стала Слідом.'}); chatBusy=false; saveState(); renderChat(); toggleComposer(true); }
}
function toggleComposer(enabled){ document.getElementById('messageInput').disabled=!enabled; document.querySelector('#composer button[type="submit"]').disabled=!enabled; document.getElementById('skipBtn').disabled=!enabled; }
function browserFallback(text){ const clean=text.trim(); return {message:'Я зараз працюю без підключеної LLM. Але Жива Пам’ять уже може зберігати видиму історію версій.',attention_shift:'У fallback я показую механіку пам’яті, але не вдаю живе розуміння.',trace_candidate:{should_offer:clean.length>15,type:clean.includes('?')?'question':'trace',text:clean.slice(0,300),reason:'Ця фраза може пережити одну розмову й отримати наступну версію.'},possible_relations:[],agent_change_candidate:{should_offer:false,summary:'',reason:''},safety:{level:'none',note:''}}; }

function openTraceDialog(){
  if(!pendingTrace) return; document.getElementById('traceDraft').value=pendingTrace.text; document.getElementById('traceReason').textContent=pendingTrace.reason||''; const relBox=document.getElementById('traceRelations'); relBox.innerHTML=''; const relations=pendingTrace.relations||[];
  if(relations.length){ relBox.innerHTML='<p class="field-label">Агент бачить можливе Тяжіння. Які зв’язки ти теж бачиш?</p>'; for(const rel of relations){ const target=state.traces.find(t=>t.id===rel.trace_id); const label=document.createElement('label'); label.className='relation-choice'; label.innerHTML=`<input type="checkbox" data-trace-link="${escapeHtml(rel.trace_id)}" data-relation="${escapeHtml(rel.relation)}" data-explanation="${escapeHtml(rel.explanation)}"> <span><strong>${escapeHtml(rel.trace_id)}</strong> · ${escapeHtml(rel.explanation)}${target?`<small>«${escapeHtml(target.text)}»</small>`:''}</span>`; relBox.appendChild(label); } relBox.innerHTML+='<p class="micro">Підтверджений зв’язок стане спільним лише разом зі спільним Слідом.</p>'; }
  document.getElementById('traceDialog').showModal();
}
document.getElementById('saveTraceBtn').addEventListener('click',e=>{
  e.preventDefault(); const text=document.getElementById('traceDraft').value.trim(); if(!text) return; const visibility=document.querySelector('input[name="visibility"]:checked').value; const type=pendingTrace?.type==='question'?'question':'trace'; const localId=`LOCAL-${Date.now()}`; const createdAt=new Date().toISOString(); const localVersionId=`${localId}-V1`; const trace={id:localId,type,text,visibility,owner:'local',originParticipantId:participantId(),currentVersionId:localVersionId,versionCount:1,encounters:1,tags:inferTags(text),state:'alive',live:true,createdAt,updatedAt:createdAt}; state.traces.push(trace); state.traceVersions.push({id:localVersionId,traceId:localId,parentVersionId:null,number:1,text,participantId:participantId(),originType:'created',createdAt}); state.traceEvents.push({id:`LOCAL-E-${Date.now()}`,traceId:localId,eventType:'confirmed',participantId:participantId(),versionId:localVersionId,detail:'Локальний приватний Слід підтверджено',createdAt}); currentConversation().messages.push({role:'system',text:`Слід підтверджено: «${text}»`}); const selectedLinks=[...document.querySelectorAll('[data-trace-link]:checked')].map(el=>({target_id:el.dataset.traceLink,relation:el.dataset.relation,explanation:el.dataset.explanation})); pendingTrace=null; saveState(); document.getElementById('traceDialog').close(); renderChat();
  publishTrace(trace).then(async published=>{ if(published&&selectedLinks.length){ for(const link of selectedLinks) await publishTraceLink(published.id,link); await syncSharedState(); } renderLivingPreview(); renderMyTraces(); });
});
document.getElementById('releaseTraceBtn').addEventListener('click',e=>{ e.preventDefault(); currentConversation().messages.push({role:'system',text:'Кандидат у Слід відпущено. Він не входить у довготривалу пам’ять.'}); pendingTrace=null; saveState(); document.getElementById('traceDialog').close(); renderChat(); });

function inferTags(text){ const map={'двер':['двері','простір'],'кімнат':['двері','простір'],'простір':['простір'],'думк':['думка','авторство'],'автор':['авторство'],'ai':['AI'],'ші':['AI'],'помил':['помилка'],'змін':['зміна'],'уваг':['увага'],'питан':['питання'],'правил':['правило'],'пам':['пам’ять']}; const t=text.toLowerCase(),tags=[]; for(const [needle,vals] of Object.entries(map)) if(t.includes(needle)) for(const v of vals) if(!tags.includes(v)) tags.push(v); return tags.length?tags:['невизначене']; }
function visibilityLabel(v){ return v==='private'?'тільки тут':v==='anonymous'?'анонімно іншим':'спільний Архів'; }
function stateLabel(v){ return v==='sleeping'?'спить':v==='released'?'відпущено':'живе'; }

function renderLivingPreview(){
  const el=document.getElementById('livingPreview'); const living=state.traces.filter(t=>(t.visibility==='world'||t.visibility==='anonymous')&&t.state!=='released').slice(-3).reverse(); el.innerHTML=''; if(!living.length){el.innerHTML='<p class="micro">Поки тут тихо. Перший підтверджений спільний Слід змінить цей блок.</p>';return;}
  living.forEach(t=>{ const c=document.createElement('div'); c.className='mini-card'; c.innerHTML=`<p>${escapeHtml(t.text)}</p><p class="mini-meta">${Number(t.versionCount||1)} версій · ${Number(t.encounters||1)} зустрічей</p>`; el.appendChild(c); });
}
function renderMyTraces(){
  const list=state.traces.filter(myTrace); const el=document.getElementById('myTraces'); el.innerHTML=''; document.getElementById('emptyMyTraces').hidden=!!list.length;
  list.forEach(t=>{ const c=document.createElement('article'); c.className='trace-card'; const vs=versionsFor(t.id); c.innerHTML=`<p class="trace-text">${escapeHtml(t.text)}</p><div class="trace-pills"><span class="visibility">${visibilityLabel(t.visibility)}</span><span class="status-pill">${stateLabel(t.state)}</span></div><p class="meta">${escapeHtml(t.id)} · ${Number(t.versionCount||vs.length||1)} версій · ${Number(t.encounters||1)} зустрічей</p>${vs.length>1?versionHistoryHtml(vs):''}`; if(t.owner!=='local'){ const actions=document.createElement('div'); actions.className='card-actions'; if(t.state!=='released'){ const cont=button('Продовжити','secondary-btn compact',()=>openContinueTrace(t.id)); actions.appendChild(cont); } if(t.originParticipantId===participantId()&&t.state==='alive') actions.appendChild(button('Приспати','text-btn compact',async()=>{await setTraceState(t.id,'sleeping');renderMyTraces();})); if(t.originParticipantId===participantId()&&t.state!=='released') actions.appendChild(button('Відпустити','text-btn compact danger',async()=>{await setTraceState(t.id,'released');renderMyTraces();})); c.appendChild(actions); } el.appendChild(c); });
}
function renderArchive(){
  const visible=state.traces.filter(t=>(t.visibility==='world'||t.visibility==='anonymous')&&t.state!=='released'); const qs=visible.filter(t=>t.type==='question'), shared=visible.filter(t=>t.type!=='question'); document.getElementById('archiveCount').textContent=`${visible.length} живих`; const qEl=document.getElementById('questionArchive'),sEl=document.getElementById('sharedArchive'); qEl.innerHTML='';sEl.innerHTML='';qs.forEach(t=>qEl.appendChild(archiveCard(t)));shared.forEach(t=>sEl.appendChild(archiveCard(t)));
}
function archiveCard(t){
  const c=document.createElement('article'); c.className='archive-card'; const vs=versionsFor(t.id); c.innerHTML=`<p>${escapeHtml(t.text)}</p><p class="meta">${Number(t.versionCount||vs.length||1)} версій · пережило ${Number(t.encounters||1)} зустрічей · ${stateLabel(t.state)}</p>${vs.length>1?versionHistoryHtml(vs):''}`; const actions=document.createElement('div'); actions.className='card-actions'; if(t.state!=='released'){ actions.appendChild(button('Зустріти й продовжити','secondary-btn compact',async()=>{await encounterTrace(t.id);openContinueTrace(t.id);})); } c.appendChild(actions); return c;
}
function versionHistoryHtml(vs){ return `<details class="version-details"><summary>Дорога Сліду · ${vs.length} версій</summary><ol>${vs.map(v=>`<li><span>v${v.number}</span><p>${escapeHtml(v.text)}</p><small>${v.participantId===participantId()?'твій дотик':'інший дотик'} · ${new Date(v.createdAt).toLocaleString('uk-UA')}</small></li>`).join('')}</ol></details>`; }
function button(text,cls,fn){ const b=document.createElement('button'); b.type='button'; b.className=cls; b.textContent=text; b.addEventListener('click',fn); return b; }

function renderReturnBadge(){ const b=document.getElementById('returnBadge'); const n=Number(state.returnSummary?.count||0); if(!b) return; b.hidden=!n; b.textContent=n; }
function renderReturn(){
  const summary=state.returnSummary||{count:0,changes:[]}; document.getElementById('returnCount').textContent=`${summary.count} змін`; const box=document.getElementById('returnChanges'); const empty=document.getElementById('emptyReturn'); box.innerHTML=''; empty.hidden=!!summary.count;
  for(const ch of summary.changes||[]){ const c=document.createElement('article'); c.className='return-card'; c.innerHTML=`<p class="eyebrow">${escapeHtml(ch.traceId)} · ТЕ, ЩО ТИ ЗАЛИШИВ, ЖИЛО БЕЗ ТЕБЕ</p><div class="return-before"><small>Було</small><p>«${escapeHtml(ch.originalText)}»</p></div><div class="return-after"><small>Тепер існує ще одна версія</small><p>«${escapeHtml(ch.currentText)}»</p></div><p class="meta">${ch.newVersionCount} нових дотиків · ${ch.versionCount} версій загалом</p><h4>Що з цього для тебе ще живе?</h4>`; const actions=document.createElement('div'); actions.className='card-actions'; actions.appendChild(button('Живе','secondary-btn compact',async()=>{await acknowledgeReturn(ch.traceId);renderReturn();renderReturnBadge();})); actions.appendChild(button('Змінилося — продовжити','primary-btn compact',()=>openContinueTrace(ch.traceId))); actions.appendChild(button('Відпускаємо','text-btn compact danger',async()=>{await setTraceState(ch.traceId,'released');renderReturn();renderReturnBadge();})); c.appendChild(actions); box.appendChild(c); }
}

async function openContinueTrace(traceId){
  const t=state.traces.find(x=>x.id===traceId); if(!t) return; pendingContinuation={traceId,parentVersionId:t.currentVersionId}; const vs=versionsFor(traceId); document.getElementById('continueTraceHistory').innerHTML=vs.length?versionHistoryHtml(vs):`<p>«${escapeHtml(t.text)}»</p>`; document.getElementById('continueTraceDraft').value=t.text; document.getElementById('continueTraceDialog').showModal();
}
document.getElementById('saveContinuedTraceBtn').addEventListener('click',async e=>{ e.preventDefault(); if(!pendingContinuation) return; const text=document.getElementById('continueTraceDraft').value.trim(); if(!text) return; const ok=await continueTrace(pendingContinuation.traceId,text,pendingContinuation.parentVersionId); if(ok){ document.getElementById('continueTraceDialog').close(); pendingContinuation=null; renderArchive(); renderMyTraces(); renderReturn(); renderReturnBadge(); } });

function openAgentChangeDialog(change){ pendingAgentChange={...change}; document.getElementById('agentChangeDraft').value=change.summary||''; document.getElementById('agentChangeReason').textContent=change.reason||''; document.getElementById('agentChangeDialog').showModal(); }
document.getElementById('saveAgentChangeBtn').addEventListener('click',async e=>{ e.preventDefault(); const summary=document.getElementById('agentChangeDraft').value.trim(); if(!summary) return; const ok=await publishAgentChange(summary,pendingAgentChange?.reason||''); if(ok){ currentConversation().messages.push({role:'system',text:`Корекцію Агента внесено як кандидат: «${summary}»`}); saveState(); renderChat(); } pendingAgentChange=null; document.getElementById('agentChangeDialog').close(); });
document.getElementById('releaseAgentChangeBtn').addEventListener('click',e=>{e.preventDefault();pendingAgentChange=null;document.getElementById('agentChangeDialog').close();});

function renderGravity(){
  const area=document.getElementById('gravityArea'); area.innerHTML=''; const candidate=state.spaceCandidate; if(!candidate){area.innerHTML='<div class="empty-state">Кандидат у Простір ще не проявився.</div>';return;} if(candidate.status==='born'){ const space=state.spaces.find(s=>s.origin===candidate.id)||state.spaces[0]; if(!space){area.innerHTML='<div class="empty-state">Простір проявився, але його стан ще синхронізується.</div>';return;} area.innerHTML=`<div class="space-born"><p class="eyebrow">ПРОСТІР ПРОЯВИВСЯ</p><h3>${escapeHtml(space.name)}</h3><p>${escapeHtml(space.worry)}</p><ul><li>походить із ${space.traceIds.length} Слідів</li><li>історія народження збережена</li><li>назва може змінитися</li></ul><h4>Що тут зараз незавершене?</h4><ul>${(space.unfinished||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`; return; } if(candidate.status==='rejected'){area.innerHTML='<div class="empty-state">Цю форму спільнота відкинула. Сліди лишилися окремими.</div>';return;}
  const traceNodes=(candidate.traceIds||[]).map(id=>state.traces.find(t=>t.id===id)).filter(Boolean); const wrapper=document.createElement('div'); wrapper.className='gravity-canvas'; const cluster=document.createElement('div'); cluster.className='trace-cluster'; cluster.innerHTML='<p class="eyebrow">СЛІДИ, ЩО ТЯЖІЮТЬ</p>'; traceNodes.forEach(t=>{const n=document.createElement('div');n.className='trace-node';n.innerHTML=`<strong>${escapeHtml(t.id)}</strong><div>${escapeHtml(t.text)}</div><div class="meta">${Number(t.versionCount||1)} версій · ${Number(t.encounters||1)} зустрічей</div>`;cluster.appendChild(n);}); const card=document.createElement('div'); card.className='candidate-card'; card.innerHTML=`<p class="eyebrow">${escapeHtml(candidate.id)}</p><h3>Щось тут збирається</h3><p>${escapeHtml(candidate.hypothesis)}</p><div class="notice"><strong>Чому це запропоновано:</strong><br>${(candidate.evidence||[]).map(escapeHtml).join('<br>')}</div><p class="gravity-links">Кандидат — ще не рішення.</p><div class="candidate-actions"><button class="primary-btn" id="reviewCandidate">Подивитися разом</button><button class="secondary-btn" id="leaveUnformed">Залишити без форми</button></div>`; wrapper.append(cluster,card); area.appendChild(wrapper); document.getElementById('reviewCandidate').addEventListener('click',openSpaceDialog); document.getElementById('leaveUnformed').addEventListener('click',()=>recordSpaceDecision('hold'));
}
function openSpaceDialog(){ const c=state.spaceCandidate;if(!c)return;document.getElementById('spaceEvidence').textContent=c.hypothesis;document.getElementById('spaceInterpretation').value='';document.getElementById('spaceDialog').showModal(); }
async function recordSpaceDecision(decision){ const note=document.getElementById('spaceInterpretation')?.value.trim()||''; await publishSpaceDecision(decision,note); document.getElementById('spaceDialog').close(); renderGravity(); }
document.getElementById('confirmSpaceBtn').addEventListener('click',e=>{e.preventDefault();recordSpaceDecision('confirm');});
document.getElementById('differentSpaceBtn').addEventListener('click',e=>{e.preventDefault();recordSpaceDecision('different');});
document.getElementById('holdSpaceBtn').addEventListener('click',e=>{e.preventDefault();recordSpaceDecision('hold');});
document.getElementById('rejectSpaceBtn').addEventListener('click',e=>{e.preventDefault();recordSpaceDecision('reject');});

function renderChanges(){ const el=document.getElementById('changeLog');el.innerHTML='';for(const ch of state.agentChanges){const c=document.createElement('article');c.className='change-card';c.innerHTML=`<div class="change-version">${escapeHtml(ch.version||'')}</div><div class="change-body"><strong>${escapeHtml(ch.title||'')}</strong><p>${escapeHtml(ch.body||'')}</p><span class="status-pill">${escapeHtml(ch.status||'')}</span></div>`;el.appendChild(c);}if(!state.agentChanges.length)el.innerHTML='<div class="empty-state">Стійких змін Агента поки немає.</div>'; }
function exportJson(){ const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}); const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='mythopoetic-agent-v03-local-state.json';a.click();URL.revokeObjectURL(a.href); }

(async function init(){ await Promise.all([loadConfig(),syncSharedState()]); renderRuntimeStatus(); renderReturnBadge(); renderLivingPreview(); showView(state.firstRun?'threshold':(state.returnSummary?.count?'return':'chat')); })();
