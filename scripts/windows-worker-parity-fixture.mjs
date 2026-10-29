// Synthetic school transport and native host; actual packaged worker, content
// scripts, extension messaging, DNR, browser tabs and durable ACK transport.
// No production source patching or replacement of command/action handlers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function until(predicate,label,timeout=15_000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){if(await predicate())return;await pause(80);}
  throw new Error(`Windows packaged-worker parity: ${label}`);
}

export async function exerciseWindowsWorkerParity(fixture){
  let {worker}=fixture;
  const {context,cdp,extensionId,browserFamily,origin,schoolId,studentId,sessions,requests,policy,navigation}=fixture;
  const checks=[];
  const source=await worker.evaluate(()=>ClassPilotWindows.active().sourceRef);
  const session=[...sessions.values()].find(value=>value.sourceRef===source);
  assert.ok(session);
  const teachingSessionId=randomUUID(),end=Date.now()+600_000;
  let revision=0;
  const tools={phase:5,revision:1,capabilities:['helpRequestsV1','questionParkingV1','timerControlsV1','lessonActivitiesV1','exitTicketsV1'],help:null,questions:[],timer:null,
    activity:{activityId:randomUUID(),revision:1,title:'Synthetic exercise',instructions:'Read and answer.',resources:[],checklist:[{id:'one',text:'Read the prompt'}],expiresAt:new Date(end).toISOString(),progress:{status:'not_reported',completedItemIds:[],revision:0}}};
  function state(restrictions={},extra={}){
    session.parityRevision=++revision;
    session.parityPolicy={classroomState:{schemaVersion:1,revision,teachingSessionId,receivedAt:Date.now(),hardExpiresAt:end,restrictions,...extra},
      fab:{schemaVersion:1,revision,ownershipRevision:revision,lifecycleRevision:revision,teachingSessionId,supervisionContextId:null,
        activeSessionIds:[teachingSessionId],activeContexts:[{teachingSessionId}],messagingEnabled:true,messagingChannelEnabled:true,handRaisingEnabled:true,
        messagesPaused:false,pauseReason:null,handRaised:false,activeHands:[],classTools:tools,
        sessions:[{sessionId:teachingSessionId,messagingEnabled:true,messagingChannelEnabled:true,handRaisingEnabled:true,messagesPaused:false,handRaised:false,lifecycleRevision:revision}]}};
  }
  async function heartbeat(){await worker.evaluate(async()=>{heartbeatBackoffUntilMs=0;apiBackoffUntilMs=0;await safeSendHeartbeat('windows-parity');});}
  async function install(restrictions={},extra={}){
    state(restrictions,extra);await heartbeat();
    try { await until(()=>worker.evaluate(expected=>currentClassroomState?.revision===expected,revision),'current exact-bound classroom policy'); }
    catch(error){console.error(await worker.evaluate(()=>({state:currentClassroomState,authenticated:hasStudentAuth(),trackingState,control:currentStudentControlRevision()})));throw error;}
  }
  function queue(type,data={},overrides={}){
    const id=randomUUID(),binding=policy(session).exactBinding;
    const envelope={studentId,studentSessionId:session.id,exactBinding:binding,sourceRef:source,bindingRevision:session.bindingRevision,
      teachingSessionId,supervisionContextId:null,authority:{teachingSessionId,supervisionContextId:null},expiresAt:new Date(end).toISOString(),...overrides};
    const frame=type==='teacher-message'?{type:'teacher-message',_msgId:randomUUID(),commandId:id,...envelope,message:data.message,fromName:'Synthetic teacher'}:
      {type:'remote-control',_msgId:randomUUID(),commandId:id,...envelope,
        command:{id,commandId:id,type,data,...envelope},classroomState:session.parityPolicy.classroomState};
    (session.pendingFrames??=[]).push(frame);return id;
  }
  const acks=id=>requests.filter(row=>row.path.endsWith('/command-acks')&&row.input.sourceRef===source).flatMap(row=>row.input.acks||[]).filter(row=>row.commandId===id);
  async function command(type,data={},overrides={}){
    const id=queue(type,data,overrides);await heartbeat();
    await worker.evaluate(()=>flushCommandAckOutbox({forceHttp:true}));
    await until(()=>acks(id).some(ack=>['completed','failed','expired'].includes(ack.ackState)),`${type} HTTP ACK`);
    const terminal=acks(id).findLast(ack=>['completed','failed','expired'].includes(ack.ackState));
    assert.equal(terminal.ackState,'completed',`${browserFamily} ${type}: ${JSON.stringify(terminal)}`);
    assert.equal(terminal.bindingVersion,2);assert.equal(terminal.studentSessionId,session.id);assert.equal(terminal.schoolId,schoolId);
    assert.equal(terminal.studentControlRevision,revision);
    return id;
  }
  await install();
  let lesson=await context.newPage();await lesson.goto(`${origin}/parity-${browserFamily}`);
  await until(()=>lesson.locator('body').count(),'synthetic lesson page');
  let popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  async function action(type,extra={}){
    const binding=await worker.evaluate(()=>({studentMessageContext:studentMessageContextFor(captureAuthenticatedContext('Windows parity action')),
      fabBinding:fabIdentityBinding(),sessionId:currentFabState.teachingSessionId,teachingSessionId:currentFabState.teachingSessionId}));
    const response=await popup.evaluate(message=>chrome.runtime.sendMessage(message),{type,...binding,...extra});
    assert.equal(response?.success,true,`${browserFamily} ${type}: ${JSON.stringify(response)}`);return response;
  }

  const opened=`${origin}/exact-${randomUUID()}`;
  await command('open-tab',{url:opened});
  await until(()=>worker.evaluate(url=>chrome.tabs.query({}).then(tabs=>tabs.some(tab=>tab.url===url)),opened),'open-tab browser effect');
  const exact=await worker.evaluate(async url=>{const auth=captureAuthenticatedContext('Windows parity exact target');const snap=await buildOpaqueTabSnapshot(await chrome.tabs.query({}),auth);
    const tab=snap.tabs.find(value=>value.url===url);return {tabRef:tab?.tabRef,observedRevision:snap.revision};},opened);
  assert.ok(exact.tabRef);
  await command('activate-tab',exact);
  assert.equal(await worker.evaluate(url=>chrome.tabs.query({active:true,lastFocusedWindow:true}).then(tabs=>tabs[0]?.url===url),opened),true);
  await command('close-tab',{tabRefs:[exact.tabRef],snapshotRevision:exact.observedRevision});
  await until(()=>worker.evaluate(url=>chrome.tabs.query({}).then(tabs=>tabs.every(tab=>tab.url!==url)),opened),'exact close-tab browser effect');
  checks.push('open/activate/exact-close tabs with source-bound HTTP ACKs');

  await install({attentionMode:{active:true,message:'Synthetic attention'}});
  await command('attention-mode',{active:true,message:'Synthetic attention'});
  await until(()=>lesson.locator('#classpilot-attention-overlay').isVisible(),'actual Attention content overlay');
  await install();await command('attention-mode',{active:false});
  await until(async()=>!await lesson.locator('#classpilot-attention-overlay').isVisible(),'Attention overlay cleared');
  checks.push('Attention on/off rendered by content script');

  // Classroom resources intentionally exclude loopback/IP domains. Use a
  // synthetic HTTPS lesson document intercepted only inside this context.
  await context.route('https://lesson.example.test/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Synthetic restricted lesson</title><p>Local fixture</p>'}));
  await install({screenLock:{active:true,url:'https://lesson.example.test/lesson',domain:'lesson.example.test'}});
  const rules=await worker.evaluate(()=>chrome.declarativeNetRequest.getDynamicRules());
  assert.ok(rules.some(rule=>rule.action.type==='redirect'||rule.action.type==='block'),'restricted state installs actual native DNR rules');
  await install();checks.push('screen-lock policy installs browser DNR and clears');
  if(lesson.isClosed())lesson=await context.newPage();
  await lesson.goto('https://lesson.example.test/lesson');
  const focusTarget=await worker.evaluate(async()=>{const auth=captureAuthenticatedContext('Windows focus target');const snapshot=await buildOpaqueTabSnapshot(await chrome.tabs.query({}),auth);
    return {tabRef:snapshot.tabs.find(tab=>tab.url==='https://lesson.example.test/lesson')?.tabRef,observedRevision:snapshot.revision};});
  assert.ok(focusTarget.tabRef);
  await install({focus:{active:true,assignmentId:randomUUID(),...focusTarget,targetKind:'snapshot',source:'teacher',setAt:new Date().toISOString()}});
  await command('focus-tab',focusTarget);
  await until(()=>worker.evaluate(()=>focusStatus.state==='active'),'exact Focus native activation');
  await install();await command('stop-focus',{});checks.push('exact Focus and Stop Focus native activation');

  // Use the local TLS CONNECT fixture instead of Playwright routing: a denied
  // URL must never reach the fixture server, and Chrome must report native DNR
  // refusal. Provider/resource domains remain synthetic and wholly offline.
  await context.unroute('https://lesson.example.test/**');
  assert.ok(navigation);
  await worker.evaluate(()=>{globalThis.__windowsNavigationErrors=[];globalThis.__windowsNavigationListener=event=>{
    if(event.frameId===0)globalThis.__windowsNavigationErrors.push({url:event.url,error:event.error});};chrome.webNavigation.onErrorOccurred.addListener(globalThis.__windowsNavigationListener);});
  async function allowed(url){
    // A denied navigation can start an asynchronous compliant fallback. Let
    // that native navigation settle, and retry only the resulting ERR_ABORTED;
    // a DNR refusal or a final wrong document still fails this positive probe.
    for(let attempt=0;attempt<3;attempt++){
      if(lesson.isClosed())lesson=await context.newPage();
      try{await lesson.goto(url);break;}catch(error){if(attempt===2||!String(error).includes('ERR_ABORTED'))throw error;await lesson.waitForLoadState('networkidle').catch(()=>{});}
    }
    await lesson.locator('#network-fixture').waitFor({state:'visible'});
    assert.equal(lesson.url(),url,'Allowed navigation must commit its exact requested document');
    assert.ok(navigation.documents.includes(url),`${browserFamily} allowed document reached only the local fixture: ${url}`);
  }
  async function denied(url){
    assert.ok(!navigation.documents.includes(url),'Denial probe must have no prior served document');
    await lesson.goto(url).catch(()=>{});
    await until(()=>worker.evaluate(value=>globalThis.__windowsNavigationErrors.some(row=>row.url===value&&row.error.includes('ERR_BLOCKED_BY_CLIENT')),url),'native DNR denial');
    assert.ok(!navigation.documents.includes(url),`${browserFamily} denied document reached the fixture: ${url}`);
    if(!lesson.isClosed())await lesson.waitForLoadState('networkidle').catch(()=>{});
  }
  await install({flightPath:{active:true,name:'Synthetic lesson',allowedDomains:['lesson.example.test']}});
  await allowed('https://lesson.example.test/flight-allowed');await denied('https://outside.example.test/flight-denied');
  await install({blockList:{active:true,blockedDomains:['blocked.example.test']}});
  await allowed('https://lesson.example.test/blocklist-allowed');await denied('https://blocked.example.test/blocklist-denied');
  await install();checks.push('Flight Path and block list allow/deny real navigation with native DNR and no denied server request');

  const resources=JSON.parse(readFileSync(new URL('../server/__tests__/fixtures/restriction-resource-matcher-cases.json',import.meta.url),'utf8')).resources;
  for(const [name,allowedUrl,deniedUrl] of [
    ['googleDoc',resources.googleDoc.canonicalUrl,'https://docs.google.com/document/d/1OtherDocumentIdAbCdEfGhIjKlMnOpQrStUvWxYz/edit'],
    ['youtubeVideo',resources.youtubeVideo.canonicalUrl,'https://www.youtube.com/watch?v=9bZkp7q19f0'],
    ['classSection','https://example.edu/class/lesson','https://example.edu/classroom/outside'],
  ]){
    await install({flightPath:{active:true,allowedDomains:[],resources:[resources[name]]}});
    await allowed(allowedUrl);await denied(deniedUrl);
  }
  await install();checks.push('precise Google Doc, YouTube video and path-section restrictions enforce native navigation boundaries');

  const sso={authPassThroughPolicyRevision:1,authPassThrough:{schemaVersion:1,policyRevision:1,defaultProfileId:'clever',attemptTtlSeconds:300,
    profiles:[{id:'clever',name:'Synthetic Clever',startUrl:'https://clever.com/in/windows-fixture',hostRules:[{hostname:'clever.com',includeSubdomains:true},{hostname:'accounts.google.com',includeSubdomains:false}]}]}};
  await install({flightPath:{active:true,allowedDomains:['lesson.example.test']}},sso);
  await allowed('https://clever.com/in/windows-fixture');await allowed('https://accounts.google.com/windows-fixture');await allowed('https://lesson.example.test/sso-return');
  await denied('https://accounts.google.com.attacker.example.test/not-provider');
  await allowed('https://clever.com/in/windows-fixture?second=1');await denied('https://outside.example.test/sso-unapproved-app');
  await install();checks.push('SSO provider/dependency/lesson navigation works while lookalike hosts and unapproved apps remain denied');
  await worker.evaluate(()=>{chrome.webNavigation.onErrorOccurred.removeListener(globalThis.__windowsNavigationListener);delete globalThis.__windowsNavigationListener;delete globalThis.__windowsNavigationErrors;});

  await install({tabLimit:2});
  await worker.evaluate(async()=>{for(let index=0;index<5;index++)await chrome.tabs.create({url:`https://lesson.example.test/overflow-${index}`,active:false}).catch(()=>{});});
  await until(()=>worker.evaluate(()=>chrome.tabs.query({}).then(tabs=>tabs.length<=2)),'tab-limit closes actual overflow tabs');
  await install();checks.push('tab-limit overflow closes real excess browser tabs');
  if(lesson.isClosed())lesson=await context.newPage();
  if(popup.isClosed()){popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);}
  await lesson.goto(`${origin}/parity-${browserFamily}`);

  await action('raise-hand');await action('lower-hand');
  for(const operation of ['raise-hand','lower-hand']){
    const sent=requests.findLast(row=>row.path.endsWith('/action')&&row.input.sourceRef===source&&row.input.operation===operation);
    assert.ok(sent);assert.equal(sent.input.payload.studentControlRevision,revision);assert.equal(sent.input.payload.teachingSessionId,teachingSessionId);
  }
  checks.push('raise/lower hand through extension messaging and Windows HTTP action');
  for(const [tool,data,operation] of [['help-request',{category:'question',explanation:'Synthetic help'},'help'],['help-withdraw',{},'help-withdraw'],
    ['question',{question:'Synthetic question'},'questions'],['progress',{status:'working',completedItemIds:['one']},'progress']]){
    const beforeAction=requests.length;
    await action('class-tools-action',{action:tool,data});
    const delivered=requests.slice(beforeAction).filter(row=>row.path.endsWith('/action')&&row.input.sourceRef===source&&row.input.operation===`class-tools:${operation}`);
    assert.equal(delivered.length,1,`${browserFamily} ${tool} must produce its own exact Windows operation`);
    assert.equal(delivered[0].input.payload.studentControlRevision,revision);
  }
  checks.push('help request/withdraw, question and lesson progress source-routed actions');

  const pollId=randomUUID();
  await command('poll',{action:'start',pollId,question:'Synthetic choice?',options:['One','Two'],responseType:'multiple_choice'});
  await action('poll-response',{pollId,selectedOption:1});
  const poll=requests.findLast(row=>row.path.endsWith('/action')&&row.input.sourceRef===source&&row.input.operation==='poll-respond');
  assert.equal(poll?.input.payload.pollId,pollId);assert.equal(poll?.input.payload.selectedOption,1);
  await command('poll',{action:'close',pollId});checks.push('poll delivery, response and close through real worker');
  await command('timer',{action:'start',seconds:90,message:'Synthetic timer'});
  await until(()=>lesson.locator('#classpilot-timer-overlay').isVisible(),'timer content overlay');
  await command('timer',{action:'stop'});
  await until(async()=>!await lesson.locator('#classpilot-timer-overlay').isVisible(),'timer overlay cleared');
  checks.push('timer start/stop rendered by content script');

  await command('teacher-message',{message:'Synthetic announcement'});
  await until(()=>lesson.locator('#classpilot-message-modal .classpilot-modal-overlay').isVisible(),'teacher announcement modal');
  await lesson.locator('#classpilot-close-msg-btn').click();
  checks.push('teacher announcement delivered with durable HTTP ACK receipt');
  // This fixture now supplies the complete server lifecycle, so it may
  // negotiate private chat independently of the deliberately simpler resource fixture.
  session.capabilities.push('privateChatLifecycleV1');
  const lifecycle={threadId:randomUUID(),schoolEpoch:1,activityEpoch:1,threadGeneration:1};
  state();session.parityPolicy.fab.privateChatLifecycleState={schoolEpoch:1,threads:[{...lifecycle,teachingSessionId,supervisionContextId:null}]};
  await heartbeat();
  await until(()=>worker.evaluate(()=>hasNegotiatedCapability('privateChatLifecycleV1')),'private chat capability with complete lifecycle');
  const privateId=randomUUID();
  const privateFrame={type:'teacher-message',_msgId:privateId,messageId:privateId,studentId,studentSessionId:session.id,exactBinding:policy(session).exactBinding,
    teachingSessionId,supervisionContextId:null,message:'Synthetic private reply',privateChatLifecycle:lifecycle,fromName:'Synthetic teacher'};
  session.pendingFrames.push(privateFrame);await heartbeat();
  await until(()=>lesson.locator('#classpilot-fab-chat-messages').textContent().then(text=>text.includes('Synthetic private reply')).catch(()=>false),'private reply content');
  const clientMessageId=randomUUID();
  const studentReply=await action('send-student-message',{clientMessageId,message:'Synthetic student reply',messageType:'message'});
  assert.equal(studentReply.status,'Delivered');assert.equal(studentReply.queued,false);
  const chatPost=requests.findLast(row=>row.path.endsWith('/action')&&row.input.sourceRef===source&&row.input.operation==='send-message');
  assert.equal(chatPost?.input.payload.clientMessageId,clientMessageId);assert.equal(chatPost?.input.payload.expectedPrivateChatLifecycle.threadId,lifecycle.threadId);
  checks.push('private teacher reply and student reply with lifecycle-bound Windows HTTP delivery');

  const staleDestination=`${origin}/stale-${randomUUID()}`;
  const staleId=queue('open-tab',{url:staleDestination},{studentSessionId:randomUUID(),exactBinding:{...policy(session).exactBinding,studentSessionId:randomUUID()}});
  await heartbeat();
  assert.equal(await worker.evaluate(url=>chrome.tabs.query({}).then(tabs=>tabs.some(tab=>tab.url===url)),staleDestination),false);
  assert.equal(acks(staleId).length,0,'wrong-session command must not ACK with current student credentials');
  checks.push('wrong-student-session command neither executes nor acknowledges');

  const oldSource=source;
  const disconnected=await worker.evaluate(async()=>{for(const port of globalThis.__windowsHostPorts)port.disconnect();const retired=!hasStudentAuth();await studentAuthMutationTail;return retired;});
  assert.equal(disconnected,true,'native-port disconnect synchronously retires authority');
  await worker.evaluate(()=>ClassPilotWindows.start());
  const reconnected=await worker.evaluate(()=>({authenticated:hasStudentAuth(),source:ClassPilotWindows.active().sourceRef}));
  assert.equal(reconnected.authenticated,true);assert.notEqual(reconnected.source,oldSource);
  assert.equal(await worker.evaluate(()=>attentionModeActive),false);
  checks.push('native-port disconnect clears authority; explicit reconnect pairs a fresh source');
  await popup.close();await lesson.close();

  // Stop the actual extension worker. Its subsequent wake must pair through
  // the host again, rather than restoring the prior browser credential.
  const restartPage=await context.newPage();await restartPage.goto(`chrome-extension://${extensionId}/popup.html`);
  const pageCdp=await context.newCDPSession(restartPage),versions=new Map();
  pageCdp.on('ServiceWorker.workerVersionUpdated',event=>{for(const version of event.versions)versions.set(version.versionId,version);});
  await pageCdp.send('ServiceWorker.enable');
  await until(()=>[...versions.values()].some(value=>value.scriptURL===worker.url()&&value.runningStatus==='running'),'CDP running worker version');
  const version=[...versions.values()].find(value=>value.scriptURL===worker.url()&&value.runningStatus==='running');
  const previousUrl=worker.url(),incarnation=randomUUID();
  await worker.evaluate(value=>{globalThis.__windowsParityIncarnation=value;},incarnation);
  await pageCdp.send('ServiceWorker.stopWorker',{versionId:version.versionId});
  await until(()=>versions.get(version.versionId)?.runningStatus==='stopped','actual worker stop');
  await restartPage.evaluate(()=>chrome.runtime.sendMessage({type:'windows-browser-status'}));
  await until(()=>[...versions.values()].some(value=>value.scriptURL===previousUrl&&value.runningStatus==='running'),'actual worker running after wake');
  worker=context.serviceWorkers().find(value=>value.url()===previousUrl);
  assert.ok(worker,'Playwright exposes the restarted extension worker');
  await waitForExtensionWorkerDeclarations(worker);
  assert.notEqual(await worker.evaluate(()=>globalThis.__windowsParityIncarnation),incarnation,'fresh worker global must not retain the previous incarnation');
  await worker.evaluate(async({origin,schoolId})=>{await authStateRestorePromise;await managedAuthGatePolicyRestorePromise;await studentAuthMutationTail;
    // As at first startup, explicitly select the isolated synthetic school
    // origin after the ordinary managed-policy restore chooses its default.
    Object.assign(CONFIG,{serverUrl:origin,schoolId,autoRegistrationPaused:true});await ClassPilotWindows.start();},{origin,schoolId});
  const restarted=await worker.evaluate(async()=>({authenticated:hasStudentAuth(),source:ClassPilotWindows.active().sourceRef,local:JSON.stringify(await chrome.storage.local.get(null))}));
  assert.equal(restarted.authenticated,true);assert.notEqual(restarted.source,reconnected.source);assert.ok(!restarted.local.includes('cpw1.browser.'));
  checks.push('actual service-worker stop/wake re-pairs and does not restore a persisted browser token');
  await pageCdp.detach();await restartPage.close();
  return {worker,checks};
}
