import { fixtureModelEndpoints, fixtureModelCatalog } from './model-fixtures.mjs'
import { fixtureActivationCode } from './account-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { createStudioEdge } from '../index.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-edge-'))
  const backendToken = 'private-backend-token'
  const profiles = path.join(root, '.hermes/profiles')
  await mkdir(path.join(profiles, 'jubao-drama/attachments'), { recursive: true })
  await writeFile(path.join(profiles, 'jubao-drama/attachments/root.txt'), 'root 原稿')
  const backend = createServer((req, res) => {
    if (req.url === '/') return res.end(`<script>window.__HERMES_SESSION_TOKEN__ = "${backendToken}";</script>`)
    if (req.headers['x-hermes-session-token'] !== backendToken) { res.writeHead(401); return res.end() }
    if(fixtureModelEndpoints(req,res))return;
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.startsWith('/api/sessions/')) {
      const owner = url.searchParams.get('profile')
      const id = url.pathname.split('/')[3]
      if (id !== `${owner}-stored`) { res.writeHead(404); return res.end('{}') }
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ id, messages: [], cwd: path.join(profiles, owner, 'workspace') }))
    }
    res.setHeader('Content-Type', 'text/plain'); res.end('原稿内容')
  })
  const backendWs = new WebSocketServer({ server: backend })
  backendWs.on('connection', (ws, req) => {
    if (!req.url.includes(backendToken)) return ws.close()
    ws.send(JSON.stringify({ jsonrpc:'2.0', method:'event', params:{ type:'gateway.ready', payload:{} } }))
    ws.on('message', data => {
      const frame = JSON.parse(data)
      if (!frame.method) return
      const p = frame.params || {}
      let result = frame.method==='model.options' ? fixtureModelCatalog(p.profile) : { accepted: true, echo: p }
      if (frame.method === 'session.create') {
        result = { session_id: `${p.profile}-live`, stored_session_id: `${p.profile}-stored`, messages: [], info: {} }
        for (const seq of [1, 2, 3]) ws.send(JSON.stringify({jsonrpc:'2.0',method:'event',params:{type:'message.delta',session_id:result.session_id,payload:{delta:String(seq)}}}))
      }
      if (frame.method === 'session.resume') result = { session_id: `${p.profile}-live`, stored_session_id: p.session_id, messages: [], info: {} }
      ws.send(JSON.stringify({ jsonrpc:'2.0', id:frame.id, result }))
    })
  })
  backend.listen(0,'127.0.0.1'); await once(backend,'listening')
  const edge = await createStudioEdge({ backend:`http://127.0.0.1:${backend.address().port}`, backendToken, dataDir:path.join(root,'state'), repoRoot:root,
    provisionProfile: async profile => { await mkdir(path.join(profiles,profile,'workspace'),{recursive:true}); return { profile, home:path.join(profiles,profile) } } })
  await edge.seedRoot('root-test-password')
  let middleware
  const server = createServer((req,res) => middleware(req,res,() => { res.writeHead(404); res.end() }))
  edge.install({ middlewares:{ use(fn) { middleware=fn } }, httpServer:server })
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (route, {method='GET',body,cookie,csrf,origin:requestOrigin=origin}={}) => {
    const response = await fetch(origin+route,{ method, headers:{ origin:requestOrigin, ...(body ? {'content-type':'application/json'}:{}), ...(cookie ? {cookie}:{}), ...(csrf ? {'x-studio-csrf':csrf}:{}) }, body:body?JSON.stringify(body):undefined })
    const text=await response.text(); let data; try { data=JSON.parse(text) } catch { data=text }
    return { status:response.status, data, cookie:response.headers.get('set-cookie')?.split(';')[0] }
  }
  const login = async (username,password) => { const r=await request('/studio/auth/login',{method:'POST',body:{username,password, activation_code: await fixtureActivationCode(edge.store, username, 'root-test-password')}}); return {...r,csrf:r.data.csrfToken} }
  t.after(async()=>{ await edge.close(); for(const s of backendWs.clients)s.terminate(); backendWs.close(); await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>backend.close(r))]); await rm(root,{recursive:true,force:true}) })
  return { root, profiles, edge, origin, request, login, server }
}

