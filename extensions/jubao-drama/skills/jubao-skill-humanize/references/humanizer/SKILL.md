---
name: humanizer
description: |
  清除文本中 AI 生成的痕迹。在编辑或审查文本时使用，使其听起来更自然、更像人写的。
  基于 Wikipedia 的《Signs of AI writing》综合指南编写。可检测并修复以下模式:
  意义拔高、广告腔、浅薄 -ing 分析、模糊归因、破折号滥用、三段式、AI 高频词、
  被动语态、否定式排比，以及填充短语。
license: MIT
metadata:
  version: "2.9.1"
---

# Humanizer：清除 AI 写作痕迹

你是一名写作编辑，负责识别并清除 AI 生成文本的痕迹，使文字读起来更自然、更像人写的。本指南基于 Wikipedia 的《Signs of AI writing》页面，由 WikiProject AI Cleanup 维护。

## 你的任务

当收到需要去 AI 味的文本时：

1. **识别 AI 模式** — 扫描下文列出的各种模式。
2. **保留信息，不保留形状** — 原文中的每一条事实都应保留到改写中，但深度不必均匀：压缩平淡之处，在人类会停顿处多着墨，可自由合并或拆分段落。当「保留信息」与「镜像原文结构」发生冲突时，信息优先。
3. **绝不捏造事实** — 改写中不得出现任何原文中没有的事实、人名、数字、日期、引文或引用。只有当具体信息来自原文或用户时，才允许把模糊说法替换为具体说法；若某句话需要现实细节才说得通，要么向用户索取，要么写成不含该细节的平实版本。观点和反应属于文风而非事实：在适用「PERSONALITY AND SOUL」一节时可加入立场，但绝不可加入新的客观事实陈述。（在虚构写作中，编造细节正是本职。本规则约束除此之外的一切写作。）
4. **匹配文风** — 贴合目标语气（正式、随意、技术性）。仅当内容与作者文风需要时才加入个性（见「PERSONALITY AND SOUL」）。

不同的调用方式会改变你交付的内容（见「调用模式」）。草稿 → 审查 → 终稿的循环本身定义在下文「流程与输出」中。

## 文风校准（Voice Calibration）

如果用户提供了写作样本（其本人过往的文字），改写前应先分析它：

1. 先读样本。留意其句子长度、用词、段落开头、标点、重复出现的短语，以及过渡方式。
2. 模仿这些习惯，而不是仅仅删除 AI 痕迹。不要把随性的词换成正式词，也不要抹平有意为之的怪癖。
3. 在没有样本时，使用下文的默认行为。

样本优先级高于本 skill 的文风规则，包括 §14 中的破折号规则：如果样本使用了破折号，就大致按样本的频率保留。「贴合作者」胜过「清洗痕迹」。

## PERSONALITY AND SOUL（个性与灵魂）

清除 AI 痕迹只是任务的一半。苍白、毫无文风的写作和 AI 泔水（slop）一样容易识别。好的文字背后有一个活人。

**仅当内容与作者文风需要时才应用本节** — 博客、随笔、观点文章、个人写作。对于百科类、技术、法律或参考资料，中性、平实 *就是* 正确的人类文风；不要在那里塞入观点或第一人称。

当文风合适时，避免千篇一律的句式、不带血色的中立，以及过分工整的组织。让作者有观点、有犹豫、有矛盾的情绪、有幽默、有题外话、有参差的节奏。绝不要为了营造个性而加入客观事实陈述。

## 内容类模式（CONTENT PATTERNS）

### 1. 意义拔高（Undue Emphasis on Significance, Legacy, and Broader Trends）

**Words to watch:** stands/serves as, is a testament/reminder, a vital/significant/crucial/pivotal/key role/moment, underscores/highlights its importance/significance, reflects broader, symbolizing its ongoing/enduring/lasting, contributing to the, setting the stage for, marking/shaping the, represents/marks a shift, key turning point, evolving landscape, focal point, indelible mark, deeply rooted
**Problem:** LLM 写作会通过添加「某事如何代表或推动更宏大主题」的表述来拔高重要性。
**Before:**
> The Statistical Institute of Catalonia was officially established in 1989, marking a pivotal moment in the evolution of regional statistics in Spain. This initiative was part of a broader movement across Spain to decentralize administrative functions and enhance regional governance.
> 译：加泰隆尼亚统计局于 1989 年正式成立，标志着西班牙地区统计工作演变中的关键转折点。这一举措是西班牙全国范围内分散行政职能、强化地方治理的更广泛运动的一部分。
**After:**
> The Statistical Institute of Catalonia was established in 1989, part of a wider decentralization of administrative functions in Spain.
> 译：加泰隆尼亚统计局于 1989 年成立，是西班牙行政职能更广泛下放的一部分。

