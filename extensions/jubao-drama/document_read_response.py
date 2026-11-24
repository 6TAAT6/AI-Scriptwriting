"""读取正文连同 JSON 回执保持在默认内联预算内，续读范围以实际返回为准。"""
from tools.budget_config import DEFAULT_RESULT_SIZE_CHARS

from .document_parameters import ReadParameterError


def bounded_read_response(build, args, encode):
    requested = args.get('max_chars', 12000)
    current = dict(args)
    while True:
        result = build(current)
        result['requested_max_chars'] = requested
        material = result.get('material')
        if isinstance(material, dict):
            material['requested_max_chars'] = requested
        encoded = encode(result)
        overflow = len(encoded) - DEFAULT_RESULT_SIZE_CHARS
        if overflow <= 0:
            return encoded
        page = material if isinstance(material, dict) else result.get('document', {})
        text = page.get('text', page.get('content', ''))
        # 先按实际转义比例估算，再重新序列化验证；避免引号与换行使正文预算失真。
        text_encoded = len(encode(text))
        available = DEFAULT_RESULT_SIZE_CHARS - (len(encoded) - text_encoded)
        smaller = min(current.get('max_chars', 12000) - 1, int(len(text) * max(0, available) / text_encoded) - 128)
        if smaller < 1000:
            raise ReadParameterError('本页回执超过安全返回预算，请缩小读取范围或选择更小的稿件批次')
        current['max_chars'] = smaller
        current.setdefault('content_sha256', material.get('content_sha256') if isinstance(material, dict) else result.get('content_sha256'))
