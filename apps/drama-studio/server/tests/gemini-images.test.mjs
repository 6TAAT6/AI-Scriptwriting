import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createInferenceBroker } from '../inference-broker.mjs'

test('Gemini 生图使用原生接口且与 GPT 的密钥和模型白名单分开', async t => {
  const calls = []
  const server = createServer(async (req,res) => {
    let text = ''; for await (const chunk of req) text += chunk
    calls.push({ url:req.url, auth:req.headers.authorization, body:JSON.parse(text) })
    res.setHeader('Content-Type','application/json')
    res.end(JSON.stringify(req.url.includes('generateContent') ? { candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'aW1hZ2U='}}]}}] } : {data:[{b64_json:'Z3B0'}]}))
  })
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const broker = await createInferenceBroker({baseUrl,apiKey:'gpt-fixture-key',models:['gpt-text'],defaultModel:'gpt-text',apiMode:'responses',imageModels:['gpt-image-2'],imageModel:'gpt-image-2',providers:[{id:'gemini',name:'Gemini',baseUrl,apiKey:'gemini-fixture-key',models:['gemini-text'],defaultModel:'gemini-text',apiMode:'chat_completions',imageModels:['gemini-3.1-flash-image'],imageModel:'gemini-3.1-flash-image'}]})
  t.after(async()=>{await broker.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const scope = broker.scope('alice'), gemini = scope.providers[0]
  const request = (route,model) => fetch(route.base_url+'/images/generations',{method:'POST',headers:{Authorization:'Bearer '+scope.token,'Content-Type':'application/json'},body:JSON.stringify({model,prompt:'雨夜',size:'1024x1536',n:1})})
  assert.equal((await request(gemini,'gpt-image-2')).status,403)
  const image = await request(gemini,'gemini-3.1-flash-image')
  assert.equal(image.status,200);assert.equal((await image.json()).data[0].b64_json,'aW1hZ2U=')
  assert.equal((await request(scope,'gpt-image-2')).status,200)
  assert.equal(calls[0].url,'/v1beta/models/gemini-3.1-flash-image:generateContent')
  assert.equal(calls[0].auth,'Bearer gemini-fixture-key');assert.equal(calls[1].auth,'Bearer gpt-fixture-key')
  assert.equal(calls[0].body.generationConfig.imageConfig.aspectRatio,'2:3')
  assert.equal(calls[1].url,'/v1/images/generations')
})