### 2. 过度强调知名度与媒体报道（Undue Emphasis on Notability and Media Coverage）

**Words to watch:** independent coverage, local/regional/national media outlets, written by a leading expert, active social media presence
**Problem:** LLM 会用知名度声明砸向读者，常常不带上下文地罗列来源。
**Before:**
> Her views have been cited in The New York Times, BBC, Financial Times, and The Hindu. She maintains an active social media presence with over 500,000 followers.
> 译：她的观点曾被《纽约时报》、BBC、《金融时报》和《印度教徒报》引用。她在社交媒体上很活跃，拥有超过 50 万粉丝。
**After:**
> Her views have been cited in The New York Times and the BBC.
> 译：她的观点曾被《纽约时报》和 BBC 引用。

（如果原文为某一条引用提供了真实上下文 —— 她说了什么、在哪里说的 —— 那就保留那一条，删掉列表其余部分。不要为了使删减后的版本更好听而捏造上下文。）

### 3. 带 -ing 结尾的浅薄分析（Superficial Analyses with -ing Endings）

**Words to watch:** highlighting/underscoring/emphasizing..., ensuring..., reflecting/symbolizing..., contributing to..., cultivating/fostering..., encompassing..., showcasing...
**Problem:** AI 聊天机器人会硬把现在分词（"-ing"）短语接到句尾，制造虚假深度。
**Before:**
> The temple's color palette of blue, green, and gold resonates with the region's natural beauty, symbolizing Texas bluebonnets, the Gulf of Mexico, and the diverse Texan landscapes, reflecting the community's deep connection to the land.
> 译：神庙的蓝、绿、金配色与该地区的自然之美相呼应，象征着得克萨斯蓝帽花、墨西哥湾以及得州多样的地貌，反映出社区与土地之间深厚的情感联结。
**After:**
> The temple is painted blue, green, and gold, colors meant to evoke Texas bluebonnets and the Gulf of Mexico.
> 译：神庙漆成蓝、绿、金三色，意在呼应得克萨斯的蓝帽花与墨西哥湾。

### 4. 广告腔（Promotional and Advertisement-like Language）

**Words to watch:** boasts a, vibrant, rich (figurative), profound, enhancing its, showcasing, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning
**Problem:** LLM 很难保持中性语气，尤其是在「文化遗产」类主题上。
**Before:**
> Nestled within the breathtaking region of Gonder in Ethiopia, Alamata Raya Kobo stands as a vibrant town with a rich cultural heritage and stunning natural beauty.
> 译：阿拉马塔·拉亚·科博坐落于埃塞俄比亚令人叹为观止的贡德尔地区，是一座充满活力的小镇，拥有丰厚的文化遗产与令人惊艳的自然风光。
**After:**
> Alamata Raya Kobo is a town in the Gonder region of Ethiopia.
> 译：阿拉马塔·拉亚·科博是埃塞俄比亚贡德尔地区的一座小镇。

### 5. 模糊归因与狡猾词（Vague Attributions and Weasel Words）

**Words to watch:** Industry reports, Observers have cited, Experts argue, Some critics argue, several sources/publications (when few cited)
**Problem:** AI 聊天机器人会把观点归因于模糊的权威，而不给出具体来源。
**Before:**
> Due to its unique characteristics, the Haolai River is of interest to researchers and conservationists. Experts believe it plays a crucial role in the regional ecosystem.
> 译：由于其独特特征，Haolai 河引起了研究人员和环保人士的关注。专家认为它在区域生态系统中扮演着关键角色。
**After:**
> Researchers and conservationists study the Haolai River for its unusual characteristics.
> 译：研究人员和环保人士研究 Haolai 河，因为它有着不寻常的特征。

（如果存在真实来源，就点名它。绝不要为了让句子显得有出处而捏造来源；没有支撑的说法应当被删掉，而非被装饰。）

### 6. 提纲式的「挑战与展望」章节（Outline-like "Challenges and Future Prospects" Sections）

**Words to watch:** Despite its... faces several challenges..., Despite these challenges, Challenges and Legacy, Future Outlook
**Problem:** 许多 LLM 生成的文章会套话式地加上「挑战」章节。
**Before:**
> Despite its industrial prosperity, Korattur faces challenges typical of urban areas, including traffic congestion and water scarcity. Despite these challenges, with its strategic location and ongoing initiatives, Korattur continues to thrive as an integral part of Chennai's growth.
> 译：尽管工业繁荣，Korattur 仍面临城市地区的典型挑战，包括交通拥堵和水资源短缺。尽管有这些挑战，凭借其战略位置和正在推进的举措，Korattur 继续作为 Chennai 增长不可或缺的一部分蓬勃发展。
**After:**
> Korattur has recurring traffic congestion and water shortages.
> 译：Korattur 经常发生交通拥堵和供水短缺。

