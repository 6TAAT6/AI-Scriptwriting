# 类别映射表：SKILL.md ↔ detector

本表是 `../SKILL.md` 中人类可读规则与 `patterns.js` 中可执行引擎之间的防漂移契约。当你在 skill 中新增一条规则时，需要在此处判定它是否可由正则检测（若是，给它一个 detector `type`），还是只能由 LLM 判断（标注为 LLM-only）。当你在 detector 中新增一个 `type` 时，要回链到它所执行的 skill 章节。

引擎暴露了 47 个 issue `type`（见 `patterns.js` 中的 `TYPE_LABELS`）。skill 的 `###` 章节数量多于这个数——这个差距**不是**覆盖遗漏，而是那些属于正则无法做出的判断性规则。下面三组涵盖了双方每一项条目。

三个计数有意并存，不应强行对齐：README 的**模式类别计数**（面向人类的散文目录，派生自 SKILL.md 并由 CI 守护）、引擎的 **47 个 `type`**（它们细分了词表级别并加入了计量文体学信号），以及 SKILL.md 的 `###` 章节（其中还包含无可检测形态的写作侧测试）。`categories.test.js` 强制执行「引擎 ↔ 本文件」的映射，并把每个关于引擎 `type` 总数的散文式陈述与 `TYPE_LABELS` 进行核对。

## A. 直接映射（skill 规则 → detector `type`）

| Detector `type` | 标签 | SKILL.md 章节 |
|---|---|---|
| `tier1` / `tier2` / `tier3` | AI 词表 / 词簇 / 滥用词 | 需替换的词与短语 |
| `tier1-clarity` | 冗赘 | 需替换的词与短语（Tier 1B） |
| `transition` | AI 过渡词 | 需删除或改写的过渡短语 |
| `template-phrase` | 模板套话 | 模板套话（避免使用） |
| `tier3-phrase` / `tier3-phrase-cluster` | 套话短语 / 短语簇 | 模板套话（避免使用） |
| `chatbot` | 聊天机器人残留 | 聊天机器人残留 |
| `sycophantic` | 谄媚语气 | 谄媚语气 |
| `acknowledgment-loop` | 致谢循环 | 致谢循环 |
| `filler` | 填充词 | 填充词 |
| `hollow-intensifier` | 空洞强调词 | 填充词（强调词） |
| `generic-conclusion` | 通用式结论 | 通用式结论 |
| `social-cta-closer` | 互动诱饵式收尾 | 社交背书式收尾 |
| `future-narrative` | 通用式未来叙事 | 通用式未来叙事收尾 |
| `lets-construction` | "Let's" 式开场 | "Let's" 式句构 |
| `reasoning-artifact` | 推理残留 | 推理链残留 |
| `significance-inflation` | 意义拔高 | 意义拔高 |
| `novelty-inflation` | 新颖性拔高 | 新颖性拔高 *（其中「生造概念标签」子规则仅由 LLM 判断——开放式造词无法用正则匹配）* |
| `real-actual-inflation` | "Real/actual" 滥用 | "Real/actual" 形容词滥用 |
| `vague-attribution` | 模糊归因 | 模糊归因 |
| `emotional-flatline` | 情感平直 | 情感平直 / 表面化 -ing 分析 |
| `lingering-attention` | 萦绕式关注陈述 | 萦绕式关注陈述 *（仅限名词锚定的框架——裸的 "I keep coming back to X" 仍由 LLM 判断，因为其后若跟一个原因从句就变成正当表达，无法用正则区分）* |
| `cutoff-disclaimer` | 截止日期免责声明 | 截止日期免责声明 |
| `false-concession` | 虚假让步 | 虚假让步结构 |
| `rhetorical-question` | 反问句 | 反问式开场 |
| `formulaic-opener` | 套话式开场 | 套话式挑战 |
| `speculative-opener` | 推测式场景开场 | 推测式场景开场 |
| `confidence-calibration` | 信心堆叠 | 信心校准短语 |
| `hedge-stack` | 对冲堆叠式预测 | 对冲堆叠式预测 |
| `parenthetical-hedge` | 括号式对冲 | 括号式对冲措辞 |
| `hashtag-stuff` | 标签堆砌 | 标签堆砌 |
| `bullet-np-list` | 项目符号名词短语列 | 裸名词短语的项目符号列表 |
| `title-case-header` | Title Case 标题 | Title Case 标题 |
| `em-dash` / `formatting` | 破折号滥用 / 格式化 | 格式化 |
| `uniformity` | 节奏均一 | 节奏与均一度 |
| `low-ttr` | 词表多样性低 | 词表多样性（计量文体学） |
| `ai-placeholder` | 未填充占位符 | 未填充的占位符 |
| `ai-citation-markup` | 聊天机器人引用标记泄漏 | 聊天机器人引用标记泄漏 |
| `ai-utm-source` | AI 工具 URL 参数 | AI 工具 URL 参数 |
| `smart-punct-signature` | 智能标点特征 | 格式化（弯引号）—*部分*映射 |

