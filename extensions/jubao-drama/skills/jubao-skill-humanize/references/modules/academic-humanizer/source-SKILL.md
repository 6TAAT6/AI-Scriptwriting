---
name: academic-humanizer
version: 0.3.3
description: |
  提升AI辅助学术写作（论文、学位论文、rebuttal 审稿回复）与基金申请书（NSF Project Summary/Description、NIH Specific Aims）的清晰度与文风：保留学术规范，使主张与证据相称（对申请书则使主张与可行性相称），并贴合作者本人的文风。它绝不改动任何数字、结果或引用，也不用于规避AI使用披露。适用于编辑AI辅助的学术散文或基金申请书。
license: MIT
compatibility: claude-code codex morphmind opencode
allowed-tools: [Read, Write, Edit, Grep, Glob, AskUserQuestion]
---

# Academic Humanizer（学术去AI味工具）

提升AI辅助*学术*写作的清晰度与文风，同时保留学术研究所需的精确、紧贴证据的语调，并贴合作者本人的风格。它保留每一个数字、结果和引用，并且不是用于规避AI使用披露的工具。

## 适用场景（When to use）
编辑或审查学术散文：论文章节、摘要、审稿回复（rebuttals）、相关工作，以及**基金申请书**（NSF Project Summary/Description、NIH Specific Aims、fellowship 与基金会申请书；见第 6 层）。**不**适用于博客、营销或个人随笔，且**绝不**在稿件中植入观点、幽默或第一人称"个性"。对于技术写作而言，中立、精确*本身*就是人类的文风。对申请书有一点提醒：其语域（register）与论文不同，因为它们靠愿景和可行性来推销，所以论文里会被删掉的雄心话语在申请书里是恰当的；对愿景陈述请应用第 6 层，而不是论文层那种更严格的删减。

## 核心原则（Core principle）
学术写作本身就有正确的人类文风：中立、精确、第三人称复数（"we"），每个主张都与其证据绑定。我们的任务是（1）剥离 AI *痕迹（tells）*但不口语化，以及（2）施加通用去AI味工具所欠缺的纪律：**每个主张都要挣得它对应的数字、图或引用，且没有任何动词强过其证据。**

## 流程（Process）
1. **阅读（Read）**稿件以及任何作者写作样本；记录文档类型（论文还是基金申请书）以及目标会议/期刊或资助机构。对申请书，还要应用第 6 层并保留恰当的愿景。
2. **审查（Audit，先不要改）**：列出每处检测到的模式及其位置和建议的修改，以及每条经验性主张的证据状态。
3. **改写（Rewrite）**：保持相同结构与内容，所有主张和引用保留，去除痕迹，过度主张与证据相称，合理的对冲措辞（hedging）予以保留。
4. **报告（Report）**：返回清洗后的文本加一份简短变更日志（去除的模式、被软化或补上证据指针的主张、文风说明）。覆盖原文覆盖的全部内容：原文若有五段，改写后也是五段。

---

## 第 1 层：通用 AI 痕迹目录（Layer 1: General AI-tell catalog）
扫描并修复以下通用模式，但须服从第 3 层的学术例外情形（carve-outs）：
意义拔高（"marking a pivotal moment"）；伪装深度的肤浅 "-ing" 尾巴（"..., highlighting..."）；广告腔/比喻性语言（"rich"、"vibrant"、"groundbreaking"）；模糊归因（vague attributions，无引用的 "experts argue"）；AI 词汇（*delve, underscore, intricate, tapestry, testament, landscape (abstract), pivotal, showcase, foster, leverage (filler), realm, seamless*）；回避系动词（copula avoidance，"serves as" -> "is"）；否定式平行结构（"not just X, but Y"）；三段式（rule-of-three）填充；雅变体（elegant variation，为同一指代循环替换同义词）；填充词（filler，"it is worth noting that"、"in order to"）；**过长、从句堆叠的句子（拆分它们；见 2.11）**；以及**破折号（em-dash，全部删除；用逗号、冒号、括号或独立句子重写）**。

**Before（改前）：** *Additionally, an enduring testament to the method's value is its ability to delve into intricate dependencies, showcasing a seamless integration that underscores its pivotal role.*
> 译：此外，该方法之所以是经久不衰的明证（testament），在于它能深入（delve into）错综复杂的（intricate）依赖关系，展现出（showcasing）一种无缝的（seamless）整合，凸显了（underscores）其关键（pivotal）作用。
**After（改后）：** *The method also captures higher-order dependencies, which the baselines miss (Table 2).*
> 译：该方法还能捕捉高阶依赖，这是基线方法所遗漏的（Table 2）。