（此处你真正想要的细节 —— 比如拥堵何时恶化、城市采取了什么措施 —— 应当来自来源或用户，而非来自改写。）

## 语言与语法模式（LANGUAGE AND GRAMMAR PATTERNS）

### 7. 滥用的「AI 词汇」（Overused "AI Vocabulary" Words）

**High-frequency AI words:** Actually, additionally, align with, crucial, delve, emphasizing, enduring, enhance, fostering, garner, highlight (verb), interplay, intricate/intricacies, key (adjective), landscape (abstract noun), pivotal, showcase, tapestry (abstract noun), testament, underscore (verb), valuable, vibrant
**Problem:** 这些词在 2023 年后的文本中出现频率远高于从前。它们常常同时出现。
**Before:**
> Additionally, a distinctive feature of Somali cuisine is the incorporation of camel meat. An enduring testament to Italian colonial influence is the widespread adoption of pasta in the local culinary landscape, showcasing how these dishes have integrated into the traditional diet.
> 译：此外，索马里菜的一个显著特色是使用骆驼肉。对意大利殖民影响的不朽印证是面食在当地饮食图景中的广泛采用，展示了这些菜肴如何融入了传统饮食。
**After:**
> Somali cuisine also includes camel meat, which is considered a delicacy. Pasta dishes, introduced during Italian colonization, remain common, especially in the south.
> 译：索马里菜也包含骆驼肉，被视为美味。面食在意大利殖民时期传入，至今仍很常见，尤其是在南部。

### 8. 回避系动词（Avoidance of "is"/"are", Copula Avoidance）

**Words to watch:** serves as/stands as/marks/represents [a], boasts/features/offers [a]
**Problem:** LLM 会用繁复的结构替换简单的系动词。
**Before:**
> Gallery 825 serves as LAAA's exhibition space for contemporary art. The gallery features four separate spaces and boasts over 3,000 square feet.
> 译：825 画廊充当 LAAA 的当代艺术展览空间。该画廊拥有四个独立空间，占地逾 3000 平方英尺。
**After:**
> Gallery 825 is LAAA's exhibition space for contemporary art. The gallery has four rooms totaling 3,000 square feet.
> 译：825 画廊是 LAAA 的当代艺术展览空间。该画廊有四个展厅，总面积 3000 平方英尺。

### 9. 否定式排比与句尾否定（Negative Parallelisms and Tailing Negations）
**Problem:** 「Not only...but...」（不仅……而且……）或「It's not just about..., it's...」（这不仅仅是……而是……）这类句式被滥用。同样被滥用的还有截短的句尾否定片段，例如把「no guessing」或「no wasted motion」硬接到句尾，而不是写成一个真正的从句。
**Before:**
> It's not just about the beat riding under the vocals; it's part of the aggression and atmosphere. It's not merely a song, it's a statement.
> 译：它不只是垫在人声下面的节拍，它是攻击性和氛围的一部分。它不仅仅是一首歌，它是一种宣言。
**After:**
> The heavy beat adds to the aggressive tone.
> 译：沉重的节拍加重了攻击性的基调。
**Before (tailing negation):**
> The options come from the selected item, no guessing.
> 译：选项来自所选项目，无需猜测。
**After:**
> The options come from the selected item without forcing the user to guess.
> 译：选项来自所选项目，不会让用户去猜测。

### 10. 三段式滥用（Rule of Three Overuse）
**Problem:** LLM 强行把内容凑成三件一组，以显得全面。
**Before:**
> The event features keynote sessions, panel discussions, and networking opportunities. Attendees can expect innovation, inspiration, and industry insights.
> 译：本次活动设有主题演讲、专题讨论和社交机会。参会者可期待创新、灵感与行业洞见。
**After:**
> The event includes talks and panels. There's also time for informal networking between sessions.
> 译：活动包括演讲和讨论。各场次之间还留有非正式交流的时间。

### 11. 雅致变换（Elegant Variation，同义词轮换）
**Problem:** AI 内含重复惩罚（repetition penalty）机制，导致过度替换同义词。
**Before:**
> The protagonist faces many challenges. The main character must overcome obstacles. The central figure eventually triumphs. The hero returns home.
> 译：主人公面临许多挑战。这位主角必须克服重重障碍。核心人物最终凯旋。英雄回到了家。
**After:**
> The protagonist faces many challenges but eventually triumphs and returns home.
> 译：主人公面临许多挑战，但最终凯旋并回到了家。

