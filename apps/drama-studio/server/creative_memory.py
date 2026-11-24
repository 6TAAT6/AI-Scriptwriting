"""服务凭据保护下，读取和编辑当前账号会话所属创作范围的要求清单与设定库。"""
from contextlib import closing
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hermes_cli.plugins import get_plugin_manager
from hermes_cli.web_routers.config_env import _config_profile_scope
from hermes_constants import get_hermes_home
from hermes_state import SessionDB


router = APIRouter()
_SESSION = r'^[A-Za-z0-9_-]{1,128}$'
_PROJECT = r'^[A-Za-z0-9_-]{1,64}$'


class Snapshot(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_id: str = Field(pattern=_SESSION)
    project_id: Optional[str] = Field(default=None, pattern=_PROJECT)
    standalone: bool = False


class Edit(Snapshot):
    target: Literal['requirement', 'bible']
    action: Literal['add', 'update', 'cancel', 'restore', 'pin', 'unpin', 'lasting', 'local', 'retire', 'revert', 'history', 'confirm', 'reject']
    data: dict[str, Any]


def _plugin(session_id):
    database = get_hermes_home() / 'state.db'
    if not database.is_file():
        raise HTTPException(404, '对话不存在。')
    with closing(SessionDB(database, read_only=True)) as db:
        if db.get_session(session_id) is None:
            raise HTTPException(404, '对话不存在。')
    manager = get_plugin_manager()
    manager.discover_and_load()
    loaded = manager._plugins.get('jubao-drama')
    if not loaded or not loaded.enabled or loaded.error or loaded.module is None:
        raise HTTPException(503, '创作资料能力尚未就绪。')
    return loaded.module


def _project(body):
    # standalone=true 表示会话不在任何项目中（“最近”），与未声明（保留原绑定）区分。
    return '' if body.standalone else body.project_id


@router.post('/api/studio/creative-memory')
def snapshot(body: Snapshot, profile: str):
    with _config_profile_scope(profile):
        return _plugin(body.session_id).creative_memory_snapshot(body.session_id, _project(body))


@router.post('/api/studio/creative-memory/edit')
def edit(body: Edit, profile: str):
    with _config_profile_scope(profile):
        module = _plugin(body.session_id)
        try:
            return module.creative_memory_edit(body.session_id, body.target, body.action, body.data, _project(body))
        except (ValueError, PermissionError) as exc:
            raise HTTPException(400, str(exc)) from None
