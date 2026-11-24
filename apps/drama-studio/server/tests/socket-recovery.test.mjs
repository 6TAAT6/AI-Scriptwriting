import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {WebSocket,WebSocketServer} from 'ws'
import {StudioBackend} from '../backend.mjs'
import {createSocketBridge} from '../socket.mjs'

async function fixture(t){
  const native=createServer(),wss=new WebSocketServer({server:native}),peers=[]
  let prompts=0
  wss.on('connection',ws=>{
    peers.push(ws)
    ws.on('message',raw=>{
      const call=JSON.parse(raw)
      let result
      if(call.method==='session.active_list')result={sessions:[{id:'live',session_key:'saved',status:'idle'}]}
      else if(call.method==='delegation.status')result={active:[]}
      else if(call.method==='prompt.submit'){prompts++;result={status:'streaming'}}
      else result={}
      ws.send(JSON.stringify({jsonrpc:'2.0',id:call.id,result}))
    })
  })
  native.listen(0,'127.0.0.1');await once(native,'listening')
  const backend=new StudioBackend({backend:`http://127.0.0.1:${native.address().port}`,backendToken:'fixture-token',repoRoot:process.cwd()})
  backend.runtimeOwners.set('live','root')
  backend.runtimeStates.set('live',{storedSessionId:'saved',running:true,submitting:true,submissionAccepted:true})
  const auth={token:'fixture-cookie',user:{id:'root',profile:'jubao-drama',role:'super_admin'}}
  const store={revoked:new Set(),authenticate:()=>auth,verifyActor:async value=>value}
  const bridge=createSocketBridge({backend,store,authenticateRequest:()=>auth,sameOrigin:()=>{}})
  const server=createServer();server.on('upgrade',bridge.upgrade)
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const peerReady=once(wss,'connection')
  const client=new WebSocket(`ws://127.0.0.1:${server.address().port}/api/ws`)
  await once(client,'open');await peerReady
  t.after(async()=>{
    client.terminate();await bridge.close()
    for(const peer of peers)peer.terminate()
    await new Promise(resolve=>wss.close(resolve))
    await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>native.close(resolve))])
  })
  return {client,peers,prompts:()=>prompts}
}

test('恢复门禁的内部只读RPC不泄漏到浏览器，也不重发上一次提示',async t=>{
  const f=await fixture(t),frames=[]
  f.client.on('message',raw=>frames.push(JSON.parse(raw)))
  const reply=new Promise(resolve=>f.client.on('message',raw=>{
    const frame=JSON.parse(raw);if(frame.id==='new-human-request')resolve(frame)
  }))
  f.client.send(JSON.stringify({jsonrpc:'2.0',id:'new-human-request',method:'prompt.submit',params:{session_id:'live',text:'用户这次明确提交的新消息'}}))
  const frame=await reply
  assert.equal(frame.error,undefined);assert.equal(frame.result.status,'streaming')
  assert.equal(f.prompts(),1)
  assert.ok(frames.every(row=>!String(row.id).startsWith('studio-state:')))
})

test('浏览器正常关闭后不把派生的上游1005记成故障',async t=>{
  const f=await fixture(t),errors=[]
  t.mock.method(console,'error',(...args)=>errors.push(args.join(' ')))
  const peerClosed=once(f.peers[0],'close'),clientClosed=once(f.client,'close')
  f.client.close(1000)
  await Promise.all([peerClosed,clientClosed])
  await new Promise(resolve=>setTimeout(resolve,2000))
  assert.ok(!errors.some(row=>row.includes('studio websocket upstream closed')))
})

test('浏览器仍在线而上游异常退出时继续记录故障并关闭当前连接',async t=>{
  const f=await fixture(t),errors=[]
  t.mock.method(console,'error',(...args)=>errors.push(args.join(' ')))
  const closed=once(f.client,'close')
  f.peers[0].terminate()
  const [code]=await closed
  assert.equal(code,1011)
  assert.ok(errors.some(row=>row.includes('studio websocket upstream closed')))
})