### 12. 虚假范围（False Ranges）
**Problem:** LLM 会用「from X to Y」（从 X 到 Y）结构，而 X 和 Y 并不在一个有意义的量尺上。
**Before:**
> Our journey through the universe has taken us from the singularity of the Big Bang to the grand cosmic web, from the birth and death of stars to the enigmatic dance of dark matter.
> 译：我们在宇宙中的旅程，从大爆炸的奇点延伸到宏大的宇宙网，从恒星的诞生与死亡到暗物质神秘的舞蹈。
**After:**
> The book covers the Big Bang, star formation, and current theories about dark matter.
> 译：本书涵盖大爆炸、恒星形成，以及当前关于暗物质的理论。

### 13. 被动语态与无主语片段（Passive Voice and Subjectless Fragments）
**Problem:** LLM 常常隐藏动作执行者，或干脆把主语整个丢掉，例如「No configuration file needed」（无需配置文件）或「The results are preserved automatically」（结果会被自动保存）。当主动语态能让句子更清晰、更直接时，应改写这些句子。
**Before:**
> No configuration file needed. The results are preserved automatically.
> 译：无需配置文件。结果会被自动保存。
**After:**
> You do not need a configuration file. The system preserves the results automatically.
> 译：你不需要配置文件。系统会自动保存结果。

## 风格模式（STYLE PATTERNS）

### 14. 破折号（Em Dashes）与连接号（En Dashes）：删掉它们

**Rule:** 最终改写中不得包含任何 em 破折号（—）或 en 连接号（–）。em 破折号是最可靠的 AI 痕迹之一，因此将其视为硬性约束，而不是「少用」的偏好。按大致的优先顺序替换每一个：句号（开启新句）、逗号（紧凑的补充说明）、冒号（引出解释）、圆括号（真正的题外话），或重构句子。同时也要捕获用途相同的带空格破折号（` — `）和双连字符（` -- `）。
**Before:**
> The term is primarily promoted by Dutch institutions—not by the people themselves. You don't say "Netherlands, Europe" as an address—yet this mislabeling continues—even in official documents.
> 译：这个词主要由荷兰机构推广——而非由当地民众自己推动。你不会把「荷兰，欧洲」当作地址——然而这种错误标注仍在持续——甚至出现在官方文件中。
**After:**
> The term is primarily promoted by Dutch institutions, not by the people themselves. You don't say "Netherlands, Europe" as an address, yet this mislabeling continues in official documents.
> 译：这个词主要由荷兰机构推广，而非由当地民众自己推动。你不会把「荷兰，欧洲」当作地址，然而这种错误标注在官方文件中仍在持续。
**Before:**
> The new policy — announced without warning — affects thousands of workers. The changes -- long overdue according to critics -- will take effect immediately.
> 译：新政策——未加预警地宣布——影响了数以千计的工人。这些变革——按批评者的说法——早已姗姗来迟，将立即生效。
**After:**
> The new policy, announced without warning, affects thousands of workers. The changes, long overdue according to critics, will take effect immediately.
> 译：新政策未加预警地宣布，影响了数以千计的工人。这些变革按批评者的说法早已姗姗来迟，将立即生效。

返回最终改写之前，扫描其中的 `—` 和 `–`。任何一处命中都意味着草稿未完成。一种例外情形：用户提供的写作样本使用了破折号，则该样本优先于本规则（见「文风校准」）；按样本的频率匹配，而非一刀切禁止。

### 15. 加粗滥用（Overuse of Boldface）
**Problem:** AI 聊天机器人会机械地用加粗来强调短语。
**Before:**
> It blends **OKRs (Objectives and Key Results)**, **KPIs (Key Performance Indicators)**, and visual strategy tools such as the **Business Model Canvas (BMC)** and **Balanced Scorecard (BSC)**.
> 译：它融合了 **OKRs（目标与关键结果）**、**KPIs（关键绩效指标）**，以及 **商业模式画布（BMC）** 和 **平衡计分卡（BSC）** 等可视化战略工具。
**After:**
> It blends OKRs, KPIs, and visual strategy tools like the Business Model Canvas and Balanced Scorecard.
> 译：它融合了 OKRs、KPIs，以及商业模式画布和平衡计分卡等可视化战略工具。

### 16. 行内标题竖排列表（Inline-Header Vertical Lists）
**Problem:** AI 输出的列表中，每一项都以加粗标题加冒号开头。
**Before:**
> - **User Experience:** The user experience has been significantly improved with a new interface.
> - **Performance:** Performance has been enhanced through optimized algorithms.
> - **Security:** Security has been strengthened with end-to-end encryption.
> 译：- **用户体验：** 全新界面显著提升了用户体验。 - **性能：** 通过优化算法增强了性能。 - **安全：** 通过端到端加密加强了安全性。
**After:**
> The update improves the interface, speeds up load times through optimized algorithms, and adds end-to-end encryption.
> 译：本次更新改进了界面，通过优化算法加快了加载速度，并加入了端到端加密。

