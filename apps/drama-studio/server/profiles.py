"""创建仅连接账号模型代理的独立创作运行目录，不继承运营账号的凭证或插件。"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
from urllib.parse import urlsplit


_PROVIDER = "studio-inference"
_TOKEN_ENV = "STUDIO_INFERENCE_TOKEN"
# 所有创作账号共用：最多一次首次补审与一次集中修改，不能反复强制续写。
_MAX_VERIFY_NUDGES = 2
_PLUGIN_SOURCE = Path(__file__).resolve().parents[3] / "extensions" / "jubao-drama"
_PLUGIN_FILES = (
    "plain_documents.py",
    "requirement_checks.py", "requirement_control.py", "requirement_review.py", "requirement_policy.py",
    "requirement_delivery.py", "requirement_turn_delivery.py", "requirement_revision.py", "requirement_workflow.py", "task_requirement_extract.py",
    "delivery_authorization.py", "continuation_context.py",
    "creative_scope.py", "ledger.py", "story_bible.py", "bible_approvals.py", "capsule.py", "context_hygiene.py",
    "creative_tools.py", "project_view.py", "tool_scope.py", "bible_suggest.py", "progress.py", "reply_text.py", "market.py", "length_rules.py", "memory/__init__.py", "memory/base.py", "memory/sqlite_store.py",
    "material_cells.py", "document_parameters.py", "document_read_response.py", "manuscript_text.py",
    "__init__.py", "agent_profiles.py", "child_readonly.py", "creative_delegation.py", "agent_documents.py", "agent_document_reading.py", "agent_document_delegation.py", "document_evidence.py", "agent_delivery.py", "document_execution_control.py", "document_execution_evidence.py", "material_pages.py", "capability_selection.py", "capabilities.json", "skill-source-manifest.json", "security.py", "workflow.py", "documents.py", "approvals.py", "images.py", "plugin.yaml",
    "vendor/drama-agent-v3/runtime/guards.py",
    "vendor/drama-agent-v3/rules/RULES.md", "vendor/drama-agent-v3/rules/MODULES.md",
    "vendor/drama-agent-v3/prompts/ALL_IN_ONE.md", "vendor/drama-agent-v3/prompts/00_system.md",
    "vendor/drama-agent-v3/prompts/01_M0_入口路由.md", "vendor/drama-agent-v3/prompts/02_M1_原剧分析.md",
    "vendor/drama-agent-v3/prompts/03_M2A_替换方案.md", "vendor/drama-agent-v3/prompts/04_M2B_事件与新纲.md",
    "vendor/drama-agent-v3/prompts/05_M3_正文创作.md", "vendor/drama-agent-v3/prompts/06_M4_独立审核.md",
    "vendor/drama-agent-v3/prompts/07_M5_阶段导出.md", "vendor/drama-agent-v3/prompts/90_batch_controller.md",
)


# 已从分发中移除的文件：同步时从工作区删除，避免旧模块被误导入、旧的整份参考文档仍出现在技能文件列表里。
_RETIRED_FILES = (
    "task_requirements.py", "memory/openviking_store.py",
    *(f"skills/jubao-agent-gm3-1/references/{name}.md" for name in (
        "writing", "framework", "doctor", "writing-craft-library", "pattern-library", "lines-library",
        "martial-arts-library", "sound-design-library")),
)


def _remove_retired(plugin_root: Path) -> None:
    for relative in _RETIRED_FILES:
        path = plugin_root / relative
        if path.is_file() and not path.is_symlink():
            path.unlink()


def _plugin_files():
    """只分发业务目录中已登记的规则，独立技能与主 Agent 使用同一白名单。"""
    skill_files = []
    catalog = json.loads((_PLUGIN_SOURCE / "capabilities.json").read_text(encoding="utf-8"))
    for entry in catalog:
        name = entry["skill"]
        if not re.fullmatch(r"jubao-(?:agent|skill)-[a-z0-9-]+", name):
            raise ValueError("创作技能名称不可信")
        directory = _PLUGIN_SOURCE / "skills" / name
        if not directory.is_dir() or directory.is_symlink():
            raise ValueError("剧本 Agent skill 目录不可信")
        skill_files.extend(
            path.relative_to(_PLUGIN_SOURCE)
            for path in sorted(directory.rglob("*"))
            if path.is_file() and not path.is_symlink()
        )
    return (*_PLUGIN_FILES, *skill_files)
# 百万级窗口按默认比例要到约 50 万 token 才压缩，模型实际读到的历史远超可靠范围。创作账号在约 16 万
# token 时压缩并提前裁剪旧工具结果；被压缩掉的要求与设定由创作胶囊每轮补回。
_COMPRESSION = {"threshold_tokens": 160000, "proactive_prune_tokens": 64000, "min_tail_user_messages": 3}
# 正式版 80 次真实压缩中位耗时 234 秒，摘要多由 gpt-6.1-sol 生成；同一摘要输入实测 gemini-3.8-flash
# 22–28 秒、gpt-6.1-sol 37–71 秒，且前者是主力创作模型（近 7 天 49% 调用）。有该模型时用它生成摘要。
_SUMMARY_MODEL = "gemini-3.8-flash-high"
# 压缩策略指定的模型调用失败（超时、断连、限流、中转站报错）时，在同一接入上改用的备用模型。2026-11-23 用同一份约 5 万 token
# 对话各压缩 3 次：gpt-6-astra 3/3、gpt-6.2-sol 3/3（87–112 秒）、gpt-6.2-astra 2/3（1 次断连）；正式近一周 gpt-6.2-sol 失败率 0.4%。
# 只用策略指定的接入，不会退回旧压缩服务；接入未授权该模型时不加备用。
_SUMMARY_FALLBACK_MODEL = "gpt-6.2-sol"


def _summary_policy(home):
    """策略仅保存模型与服务标识；连接和凭据始终从账号当前授权配置取得。"""
    path = Path(home).parent.parent / 'studio' / 'compression-policy.json'
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, 'r', encoding='utf-8') as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096):
            raise ValueError('压缩服务策略文件不可信')
        value = json.loads(handle.read(4097))
    if not isinstance(value, dict):
        raise ValueError('压缩服务策略格式不正确')
    if value.get('version') == 1:
        if (set(value) != {'version', 'provider', 'model'} or value.get('model') != _SUMMARY_MODEL
                or not isinstance(value.get('provider'), str)
                or not re.fullmatch(r'studio-model-[a-f0-9]{16}', value['provider'])):
            raise ValueError('压缩服务策略格式不正确')
        return None if Path(home).parent.name == 'profiles' else value['provider']
    if (value.get('version') != 2
            or set(value) != {'version', 'provider', 'operator_provider', 'model', 'replace_model'}
            or value.get('model') != 'gpt-6-astra' or value.get('replace_model') != _SUMMARY_MODEL
            or value.get('provider') != _PROVIDER
            or not isinstance(value.get('operator_provider'), str)
            or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', value['operator_provider'])):
        raise ValueError('压缩服务策略格式不正确')
    if Path(home).parent.name == 'profiles':
        value = {**value, 'provider': value['operator_provider']}
    return value


def _summary_route(config, preferred_provider=None, current_provider=None, current_model=None):
    """在账号已接入的服务中找到摘要模型，原压缩路由保留为备用；找不到时返回 None。"""
    current = (config.get("auxiliary") or {}).get("compression") or {}
    summary_model = _SUMMARY_MODEL
    if isinstance(preferred_provider, dict):
        previous_model = current.get('model') if current_model is None else current_model
        if previous_model and previous_model not in (preferred_provider['replace_model'], preferred_provider['model']):
            return None
        summary_model = preferred_provider['model']
        preferred_provider = preferred_provider['provider']
    providers = config.get('providers') or {}
    preference = preferred_provider or current_provider or current.get('provider')
    ordered = list(providers)
    if preference in providers and summary_model in (providers[preference].get('models') or {}):
        ordered = [preference]
    elif preferred_provider:
        raise ValueError('首选压缩服务未在当前账号代理中获准，不能回退到旧服务')
    for identifier in ordered:
        entry = providers[identifier]
        models = entry.get("models") or {}
        if summary_model not in (models if isinstance(models, (dict, list)) else []):
            continue
        fallback = {key: value for key, value in current.items() if key != "fallback_chain"} if current.get("model") else None
        connection = {"base_url": entry.get("base_url"), "key_env": entry.get("key_env"),
                      "api_mode": entry.get("transport") or entry.get("api_mode")}
        backup = ([{"provider": identifier, "model": _SUMMARY_FALLBACK_MODEL, **connection,
                    "timeout": 600, "no_progress_timeout": 180, "reasoning_effort": "low"}]
                  if summary_model != _SUMMARY_FALLBACK_MODEL and _SUMMARY_FALLBACK_MODEL in models else [])
        route = {"provider": identifier, "model": summary_model, **connection,
                 "fallback_chain": backup if preferred_provider else [fallback] if fallback and fallback.get("model") != summary_model else
                                   list(current.get("fallback_chain") or []),
                 "timeout": 600, "no_progress_timeout": 180, "reasoning_effort": "low"}
        if preferred_provider or current.get('allow_main_model_fallback') is False:
            route['allow_main_model_fallback'] = False
        return route if all(route[key] for key in ("base_url", "key_env", "api_mode")) else None
    return None


def _existing_summary_preference(home):
    """仅沿用服务与禁止隐式回退的选择；旧scope和凭据不进入新配置。"""
    try:
        descriptor = os.open(Path(home)/'config.yaml', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return {}
    from utils import fast_safe_load
    with os.fdopen(descriptor, 'r', encoding='utf-8') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 131072:
            raise ValueError('既有压缩服务配置不可信')
        config = fast_safe_load(handle.read(131073)) or {}
    route = (config.get('auxiliary') or {}).get('compression') or {}
    value = route.get('provider')
    return {**({'provider': value} if isinstance(value, str) else {}),
            **({'model': route['model']} if isinstance(route.get('model'), str) else {}),
            **({'allow_main_model_fallback': False} if route.get('allow_main_model_fallback') is False else {})}
_DENIED_TOOLSETS = [
    "terminal", "file", "code_execution", "browser", "web", "search",
    "cronjob", "messaging", "project", "desktop_ui", "computer_use",
    "vision", "video", "video_gen", "tts", "connectors", "kanban", "moa",
]


def _inference_route(value):
    required = {"base_url", "token", "model", "models", "api_mode"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - {"providers", "image_models", "image_model", "model_metadata"}:
        raise ValueError("账号创建需要完整的受限模型代理配置")
    endpoint = value["base_url"]
    if not isinstance(endpoint, str):
        raise ValueError("模型代理地址无效")
    parsed = urlsplit(endpoint)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not re.fullmatch(r"/(?:scope/[A-Za-z0-9_-]{32}/)?v1", parsed.path)):
        raise ValueError("模型代理必须使用独立的本机回环服务")
    if not isinstance(value["token"], str) or not re.fullmatch(r"[A-Za-z0-9._~-]{24,512}", value["token"]):
        raise ValueError("模型代理凭证格式不正确")
    models = value["models"]
    if (not isinstance(models, list) or not 1 <= len(models) <= 100
            or any(not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}", model)
                   for model in models)
            or value["model"] not in models or len(set(models)) != len(models)):
        raise ValueError("模型代理允许列表不正确")
    modes = {"chat_completions": "chat_completions", "responses": "codex_responses", "codex_responses": "codex_responses"}
    if not isinstance(value["api_mode"], str) or value["api_mode"] not in modes:
        raise ValueError("模型代理接口类型不支持")
    providers = value.get("providers", [])
    image_models = value.get("image_models", [])
    image_model = value.get("image_model", "")
    if (not isinstance(image_models, list) or len(image_models) > 30
            or any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}", item) for item in image_models)
            or image_model and image_model not in image_models):
        raise ValueError("图片模型配置无效")
    if not isinstance(providers, list) or len(providers) > 30:
        raise ValueError("模型接入列表无效")
    metadata = value.get('model_metadata', {})
    if not isinstance(metadata, dict) or any(name not in models for name in metadata):
        raise ValueError('模型能力必须属于当前允许列表')
    efforts = {'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}
    for entry in metadata.values():
        if not isinstance(entry, dict) or set(entry) - {'context_length', 'supported_efforts', 'default_reasoning_effort'}:
            raise ValueError('模型能力字段无效')
        if 'context_length' in entry and (type(entry['context_length']) is not int or entry['context_length'] <= 0):
            raise ValueError('模型上下文配置无效')
        levels = entry.get('supported_efforts', [])
        if not isinstance(levels, list) or any(not isinstance(level, str) or level not in efforts for level in levels):
            raise ValueError('模型思考档位无效')
        if 'default_reasoning_effort' in entry and entry['default_reasoning_effort'] not in levels:
            raise ValueError('默认思考档位不受支持')
    accepted, seen = [], set()
    for entry in providers:
        if not isinstance(entry, dict) or not required | {"id", "name"} <= set(entry) or set(entry) - required - {"id", "name", "image_models", "image_model", "model_metadata"}:
            raise ValueError("模型接入配置无效")
        identifier, name = entry["id"], entry["name"]
        if (not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", identifier)
                or identifier in seen or not isinstance(name, str) or not 1 <= len(name) <= 80):
            raise ValueError("模型接入名称无效")
        seen.add(identifier)
        route = _inference_route({key: entry[key] for key in required | {"image_models", "image_model", "model_metadata"} if key in entry})
        if urlsplit(route["base_url"]).netloc != parsed.netloc or route["token"] != value["token"]:
            raise ValueError("多个模型接入必须共用当前账号的受限代理")
        accepted.append({"id": identifier, "name": name, **route})
    return {**value, "models": list(models), "api_mode": modes[value["api_mode"]], "providers": accepted}


# 剧本插件的后台任务（要求核验、要求提取、设定与末态整理）默认用本轮会话的模型；员工选的模型连接
# 在回合结束后释放，回合后执行的审稿与整理会报“main provider unavailable”（重放中约两成失败，审稿全部落空）。
# 给这些任务配上账号默认模型作为后备，先用会话模型，不可用时改用账号默认模型。
_PLUGIN_AUX_TASKS = ("jubao_drama_review", "jubao_requirement_review", "jubao_requirement_extract",
                     "jubao_bible_suggest", "jubao_timeline")


def _plugin_aux(config):
    model = config.get("model") if isinstance(config.get("model"), dict) else {}
    if model.get("provider") != _PROVIDER or not model.get("default") or not model.get("base_url"):
        return {}
    route = {"provider": _PROVIDER, "model": model["default"], "base_url": model["base_url"],
             "key_env": _TOKEN_ENV, "api_mode": model.get("api_mode")}
    return {task: {"provider": "auto", "fallback_chain": [dict(route)]} for task in _PLUGIN_AUX_TASKS}


def _config(home, inference):
    from hermes_cli.config import DEFAULT_CONFIG

    route = {"provider": _PROVIDER, "model": inference["model"], "base_url": inference["base_url"],
             "key_env": _TOKEN_ENV, "api_mode": inference["api_mode"], "fallback_chain": []}
    auxiliary = {name: dict(route) for name, default in DEFAULT_CONFIG["auxiliary"].items()
                 if isinstance(default, dict) and "provider" in default}
    auxiliary["background_review"]["enabled"] = False
    auxiliary["title_generation"].update(language="简体中文", prefer_fast_model=False)
    # 压缩独立使用账号内已批准的模型及当前代理凭据，重建进程后不会沿用旧连接。
    summary_model = 'gpt-6.1-sol' if 'gpt-6.1-sol' in inference['models'] else inference['model']
    auxiliary['compression'].update(model=summary_model, timeout=600, no_progress_timeout=180,
                                    reasoning_effort='low')
    fallback = next((model for model in inference['models'] if model != summary_model), None)
    if fallback:
        auxiliary['compression']['fallback_chain'] = [{**route, 'model': fallback, 'timeout': 600}]
    providers = {_PROVIDER: {"base_url": inference["base_url"], "key_env": _TOKEN_ENV,
                             "transport": inference["api_mode"], "models": {name: inference['model_metadata'].get(name, {}) for name in inference['models']} if inference.get('model_metadata') else inference['models'],
                             "discover_models": False}}
    image_provider = _PROVIDER if inference.get("image_model") else ""
    image_model = inference.get("image_model", "")
    image_endpoints = {_PROVIDER: {"model": image_model, "models": inference.get("image_models", [])}}
    for entry in inference.get("providers", []):
        identifier = "studio-model-" + hashlib.sha256(entry["id"].encode()).hexdigest()[:16]
        providers[identifier] = {"name": entry["name"], "base_url": entry["base_url"], "key_env": _TOKEN_ENV,
                                 "transport": entry["api_mode"], "models": {name: entry['model_metadata'].get(name, {}) for name in entry['models']} if entry.get('model_metadata') else entry['models'], "discover_models": False}
        image_endpoints[identifier] = {"model": entry.get("image_model", ""), "models": entry.get("image_models", [])}
        if not image_model and entry.get("image_model"):
            image_provider, image_model = identifier, entry["image_model"]
    toolsets = ["jubao_drama", "skills", "todo", "memory", "session_search", "clarify", "delegation", "no_mcp", *(["image_gen"] if image_model else [])]
    config = {
        "model": {"provider": _PROVIDER, "default": inference["model"], "base_url": inference["base_url"],
                  "api_mode": inference["api_mode"]},
        "model_catalog": {"enabled": False},
        "providers": providers,
        "fallback_providers": [], "auxiliary": auxiliary,
        "image_gen": {"provider": "openai", "openai": {"provider": image_provider, "model": image_model}, "studio_endpoints": image_endpoints},
        "studio_security": {"restricted": True, "require_agent_invocation": True},
        "platform_toolsets": {platform: list(toolsets) for platform in ("cli", "web", "tui", "desktop")},
        "toolsets": list(toolsets),
        "tools": {"tool_search": {"enabled": "off"}},
        "agent": {"disabled_toolsets": list(_DENIED_TOOLSETS), "coding_context": "off", "max_verify_nudges": _MAX_VERIFY_NUDGES,
                  "reasoning_overrides": {name: detail['default_reasoning_effort'] for source in [inference, *inference.get('providers', [])] for name, detail in source.get('model_metadata', {}).items() if detail.get('default_reasoning_effort')},
                  "environment_probe": False, "bot_mode_protocol": False},
        "delegation": {"max_spawn_depth": 1, "max_concurrent_children": 2,
                       "orchestrator_enabled": False, "subagent_auto_approve": False,
                       "inherit_mcp_toolsets": False, "worktree_isolation": False,
                       "fallback_providers": []},
        "terminal": {"backend": "local", "cwd": str(home / "workspace")},
        "compression": dict(_COMPRESSION),
        "attachments": {"storage": "hermes-home"},
        "plugins": {"enabled": ["jubao-drama"], "entries": {"jubao-drama": {"llm": {
            "allow_provider_override": False, "allow_model_override": False,
            "allow_profile_override": False, "allow_agent_id_override": False, "allow_task_override": False}}}},
        "skills": {"project_discovery": False, "auto_load": [], "inline_shell": False},
        # Employee/admin worker profiles use the same Hermes built-in memory surface as the main
        # profile.  The profile home and state.db remain isolated, so enabling memory here does not
        # grant access to another account's notes or conversation history.
        "memory": {"memory_enabled": True, "user_profile_enabled": True, "provider": ""},
        "onboarding": {"profile_build": "off"},
        "curator": {"enabled": False}, "approvals": {"mode": "manual"},
        "display": {"language": "zh", "show_reasoning": False},
    }
    preference = _existing_summary_preference(home)
    route = _summary_route(config, preferred_provider=_summary_policy(home),
                           current_provider=preference.get('provider'), current_model=preference.get('model', ''))
    if route:
        if preference.get('allow_main_model_fallback') is False:
            route['allow_main_model_fallback'] = False
        config["auxiliary"]["compression"] = route
    config["auxiliary"].update(_plugin_aux(config))
    return config


def _worker_home(name, workers_root):
    if not isinstance(name, str) or not re.fullmatch(r"studio-[a-f0-9]{20}", name):
        raise ValueError("账号工作区标识不正确")
    from hermes_constants import get_default_hermes_root
    root = Path(workers_root) if workers_root is not None else get_default_hermes_root() / "studio-workers"
    if not root.is_absolute() or root.is_symlink():
        raise ValueError("创作运行目录不正确")
    return root / name


def _write_proxy_token(home, token):
    descriptor, temporary = tempfile.mkstemp(prefix=".proxy-", dir=home)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(_TOKEN_ENV + "=" + token + "\n")
        os.replace(temporary, home / ".env")
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def _directory_fd(path):
    """从根逐级打开目录，父目录链接也不能把运营进程引向别处。"""
    if not path.is_absolute() or ".." in path.parts or not hasattr(os, "O_NOFOLLOW"):
        raise ValueError("创作目录无法安全访问")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(path.anchor, flags)
    try:
        for component in path.parts[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


def _file_identity(directory, filename):
    info = os.stat(filename, dir_fd=directory, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("创作配置必须是独立普通文件，不能是链接")
    return info.st_dev, info.st_ino


def _read_restricted_marker(directory):
    from utils import fast_safe_load

    identities = {name: _file_identity(directory, name) for name in ("config.yaml", ".env")}
    descriptor = os.open("config.yaml", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_dev, info.st_ino) != identities["config.yaml"]:
            raise ValueError("创作配置已经变化，无法轮换")
        text = handle.read(131073)
    if len(text) > 131072:
        raise ValueError("创作配置超出允许范围")
    existing = fast_safe_load(text)
    security = existing.get("studio_security") if isinstance(existing, dict) else None
    if not isinstance(security, dict) or security.get("restricted") is not True:
        raise ValueError("不能为未受限账号配置创作代理")
    return identities


def _assert_home_binding(home, parent_fd, home_fd):
    with _directory_fd(home.parent) as current:
        before, after = os.fstat(parent_fd), os.fstat(current)
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise ValueError("创作目录父级已经变化")
    current = os.stat(home.name, dir_fd=parent_fd, follow_symlinks=False)
    bound = os.fstat(home_fd)
    if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (bound.st_dev, bound.st_ino):
        raise ValueError("账号创作目录已经变化")


def provision(name: str, inference=None, workers_root=None) -> dict:
    inference = _inference_route(inference)
    from hermes_cli.config import atomic_config_replace

    home = _worker_home(name, workers_root)
    root = home.parent
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = root.resolve(strict=True)
    home = root / name
    if home.exists() or home.is_symlink():
        raise FileExistsError("账号创作运行目录已存在，不能覆盖")
    staging = Path(tempfile.mkdtemp(prefix=".creating-", dir=root))
    try:
        for folder in ("workspace", "attachments", "skills", "plugins"):
            (staging / folder).mkdir(mode=0o700)
        atomic_config_replace(staging / "config.yaml", _config(home, inference))
        (staging / "config.yaml").chmod(0o600)
        _write_proxy_token(staging, inference["token"])
        # 仅复制本仓库审读过的代码与固定规则；源运营账号的任何安装目录都不读取。
        for relative in _plugin_files():
            source = _PLUGIN_SOURCE / relative
            if source.is_symlink() or not source.is_file():
                raise ValueError("创作能力文件缺失或不可信")
            target = staging / "plugins" / "jubao-drama" / relative
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o600)
        shutil.copyfile(_PLUGIN_SOURCE / "SOUL.md", staging / "SOUL.md")
        (staging / "SOUL.md").chmod(0o600)
        from hermes_cli.profiles import NO_BUNDLED_SKILLS_MARKER
        (staging / NO_BUNDLED_SKILLS_MARKER).write_text("创作账号不启用通用技能。\n", encoding="utf-8")
        os.rename(staging, home)
    except BaseException:
        shutil.rmtree(staging)
        raise
    return {"profile": name, "name": name, "home": str(home)}


def refresh_inference(name: str, inference, workers_root=None) -> dict:
    """刷新账号模型连接，保留稿件与状态；已有代理凭证不变时无需重启进程。"""
    inference = _inference_route(inference)
    home = _worker_home(name, workers_root)
    from hermes_cli.config import atomic_config_replace

    with _directory_fd(home.parent) as parent_fd, _directory_fd(home) as home_fd:
        _assert_home_binding(home, parent_fd, home_fd)
        identities = _read_restricted_marker(home_fd)
        # canonical writer 会保留既有链接，因此只让它操作员工无权写入的全新父级临时目录。
        # 员工配置不是产品内的可编辑资料；重建固定配置，不能继承未知命令、插件或环境字段。
        staging = Path(tempfile.mkdtemp(prefix=".refresh-", dir=home.parent))
        try:
            atomic_config_replace(staging / "config.yaml", _config(home, inference))
            (staging / "config.yaml").chmod(0o600)
            _write_proxy_token(staging, inference["token"])
            _assert_home_binding(home, parent_fd, home_fd)
            for filename, identity in identities.items():
                if _file_identity(home_fd, filename) != identity:
                    raise ValueError("创作配置已经变化，无法轮换")
            # renameat 不跟随目标链接；目录描述符将发布位置绑定到已验证的账号目录。
            for filename in ("config.yaml", ".env"):
                os.replace(staging / filename, filename, dst_dir_fd=home_fd)
            _assert_home_binding(home, parent_fd, home_fd)
            for filename in identities:
                _file_identity(home_fd, filename)
        finally:
            shutil.rmtree(staging)
    return {"profile": name, "name": name, "home": str(home)}


def _capability_matches(home, relative, source):
    """从已验证目录读取目标，不能用内容相同绕过链接或权限检查。"""
    expected = source.read_bytes()
    try:
        with _directory_fd(home / relative.parent) as directory:
            identity = _file_identity(directory, relative.name)
            descriptor = os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(descriptor, "rb") as handle:
                info = os.fstat(handle.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                        or (info.st_dev, info.st_ino) != identity):
                    raise ValueError("创作能力文件已经变化，无法同步")
                matches = stat.S_IMODE(info.st_mode) == 0o600 and handle.read(len(expected) + 1) == expected
            if _file_identity(directory, relative.name) != identity:
                raise ValueError("创作能力文件已经变化，无法同步")
            return matches
    except FileNotFoundError:
        return False


def sync_worker_capabilities(home) -> None:
    """仅在工作进程启动前更新受控能力文件；热更新模型配置不得调用此入口。"""
    home = Path(home)
    if _worker_home(home.name, home.parent) != home:
        raise ValueError("账号创作目录无效")
    files = [(relative, Path("plugins/jubao-drama") / relative) for relative in _plugin_files()]
    files.append(("SOUL.md", Path("SOUL.md")))
    with _directory_fd(home.parent) as parent_fd, _directory_fd(home) as home_fd:
        _assert_home_binding(home, parent_fd, home_fd)
        _read_restricted_marker(home_fd)
        changes = []
        # 先校验全部源文件和目标边界；后续文件不可信时，不得先更新前面的文件。
        for relative, target in files:
            source = _PLUGIN_SOURCE / relative
            if source.is_symlink() or not source.is_file():
                raise ValueError("创作能力文件缺失或不可信")
            if not _capability_matches(home, target, source):
                changes.append((relative, target))
        staging = Path(tempfile.mkdtemp(prefix=".capabilities-", dir=home.parent))
        try:
            for index, (relative, _) in enumerate(changes):
                source = _PLUGIN_SOURCE / relative
                if source.is_symlink() or not source.is_file():
                    raise ValueError("创作能力文件缺失或不可信")
                target = staging / str(index)
                shutil.copyfile(source, target)
                target.chmod(0o600)
            for index, (_, relative) in enumerate(changes):
                _assert_home_binding(home, parent_fd, home_fd)
                (home / relative.parent).mkdir(mode=0o700, parents=True, exist_ok=True)
                with _directory_fd(home / relative.parent) as directory:
                    try:
                        _file_identity(directory, relative.name)
                    except FileNotFoundError:
                        pass
                    os.replace(staging / str(index), relative.name, dst_dir_fd=directory)
                    _file_identity(directory, relative.name)
            _assert_home_binding(home, parent_fd, home_fd)
            _remove_retired(home / "plugins" / "jubao-drama")
            _sync_compression(home, home_fd, staging)
        finally:
            shutil.rmtree(staging)


def sync_operator_capabilities(hermes_home) -> list[str]:
    """主后端启动前，把运营 profile 中已安装的业务插件对齐到当前发布代码。

    员工工作区每次启动都会同步能力文件，运营 profile（超级管理员沿用的 jubao-drama）此前只靠发布
    脚本拷贝，曾漏掉 vendor 下的守卫模块导致整个插件加载失败。这里只覆盖白名单文件、删除已退役文件，
    配置只对齐压缩策略、摘要模型与工具检索开关（与员工工作区一致），不改写 profile 自己的 SOUL 与其他配置。
    """
    root = Path(hermes_home)
    candidates = [root / "plugins" / "jubao-drama", *sorted((root / "profiles").glob("*/plugins/jubao-drama"))]
    synced = []
    for target in candidates:
        if target.is_symlink() or not target.is_dir():
            continue
        for relative in _plugin_files():
            source = _PLUGIN_SOURCE / relative
            if source.is_symlink() or not source.is_file():
                raise ValueError("创作能力文件缺失或不可信")
            destination = target / relative
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if destination.is_file() and not destination.is_symlink() and destination.read_bytes() == source.read_bytes():
                continue
            handle, temporary = tempfile.mkstemp(prefix=".sync-", dir=destination.parent)
            with os.fdopen(handle, "wb") as stream:
                stream.write(source.read_bytes())
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
        _remove_retired(target)
        _align_operator_config(target.parents[1])
        synced.append(str(target))
    return synced


# 员工工作区关闭了 Hermes 的工具检索；运营 profile 未关闭时，剧本工具被藏在 tool_describe/tool_call
# 中转之后，每次调用多一到两轮往返，中转还会丢参数（实测 drama_agent_document 缺 action 报错）。
_TOOL_SEARCH = {"enabled": "off"}


def _align_operator_config(profile_home: Path) -> None:
    import hermes_yaml as yaml
    from hermes_cli.config import atomic_config_replace

    path = profile_home / "config.yaml"
    if path.is_symlink() or not path.is_file():
        return
    config = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(config, dict):
        return
    route = _summary_route(config, preferred_provider=_summary_policy(profile_home))
    current = (config.get("auxiliary") or {}).get("compression") or {}
    summary_aligned = route is None or current == route
    tools = config.get("tools") if isinstance(config.get("tools"), dict) else {}
    search_aligned = (tools.get("tool_search") or {}) == _TOOL_SEARCH
    # 与员工工作区一致关闭 Hermes 的自我改进回顾与技能整理：后台审阅会在超级管理员的技能库里自行新建、修补技能
    # （如“cross-cultural-script-adaptation”），之后每个对话都会读到这些未经审核的规则，界面还反复显示“自我改进回顾”。
    review = ((config.get("auxiliary") or {}).get("background_review") or {})
    reflection_aligned = review.get("enabled") is False and (config.get("curator") or {}).get("enabled") is False
    verify_aligned = (config.get("agent") or {}).get("max_verify_nudges") == _MAX_VERIFY_NUDGES
    if config.get("compression") == _COMPRESSION and summary_aligned and search_aligned and reflection_aligned and verify_aligned:
        return
    config.setdefault("auxiliary", {}).setdefault("background_review", {})["enabled"] = False
    config["curator"] = {**(config.get("curator") or {}), "enabled": False}
    config["compression"] = dict(_COMPRESSION)
    config.setdefault("agent", {})["max_verify_nudges"] = _MAX_VERIFY_NUDGES
    if not summary_aligned:
        config.setdefault("auxiliary", {})["compression"] = route
    config["tools"] = {**tools, "tool_search": dict(_TOOL_SEARCH)}
    staging = Path(tempfile.mkdtemp(prefix=".operator-config-", dir=profile_home))
    try:
        atomic_config_replace(staging / "config.yaml", config)
        (staging / "config.yaml").chmod(0o600)
        os.replace(staging / "config.yaml", path)
    finally:
        shutil.rmtree(staging)


def _sync_compression(home, home_fd, staging):
    """已有账号的固定配置在创建时生成；启动前只把压缩策略对齐到当前版本，其余字段原样保留。"""
    import hermes_yaml as yaml
    from hermes_cli.config import atomic_config_replace

    identity = _file_identity(home_fd, "config.yaml")
    descriptor = os.open("config.yaml", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=home_fd)
    with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
        config = yaml.safe_load(handle) or {}
    if not isinstance(config, dict):
        return
    preference = _summary_policy(home)
    route = _summary_route(config, preferred_provider=preference)
    current = (config.get("auxiliary") or {}).get("compression") or {}
    summary_aligned = route is None or all(current.get(key) == value for key, value in route.items())
    plugin_aux = _plugin_aux(config)
    aux_aligned = all((config.get("auxiliary") or {}).get(task) == entry for task, entry in plugin_aux.items())
    verify_aligned = (config.get("agent") or {}).get("max_verify_nudges") == _MAX_VERIFY_NUDGES
    if config.get("compression") == _COMPRESSION and summary_aligned and aux_aligned and verify_aligned:
        return
    config["compression"] = dict(_COMPRESSION)
    config.setdefault("agent", {})["max_verify_nudges"] = _MAX_VERIFY_NUDGES
    if not summary_aligned:
        config.setdefault("auxiliary", {})["compression"] = route
    config.setdefault("auxiliary", {}).update(plugin_aux)
    atomic_config_replace(staging / "config.yaml", config)
    (staging / "config.yaml").chmod(0o600)
    if _file_identity(home_fd, "config.yaml") != identity:
        raise ValueError("创作配置已经变化，无法同步压缩策略")
    os.replace(staging / "config.yaml", "config.yaml", dst_dir_fd=home_fd)


if __name__ == "__main__":
    try:
        payload = sys.stdin.read(65537)
        if len(payload) > 65536:
            raise ValueError("代理配置过长")
        action = refresh_inference if sys.argv[2:] == ["--refresh"] else provision
        if sys.argv[2:] and sys.argv[2:] != ["--refresh"]:
            raise ValueError("未知账号操作")
        print(json.dumps(action(sys.argv[1], inference=json.loads(payload)), ensure_ascii=False))
    except Exception:
        print("人员工作区创建失败。", file=sys.stderr)
        sys.exit(1)
