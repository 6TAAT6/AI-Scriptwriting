import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanySso } from '../company-sso.mjs'

test('公司 SSO 核心事务校验状态、一次性凭证和员工身份', async () => {
  const calls = []
  const sso = new CompanySso({
    serverUrl: 'http://company.example', callbackUrl: 'http://studio.example/auth/company/callback',
    appId: 'web-company-test', secret: 'company-secret-123456'
  }, {
    fetcher: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) })
      return new Response(JSON.stringify({ ok: true, data: {
        session: 'jbs_' + 'A'.repeat(43), employeeId: '104',
        employee: { employeeId: '104', name: '测试员工', account: 'employee-104' }, expiresIn: 3600
      }}), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  const started = sso.begin()
  assert.match(started.url, /appId=web-company-test/)
  const result = await sso.complete(started.transaction, 'ticket-104', started.state)
  assert.deepEqual(result.employee, { id: '104', name: '测试员工', account: 'employee-104' })
  assert.equal(result.upstream, 'jbs_' + 'A'.repeat(43))
  assert.equal(calls[0].url, 'http://company.example/sso/exchange')
  await assert.rejects(() => sso.complete(started.transaction, 'ticket-104', started.state), error => error.status === 401)
})

test('公司身份服务限流保持临时不可用，不伪装成撤权', async () => {
  const sso = new CompanySso({
    serverUrl: 'http://company.example', callbackUrl: 'http://studio.example/auth/company/callback',
    appId: 'web-company-test', secret: 'company-secret-123456'
  }, { fetcher: async () => new Response(JSON.stringify({ ok: false }), { status: 429 }) })
  await assert.rejects(() => sso.verify('jbs_' + 'A'.repeat(43), '104'), error => error.status === 503)
})
