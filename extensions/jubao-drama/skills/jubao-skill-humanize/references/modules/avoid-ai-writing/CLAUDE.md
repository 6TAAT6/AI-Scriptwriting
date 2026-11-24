# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在处理本仓库代码时提供指引。

## 这是什么

一个单文件写作技能（`SKILL.md`），用于审查并改写内容以去除 AI 痕迹（AI tell）。该技能是一个供 AI 编程助手读取的 markdown 文件；仓库还附带一个零依赖的确定性检测器和测试套件。

## 仓库结构

- `SKILL.md` — 技能本体，即产品本身。所有规则、分级、画像与输出格式都存放于此。
- `README.md` — 面向公开读者的文档，包含安装说明、模板套话（pattern）参照表，以及完整的 Before/After 示例。
- `CHANGELOG.md` — 版本历史，记录改了什么以及为什么改。

## 如何修改

直接编辑 `SKILL.md`。修改时注意：

- 在 SKILL.md 的 frontmatter 中提升版本号（`version: X.Y.Z`）。
- 运行 `bash scripts/sync-plugin-skill.sh`。根目录的 SKILL.md 是唯一事实来源；插件内置副本以及 `plugin.json` 的版本号都由它生成，CI 会在两者不一致时报错。只提升 frontmatter 而不执行此步骤，会使 `check` 任务以 `version mismatch: SKILL.md=X plugin.json=Y` 失败。
- 运行 `npm test` 以跑通检测器、类别契约、校验器、语料辅助工具以及风格检查。
- 在 CHANGELOG.md 中添加一条带日期的记录。
- 若改动影响安装、用法、功能清单或模板套话条目数，则同步更新 README.md。
- 模板套话条目数只放在**唯一一处**——README 里 "61 pattern categories"（61 类模板套话）这一条项目符号——它由 SKILL.md 中检测类的 `###` 条目推导而来。不要在别处重复此数字；CI（`scripts/check-pattern-count.sh`）在 README 数字与 SKILL.md 不一致时会令构建失败，因此只需新增 `###` 条目并相应更新 README 这一条项目符号即可。

## 技能架构

该技能有三种模式（默认 `rewrite`、仅打标 `detect`、就地 `edit`），按如下流水线处理文本：

1. **语境画像检测（Context profile detection）** — 自动识别或接受画像提示（linkedin、blog、technical-blog、investor-email、docs、casual），通过容差矩阵调整规则严格程度。
2. **模板套话匹配（Pattern matching）** — 覆盖内容、语言、结构、沟通及元层面模式等多类检测类别（完整目录见 SKILL.md；条目数见 README 中的项目符号）。
3. **词汇标记（Vocabulary flagging）** — 三级体系：Tier 1（一律标记）、Tier 2（成簇出现才标记）、Tier 3（高密度才标记）。
4. **严重度分级（Severity classification）** — P0（致命可信度问题）、P1（明显的 AI 腔）、P2（风格层面的打磨）。
5. **输出（Output）** — 改写模式：共 4 个区块，含一轮二次审查；检测模式：共 2 个区块，区分确属问题与可商榷判断。

## 关键约束

- 该技能必须保持为单个 `SKILL.md` 文件，并采用兼容 agentskills.io 的 frontmatter。
- 用词替换表中的每一条都必须给出具体的替换词，而不能只写 "rephrase"（改写）。
- 自引用例外通道（引号内示例免于标记）必须保留——否则技能会把自身的文档判定为 AI 痕迹。
- technical-blog（技术博客）画像有明确的用词表例外（例如 "robust" 和 "ecosystem" 在技术语境里本就是正当用词）。
- 容差矩阵中的 "Extra strict"（特别严格）和 "skip"（跳过）各自有文件中明确定义的语义。
- `ai-writing-skill-field-guide` 的调研把本仓库列为维护度第一，其作者在本仓库提过 Issue #12。凡对外引用这一排名，都必须附带该披露说明。

## 兼容性

该技能兼容 Claude Code、OpenClaw/ClawHub，以及任何兼容 agentskills.io 的 agent。frontmatter 同时包含 `agentskills_spec` 和 `openclaw` 两个字段。任何修改都不得破坏其中任一格式。
