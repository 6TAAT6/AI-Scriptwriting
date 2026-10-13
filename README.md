# 巨豹智能体 · 剧本创作工作区

本仓库保存巨豹智能体 **v1.0.0 完整源码**，基于 Hermes Agent 核心，包含自定义网页工作区、剧本创作插件、账号与模型接入服务、共享客户端、测试、构建脚本和依赖锁文件。

源码以 2026 年 10 月 13 日迁移时的正式发布版本 `20261012-document-image-r1` 为基准，包含此前 `20261012-branding-v1.0.0` 的功能以及后续文档与图片更新。产品版本由 `apps/drama-studio/package.json` 和根目录 `VERSION` 标明；Hermes 核心与插件保留各自的版本信息。

## 功能

- 项目、最近聊天、侧栏置顶、归档和稿件阅读面板。
- 流式回复、原生工具状态、子智能体进度、人工确认与历史恢复。
- 独立剧本 Agent 与技能、原稿读取、阶段稿件、Word 等文档交付。
- 附件上传、图片读取与生成、账号内文件预览和下载。
- 超级管理员、管理员与员工账号，以及模型品牌入口、实际模型绑定和独立员工工作进程。

具体行为和配置请查看 [工作区说明](apps/drama-studio/README.md) 与 [部署说明](apps/drama-studio/DEPLOYMENT.md)。

## 目录

- `apps/drama-studio/`：React/Vite 前端、Node 服务、Python 运行桥接及测试。
- `extensions/jubao-drama/`：剧本业务插件、Agent/Skill 规则、模板与导出能力。
- `apps/shared/`：Hermes JSON-RPC 客户端和协议契约。
- `agent/`、`tui_gateway/`、`hermes_cli/`、`tools/` 等：完整 Hermes 核心。
- `tests/`、`tests-js/`：Python 与 JavaScript 回归测试。
- `scripts/`、`pm/`、`pyproject.toml`、`uv.lock`、`package-lock.json`：开发、依赖管理和构建入口。
- `docs/releases/v1.0.0.md`：本次源码迁移的范围与验证记录。

## 本机开发

Python 支持范围为 `>=3.11,<3.15`，仓库推荐 Python 3.14；Node.js 与 npm 的兼容范围见根目录 `package.json` 的 `engines`。Python 环境通过 Hermes PM 管理，首次准备方式见 [贡献指南](CONTRIBUTING.md) 和 [依赖管理说明](website/docs/reference/package-management.md)。

准备独立的开发用 `HERMES_HOME` 与 `HERMES_RUNTIME_DIR` 后，在仓库根目录安装依赖：

```bash
source ./activate
npm ci
```

启动工作区：

```bash
npm run start --workspace apps/drama-studio
```

本机默认入口为 `http://localhost:10619/`。macOS 也可以使用仓库根目录的 `启动巨豹智能体.command`。模型凭据、账号和运行状态需要在自己的环境中配置；源码仓库不携带生产账号、密码、API Key、历史对话、稿件数据、数据库、运行日志或依赖安装目录。

## 构建与测试

```bash
npm run build --workspace apps/drama-studio
npm test --workspace apps/drama-studio
scripts/run_tests.sh tests/apps/drama_studio/
```

Python 测试使用 `scripts/run_tests.sh` 提供的独立环境与隔离行为。正式服务器使用已构建前端与独立服务入口，部署步骤及员工隔离要求见 [DEPLOYMENT.md](apps/drama-studio/DEPLOYMENT.md)。

## 来源与许可证

Hermes 上游基线为 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) 的提交 `eb7e8620324b32424c06218f6a28094df2e921f8`。上游介绍保存在 [README.hermes.md](README.hermes.md)，原有版权、作者说明与 [MIT 许可证](LICENSE) 已保留。自研业务层与上游核心均在此仓库内；本次以完整源码快照建立 Git 历史。
