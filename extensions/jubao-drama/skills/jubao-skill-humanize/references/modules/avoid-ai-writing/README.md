<div align="center">

# avoid-ai-writing

审查并改写内容以去除 AI 写作痕迹。适用于任何 AI agent 的实用 skill。支持仅检测与原地编辑两种模式，并支持文风配置。

[![GitHub stars](https://img.shields.io/github/stars/conorbronsdon/avoid-ai-writing?style=social)](https://github.com/conorbronsdon/avoid-ai-writing/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![X](https://img.shields.io/badge/X-@ConorBronsdon-black?style=flat-square&logo=x)](https://x.com/ConorBronsdon)

<img src="docs/demo.gif" alt="The bundled detector engine flagging 13 AI-writing patterns by category in a sample paragraph, then scoring the clean rewrite 0/100" width="800">
</div>

---


一个可移植的写作 skill，适用于 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[OpenClaw](https://github.com/openclaw/openclaw)、[Hermes](https://github.com/NousResearch/hermes-agent) 以及任何兼容 [agentskills.io](https://agentskills.io) 的 agent。用于审查并改写内容，去除 AI 写作痕迹（"AI-isms"，即 AI 腔）。

**三种模式：**
- **改写（Rewrite，默认）**——标记 AI 痕迹并改写文本加以修复。内置二次复审会捕获第一次改写后仍残留的痕迹。
- **检测（Detect）**——只标记 AI 痕迹，不改写。会标明哪些标记是真正的问题、哪些属于判断取舍。适用于痕迹可能是有意为之、审查不希望被改动的内容，或只是想快速扫描时。
- **编辑（Edit）**——通过 Edit 工具就地编辑文件，做最小化的针对性修改，保留已经像人写的段落。返回"已做修改 + 验证"报告，而非整个文件。

可选的 **文风配置**（casual 随意 / professional 专业 / technical 技术 / warm 温暖 / blunt 直白）决定文字应有的听感，与受众上下文配置相互独立。

## 快速演示

**输入：**
> Certainly! Acme Analytics, a vibrant startup nestled in the heart of Boulder's thriving tech ecosystem, has secured $40M in Series B funding — marking a watershed moment for the observability landscape. The platform serves as a unified hub, featuring real-time dashboards, boasting sub-second queries, and presenting a seamless integration layer. Moreover, experts believe Acme is poised to disrupt the market. In conclusion, the future looks bright!
> 译：当然！Acme Analytics 是一家充满活力的初创公司，坐落于博尔德蓬勃发展的科技生态核心地带，已获得 4000 万美元 B 轮融资——这是可观测性领域具有分水岭意义的时刻。该平台充当统一枢纽，提供实时仪表盘，宣称查询低于一秒，并呈现无缝的集成层。此外，专家认为 Acme 有望颠覆市场。总之，未来一片光明！

**输出：**
> Acme Analytics raised a $40M Series B led by Sequoia. The Boulder-based startup makes an observability platform that runs queries in under a second and plugs into existing monitoring stacks without custom integration work.
> 译：Acme Analytics 完成了一轮由 Sequoia 领投的 4000 万美元 B 轮融资。这家位于博尔德的初创公司做的是可观测性平台，查询低于一秒，且无需自定义集成工作即可接入现有的监控技术栈。

**它捕获到了什么：** 聊天机器人开场白（"Certainly!"）、广告腔（"vibrant"、"nestled"、"thriving"）、意义拔高（"watershed moment"）、回避系动词（"serves as"、"featuring"、"boasting"）、4 处词汇替换、模糊归因（"experts believe"）、填充词（"Moreover"）、套话式结尾（"the future looks bright"）、过度打磨的整齐划一。一段话里就有 15 处以上的 AI 痕迹。

## 为什么是 skill，而不只是一段提示词

一段一次性的"让这段听起来像人写的"提示词只能抓住明显的东西。本 skill 不一样：

- **结构化审查**——以四个独立小节返回已识别的问题，包含原文引用、改写结果、修改摘要以及二次复审。你能清楚地看到改了什么、为什么改。
- **两轮检测**——第二轮会重读改写结果，捕获第一次改写后仍残留的痕迹：被复用的过渡词、尚未消除的意义拔高、偷偷溜进来的系动词替换。
- **112 条词汇替换表，分 3 个级别，外加 10 个 Tier 3 短语**——不是凭感觉。每个被标记的词都有具体、更平实的替代说法。"Leverage" → "use"；"Commence" → "start"。Tier 1 词一律标记，Tier 2 词在成堆出现时才标记，Tier 3 词只在高密度时才标记。Tier 1 内部再分为 **1A 频率标记词**（`delve`、`tapestry`）和 **1B 清晰度修改词**（`in order to`、`utilize`）——修改方式相同，但只有 1A 能作为"一段文字是怎么被生产出来的"证据，1B 权重更低，这样一个啰嗦词修复就不会把文档推向 AI 分类。Tier 3 *短语*（如 "the integration of"、"decentralized compute" 这类多词套话）按每个短语重复出现或单篇中出现 3 个以上不同短语堆叠时才标记——也就是"LLM 自我变换套话"的形态。
- **61 个模式类别**——下面给出有代表性的示例，每个都附 before/after。包括结构性检测（话题标签堆砌、光秃秃的名词短语项目符号列表、对冲堆叠的预测）、AI 工具指纹（占位符、引用标记、UTM 参数）、节奏/整齐度检查、口语语域痕迹，以及面向写作者的自检。完整目录位于 [`SKILL.md`](./SKILL.md)；这个数字会由 CI 对照该文件强制校验。
- **检测模式**——只标记痕迹不改写。看清哪些标记是真正的问题、哪些属于判断取舍。适用于痕迹可能是有意为之，或你正在审查不希望被改动的内容时。
- **跨平台通用**——一份 `SKILL.md` 即可在 Claude Code、Cowork（作为插件）、OpenClaw 和 Cursor（作为移植规则）中运行。安装方式见下文。

## 安装与使用

### Claude Code

**方式 1：克隆到 skills 目录**

```bash
git clone https://github.com/conorbronsdon/avoid-ai-writing ~/.claude/skills/avoid-ai-writing
```

**方式 2：直接复制文件**

下载 `SKILL.md` 并放到 Claude Code 可读取的任意目录。在你的 `CLAUDE.md` 中引用它：

```markdown
- Editing for AI patterns → read `path/to/avoid-ai-writing/SKILL.md`
```

**方式 3：作为 slash 命令使用**

创建一个命令文件（例如 `~/.claude/commands/clean-ai-writing.md`）：

```markdown
---
description: Audit and rewrite content to remove AI writing patterns
---

$ARGUMENTS

Read and follow the instructions in ~/.claude/skills/avoid-ai-writing/SKILL.md
```

然后在 Claude Code 中使用 `/clean-ai-writing <你的文本>`。

### Claude Cowork —— 作为插件安装

[Cowork](https://www.anthropic.com/cowork) 只从**已安装的插件**加载 skill——它不会扫描 `~/.claude/skills/`，所以单纯克隆（即上面 Claude Code 的步骤）在那里不会被识别。本仓库同时也是一个单插件的 [marketplace](https://code.claude.com/docs/en/plugin-marketplaces)，因此把它当作插件安装即可：

```bash
/plugin marketplace add conorbronsdon/avoid-ai-writing
/plugin install avoid-ai-writing@conorbronsdon-skills
/reload-plugins   # 或重启会话以激活 skill
```

在 Cowork 桌面应用中，从 **Customize → Plugins → Add marketplace from GitHub**（`conorbronsdon/avoid-ai-writing`）做同样操作，然后安装 **avoid-ai-writing**。该 skill 会从诸如"remove AI-isms"这类短语自动触发。插件版本号升级时即发布新版本——运行 `/plugin marketplace update` 拉取。

如果你更希望拥有一个带版本号、可更新的插件，而非上面的文件克隆，则同样的插件安装方式也适用于 Claude Code。

> 不想装插件？把 `SKILL.md` 复制到一个与你的 Cowork 会话相连的文件夹，告诉 agent 遵循 `./SKILL.md`——作为一次性方案使用，不会自动触发。

### OpenClaw

**方式 1：[从 ClawHub 安装](https://clawhub.ai/conorbronsdon/avoid-ai-writing)**

```bash
clawhub install avoid-ai-writing
```

**方式 2：克隆到 skills 目录**

```bash
git clone https://github.com/conorbronsdon/avoid-ai-writing ~/.openclaw/skills/avoid-ai-writing
```

### Cursor

把移植版规则放到你项目的 `.cursor/rules/` 下：

```bash
mkdir -p .cursor/rules
curl -o .cursor/rules/avoid-ai-writing.mdc \
  https://raw.githubusercontent.com/conorbronsdon/avoid-ai-writing/main/cursor-rules/avoid-ai-writing.mdc
```

激活用的 glob 与触发短语见 [`cursor-rules/README.md`](./cursor-rules/README.md)。功能上与 Claude Code skill 完全一致——同一套分级词表、同一套上下文配置、同一套模式。

### Hermes

把 skill 放到 Hermes 的 skills 目录下——它会自动以 `/avoid-ai-writing` 出现，无需注册：

```bash
mkdir -p ~/.hermes/skills/writing/avoid-ai-writing
curl -o ~/.hermes/skills/writing/avoid-ai-writing/SKILL.md \
  https://raw.githubusercontent.com/conorbronsdon/avoid-ai-writing/main/SKILL.md
```

### OpenAI Codex

Codex 以相同的 `SKILL.md` 格式读取 [Agent Skills](https://developers.openai.com/codex/skills)。把它放到仓库根目录的 `.agents/skills/` 下，或放到 `~/.agents/skills/` 以在所有项目中使用：

```bash
mkdir -p .agents/skills/avoid-ai-writing
curl -o .agents/skills/avoid-ai-writing/SKILL.md \
  https://raw.githubusercontent.com/conorbronsdon/avoid-ai-writing/main/SKILL.md
```

### 其他 agent

同一份 `SKILL.md`（或 Cursor 的 `.mdc` 移植版）可以放进大多数工具的 rules/skills 位置：

| 工具 | 放在哪里 |
|------|-----------------|
| **Windsurf** | `.windsurf/rules/avoid-ai-writing.md` |
| **Cline** | `.clinerules/avoid-ai-writing.md` |
| **GitHub Copilot**（VS Code） | 粘贴进 `.github/copilot-instructions.md` |
| **Claude.ai Projects** | 把 `SKILL.md` 粘贴进项目的自定义指令 |
| **ChatGPT Custom GPTs** | 把 `SKILL.md` 粘贴进 GPT 的 Instructions 字段 |

### 触发 skill

安装完成后，让你的助手清理 AI 写作：

- "Remove AI-isms from this post"（去掉这篇文章里的 AI 腔）
- "Audit this draft for AI tells"（审查这份草稿的 AI 痕迹）
- "Make this sound less like AI"（让这段听起来不那么像 AI）
- "Clean up AI writing in this paragraph"（清理这段中的 AI 写作）

在**改写模式**（默认）下，skill 返回四个小节：

1. **发现的问题**——识别到的每一处 AI 腔，附带引用的原文
2. **改写版本**——去除所有 AI 腔的干净版本
3. **改了什么**——主要修改的摘要
4. **二次审查**——重读改写结果，捕获任何残留的痕迹

在**检测模式**下，skill 返回两个小节：

1. **发现的问题**——识别到的每一处 AI 腔，按严重程度分组（P0/P1/P2）
2. **评估**——哪些标记是明显的问题，哪些可能是有意为之或在当前语境中有效

用以下方式触发检测模式："detect"、"flag only"、"audit only"、"just flag"、"scan" 或类似说法。

## 模式参考

> 下面是目录中的代表性示例——并非穷尽清单（完整清单见 [`SKILL.md`](./SKILL.md)）。skill 面向人类的散文目录与[检测引擎](./detector/)的计数**有意不同**：引擎实现了 47 个 `type` 类别，因为它把词表分级拆开，并加入了计量文体学/指纹类信号（标点分布、虚词熵、绕过手法检测），这些是作用于一篇文档的数学运算，而非可查阅的规则。两者在 [`detector/CATEGORIES.md`](./detector/CATEGORIES.md) 中有映射；不要"修"其中一个计数去对齐另一个。

### 内容模式

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 1 | **意义拔高 (Significance inflation)** | "marking a pivotal moment in the evolution of..." | "was founded in 2019 to solve X"（2019 年为解决 X 而成立） |
| 2 | **堆砌名头 (Notability name-dropping)** | "cited in NYT, BBC, and Wired" | "In a 2024 NYT interview, she argued..."（在 2024 年一次 NYT 访谈中，她论证了……） |
| 3 | **浅薄 -ing 分析 (Superficial -ing analyses)** | "symbolizing... reflecting... showcasing..." | 用具体事实替换，或直接删掉 |
| 4 | **广告腔 (Promotional language)** | "nestled within the breathtaking region" | "is a town in the Gonder region"（是 Gonder 地区的一个镇） |
| 5 | **模糊归因 (Vague attributions)** | "Experts believe it plays a crucial role" | "according to a 2019 survey by Gartner"（据 Gartner 2019 年的一项调查） |
| 6 | **套话式挑战 (Formulaic challenges)** | "Despite challenges... continues to thrive" | 点明挑战和应对 |
| 7 | **新奇拔高 (Novelty inflation)** | "He introduced a term I hadn't heard before" | "He walked through how X works in practice"（他演示了 X 实际怎么运作） |

### 语言模式

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 8 | **词汇/短语替换（3 个级别）** | "leverage... robust... seamless... utilize" | "use... reliable... smooth... use" |
| 9 | **回避系动词 (Copula avoidance)** | "serves as... features... boasts" | "is... has" |
| 10 | **同义词轮换 (Synonym cycling)** | "developers... engineers... practitioners... builders" | "developers"（重复使用这个清晰的词） |
| 11 | **模板套话 (Template phrases)** | "a [adj] step towards [adj] infrastructure" | 描述具体的结果 |
| 12 | **填充短语 (Filler phrases)** | "In order to," "Due to the fact that" | "To," "Because" |
| 13 | **虚假范围 (False ranges)** | "from the Big Bang to dark matter" | 列出实际的话题 |
| 14 | **括号式对冲 (Parenthetical hedging)** | "tools (like X and Y)" | 直接点名，或删掉 |

### 结构模式

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 15 | **格式** | 破折号（— 与 --）、加粗滥用、emoji 标题、项目符号过多 | 逗号/句号、散文段落 |
| 16 | **句子结构** | "It's not X, it's Y" + 空洞强调词 + 对冲 | 直接的正面陈述 |
| 17 | **结构问题** | 段落整齐划一、套话式开头、过于干净的语法 | 长短变化、把要点放前面 |
| 18 | **过渡短语** | "Moreover," "Furthermore," "In today's [X]" | "and"、"also"，或重构 |
| 19 | **行内小标题列表** | "**Speed:** Speed improved by..." | 直接写出要点 |
| 20 | **标题大小写 (Title case headings)** | "Strategic Negotiations And Partnerships" | "Strategic negotiations and partnerships" |
| 21 | **编号列表膨胀** | "Here are 7 reasons why..." | 砍到真正重要的 2-3 条 |
| 22 | **虚假让步 (False concession)** | "While X has limitations, it's still remarkable" | 说明真正的取舍 |
| 23 | **反问式开头** | "What if there were a better way to...?" | 以主张开头 |

### 沟通模式

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 24 | **聊天机器人痕迹 (Chatbot artifacts)** | "I hope this helps! Let me know if..." | 整段删除 |
| 25 | **"Let's" 句式** | "Let's explore," "Let's break this down" | 直接从要点开始 |
| 26 | **截断式免责声明 (Cutoff disclaimers)** | "While details are limited in available sources..." | 找到来源或删除 |
| 27 | **套话式结尾 (Generic conclusions)** | "The future looks bright," "Only time will tell" | 具体的收尾想法，或删掉 |
| 28 | **情感平线 (Emotional flatline)** | "What surprised me most," "I was fascinated to discover" | 让情感配得上，或删掉该主张 |
| 29 | **推理链痕迹 (Reasoning chain artifacts)** | "Let me think step by step," "Breaking this down" | 先给结论，再给证据 |
| 30 | **谄媚语气 (Sycophantic tone)** | "Great question!", "You're absolutely right!" | 整段删除 |
| 31 | **确认循环 (Acknowledgment loops)** | "You're asking about," "To answer your question" | 直接回答 |
| 32 | **置信度校准 (Confidence calibration)** | "It's worth noting," "Interestingly," "Surprisingly" | 让事实自己说话 |

### 元模式

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 33 | **结构过度** | 200 词里出现 5 个标题，"Overview:"、"Key Points:" | 合并小节，用具体标题 |
| 34 | **节奏与整齐度 (Rhythm and uniformity)** | 所有句子都是 15–25 词，所有段落长度相同 | 长短混搭、短片段、问句 |
| 35 | **过度打磨 (Over-polishing)** | 每一处不规整都被磨平，散文完美整齐 | 保留自然的语顿、变化的节奏 |
| 36 | **改写 vs 修补阈值** | 5+ 处词汇标记 + 3+ 个模式类别 + 节奏整齐 | 建议整体改写，而非打补丁 |

### 结构性检测 (v3.4)

v3.4 中新增，用于捕获那些通过替换同义词绕过词表、却仍依赖检测器可识别的结构形态的 LLM 输出。加密货币/web3/AI 基础设施内容是这些模式最集中的地方，但规则对任何社交长度的帖子都通用。

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 37 | **Tier 3 短语（多词套话）** | "the integration of"、"decentralized compute"、"community-driven"、"long-term sustainability" 在整篇里堆叠出现 | 把重复的短语替换成具体主张，或真正地加以变化。每个短语出现 ≥2 次即标记，或当 ≥3 个不同短语堆叠出现时作为簇标记 |
| 38 | **未来叙事式收尾 (Future-narrative closers)** | "may become one of the most important narratives of the next market cycle" | 选可证伪的版本。"X may exceed Y by 2027"（X 可能到 2027 年超过 Y）是预测；模板形态不是 |
| 39 | **对冲堆叠式预测 (Hedge-stacked predictions)** | "could potentially create," "may eventually unlock" | 选一个。每一个对冲都会抵消下一个 |
| 40 | **"real/actual" 形容词拔高** | "real on-chain tokenomics," "actual reward sustainability" | 删掉空洞强调词，加上具体主张。例外情形："real on-chain settlement, *not* bridged IOUs"（真正的链上结算，*而不是*桥接的欠条）是诚实的对比式写作——AI 痕迹在于那个未说出口的对比 |
| 41 | **话题标签堆砌 (Hashtag stuffing)** | 15 个标签的尾部块：`#AI #Crypto #Web3 #Innovation #FutureTech…` | 最多 2-3 个具体标签，或没有。经验阈值：6+ 个标签在 LLM 社交输出中近乎普遍，在用心的人类帖子中很罕见 |
| 42 | **光秃名词短语项目符号列表 (Bullet lists of bare noun phrases)** | `* Stable mining efficiency / Reliable pool connectivity / Optimized RandomX performance / Low failed share rates / Effective hardware utilization / Consistent thermal stability` | 改成散文，或把每条改写成带动词和数字的完整主张。例外情形：真正的列表内容（更新日志、参数文档、配料表），其中光秃名词短语才是正确的 |

### AI 工具指纹及后续补充 (v3.5–3.8)

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 43 | **未填写的占位符 (Unfilled placeholders)** | `[Your Name]`、`[INSERT SOURCE]`、`2025-XX-XX` | 填入真实内容或删除——发布出去的占位符几乎是决定性的痕迹 |
| 44 | **聊天机器人引用标记 (Chatbot citation markup)** | `citeturn0search0`、`oai_citation`、`contentReference[oaicite:0]` | 整段剥除该标记 token |
| 45 | **AI 工具 URL 参数** | `utm_source=chatgpt.com`、`utm_source=copilot.com` | 剥除跟踪参数；如果链接重要则保留 URL |
| 46 | **投机性填空 (Speculative gap-filling)** | "maintains a low profile," "likely began his career" | 删掉猜测，或替换成有来源的事实 |
| 47 | **连字符对滥用 (Hyphenated-pair overuse)** | "a high-quality, well-architected, future-proof solution" | 只留那个最重要的修饰语；谓语中不加连字符（"the report is high quality"） |
| 48 | **电视购物式钩子 (Infomercial engagement hooks)** | "The catch?", "The kicker?", "Here's the thing." | 删掉钩子，直接说出那件事 |
| 49 | **词汇多样性低（低 TTR）** | 200+ 词中词汇范围狭窄、重复 | 拓宽"写了什么"——点名具体的事物、引用具体的案例 |
| 50 | **自我贴标签式拔高 (Self-labeling significance)** | "That last move is the contrarian one," "This is the interesting part" | 删掉标签；让解释本身承担分量，或重新摆放该项，让它自己立得住 |
| 51 | **列表标签句号 (List-label periods)** | `- **Intros.** Years of conferences and operator network.`（也包括不加粗的：`- Intros. Years of...`） | 列表标签上用冒号，而不是句号：`- **Intros:** years of conferences and operator network.` |

### 口语语域模式 (v3.15)

在一次真实交流之后新增：一位维护者点名指出一条听起来像是 AI 辅助生成的 GitHub issue 回复"我更喜欢人对人地说话"。两者都属于判断取舍，而非可用正则检测的（一段普通的人类段落与一段 AI 生成的段落在结构上可能完全相同；痕迹在于语域和冗余的上下文，而非固定形态）——见 `detector/CATEGORIES.md` §C 注释，了解为何一堵文字检测器的首次尝试被回退了。

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 52 | **一堵文字式回复 (Wall-of-text replies)** | 一段 4+ 句、不足 150 词的回复，作为一个不间断、不换行的段落发出——这是 LLM 在 issue/PR 评论、聊天和私信中的默认形态 | 在思路边界处断开。每一组行写一个想法，像一个人真正敲回复时那样 |
| 53 | **回顾式奉承开头 (Recap-flattery opener)** | "Thanks for all the legwork here — the migration script and the rollback plan you worked through are what made this possible." | 内容优先。如果道谢是应该的，写一个不带回顾的普通从句："Thanks for the legwork — this looks right to me" |

### 分享帖框架 (v3.20)

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 54 | **萦绕式注意力主张 (Lingering-attention claims)** | "The line I keep coming back to:", "I can't stop thinking about this," "this has been rattling around in my head all week" | 从那件事本身开头。例外情形：当后面跟着一个理由时保留这个框架（"I keep coming back to exit-voice because it predicts who quits"） |

### 叙述式坦诚 (v3.21)

| # | 模式 | Before | After |
|---|---------|--------|-------|
| 55 | **叙述式坦诚 (Narrated candor)** | "Two caveats I would rather flag than let you discover later:", "I want to be upfront:" | 直接把注意事项说出来。仅凭判断：同样的词在利益冲突披露里承载的是真实内容（"in the interest of full disclosure, I own shares in…"），正则无法把它和空框架区分开 |

目录最后还有两个面向写作者的**自检**（判断式检查，不自动检测）：**段落重排免疫力**（你能不能互换两个正文段落而不破坏整篇文章？）和**跑步机效应**（"这一段到底有什么新东西？"）。

## 完整示例

**Before（AI 生成）：**

> Certainly! Here's a comprehensive overview of Acme's Series B.
>
> Acme Analytics, a vibrant startup nestled in the heart of Boulder's thriving tech ecosystem, has secured $40M in Series B funding — marking a watershed moment for the company and the observability landscape at large. The round was led by Sequoia, with participation from Andreessen Horowitz, Y Combinator, and Index Ventures, underscoring the robust investor confidence in Acme's vision.
>
> The platform serves as a unified hub for engineering teams, featuring real-time dashboards, boasting sub-second query performance, and presenting a seamless integration layer. It's not just another monitoring tool — it's a paradigm shift in how organizations navigate complex distributed systems. Experts believe Acme is poised to disrupt the $15B observability market. Studies show that companies utilizing comprehensive monitoring solutions can ascertain issues 40% faster.
>
> - 🚀 **Performance:** The platform streamlines incident response, empowering engineers to resolve issues faster.
> - 💡 **Scale:** Acme fosters collaboration across teams, from frontend developers to SRE practitioners to platform builders to infrastructure engineers.
> - ✅ **Adoption:** Customer adoption continues to accelerate, reflecting broader industry trends.
>
> Moreover, Acme's approach showcases the potential of modern observability — symbolizing a shift toward proactive monitoring, reflecting years of R&D investment, and highlighting the intricate interplay between data collection and actionable intelligence. Despite challenges common in the crowded monitoring space, Acme continues to thrive. In order to fully capitalize on this momentum, the company plans to expand its go-to-market endeavors.
>
> In conclusion, the future looks bright for Acme Analytics. Only time will tell how this game-changer will reshape the observability paradigm. Feel free to reach out if you'd like more details!

> 译：当然！这是 Acme B 轮的全面概述。
>
> Acme Analytics 是一家充满活力的初创公司，坐落于博尔德蓬勃发展的科技生态核心地带，已获得 4000 万美元 B 轮融资——这对公司及整个可观测性领域而言都是具有分水岭意义的时刻。本轮融资由 Sequoia 领投，Andreessen Horowitz、Y Combinator 和 Index Ventures 跟投，凸显了投资界对 Acme 愿景的强劲信心。
>
> 该平台充当工程团队的统一枢纽，提供实时仪表盘，宣称查询低于一秒，并呈现一个无缝的集成层。它不只是又一个监控工具——它是组织如何驾驭复杂分布式系统的一次范式转变。专家认为 Acme 有望颠覆 150 亿美元的可观测性市场。研究表明，使用全面监控方案的公司能快 40% 地查明问题。
>
> - 🚀 **性能：** 该平台简化了事件响应，赋能工程师更快地解决问题。
> - 💡 **规模：** Acme 促进跨团队协作，从前端开发者到 SRE 实践者、到平台构建者、再到基础设施工程师。
> - ✅ **采用：** 客户采用持续加速，反映了更广泛的行业趋势。
>
> 此外，Acme 的做法展示了现代可观测性的潜力——象征着向主动监控的转变，反映了多年的研发投入，并突显了数据采集与可执行智能之间错综复杂的相互作用。尽管在拥挤的监控领域面临常见挑战，Acme 仍在继续蓬勃发展。为了充分利用这一势头，公司计划扩展其上市举措。
>
> 总之，Acme Analytics 的未来一片光明。只有时间会告诉我们这个颠覆者将如何重塑可观测性的范式。如需更多细节，欢迎垂询！

**After（清理后）：**

> Acme Analytics raised a $40M Series B led by Sequoia. The Boulder-based startup makes an observability platform that runs queries in under a second and plugs into existing monitoring stacks without custom integration work.
>
> The pitch is speed. Their median time-to-resolution is 12 minutes, compared to the 45-minute industry average that Datadog reported in 2024. That gap is why 380 companies are paying for it.
>
> They'll use the money to hire sales reps in EMEA and add log management. The monitoring market is crowded, but Acme's bet is that most teams still stitch together three or four tools and lose time switching between them.

> 译：Acme Analytics 完成了一轮由 Sequoia 领投的 4000 万美元 B 轮融资。这家位于博尔德的初创公司做的是可观测性平台，查询低于一秒，且无需自定义集成工作即可接入现有的监控技术栈。
>
> 卖点是速度。他们的中位解决时长为 12 分钟，相比 Datadog 在 2024 年报告的 45 分钟行业平均值。这个差距正是 380 家公司付费的原因。
>
> 他们将用这笔钱在 EMEA 招聘销售，并增加日志管理。监控市场很拥挤，但 Acme 押注的是：大多数团队仍在用三四个工具拼凑，并在切换之间浪费时间。

**skill 捕获到了什么：** 聊天机器人痕迹（Certainly!、Feel free to reach out）、3 处破折号、广告腔（vibrant、nestled、thriving）、意义拔高（watershed moment）、回避系动词（serves as、featuring、boasting、presenting）、10 处词汇替换（landscape、robust、seamless、paradigm、streamline、empower、foster、utilize、ascertain、endeavor）、同义词轮换（developers/practitioners/builders/engineers）、否定式排比（It's not just X, it's Y）、堆砌名头（Sequoia、a16z、YC、Index 堆在一起充门面）、模糊归因（Experts believe、Studies show）、填充短语（In order to、Moreover）、带 emoji 的行内小标题列表、浅薄 -ing 分析（symbolizing... reflecting... highlighting...）、套话式挑战（Despite challenges... continues to thrive）、套话式结尾（the future looks bright、only time will tell）、采用一条目中隐含的虚假范围。

合计 35+ 处 AI 痕迹。

## 运行检测器

skill 在
[`detector/`](./detector/) 中附带了一个确定性、零依赖的检测引擎——
即上面规则所描述的同一个引擎，作为可运行代码提供。它在
Node（`>=18`）和浏览器中均可工作，无需任何构建步骤。

它也是数字分数的唯一来源：skill 本身（以及 `detect` 模式）报告的是出现了*哪些*模式以及严重程度（P0/P1/P2），而引擎负责把这些转成一个计算出的 0–100 分数 `score`。`SKILL.md` 里有意没有第二个由散文估算的分数——一个打分者，而非两个。

```bash
npm test          # run the detector's fixtures (no deps to install)
```

```js
const AIDetector = require("./detector/patterns.js");
const { score, label, issues } = AIDetector.analyzeText("Your text here…");
```

完整的 `analyzeText` API 见 [`detector/README.md`](./detector/README.md)，
让 `SKILL.md` 与引擎保持同步的规则 ↔ 类别映射见
[`detector/CATEGORIES.md`](./detector/CATEGORIES.md)。

引擎还附带一个保留性校验器。`detector/validate.js` 会把改写结果与
原文对比，当编辑碰到了不该碰的东西时就判定失败：代码块、YAML frontmatter、
引用块、表格单元格、行内代码、URL、文件路径、标题结构，
或当改写后结尾处的被标记模式比开始时还多时。

```bash
node detector/validate.js before.md after.md   # exits 1 on a preservation error
```

**它能通过自身的检测吗？** [`PROOF.md`](./PROOF.md) 用本仓库的检测器
为本仓库的文档打分，并公开结果，包括扫描在我们自己的工作里发现的
两处缺陷。`npm run self-scan` 可复现该结果，当某篇文档的分数超出预算时
CI 会失败。

## 内部风格指南是另一项工作

本 skill 用于去除 AI 写作痕迹。强制执行一套已发布的风格指南是
另一项工作：它不做那件事，也不附带任何风格指南。可选的 `--style`
输入接收你提供的一份内部风格配置：一个 `register` 列表由模型应用，
一个 `mechanics` 对象，其可检查的规则由
`scripts/check-style.js` 确定性地校验（引号形式和拉丁缩写
会决定退出码；标题大小写、破折号比例和数字拼写为建议性）。
[`examples/`](./examples/) 中有该 schema。你也可以完全跳过该输入，
把指南作为指令（而非被检查的规则集）放到你 agent 的上下文中，
与 [文风配置](#triggering-the-skill) 并列。

如果你想让 Google、Microsoft、Red Hat 或 Salesforce 的风格在 CI 中被检查，
[Vale](https://github.com/vale-cli/vale) 已经覆盖了这件事。它的
[包注册表](https://github.com/vale-cli/packages) 收录了这四套的
Vale 兼容实现，以及 `proselint`、`write-good` 和 `alex` 的移植。
这四个风格指南包采用 MIT 许可，但它们所实现的指南不一定都是（见
下方的审计）；各种 linter 移植各有差异，proselint 的是 BSD-3-Clause。
这两个工具做的是不同的事，可以组合使用：Vale 对照一个规则集
把关一份文档，一次警报应用一处修复；而本 skill 是在起草时
改写整段文字。

付费指南（Chicago、APA、MLA、AP）在此处和 Vale 中都没有机器可读的
实现，也不会在此处提供。本仓库中没有任何东西能验证一次改写是否
符合 Chicago，所以声称能做到就达不到 [`PROOF.md`](./PROOF.md) 对其他所有
数字所要求的同一标准。向 `--style` 传入其中某个名字不会绑入任何东西；
它会回退到模型自身的知识，而 `SKILL.md` 会指示它如实说明，且不得声称合规。
这是一条指令而非一条被检查的规则，这正是要点：这里没有任何东西
可以拿来检查它。这一行背后的
[许可审计](https://github.com/conorbronsdon/avoid-ai-writing/issues/88)
是公开的。

## 致谢

模式研究受以下来源启发：
- [Pangram Labs](https://www.pangram.com/) AI 检测研究——结构规律性洞见、来自一个在 2800 万篇人类文档上训练的 decoder-only 分类器的词汇标记
- 维基百科的 [Signs of AI-generated text](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) 文档——AI 写作痕迹的权威参考，由维基百科编辑维护
- [blader/humanizer](https://github.com/blader/humanizer) Claude Code skill
- [brandonwise/humanizer](https://github.com/brandonwise/humanizer)——分级词表系统、统计分析研究（句长波动 burstiness、句子长度变化、三元组重复）以及改写哲学
- [OpenClaw](https://github.com/openclaw/openclaw) humanizer skill 生态——社区模式与词汇研究

Pull request 会由 [Qodo Merge](https://github.com/marketplace/qodo-merge-pro-for-open-source) 自动做一遍首轮审查，通过 Qodo 的开源项目免费提供。感谢 Qodo 团队对 OSS 维护者的支持。

作者 [Conor Bronsdon](https://github.com/conorbronsdon) · [LinkedIn](https://www.linkedin.com/in/conorbronsdon/) · [Chain of Thought 播客](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=avoid-ai-writing)

## 社区 / 多语言

围绕本 skill 社区已经构建的东西：

- **[avoid-ai-writing-multilingual](https://github.com/jurigis/avoid-ai-writing-multilingual)**，作者 [Jürgen Kraus](https://github.com/jurigis)——德语（`SKILL-DE.md`）、法语（`SKILL-FR.md`）、意大利语（`SKILL-IT.md`）、罗马尼亚语（`SKILL-RO.md`）和瑞典语（`SKILL-SV.md`）改编版，基于母语研究而非从英文翻译而来。

在本 skill 之上构建了什么？开一个 issue——乐意在此链接。

---

## 免责声明

*这是一个独立的个人项目，不附属于、不受赞助、也不受任何公司背书。所表达的所有观点均为本人观点。*

## 许可

MIT
