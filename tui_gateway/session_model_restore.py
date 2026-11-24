"""恢复受限账号历史记录中发生分离的模型与接入身份。"""
from __future__ import annotations


class StudioSessionRouteUnavailable(RuntimeError):
    """历史可继续阅读，但执行前必须明确选择当前账号内的路由。"""

    def __init__(self, model: str, provider: str) -> None:
        super().__init__("历史记录已恢复；原模型已不可用或接入无法唯一确认，请重新选择当前账号可用的模型后继续。")
        self.model = model
        self.provider = provider


def _serves_model(entry: dict, model: str) -> bool:
    models = entry.get("models") if isinstance(entry, dict) else None
    if isinstance(models, dict):
        return model in models
    if isinstance(models, list):
        return any((item.get("id") or item.get("name") if isinstance(item, dict) else item) == model
                   for item in models)
    return False


def reconcile_studio_session_route(row: dict, model: str, route: dict, config: dict) -> dict:
    """只修复已保存接入不能提供目标模型的受限会话；有效选择保持优先。"""
    security = config.get("studio_security")
    providers = config.get("providers")
    if not isinstance(security, dict) or security.get("restricted") is not True or not isinstance(providers, dict):
        return route
    provider = str(route.get("provider") or "").strip().removeprefix("custom:")
    if not model or (provider in providers and _serves_model(providers[provider], model)):
        return route
    billing = str(row.get("billing_provider") or "").strip().removeprefix("custom:")
    if billing in providers and _serves_model(providers[billing], model):
        selected = billing
    else:
        candidates = [name for name, entry in providers.items() if _serves_model(entry, model)]
        if len(candidates) != 1:
            raise StudioSessionRouteUnavailable(model, str(route.get("provider") or ""))
        selected = candidates[0]
    # 历史地址和协议属于旧接入；由当前账号目录重新解析，避免带回上次启动的 scope。
    return {**route, "provider": "custom:" + selected, "base_url": None, "api_mode": None}
