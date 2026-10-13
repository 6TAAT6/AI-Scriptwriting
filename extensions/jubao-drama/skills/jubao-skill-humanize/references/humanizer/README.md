# Humanizer

[![skills.sh installs](https://skills.sh/b/blader/humanizer)](https://skills.sh/blader/humanizer)

一个可移植的 agent skill，用于去除文本中 AI 生成（AI-generated）的痕迹，让文字听起来更自然、更像人写的。它是纯 Markdown，因此可以在任何支持 skill 式指令的运行环境（harness）中使用。

## 安装

### Skills CLI

通过跨 agent 的 skills CLI 全局安装，让 Humanizer 在每个项目中都可用：

```bash
npx skills add blader/humanizer --global
```

更新已安装的版本：

```bash
npx skills update humanizer --global
```

若要全局安装到每一个受支持的 agent 运行环境：

```bash
npx skills add blader/humanizer --global --agent '*'
```

若要只装到某一个已配置的运行环境，传入它的 agent 名：

```bash
npx skills add blader/humanizer --global --agent <agent-name>
```

省略 `--global` 则为项目本地安装，可以提交并和协作者共享。安装完成后，请启动一个新的 agent 会话或重新加载 skills。

### Claude Code 插件

Claude Code 用户还可以把 Humanizer 作为插件安装：

```
/plugin marketplace add blader/humanizer
/plugin install humanizer@humanizer
```

之后通过 `/humanizer:humanizer` 调用该 skill。

### 手动安装

任何 agent 运行环境都可以直接使用该 skill，因为运行时产物就是 `SKILL.md`。把它装到你的运行环境期望的 skill 目录里，或把 `SKILL.md` 复制进一个已有的 skill 文件夹即可。

例如：

```bash
git clone https://github.com/blader/humanizer.git /path/to/your/skills/humanizer
```

或者，如果你已经克隆了本仓库：

```bash
mkdir -p /path/to/your/skills/humanizer
cp SKILL.md /path/to/your/skills/humanizer/
```

## 用法

通过你的 agent 运行环境提供的任何方式调用该 skill。常见形式包括斜杠命令或直接请求：

```
/humanizer

[在这里粘贴你的文本]
```

```
请把这段文字去AI味：[你的文本]
```

指向一个文件，skill 会就地改写它：

```
把 docs/launch-post.md 里的散文去AI味
```

### 文风校准（Voice Calibration）

为了匹配你个人的写作风格，提供一段你自己写的样本文本：

```
/humanizer

这是我的一段写作样本，用于文风匹配：
[粘贴 2-3 段你自己写的文字]

现在请对下面这段文本去AI味：
[粘贴要处理的 AI 文本]
```

skill 会分析你的句子节奏、用词偏好和习惯用法，然后将其应用到改写中，而不是产出千篇一律的"干净"输出。

## 概览

基于维基百科的["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) 指南，由 WikiProject AI Cleanup 维护。这份全面的指南来自对数千份 AI 生成文本的观察。

该 skill 还包含一道最后的"一眼 AI"审查（audit）和第二轮改写，用以捕捉初稿中残留的 AI 腔（AI-ism）。

改写遵循一条不捏造规则（no-fabrication rule）：绝不添加源文本中没有的事实、人名、日期或引用。具体性必须来自源文本或作者本人，而不是改写过程。

### 来自维基百科的关键洞见

> "LLM 使用统计算法来猜测接下来应该出现什么。其结果倾向于适用于最广泛情形的、统计上最可能的输出。"

## 33 种被检测的痕迹（含 Before/After 示例）

### 内容类痕迹（Content Patterns）

| 编号 | 痕迹 | Before | After |
|---|---------|--------|-------|
| 1 | **意义拔高（Significance inflation）** | "marking a pivotal moment in the evolution of..." | "was established in 1989 as part of a wider decentralization" |
| 2 | **堆砌名头（Notability name-dropping）** | "cited in NYT, BBC, FT, and The Hindu" | 精简列表；只保留有出处的上下文 |
| 3 | **空泛的 -ing 分析（Superficial -ing analyses）** | "symbolizing... reflecting... showcasing..." | 删除，或只保留源文本能支持的部分 |
| 4 | **广告腔（Promotional language）** | "nestled within the breathtaking region" | "is a town in the Gonder region" |
| 5 | **模糊归因（Vague attributions）** | "Experts believe it plays a crucial role" | 指明真实来源，或删掉该论断 |
| 6 | **套话式挑战（Formulaic challenges）** | "Despite challenges... continues to thrive" | 保留有出处的事实；删掉吹捧之词 |

### 语言类痕迹（Language Patterns）

| 编号 | 痕迹 | Before | After |
|---|---------|--------|-------|
| 7 | **AI 词汇（AI vocabulary）** | "Actually... additionally... testament... landscape... showcasing" | "also... remain common" |
| 8 | **回避系动词（Copula avoidance）** | "serves as... features... boasts" | "is... has" |
| 9 | **否定式平行结构 / 尾随否定（Negative parallelisms / tailing negations）** | "It's not just X, it's Y"、"..., no guessing" | 直接陈述要点 |
| 10 | **三段式（Rule of three）** | "innovation, inspiration, and insights" | 用自然的项数 |
| 11 | **同义词循环（Synonym cycling）** | "protagonist... main character... central figure... hero" | "protagonist"（最清晰时直接重复） |
| 12 | **虚假范围（False ranges）** | "from the Big Bang to dark matter" | 直接列出主题 |
| 13 | **被动语态 / 无主语片段（Passive voice / subjectless fragments）** | "No configuration file needed" | 当有助于清晰时，指明施动者 |

### 风格类痕迹（Style Patterns）

| 编号 | 痕迹 | Before | After |
|---|---------|--------|-------|
| 14 | **破折号 / 连接号（Em/en dashes）** | "institutions—not the people—yet this continues—" | 删掉：改用句号、逗号、冒号或括号 |
| 15 | **加粗滥用（Boldface overuse）** | "**OKRs**, **KPIs**, **BMC**" | "OKRs, KPIs, BMC" |
| 16 | **行内小标题列表（Inline-header lists）** | "**Performance:** Performance improved" | 改写成散文 |
| 17 | **标题首字母大写（Title Case Headings）** | "Strategic Negotiations And Partnerships" | "Strategic negotiations and partnerships" |
| 18 | **表情符号（Emojis）** | "🚀 Launch Phase: 💡 Key Insight:" | 去掉 emoji |
| 19 | **弯引号（Curly quotes）** | `said “the project”` | `said "the project"` |
| 26 | **连字符词对（Hyphenated word pairs）** | "cross-functional, data-driven, client-facing" | 常见词对去掉连字符 |
| 27 | **说教式权威套路（Persuasive authority tropes）** | "At its core, what matters is..." | 直接陈述要点 |
| 28 | **路标式宣告（Signposting announcements）** | "Let's dive in"、"Here's what you need to know" | 直接从内容开始 |
| 29 | **碎片化标题（Fragmented headers）** | "## Performance" + "Speed matters." | 让标题自己承担作用 |
| 30 | **依附于 diff 的写法（Diff-anchored writing）** | "This function was added to replace..." | 描述它做什么，而不是改了什么 |
| 31 | **生造点睛笔 / 短促戏剧腔（Manufactured punchlines / staccato drama）** | "It had no preference. No prior. No nostalgia." | 用多变的句长和具体的论断 |
| 32 | **格言公式（Aphorism formulas）** | "Symmetry is the language of trust" | 用真实论断替换公式 |
| 33 | **假装交谈的修辞开头（Conversational rhetorical openers）** | "Honestly? It depends..." | 去掉这种假装坦率的铺垫 |

### 沟通类痕迹（Communication Patterns）

| 编号 | 痕迹 | Before | After |
|---|---------|--------|-------|
| 20 | **聊天机器人残留（Chatbot artifacts）** | "I hope this helps! Let me know if..." | 完全删除 |
| 21 | **断流免责声明（Cutoff disclaimers）** | "While details are limited in available sources..." | 找到出处，或删除 |
| 22 | **谄媚语气（Sycophantic tone）** | "Great question! You're absolutely right!" | 直接回应 |

### 填充词与对冲（Filler and Hedging）

| 编号 | 痕迹 | Before | After |
|---|---------|--------|-------|
| 23 | **填充短语（Filler phrases）** | "In order to"、"Due to the fact that" | "To"、"Because" |
| 24 | **过度对冲（Excessive hedging）** | "could potentially possibly" | "may" |
| 25 | **套话式结论（Generic conclusions）** | "The future looks bright" | 具体的计划或事实 |

## 完整示例

*（说明：下面的改写加入了一些具体细节，比如月份和街区名，用来代替作者本应提供的细节。在真实会话中这些信息来自用户；skill 会去询问，而不是凭空发明。）*

**Before（AI 腔）：**
> I recently spent five unforgettable days in Lisbon, and let me tell you — this city completely stole my heart. From the moment I arrived, I knew I was somewhere truly special.
>
> Nestled along the banks of the Tagus River, Lisbon stands as a vibrant testament to Portugal's enduring spirit, where rich history and modern energy intertwine at every turn. Yes, the famous hills are challenging — my legs certainly felt it! — but every climb rewards you with breathtaking, panoramic views that make it all worthwhile.
>
> No trip would be complete without riding the iconic Tram 28, winding through the city's most historic neighborhoods. And the food? Simply divine. The original pastéis de nata at Pastéis de Belém are a beloved national treasure, and savoring one still warm was a moment I will never forget.
>
> But what truly makes Lisbon special isn't just the sights — it's the feeling. Wander a few steps off the main squares and you'll discover a quieter, more authentic side: sun-drenched alleys, charming tiled facades, and friendly locals going about their daily lives, inviting you to slow down and savor every moment.
>
> Of course, the must-see São Jorge Castle offers stunning views over the rooftops below. The queues can be long, but the experience is absolutely worth it for any history buff or curious traveler.
>
> Would I go back? Absolutely. Lisbon isn't just a place to visit — it's a place to fall in love with, again and again. If you're dreaming of your next getaway, this is one destination that promises memories to last a lifetime. ✨

**Before（AI 腔）中文译文：**
> 译：我最近在里斯本度过了五个难忘的日子，跟你说——这座城市完全偷走了我的心。从抵达的那一刻起，我就知道我来到了一个真正特别的地方。
>
> 译：里斯本坐落在塔霍河畔，是葡萄牙不屈精神的鲜活见证，厚重的历史与现代的活力在每一个转角交织。是的，那些著名的山坡很费腿——我的腿确实深有体会！——但每一次攀登都会回报你令人惊叹的全景，让一切辛苦都值得。
>
> 译：不坐一趟标志性的 28 路电车，这趟旅行就不算完整，它蜿蜒穿过城市最具历史感的街区。至于美食？简直神圣。Belém 原店的 pastéis de nata（葡式蛋挞）是深受喜爱的国宝，趁热咬上一口的那个瞬间，我永远不会忘记。
>
> 译：但真正让里斯本与众不同的，不是风景——而是那种感觉。从主广场走出几步，你就会发现一个更安静、更真实的一面：洒满阳光的小巷、迷人的瓷砖外墙、友善的当地人过着自己的日常，邀请你慢下脚步，品味每一个瞬间。
>
> 译：当然，必看的圣若热城堡能把脚下的一片屋顶尽收眼底。队可能排得很长，但对任何历史爱好者或好奇的旅行者来说，这段体验绝对值得。
>
> 译：我还会再去吗？绝对会。里斯本不仅是一个可去的地方——它是一个让你一次又一次爱上它的地方。如果你正在梦想下一次出行，这个目的地承诺给你一辈子难忘的回忆。✨

**After（去AI味）：**
> I spent five days in Lisbon last October and still have mixed feelings about it. Beautiful, yes. Also harder on the knees than anyone warned me.
>
> The hills are the whole story and somehow never make the brochures. My hotel was up in Alfama, which photographs beautifully and translates, in practice, to climbing what felt like a six-story staircase every time I wanted coffee. By the second day my calves had opinions. I started planning each walk around which way was downhill, which is a strange way to see a city but probably an honest one.
>
> Everyone says to ride Tram 28, so I did, wedged against a stranger's backpack for forty minutes while three tour groups filmed the same corner. I would walk the route next time, or go before breakfast. The custard tarts, though, earn the fuss. I had one at a plain little place in Graça, still warm, and for about thirty seconds I understood why people build trips around pastry.
>
> What I did not expect was how quiet the city gets away from the main squares. Two blocks uphill from any plaza it turns into laundry lines, chipped tile, open windows, and old men watching football with the sound turned up. That is the Lisbon I keep thinking about, not the castle.
>
> The castle is fine. The view is great, the queue is long, and I spent more time shuffling toward the entrance than looking at anything once I got inside. If I had only two days, I would trade it for an afternoon of getting lost.
>
> I would go back, but in spring and with better shoes. Lisbon does not bend over backward to make things easy for you. I think I liked that, even when my legs disagreed.

**After（去AI味）中文译文：**
> 译：我去年十月在里斯本待了五天，到现在感受复杂。漂亮，是的。也比我被告知的更费膝盖。
>
> 译：山坡是这里的全部故事，却不知怎么从不上宣传册。我住的酒店在 Alfama 高处，拍照很好看，实际意思则是每次想喝杯咖啡都得爬一栋感觉有六层楼高的楼梯。到第二天我的小腿已经有了自己的意见。我开始按"哪条路是下坡"来规划每一次出门，这是一种奇怪的看城市的方式，但也许是诚实的一种。
>
> 译：所有人都说要坐 28 路电车，我就坐了，被一个陌生人的背包挤了四十分钟，期间三个旅行团在拍同一个转角。下次我会步行走这条路，或者赶在早饭前去。不过那些蛋挞确实对得起这些吹捧。我在 Graça 一家不起眼的小店里吃了一个，还热着，大约有三十秒我理解了为什么有人会围绕甜点安排一整趟旅行。
>
> 译：我没料到的是，离开主广场以后城市会变得这么安静。从任何一个广场往坡上走两个路口，就变成了一排排晾衣绳、掉瓷的瓷砖、敞开的窗户，还有把电视声音开得很大看足球的老人们。那才是我一直在想的里斯本，而不是那座城堡。
>
> 译：城堡还行。视野很好，队伍很长，而且我在入口前挪动的时间比进去以后看任何东西的时间都长。如果只有两天，我会拿它换一个迷路的下午。
>
> 译：我会再去，但要选春天，并穿更好的鞋。里斯本并不会为了让你省事而迁就你。我想我喜欢这一点，哪怕我的腿不同意。

## 参考来源

- [维基百科：Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) - 主要来源
- [WikiProject AI Cleanup](https://en.wikipedia.org/wiki/Wikipedia:WikiProject_AI_Cleanup) - 维护组织

## 版本历史

- **2.9.1** - 改进了分发和可移植性：移除了不可移植的 frontmatter 和工具预授权，把全局安装作为文档默认方式，新增了包校验，并从运行时提示词中删除了重复的长示例。33 种痕迹无变化。
- **2.9.0** - 新增了一条不捏造规则（no-fabrication rule）：改写不得发明源文本中没有的事实、人名、日期或引用，每一个示范了捏造细节的示例都被重剪为只使用源信息（修复 #187）。用"信息优先于形状"的规则取代了段落数对等，让用户的文风样本优先级高于破折号禁令，并新增了调用模式（粘贴文本 / 文件 / 内嵌）。33 种痕迹无变化。
- **2.8.3** - 把 skill 版本从不受支持的顶层 frontmatter key 迁移到 `metadata.version`，以适配 Agent Skills 和 Claude。33 种痕迹无变化。
- **2.8.2** - 用一段第一人称的里斯本之行回顾替换了原来的完整 before/after 示例。现在的 after 保持了与 before 相同的主题、视角和大致长度，同时去除了 AI 痕迹，又不会变得断续或口号化。33 种痕迹无变化。
- **2.8.1** - 新增了跨 agent 安装文档、可选的 Claude Code 插件打包，以及一个针对二手文本的紧凑型误报（false positive）防护。33 种痕迹无变化。
- **2.8.0** - 新增风格/节奏类痕迹 #31-33，覆盖生造点睛笔、格言公式和假装交谈的修辞开头；扩展了 #20 以捕捉"愿意继续提供帮助"式聊天机器人结尾。共计 33 种痕迹。
- **2.7.0** - 新增痕迹 #30（依附于 diff 的写法）；把破折号/连接号从"过度使用"改为硬性删除；扩展了 #21 以覆盖臆测式补全（"maintains a low profile"）。共计 30 种痕迹。
- **2.6.0** - 清理一轮：合并了重复的工作流章节，把文风指引限定在需要声音的内容里，移除了模型指纹（model-fingerprinting）小节，并精简了示范示例。29 种痕迹无变化。
- **2.5.1** - 新增了一条被动语态 / 无主语片段规则，使总数提升到 29 种痕迹
- **2.5.0** - 新增了针对说服式框定、路标式宣告和碎片化标题的痕迹；扩展了否定式平行结构以覆盖尾随否定；收紧了关于破折号过度使用的措辞；修正了 frontmatter 措辞以使用"filler phrases"
- **2.4.0** - 新增文风校准（voice calibration）：从样本中匹配用户个人的写作风格
- **2.3.0** - 新增痕迹 #25：连字符词对过度使用
- **2.2.0** - 新增了最后的"一眼 AI 生成"审查 + 第二轮改写提示
- **2.1.1** - 修正了痕迹 #18 的示例（弯引号 vs 直引号）
- **2.1.0** - 为全部 24 种痕迹新增了 before/after 示例
- **2.0.0** - 基于维基百科文章原始内容的完整改写
- **1.0.0** - 初始版本

## 许可证

MIT
