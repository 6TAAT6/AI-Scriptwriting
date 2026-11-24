# 内部模块目录

本目录用于选择当前任务资料，不要求一次加载所有模块。所列入口均为完整上游规则的保留副本；每次完整读取选中的 source-SKILL.md，再完整读取该任务实际需要的支持文档。

## 剧本导演工作室

- 内部标识：`script-writing-studio`。
- 用途：串联中文剧本、剧本诊断、台词、资产、分镜、视频提示词与声音设计。
- 完整规则：[source-SKILL.md](modules/script-writing-studio/source-SKILL.md)。
- 支持资料根：`references/modules/script-writing-studio/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## Seedance 剧本分镜

- 内部标识：`seedance-storyboard-generator`。
- 用途：生成 Seedance 2.0 剧本、分集、角色场景资产与分镜提示词。
- 完整规则：[source-SKILL.md](modules/seedance-storyboard-generator/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-storyboard-generator/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## AI 短剧制作

- 内部标识：`ai-short-drama`。
- 用途：统筹短剧 IP 创作、参考图、分镜图和分集视频制作。
- 完整规则：[source-SKILL.md](modules/ai-short-drama/source-SKILL.md)。
- 支持资料根：`references/modules/ai-short-drama/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 出图与出片阶段依赖外部媒体服务和配套脚本；仅安装不代表媒体服务已接通。

## 漫剧图片生成

- 内部标识：`generate-media`。
- 用途：按已有作品目录调用 Google Gemini 生成角色图和分镜图。
- 完整规则：[source-SKILL.md](modules/generate-media/source-SKILL.md)。
- 支持资料根：`references/modules/generate-media/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 依赖 Google Gemini API、模型配置及可用授权。

## 漫剧剧本制作

- 内部标识：`produce-anime`。
- 用途：生成 25 集短剧的剧本、角色设定、九宫格分镜与故事板配置。
- 完整规则：[source-SKILL.md](modules/produce-anime/source-SKILL.md)。
- 支持资料根：`references/modules/produce-anime/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 音乐视频分镜

- 内部标识：`produce-mv`。
- 用途：从歌词或 MV 剧本生成分镜、故事板与 Seedance 视频任务。
- 完整规则：[source-SKILL.md](modules/produce-mv/source-SKILL.md)。
- 支持资料根：`references/modules/produce-mv/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 视频任务提交与生成需另行核实 Seedance 服务接入。

## 漫剧任务提交

- 内部标识：`submit-anime-project`。
- 用途：读取全剧 Seedance 任务文件，批量提交并生成提交报告。
- 完整规则：[source-SKILL.md](modules/submit-anime-project/source-SKILL.md)。
- 支持资料根：`references/modules/submit-anime-project/`；原规则里的相对路径从此处解析。
- 接入状态：需要工具适配，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

- 依赖 Seedance 任务服务 /api/tasks/push，必须配置测试目标且按用户授权提交。

## 短视频开场钩子

- 内部标识：`seedance-viral-hook`。
- 用途：为 Seedance 2.0 设计吸引注意力的短视频开场提示词。
- 完整规则：[source-SKILL.md](modules/seedance-viral-hook/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-viral-hook/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 产品发布视频

- 内部标识：`seedance-saas-launch`。
- 用途：设计软件或产品发布、功能演示与宣传视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-saas-launch/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-saas-launch/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 个人品牌视频

- 内部标识：`seedance-personal-brand`。
- 用途：设计个人品牌、创始人故事与日常记录视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-personal-brand/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-personal-brand/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 课程宣传视频

- 内部标识：`seedance-course-promo`。
- 用途：设计课程预告、培训推广与教育产品宣传提示词。
- 完整规则：[source-SKILL.md](modules/seedance-course-promo/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-course-promo/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 旁白叙事视频

- 内部标识：`seedance-faceless-channel`。
- 用途：设计不露脸的旁白、素材画面与短视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-faceless-channel/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-faceless-channel/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 高端品牌视频

- 内部标识：`seedance-luxury-aesthetic`。
- 用途：设计高端产品、品牌形象与精致美学视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-luxury-aesthetic/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-luxury-aesthetic/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 前后对比视频

- 内部标识：`seedance-before-after`。
- 用途：设计变身、改造、翻新与成果揭晓类视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-before-after/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-before-after/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 客户案例视频

- 内部标识：`seedance-testimonial-story`。
- 用途：设计客户故事、评价展示与成功案例视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-testimonial-story/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-testimonial-story/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 虚拟人物视频

- 内部标识：`seedance-ai-avatar`。
- 用途：设计虚拟代言人、数字分身与 AI 主持视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-ai-avatar/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-ai-avatar/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## 播客可视化视频

- 内部标识：`seedance-podcast-visual`。
- 用途：把播客、访谈或音频片段转换为可视化视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-podcast-visual/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-podcast-visual/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。


## TVC 广告导演

- 内部标识：`seedance-tvc-director`。
- 用途：将品牌简报转为 Seedance 2.5 广告创意、分镜和视频提示词。
- 完整规则：[source-SKILL.md](modules/seedance-tvc-director/source-SKILL.md)。
- 支持资料根：`references/modules/seedance-tvc-director/`；原规则里的相对路径从此处解析。
- 接入状态：文本规则候选，仅文本方法已纳入本入口，原包脚本和外部服务未执行或接通。