test('账号权限和密码状态在真实HTTP路径持久化并撤销旧会话', async t => {
  const f=await fixture(t)
  assert.deepEqual((await f.request('/studio/auth/me')).data,{user:null})
  assert.equal((await f.request('/studio/bootstrap')).status,401)
  const root=await f.login('root','root-test-password')
  assert.equal(root.data.user.role,'super_admin')
  const create = body => f.request('/studio/admin/users',{method:'POST',body,cookie:root.cookie,csrf:root.csrf})
  assert.equal((await f.request('/studio/admin/users',{method:'POST',body:{},cookie:root.cookie})).status,403)
  const alice=(await create({username:'alice',display_name:'编剧甲',password:'alice-test-password',role:'employee'})).data.user
  assert.ok(alice.id)
  assert.notEqual(alice.profile,'jubao-drama')
  const member=await f.login('alice','alice-test-password')
  assert.equal((await f.request('/studio/admin/users',{cookie:member.cookie})).status,403)
  assert.equal((await f.request(`/studio/admin/users/${root.data.user.id}`,{method:'PATCH',body:{enabled:false},cookie:root.cookie,csrf:root.csrf})).status,400)
  assert.equal((await f.request(`/studio/admin/users/${alice.id}`,{method:'PATCH',body:{enabled:false},cookie:root.cookie,csrf:root.csrf})).status,200)
  assert.equal((await f.request('/studio/bootstrap',{cookie:member.cookie})).status,401)
  assert.equal((await f.login('alice','alice-test-password')).status,401)
  await f.request(`/studio/admin/users/${alice.id}`,{method:'PATCH',body:{enabled:true},cookie:root.cookie,csrf:root.csrf})
  await f.request(`/studio/admin/users/${alice.id}/password`,{method:'POST',body:{password:'new-alice-password'},cookie:root.cookie,csrf:root.csrf})
  assert.equal((await f.login('alice','alice-test-password')).status,401)
  assert.equal((await f.login('alice','new-alice-password')).status,200)
  const manager=(await create({username:'manager',display_name:'组长',password:'manager-test-password',role:'admin'})).data.user
  const admin=await f.login('manager','manager-test-password')
  assert.equal((await f.request('/studio/admin/users',{method:'POST',body:{username:'second-admin',display_name:'管理员',password:'admin-test-password',role:'admin'},cookie:admin.cookie,csrf:admin.csrf})).status,403)
  assert.equal((await f.request(`/studio/admin/users/${root.data.user.id}`,{method:'PATCH',body:{display_name:'无效'},cookie:admin.cookie,csrf:admin.csrf})).status,403)
  assert.equal((await f.request(`/studio/admin/users/${alice.id}`,{method:'PATCH',body:{display_name:'编剧乙'},cookie:admin.cookie,csrf:admin.csrf})).status,200)
  const replaced=await f.request('/studio/auth/login',{method:'POST',body:{username:'root',password:'root-test-password'},cookie:root.cookie})
  assert.equal((await f.request('/studio/bootstrap',{cookie:root.cookie})).status,401)
  assert.equal((await f.request('/studio/auth/logout',{method:'POST',body:{},cookie:replaced.cookie,csrf:replaced.data.csrfToken})).status,200)
  assert.equal((await f.request('/studio/bootstrap',{cookie:root.cookie})).status,401)
  const saved=await readFile(path.join(f.root,'state/accounts.json'),'utf8')
  assert.ok(!saved.includes('root-test-password') && !saved.includes('new-alice-password'))
  const reopened=await createStudioEdge({backend:'http://127.0.0.1:1',dataDir:path.join(f.root,'state'),repoRoot:f.root})
  assert.equal(reopened.store.listUsers().length,3)
  await reopened.close()
})

test('HTTP与WebSocket共同拒绝跨账号会话、profile、任意文件和未授权RPC',async t=>{
  const f=await fixture(t)
  const root=await f.login('root','root-test-password')
  const created=await f.request('/studio/admin/users',{method:'POST',body:{username:'alice',display_name:'编剧甲',password:'alice-test-password',role:'employee'},cookie:root.cookie,csrf:root.csrf})
  const profile=created.data.user.profile
  const alice=await f.login('alice','alice-test-password')
  const bootstrap=await f.request('/studio/bootstrap',{cookie:alice.cookie})
  assert.equal(bootstrap.data.profile,profile)
  assert.ok(!('token' in bootstrap.data))
  assert.equal((await f.request('/api/config',{cookie:alice.cookie})).status,403)
  assert.equal((await f.request('/api/sessions/jubao-drama-stored/messages',{cookie:alice.cookie})).status,404)
  const file=path.join(f.profiles,profile,'workspace/稿件.txt'); await writeFile(file,'稿件')
  await symlink(path.join(f.profiles,'jubao-drama/attachments/root.txt'),path.join(f.profiles,profile,'workspace/越界.txt'))
  for(const forbidden of [path.join(f.profiles,'jubao-drama/attachments/root.txt'),path.join(f.profiles,profile,'workspace/越界.txt'),path.join(f.profiles,profile,'config.yaml')]) {
    assert.equal((await f.request('/api/fs/read-text?path='+encodeURIComponent(forbidden),{cookie:alice.cookie})).status,403)
  }
  assert.equal((await f.request('/api/fs/read-text?path='+encodeURIComponent(file),{cookie:alice.cookie})).status,403)
  assert.equal((await f.request('/studio/admin/users',{cookie:root.cookie,origin:'https://foreign.example'})).status,403)
  const rejectedStatus=await new Promise(resolve=>{
    const anonymous=new WebSocket(f.origin.replace('http','ws')+'/api/ws',{headers:{Origin:f.origin}})
    anonymous.on('error',()=>{})
    anonymous.on('unexpected-response',(_,response)=>{response.resume();resolve(response.statusCode)})
  })
  assert.equal(rejectedStatus,401)
  const ws=new WebSocket(f.origin.replace('http','ws')+'/api/ws',{headers:{Cookie:alice.cookie,Origin:f.origin}})
  await once(ws,'open')
  const rpc=(id,method,params)=>new Promise(resolve=>{ const cb=data=>{const frame=JSON.parse(data);if(frame.id===id){ws.off('message',cb);resolve(frame)}};ws.on('message',cb);ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params})) })
  assert.equal((await rpc('bad-profile','session.list',{profile:'jubao-drama'})).error.code,403)
  assert.equal((await rpc('bad-rpc','shell.exec',{command:'id'})).error.code,403)
  assert.equal((await rpc('bad-session','session.resume',{session_id:'jubao-drama-stored'})).error.code,404)
  const received=[]
  let eventsDone
  const allEvents=new Promise(resolve=>{eventsDone=resolve})
  ws.on('message',data=>{const frame=JSON.parse(data);if(frame.params?.type==='message.delta'){received.push(frame.params.payload.text);if(received.length===3)eventsDone()}})
  assert.equal((await rpc('catalog','model.options',{})).error,undefined)
  const own=await rpc('create','session.create',{})
  assert.equal(own.error,undefined)
  await allEvents
  assert.deepEqual(received,['1','2','3'])
  assert.equal(own.result.session_id,`${profile}-live`)
  const foreign=await rpc('cross','prompt.submit',{session_id:'jubao-drama-live',text:'无效'})
  assert.equal(foreign.error.code,403)
  const allowed=await rpc('own','prompt.submit',{session_id:own.result.session_id,text:'你好'})
  assert.equal(allowed.result.accepted,true)
  await f.request(`/studio/admin/users/${created.data.user.id}`,{method:'PATCH',body:{enabled:false},cookie:root.cookie,csrf:root.csrf})
  if(ws.readyState===WebSocket.OPEN) await once(ws,'close')
  assert.notEqual(ws.readyState,WebSocket.OPEN)
})