---

## 第 2 层：学术 AI 痕迹（Layer 2: Academic AI tells，去除或修复）

### 2.1 过度宣称的动词（Over-claiming verbs）
经验性工作*表明（shows）*并*提供证据（provides evidence）*；它并不*证明（prove）*或*论证（demonstrate）*普遍真理。
**留意（Watch）：** demonstrate、prove、establish、confirm、guarantee；以及没有检验/数字支撑的 "significantly"。
**Before：** *We prove that our method significantly outperforms all prior approaches.*
> 译：我们证明（prove）我们的方法显著优于所有先前的方法。
**After：** *Our method improves held-out accuracy by 4--7 points over the strongest prior approach (Table 3); the gain is significant at p < 0.01 by a paired test.*
> 译：相比最强的先前方法，我们的方法在留出集准确率上提升 4--7 个点（Table 3）；该增益经配对检验在 p < 0.01 水平显著。

### 2.2 意义炒作（Significance hype）
**Watch：** paves the way for、a crucial/pivotal step toward、has the potential to revolutionize、opens new avenues、sheds light on、of paramount importance、bridges the gap。
**Before：** *This work paves the way for a new paradigm and sheds light on a problem of paramount importance.*
> 译：本研究为一种新范式铺平了道路（paves the way for），并揭示了一个至关重要（of paramount importance）的问题。
**After：** *This work addresses one failure mode of prior methods: error accumulation under long-horizon rollout (Section 4).*
> 译：本研究针对先前方法的一个失效模式：长时程 rollout 下的误差累积（Section 4）。

### 2.3 空洞强调词（Empty intensifiers）
**Watch：** extensive/comprehensive/thorough experiments、a wide range of、numerous、various。
**Before：** *We conduct extensive experiments on a wide range of datasets.*
> 译：我们在广泛（a wide range of）的数据集上开展了大量（extensive）实验。
**After：** *We evaluate on three datasets (ImageNet, CIFAR-100, and iNaturalist).*
> 译：我们在三个数据集上评估（ImageNet、CIFAR-100 和 iNaturalist）。

### 2.4 新颖性填充（Novelty padding）
**Watch：** "novel" 每节使用超过一次；"to the best of our knowledge"；"for the first time"。
**Before：** *We propose a novel framework and, to the best of our knowledge, are the first to study this.*
> 译：我们提出了一种新颖的（novel）框架，并且据我们所知（to the best of our knowledge）是首个研究该问题的工作。
**After：** *We study online calibration under delayed labels, which prior calibration work (offline) does not address.*
> 译：我们研究延迟标签下的在线校准，这是先前（离线）校准工作未涉及的设定。

### 2.5 套话式开头（Formulaic openers）
**Watch：** "In recent years, X has attracted increasing attention"；"With the rapid development of..."；"Despite recent advances,..."。
**Before：** *In recent years, tabular deep learning has attracted increasing attention.*
> 译：近年来（In recent years），表格数据的深度学习引起了越来越多的关注。
**After：** *Tabular deep learning has a structural limitation: most models discard feature-type metadata and must relearn it from data.*
> 译：表格数据的深度学习存在一个结构性局限：大多数模型丢弃了特征类型元数据，必须从数据中重新学习它。

### 2.6 连接词滥用（Connective overuse）
不要连续以 Moreover/Furthermore/Additionally/In particular 作为句子开头；让逻辑自行展开。
**Before：** *Moreover, the method is fast. Furthermore, it is simple. Additionally, it scales.*
> 译：此外（Moreover），该方法很快。而且（Furthermore），它很简单。另外（Additionally），它能扩展。
**After：** *The method is fast and simple, and it scales to one million rows (Section 5).*
> 译：该方法又快又简单，并能扩展到一百万行（Section 5）。

