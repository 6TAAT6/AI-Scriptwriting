"""服务凭据保护下，整理当前账号已保存回复对应的只读稿件。"""
from contextlib import closing

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hermes_cli.plugins import get_plugin_manager
from hermes_cli.web_routers.config_env import _config_profile_scope
from hermes_constants import get_hermes_home
from hermes_state import SessionDB


router = APIRouter()


class SessionDocuments(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')


@router.post('/api/studio/session-documents')
def session_documents(body: SessionDocuments, profile: str):
    with _config_profile_scope(profile):
        database = get_hermes_home() / 'state.db'
        if not database.is_file():
            raise HTTPException(404, '对话不存在。')
        with closing(SessionDB(database, read_only=True)) as db:
            if db.get_session(body.session_id) is None:
                raise HTTPException(404, '对话不存在。')
        manager = get_plugin_manager()
        manager.discover_and_load()
        loaded = manager._plugins.get('jubao-drama')
        if not loaded or not loaded.enabled or loaded.error or loaded.module is None:
            raise HTTPException(503, '稿件能力尚未就绪。')
        loaded.module.reconcile_session_documents(body.session_id)
        return loaded.module.session_documents(body.session_id)
