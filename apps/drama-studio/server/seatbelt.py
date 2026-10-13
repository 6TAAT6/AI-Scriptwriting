"""为员工工作进程生成默认拒绝的 macOS Seatbelt 策略。

父进程必须先绑定回环监听句柄，清空环境并关闭无关句柄，再执行 sandbox-exec。
真实模型凭证留在沙箱外的代理；本模块不提供同一用户会话之间的可信共享内存。
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys

_SOURCE_DIRS = (
    "agent", "cron", "gateway", "hermes_cli", "hermes_platform", "tools", "tui_gateway",
    "pm", "providers", "plugins", "skills", "optional-skills", "acp_adapter", "extensions/jubao-drama",
    "apps/drama-studio/server",
)
_SYSCTLS = (
    "hw.ncpu", "hw.logicalcpu", "hw.physicalcpu", "hw.memsize", "hw.pagesize", "hw.optional.arm64",
    "hw.machine", "hw.model", "kern.osrelease", "kern.osversion", "kern.ostype", "kern.hostname",
    "kern.version", "kern.osrevision",
)


def _quoted(value) -> str:
    text = str(value)
    if any(ord(char) < 32 for char in text):
        raise ValueError("沙箱路径不能包含控制字符。")
    return json.dumps(text, ensure_ascii=False)


def _filter(kind: str, value) -> str:
    return f"({kind} {_quoted(value)})"


def _library_files(binary: Path) -> set[Path]:
    """只读取本机已安装转换器的动态库依赖，不放开整个 Homebrew 目录。"""
    from hermes_platform.resolver import locate_command
    inspector = locate_command("otool", known_dirs=("/usr/bin",))
    if not inspector.found:
        raise RuntimeError("缺少本机动态库检查工具，不能启用 PDF 转换。")
    pending, found = [binary], set()
    while pending:
        current = pending.pop().resolve(strict=True)
        if current in found:
            continue
        if len(found) > 128:
            raise RuntimeError("PDF 转换器依赖数量异常。")
        found.add(current)
        def inspect(flag):
            return subprocess.run([*inspector.command, flag, str(current)], check=True, capture_output=True,
                                  text=True, timeout=10).stdout
        rpaths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset", inspect("-l"))
        def expand(value):
            return value.replace("@loader_path", str(current.parent)).replace("@executable_path", str(binary.parent))
        for line in inspect("-L").splitlines()[1:]:
            dependency = line.strip().split(" (compatibility", 1)[0]
            if dependency.startswith(("/usr/lib/", "/System/")):
                continue
            candidates = [Path(expand(dependency))]
            if dependency.startswith("@rpath/"):
                candidates = [Path(expand(root)) / dependency[7:] for root in rpaths]
            match = next((item for item in candidates if item.is_file()), None)
            if match is None:
                raise RuntimeError("无法确认 PDF 转换器的本机动态库。")
            pending.append(match)
    return found


def build_profile(*, repo_root, python_paths, employee_home, broker_port, backend_port, pdf_binary=None) -> str:
    """返回用于整个工作进程树的策略；python_paths 只能是显式解释器或依赖目录。"""
    repo = Path(repo_root).resolve(strict=True)
    home = Path(employee_home).resolve(strict=True)
    if home == repo or home in repo.parents:
        raise ValueError("员工资料目录不能覆盖程序目录。")
    ports = []
    for port in (broker_port, backend_port):
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("沙箱端口必须是有效整数。")
        ports.append(port)
    python = Path(sys.executable).resolve(strict=True)
    dependencies = {Path(item).resolve(strict=True) for item in python_paths}
    if not dependencies:
        raise ValueError("必须指定工作进程的 Python 依赖目录。")
    for dependency in dependencies:
        if dependency in (Path("/"), repo, Path.home().resolve()) or dependency in home.parents:
            raise ValueError("Python 依赖目录过宽。")
    system = [_filter("subpath", path) for path in ("/System/Library", "/usr/lib")]
    dependencies_read = [_filter("subpath" if path.is_dir() else "literal", path) for path in sorted(dependencies)]
    read = system + dependencies_read + [_filter("subpath", home)]
    # PathFinder 枚举导入根目录建立缓存；仅授权目录本身，不递归开放账号与缓存数据。
    read.append(_filter("literal", repo))
    read += [_filter("literal", value) for value in ("/dev/null", "/dev/random", "/dev/urandom", "/private/etc/localtime")]
    source_dirs = [_filter("subpath", repo / item) for item in _SOURCE_DIRS if (repo / item).is_dir()]
    source_files = [_filter("literal", item) for item in sorted(repo.glob("*.py"))]
    source_files += [_filter("literal", repo / item) for item in (
        "pyproject.toml", "plugin-catalog/removed.yaml",
    )]
    # 隐藏配置从源目录授权中排除；员工自己的隐藏运行资料仅由明确的 home 规则授权。
    source = f'(require-all (require-any {" ".join(source_dirs + source_files)}) (require-not (regex #"/\\.[^/]+(/|$)")))'
    execute = [_filter("literal", python)]
    mappings = system + dependencies_read
    protected = [_filter("literal", home / item) for item in ("config.yaml", ".env", "SOUL.md")]
    protected += [_filter("subpath", home / item) for item in ("plugins", "skills")]
    if pdf_binary:
        pdf = Path(pdf_binary).resolve(strict=True)
        execute.append(_filter("literal", pdf))
        libraries = _library_files(pdf)
        read += [_filter("literal", item) for item in sorted(libraries)]
        mappings += [_filter("literal", item) for item in sorted(libraries)]
        data = pdf.parent.parent / "share/poppler"
        if data.is_dir():
            read.append(_filter("subpath", data.resolve()))
    return "\n".join([
        "(version 1)", "(deny default)",
        # v1 的默认策略未涵盖后加的操作类别，必须显式关闭外部进程探测。
        "(deny process-info* file-map-executable iokit-get-properties nvram*)",
        "(allow process-info* (target self))",
        '(import "dyld-support.sb")',
        "(allow process-fork)", f'(allow process-exec {" ".join(execute)})',
        f'(allow sysctl-read (sysctl-name {" ".join(map(_quoted, _SYSCTLS))}))',
        "(allow file-read-metadata)",
        f'(allow file-read* {" ".join(read)} {source})',
        f'(allow file-map-executable {" ".join(mappings)})',
        f'(allow file-write* {_filter("subpath", home)} (literal "/dev/null"))',
        # 可信配置与代码只能由沙箱外的部署进程维护，包含删除、改名和链接替换。
        f'(deny file-write* {" ".join(protected)})',
        f'(allow network-outbound (remote tcp "localhost:{ports[0]}"))',
        f'(allow network-inbound (local tcp "localhost:{ports[1]}"))',
        "",
    ])
