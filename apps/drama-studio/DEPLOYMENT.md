# 服务器部署与运行说明

本说明对应 `192.168.10.36` 上的独立巨豹智能体部署，目录和配置于 2026-10-05 核对。服务账号为 `admin1`，浏览器访问地址为 `http://192.168.10.36:10619/`。这是局域网地址；跨网络访问能力取决于实际路由配置。

## 目录与端口

服务根目录为 `/home/admin1/services/jubao-hermes`：

```text
jubao-hermes/
├── current -> releases/20261005-r1
├── releases/
│   └── 20261005-r1/            # 独立程序发布目录，包含构建后的前端
├── state/                     # 本次新建的独立 Hermes 运行状态目录
│   ├── studio/                # 账号、侧栏、服务凭证和员工运行日志
│   ├── profiles/jubao-drama/   # 超级管理员创作空间
│   └── studio-workers/        # 普通管理员和员工的独立创作空间
├── runtime/
│   ├── bin/                   # Node 等启动命令
│   ├── venv/                  # 预装的业务 Python 环境
│   ├── test-venv/             # 独立测试环境
│   ├── tools/                 # Python 基础运行时和外部工具
│   └── ipc/                   # Linux 员工专用短路径通信目录
├── deploy/
│   └── server.json            # 启动配置，不存放模型 API Key
└── logs/                      # 部署和验证回执
```

`state/` 与发布目录分开，升级代码时保留账号、聊天和剧本资料。此目录由本服务独立使用，不复用服务器上旧剧本工具的运行目录。本次按用户最终要求使用全新账号和空白业务数据，仅配置运行所需的模型接入；没有导入本机账号、聊天、剧本或记忆。

前端和账号边缘服务绑定 `192.168.10.36:10619`。Hermes 主后端只绑定 `127.0.0.1:10620`，由边缘服务携带私有服务凭证访问。员工后端按需创建独立进程和容器，不向局域网另开公开端口。

## 部署配置

两个启动入口共同读取 `/home/admin1/services/jubao-hermes/deploy/server.json`。当前配置形状如下；镜像标识和解释器目录必须对应已经安装、校验过的实际产物：

```json
{
  "hermesHome": "/home/admin1/services/jubao-hermes/state",
  "backend": "http://127.0.0.1:10620",
  "host": "192.168.10.36",
  "port": 10619,
  "publicOrigin": "http://192.168.10.36:10619",
  "linuxWorkerImage": "sha256:d3266579fd59fc4d4d05c58f9a87ca03e405b9e7acd6e8d33a7e6493f73477df",
  "ipcRoot": "/home/admin1/services/jubao-hermes/runtime/ipc",
  "nativeRuntime": {
    "python": "/home/admin1/services/jubao-hermes/runtime/venv/bin/python",
    "pythonPath": "/home/admin1/services/jubao-hermes/releases/20261005-r1",
    "pythonPaths": [
      "/home/admin1/services/jubao-hermes/runtime/tools/python-3.14.7+20260901-linux-x64",
      "/home/admin1/services/jubao-hermes/runtime/venv"
    ],
    "runtimeDir": "/home/admin1/services/jubao-hermes/runtime/tools"
  }
}
```

- `hermesHome` 必须为绝对路径。账号数据目录由入口固定为其下的 `studio/`；程序根目录由入口文件所在发布目录确定，无需额外配置 `repoRoot` 或 `dataDir`。
- `publicOrigin` 为不含凭证、路径和查询参数的 HTTP 或 HTTPS 来源。服务器验证实际 Host；写操作和 WebSocket 必须带匹配的 Origin，账号写操作还需 CSRF。`X-Forwarded-Host`、`X-Forwarded-Proto` 不参与信任判断。未配置公开来源时，底层服务只允许本机回环监听。
- HTTPS 来源会启用会话 Cookie 的 `Secure`。入口自身提供 HTTP；若改用 HTTPS，需先实际配置 TLS 终止和同源反向代理，并保留正确的 Host 与 Origin，仅修改字符串不会启用 TLS。
- `backend` 在 `run-backend.py` 中必须为带明确端口的 `http://127.0.0.1` 地址，不接受凭证、查询参数或其他主机。
- `nativeRuntime.python` 是预装虚拟环境解释器；`pythonPath` 用于导入本次发布的代码，需要额外模块目录时按系统路径分隔符连接。虚拟环境自身提供已安装依赖。
- `pythonPaths` 是容器需要只读映射的解释器和依赖目录。它们必须与程序、账号资料分开，不能配置为系统根目录、用户主目录或包含账号资料的祖先目录。
- `runtimeDir` 指向已准备的工具目录。后台读取模型连接、创建或刷新员工工作区、读取推理档位均直接使用指定环境；没有 `nativeRuntime` 的本机模式继续使用 `scripts/run-in-hermes-env`。
- `linuxWorkerImage` 必须使用 `sha256:<64位摘要>` 或 `仓库@sha256:<64位摘要>`，镜像须在启动员工容器前准备完毕。Linux 服务以非 root 系统账号运行，并需要调用 Docker 的权限。
- `ipcRoot` 采用独立短绝对路径。Linux Unix Socket 路径连同生成的子目录和文件名必须小于 108 字节；中文按 UTF-8 字节计数，不能只按字符数估算。

