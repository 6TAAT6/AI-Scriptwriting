import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WorkerPool} from '../worker-pool.mjs'

const user={profile:'studio-'+'a'.repeat(20)}

test('启动失败合并并发请求，后续连接在冷却期不重复启动进程',async t=>{
  const pool=new WorkerPool({repoRoot:process.cwd(),hermesHome:'/unused'})
  let starts=0
  pool.start=async()=>{starts++;throw new Error('隔离启动失败')}
  t.after(()=>pool.close())
  await Promise.allSettled(Array.from({length:12},()=>pool.get(user)))
  assert.equal(starts,1)
  await assert.rejects(pool.get(user),error=>error.status===503&&error.retryAfterSeconds>0)
  assert.equal(starts,1)
})

test('冷却结束可重试，成功后恢复复用且撤销不会留下旧失败状态',async t=>{
  let now=10000
  t.mock.method(Date,'now',()=>now)
  const pool=new WorkerPool({repoRoot:process.cwd(),hermesHome:'/unused'})
  t.after(()=>pool.close())
  let starts=0
  pool.start=async()=>{
    if(++starts===1)throw new Error('首次失败')
    const worker={endpoint:new URL('http://127.0.0.1:1')};pool.workers.set(user.profile,worker);return worker
  }
  await assert.rejects(pool.get(user))
  await assert.rejects(pool.get(user),error=>error.status===503)
  now+=120000
  const worker=await pool.get(user)
  assert.equal(await pool.get(user),worker)
  assert.equal(starts,2)
})
