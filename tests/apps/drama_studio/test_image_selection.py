"""生图选择按账号与会话保存，不能借选择接口配置连接或密钥。"""
import importlib.util
import json
from pathlib import Path

from fastapi import FastAPI
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]


def test_image_selection_profile_session_isolation_and_validation(tmp_path, monkeypatch):
    from hermes_cli.config import atomic_config_replace
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'state'))
    spec = importlib.util.spec_from_file_location('studio_image_selection', ROOT / 'apps/drama-studio/server/image_selection.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    image_spec = importlib.util.spec_from_file_location('studio_image_provider', ROOT / 'extensions/jubao-drama/images.py')
    images = importlib.util.module_from_spec(image_spec); image_spec.loader.exec_module(images)
    app = FastAPI(); app.include_router(module.router)
    homes = [tmp_path / 'state/profiles'/name for name in ('a', 'b')]
    for home in homes:
        home.mkdir(parents=True)
        atomic_config_replace(home/'config.yaml', {'providers': {'writer': {'models': ['writer']}}, 'image_gen': {'studio_endpoints': {'writer': {'models': ['allowed-image'], 'model': 'allowed-image'}}}})
    client = TestClient(app)
    assert client.post('/api/studio/image-selection?profile=a', json={'session_id': 'live', 'provider': 'writer', 'model': 'allowed-image'}).status_code == 200
    assert client.post('/api/studio/image-selection?profile=a', json={'session_id': 'live', 'provider': 'writer', 'model': 'foreign-image'}).status_code == 400
    assert client.post('/api/studio/image-selection?profile=a', json={'session_id': 'live', 'provider': 'writer', 'model': 'allowed-image', 'api_key': 'forbidden'}).status_code == 422
    for home, expected in ((homes[0], {'provider':'writer','model':'allowed-image'}), (homes[1], None), (homes[0], {'provider':'writer','model':'allowed-image'})):
        token = set_hermes_home_override(home)
        try: assert images.read_selection('live') == expected
        finally: reset_hermes_home_override(token)
    assert client.post('/api/studio/image-selection?profile=a', json={'session_id':'live'}).status_code == 200
    assert not list((homes[0]/'.studio-image-selections').glob('*.json'))