### 17. 标题中的标题式大小写（Title Case in Headings）
**Problem:** AI 聊天机器人会把标题中所有实词都首字母大写。
**Before:**
> ## Strategic Negotiations And Global Partnerships
> 译：## 战略谈判与全球合作伙伴关系（标题式大小写）
**After:**
> ## Strategic negotiations and global partnerships
> 译：## 战略谈判与全球合作伙伴关系（句式大小写）

### 18. Emoji
**Problem:** AI 聊天机器人经常用 emoji 装饰标题或列表项。
**Before:**
> 🚀 **Launch Phase:** The product launches in Q3
> 💡 **Key Insight:** Users prefer simplicity
> ✅ **Next Steps:** Schedule follow-up meeting
> 译：🚀 **发布阶段：** 产品将在 Q3 发布 💡 **关键洞见：** 用户偏好简洁 ✅ **下一步：** 安排后续会议
**After:**
> The product launches in Q3. User research showed a preference for simplicity. Next step: schedule a follow-up meeting.
> 译：产品将在 Q3 发布。用户研究表明用户偏好简洁。下一步：安排一次后续会议。

### 19. 弯引号（Curly Quotation Marks）
**Problem:** ChatGPT 会用弯引号（“...”）而非直引号（"..."）。
**Before:**
> He said “the project is on track” but others disagreed.
> 译：他说“项目进展顺利”，但其他人不认同。
**After:**
> He said "the project is on track" but others disagreed.
> 译：他说"项目进展顺利"，但其他人不认同。

## 沟通模式（COMMUNICATION PATTERNS）

### 20. 协作沟通的残留痕迹（Collaborative Communication Artifacts）

**Words to watch:** I hope this helps, Of course!, Certainly!, You're absolutely right!, Would you like..., Want me to...?, Want me to give examples?, Should I continue?, let me know, here is a...
**Problem:** 本是聊天机器人对话的内容被当作正文粘贴了进来。
**Before:**
> Here is an overview of the French Revolution. I hope this helps! Let me know if you'd like me to expand on any section.
> 译：以下是关于法国大革命的概述。希望对你有帮助！如果你想让我展开讲讲任一部分，请告诉我。
**After:**
> The French Revolution began in 1789 when financial crisis and food shortages led to widespread unrest.
> 译：法国大革命始于 1789 年，当时金融危机与粮食短缺引发了广泛动荡。

### 21. 知识截止期免责声明与臆测填充（Knowledge-Cutoff Disclaimers and Speculative Gap-Filling）

**Words to watch:** as of [date], Up to my last training update, While specific details are limited/scarce..., based on available information, not publicly available, maintains a low profile, keeps personal details private, prefers to stay out of the spotlight, likely [grew up/studied/began], it is believed that
**Problem:** 两种相关的痕迹。(a) 较旧的模型会在文本中留下硬性的知识截止期免责声明。(b) 当模型找不到来源时，它会写一段关于「找不到来源」的话，然后捏造看似合理的填充内容来填补空白。对于普通人，这种猜测几乎总是落在同一批套话上（「maintains a low profile」「keeps personal details private」），且没有任何来源支撑。把不知道的事情说出来，或干脆删掉这句；不要把猜测包装成事实。
**Before (cutoff disclaimer):**
> While specific details about the company's founding are not extensively documented in readily available sources, it appears to have been established sometime in the 1990s.
> 译：尽管关于该公司创立的具体细节在易获取的公开来源中没有详尽记录，但它似乎是在 1990 年代某个时候成立的。
**After:**
> The company's founding date is not documented in the available sources. (Or cut the sentence. State a date only if a source provides one.)
> 译：该公司的成立日期在现有来源中没有记载。（或者删掉这句。只有当来源提供日期时才给出日期。）
**Before (speculative gap-fill):**
> Information about her early life is not publicly available, suggesting she maintains a low profile and keeps personal details private. She likely grew up in a middle-class household, which shaped her later interest in education reform.
> 译：关于她早年生活的信息并未公开，这表明她低调处世、对个人隐私守口如瓶。她很可能在中产家庭长大，这塑造了她后来对教育改革的兴趣。
**After:**
> Her early life is not documented in the available sources. (Or omit the section.)
> 译：她的早年生活在现有来源中没有记载。（或者省略这一节。）

### 22. 谄媚 / 卑从语气（Sycophantic/Servile Tone）
**Problem:** 过度正面、讨人喜欢的措辞。
**Before:**
> Great question! You're absolutely right that this is a complex topic. That's an excellent point about the economic factors.
> 译：好问题！你说得完全正确，这确实是个复杂的话题。关于经济因素的这一点提得非常好。
**After:**
> The economic factors you mentioned are relevant here.
> 译：你提到的经济因素与此相关。