模型 API Key 保存在运营 profile 的 Hermes 凭证存储，不写入此 JSON。`state/studio/runtime-token` 是边缘服务与主后端共用的私有服务凭证，首次部署需要先通过 `server/runtime-credentials.mjs` 的 `runtimeToken(dataDir, { create: true })` 初始化，后续启动复用原文件。凭证不进入浏览器、命令行参数或文档。

## 两个启动入口与进程管理

`scripts/serve.mjs --config <绝对路径>` 启动已构建前端、账号边缘服务及员工进程池。它只读取 `dist/` 中的公开资产，不运行 Vite，不在收到请求时构建或安装依赖。

`scripts/run-backend.py --config <绝对路径>` 读取同一配置及私有服务凭证，再用 `nativeRuntime.python` 执行 `server/runtime.py`，固定回环监听并启用 `--isolated`。员工模型连接读取绑定真实的 Hermes home 和 secret scope，再由原生 Provider 解析链决定实际协议。

服务器使用两个 `systemd --user` 单元，文件位于 `/home/admin1/.config/systemd/user/`：

- `jubao-hermes-core.service`：启动 `current/apps/drama-studio/scripts/run-backend.py`。
- `jubao-hermes-studio.service`：启动 `current/apps/drama-studio/scripts/serve.mjs`，依赖并排序在 core 单元之后。

两者的工作目录均为 `current`，配置均为 `deploy/server.json`，异常退出采用 `Restart=on-failure`。使用服务账号执行日常检查：

```bash
systemctl --user status jubao-hermes-core.service jubao-hermes-studio.service --no-pager
journalctl --user -u jubao-hermes-core.service -u jubao-hermes-studio.service -n 100 --no-pager
```

新安装或调整了这两个单元文件后，重载并启动：

```bash
systemctl --user daemon-reload
systemctl --user start jubao-hermes-core.service jubao-hermes-studio.service
```

服务托管运行时，不同时手动运行相同端口的本机启动器或部署入口。需要停止本服务时，先确认各账号业务空闲，再停止网页入口和主后端：

```bash
systemctl --user stop jubao-hermes-studio.service jubao-hermes-core.service
```

边缘服务关闭会回收其员工进程和容器；后台仍在执行的工作会受影响。未过期且账号版本仍有效的登录会话会从 `state/studio/studio-sessions.json` 恢复，浏览器重新连接后刷新页面验证信息；账号与资料由 `state/` 保留。升级应在创作任务空闲时进行。

工作台新登录的固定有效期为 7 天，服务端会话与浏览器 Cookie 使用同一期限；普通请求和服务重启不延长到期时间。升级前已经签发的登录保留原到期时间，下次成功登录才使用 7 天期限。主动退出、修改密码或账号权限撤销仍会提前结束相应登录。

## 升级与回滚

所有操作仅针对 `/home/admin1/services/jubao-hermes` 和上述两个单元。服务器上的其他剧本工具、服务单元和资料目录不属于此发布范围。

1. 将新版本准备在新的 `releases/<版本>/` 目录，完成构建、依赖与镜像准备、权限检查和隔离测试；运行中的发布目录保持完整，便于回滚。
2. 保存当前 `current` 指向以及 `deploy/server.json` 的副本。若升级涉及存储格式，还要在业务空闲时备份本服务 `state/`，不能用运行中的不一致复制代替备份。
3. 核实无活动创作及后台子任务后，停止本服务的两个单元。
4. 切换 `current`，同时把 `nativeRuntime.pythonPath` 等引用发布目录的配置改为新版本；只切换软链接、留下旧模块路径会混用代码。解释器、工具目录或镜像发生变化时，一并切换到对应已验收产物。
5. 启动 core 和 studio，检查运行日志、监听地址、登录、历史聊天、资料下载，以及真实员工会话的 WebSocket 事件链。
6. 验收失败时停止这两个单元，恢复上一版本软链接和匹配配置，再启动并复查。保留 `state/`；仅在已评估数据格式兼容性并有明确恢复范围时使用数据备份，不能直接覆盖新产生的稿件。

