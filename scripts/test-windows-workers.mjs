// Real Chrome and Edge, disposable profiles, synthetic HTTP and native-host fixture.
// This does not certify Authenticode, native messaging registration or device policy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync,existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';
import { exerciseWindowsWorkerParity } from './windows-worker-parity-fixture.mjs';
import { createWindowsNavigationFixture } from './windows-navigation-fixture.mjs';
const argument=process.argv.find(x=>x.startsWith('--artifact='))?.slice(11);
assert.ok(argument,'Pass --artifact=<generated Windows package directory>');
const artifact=resolve(argument),manifest=JSON.parse(readFileSync(join(artifact,'package-manifest.json'),'utf8'));
assert.equal(manifest.development,true,'Only the explicitly marked loopback development artifact is allowed');
const scratch=mkdtempSync(join(tmpdir(),'classpilot-windows-workers-'));
const requests=[],sessions=new Map(),running=[],navigationFixtures=[];
const imageMeasurements=[];
let requestBodyBytes=0,responseBodyBytes=0;
const resourceMinutes=Number(process.argv.find(x=>x.startsWith('--resource-minutes='))?.slice(19)||0);
assert.ok(Number.isFinite(resourceMinutes)&&resourceMinutes>=0&&resourceMinutes<=30);
const schoolId=randomUUID(),studentId=randomUUID();
const settings={enableTrackingHours:false,afterHoursMode:'full',trackingStartTime:'00:00',trackingEndTime:'23:59',trackingDays:['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],schoolTimezone:'America/New_York'};
function policy(session){return {schoolId,studentId,studentSessionId:session.id,deviceId:session.id,serverProtocolVersion:3,
  acceptedCapabilities:session.capabilities,...settings,settings,trackingSettings:settings,planStatus:'active',classroomState:null,
  monitoringPolicy:{mode:'full',policyMode:'full'},fab:{enabled:false},
  ...session.parityPolicy,
  exactBinding:{bindingVersion:2,schoolId,studentId,studentSessionId:session.id,deviceId:session.id,controlRevision:session.parityRevision||0},
  screenshotPolicy:{mode:'tracking_window_lease',captureAllowed:resourceMinutes>0,expiresInSeconds:resourceMinutes>0?45:0,serverTime:new Date().toISOString(),authority:{kind:'student_session',controlRevision:0},
    ...(resourceMinutes>0?{captureCadence:{mode:'background',intervalSeconds:30,expiresInSeconds:45}}:{})},
  guardExpiresAt:new Date(Date.now()+45_000).toISOString(),absoluteExpiresAt:new Date(Date.now()+3600_000).toISOString(),serverTime:new Date().toISOString()};}
const server=createServer(async(req,res)=>{
  const originalEnd=res.end;
  res.end=function(chunk,...args){if(typeof chunk==='string'||Buffer.isBuffer(chunk))responseBodyBytes+=Buffer.byteLength(chunk);return Reflect.apply(originalEnd,this,[chunk,...args]);};
  res.setHeader('access-control-allow-origin','*');res.setHeader('content-type','application/json');
  if(req.method==='OPTIONS'){res.end();return;}
  if(req.method==='GET'&&!req.url.startsWith('/api/')){res.setHeader('content-type','text/html');res.end(resourceMinutes>0
    ? '<!doctype html><meta charset="utf-8"><title>Synthetic classroom resource</title><style>body{margin:24px;font:18px system-ui;background:#edf3f7;color:#17354a}canvas{width:100%;height:65vh;border:1px solid #abc;background:white}h1{font-size:28px}</style><h1>Synthetic classroom resource</h1><p>Local generated content only — no student data or external requests.</p><canvas id="lesson" width="1280" height="720"></canvas><script>const c=document.getElementById("lesson").getContext("2d");let seed=73921;const next=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);for(let y=0;y<720;y+=8)for(let x=0;x<1280;x+=8){c.fillStyle=`hsl(${Math.floor(next()*360)} 55% ${45+Math.floor(next()*40)}%)`;c.fillRect(x,y,8,8);}c.fillStyle="#ffffffed";c.fillRect(24,24,760,500);c.fillStyle="#17354a";c.font="bold 32px system-ui";c.fillText("Synthetic science lesson",48,78);c.font="22px system-ui";for(let n=0;n<9;n++)c.fillText(`Exercise ${n+1}: explain, compare and record the result.`,48,132+n*40);</script>'
    : '<!doctype html><title>Synthetic browser source</title><p>ClassPilot local fixture</p>');return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  requestBodyBytes+=Buffer.byteLength(raw);
  let input;try{input=raw?JSON.parse(raw):{};}catch{res.writeHead(400);res.end('{}');return;}
  requests.push({path:req.url,input:req.url.endsWith('/screenshot')?{...input,screenshot:undefined,image:undefined}:input,authorization:req.headers.authorization});
  if(req.url==='/api/extension/login-config'){res.end(JSON.stringify({sharedSignInEnabled:true,schoolId,loginMethod:'name_pin'}));return;}
  if(req.url==='/api/classpilot/windows/browser/pair'){
    assert.equal(req.headers.authorization,undefined);assert.match(input.challenge,/^[A-Za-z0-9_-]{43}$/);
    assert.equal(input.proof,`synthetic-proof-${input.browserFamily}`);
    const session={id:randomUUID(),sourceRef:randomUUID(),bindingRevision:1,browserFamily:input.browserFamily,capabilities:input.capabilities.filter(name=>name!=='privateChatLifecycleV1')};
    const token=`cpw1.browser.${randomUUID()}`;sessions.set(token,session);
    res.end(JSON.stringify({...policy(session),studentToken:token,browserFamily:session.browserFamily,sourceRef:session.sourceRef,bindingRevision:1,student:{id:studentId,firstName:'Synthetic',lastName:'Student',displayName:'Synthetic Student'}}));return;
  }
  const token=req.headers.authorization?.slice(7),session=sessions.get(token);
  if(!session||input.sourceRef!==session.sourceRef||input.bindingRevision!==session.bindingRevision){res.writeHead(401);res.end('{}');return;}
  if(req.url==='/api/classpilot/windows/browser/heartbeat'){res.end(JSON.stringify({...policy(session),messages:session.pendingFrames?.splice(0)||[]}));return;}
  if(req.url==='/api/classpilot/windows/browser/screenshot'&&resourceMinutes>0){
    assert.match(input.screenshot,/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
    const bytes=Buffer.byteLength(input.screenshot.slice(input.screenshot.indexOf(',')+1),'base64');
    const age=Date.now()-Date.parse(input.capturedAt);
    assert.ok(bytes>0&&bytes<=262_144,'Bounded synthetic browser thumbnail');
    assert.ok(Number.isFinite(age)&&age>=-1000&&age<=5000,'Fresh synthetic browser thumbnail');
    assert.equal(input.screenshotAuthority?.kind,'student_session');
    imageMeasurements.push({browserFamily:session.browserFamily,bytes,ageMs:age,receivedAt:new Date().toISOString()});
    // Mirrors the reviewed no-class path: measure ingress, discard the pixels.
    res.end(JSON.stringify({ok:true,discarded:true,serverTime:new Date().toISOString(),screenshotPolicy:policy(session).screenshotPolicy}));return;
  }
  if(req.url==='/api/classpilot/windows/browser/action'){
    const result=input.operation==='school-status'?{success:true,schoolActive:true,planStatus:'active'}:input.operation==='settings'?{...policy(session)}:
      input.operation==='send-message'?{delivered:true,clientMessageId:input.payload?.clientMessageId,messageId:randomUUID()}:{success:true};
    res.end(JSON.stringify(result));return;
  }
  if(req.url==='/api/classpilot/windows/browser/command-acks'){res.end(JSON.stringify({receipts:(input.acks||[]).map(ack=>({ackId:ack.ackId,commandId:ack.commandId,accepted:true,disposition:'applied',retryable:false}))}));return;}
  res.writeHead(404);res.end('{}');
});
let context;
try{
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
  for(const browserFamily of ['chrome','edge']){
    const executablePath=browserFamily==='chrome'?(process.env.CLASSPILOT_CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'):(process.env.CLASSPILOT_EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
    assert.ok(existsSync(executablePath),`Real ${browserFamily} is required`);
    const extension=join(scratch,browserFamily);cpSync(join(artifact,browserFamily),extension,{recursive:true});
    writeFileSync(join(extension,'config.js'),`globalThis.CLASSPILOT_SERVER_URL=${JSON.stringify(origin)};
      globalThis.__windowsHostPorts=[];globalThis.__windowsHostAuthorized=true;
      chrome.runtime.connectNative=function(name){if(name!=='net.classpilot.guard')throw new Error('unexpected host');
        const messages=[],disconnects=[];let disconnected=false;
        const sendStatus=id=>{const value={id,type:'status',protocolVersion:1,authorized:globalThis.__windowsHostAuthorized,guardEpoch:'11111111-1111-4111-8111-111111111111',browserFamily:${JSON.stringify(browserFamily)},expiresInSeconds:45};for(const fn of messages)fn(value);};
        const port={onMessage:{addListener:fn=>messages.push(fn)},onDisconnect:{addListener:fn=>disconnects.push(fn)},
          disconnect(){if(disconnected)return;disconnected=true;clearInterval(tick);disconnects.forEach(fn=>fn());},
          postMessage(value){queueMicrotask(()=>{if(disconnected)return;if(value.type==='status')sendStatus(value.id);else messages.forEach(fn=>fn({id:value.id,type:'pair',browserFamily:${JSON.stringify(browserFamily)},proof:'synthetic-proof-${browserFamily}'}));});},sendStatus};
        const tick=setInterval(()=>{if(!disconnected)sendStatus();},250);globalThis.__windowsHostPorts.push(port);return port;};
    `);
    // Diagnostic counters only in this disposable fixture, never in release source.
    const workerPath=join(extension,'service-worker.js');
    writeFileSync(workerPath,readFileSync(workerPath,'utf8')+`\n;globalThis.__windowsFixtureHeartbeatReasons={};const fixtureHeartbeat=sendHeartbeat;sendHeartbeat=async(...args)=>{const reason=String(args[0]||'manual');globalThis.__windowsFixtureHeartbeatReasons[reason]=(globalThis.__windowsFixtureHeartbeatReasons[reason]||0)+1;return fixtureHeartbeat(...args);};\n`);
    const navigation=resourceMinutes?null:await createWindowsNavigationFixture(extension);
    if(navigation)navigationFixtures.push(navigation);
    const launch=()=>chromium.launchPersistentContext(join(scratch,`${browserFamily}-profile`),{executablePath,headless:true,ignoreDefaultArgs:['--disable-extensions'],
      args:['--headless=new','--enable-unsafe-extension-debugging',...(navigation?[`--proxy-server=${navigation.address}`,'--proxy-bypass-list=127.0.0.1;localhost','--ignore-certificate-errors']:['--no-proxy-server']),
        '--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1']});
    context=await launch();
    // Chrome-branded 137+ loads unpacked development fixtures through CDP, not the removed CLI switch.
    let cdp=await context.browser().newBrowserCDPSession();
    const installed=await cdp.send('Extensions.loadUnpacked',{path:extension});
    const browserVersion=(await cdp.send('Browser.getVersion')).product;
    let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15_000}).catch(async error=>{
      const page=context.pages()[0]||await context.newPage();await page.goto(browserFamily==='edge'?'edge://extensions/':'chrome://extensions/');
      console.log(await page.evaluate(()=>new Promise(done=>chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},done))));throw error;});
    await waitForExtensionWorkerDeclarations(worker);
    const errors=[];worker.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text().slice(0,200));});
    const connected=await worker.evaluate(async({origin,schoolId})=>{
      await authStateRestorePromise;await managedAuthGatePolicyRestorePromise;await studentAuthMutationTail;
      Object.assign(CONFIG,{serverUrl:origin,schoolId,autoRegistrationPaused:true});
      await ClassPilotWindows.start();
      return {authenticated:hasStudentAuth(),identitySource:CONFIG.identitySource,sourceRef:ClassPilotWindows.active().sourceRef,
        local:await chrome.storage.local.get(null),gate:getAuthGateState()};
    },{origin,schoolId});
    assert.equal(connected.authenticated,true,`${browserFamily} auth adoption`);assert.equal(connected.identitySource,'windows_guard');
    assert.equal(connected.gate.authRequired,false);assert.equal(connected.gate.windowsSignIn,true);
    assert.ok(!JSON.stringify(connected.local).includes('cpw1.browser.'),'Browser credential must not be persisted in local storage');
    await worker.evaluate(async()=>{heartbeatBackoffUntilMs=0;apiBackoffUntilMs=0;await safeSendHeartbeat('windows-fixture');});
    const until=Date.now()+6000;
    while(!requests.some(row=>row.path.endsWith('/heartbeat')&&row.input.sourceRef===connected.sourceRef)&&Date.now()<until){
      await new Promise(done=>setTimeout(done,100));await worker.evaluate(()=>safeSendHeartbeat('windows-fixture-retry'));
    }
    const heartbeat=requests.find(row=>row.path.endsWith('/heartbeat')&&row.input.sourceRef===connected.sourceRef);
    if(!heartbeat)console.log(await worker.evaluate(()=>({trackingState,determined:determineTrackingState(),license:currentLicenseIsActive(),authenticated:hasStudentAuth(),wake:workerWakeSettled,settings:schoolSettings,errors:globalThis.__windowsHostPorts.length})));
    assert.ok(heartbeat,`${browserFamily} full worker sends source-qualified telemetry`);assert.ok(Number.isSafeInteger(heartbeat.input.sequence));assert.match(heartbeat.input.observationId,/^[0-9a-f-]{36}$/);
    if(resourceMinutes){
      await (context.pages()[0]||await context.newPage()).goto(origin+'/synthetic-'+browserFamily);
      await worker.evaluate(()=>captureAndSendScreenshot({reason:'resource-initial'}));
      running.push({browserFamily,browserVersion,worker,context,cdp,sourceRef:connected.sourceRef});context=null;continue;
    }
    const parity=await exerciseWindowsWorkerParity({worker,context,cdp,extensionId:installed.id,browserFamily,origin,schoolId,studentId,sessions,requests,policy,navigation});
    worker=parity.worker;
    const beforeRestart=await worker.evaluate(async()=>({source:ClassPilotWindows.active().sourceRef,profileId:(await chrome.storage.local.get('windowsProfileId')).windowsProfileId}));
    const oldBrowserPid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(process=>process.type==='browser')?.id;
    assert.ok(oldBrowserPid,'Owned browser PID before restart');
    await context.close();context=await launch();cdp=await context.browser().newBrowserCDPSession();
    const newBrowserPid=(await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(process=>process.type==='browser')?.id;
    assert.ok(newBrowserPid);assert.notEqual(newBrowserPid,oldBrowserPid,'Full browser process actually restarted');
    // CDP-loaded development extensions are session-scoped in branded
    // browsers. Reload the same unchanged artifact; managed-install automatic
    // loading remains a separate acceptance test.
    const reinstalled=await cdp.send('Extensions.loadUnpacked',{path:extension});assert.equal(reinstalled.id,installed.id);
    const wakePage=await context.newPage();await wakePage.goto(`chrome-extension://${installed.id}/windows-popup.html`);
    worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15_000});await waitForExtensionWorkerDeclarations(worker);
    worker.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text().slice(0,200));});
    const afterRestart=await worker.evaluate(async({origin,schoolId})=>{await authStateRestorePromise;await managedAuthGatePolicyRestorePromise;await studentAuthMutationTail;
      Object.assign(CONFIG,{serverUrl:origin,schoolId,autoRegistrationPaused:true});await ClassPilotWindows.start();
      return {source:ClassPilotWindows.active().sourceRef,authenticated:hasStudentAuth(),local:await chrome.storage.local.get(null)};},{origin,schoolId});
    assert.equal(afterRestart.authenticated,true);assert.notEqual(afterRestart.source,beforeRestart.source);assert.equal(afterRestart.local.windowsProfileId,beforeRestart.profileId);
    assert.ok(!JSON.stringify(afterRestart.local).includes('cpw1.browser.'));await wakePage.close();
    parity.checks.push('full browser process restart plus unchanged development extension reload preserves profile UUID and re-pairs a fresh source');
    const clearFence=await worker.evaluate(async()=>{
      const pending=clearStudentAuth('windows-clear-regression',{notifyBackend:false,pauseAutoRegistration:true});
      let retired=false;try{ClassPilotWindows.active();}catch{retired=true;}
      await pending;await ClassPilotWindows.start();return {retired,authenticated:hasStudentAuth()};
    });
    assert.equal(clearFence.retired,true);assert.equal(clearFence.authenticated,true);
    const invalidation=await worker.evaluate(async()=>{
      const started=performance.now();globalThis.__windowsHostAuthorized=false;for(const port of globalThis.__windowsHostPorts)port.sendStatus();
      const fenced=!hasStudentAuth();await studentAuthMutationTail;
      return {fenced,elapsed:performance.now()-started,gate:getAuthGateState(),session:await chrome.storage.session.get(null)};
    });
    assert.equal(invalidation.fenced,true);assert.ok(invalidation.elapsed<1000,'Known local invalidation target');assert.equal(invalidation.gate.authRequired,true);
    assert.ok(!JSON.stringify(invalidation.session).includes('cpw1.browser.'),'Guard invalidation clears session credential');
    assert.ok(!requests.some(row=>row.authorization?.startsWith('Bearer cpw1.browser.')&&!row.path.startsWith('/api/classpilot/windows/browser/')),'No native browser credential may reach legacy endpoints');
    console.log(JSON.stringify({browserFamily,browserVersion,workerAuthenticated:true,heartbeat:true,parity:parity.checks,invalidationMs:Math.round(invalidation.elapsed),errors}));
    await context.close();context=null;
  }
  if(resourceMinutes){
    const report={schemaVersion:1,fixture:'synthetic native host and HTTP; actual unpacked Chrome and Edge workers',pilotReady:false,
      limits:['Signed native host and guard integration NOT RUN','Managed installation and physical OS lifecycle NOT RUN','Desktop pixels not collected in this browser-only resource run','Synthetic student-session thumbnails are measured on ingress then discarded; teacher reads and real backend NOT RUN','Other automated tests may run concurrently; CPU/memory are whole isolated browser process trees'],
      artifact,version:manifest.version,sourceRevision:manifest.sourceRevision,sourceDigest:manifest.sourceDigest,
      content:'Deterministic generated lesson canvas with text and colored detail; no external content',
      cpuMeasurement:'Sum of currently live isolated browser-process CPU counters at each sample; not an exact cumulative total for processes that exit between samples',
      startedAt:new Date().toISOString(),durationMinutes:resourceMinutes,samples:[],recovery:[]};
    const reportFile=join(artifact,`two-browser-resource-${Date.now()}-${resourceMinutes}min.json`),start=performance.now();
    while(performance.now()-start<resourceMinutes*60_000){
      const sample={elapsedSeconds:Math.round((performance.now()-start)/1000),requests:requests.length,browsers:[]};
      for(const instance of running){
        try{
          const processes=(await instance.cdp.send('SystemInfo.getProcessInfo')).processInfo;
          const ids=processes.map(p=>Number(p.id)).filter(id=>Number.isSafeInteger(id)&&id>0);
          const values=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
            `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,CPU,WorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`],{encoding:'utf8'}));
          const rows=Array.isArray(values)?values:[values];
          const status=await instance.worker.evaluate(()=>({authenticated:hasStudentAuth(),sourceRef:ClassPilotWindows.active().sourceRef,heartbeatReasons:globalThis.__windowsFixtureHeartbeatReasons}));
          sample.browsers.push({browserFamily:instance.browserFamily,browserVersion:instance.browserVersion,processCount:rows.length,
            cpuSeconds:rows.reduce((a,p)=>a+(p.CPU||0),0),workingSetBytes:rows.reduce((a,p)=>a+p.WorkingSet64,0),privateBytes:rows.reduce((a,p)=>a+p.PrivateMemorySize64,0),...status,
            telemetryRequests:requests.filter(r=>r.path.endsWith('/heartbeat')&&r.input.sourceRef===status.sourceRef).length});
        }catch(error){sample.browsers.push({browserFamily:instance.browserFamily,gap:true,errorName:error.name});}
      }
      report.samples.push(sample);report.observedSeconds=Math.round((performance.now()-start)/1000);
      writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');
      console.log(JSON.stringify({resourceSampleSeconds:sample.elapsedSeconds,browsers:sample.browsers.map(b=>({browserFamily:b.browserFamily,authenticated:b.authenticated,gap:b.gap,workingSetBytes:b.workingSetBytes}))}));
      await new Promise(done=>setTimeout(done,Math.min(15_000,Math.max(0,resourceMinutes*60_000-(performance.now()-start)))));
    }
    report.finalBrowserStates=await Promise.all(running.map(async instance=>({browserFamily:instance.browserFamily,...await instance.worker.evaluate(()=>({authenticated:hasStudentAuth(),heartbeatReasons:globalThis.__windowsFixtureHeartbeatReasons}))})));
    report.finishedAt=new Date().toISOString();report.observedSeconds=Math.round((performance.now()-start)/1000);
    report.heartbeatRequests=requests.filter(r=>r.path.endsWith('/heartbeat')).length;
    report.requestBodyBytes=requestBodyBytes;report.responseBodyBytes=responseBodyBytes;
    report.trafficMeasurement='HTTP bodies only; excludes headers, TLS and background browser network';
    report.screenshotRequests=requests.filter(r=>r.path.endsWith('/screenshot')).length;
    report.images=imageMeasurements;
    for(const browserFamily of ['chrome','edge'])assert.ok(imageMeasurements.some(image=>image.browserFamily===browserFamily),'Both browsers must capture and upload thumbnails');
    writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({resourceReport:reportFile,observedSeconds:report.observedSeconds}));
  }
}finally{await context?.close();for(const instance of running)await instance.context.close();for(const navigation of navigationFixtures)await navigation.close();await new Promise(done=>server.close(done));const target=resolve(scratch);assert.ok(target.startsWith(resolve(tmpdir())));rmSync(target,{recursive:true,force:true});}