> **部分映射：** `smart-punct-signature` 仅在弯引号同时与破折号、牛津逗号和干净的输入（≥80 词）一起出现时才触发——绝不会单独因弯标点而触发。SKILL.md 的 Formatting 规则把弯引号当作纯文本语境下的弱佐证信号，并排除撇号。二者在精神上是一致的（弯标点本身从不是定论），但机制不同——所以这是部分映射，而非 1:1。

## B. 仅引擎（计量文体学 / 指纹——skill 中无散文说明）

这些用对整篇文档做数学运算的信号来扩展 skill，而不是人类编辑会去查的某个短语：

| Detector `type` | 标签 | 为何只在引擎中 |
|---|---|---|
| `punct-distribution` | 标点分布 | 每段标点的均一度 |
| `fnword-trigram-entropy` | 语法重复 | 功能词三元组的熵 |
| `cross-para-burstiness` | 跨段落节奏 | 跨段落的句长波动 |
| `normalization-flag` | 绕过伎俩字符 | 零宽字符 / 同形字绕过去AI味工具的检测 |

## C. 仅 skill（LLM 判断——无 detector `type`）

这些规则需要读出语义，所以它们存在于 skill 的散文说明里，由模型而非正则引擎来执行。此处列出，以免未来的贡献者把它们的缺失误当成覆盖遗漏：

- 同义词轮换
- 回避系动词
- 广告腔
- 句式结构："It's not X — it's Y" / 拆分句式 / 多重否定倒计时 / 尾随否定
- 结构性问题 / 结构过度 / 内嵌标题列表 / 编号列表膨胀
- 道德形容词的范畴错误（包括对假设的本体论式 AI 泔水、无端的全称量词）
- 生造对立对镜像
- 虚假区间
- 堆砌名头
- 模糊的第三方背书
- 自贴意义的标签
- 大段文字回复（缺少换行） *（曾尝试做成 detector——"reply-length，>=4 句，零换行"——后被撤销；它会对任何普通的短段落触发，而不只是对话回复语域，于是保持为仅判断。见 `patterns.js` 中 bullet-NP-list 块附近的 NOTE）*
- 复述吹捧式开场
- 自述坦诚 *（曾尝试做成 detector 后撤销：其措辞与地道的利益冲突披露（"in the interest of full disclosure, I own shares in..."）以及普通英语比较句（"I'd rather die than let you drive"）共用，因此任何紧到能避开上述用法的正则也匹配不到这条痕迹。判断它需要读出该从句是否承载信息，还是只宣告信息即将到来）*
- 随用语域中的无瑕排版 *（并入 Formatting 章节——与弯引号同属弱信号级别，不单列一类）*
- 无主语片段与无施事被动 *（文档和变更日志语域为例外情形——片段在那里才是正确形式）*
- Diff 锚定式写作 *（变更日志、发行说明、迁移指南为例外情形）*
- 人造抖包袱 / 短促戏剧化句式
- 格言公式 *（针对 "X is the Y of Z" 的正则会误标普通的所有格系动词——"Paris is the capital of France"）*
- 何时从零改写 vs. 打补丁
- 严重性分级（P0 / P1 / P2）
- 自我引用逃生口
- 输出格式

> **部分映射：** skill 的**语境画像 / 容忍度矩阵 / 自动检测线索**部分由引擎的 `options.contextMode`（`general` / `technical`）实现，它会抑制语境不当的标记。完整的画像式容忍度仍属于 LLM 侧判断。