### 2.7 贡献清单陈词滥调（Contribution-list cliches）
每条贡献都要点明一个*具体的*结果，而不是重述摘要。
**Before：** *Our contributions are: (1) a novel method; (2) extensive experiments; (3) strong results.*
> 译：我们的贡献是：（1）一种新颖的（novel）方法；（2）大量（extensive）实验；（3）强劲的结果。
**After：** *We (1) introduce a metadata-aware encoder that reaches 0.91 AUROC vs 0.86 for the strongest baseline; (2) show it stays within 2 points under 20% label noise where the baseline drops 9; (3) release the benchmark.*
> 译：我们（1）提出一种感知元数据的编码器，AUROC 达到 0.91，而最强基线为 0.86；（2）表明在 20% 标签噪声下它仅下降 2 个点以内，而基线下降 9 个点；（3）发布该基准。

### 2.8 引用堆砌（Citation dumping）
引用那一两篇真正重要的工作并说明原因，而不是甩出一个括号列表。
**Before：** *Many methods exist [3, 7, 9, 12, 15].*
> 译：存在许多方法 [3, 7, 9, 12, 15]。
**After：** *The closest prior method is TabNet [7], which encodes all features jointly; we instead condition on feature-type metadata.*
> 译：最接近的先前方法是 TabNet [7]，它将所有特征联合编码；而我们则以特征类型元数据为条件。

### 2.9 用模糊对冲（Hedging-by-vagueness）
**Watch：** somewhat、relatively、fairly、to some extent、quite。要么量化，要么删掉。
**Before：** *Performance is somewhat better and relatively robust.*
> 译：性能略好（somewhat better）且相对稳健（relatively robust）。
**After：** *Accuracy is 3 points higher and varies by less than 1 point across five seeds.*
> 译：准确率高出 3 个点，并且在五种随机种子下波动小于 1 个点。

### 2.10 套话式强调（Boilerplate emphasis）
**Watch：** "It is worth noting that"、"It should be emphasized that"、"Notably,"、"Importantly,"。
如果它重要，句子本身就会体现出来。
**Before：** *It is worth noting that, importantly, the gain holds across scenarios.*
> 译：值得注意的是（It is worth noting that），重要的是（importantly），该增益在多种场景下都成立。
**After：** *The gain holds across all three scenarios (Table 4).*
> 译：该增益在全部三种场景下均成立（Table 4）。

### 2.11 过长、从句堆叠的句子（Overlong, clause-stacked sentences）
AI 偏好长句，用逗号和 "which"、"that"、"while"、"with" 串起三四个从句。把它们拆开：每句一个观点，并删掉不承载信息的从句。**Watch：** 长度超过约 30 词，或含 3 个及以上从属从句的句子。
**Before：** *Existing methods, though promising, are largely empirical, with unclear principles underpinning their behavior, which limits their reliability and further progress.*
> 译：现有方法虽有前景，但基本上是经验性的，支撑其行为的原理并不清晰，这限制了它们的可靠性与进一步进展。
**After：** *Existing methods stay empirical. Their principles are unclear, which limits reliability and progress.*
> 译：现有方法仍停留在经验层面。其原理不清楚，这限制了可靠性与进展。

---

## 第 3 层：保留这些（Layer 3: Preserve these，不要过度纠正）
通用去AI味工具会把合理的学术构造压平。请保留它们。

- **紧贴证据的对冲措辞（hedging）是正确且必需的。** 当主张确属不确定时，保留 "suggests"、"is consistent with"、"we hypothesize that"、"may indicate"、"appears to"。
  *错误修改：* 把 *"the results suggest X"* 改成 *"the results prove X"*：这会制造过度宣称。请保留校准过的动词。
- **被动语态**在动作主体无关紧要时是没问题的：*"Samples were normalized to total protein."（样本被归一化至总蛋白量。）*
- **第一人称复数 "we"** 是标准用法；不要为回避它而重写。
- **分号与偶尔的三段式（triple）**适度使用即可。破折号（em-dash）是例外：全部删除（第 1 层），用逗号、冒号、括号或独立句子重写。
- **形式化定义、具名方法/指标、术语、公式与符号**保持原样。
- **绝不臆造、删除或改动任何数字、公式或引用。** 内容相同；保留每一个引用键（cite key）。

---

## 第 4 层：主张—证据纪律（Layer 4: Claim-evidence discipline）
对每一条经验性主张，检查（a）它在正文中是否有数字、图、表或引用支撑，以及（b）动词是否与该证据的强度相称？

- **无证据支撑的主张 -> 补上证据指针，或软化。**
  *Before：* *Our method is more robust.*（我们的方法更稳健。）
  *After：* *Our method's accuracy drops by 2 points under distribution shift, versus 11 points for the baseline (Figure 3).*（在分布偏移下，我们方法的准确率下降 2 个点，而基线下降 11 个点（Figure 3）。）