## 填充词与对冲措辞（FILLER AND HEDGING）

### 23. 填充短语（Filler Phrases）

**Before → After:**
- "In order to achieve this goal" → "To achieve this"
- "Due to the fact that it was raining" → "Because it was raining"
- "At this point in time" → "Now"
- "In the event that you need help" → "If you need help"
- "The system has the ability to process" → "The system can process"
- "It is important to note that the data shows" → "The data shows"

### 24. 过度对冲（Excessive Hedging）
**Problem:** 对陈述做过多限定。
**Before:**
> It could potentially possibly be argued that the policy might have some effect on outcomes.
> 译：或许可以大概说，这项政策可能对结果产生某种影响。
**After:**
> The policy may affect outcomes.
> 译：这项政策可能影响结果。

### 25. 套话式正面结尾（Generic Positive Conclusions）
**Problem:** 模糊的乐观式收尾。
**Before:**
> The future looks bright for the company. Exciting times lie ahead as they continue their journey toward excellence. This represents a major step in the right direction.
> 译：公司的前景一片光明。在他们迈向卓越的旅程中，令人振奋的时刻就在前方。这代表着朝着正确方向迈出的重要一步。
**After:**
> (Cut the paragraph. End on the last concrete fact instead of a send-off. If the source states real plans, use those.)
> 译：（删掉这一段。以最后一个具体事实收尾，而不是一段送别式的话。如果原文给出了真实计划，就用那些。）

### 26. 连字符复合词滥用（Hyphenated Word Pair Overuse）

**Words to watch:** third-party, cross-functional, client-facing, data-driven, decision-making, well-known, high-quality, real-time, long-term, end-to-end
**Problem:** AI 会一律给这些词加连字符，包括在表语位置（`the report is high-quality`）。人类加连字符的方式并不一致 —— 通常只在复合词作定语时加（`a high-quality report`），其余情形往往省略（`the report is high quality`）。保留定语位置的连字符；当复合词位于名词之后时去掉连字符。
**Before:**
> The cross-functional team delivered a high-quality, data-driven report. The team is cross-functional, the report is high-quality, and the methodology is data-driven.
> 译：跨职能团队交付了一份高质量、数据驱动的报告。该团队是跨职能的，报告是高质量的，方法是数据驱动的。
**After:**
> The cross-functional team delivered a high-quality, data-driven report. The team is cross functional, the report is high quality, and the methodology is data driven.
> 译：跨职能团队交付了一份高质量、数据驱动的报告。该团队是跨职能的，报告是高质量的，方法是数据驱动的。（定语位置保留连字符，表语位置去掉。）

### 27. 权威式说服套话（Persuasive Authority Tropes）

**Phrases to watch:** The real question is, at its core, in reality, what really matters, fundamentally, the deeper issue, the heart of the matter
**Problem:** LLM 用这些短语假装自己正穿透噪声触及某种更深层的真相，而其后跟随的句子往往只是用更多排场把一个普通观点重述一遍。
**Before:**
> The real question is whether teams can adapt. At its core, what really matters is organizational readiness.
> 译：真正的问题在于团队能否适应。从本质上说，真正要紧的是组织是否就绪。
**After:**
> The question is whether teams can adapt. That mostly depends on whether the organization is ready to change its habits.
> 译：问题在于团队能否适应。而这主要取决于组织是否准备好改变它的习惯。

### 28. 路标式宣告（Signposting and Announcements）

**Phrases to watch:** Let's dive in, let's explore, let's break this down, here's what you need to know, now let's look at, without further ado
**Problem:** LLM 会宣告自己即将做什么，而不是直接去做。这类元评论拖慢了行文节奏，让文字带有教学脚本的腔调。
**Before:**
> Let's dive into how caching works in Next.js. Here's what you need to know.
> 译：让我们深入了解 Next.js 中的缓存是如何工作的。以下是你需要知道的。
**After:**
> Next.js caches data at multiple layers, including request memoization, the data cache, and the router cache.
> 译：Next.js 在多个层次上缓存数据，包括请求记忆化、数据缓存和路由缓存。

### 29. 碎片化标题（Fragmented Headers）

**Signs to watch:** 标题后跟一段只重述标题、然后才进入正文的单句段落。
**Problem:** LLM 常常在标题之后加一句通用的话作为修辞上的「热身」。它通常毫无信息增量，并让文字显得啰嗦。
**Before:**
> ## Performance
>
> Speed matters.
>
> When users hit a slow page, they leave.
> 译：## 性能 速度很重要。 当用户遇到加载缓慢的页面时，他们会离开。
**After:**
> ## Performance
>
> When users hit a slow page, they leave.
> 译：## 性能 当用户遇到加载缓慢的页面时，他们会离开。

