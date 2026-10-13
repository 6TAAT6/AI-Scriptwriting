"""沿用原生生图工具，使用当前账号和会话选择的图片服务。"""
import hashlib
import json
import os

from agent.image_gen_provider import save_b64_image, success_response
from hermes_constants import get_hermes_home
from plugins.image_gen.openai import OpenAIImageGenProvider


def read_selection(session_id):
    if not session_id:
        return None
    directory = get_hermes_home() / '.studio-image-selections'
    try:
        root = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        filename = hashlib.sha256(session_id.encode()).hexdigest() + '.json'
        try:
            fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
        except FileNotFoundError:
            return None
        with os.fdopen(fd) as handle:
            return json.loads(handle.read(4096))
    finally:
        os.close(root)


class StudioImageProvider(OpenAIImageGenProvider):
    def capabilities(self):
        return {'modalities': ['text'], 'max_reference_images': 0}

    def generate(self, prompt, aspect_ratio='landscape', **kwargs):
        import base64
        import io
        import httpx
        from PIL import Image
        from agent.secret_scope import get_secret
        from gateway.session_context import get_session_env
        from hermes_cli.config import load_config_readonly
        try:
            if not isinstance(prompt, str) or not 1 <= len(prompt) <= 12000 or aspect_ratio not in {'landscape', 'portrait', 'square'}:
                raise ValueError('图片描述或比例无效')
            config = load_config_readonly()
            images = config.get('image_gen') or {}
            choice = read_selection(get_session_env('HERMES_UI_SESSION_ID')) or images.get('openai') or {}
            provider, model = choice.get('provider', ''), choice.get('model', '')
            allowed = (images.get('studio_endpoints') or {}).get(provider, {}).get('models', [])
            if model not in allowed:
                raise ValueError('所选图片模型未接入')
            endpoint = (config.get('providers') or {}).get(provider, {})
            key = get_secret(endpoint.get('key_env', ''))
            base = str(endpoint.get('base_url', '')).rstrip('/')
            if not key or not base:
                raise ValueError('图片接入尚未配置完整')
            size = {'landscape': '1536x1024', 'portrait': '1024x1536', 'square': '1024x1024'}[aspect_ratio]
            native_gemini = model.startswith('gemini-') and not (config.get('studio_security') or {}).get('restricted')
            headers = {'Authorization': 'Bearer ' + key}
            if native_gemini:
                target = base.removesuffix('/v1') + '/v1beta/models/' + model + ':generateContent'
                body = {'contents': [{'role': 'user', 'parts': [{'text': prompt}]}], 'generationConfig': {'responseModalities': ['TEXT', 'IMAGE'], 'imageConfig': {'aspectRatio': {'landscape':'3:2','portrait':'2:3','square':'1:1'}[aspect_ratio]}}}
            else:
                target = base + '/images/generations'
                body = {'model': model, 'prompt': prompt, 'size': size, 'n': 1}
            with httpx.Client(timeout=300, follow_redirects=False) as client:
                with client.stream('POST', target, headers=headers, json=body) as response:
                    response.raise_for_status()
                    chunks, length = [], 0
                    for chunk in response.iter_bytes():
                        length += len(chunk)
                        if length > 36 * 1024 * 1024: raise ValueError('图片结果过大')
                        chunks.append(chunk)
            data = json.loads(b''.join(chunks))
            if native_gemini:
                parts = [part for candidate in data.get('candidates', []) for part in candidate.get('content', {}).get('parts', [])]
                encoded = next(part.get('inlineData', part.get('inline_data', {})).get('data') for part in parts if part.get('inlineData', part.get('inline_data', {})).get('data'))
            else:
                encoded = data['data'][0]['b64_json']
            raw = base64.b64decode(encoded, validate=True)
            with Image.open(io.BytesIO(raw)) as image:
                extension = {'PNG':'png','JPEG':'jpg','WEBP':'webp'}.get(image.format)
                if not extension: raise ValueError('图片格式不受支持')
                image.verify()
            target = save_b64_image(encoded, prefix='studio-image', extension=extension)
            return success_response(image=str(target), model=model, prompt=prompt, aspect_ratio=aspect_ratio, provider='openai', modality='text')
        except Exception as exc:
            # 上游错误可能包含请求头或服务地址，业务结果不透出运营凭据。格式、配置和
            # 解码错误是确定性前置条件；只有明确的超时/连接/服务端状态才允许稍后重试。
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            message = str(exc).lower()
            retryable = (
                isinstance(exc, (TimeoutError, ConnectionError))
                or status in {408, 409, 425, 429}
                or isinstance(status, int) and status >= 500
                or any(marker in message for marker in ('timeout', 'timed out', 'connection reset', 'temporarily unavailable'))
            )
            return {
                'success': False,
                'error': '图片生成暂时不可用，请检查所选模型配置或稍后重试。' if retryable
                         else '图片生成前置条件未满足，请检查所选模型和图片参数。',
                'blocked_reason': 'upstream_unavailable' if retryable else 'image_generation_precondition',
                'required_user_action': '稍后重试同一请求。' if retryable else '修正图片模型配置或描述、比例后再试。',
                'retryable': retryable,
                'tool': 'image_generate',
            }
