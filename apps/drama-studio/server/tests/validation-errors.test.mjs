import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createInferenceBroker} from '../inference-broker.mjs'

test('本地校验错误有专用代码，诊断不得包含请求正文或模型凭据',async t=>{
  const rows=[]
  const broker=await createInferenceBroker({baseUrl:'https://unused.invalid/v1',apiKey:'parent-secret-canary',
    models:['allowed'],defaultModel:'allowed',apiMode:'chat_completions',onDiagnostic:row=>rows.push(row)})
  t.after(()=>broker.close())
  const scope=broker.scope('fixture-profile')
  for(const [body,status,code] of [
    [{model:'not-allowed',messages:[{role:'user',content:'private-prompt-canary'}]},403,'model_not_allowed'],
    [{model:'allowed',messages:[],unsupported:'private-prompt-canary'},400,'request_invalid']]){
    const response=await fetch(scope.base_url+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+scope.token,'Content-Type':'application/json'},body:JSON.stringify(body)})
    assert.equal(response.status,status);assert.equal((await response.json()).error.code,code)
  }
  assert.equal(rows.length,2)
  assert.ok(rows.every(row=>row.event==='studio.inference.rejected'&&row.phase==='validation'))
  for(const secret of ['parent-secret-canary','private-prompt-canary',scope.token])assert.ok(!JSON.stringify(rows).includes(secret))
})
