// Reuses the local TLS CONNECT-proxy pattern from test-extension-portal-first.
// Every HTTPS destination terminates here; no external provider is contacted.
// The one-day certificate is untrusted and is used only by disposable test
// profiles with the explicit test-only certificate-error switch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync,readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join } from 'node:path';

export async function createWindowsNavigationFixture(directory){
  const keyPath=join(directory,'navigation-fixture-key.pem'),certPath=join(directory,'navigation-fixture-cert.pem');
  const openssl=process.env.CLASSPILOT_OPENSSL_PATH||(process.platform==='win32'&&existsSync('C:/Program Files/Git/usr/bin/openssl.exe')?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
  execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=classpilot-navigation-fixture','-keyout',keyPath,'-out',certPath],{windowsHide:true,stdio:'ignore'});
  const documents=[];
  const tls=createHttpsServer({key:readFileSync(keyPath),cert:readFileSync(certPath)},(request,response)=>{
    const url=new URL(request.url,`https://${request.headers.host}`);
    if(request.headers['sec-fetch-dest']==='document')documents.push(url.toString());
    response.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});
    const heading=url.hostname==='clever.com'?'Synthetic portal':url.hostname==='accounts.google.com'?'Synthetic identity provider':'Synthetic network lesson';
    response.end(`<!doctype html><title>${heading}</title><h1>${heading}</h1><p id="network-fixture">Served by local test fixture</p>`);
  });
  const proxy=createServer((_req,res)=>{res.writeHead(502);res.end('HTTPS fixture only');});
  const sockets=new Set();
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  proxy.on('connect',(_req,socket,head)=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)socket.unshift(head);tls.emit('connection',socket);});
  await new Promise(done=>proxy.listen(0,'127.0.0.1',done));
  assert.equal(proxy.address().address,'127.0.0.1');
  return {documents,address:`http://127.0.0.1:${proxy.address().port}`,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(done=>proxy.close(done));}};
}
