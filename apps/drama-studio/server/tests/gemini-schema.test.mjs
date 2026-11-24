import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geminiStructuredRequest } from '../gemini-schema.mjs'

test('嵌套 schema 保留已有联合约束及数据中的同名字段', () => {
  const schema = { type: 'object', properties: {
    values: { type: 'array', items: { type: ['string', 'null'], anyOf: [{ enum: ['确认', null] }] } },
    type: { type: ['string', 'null'] }
  }, $defs: { limit: { type: ['integer', 'null'], minimum: 1 } }, examples: [{ type: ['业务', '原文'] }] }
  const body = { model: 'gemini-4-hydrogen', response_format: { type: 'json_schema', json_schema: { schema, strict: false } } }
  const before = JSON.stringify(body)
  const result = geminiStructuredRequest(body, '/chat/completions', new URL('https://api.apib.ai/v1')).response_format.json_schema.schema
  assert.deepEqual(result.properties.values.items, { anyOf: [{ enum: ['确认', null] }], allOf: [{ anyOf: [{ type: 'string' }, { type: 'null' }] }] })
  assert.deepEqual(result.properties.type, { anyOf: [{ type: 'string' }, { type: 'null' }] })
  assert.deepEqual(result.$defs.limit, { minimum: 1, anyOf: [{ type: 'integer' }, { type: 'null' }] })
  assert.deepEqual(result.examples, [{ type: ['业务', '原文'] }])
  assert.equal(JSON.stringify(body), before)
})

test('不改写其他模型、普通 JSON 模式和非结构化路由', () => {
  for (const [model, route, format] of [
    ['gpt-6-astra', '/chat/completions', { type: 'json_schema', json_schema: { schema: { type: ['string', 'null'] } } }],
    ['gemini-4-hydrogen', '/chat/completions', { type: 'json_object' }],
    ['gemini-4-hydrogen', '/responses', { type: 'json_schema', json_schema: { schema: { type: ['string', 'null'] } } }]
  ]) {
    const body = { model, response_format: format }
    assert.equal(geminiStructuredRequest(body, route), body)
  }
})


test('仅新站显式固定省略的 stream，其他站点和显式流式保持原样', () => {
  const body = { model: 'gemini-4-hydrogen', messages: [{ role: 'user', content: '标题' }] }
  assert.equal(geminiStructuredRequest(body, '/chat/completions', new URL('https://api.apib.ai/v1')).stream, false)
  assert.equal(geminiStructuredRequest({ ...body, stream: true }, '/chat/completions', new URL('https://api.apib.ai/v1')).stream, true)
  const withSchema = { ...body, response_format: { type: 'json_schema', json_schema: { schema: { type: ['object', 'null'] } } } }
  for (const host of ['sub2.xlbby.com', 'api.apib.ai.evil.example']) {
    assert.equal(geminiStructuredRequest(withSchema, '/chat/completions', new URL('https://' + host + '/v1')), withSchema)
  }
})
