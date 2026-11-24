# 内部模块目录

本目录用于选择当前任务资料，不要求一次加载所有模块。所列入口均为完整上游规则的保留副本；每次完整读取选中的 source-SKILL.md，再完整读取该任务实际需要的支持文档。

## 电影剧本开发

- 内部标识：`movie-development-skill`。
- 用途：开发电影结构、人物、关系、类型场景、对白与剧本诊断。
- 完整规则：[source-SKILL.md](modules/movie-development-skill/source-SKILL.md)。
- 支持资料根：`references/modules/movie-development-skill/`；原规则里的相对路径从此处解析。
- 接入状态：需要脚本适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 内置本地电影机制资料库；可选全文库和 Python 搜索脚本已包含，尚未执行验证。

## 剧本动作描写

- 内部标识：`action-description`。
- 用途：设计可视化动作、场景描述、动作序列与段落格式。
- 完整规则：[source-SKILL.md](modules/action-description/source-SKILL.md)。
- 支持资料根：`references/modules/action-description/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 人物弧光校验

- 内部标识：`arc-check`。
- 用途：检查正向、负向、转变型与平坦型人物弧光是否成立。
- 完整规则：[source-SKILL.md](modules/arc-check/source-SKILL.md)。
- 支持资料根：`references/modules/arc-check/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 人物弧光设计

- 内部标识：`character-arcs`。
- 用途：设计人物缺陷、欲望、需求、错误信念与成长转变。
- 完整规则：[source-SKILL.md](modules/character-arcs/source-SKILL.md)。
- 支持资料根：`references/modules/character-arcs/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 人物对白排版

- 内部标识：`character-dialogue`。
- 用途：规范 Fountain 人物名、对白、括注与相关版式。
- 完整规则：[source-SKILL.md](modules/character-dialogue/source-SKILL.md)。
- 支持资料根：`references/modules/character-dialogue/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 人物深度访谈

- 内部标识：`character-interview`。
- 用途：通过 80 问人物访谈框架发展角色背景与内在动机。
- 完整规则：[source-SKILL.md](modules/character-interview/source-SKILL.md)。
- 支持资料根：`references/modules/character-interview/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本连续性追踪

- 内部标识：`continuity-tracking`。
- 用途：追踪剧本的时间线、人物状态、道具与场景连续性。
- 完整规则：[source-SKILL.md](modules/continuity-tracking/source-SKILL.md)。
- 支持资料根：`references/modules/continuity-tracking/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本对白打磨

- 内部标识：`dialogue-craft`。
- 用途：改善角色声音、潜台词、对白节奏与信息传递。
- 完整规则：[source-SKILL.md](modules/dialogue-craft/source-SKILL.md)。
- 支持资料根：`references/modules/dialogue-craft/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本格式导出

- 内部标识：`format-export`。
- 用途：将规范化剧本导出为 PDF、FDX 或 HTML。
- 完整规则：[source-SKILL.md](modules/format-export/source-SKILL.md)。
- 支持资料根：`references/modules/format-export/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 导出依赖 Better Fountain、afterwriting 或 screenplain 等工具，不能仅靠说明文本保证 PDF/FDX/HTML 导出。

## Fountain 格式规范

- 内部标识：`fountain-syntax`。
- 用途：提供 Fountain 剧本语法、格式规则与排版参考。
- 完整规则：[source-SKILL.md](modules/fountain-syntax/source-SKILL.md)。
- 支持资料根：`references/modules/fountain-syntax/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 影视术语参考

- 内部标识：`glossary-reference`。
- 用途：查询电影、电视、编剧和制作术语。
- 完整规则：[source-SKILL.md](modules/glossary-reference/source-SKILL.md)。
- 支持资料根：`references/modules/glossary-reference/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 一句话故事设计

