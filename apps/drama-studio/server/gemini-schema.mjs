const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
const lists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const children = new Set(['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties',
  'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'])
const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'])

// 只遍历 schema 位置；default、enum、examples 内的用户数据必须逐字保留。
function unionSchema(schema) {
  if (!object(schema)) return schema
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => {
    if (maps.has(key) && object(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, unionSchema(child)]))]
    if ((lists.has(key) || key === 'items') && Array.isArray(value)) return [key, value.map(unionSchema)]
    if (children.has(key)) return [key, unionSchema(value)]
    return [key, value]
  }))
  if (!Array.isArray(result.type) || !result.type.length || !result.type.every(type => types.has(type))) return result
  const union = [...new Set(result.type)].map(type => ({ type }))
  delete result.type
  // 原有 anyOf 与类型限制是交集，不能用新联合覆盖原有校验。
  if (result.anyOf) result.allOf = [...(result.allOf ?? []), { anyOf: union }]
  else result.anyOf = union
  return result
}

export function geminiStructuredRequest(body, route, upstreamBase) {
  if (route !== '/chat/completions' || !/^gemini-/i.test(body.model)
    || upstreamBase?.hostname !== 'api.apib.ai') return body
  // 新站省略 stream 时默认 SSE；普通完成显式请求 JSON，原有流式请求保留。
  const request = { stream: false, ...body }
  const format = body.response_format
  if (format?.type !== 'json_schema' || !object(format.json_schema?.schema)) return request
  return { ...request, response_format: { ...format, json_schema: {
    ...format.json_schema, schema: unionSchema(format.json_schema.schema)
  } } }
}