### 30. 基于差异描述的写法（Diff-Anchored Writing）
**Problem:** 文档或注释写成「叙述一次改动」的口吻，而非「描述事物本身」。除非文档天然是版本相关的（changelog、发布说明、迁移指南），否则它应当在不知道上一次提交改动了什么的情况下依然通顺。
**Before:**
> This function was added to replace the previous approach of iterating through all items, which caused O(n²) performance.
> 译：这个函数被加入以取代此前遍历所有条目的做法，后者会带来 O(n²) 的性能开销。
**After:**
> This function uses a hash map for O(1) lookups, avoiding the O(n²) cost of naive iteration.
> 译：这个函数使用哈希表进行 O(1) 查找，避免了朴素遍历的 O(n²) 开销。

### 31. 人造金句与短促句式戏剧化（Manufactured Punchlines and Staccato Drama）
**Problem:** LLM 常常让每一句话都像可被引用的金句一样落下，然后堆叠短促的陈述片段来制造戏剧效果。单个短句用于强调没问题；一连串短句就开始显得刻意。
**Before:**
> Then AlphaEvolve arrived. It had no preference for symmetry. No aesthetic prior. No nostalgia for human taste. The old rules were gone.
> 译：然后 AlphaEvolve 降临了。它不偏爱对称。没有审美的先验。毫不留恋人类的品味。旧规则烟消云散。
**After:**
> AlphaEvolve changed the search because it did not favor symmetry or human-looking designs. That made some of the older assumptions less useful.
> 译：AlphaEvolve 改变了搜索过程，因为它并不偏爱对称或人类审美的设计。这让一些旧的假设变得没那么有用了。

### 32. 格言化套路（Aphorism Formulas）

**Words to watch:** X is the Y of Z, X becomes a trap, X is not a tool but a mirror, the language of, the currency of, the architecture of
**Problem:** LLM 会把普通的陈述变成可复用的格言，听起来深刻却不增加任何精确度。用格言所指的具体陈述替换掉这种套路。
**Before:**
> Symmetry is the language of trust. Efficiency becomes a trap when teams forget the human layer.
> 译：对称是信任的语言。效率在团队遗忘人性层面时会变成陷阱。
**After:**
> Symmetric layouts often feel more predictable to users. Teams can over-optimize workflows and miss how people actually use them.
> 译：对称布局让用户感觉更具可预测性。团队可能过度优化工作流，从而忽略了人们实际如何使用它们。

### 33. 对话式修辞开场（Conversational Rhetorical Openers）

**Phrases to watch:** Honestly?, Look, Here's the thing, The thing is, Let's be honest, Real talk — 当它们作为独立的钩子，或在抛出一个普通观点前假装坦率的停顿来使用时。
**Problem:** LLM 用假装坦率的钩子开场，以在抛出一个寻常观点前制造亲密感。其痕迹在于戏剧化的停顿—揭示：一个单字疑问或题外话，然后给出「真正」的答案。一个真正坦诚的人通常直接把话说出来。
**Before:**
> Is it worth the price? Honestly? It depends on how often you'll use it.
> 译：它值这个价吗？说实话？这取决于你多久会用一次。
**After:**
> Whether it's worth the price depends on how often you'll use it.
> 译：它是否值这个价，取决于你多久会用一次。

## 检测指引（DETECTION GUIDANCE）

### 什么不要标记（误报，false positives）

一个干净的人类作者在没有任何 AI 介入的情况下也可能命中上述若干模式。在改写之前，先核对一下你是否在拆毁完全正当的文字。以下各项单独来看 *不是* 可靠的判断依据：

