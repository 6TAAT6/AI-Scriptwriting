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
_PLUGIN_SOURCE = Path(__file__).resolve().parents[3] / "extensions" / "jubao-drama"
_PLUGIN_FILES = (
    "__init__.py", "agent_profiles.py", "agent_documents.py", "agent_document_reading.py", "agent_document_delegation.py", "document_evidence.py", "agent_delivery.py", "document_execution_control.py", "document_execution_evidence.py", "material_pages.py", "capability_selection.py", "capabilities.json", "skill-source-manifest.json", "security.py", "workflow.py", "documents.py", "approvals.py", "images.py", "plugin.yaml",
    "vendor/drama-agent-v3/runtime/guards.py",
    "vendor/drama-agent-v3/rules/RULES.md", "vendor/drama-agent-v3/rules/MODULES.md",
    "vendor/drama-agent-v3/prompts/ALL_IN_ONE.md", "vendor/drama-agent-v3/prompts/00_system.md",
    "vendor/drama-agent-v3/prompts/01_M0_入口路由.md", "vendor/drama-agent-v3/prompts/02_M1_原剧分析.md",
    "vendor/drama-agent-v3/prompts/03_M2A_替换方案.md", "vendor/drama-agent-v3/prompts/04_M2B_事件与新纲.md",
    "vendor/drama-agent-v3/prompts/05_M3_正文创作.md", "vendor/drama-agent-v3/prompts/06_M4_独立审核.md",
    "vendor/drama-agent-v3/prompts/07_M5_阶段导出.md", "vendor/drama-agent-v3/prompts/90_batch_controller.md",
)


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
    return {
        "model": {"provider": _PROVIDER, "default": inference["model"], "base_url": inference["base_url"],
                  "api_mode": inference["api_mode"]},
        "providers": providers,
        "fallback_providers": [], "auxiliary": auxiliary,
        "image_gen": {"provider": "openai", "openai": {"provider": image_provider, "model": image_model}, "studio_endpoints": image_endpoints},
        "studio_security": {"restricted": True, "require_agent_invocation": True},
        "platform_toolsets": {platform: list(toolsets) for platform in ("cli", "web", "tui", "desktop")},
        "toolsets": list(toolsets),
        "tools": {"tool_search": {"enabled": "off"}},
        "agent": {"disabled_toolsets": list(_DENIED_TOOLSETS), "coding_context": "off",
                  "reasoning_overrides": {name: detail['default_reasoning_effort'] for source in [inference, *inference.get('providers', [])] for name, detail in source.get('model_metadata', {}).items() if detail.get('default_reasoning_effort')},
                  "environment_probe": False, "bot_mode_protocol": False},
        "delegation": {"max_spawn_depth": 1, "max_concurrent_children": 2,
                       "orchestrator_enabled": False, "subagent_auto_approve": False,
                       "inherit_mcp_toolsets": False, "worktree_isolation": False,
                       "fallback_providers": []},
        "terminal": {"backend": "local", "cwd": str(home / "workspace")},
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
        staging = Path(tempfile.mkdtemp(prefix=".capabilities-", dir=home.parent))
        try:
            for index, (relative, _) in enumerate(files):
                source = _PLUGIN_SOURCE / relative
                if source.is_symlink() or not source.is_file():
                    raise ValueError("创作能力文件缺失或不可信")
                target = staging / str(index)
                shutil.copyfile(source, target)
                target.chmod(0o600)
            for index, (_, relative) in enumerate(files):
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
        finally:
            shutil.rmtree(staging)


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
