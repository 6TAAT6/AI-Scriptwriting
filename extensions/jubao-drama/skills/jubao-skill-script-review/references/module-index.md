# 内部模块目录

本目录用于选择当前任务资料，不要求一次加载所有模块。所列入口均为完整上游规则的保留副本；每次完整读取选中的 source-SKILL.md，再完整读取该任务实际需要的支持文档。

## 人物小传生成

- 内部标识：`character-profile`。
- 用途：人物小传生成
- 完整规则：[source-SKILL.md](modules/character-profile/source-SKILL.md)。
- 支持资料根：`references/modules/character-profile/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 人物关系分析

- 内部标识：`character-relationships`。
- 用途：人物关系分析
- 完整规则：[source-SKILL.md](modules/character-relationships/source-SKILL.md)。
- 支持资料根：`references/modules/character-relationships/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 竖屏短剧评估

- 内部标识：`drama-evaluator`。
- 用途：竖屏短剧评估
- 完整规则：[source-SKILL.md](modules/drama-evaluator/source-SKILL.md)。
- 支持资料根：`references/modules/drama-evaluator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## IP 改编价值评估

- 内部标识：`ip-evaluator`。
- 用途：IP 改编价值评估
- 完整规则：[source-SKILL.md](modules/ip-evaluator/source-SKILL.md)。
- 支持资料根：`references/modules/ip-evaluator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 影视剧本评估

- 内部标识：`script-evaluator`。
- 用途：影视剧本评估
- 完整规则：[source-SKILL.md](modules/script-evaluator/source-SKILL.md)。
- 支持资料根：`references/modules/script-evaluator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 故事大纲评估

- 内部标识：`story-outline-evaluator`。
- 用途：故事大纲评估
- 完整规则：[source-SKILL.md](modules/story-outline-evaluator/source-SKILL.md)。
- 支持资料根：`references/modules/story-outline-evaluator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 短剧知识库查询

- 内部标识：`knowledge-query`。
- 用途：短剧知识库查询
- 完整规则：[source-SKILL.md](modules/knowledge-query/source-SKILL.md)。
- 支持资料根：`references/modules/knowledge-query/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 需绑定真实知识库，不能把规则文件视为已接通查询服务。

## 短剧市场检索

- 内部标识：`web-search`。
- 用途：短剧市场检索
- 完整规则：[source-SKILL.md](modules/web-search/source-SKILL.md)。
- 支持资料根：`references/modules/web-search/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 需接入 Hermes 可用的检索路径，不能假定 hosted web_search 可用。

## 小说故事评估

- 内部标识：`novel-evaluator`。
- 用途：小说故事评估
- 完整规则：[source-SKILL.md](modules/novel-evaluator/source-SKILL.md)。
- 支持资料根：`references/modules/novel-evaluator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 小说大纲提炼

- 内部标识：`novel-summarizer`。
- 用途：小说大纲提炼
- 完整规则：[source-SKILL.md](modules/novel-summarizer/source-SKILL.md)。
- 支持资料根：`references/modules/novel-summarizer/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 小说文本截断

- 内部标识：`novel-truncator`。
- 用途：小说文本截断
- 完整规则：[source-SKILL.md](modules/novel-truncator/source-SKILL.md)。
- 支持资料根：`references/modules/novel-truncator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 评分汇总分析

- 内部标识：`score-analyzer`。
- 用途：评分汇总分析
- 完整规则：[source-SKILL.md](modules/score-analyzer/source-SKILL.md)。
- 支持资料根：`references/modules/score-analyzer/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 分析报告整理

- 内部标识：`output-formatter`。
- 用途：分析报告整理
- 完整规则：[source-SKILL.md](modules/output-formatter/source-SKILL.md)。
- 支持资料根：`references/modules/output-formatter/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 多项分析整合

- 内部标识：`result-integrator`。
- 用途：多项分析整合
- 完整规则：[source-SKILL.md](modules/result-integrator/source-SKILL.md)。
- 支持资料根：`references/modules/result-integrator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 剧集拉片分析

