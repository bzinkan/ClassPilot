// Optional cross-repository integration. Secrets arrive on stdin and stay in
// this broker's memory. Only one-time pairing proofs reach disposable browsers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';
let stage='input',evidenceDirectory=null;
process.on('uncaughtException',error=>{
  const report={schemaVersion:1,stage,code:/^WINDOWS_E2E_[A-Z0-9_]+$/.test(error.message||'')?error.message:'WINDOWS_E2E_FAILURE',
    status:Number.isInteger(error.status)&&error.status>=100&&error.status<=599?error.status:undefined,
    apiCode:/^[A-Z0-9_]{1,100}$/.test(error.code||'')?error.code:undefined,errorName:error.name==='AssertionError'?'AssertionError':'Error'};
  if(evidenceDirectory)writeFileSync(join(evidenceDirectory,'real-schoolpilot-browser-failure.json'),JSON.stringify(report,null,2)+'\n');
  process.stderr.write(JSON.stringify(report)+'\n');process.exitCode=1;
});
let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>16_384)throw new Error('WINDOWS_E2E_INPUT_TOO_LARGE');}
const fixture=JSON.parse(raw);raw='';
const origin=new URL(fixture.origin);assert.ok(['127.0.0.1','localhost','[::1]'].includes(origin.hostname));assert.equal(origin.protocol,'http:');
assert.ok(typeof fixture.guardCredential==='string'&&fixture.guardCredential.startsWith('cpw1.guard.'));
assert.match(fixture.osSessionNonce,/^[0-9a-f-]{36}$/i);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),scratch=mkdtempSync(join(tmpdir(),'classpilot-real-schoolpilot-'));
const evidence=resolve(fixture.artifactRoot);evidenceDirectory=evidence;stage='package';mkdirSync(evidence,{recursive:true});
let artifact=process.env.WINDOWS_EXTENSION_ARTIFACT;
if(!artifact){artifact=JSON.parse(execFileSync(process.execPath,[join(root,'scripts/package-windows-extension.mjs'),'--development'],{cwd:root,encoding:'utf8'}).trim()).output;}
assert.equal(JSON.parse(readFileSync(join(artifact,'package-manifest.json'),'utf8')).development,true);
const artifacts=join(evidence,`browser-artifacts-${randomUUID()}`);cpSync(artifact,artifacts,{recursive:true});
const contexts=[],sources={},epoch=randomUUID(),brokerNonce=randomUUID();
let guardEnd=0,renewing=false,renewTimer;
async function request(path,{body,method='POST',token=fixture.teacherCredential,staff=true,canonical=false}={}){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
  try {
  const response=await fetch(`${origin.origin}/api/classpilot${canonical?'':'/windows'}${path}`,{method,signal:controller.signal,redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(staff?{'X-School-Id':fixture.schoolId}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error('WINDOWS_E2E_API_REFUSED'),{status:response.status,code:typeof value.code==='string'?value.code:'unavailable'});
  return value;
  } finally { clearTimeout(timeout); }
}
async function renew(){
  if(renewing)return;renewing=true;const started=performance.now();
  try{const value=await request('/guards/renew',{token:fixture.guardCredential,staff:false,body:{osSessionNonce:fixture.osSessionNonce}});
    guardEnd=performance.now()+Math.max(0,Math.min(45_000,Date.parse(value.expiresAt)-Date.parse(value.serverTime))-(performance.now()-started)-2000);
  }catch{guardEnd=0;}finally{renewing=false;}
}
const server=createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','content-type');res.end();return;}
  if(req.url.startsWith('/page/')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic managed browser</title><p>Local Windows browser integration fixture</p>');return;}
  if(req.url!==`/${brokerNonce}/native`){res.writeHead(404);res.end('{}');return;}
  try{
    let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048)throw new Error();}const input=JSON.parse(body);
    assert.ok(['chrome','edge'].includes(input.browserFamily));
    if(input.type==='status')res.end(JSON.stringify({protocolVersion:1,authorized:performance.now()<guardEnd,reason:'synthetic_native_broker',guardEpoch:epoch,expiresInSeconds:Math.max(0,(guardEnd-performance.now())/1000),browserFamily:input.browserFamily}));
    else if(input.type==='pair'){
      const proof=await request('/guards/pairing-proofs',{token:fixture.guardCredential,staff:false,body:{browserFamily:input.browserFamily,profileId:input.profileId,challenge:input.challenge}});
      res.end(JSON.stringify({...proof,type:'pair',browserFamily:input.browserFamily}));
    }else{res.writeHead(400);res.end('{}');}
  }catch{res.writeHead(403);res.end('{"reason":"fixture_refused"}');}
});
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
async function until(predicate,code,timeout=15_000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await predicate())return;await sleep(500);}throw new Error(code);}
const authority={teachingSessionId:fixture.teachingSessionId};
async function command(commandType,commandPayload,browser){return request('/commands',{body:{...authority,targetScope:'students',targetStudentIds:[fixture.studentId],commandType,commandPayload,
  ...(browser?{browserTargets:[{studentId:fixture.studentId,sourceRef:browser.sourceRef,bindingRevision:browser.bindingRevision}]}:{})}});}
