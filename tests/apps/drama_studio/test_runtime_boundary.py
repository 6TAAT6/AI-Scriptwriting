"""工作区私有后端不得向匿名浏览器发放通用访问令牌。"""
import importlib.util
from pathlib import Path

from starlette.testclient import TestClient


RUNTIME = Path(__file__).resolve().parents[3] / "apps/drama-studio/server/runtime.py"
SPEC = importlib.util.spec_from_file_location("studio_private_runtime", RUNTIME)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
TOKEN = "fixture-runtime-" + "a" * 48


async def backend(scope, receive, send):
    if scope["type"] == "http":
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"private-backend-canary"})
    elif scope["type"] == "websocket":
        await send({"type": "websocket.accept"})
        await send({"type": "websocket.send", "text": "private-backend-canary"})
        await send({"type": "websocket.close", "code": 1000})


def test_anonymous_http_cannot_reach_any_backend_route_or_bootstrap_token():
    client = TestClient(MODULE.ServiceBoundary(backend, TOKEN))
    for route in ("/", "/api/status", "/api/auth/me", "/docs", "/openapi.json", "/internal/ready"):
        for headers in ({}, {"x-hermes-session-token": "wrong"}):
            response = client.get(route, headers=headers)
            assert response.status_code == 401
            assert "private-backend-canary" not in response.text
            assert TOKEN not in response.text
    allowed = client.get("/api/status", headers={"x-hermes-session-token": TOKEN})
    assert allowed.text == "private-backend-canary"
    root = client.get("/", headers={"x-hermes-session-token": TOKEN})
    assert root.json() == {"service": "studio-runtime"}


def test_websocket_requires_unique_service_credential_before_connecting():
    from starlette.websockets import WebSocketDisconnect
    import pytest

    client = TestClient(MODULE.ServiceBoundary(backend, TOKEN))
    for suffix in ("", "?token=wrong", f"?token={TOKEN}&token=wrong"):
        with pytest.raises(WebSocketDisconnect) as caught:
            with client.websocket_connect("/api/ws" + suffix):
                pass
        assert caught.value.code == 1008
    with client.websocket_connect("/api/ws?token=" + TOKEN) as socket:
        assert socket.receive_text() == "private-backend-canary"