## 验证范围

检查页面能访问、登录成功或健康接口返回成功，只能证明相应环节可用。服务器交付还需分别核对主后端、员工 Docker 隔离、历史恢复、附件和导出、真实 WebSocket 逐段事件与子智能体回执。

在发布目录使用独立测试解释器运行后台检查：

```bash
PATH=/home/admin1/services/jubao-hermes/runtime/bin:$PATH \
HERMES_PYTHON=/home/admin1/services/jubao-hermes/runtime/test-venv/bin/python \
scripts/run_tests.sh tests/apps/drama_studio/test_native_runtime.py -q
```

`test_native_runtime.py` 已在本机 macOS 与服务器真实 Linux 环境各通过 2 项检查：预装运行环境贯穿后台辅助命令，以及 A→B→A 的 profile 凭据隔离。Linux 检查还覆盖超长 IPC 路径的明确拒绝。服务器回执为 `/home/admin1/services/jubao-hermes/logs/linux-native-runtime-final.log`。

这些测试使用临时数据和受控模型配置，**不包含付费生成**，也不证明生成质量、完整剧本验收或并发承载能力。本次已通过真实服务器员工登录、WebSocket 模型目录、创建空会话、附件上传及鉴权下载字节一致、普通账号管理权限拒绝、错误 Host/Origin 拒绝和停用收回容器验证。验收员工及其资料已清理，交付时仅保留全新 `root`，两份正式会话库均为 0 会话、0 消息。

## 本次发布回执

- 版本：`20261005-r1`，包含当前工作区尚未提交的产品改动；并非仅部署 Git HEAD。
- 189 个程序、构建与扩展文件的 SHA256 已逐一核对一致，清单位于 `deploy/release-manifest.json`。
- 前端 73 项、服务端 40 项测试通过；之后新增空会话下载修复，本机及服务器相关 HTTP 权限回归均为 9 项通过。
- Linux 隔离、PDF、分段转发与真实回环连接共 5 项通过；另使用独立临时容器验证原生 WebSocket token 拒绝与合法模型目录/会话目录访问。
- 内网 HTTP 白屏修复通过失败重现、回归和实际浏览器登录验收。
- 两服务 `active/running`、`enabled`，服务账号 `Linger=yes`；本次未重启整台服务器。
- 原有 `10618`、`10588`、`10589` 服务保持运行，未修改其发布目录或数据。
- 初始密码只在本机私有交付文件保留；服务器初始化明文密码及临时配置包已删除。

Linux 员工容器对可信配置采用只读挂载。如果在其运行时更新模型配置，宿主的原子替换不会刷新旧挂载的文件 inode。应在所有创作与后台子任务空闲后重启本服务的 studio 单元，让下次员工连接建立读取最新配置的容器；不要为刷新模型配置中断进行中的创作。

## 2026-10-05 首屏加载更新

同日增量更新了前端初始化：后台连接和模型目录读取期间，首页及输入框保持可用；聊天恢复不再等待模型目录；发送与附件上传仍要求初始化完成，并保护等待期间的新草稿。

此次只替换前端静态资产和对应源码，先上传内容哈希命名的资产，再原子替换 `index.html`，保留旧资产供已经打开的页面使用。主后端、网页进程与现有员工容器均保持原 PID／容器 ID。备份、资产 SHA256 清单与前后运行记录位于 `deploy/frontend-startup-20261005/`。回滚本次界面时从该目录的 `previous-dist.tar.gz` 恢复上一份静态资产；不切换或覆盖 `state/`。

本次隔离临时账号实测：首次创作进程启动 6322 毫秒，再次取得同一进程不足 1 毫秒。主账号聊天目录约 58–60 毫秒、模型目录约 524–528 毫秒。此修复取消前端全屏阻塞，不宣称消除了独立进程首次启动所需的时间。75 项前端测试和 41 项服务端测试通过，最终相关 21 项回归及构建通过。实际服务器浏览器已验证模型目录尚未返回时输入框可输入，验收未发起模型生成。

## 2026-10-05 新建对话侧栏同步更新

修复新会话创建成功后，首轮尚未落库而被空历史列表覆盖的问题。前端根据真实 `session.create` 回执保存临时条目，项目归属确认后立即发布；历史列表出现同一 ID 后使用正式记录并去重。删除和账号退出清理临时条目，实时标题同步更新。77 项前端测试、41 项服务端测试和构建通过，两项针对性回归先在旧实现复现失败。