test('停用或更新密码后，尚未传完和并发提交的旧账号表单不再生效', async t => {
  const f=await fixture(t)
  const root=await f.login('root','root-test-password')
  const alice=(await f.request('/studio/admin/users',{method:'POST',body:{username:'alice',display_name:'编剧甲',password:'alice-test-password',role:'employee'},cookie:root.cookie,csrf:root.csrf})).data.user
  const member=await f.login('alice','alice-test-password')
  const requestBody=JSON.stringify({display_name:'过期表单里的名字'})
  let finishRequest
  const bodyStarted=new Promise(resolve=>f.server.once('request',req=>req.once('readable',resolve)))
  const delayed=new Promise((resolve,reject)=>{
    const req=httpRequest(f.origin+'/studio/account',{method:'PATCH',headers:{origin:f.origin,cookie:member.cookie,'content-type':'application/json','content-length':Buffer.byteLength(requestBody),'x-studio-csrf':member.csrf}},res=>{
      res.resume();res.once('end',()=>resolve(res.statusCode))
    })
    req.on('error',reject)
    req.write(requestBody.slice(0,5))
    finishRequest=()=>req.end(requestBody.slice(5))
  })
  await bodyStarted
  assert.equal((await f.request(`/studio/admin/users/${alice.id}`,{method:'PATCH',body:{enabled:false},cookie:root.cookie,csrf:root.csrf})).status,200)
  finishRequest()
  assert.equal(await delayed,401)
  assert.equal(f.edge.store.user(alice.id).display_name,'编剧甲')
  await f.request(`/studio/admin/users/${alice.id}`,{method:'PATCH',body:{enabled:true},cookie:root.cookie,csrf:root.csrf})
  const resumed=await f.login('alice','alice-test-password')
  const changes=await Promise.all(['first-new-password','second-new-password'].map(password=>f.request('/studio/account/password',{method:'POST',body:{current_password:'alice-test-password',password},cookie:resumed.cookie,csrf:resumed.csrf})))
  assert.deepEqual(changes.map(result=>result.status).sort(),[200,401])
  const chosen=['first-new-password','second-new-password'][changes.findIndex(result=>result.status===200)]
  const fresh=await f.login('alice',chosen)
  assert.equal(fresh.status,200)
  const actor = cookie => { const token=cookie.split('=')[1]; return { ...f.edge.store.authenticate(token), token } }
  const oldActor=actor(fresh.cookie)
  // 重置先进入持久化序列；后面的昵称变更携带重置前版本，即使账号仍启用也必须拒绝。
  const queued=await Promise.allSettled([
    f.edge.store.setPassword(actor(root.cookie),alice.id,'admin-reset-password'),
    f.edge.store.renameSelf(oldActor,{display_name:'已排队的旧表单'})
  ])
  assert.equal(queued[0].status,'fulfilled')
  assert.equal(queued[1].status,'rejected')
  assert.equal(queued[1].reason.status,401)
  assert.equal(f.edge.store.user(alice.id).display_name,'编剧甲')
  assert.equal((await f.login('alice','admin-reset-password')).status,200)
})
