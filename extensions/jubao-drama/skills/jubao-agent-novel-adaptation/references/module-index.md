# 内部模块目录

本目录用于选择当前任务资料，不要求一次加载所有模块。所列入口均为完整上游规则的保留副本；每次完整读取选中的 source-SKILL.md，再完整读取该任务实际需要的支持文档。

## 小说改编美术设定

- 内部标识：`novel-art`。
- 用途：为短剧设计场景、道具、一致性锚点与美术提示词。
- 完整规则：[source-SKILL.md](modules/novel-art/source-SKILL.md)。
- 支持资料根：`references/modules/novel-art/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- Node.js >= 18；原文可选出图调用 Codex imagegen，迁入 Hermes 时需核实能力映射。

## 小说改编人物设计

- 内部标识：`novel-characters`。
- 用途：从小说拆出角色、人物画像、形象与音色提示词。
- 完整规则：[source-SKILL.md](modules/novel-characters/source-SKILL.md)。
- 支持资料根：`references/modules/novel-characters/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- Node.js >= 18；原文可选出图调用 Codex imagegen，迁入 Hermes 时需核实能力映射。

## 小说改编分集大纲

- 内部标识：`novel-outline`。
- 用途：把小说转为改编说明、人物表、爽点表、分集梗概与资产清单。
- 完整规则：[source-SKILL.md](modules/novel-outline/source-SKILL.md)。
- 支持资料根：`references/modules/novel-outline/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- Node.js >= 18；原文可选出图调用 Codex imagegen，迁入 Hermes 时需核实能力映射。

## 小说改编分集剧本

- 内部标识：`novel-script`。
- 用途：将分集梗概写成场次、动作节拍和逐句台词。
- 完整规则：[source-SKILL.md](modules/novel-script/source-SKILL.md)。
- 支持资料根：`references/modules/novel-script/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- Node.js >= 18；原文可选出图调用 Codex imagegen，迁入 Hermes 时需核实能力映射。

## 小说改编分镜脚本

- 内部标识：`novel-storyboard`。
- 用途：将剧本拆为分镜、关键帧和 MiniMax H3 视频提示词。
- 完整规则：[source-SKILL.md](modules/novel-storyboard/source-SKILL.md)。
- 支持资料根：`references/modules/novel-storyboard/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- Node.js >= 18；原文可选出图调用 Codex imagegen，迁入 Hermes 时需核实能力映射。

## 小说改编分析

- 内部标识：`short-drama-novel-analyze`。
- 用途：只读拆解原著章节、人物、节奏、改编价值与分集候选。
- 完整规则：[source-SKILL.md](modules/short-drama-novel-analyze/source-SKILL.md)。
- 支持资料根：`references/modules/short-drama-novel-analyze/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