async function tiles(selectedSources=[]){return request('/tiles',{body:{...authority,studentIds:[fixture.studentId],selectedSources}});}
const checks=[];
const sourceTarget=source=>({studentId:fixture.studentId,sourceRef:source.sourceRef,bindingRevision:source.bindingRevision});
// The real bridge also polls every five seconds, in addition to the ordinary
// worker heartbeat. Bound our extra traffic below the real 30/minute limit.
// Each source has one queue; independent Chrome/Edge waits may run together.
const heartbeatQueues=new WeakMap(),heartbeatTimes=new WeakMap();
function heartbeat(source){
  const pending=(heartbeatQueues.get(source)||Promise.resolve()).then(async()=>{
    const remaining=6000-(performance.now()-(heartbeatTimes.get(source)??-Infinity));
    if(remaining>0)await sleep(remaining);
    heartbeatTimes.set(source,performance.now());
    await source.worker.evaluate(()=>safeSendHeartbeat('schoolpilot-e2e'));
  });
  heartbeatQueues.set(source,pending.catch(()=>{}));return pending;
}
async function heartbeatAll(){await Promise.all(Object.values(sources).map(heartbeat));}
async function acknowledgedCommand(type,payload,browser){
  const result=await command(type,payload,browser),expected=browser?[browser]:Object.values(sources);
  assert.equal(result.targets.length,expected.length);
  for(const source of expected)assert.ok(result.targets.some(target=>target.sourceRef===source.sourceRef&&target.bindingRevision===source.bindingRevision));
  await until(async()=>{
    await Promise.all(expected.map(async source=>{await heartbeat(source);await source.worker.evaluate(()=>flushCommandAckOutbox({forceHttp:true}));}));
    const outcome=await request(`/commands/${result.command.id}?teachingSessionId=${encodeURIComponent(fixture.teachingSessionId)}`,{method:'GET'});
    assert.equal(outcome.targets.length,expected.length);
    return outcome.targets.every(target=>target.status==='completed'&&expected.some(source=>target.sourceRef===source.sourceRef&&target.bindingRevision===source.bindingRevision));
  },'WINDOWS_E2E_COMMAND_NOT_ACKNOWLEDGED');
  return result;
}
async function action(source,type,extra={}){
  const binding=await source.worker.evaluate(()=>({studentMessageContext:studentMessageContextFor(captureAuthenticatedContext('Windows real-server action')),
    fabBinding:fabIdentityBinding(),sessionId:currentFabState.teachingSessionId,teachingSessionId:currentFabState.teachingSessionId}));
  const result=await source.popup.evaluate(message=>chrome.runtime.sendMessage(message),{type,...binding,...extra});
  assert.equal(result?.success,true,'WINDOWS_E2E_STUDENT_ACTION_REFUSED');return result;
}
const toolState=()=>request(`/class-tools/state?teachingSessionId=${encodeURIComponent(fixture.teachingSessionId)}`,{method:'GET',canonical:true});
const observationViewer=randomUUID();let observing=false;
const observationPath=`/teaching-sessions/${encodeURIComponent(fixture.teachingSessionId)}/observation-lease`;
let summary;
try{
  stage='guard-renewal';await renew();assert.ok(guardEnd>performance.now());renewTimer=setInterval(()=>void renew(),15_000);
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const pageOrigin=`http://127.0.0.1:${server.address().port}`,broker=`${pageOrigin}/${brokerNonce}/native`;
  for(const browserFamily of ['chrome','edge']){
    stage=browserFamily+'-startup';
    const executablePath=browserFamily==='chrome'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';assert.ok(existsSync(executablePath));
    const extension=join(scratch,browserFamily);cpSync(join(artifact,browserFamily),extension,{recursive:true});
    writeFileSync(join(extension,'config.js'),`globalThis.CLASSPILOT_SERVER_URL=${JSON.stringify(origin.origin)};
      globalThis.__windowsFixtureLegacyCredentialLeak=false;globalThis.__windowsFixtureImages=[];const networkFetch=globalThis.fetch.bind(globalThis);
      globalThis.fetch=async(url,init={})=>{const endpoint=new URL(typeof url==='string'?url:url.url);const headers=new Headers(init.headers||{});
        if(headers.get('Authorization')?.startsWith('Bearer cpw1.browser.')&&!endpoint.pathname.startsWith('/api/classpilot/windows/browser/')){globalThis.__windowsFixtureLegacyCredentialLeak=true;throw new Error('WINDOWS_FIXTURE_CREDENTIAL_ROUTE');}
        const response=await networkFetch(url,init);
        if(endpoint.pathname==='/api/classpilot/windows/browser/screenshot'){
          const input=JSON.parse(init.body||'{}');globalThis.__windowsFixtureImages.push({status:response.status,sourceRef:input.sourceRef,bindingRevision:input.bindingRevision,sequence:input.sequence,
            bytes:typeof input.screenshot==='string'?Math.floor(input.screenshot.slice(input.screenshot.indexOf(',')+1).replace(/=+$/,'').length*3/4):0});
          if(globalThis.__windowsFixtureImages.length>30)globalThis.__windowsFixtureImages.shift();}
        return response;};
      chrome.runtime.connectNative=function(name){if(name!=='net.classpilot.guard')throw new Error('host');const messages=[],disconnects=[];let closed=false;
        const emit=value=>{if(!closed)messages.forEach(fn=>fn(value));};
        const call=async value=>{try{const response=await fetch(${JSON.stringify(broker)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...value,browserFamily:${JSON.stringify(browserFamily)}})});const data=await response.json();emit({...data,id:value.id,type:value.type==='pair'?'pair':'status'});}catch{emit({type:'status',authorized:false});}};
        const timer=setInterval(()=>void call({type:'status'}),250);
        return {onMessage:{addListener:fn=>messages.push(fn)},onDisconnect:{addListener:fn=>disconnects.push(fn)},postMessage:value=>void call(value),disconnect(){if(closed)return;closed=true;clearInterval(timer);disconnects.forEach(fn=>fn());}};};`);
    const context=await chromium.launchPersistentContext(join(scratch,`${browserFamily}-profile`),{executablePath,headless:true,ignoreDefaultArgs:['--disable-extensions'],
      args:['--headless=new','--enable-unsafe-extension-debugging','--no-proxy-server','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
    contexts.push({context,browserFamily});
    const cdp=await context.browser().newBrowserCDPSession();await cdp.send('Extensions.loadUnpacked',{path:extension});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15_000});await waitForExtensionWorkerDeclarations(worker);
    stage=browserFamily+'-pairing';
    await worker.evaluate(async schoolId=>{await authStateRestorePromise;await managedAuthGatePolicyRestorePromise;await studentAuthMutationTail;CONFIG.schoolId=schoolId;await ClassPilotWindows.start();},fixture.schoolId);
    const state=await worker.evaluate(()=>({authenticated:hasStudentAuth(),sourceRef:ClassPilotWindows.active().sourceRef,bindingRevision:ClassPilotWindows.active().bindingRevision}));
    assert.equal(state.authenticated,true);sources[browserFamily]={...state,worker,context};
    const page=context.pages()[0]||await context.newPage();await page.goto(`${pageOrigin}/page/${browserFamily}`);
    const popup=await context.newPage();await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    sources[browserFamily].page=page;sources[browserFamily].popup=popup;
    await heartbeat(sources[browserFamily]);
  }
  assert.notEqual(sources.chrome.sourceRef,sources.edge.sourceRef);
  stage='paired-roster';const roster=await tiles();assert.equal(roster.tiles.length,1);assert.equal(roster.tiles[0].browserSources.length,2);
  const opened=`${pageOrigin}/page/chrome-selected-${randomUUID()}`;
  stage='chrome-exact-open';const open=await command('open-tab',{url:opened},sources.chrome);
  await until(async()=>{
    await heartbeat(sources.chrome);
    return sources.chrome.worker.evaluate(url=>chrome.tabs.query({}).then(tabs=>tabs.some(t=>t.url===url)),opened);
  },'WINDOWS_E2E_CHROME_TAB_NOT_OPENED');
  assert.equal(await sources.edge.worker.evaluate(url=>chrome.tabs.query({}).then(tabs=>tabs.some(t=>t.url===url)),opened),false);
  stage='chrome-ack';const openId=open.command.id;
  await until(async()=>{const outcome=await request(`/commands/${openId}?teachingSessionId=${encodeURIComponent(fixture.teachingSessionId)}`,{method:'GET'});return outcome.targets.length===1&&outcome.targets[0].status==='completed';},'WINDOWS_E2E_ACK_NOT_ACCEPTED');
  stage='both-attention';const attention=await command('attention-mode',{active:true,message:'Synthetic classroom attention'});
  await until(async()=>{
    await heartbeatAll();
    return (await Promise.all(Object.values(sources).map(source=>source.worker.evaluate(()=>attentionModeActive===true)))).every(Boolean);
  },'WINDOWS_E2E_POLICY_NOT_APPLIED');
  assert.equal(attention.targets.length,2);
  stage='attention-clear';await acknowledgedCommand('attention-mode',{active:false});
  stage='source-reads';const selected=Object.values(sources).map(source=>({studentId:fixture.studentId,sourceRef:source.sourceRef,bindingRevision:source.bindingRevision}));
  // The tile API selects one browser per student; verify both separately.
  for(const target of selected){const result=await tiles([target]);assert.equal(result.tiles.length,1);assert.ok(result.tiles[0].browserSources.some(source=>source.sourceRef===target.sourceRef));}
  checks.push('exact tab target, both-browser policy, source-bound durable acknowledgements');

  stage='timer-start';const timer=await acknowledgedCommand('timer',{action:'start',seconds:120,message:'Synthetic timer'});
  for(const source of Object.values(sources))await until(()=>source.page.locator('#classpilot-timer-overlay').isVisible(),'WINDOWS_E2E_TIMER_NOT_RENDERED');
  const timerState=await toolState();assert.equal(timerState.timer.id,timer.command.commandPayload.timerId);
  assert.equal(timerState.timerTargets.length,2);
  stage='timer-stop';await acknowledgedCommand('timer',{action:'stop',timerId:timerState.timer.id,expectedRevision:timerState.timer.revision});
  for(const source of Object.values(sources))await until(async()=>!await source.page.locator('#classpilot-timer-overlay').isVisible(),'WINDOWS_E2E_TIMER_NOT_CLEARED');
  checks.push('one server timer, both browser overlays and acknowledged stop');

  stage='poll-start';const poll=await acknowledgedCommand('poll',{question:'Synthetic shared choice?',options:['One','Two']});
  const pollId=poll.command.commandPayload.pollId;assert.ok(pollId);
  for(const [family,source] of Object.entries(sources)){stage=`${family}-poll-response`;await action(source,'poll-response',{pollId,selectedOption:0});}
  const pollResults=await request(`/polls/${encodeURIComponent(pollId)}/results`,{method:'GET',canonical:true});
  assert.equal(pollResults.totalResponses,1);assert.deepEqual(pollResults.results,[{option:0,count:1}]);
  stage='poll-close';await acknowledgedCommand('poll',{action:'close',pollId});
  checks.push('both browser poll responses reach one student-deduplicated server result');

  stage='lesson-start';await acknowledgedCommand('lesson-activity',{action:'start',title:'Synthetic exercise',instructions:'Read and answer.',
    resources:[],checklist:[{id:'one',text:'Read the prompt'}]});
  const lesson=await toolState();assert.ok(lesson.activity?.id);assert.equal(lesson.activityTargets.length,2);
  for(const [family,source] of Object.entries(sources)){
    stage=`${family}-lesson-progress`;await heartbeat(source);
    const progress=(await toolState()).progress.find(row=>row.studentId===fixture.studentId);
    await action(source,'class-tools-action',{action:'progress',data:{activityId:lesson.activity.id,expectedRevision:progress?.revision||0,
      status:family==='chrome'?'working':'ready_for_review',completedItemIds:family==='chrome'?[]:['one']}});
  }
  const progress=(await toolState()).progress.filter(row=>row.studentId===fixture.studentId);
  assert.equal(progress.length,1);assert.equal(progress[0].revision,2);assert.equal(progress[0].status,'ready_for_review');
  stage='lesson-end';await acknowledgedCommand('lesson-activity',{action:'end',activityId:lesson.activity.id,expectedRevision:lesson.activity.revision});
  checks.push('both browsers update the one server lesson progress with exact revisions');

  for(const [family,source] of Object.entries(sources)){
    stage=`${family}-hand`;await heartbeat(source);await action(source,'raise-hand');
    await until(async()=>{await heartbeat(source);return source.worker.evaluate(()=>currentFabState.handRaised===true);},'WINDOWS_E2E_HAND_NOT_RAISED');
    await action(source,'lower-hand');
    await until(async()=>{await heartbeat(source);return source.worker.evaluate(()=>currentFabState.handRaised===false);},'WINDOWS_E2E_HAND_NOT_LOWERED');
    stage=`${family}-help`;await action(source,'class-tools-action',{action:'help-request',data:{category:'assignment',explanation:`Synthetic ${family} help`}});
    assert.ok((await toolState()).help.some(row=>row.studentId===fixture.studentId));
    await action(source,'class-tools-action',{action:'help-withdraw',data:{}});
    assert.equal((await toolState()).help.some(row=>row.studentId===fixture.studentId),false);
    stage=`${family}-question`;await action(source,'class-tools-action',{action:'question',data:{clientRequestId:randomUUID(),question:`Synthetic ${family} question`}});
  }
  const questions=(await toolState()).questions.filter(row=>row.studentId===fixture.studentId&&/^Synthetic (chrome|edge) question$/.test(row.question));
  assert.equal(questions.length,2);checks.push('Chrome and Edge hand/help/withdraw/question runtime actions are persisted by the real server');

  stage='announcement';await acknowledgedCommand('teacher-message',{message:'Synthetic announcement'});
  for(const source of Object.values(sources)){
    await until(()=>source.page.locator('#classpilot-message-modal .classpilot-modal-overlay').isVisible(),'WINDOWS_E2E_ANNOUNCEMENT_NOT_RENDERED');
    await source.page.locator('#classpilot-close-msg-btn').click();
  }
  const studentMessageIds=[];
  for(const [family,source] of Object.entries(sources)){
    stage=`${family}-student-chat`;await heartbeat(source);const clientMessageId=randomUUID();studentMessageIds.push(clientMessageId);
    const sent=await action(source,'send-student-message',{clientMessageId,message:`Synthetic ${family} student reply`,messageType:'message'});
    assert.equal(sent.status,'Delivered');assert.equal(sent.queued,false);
  }
  const transcript=await request(`/students/${encodeURIComponent(fixture.studentId)}/messages?teachingSessionId=${encodeURIComponent(fixture.teachingSessionId)}`,{method:'GET',canonical:true});
  for(const id of studentMessageIds)assert.ok(transcript.messages.some(message=>message.clientMessageId===id));
  const privateChatLifecycle=transcript.messages.find(message=>message.clientMessageId===studentMessageIds[0])?.privateChatLifecycle;
  assert.ok(privateChatLifecycle?.threadId,'WINDOWS_E2E_PRIVATE_CHAT_LIFECYCLE_MISSING');
  stage='teacher-private-reply';await request('/teacher/reply',{canonical:true,body:{sessionId:fixture.teachingSessionId,studentId:fixture.studentId,
    expectedPrivateChatLifecycle:privateChatLifecycle,message:'Synthetic private teacher reply'}});
  await until(async()=>{
    await heartbeatAll();return (await Promise.all(Object.values(sources).map(source=>source.page.locator('#classpilot-fab-chat-messages').textContent().then(text=>text.includes('Synthetic private teacher reply')).catch(()=>false)))).every(Boolean);
  },'WINDOWS_E2E_PRIVATE_REPLY_NOT_RENDERED');
  checks.push('announcement and private teacher reply reach both browsers; both student replies appear in server transcript');

  stage='browser-observation';await request(observationPath,{canonical:true,method:'PUT',body:{viewerInstanceId:observationViewer,scope:{kind:'students',studentIds:[fixture.studentId]}}});observing=true;
  const images=[];
  for(const [family,source] of Object.entries(sources)){
    await request(observationPath,{canonical:true,method:'PUT',body:{viewerInstanceId:observationViewer,scope:{kind:'students',studentIds:[fixture.studentId]}}});
    stage=`${family}-active-cadence`;await source.page.bringToFront();
    await until(async()=>{await heartbeat(source);return source.worker.evaluate(()=>screenshotPolicyState.captureCadence.mode==='active_view'&&screenshotPolicyState.captureCadence.intervalSeconds===5);},'WINDOWS_E2E_ACTIVE_CADENCE_MISSING');
    stage=`${family}-real-thumbnail`;await source.worker.evaluate(()=>captureAndSendScreenshot({reason:'schoolpilot-e2e'}));
    let image;
    await until(async()=>{
      const result=await tiles([sourceTarget(source)]),rows=result.tiles[0].browserSources;
      for(const row of rows.filter(row=>row.sourceRef!==source.sourceRef))assert.equal(row.screenshot,undefined);
      image=rows.find(row=>row.sourceRef===source.sourceRef);
      return typeof image?.screenshot==='string';
    },'WINDOWS_E2E_HEADLESS_SCREENSHOT_UNAVAILABLE',20_000);
    assert.equal(image.bindingRevision,source.bindingRevision);assert.match(image.screenshot,/^data:image\/jpeg;base64,/);
    assert.ok(Date.parse(image.expiresAt)>Date.now());assert.ok(Date.now()-Date.parse(image.screenshotAt)<45_000);
    const decoded=await source.page.evaluate(async uri=>{const image=new Image();image.src=uri;await image.decode();return {width:image.naturalWidth,height:image.naturalHeight};},image.screenshot);
    assert.ok(decoded.width>0&&decoded.width<=1280&&decoded.height>0&&decoded.height<=720);
    const uploads=await source.worker.evaluate(()=>globalThis.__windowsFixtureImages);
    assert.ok(uploads.some(row=>row.status===200&&row.sourceRef===source.sourceRef&&row.bindingRevision===source.bindingRevision&&row.bytes>0));
    images.push({browserFamily:family,bytes:Buffer.byteLength(image.screenshot.split(',')[1],'base64'),...decoded,activeCadenceSeconds:5,teacherRead:true});
    image=null;
  }
  stage='browser-observation-release';await request(observationPath,{canonical:true,method:'DELETE',body:{viewerInstanceId:observationViewer}});observing=false;
  await until(async()=>{await heartbeatAll();return (await Promise.all(Object.values(sources).map(source=>source.worker.evaluate(()=>screenshotPolicyState.captureCadence.intervalSeconds===30)))).every(Boolean);},'WINDOWS_E2E_BACKGROUND_CADENCE_NOT_RESTORED');
  checks.push('both actual browser thumbnails upload, decode under exact teacher source, and follow 5s observed/30s released cadence');
  for(const source of Object.values(sources))assert.equal(await source.worker.evaluate(()=>globalThis.__windowsFixtureLegacyCredentialLeak),false);
  stage='completed';summary={schemaVersion:1,chrome:{authenticated:true,sourceRef:sources.chrome.sourceRef},edge:{authenticated:true,sourceRef:sources.edge.sourceRef},exactTabAction:true,bothBrowserPolicy:true,acknowledgment:true,legacyCredentialLeak:false,
    realServerTools:true,studentResponseDeduplication:true,privateChat:true,sourceQualifiedScreenshots:true,checks,images,
    nativeHost:'SIMULATED proof broker; exact signed native host NOT RUN',pilotReady:false};
  writeFileSync(join(evidence,'real-schoolpilot-browser-summary.json'),JSON.stringify(summary,null,2)+'\n');
}finally{
  if(observing)await request(observationPath,{canonical:true,method:'DELETE',body:{viewerInstanceId:observationViewer}}).catch(()=>{});
  clearInterval(renewTimer);for(const {context} of contexts)await context.close();
  await new Promise(done=>server.close(done));
  const target=resolve(scratch);assert.ok(target.startsWith(resolve(tmpdir())));rmSync(target,{recursive:true,force:true});
  fixture.guardCredential='';fixture.teacherCredential='';
}
console.log(JSON.stringify(summary));