- 内部标识：`logline`。
- 用途：提炼故事主角、目标、阻力与吸引力，生成一句话故事。
- 完整规则：[source-SKILL.md](modules/logline/source-SKILL.md)。
- 支持资料根：`references/modules/logline/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本篇幅估算

- 内部标识：`page-estimation`。
- 用途：估算剧本页数、篇幅和片长。
- 完整规则：[source-SKILL.md](modules/page-estimation/source-SKILL.md)。
- 支持资料根：`references/modules/page-estimation/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本提案设计

- 内部标识：`pitch-worksheet`。
- 用途：整合故事概念、结构、人物与商业价值，准备提案。
- 完整规则：[source-SKILL.md](modules/pitch-worksheet/source-SKILL.md)。
- 支持资料根：`references/modules/pitch-worksheet/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 场景冲突分析

- 内部标识：`power-analysis`。
- 用途：分析场景权力、对抗关系、张力与利害。
- 完整规则：[source-SKILL.md](modules/power-analysis/source-SKILL.md)。
- 支持资料根：`references/modules/power-analysis/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本系统改写

- 内部标识：`rewriting-methodology`。
- 用途：按六步流程检查故事线、场景、对白与终稿质量。
- 完整规则：[source-SKILL.md](modules/rewriting-methodology/source-SKILL.md)。
- 支持资料根：`references/modules/rewriting-methodology/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本逐场分析

- 内部标识：`scene-analysis`。
- 用途：拆解场景节拍、节奏、功能与状态变化。
- 完整规则：[source-SKILL.md](modules/scene-analysis/source-SKILL.md)。
- 支持资料根：`references/modules/scene-analysis/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本场景标题

- 内部标识：`scene-headings`。
- 用途：规范内外景、地点、时间与连续场景标题。
- 完整规则：[source-SKILL.md](modules/scene-headings/source-SKILL.md)。
- 支持资料根：`references/modules/scene-headings/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 故事完整性校验

- 内部标识：`story-check`。
- 用途：通过 12 个核心问题评估概念、主题、人物、动机和结局。
- 完整规则：[source-SKILL.md](modules/story-check/source-SKILL.md)。
- 支持资料根：`references/modules/story-check/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 三幕结构设计

- 内部标识：`story-structure`。
- 用途：规划三幕结构、故事节拍与关键节点。
- 完整规则：[source-SKILL.md](modules/story-structure/source-SKILL.md)。
- 支持资料根：`references/modules/story-structure/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 故事梗概编写

- 内部标识：`synopsis`。
- 用途：将剧本压缩为用于投稿或提案的一页式故事梗概。
- 完整规则：[source-SKILL.md](modules/synopsis/source-SKILL.md)。
- 支持资料根：`references/modules/synopsis/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 故事主题挖掘

- 内部标识：`theme-discovery`。
- 用途：从生活经历、观影共鸣和故事概念中挖掘主题。
- 完整规则：[source-SKILL.md](modules/theme-discovery/source-SKILL.md)。
- 支持资料根：`references/modules/theme-discovery/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本封面规范

- 内部标识：`title-page`。
- 用途：设置剧名、作者、日期等扉页信息及 Fountain 格式。
- 完整规则：[source-SKILL.md](modules/title-page/source-SKILL.md)。
- 支持资料根：`references/modules/title-page/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧本转场设计

- 内部标识：`transitions`。
- 用途：规范剪切、淡入淡出与其他转场的节奏和格式。
- 完整规则：[source-SKILL.md](modules/transitions/source-SKILL.md)。
- 支持资料根：`references/modules/transitions/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 编剧协作讨论

- 内部标识：`writers-room`。
- 用途：以六种专业角色开展前期创意与改写讨论。
- 完整规则：[source-SKILL.md](modules/writers-room/source-SKILL.md)。
- 支持资料根：`references/modules/writers-room/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 跨模型协作是可选能力，需核实 Hermes 子代理及供应商配置。
- 原文默认 Claude 路由并引用 .claude/model-routing.md；需适配 Hermes 子代理和模型权限，不能照抄上线路径。