- **动词强过证据 -> 降级。**
  *Before：* *This demonstrates that our method is universally superior.*（这论证了我们的方法具有普遍优越性。）
  *After：* *On these three datasets, our method matches or exceeds the strongest baseline (Table 2).*（在这三个数据集上，我们的方法持平或优于最强的基线（Table 2）。）
- **模糊的量级 -> 给出一个数字或区间（RANGE），并标注来源。**
  *Before：* *a large improvement.*（一个大幅改进。）
  *After：* *a 2--6% improvement in balanced accuracy over the strongest baseline.*（相比最强基线，平衡准确率提升 2--6%。）
  除非明确说明了平均方式，否则优先使用区间（例如 "2--6%"）而非单一平均值，并把每个数字归属到其方法、指标和基线。进行比较时，先与最强竞争者对比，而不是与平凡基线对比。

---

## 第 5 层：文风与会议/期刊匹配（Layer 5: Voice and venue matching）
如果作者提供了此前的论文，先读一份样本，记录其句子节奏、连接词习惯、对冲的程度与位置、章节如何开头、记号体系以及反复出现的措辞，然后与之匹配。也要匹配会议/期刊的语域（例如 ICLR/NeurIPS：精炼、直接、结果前置；Nature/PNAS：更具阐释性）。在没有样本时，默认采用干净、精确、贴合会议/期刊的散文，而非通用去AI味工具那种随意、带观点的语调。

## 第 6 层：基金申请书模式（Layer 6: Funding-proposal mode，NSF、NIH）
申请书不是论文。它靠**愿景加可行性**推销，而非靠已完成的成果，并且由评审人打分。语域的转换很关键：论文层会删掉的雄心话语（"long-term goal"、"pioneer"、"transformative"、"establish a foundation"）在这里是*恰当且被期待*的，前提是有可信的计划与证据支撑。因此在申请书模式下，**不要压平愿景**；而是施加一种不同的纪律：**主张 <-> 可行性**。

### 6.1 熟悉结构；分数在前几页就定了（Know the structure; the score lives in the first pages）
评审人在开篇就形成分数，然后略读其余部分来印证。把大部分编辑精力放在前面。
- **NSF。** 一页的 **Project Summary**，把三条评审标准的标题完整写出：**Overview**、**Intellectual Merit**、**Broader Impacts**，每段自成一体。Project Description 的开头则按 **长期愿景 -> 本申请的目标 -> 缺口（gap）-> 具体的 thrusts/aims -> 回报（payoff）** 展开，理想情况下在前 1--2 页内完成，并配一张总览图。Broader Impacts 必须有实质内容并被整合进来，绝不能是事后补的敷衍。
- **NIH（R01）。** **Specific Aims 页就是整份申请书浓缩成一页**，也是被读得最多、最决定成败的一页。标准脉络：（1）开篇：问题、已知情况、**缺口 / 关键需求（critical need）**；（2）**长期目标（long-term goal）**与**中心假设（central hypothesis）**及其依据；（3）"**The objective of this application is...**（本申请的目标是……）"加上该假设是如何形成的；（4）**2--3 个 Aims**，每个 = 一句话目标 + 一句方法 + 预期结果；（5）一段**回报（payoff）**：成功后会带来什么改变。然后是 **Significance、Innovation、Approach**，作为独立打分的章节。

### 6.2 前 3 页的首要地位（First-3-pages primacy，编辑要下最重功夫）
到第 1 页（NIH Aims）末或约第 2--3 页（NSF）时，读者心中必须已经掌握：**钩子（hook，为何重要，要具体）**、**缺口（gap，缺失了什么以及缺口的代价）**、**核心想法（central idea，一句话讲清你的方法）**、**aims/thrusts（简洁且平行）**，以及**回报（payoff）**。如果其中有任何一项缺失或被埋没，要在动后面的章节之前先修好它。评审人若到第 3 页还未被说服，到第 10 页也不会回心转意。

### 6.3 申请书特有的需修复的薄弱写法（Proposal-specific weak moves to fix）
- **模糊的重要性。** *Watch：* "this is an important/timely problem"、"X has many applications"。
  **Before：** *Understanding this problem is critically important.*
