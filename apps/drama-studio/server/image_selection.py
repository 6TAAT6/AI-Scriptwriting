"""服务凭据保护下，保存当前账号会话的生图选择。"""
import hashlib
import json
import os
import secrets
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from hermes_cli.web_routers.config_env import _config_profile_scope
from hermes_cli.config import load_config_readonly
from hermes_constants import get_hermes_home

router = APIRouter()


class ImageSelection(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')
    provider: str = ''
    model: str = ''


@router.post('/api/studio/image-selection')
def set_selection(body: ImageSelection, profile: str):
    with _config_profile_scope(profile):
        config = load_config_readonly()
        provider = body.provider.removeprefix('custom:')
        if body.model or provider:
            models = (config.get('image_gen') or {}).get('studio_endpoints', {}).get(provider, {}).get('models', [])
            if body.model not in models: raise HTTPException(400, '请从已接入的生图模型中选择。')
        folder = get_hermes_home() / '.studio-image-selections'
        folder.mkdir(mode=0o700, exist_ok=True)
        directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        name = hashlib.sha256(body.session_id.encode()).hexdigest() + '.json'
        temporary = secrets.token_hex(16) + '.tmp'
        try:
            if not body.model:
                try: os.unlink(name, dir_fd=directory)
                except FileNotFoundError: pass
            else:
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                with os.fdopen(fd, 'w') as handle: json.dump({'provider': provider, 'model': body.model}, handle)
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            try: os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError: pass
            os.close(directory)
        return {'ok': True}
