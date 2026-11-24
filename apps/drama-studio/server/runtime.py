"""仅供工作区边缘服务连接的后端入口。"""

import hmac
import json
import os
import sys
from urllib.parse import parse_qs


class ServiceBoundary:
    def __init__(self, app, token):
        if not isinstance(token, str) or len(token) < 32:
            raise ValueError("必须提供独立的服务访问凭证。")
        self.app = app
        self.token = token.encode("utf-8")

    def authorized(self, scope):
        candidates = []
        for name, value in scope.get("headers", []):
            if name.lower() == b"x-hermes-session-token":
                candidates.append(value)
            elif name.lower() == b"authorization" and value.startswith(b"Bearer "):
                candidates.append(value[7:])
        if scope["type"] == "websocket":
            try:
                values = parse_qs(scope.get("query_string", b"").decode("ascii"), keep_blank_values=True, max_num_fields=20)
            except (ValueError, UnicodeDecodeError):
                return False
            candidates.extend(value.encode("utf-8") for value in values.get("token", []))
        return len(candidates) == 1 and hmac.compare_digest(candidates[0], self.token)

    @staticmethod
    async def response(send, status, content):
        body = json.dumps(content, ensure_ascii=False).encode("utf-8")
        await send({"type": "http.response.start", "status": status, "headers": [
            (b"content-type", b"application/json; charset=utf-8"),
            (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff"),
        ]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] in {"http", "websocket"}:
            if not self.authorized(scope):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await self.response(send, 401, {"error": "服务访问需要授权。"})
                return
            # 包括可信边缘服务在内，根页面都不再提供通用令牌。
            if scope["type"] == "http" and scope.get("path") == "/":
                await self.response(send, 200, {"service": "studio-runtime"})
                return
        await self.app(scope, receive, send)


def configure_app(app, router, token):
    original_routes = len(app.router.routes)
    app.include_router(router)
    # Hermes 已注册页面兜底路由；专用接口必须排在它前面才能接收到 GET 请求。
    app.router.routes[:] = app.router.routes[original_routes:] + app.router.routes[:original_routes]
    app.add_middleware(ServiceBoundary, token=token)


def main():
    token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("工作区服务缺少专用访问凭证，已停止启动。")
    # 标题与主任务会并发首次访问 SDK；先在启动线程完成资源模块导入，避免循环导入锁冲突。
    import importlib
    for module in ("openai.resources.chat.completions", "openai.resources.responses.responses"):
        importlib.import_module(module)
    os.environ["HERMES_SERVE_HEADLESS"] = "1"
    if "--worker-fd" in sys.argv:
        return worker(token)
    from hermes_cli.web_server import app
    from hermes_cli.main import main as run
    from model_settings import router as model_settings_router
    from image_selection import router as image_selection_router
    from session_documents import router as session_documents_router
    from creative_memory import router as creative_memory_router

    configure_app(app, model_settings_router, token)
    original_routes = len(app.router.routes)
    app.include_router(image_selection_router)
    app.include_router(session_documents_router)
    app.include_router(creative_memory_router)
    app.router.routes[:] = app.router.routes[original_routes:] + app.router.routes[:original_routes]
    sys.argv = [sys.argv[0], "serve", *sys.argv[1:]]
    run()


def worker(token):
    import argparse
    import asyncio
    import socket
    import mimetypes
    from pathlib import Path
    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    from hermes_constants import get_hermes_home
    from hermes_cli.profiles import get_profile_dir

    parser = argparse.ArgumentParser()
    parser.add_argument("--worker-fd", type=int, required=True)
    parser.add_argument("--port", type=int, required=True)
    options = parser.parse_args()
    # 使用标准库内置文件类型表，避免读取员工业务无关的系统 Web 服务配置。
    mimetypes.knownfiles = []
    mimetypes.init(files=[])
    home = get_hermes_home().resolve()
    if not home.name.startswith("studio-") or Path.cwd().resolve() != home / "workspace":
        raise RuntimeError("账号运行目录未隔离。")
    if get_profile_dir("default").resolve() != home:
        raise RuntimeError("默认运行目录不属于当前账号。")
    discover_plugins()
    plugin = next((row for row in get_plugin_manager().list_plugins() if row["name"] == "jubao-drama"), None)
    if not plugin or not plugin["enabled"] or plugin["error"] or plugin["tools"] < 8 or plugin["middleware"] < 2:
        raise RuntimeError("账号安全创作能力未完整载入。")
    from hermes_cli.web_server import app
    from tui_gateway.server import install_exit_flush_signal_handlers
    import uvicorn

    app.state.auth_required = False
    app.state.trusted_public_hosts = frozenset()
    app.state.bound_host = "127.0.0.1"
    app.state.initial_profile = "default"
    from image_selection import router as image_selection_router
    from session_documents import router as session_documents_router
    from creative_memory import router as creative_memory_router
    configure_app(app, image_selection_router, token)
    original_routes = len(app.router.routes)
    app.include_router(session_documents_router)
    app.include_router(creative_memory_router)
    app.router.routes[:] = app.router.routes[original_routes:] + app.router.routes[:original_routes]
    install_exit_flush_signal_handlers()
    config = uvicorn.Config(app, host="127.0.0.1", port=options.port, fd=options.worker_fd,
                           log_level="warning", access_log=False, proxy_headers=False,
                           ws_ping_interval=None, ws_max_size=32_000_000, timeout_graceful_shutdown=3)
    listener = socket.socket(fileno=options.worker_fd)
    server = uvicorn.Server(config)
    asyncio.run(server.serve(sockets=[listener]))


if __name__ == "__main__":
    main()