- 内部标识：`series-analyzer`。
- 用途：剧集拉片分析
- 完整规则：[source-SKILL.md](modules/series-analyzer/source-SKILL.md)。
- 支持资料根：`references/modules/series-analyzer/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 详细情节点分析

- 内部标识：`detailed-plot-analyzer`。
- 用途：详细情节点分析
- 完整规则：[source-SKILL.md](modules/detailed-plot-analyzer/source-SKILL.md)。
- 支持资料根：`references/modules/detailed-plot-analyzer/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 戏剧功能分析

- 内部标识：`drama-analyzer`。
- 用途：戏剧功能分析
- 完整规则：[source-SKILL.md](modules/drama-analyzer/source-SKILL.md)。
- 支持资料根：`references/modules/drama-analyzer/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 主线情节点提炼

- 内部标识：`plot-keypoints`。
- 用途：主线情节点提炼
- 完整规则：[source-SKILL.md](modules/plot-keypoints/source-SKILL.md)。
- 支持资料根：`references/modules/plot-keypoints/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 情节点分析

- 内部标识：`plot-points-analyzer`。
- 用途：情节点分析
- 完整规则：[source-SKILL.md](modules/plot-points-analyzer/source-SKILL.md)。
- 支持资料根：`references/modules/plot-points-analyzer/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 故事五元素分析

- 内部标识：`story-five-elements`。
- 用途：故事五元素分析
- 完整规则：[source-SKILL.md](modules/story-five-elements/source-SKILL.md)。
- 支持资料根：`references/modules/story-five-elements/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 故事大纲生成

- 内部标识：`story-outliner`。
- 用途：故事大纲生成
- 完整规则：[source-SKILL.md](modules/story-outliner/source-SKILL.md)。
- 支持资料根：`references/modules/story-outliner/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 故事梗概生成

- 内部标识：`story-summarizer`。
- 用途：故事梗概生成
- 完整规则：[source-SKILL.md](modules/story-summarizer/source-SKILL.md)。
- 支持资料根：`references/modules/story-summarizer/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 题材与创意提炼

- 内部标识：`story-type-analyzer`。
- 用途：题材与创意提炼
- 完整规则：[source-SKILL.md](modules/story-type-analyzer/source-SKILL.md)。
- 支持资料根：`references/modules/story-type-analyzer/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 文件引用解析

- 内部标识：`file-reference`。
- 用途：文件引用解析
- 完整规则：[source-SKILL.md](modules/file-reference/source-SKILL.md)。
- 支持资料根：`references/modules/file-reference/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 故事思维导图

- 内部标识：`mind-map-generator`。
- 用途：故事思维导图
- 完整规则：[source-SKILL.md](modules/mind-map-generator/source-SKILL.md)。
- 支持资料根：`references/modules/mind-map-generator/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 原包依赖 generateTreeMind，当前还未适配其服务。

## 长文本分块

- 内部标识：`text-splitter`。
- 用途：长文本分块
- 完整规则：[source-SKILL.md](modules/text-splitter/source-SKILL.md)。
- 支持资料根：`references/modules/text-splitter/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 长文本截断

- 内部标识：`text-truncator`。
- 用途：长文本截断
- 完整规则：[source-SKILL.md](modules/text-truncator/source-SKILL.md)。
- 支持资料根：`references/modules/text-truncator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 情节点戏剧分析流程

- 内部标识：`drama-workflow`。
- 用途：情节点戏剧分析流程
- 完整规则：[source-SKILL.md](modules/drama-workflow/source-SKILL.md)。
- 支持资料根：`references/modules/drama-workflow/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 情节大纲细化流程

- 内部标识：`plot-workflow`。
- 用途：情节大纲细化流程
- 完整规则：[source-SKILL.md](modules/plot-workflow/source-SKILL.md)。
- 支持资料根：`references/modules/plot-workflow/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

