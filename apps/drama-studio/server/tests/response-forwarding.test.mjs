import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer, request} from 'node:http'
import {once} from 'node:events'
import {forwardBody} from '../response-forwarding.mjs'

test('下载超时和浏览器提前断开均被处理，随后请求仍可完成',async t=>{
  let slow=true, failures=0
  const upstream=createServer((req,res)=>{req.resume();res.writeHead(200);res.write('正文开始');if(!slow)res.end('正文结束')})
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening')
  const edge=createServer(async(req,res)=>{
    try{const response=await fetch(`http://127.0.0.1:${upstream.address().port}`,{signal:AbortSignal.timeout(2200)});await forwardBody(response.body,res)}catch{failures++;res.destroy()}
  })
  edge.listen(0,'127.0.0.1');await once(edge,'listening')
  t.after(async()=>{upstream.closeAllConnections();edge.closeAllConnections();await Promise.all([new Promise(r=>upstream.close(r)),new Promise(r=>edge.close(r))])})
  await assert.rejects(async()=>{const r=await fetch(`http://127.0.0.1:${edge.address().port}`);return r.text()})
  assert.equal(failures,1)
  await new Promise((resolve,reject)=>{const req=request(`http://127.0.0.1:${edge.address().port}`,res=>{res.once('data',()=>{req.destroy();resolve()})});req.once('error',reject);req.end()})
  slow=false
  const after=await fetch(`http://127.0.0.1:${edge.address().port}`)
  assert.equal(await after.text(),'正文开始正文结束')
})