前端使用先上传内容哈希资产、再原子替换首页的方式更新，原主服务 PID、网页 PID 与账号容器均保持运行。备份、文件校验和前后运行记录位于 `deploy/frontend-sidebar-20261005/`。模型精简配置另行准备在本机 `.cache/models-20261005/pending-change.json`；此界面发布没有修改模型允许列表。

## 最近列表与归档集中管理更新

本次候选增加显式 `projectId: null`，用于不属于项目的最近对话；原有未标记项目的旧聊天仍归原默认项目。项目选择、最近选择和草稿按账号隔离，项目恢复集中到“系统设置 → 已归档”。模型选择仍对全部账号开放，模型接入及 API Key 管理继续只允许超级管理员。模型列表切换目标为 `gpt-6-astra`、`gpt-6.1-sol`，默认前者。

78 项前端、43 项服务端回归通过，最终相关 25 项回归及构建通过。独立浏览器验收覆盖最近对话、项目对话的即时出现与刷新归属、项目隐藏后侧栏无占位、设置内恢复；使用受控响应，没有真实模型调用。依赖审计无 high/critical，本次未新增或更换依赖；现有 low/moderate 告警未阻塞本次功能验证，安排于 2026-10-12 复核可达路径和兼容升级。

这组更新已合入下方的自动同步正式发布。此前 `deploy/workspace-recents-20261005/` 只作为历史候选保留，不应再次覆盖正式目录。

## 2026-10-05 自动同步正式发布

已在所有创作和后台子任务空闲时加载更新，正式入口仍为 `http://192.168.10.36:10619/`。回退副本、部署脚本和最终文件哈希清单位于 `deploy/workspace-live-sync-20261005/`；最终前端修订采用静态资产原子替换，没有再次重启创作进程。

- 断线自动重连，当前对话恢复时保留输入框和继续输入的草稿，不重新提交生成请求。
- 可见页面每 20 秒同步聊天、项目与相关状态；模型目录每 60 秒更新，切回页面和保存模型设置时提前刷新。
- 后台和其他对话的完成、标题变化也会更新列表。
- 检测新前端后，在没有未发送草稿、附件、生成、确认请求或打开菜单的情况下自动加载；关闭但保留在 DOM 中的下拉菜单不会阻挡更新。
- 未选择项目的新对话进入最近，项目内新对话保持原项目归属；旧版自动选中的默认项目标记不再当成显式选择。
- 已移除项目仅在系统设置的已归档页显示恢复入口。
- 聊天模型只保留 `gpt-6-astra` 和 `gpt-6.1-sol`，默认前者；现有 `gpt-image-2` 图片配置与 API 凭据校验一致。模型选择供所有账号使用，接入与密钥管理仅限超级管理员。
- 修复专用模型 GET 接口被页面兜底路由遮蔽的问题，管理员模型设置接口实测恢复为 HTTP 200。

验证：独立构建副本的 86 项前端测试和构建通过；最终选择归属修订的 9 项针对性检查通过；相关服务端 HTTP/权限回归 16 项通过；通过规定的 Python 测试运行器验证真实配置与路由、凭据边界共 4 项。服务器真实管理员和临时隔离账号的目录均只有两个聊天模型。临时隔离账号未写入正式账号表，验证未调用模型生成。浏览器验证了连接中断后的自动恢复、其他页面新增项目的同步、草稿保护，以及空闲后的自动版本切换。

## 模型超时与错误诊断修复（2026-10-09）

长模型请求分成首响应、无新数据和总预算三项限制：默认分别为 600 秒、180 秒、1800 秒；图片仍使用 300 秒预算。SSE 持续返回内容或心跳时更新空闲计时，避免原先固定 180 秒总时限截断正常长输出。需要调整时，在运营 profile 的 `config.yaml` 中配置 `studio_inference.timeouts_ms`，支持 `firstResponseMs`、`idleMs`、`totalMs`；修改后在所有任务空闲时重新加载工作区服务。此配置不改变模型、推理档位或并发数。

独立审稿使用插件注册的 `auxiliary.jubao_drama_review` 路由，默认等待 600 秒，可在该配置项中覆盖 `timeout`。原稿提交支持直接读取本账号已经上传的 `data.path`，沿用原有目录、文件类型和大小校验；跨账号或不合法路径仍拒绝。

代理保留已脱敏的上游状态和请求编号，区分上下文超限、认证失败、限流、连接错误和各阶段超时。`jubao-hermes-studio.service` 的日志中 `STUDIO_INFERENCE` 记录只含账号标识、模型、错误类别、状态码、耗时和请求编号，不记录密钥、上游地址或原始输入。独立运维后台读取这些记录，并将重试、业务校验和明确失败分开统计。
