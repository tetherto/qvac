// Self-contained API explorer. The route table supplies its OpenAPI document;
// neither rendering nor trying a request loads third-party scripts or styles.
export const apiDocsHtml = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>QVAC API</title><style>
:root{color-scheme:dark;--bg:#111211;--panel:#191b19;--field:#121412;--line:#343a32;--muted:#a6aea2;--text:#edf0e9;--accent:#d4ee9f;--mono:ui-monospace,SFMono-Regular,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,sans-serif}button,input,select,textarea{font:inherit}a{color:var(--accent);text-underline-offset:4px}button,a,input,textarea,select,summary{outline-offset:4px}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent)}
.shell{max-width:1240px;margin:auto;padding:36px 36px 60px}.masthead{display:flex;align-items:center;justify-content:space-between;padding-bottom:25px;border-bottom:1px solid var(--line);gap:20px}.brand{display:flex;align-items:center;gap:16px}.mark{width:37px;height:37px;border:1px solid var(--accent);border-radius:11px;display:grid;place-items:center;color:var(--accent);font:700 21px var(--mono)}h1{font-size:22px;letter-spacing:-1px;margin:0}.eyebrow{font:11px var(--mono);letter-spacing:1.8px;text-transform:uppercase;color:var(--muted)}.download{font-size:12px;text-decoration:none;border:1px solid var(--line);border-radius:7px;padding:8px 12px;white-space:nowrap}.download:hover{border-color:var(--accent)}
.intro{padding:28px 0 24px}.intro h2{font-size:27px;letter-spacing:-.8px;margin:0 0 5px;font-weight:550}.intro p{margin:0;color:var(--muted)}main{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:20px;align-items:start}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}.panel-head{padding:17px 22px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.panel-head h2{font-size:14px;font-weight:600;margin:0}.step{color:var(--muted);font:11px var(--mono)}.panel-body{padding:20px 22px}.response-panel{position:sticky;top:20px}
label{display:block;margin:16px 0 7px;font-size:12px;font-weight:550;color:#d0d6ca}.first-label{margin-top:0}input,select,textarea{display:block;width:100%;margin-top:7px;padding:10px 12px;border:1px solid #41483d;border-radius:7px;background:var(--field);color:var(--text)}select{font:12px var(--mono);height:43px}textarea{font:12px/1.7 var(--mono);resize:vertical;min-height:140px}input[type=file]{font-size:12px;padding:8px}input::file-selector-button{background:#2c3328;color:var(--text);border:0;padding:5px 8px;border-radius:4px;margin-right:9px}small{display:block;font-size:11px;color:var(--muted);margin-top:6px}.summary{margin:10px 0 18px;color:var(--muted);font-size:12px}.auth{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:0 0 17px;margin-bottom:12px}.actions{display:flex;gap:9px;margin-top:22px}button{padding:10px 15px;border:1px solid var(--line);border-radius:7px;cursor:pointer;background:transparent;color:var(--text);font-size:12px;font-weight:600}.primary{background:var(--accent);color:#192010;border-color:var(--accent);flex:1}.primary:hover{background:#e1f6b7}button:disabled{opacity:.35;cursor:default}details{border-top:1px solid var(--line)}summary{cursor:pointer;padding:16px 22px;color:var(--muted);font-size:12px}pre{font:12px/1.75 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;tab-size:2}#response{min-height:240px;max-height:65vh;overflow:auto;padding:22px;background:#141614}#response:empty::before{content:'Your response will appear here.\A\ASend a request to inspect its status and body.';color:#838d7d}#schema{max-height:330px;overflow:auto;padding:0 22px 22px;color:#b9c6ac}.status{font:11px var(--mono);color:var(--accent);max-width:65%;text-align:right;margin:0}.status:empty::before{content:'READY';color:var(--muted)}.status.error{color:#ffaaa0}.footnote{font-size:11px;color:var(--muted);margin:14px 3px 0}
@media(max-width:800px){.shell{padding:22px 18px 40px}main{grid-template-columns:1fr}.response-panel{position:static}.masthead{align-items:flex-start}.intro h2{font-size:23px}.download{font-size:11px}.panel-body{padding:17px}.panel-head{padding:15px 17px}#response{max-height:400px}}@media(prefers-reduced-motion:no-preference){button,input,select,textarea,a{transition:border-color .15s,background .15s}}
</style></head><body><div class="shell"><header class="masthead"><div class="brand"><span class="mark" aria-hidden="true">Q</span><div><h1>QV.AC</h1><span class="eyebrow">API explorer</span></div></div><a class="download" href="/openapi.json">OpenAPI JSON ↗</a></header>
<div class="intro"><h2>Explore your local API.</h2><p id="description"></p></div>
<main><section class="panel"><div class="panel-head"><h2>Request</h2><span class="step">01 / COMPOSE</span></div><div class="panel-body">
<label class="first-label" for="endpoint">Endpoint</label><select id="endpoint"></select><p class="summary" id="summary"></p>
<div class="auth"><label for="token">Bearer API key</label><input id="token" type="password" autocomplete="off" placeholder="Enter a key if your server requires one"><small>Kept in this page only. Never saved to browser storage.</small></div>
<form id="request"><div id="parameters"></div><div id="body"></div><div class="actions"><button class="primary" type="submit">Send request →</button><button id="stop" type="button" disabled>Stop</button></div></form>
</div></section><aside><section class="panel response-panel"><div class="panel-head"><h2>Response</h2><p class="status" id="status" role="status"></p></div><pre id="response" aria-live="off"></pre>
<details><summary>View endpoint schema</summary><pre id="schema"></pre></details></section><p class="footnote">Requests stay on this API server. Streaming responses appear as they arrive.</p></aside></main></div>
<script type="module">
const $=id=>document.getElementById(id);
let active;
try {
 const response=await fetch('/openapi.json');
 if(!response.ok)throw new Error('Could not load OpenAPI document: '+response.status);
 const spec=await response.json();
 $('description').textContent=spec.info.description||'';
 const routes=[];
 for(const [path,item] of Object.entries(spec.paths||{}))for(const method of ['get','post','put','patch','delete','head','options'])if(item[method]){
  const operation=item[method];routes.push({path,method,operation,parameters:[...(item.parameters||[]),...(operation.parameters||[])]});
  const option=document.createElement('option');option.value=String(routes.length-1);option.textContent=method.toUpperCase()+' '+path;$('endpoint').append(option);
 }
 const resolve=schema=>schema&&schema.$ref&&schema.$ref.startsWith('#/')?schema.$ref.slice(2).split('/').reduce((value,key)=>value?.[key.replace(/~1/g,'/').replace(/~0/g,'~')],spec):schema;
 const addInput=(container,label,type='text')=>{const wrapper=document.createElement('label');wrapper.textContent=label;const input=document.createElement('input');input.type=type;wrapper.append(input);container.append(wrapper);return input;};
 function choose(){
  const route=routes[Number($('endpoint').value)];if(!route)return;
  $('summary').textContent=route.operation.summary||route.operation.description||'';
  $('schema').textContent=JSON.stringify(route.operation,null,2);$('parameters').replaceChildren();$('body').replaceChildren();
  for(const raw of route.parameters){const param=resolve(raw);if(!['path','query','header'].includes(param.in))continue;const input=addInput($('parameters'),param.name+' ('+param.in+')');input.dataset.name=param.name;input.dataset.location=param.in;input.required=!!param.required;}
  const content=route.operation.requestBody&&resolve(route.operation.requestBody).content||{};
  const media=Object.keys(content);let selected=media[0];
  const editor=document.createElement('div');
  function renderBody(){
   editor.replaceChildren();
   if(selected==='multipart/form-data'){
    const schema=resolve(content[selected].schema)||{};
    for(const [name,raw] of Object.entries(schema.properties||{})){
     const property=resolve(raw)||{};
     const binary=property.format==='binary'||(property.anyOf||property.oneOf||[]).some(item=>resolve(item)?.format==='binary');
     const input=addInput(editor,name,binary?'file':'text');input.dataset.field=name;input.required=(schema.required||[]).includes(name);
     if(binary&&name.endsWith('[]'))input.multiple=true;
    }
   }else if(selected){
    const label=document.createElement('label');label.textContent='Request body (JSON)';const input=document.createElement('textarea');input.id='json';input.rows=12;input.value='{}';label.append(input);editor.append(label);
   }
  }
  if(media.length>1){const label=document.createElement('label');label.textContent='Content type';const select=document.createElement('select');select.id='content-type';for(const type of media){const option=document.createElement('option');option.value=type;option.textContent=type;select.append(option);}select.addEventListener('change',()=>{selected=select.value;renderBody();});label.append(select);$('body').append(label);}
  $('body').append(editor);renderBody();
 }
 $('endpoint').addEventListener('change',choose);choose();
 $('stop').addEventListener('click',()=>active?.abort());
 $('request').addEventListener('submit',async event=>{
  event.preventDefault();active?.abort();const controller=new AbortController();active=controller;$('stop').disabled=false;
  $('response').textContent='';$('status').textContent='Sending…';$('status').className='status';
  try{
   const route=routes[Number($('endpoint').value)];let path=route.path;const query=new URLSearchParams();const headers={};
   if($('token').value)headers.Authorization='Bearer '+$('token').value;
   for(const input of $('parameters').querySelectorAll('input')){const name=input.dataset.name,value=input.value;if(!value)continue;if(input.dataset.location==='path')path=path.replace('{'+name+'}',encodeURIComponent(value));else if(input.dataset.location==='query')query.append(name,value);else headers[name]=value;}
   const url=new URL(path,location.origin);if(url.origin!==location.origin)throw new Error('Only this API server can receive requests.');url.search=query.toString();
   let body;const fields=$('body').querySelectorAll('input[data-field]');
   if(fields.length){body=new FormData();for(const input of fields){if(input.type==='file'){for(const file of input.files)body.append(input.dataset.field,file);}else if(input.value)body.append(input.dataset.field,input.value);}}
   else if($('json')){body=JSON.stringify(JSON.parse($('json').value));headers['Content-Type']='application/json';}
   const response=await fetch(url,{method:route.method.toUpperCase(),headers,body,signal:controller.signal});
   $('status').textContent=response.status+' '+response.statusText;
   if(response.body){const reader=response.body.getReader(),decoder=new TextDecoder();let shown=0;for(;;){const {done,value}=await reader.read();if(done)break;const text=decoder.decode(value,{stream:true});shown+=text.length;if(shown>1024*1024){await reader.cancel();$('response').textContent+='\n[Preview stopped at 1 MiB]';break;}$('response').textContent+=text;}$('response').textContent+=decoder.decode();if((response.headers.get('content-type')||'').includes('application/json')){try{$('response').textContent=JSON.stringify(JSON.parse($('response').textContent),null,2);}catch{}}}
  }catch(error){$('status').textContent=controller.signal.aborted?'Request stopped.':String(error);$('status').className='status error';}
  finally{if(active===controller){active=undefined;$('stop').disabled=true;}}
 });
}catch(error){$('status').textContent=String(error);$('status').className='status error';}
</script></body></html>`
