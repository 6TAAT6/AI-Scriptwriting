# 内部模块目录

本目录用于选择当前任务资料，不要求一次加载所有模块。所列入口均为完整上游规则的保留副本；每次完整读取选中的 source-SKILL.md，再完整读取该任务实际需要的支持文档。

## 女频短剧大纲策划

- 内部标识：`female-drama-outline`。
- 用途：女频短剧大纲策划
- 完整规则：[source-SKILL.md](modules/female-drama-outline/source-SKILL.md)。
- 支持资料根：`references/modules/female-drama-outline/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 原包没有技能元数据，需要补规范入口；功能范围为大纲与审稿，不包装成正文写作。

## 男频短剧大纲策划

- 内部标识：`male-drama-outline`。
- 用途：男频短剧大纲策划
- 完整规则：[source-SKILL.md](modules/male-drama-outline/source-SKILL.md)。
- 支持资料根：`references/modules/male-drama-outline/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 原包没有技能元数据，需要补规范入口；功能范围为大纲与审稿，不包装成正文写作。

## 女频短剧统筹

- 内部标识：`ai-short-drama-studio-female`。
- 用途：统筹女性向短剧的选题、编剧、角色、分镜、声音与资产交接。
- 完整规则：[source-SKILL.md](modules/ai-short-drama-studio-female/source-SKILL.md)。
- 支持资料根：`references/modules/ai-short-drama-studio-female/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 微短剧全流程创作

- 内部标识：`short-drama-paid`。
- 用途：开发 50–100 集竖屏付费短剧，设计付费卡点、爽点和分集。
- 完整规则：[source-SKILL.md](modules/short-drama-paid/source-SKILL.md)。
- 支持资料根：`references/modules/short-drama-paid/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 合并 Top10、女频包、男频包及 GR4.7 赠送区的同源微短剧副本。

## 短剧项目统筹

- 内部标识：`short-drama-router`。
- 用途：在文件系统中初始化、继续、恢复短剧项目并统筹阶段交接。
- 完整规则：[source-SKILL.md](modules/short-drama-router/source-SKILL.md)。
- 支持资料根：`references/modules/short-drama-router/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 该短剧链提及 short-drama-image-prompts / short-drama-video-prompts，本组未包含这两个入口。
- 与男频战神包同名 short-drama 内容不同，安装时必须避免同名覆盖。
- 原名 short-drama 与另一套全流程技能同名异文，单独分配安装标识，避免覆盖。
- 引用的 short-drama-image-prompts、short-drama-video-prompts 未在本合集找到入口。

## 短剧资产拆解

- 内部标识：`short-drama-assets`。
- 用途：拆解角色、造型、场景、道具、声音方向与跨场连续性。
- 完整规则：[source-SKILL.md](modules/short-drama-assets/source-SKILL.md)。
- 支持资料根：`references/modules/short-drama-assets/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 该短剧链提及 short-drama-image-prompts / short-drama-video-prompts，本组未包含这两个入口。

## 短剧故事开发

- 内部标识：`short-drama-develop`。
- 用途：将小说或故事点子发展为创作简报、故事引擎与分集地图。
- 完整规则：[source-SKILL.md](modules/short-drama-develop/source-SKILL.md)。
- 支持资料根：`references/modules/short-drama-develop/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 短剧质量审查

- 内部标识：`short-drama-review`。
- 用途：独立审查故事、剧本、资产、分镜、连续性和提示词。
- 完整规则：[source-SKILL.md](modules/short-drama-review/source-SKILL.md)。
- 支持资料根：`references/modules/short-drama-review/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 短剧镜头规划

- 内部标识：`short-drama-storyboard`。
- 用途：把已确认剧本与资产转为镜头、连续性边界和关键帧提示词。
- 完整规则：[source-SKILL.md](modules/short-drama-storyboard/source-SKILL.md)。
- 支持资料根：`references/modules/short-drama-storyboard/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 该短剧链提及 short-drama-image-prompts / short-drama-video-prompts，本组未包含这两个入口。

## 短剧单集编写

- 内部标识：`short-drama-write`。
- 用途：创作、续写或修订单集卡、因果节拍与可拍摄剧本。
- 完整规则：[source-SKILL.md](modules/short-drama-write/source-SKILL.md)。
- 支持资料根：`references/modules/short-drama-write/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 竖屏短剧创作

- 内部标识：`drama-creator`。
- 用途：竖屏短剧创作
- 完整规则：[source-SKILL.md](modules/drama-creator/source-SKILL.md)。
- 支持资料根：`references/modules/drama-creator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 竖屏短剧策划

- 内部标识：`drama-planner`。
- 用途：竖屏短剧策划
- 完整规则：[source-SKILL.md](modules/drama-planner/source-SKILL.md)。
- 支持资料根：`references/modules/drama-planner/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

