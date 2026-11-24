import {test} from 'node:test'
import assert from 'node:assert/strict'
import {StudioBackend} from '../backend.mjs'

function fixture(){
  const backend=Object.create(StudioBackend.prototype)
  backend.runtimeStates=new Map([['live',{running:false,storedSessionId:'saved'}]])
  backend.deletingRuntime=new Set();backend.deletingStored=new Set()
  const call={method:'prompt.submit',params:{session_id:'live'}}
  return {backend,call}
}

test('缺少开始完成事件时，只能用同连接Native空闲证据恢复发送门禁',async()=>{
  const {backend,call}=fixture()
  backend.noteRequest(call);await backend.noteReply(call,{result:{status:'streaming'}})
  backend.noteEvent({method:'event',params:{session_id:'live',type:'session.info',payload:{running:false}}})
  assert.throws(()=>backend.noteRequest(call),error=>error.status===409)
  await backend.prepareRequest(call,async method=>method==='session.active_list'
    ?{sessions:[{id:'live',session_key:'saved',status:'working'}]}:{active:[]})
  assert.throws(()=>backend.noteRequest(call),error=>error.status===409)
  await backend.prepareRequest(call,async method=>method==='session.active_list'
    ?{sessions:[{id:'live',session_key:'saved',status:'idle'}]}:{active:[]})
  assert.doesNotThrow(()=>backend.noteRequest(call))
  await backend.noteReply(call,{result:{status:'streaming'}})
  const compressed=async method=>method==='session.active_list'
    ?{sessions:[{id:'live',session_key:'continued',status:'idle'}]}:{active:[]}
  await backend.prepareRequest(call,compressed,async()=>({requested_session_id:'saved',session_id:'continued',path:['foreign','continued']}))
  assert.throws(()=>backend.noteRequest(call),error=>error.status===409)
  await backend.prepareRequest(call,compressed,async()=>({requested_session_id:'saved',session_id:'continued',path:['saved','continued']}))
  assert.doesNotThrow(()=>backend.noteRequest(call))
})

test('提交回执未到或空闲快照已落后于新开始事件时不能解锁',async()=>{
  const {backend,call}=fixture()
  backend.noteRequest(call)
  const idle=async method=>method==='session.active_list'?{sessions:[{id:'live',session_key:'saved',status:'idle'}]}:{active:[]}
  await backend.prepareRequest(call,idle)
  assert.throws(()=>backend.noteRequest(call),error=>error.status===409)
  await backend.noteReply(call,{result:{status:'streaming'}})
  let resolve,entered
  const ready=new Promise(done=>{entered=done})
  const checking=backend.prepareRequest(call,async method=>{
    if(method!=='session.active_list')return {active:[]}
    entered();return new Promise(done=>{resolve=done})
  })
  await ready
  backend.noteEvent({method:'event',params:{session_id:'live',type:'message.start',payload:{}}})
  resolve({sessions:[{id:'live',session_key:'saved',status:'idle'}]})
  await checking
  assert.throws(()=>backend.noteRequest(call),error=>error.status===409)
})
