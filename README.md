# 巨豹智能体 · 剧本创作工作区

本仓库保存巨豹智能体当前正式版源码。当前正式发布代次为 `20261123-agent22-length-formal`，工作区产品版本为 `2.6.4`。正式版已在 2026 年 11 月 23 日完成发布验收，代码快照与正式环境保持一致。

巨豹智能体基于 Hermes Agent，面向短剧、小说和剧本创作场景，提供创作工作区、独立剧本 Agent、稿件保存与核验、附件处理、模型接入和公司统一登录能力。

## 当前正式版能力

- Agent2.2 默认每集 1400—1600 个汉字，并在字数不符合范围时执行一次定向返修。
- 收尾补存支持带空格的集标题，例如“第 1 集”，保存后的集数与核验结果保持一致。
- 工具执行中间件会先按工具定义转换参数类型，兼容模型返回的布尔值和数字字符串。
- 支持剧本、小说、改编、分镜、审阅和短剧创作等工作流，以及稿件版本、历史记录和刷新恢复。
- 正式工作区保留公司统一登录、正式回调和正式 origin。生产账号、数据库、附件、日志、模型配置和密钥不包含在源码仓库中。

## 目录

- `apps/drama-studio/` 提供 React/Vite 工作区、Node 服务、模型代理和前端测试。
- `extensions/jubao-drama/` 提供剧本业务插件、Agent、Skill、设定库和稿件导出能力。
- `apps/shared/` 提供 JSON-RPC 客户端和共享协议契约。
- `agent/`、`hermes_cli/`、`tui_gateway/`、`tools/` 等目录保存 Hermes 核心能力。
- `tests/` 和 `tests-js/` 保存 Python、JavaScript 与前端回归测试。
- `scripts/`、`pm/`、`pyproject.toml`、`uv.lock` 和 `package-lock.json` 提供开发、依赖和构建入口。

## 本机开发

Python 支持范围为 `>=3.11,<3.15`，Node.js 与 npm 的兼容范围见根目录 `package.json`。建议使用独立的 `HERMES_HOME` 和 `HERMES_RUNTIME_DIR`，避免把本机运行状态写入源码目录。

```bash
source ./activate
npm ci
npm run start --workspace apps/drama-studio
```

本机开发入口默认使用 `http://localhost:10619/`。正式服务的端口、域名、登录配置和数据目录属于部署环境，不应写入源码或复制到本机开发环境。

## 构建与测试

```bash
npm run build --workspace apps/drama-studio
npm test --workspace apps/drama-studio
scripts/run_tests.sh tests/apps/drama_studio/
```

前端构建产物 `apps/drama-studio/dist/` 由构建命令生成，不作为源码快照提交。运行测试前请准备本机依赖，并按需要设置隔离的运行目录。

## 安全边界

请勿提交 `.env`、账号密码、API Key、私钥、数据库、会话、附件、日志、生产配置或任何员工数据。仓库中的 `.env.example` 只包含配置示例。正式环境与测试环境的账号、数据库、附件、日志和模型配置彼此独立，更新源码不会复制这些运行数据。

## 来源与许可证

Hermes 核心基线来自 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。本项目保留上游许可证和版权说明，许可证见 [LICENSE](LICENSE)。剧本业务层和工作区代码随本仓库维护。
