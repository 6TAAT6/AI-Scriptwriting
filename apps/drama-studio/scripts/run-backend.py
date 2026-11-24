"""由进程管理器启动固定运行环境，私有服务凭证只进入子进程环境。"""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    repo = Path(__file__).resolve().parents[3]
    home = Path(config["hermesHome"])
    runtime = config["nativeRuntime"]
    endpoint = urlsplit(config["backend"])
    if (not home.is_absolute() or endpoint.scheme != "http"
            or endpoint.hostname != "127.0.0.1" or not endpoint.port
            or endpoint.username or endpoint.password or endpoint.path not in ("", "/")
            or endpoint.query or endpoint.fragment):
        raise ValueError("创作后端必须使用明确的本机回环地址。")
    token = (home / "studio" / "runtime-token").read_text().strip()
    if len(token) < 32:
        raise ValueError("工作区服务凭证不可用。")
    # 运营 profile 的插件副本与员工工作区一样，在启动前对齐到本次发布的业务代码。
    # 同步代码会导入 Hermes 模块，必须从本次 release 导入：运行环境的可编辑安装可能登记着已删除的旧 release。
    import sys
    sys.path[:0] = [str(repo / "apps/drama-studio/server"), str(repo)]
    from profiles import sync_operator_capabilities
    sync_operator_capabilities(home)
    # 当前入口所在 release 是代码导入根。配置可能从旧 release 继承，
    # 不能让 core 与入口脚本加载不同版本的 Hermes 模块。
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_RUNTIME_DIR": runtime["runtimeDir"],
           "HERMES_DASHBOARD_SESSION_TOKEN": token, "PYTHONPATH": str(repo),
           "PYTHONDONTWRITEBYTECODE": "1", "PYTHONNOUSERSITE": "1"}
    command = [runtime["python"], str(repo / "apps/drama-studio/server/runtime.py"),
               "--host", "127.0.0.1", "--port", str(endpoint.port), "--isolated"]
    os.execve(command[0], command, env)


if __name__ == "__main__":
    main()