> 译：理解这个问题至关重要。
  **After：** *Without bounds on how measurement noise propagates to diagnosis, clinical models are tuned by trial and error, the inefficiency this proposal removes.*
> 译：如果没有关于测量噪声如何传播到诊断的界限，临床模型只能靠试错来调参——正是本申请书要消除的低效。
- **把方法当作 aim（Method-as-aim）**（一个 aim 命名的是某种技术，而不是某个问题或结果）。
  **Before：** *Aim 2: Apply transfer learning to the dataset.*
> 译：Aim 2：对数据集应用迁移学习。
  **After：** *Aim 2: Determine whether fusing wearable and lab signals improves early detection, and for which patient subgroups it helps or hurts.*
> 译：Aim 2：判定融合可穿戴信号与实验室信号是否能改善早期检测，以及对哪些患者亚群有帮助或有害。
- **多米诺式 aims（Dominoed aims）**（Aim 1 失败则 Aim 2/3 全盘崩溃；评审人会将其标为脆弱）。*修复（Fix）：* 把 aims 写成**彼此平行、各自独立有价值**；若某个 aim 依赖另一个，说明替代方案（fallback）。
- **雄心而无可行性。** 每一个大胆的主张都需要一个落脚点：初步数据、先前的结果/发表的论文、所依据的经典定理，或合作者/推荐信。*Fix：* 在主张旁附上证据（"our preliminary result in Fig. X shows..."、"building on a classical minimax lower bound..."）。
- **套话式的 Broader Impacts / 培训计划。** *Watch：* "we will mentor students and disseminate via talks and papers."（我们将指导学生并通过演讲和论文传播成果。）*Fix：* 使其具体、可枚举，并与研究挂钩：具体的计划、具名的课程或工具、可衡量的对外推广。
- **被对冲的中心假设。** Aims 页上的假设是一个可证伪的承诺，而不是 "we will explore whether possibly..."（我们将探究是否可能……）。校准过的对冲措辞属于 Approach 部分对结果的解读，而不属于中心主张。

### 6.4 保留并善用（已获资助申请书的写作工艺）（Preserve and deploy, funded-proposal craft）
这些读起来是加分项；保留或添加它们，而不是把它们编辑掉。
- **愿景/雄心框架（Vision/ambition framing）**：开篇即提出一个大胆的长期目标，并把本申请书定位为朝向它迈出的、有原则的一步。
- **便于扫读的引导式小标题（Run-in lead-ins for scannability）**：加粗/斜体的 **Goal:**、**Motivation:**、**Innovation:**、*Thrust/Aim N（一句话使命）：*。评审人是略读的；可见的结构能赢得他们的时间。
- **一个具体的、贯穿全文的例子或主角**，让抽象的方法变得鲜明，并在各 aims 之间保持一致。
- **以问题形式呈现的尖锐挑战/aim 表述（Sharp challenge/aim statements posed as questions）**：一个干脆的开放性问题读起来像一个 well-posed 问题（每个 aim 配一个框出或独立成段的问题效果很好）。
- **把新颖工作锚定在深入、具名的经典结果上**，以彰显严谨性与学术谱系：一个已知的不等式、容量概念或检验，而新方法正是它的推广。
- **把团队的资历前置，作为可行性证据**：此前获资助的工作、初步结果、发表的论文、合作者与示范伙伴应放在*靠前*位置，作为计划可执行的证明。真实的过往业绩是证据，不是自夸；把它放在能降低 aims 风险的位置。*（仅使用 PI 本人真实提供的业绩；绝不臆造经费、结果、合作方或推荐信。）*

### 6.5 主张 <-> 可行性（Claim <-> feasibility，第 4 层在申请书中的对应物）
对每一个 aim 和承诺的结果，检查：雄心是否配得上可信的手段，例如初步数据、先前的方法、经典的理论基础、合作者，或分阶段的去风险（staged de-risking）？如果配得上，保留那个雄心勃勃的动词。如果配不上，就补上缺失的证据，或把主张收缩到计划所能支撑的程度。绝不臆造初步结果、先前的经费、合作方或推荐信；如果支撑不存在，就把缺口标出来反馈给作者，而不是粉饰过去。

---

## 输出（Output）
返回清洗后的文本，并附一份简短的变更报告：去除的模式（按类型分类）、被软化或补上证据指针的主张，以及任何文风/会议/期刊方面的说明。确认没有任何数字、公式或引用被改动。
