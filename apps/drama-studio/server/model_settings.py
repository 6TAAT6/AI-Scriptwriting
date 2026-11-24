"""工作区完整模型列表的原子保存适配，复用 Hermes 的密钥与配置写入机制。"""

import json
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException
from hermes_cli.web_models import CustomEndpointUpdate
from hermes_cli.web_routers import config_env
from hermes_constants import get_hermes_home
from pydantic import BaseModel, ConfigDict, Field


router = APIRouter()


class StudioEndpointUpdate(CustomEndpointUpdate):
    image_model: str | None = None
    image_models: list[str] | None = None


class StudioEndpointState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    enabled: bool


def compression_operator():
    """压缩策略 v2 的 operator_provider；它被停用时 core 启动会找不到摘要模型而反复重启。"""
    # 与 profiles.py 的 _summary_policy 同一路径：工作区 home 的上两级是 state 目录。
    path = Path(get_hermes_home()).parent.parent / "studio" / "compression-policy.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    return value.get("operator_provider") if isinstance(value, dict) else None


def response(config):
    result = config_env._custom_endpoint_response(config)
    providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
    for row in result.get("endpoints", []):
        entry = (config.get("image_gen") or {}).get("studio_endpoints", {}).get(row["id"], {})
        provider = providers.get(row["id"])
        # 员工配置跳过 enabled: false 的接入；后台必须看到同一状态，否则品牌入口会绑到前台不显示的模型上。
        disabled = isinstance(provider, dict) and provider.get("enabled") is False
        row.update(image_model=entry.get("model", ""), image_models=entry.get("models", []), enabled=not disabled)
    return result


@router.get("/api/studio/model-endpoints")
def get_model_endpoints(profile: str):
    if profile != "jubao-drama":
        raise HTTPException(status_code=403, detail="不能读取其他工作区的模型接入。")
    with config_env._config_profile_scope(profile):
        return response(config_env.load_config())


@router.post("/api/studio/model-endpoints")
def save_model_endpoint(body: StudioEndpointUpdate, profile: str):
    # 此路由仅挂到运营后端，外层 ServiceBoundary 验证边缘服务的私有令牌。
    if profile != "jubao-drama":
        raise HTTPException(status_code=403, detail="不能修改其他工作区的模型接入。")
    if (not body.models or len(body.models) > 100 or body.model not in body.models or body.model_details
            or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}", model) for model in body.models)):
        raise HTTPException(status_code=400, detail="需要包含默认模型的完整模型列表。")
    with config_env._config_profile_scope(profile), config_env._CONFIG_MUTATION_LOCK:
        config = config_env.load_config()
        endpoint_id, entry = config_env._write_custom_endpoint(config, body)
        if body.image_models is not None or body.image_model is not None:
            models = body.image_models or []
            model = body.image_model or ""
            if len(models) > 30 or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}", item) for item in models) or model and model not in models:
                raise HTTPException(status_code=400, detail="图片模型需要包含在图片模型列表中。")
            image_config = config.setdefault("image_gen", {})
            image_config.setdefault("studio_endpoints", {})[endpoint_id] = {"models": list(dict.fromkeys(models)), "model": model}
            if model:
                image_config.update(provider="openai", openai={"provider": endpoint_id, "model": model})
                for platform in ("web", "desktop", "tui"):
                    toolsets = config.setdefault("platform_toolsets", {}).setdefault(platform, ["all"])
                    if "image_gen" not in toolsets:
                        toolsets.append("image_gen")
            elif config.get("image_gen", {}).get("openai", {}).get("provider") == endpoint_id:
                image_config.update(provider="", openai={})
        # 原生表单是追加语义；本工作区编辑的是完整允许列表，保留所选模型的全部元数据。
        entry["models"] = {model: entry["models"][model] for model in dict.fromkeys(body.models)}
        entry["discover_models"] = False
        config_env.save_config(config)
        return {**response(config), "ok": True, "id": endpoint_id}


@router.post("/api/studio/model-endpoints/enabled")
def set_model_endpoint_enabled(body: StudioEndpointState, profile: str):
    # 只切换启用状态：普通保存在原条目上合并字段，会保留这里写入的 enabled。
    if profile != "jubao-drama":
        raise HTTPException(status_code=403, detail="不能修改其他工作区的模型接入。")
    with config_env._config_profile_scope(profile), config_env._CONFIG_MUTATION_LOCK:
        config = config_env.load_config()
        providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}
        entry = providers.get(body.id)
        row = next((item for item in response(config).get("endpoints", []) if item.get("id") == body.id), None)
        if not isinstance(entry, dict) or row is None:
            raise HTTPException(status_code=404, detail="模型接入不存在，请刷新后重试。")
        if body.enabled:
            entry.pop("enabled", None)
        else:
            if row.get("is_current"):
                raise HTTPException(status_code=400, detail="这是默认接入，员工对话和上下文压缩都依赖它，不能停用。")
            if compression_operator() == body.id:
                raise HTTPException(status_code=400, detail="上下文压缩正在使用这个接入，停用后服务无法启动，不能停用。")
            entry["enabled"] = False
        config_env.save_config(config)
        return {**response(config), "ok": True, "id": body.id}