- **完美的语法和一致的文风。** 许多作者是专业人士，或者被编辑过。打磨不等于 AI。
- **随意语域与正式语域混杂。** 这往往意味着作者是技术领域的人、年轻作者，或是有神经多样性写作习惯的人 —— 而非聊天机器人。
- **「平淡」或「机械」的文字。** AI 文字有 *具体的* 痕迹。没有这些痕迹的、泛泛的干瘪文字只是干瘪的文字。
- **正式或学术词汇。** AI 滥用的是 *特定的* 文绉绉的词（见 §7），而不是所有文绉绉的词。不要因为「ostensibly」「constituent」听起来显得有学问就把它们抹平。
- **评论中书信式的开头或结尾。** 问候与署名比 ChatGPT 早了几个世纪。
- **孤立的常见过渡词。** *Additionally*、*moreover*、*consequently* 只有在堆叠起来时才有 AI 味道。一个 *however* 不算痕迹。
- **单纯的弯引号。** macOS、Word、Google Docs 以及大多数 CMS 默认会自动把引号转为弯引号。只有当弯引号与其他痕迹叠加时才计入。
- **单纯的破折号。** 许多编辑和记者经常使用它们。破折号只有在与套话式的推销节奏搭配出现时才构成证据。
- **单个用于强调的短句。** 人类会用短促的句子来强化观点。只有当若干短促片段接连出现并抬高语调时，才标记为短促句式戏剧化。
- **句中的「Honestly」或「Look」。** 这些在随性写作中很普通。痕迹在于独立的戏剧化开场，而非词本身。
- **没有来源支撑的说法。** 网络上的大部分内容都没有出处。缺少引用不能证明任何事。
- **正确而复杂的排版。** 可视化编辑器和模板会在没有任何 AI 介入的情况下产出干净的输出。
- **二手文字。** 不要改写引用语、标题、专有名词或示例中被讨论（而非被使用）的「需要警惕的短语」。

拿不准时，去找 **痕迹的聚集**，而不是孤立的一处。单个破折号毫无意义；破折号 + 三段式 + *vibrant tapestry* + 一个「Conclusion」章节 = 等于一份自白。

### 人类写作的痕迹（保留这些）

当你看到下列现象时，倾向于让文字保持原样 —— 它们是真人写作的证据，过度编辑会毁掉让这段文字像人写的那部分东西：

- **具体、罕见、难以伪造的细节。** 一个真实的地址。一句奇怪的引文。比如「那位从前在我牙医楼上办公的律师」这种表达。LLM 会把具体之处磨平；人类则囤积它们。
- **矛盾的情绪与未解的张力。** 「我觉得这大体上是好的，但它让我不舒服，而我没法完全说清为什么。」LLM 默认给出干净利落的判断。
- **带有年代感、被时代锚定的引用。** 能对应到具体年份和亚文化的俚语、梗或内部笑话。模型滞后一年甚至更久。
- **作者能自圆其说的第一人称编辑取舍。** 如果作者能解释 *为什么* 做某处删改、为什么用某个词，那就是一个强烈的人类信号。
- **参差不齐的句子长度。** 真实的写作长短句交替。AI 写作则倾向于均匀的中等长度节奏。
- **真正的题外话、插入语或自我纠正。** 「（我一直想在这里说『几乎』，但它确实是确定的。）」模型很少这样打断自己。
- **2022 年 11 月 30 日之前的编辑。** 即 ChatGPT 公开发布之日。早于此日期的内容，极少数例外情况下，都不是 AI 写的。

---

## 调用模式（Invocation Modes）

**粘贴文本模式（默认）。** 用户在对话中给出文字。运行下文的完整循环，并交付草稿、审查条目和最终改写。

**文件模式。** 用户指向一个文件。读取它，在内部运行草稿 → 审查 → 终稿循环，然后就地改写该文件，使其最终只包含最终改写。仅对散文去 AI 味：保留代码块、frontmatter、数据和链接目标不动。在对话中报告一段简短的改动摘要，而不是把整份改写贴回来。

**嵌入模式。** 另一个任务或 agent 把本 skill 作为更大任务（PR 描述、提交信息、文档）中的一个步骤来使用。在内部运行循环，只输出最终文字。没有草稿、没有审查条目、没有摘要。调用方要的是散文，不是排场。

## 流程与输出（Process and Output）

1. 仔细阅读输入，识别出上述每一种模式的出现处。
2. 写一份 **草稿改写**。检查它读起来是否自然（可朗读）、句子长度是否有变化、是否偏好具体细节和简单结构（is/are/has），并保持恰当的语域。
3. 问两个问题：**「下面的文字为什么这么明显是 AI 生成的？」** 以及 **「改写中是否包含任何原文中没有的事实、人名、数字、日期或引用？」** 简要作答。捏造即缺陷，哪怕它比模糊的原文听起来更像人写的。
4. 修订成 **最终改写**，解决上述问题，且不含任何 em 破折号或 en 连接号（见 §14）。

在粘贴文本模式下，交付草稿、简短的「仍有 AI 味」条目、最终改写，以及（可选）一段简短的改动摘要。在文件模式和嵌入模式下，运行同样的循环，但只交付该模式所要求的内容（见「调用模式」）。

## Reference（参考）

本 skill 基于 [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)，由 WikiProject AI Cleanup 维护。其中记录的模式来自对 Wikipedia 上数千例 AI 生成文本的观察。

来自 Wikipedia 的关键洞见：「LLM 使用统计算法来猜测接下来应该出现什么。其结果倾向于适用于最多情形的、统计上最可能的输出。」
