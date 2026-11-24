"""在新站请求边界保持普通完成和 JSON Schema 的语义，不改写会话内容。"""
from urllib.parse import urlparse

_MAPS = {'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'}
_LISTS = {'allOf', 'anyOf', 'oneOf', 'prefixItems'}
_CHILDREN = {'items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties',
             'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'}
_TYPES = {'null', 'boolean', 'object', 'array', 'number', 'integer', 'string'}


def _union_schema(schema):
    if not isinstance(schema, dict):
        return schema
    result = {}
    for key, value in schema.items():
        if key in _MAPS and isinstance(value, dict):
            result[key] = {name: _union_schema(child) for name, child in value.items()}
        elif (key in _LISTS or key == 'items') and isinstance(value, list):
            result[key] = [_union_schema(child) for child in value]
        elif key in _CHILDREN:
            result[key] = _union_schema(value)
        else:
            result[key] = value
    types = result.get('type')
    if isinstance(types, list) and types and all(isinstance(value, str) and value in _TYPES for value in types):
        result.pop('type')
        union = [{'type': value} for value in dict.fromkeys(types)]
        if result.get('anyOf'):
            result['allOf'] = [*result.get('allOf', []), {'anyOf': union}]
        else:
            result['anyOf'] = union
    return result


def _response_format(value):
    if not isinstance(value, dict) or value.get('type') != 'json_schema':
        return value
    spec = value.get('json_schema')
    if not isinstance(spec, dict) or not isinstance(spec.get('schema'), dict):
        return value
    return {**value, 'json_schema': {**spec, 'schema': _union_schema(spec['schema'])}}


def apib_chat_request(request, base_url):
    if urlparse(str(base_url or '')).hostname != 'api.apib.ai' or not str(request.get('model', '')).lower().startswith('gemini-'):
        return request
    result = dict(request)
    extra = request.get('extra_body')
    if 'stream' not in request and not (isinstance(extra, dict) and 'stream' in extra):
        # 该站省略 stream 时默认 SSE；SDK 普通完成需要明确的 JSON 响应。
        result['stream'] = False
    if 'response_format' in result:
        result['response_format'] = _response_format(result['response_format'])
    if isinstance(extra, dict) and 'response_format' in extra:
        result['extra_body'] = {**extra, 'response_format': _response_format(extra['response_format'])}
    return result
