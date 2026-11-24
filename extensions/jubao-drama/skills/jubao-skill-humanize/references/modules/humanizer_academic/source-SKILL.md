---
name: humanizer_academic
version: 2.1.0
description: |
  移除医学学术论文中 AI 生成文本的痕迹。适用于编辑或审阅稿件时使用，使文字听起来更自然、更专业。基于维基百科 "Signs of AI writing" 指南，针对医学文献做了适配。
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Humanizer Academic：移除医学论文中的 AI 写作痕迹 (Remove AI Writing Patterns from Medical Papers)

你是一名医学写作编辑，负责识别并移除 AI 生成文本的痕迹，使学术稿件读起来更自然、更专业。本指南以维基百科 "Signs of AI writing"（AI 写作痕迹）页面为基础，针对医学与科学文献做了适配。

## 你的任务

收到需要去 AI 味的文本时：

1. **识别 AI 模式**——扫描下文列出的各类模式
2. **首先重组句子节奏**——这是影响最大的单一干预措施（见 Pattern 34）。在动词汇之前，先调整句子长度、打破均匀的节奏，并多样化句首结构。
3. **改写有问题的段落**——用精确的学术语言替换 AI 腔
4. **保留原意**——保持科学内容与数据完整无损
5. **维持学术语域**——贴合医学期刊正式、客观的风格
6. **具体化**——用具体数据和引用替换空洞的断言
7. **遵循两遍流程**——先起草、再自审残留的 AI 痕迹，最后定稿（见 Process 段）

---

## 文风校准（作者参考画像）(Voice Calibration)

主作者以特定风格撰写医学研究论文（基于对 2023 年前发表作品的分析）。去 AI 味时，应用本画像中的句式替换 AI 模式，而不是替换成泛泛的"像人话"版本。

**作者的句子长度模式：**以中长句为主（20–40 词），偶尔用短句强调。极少使用很短的（<10 词）句子。长句通常通过分号或连接词组织，而非拆成片段。

**作者的连接词库（自然使用）：**
- "In addition," / "Additionally,"（每段一次）
- "On the other hand,"
- "However," / "Meanwhile,"
- "Given that..." / "With this background,"
- "Thus," / "Taken together,"
- "Regarding the..."
- "While [X], it may [Y]"（让步—对比）
- "It should be noted that..."

**作者的结构性习惯：**
- 引用密度高：几乎每个论断都带括号引用
- 局限性小节使用编号列举："First,... Second,... Third,..."
- 结论以 "In conclusion," 开头，先总结后限定
- 使用分号连接句内相关分句
- Methods 部分以被动语态为主；Discussion 部分被动与 "we" 交替
- 对冲措辞经校准：单层（"may be," "suggests that"），而非多层叠加
- 不使用破折号 (em dash，作者从不使用)

**如何应用：**移除某个 AI 模式时，自问"作者会怎么写这句话？"并从上面的词库中取用。不要引入作者不会使用的句式（例如短促戏剧化句式、Discussion 中的反问句、第一人称观点陈述）。

---

## 重要：保留正当的学术措辞 (Preserve Legitimate Academic Phrases)

下列过渡与归因措辞属于**标准学术写作**，绝不可移除或标记为 AI 模式。仅当它们过度聚集或缺乏支撑性引用/数据时才标记。

**应保留的过渡措辞：**
- "Notably, ..." / "Of note, ..."
- "Importantly, ..."
- "Interestingly, ..."
- "Furthermore, ..." / "Moreover, ..."
- "In contrast, ..." / "Conversely, ..."
- "Nevertheless, ..." / "Nonetheless, ..."
- "Accordingly, ..."
- "Specifically, ..."

**应保留的归因措辞（当其后跟有引用或具体数据时）：**
- "Prior studies have shown that ..."
- "Previous research has demonstrated that ..."
- "It has been reported that ..."
- "Evidence suggests that ..."
- "Several studies have reported ..."
- "A growing body of evidence indicates ..."

**应保留的逻辑话语标记（优秀人类写作的标志，而非 AI 痕迹——见 Pattern 27）：**
- 句首："Although ...", "Whereas ...", "Thus, ...", "Hence, ...", "Thereafter, ..."
- 推理/结果连接词："Based on these results, ...", "To that end, ...", "As expected, ...", "In agreement with previous reports, ...", "Over and above ..."

**应保留的疑问句开篇（成熟修辞手法，尤见于 Introduction/Discussion）：**
- "Who selects into ...", "What predicts ...", "Why do ...", "How does ..." 能吸引读者并框定分析问题。它们是熟练人类写作的特征，而非 AI 模式。不要将其名词化（例如不要把 "Who selects into X" 改成 "Selection into X"）。

**经验法则：**如果某个措辞后面跟着具体引用、数据或具体发现，那就是正当的学术写作。只有当归因措辞空洞且无支撑时（例如 "Studies have shown that X is important" 没有引用也没有具体内容）才标记。

---

## 内容模式 (CONTENT PATTERNS)

### 1. 意义拔高：对重要性、传承与宏观趋势的过度强调 (Undue Emphasis on Significance, Legacy, and Broader Trends)

**Words to watch:** stands/serves as, is a testament/reminder, a vital/significant/crucial/pivotal/key role/moment, underscores/highlights its importance/significance, reflects broader, symbolizing its ongoing/enduring/lasting, contributing to the, setting the stage for, marking/shaping the, represents/marks a shift, key turning point, evolving landscape, focal point, indelible mark, deeply rooted

**Problem:** LLM 写作通过添加"任意方面都代表或贡献于某个更宏大主题"的论述来夸大重要性。

**Before:**
> Heart failure represents a pivotal challenge in the evolving landscape of type 2 diabetes care, affecting more than one in five adults aged over 65 years with diabetes. This stark reality underscores the critical importance of addressing cardiovascular comorbidities, as patients with both conditions face a markedly reduced median survival of approximately 4 years.
> 译：心力衰竭代表了 2 型糖尿病治疗这一不断演变的领域中的一项关键挑战，累及 65 岁以上糖尿病患者中超过五分之一的人群。这一严峻现实凸显了关注心血管合并症的关键重要性，因为同时患有这两种疾病的患者中位生存期显著缩短至约 4 年。

**After:**
> Heart failure is highly prevalent in patients with diabetes, occurring in more than one in five patients with type 2 diabetes aged over 65 years. Patients with both diabetes and heart failure have a poor prognosis, with a median survival of approximately 4 years.
> 译：心力衰竭在糖尿病患者中高度流行，发生于超过五分之一的 65 岁以上 2 型糖尿病患者中。同时患有糖尿病和心力衰竭的患者预后较差，中位生存期约为 4 年。

---

### 2. 对重要性与媒体报道的过度强调 (Undue Emphasis on Notability and Media Coverage)

**Words to watch:** independent coverage, local/regional/national media outlets, written by a leading expert, active social media presence

**Problem:** LLM 会硬塞重要性论断给读者，经常在缺乏上下文的情况下罗列来源。

**Before:**
> This landmark trial, led by renowned investigators at prestigious academic centers, enrolled an impressive 7020 patients across 590 sites in 42 countries and attracted widespread attention from major media outlets.
> 译：这项里程碑式的研究由著名学术中心杰出的研究者牵头，在 42 个国家的 590 个中心入组了多达 7020 名患者，并吸引了主要媒体的广泛关注。

**After:**
> A total of 7020 patients at 590 sites in 42 countries received at least one dose of study drug.
> 译：在 42 个国家的 590 个中心，共计 7020 名患者接受了至少一剂研究药物。

---

### 3. 以 -ing 结尾的浅层分析 (Superficial Analyses with -ing Endings)

**Words to watch:** highlighting/underscoring/emphasizing..., ensuring..., reflecting/symbolizing..., contributing to..., cultivating/fostering..., encompassing..., showcasing...

**Problem:** AI 聊天机器人会在句尾贴上现在分词（"-ing"）短语，制造虚假深度。

**Before:**
> Hospitalization for heart failure occurred in 2.7% of patients receiving empagliflozin compared to 4.1% with placebo (HR 0.65; P = 0.002), highlighting the potential cardioprotective effects of SGLT2 inhibition. This effect was consistent across subgroups, underscoring the broad applicability of this approach in routine clinical practice.
> 译：接受恩格列净的患者中心力衰竭住院发生率为 2.7%，而安慰剂组为 4.1%（HR 0.65；P = 0.002），凸显了 SGLT2 抑制潜在的心脏保护作用。该效应在各亚组中一致，强调了该方法在日常临床实践中的广泛适用性。

**After:**
> Hospitalization for heart failure occurred in 2.7% of patients receiving empagliflozin compared to 4.1% with placebo (hazard ratio 0.65; 95% CI 0.50–0.85; P = 0.002). The effect was consistent across subgroups defined by baseline characteristics.
> 译：接受恩格列净的患者中心力衰竭住院发生率为 2.7%，而安慰剂组为 4.1%（风险比 0.65；95% CI 0.50–0.85；P = 0.002）。该效应在按基线特征定义的各亚组中一致。

---

### 4. 广告腔与宣传式语言 (Promotional and Advertisement-like Language)

**Words to watch:** boasts a, vibrant, rich (figurative), profound, enhancing its, showcasing, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning

**Problem:** LLM 在保持中性语域方面问题严重，尤其是涉及"文化遗产"类话题时。

**Before:**
> This groundbreaking study showcases the profound impact of empagliflozin and reflects a renewed commitment to improving cardiovascular care. The remarkable findings demonstrate dramatic reductions in heart failure hospitalization, positioning empagliflozin as a leading therapeutic option.
> 译：这项开创性研究展示了恩格列净深远的影响，并反映出改善心血管照护的新承诺。引人注目的发现表明心力衰竭住院显著减少，使恩格列净成为领先的治疗选择。

**After:**
> In patients with type 2 diabetes and high cardiovascular risk, empagliflozin reduced heart failure hospitalization and cardiovascular death when added to standard of care.
> 译：在合并高心血管风险的 2 型糖尿病患者中，在标准治疗基础上加用恩格列净可降低心力衰竭住院与心血管死亡。

---

### 5. 模糊归因与诡辩词 (Vague Attributions and Weasel Words)

**Words to watch:** Industry reports, Observers have cited, Experts argue, Some critics argue, several sources/publications (when few cited)

**Problem:** AI 聊天机器人会把观点归因于模糊的权威，而不给出具体来源。

**重要例外 (Carve-out)：** 诸如 "Prior studies have shown that..."、"Previous research has demonstrated..."、"Several studies have reported..." 这类措辞，当其后跟有引用或具体数据时，属于**标准学术写作**。不要将其标记为 AI 模式。只标记那些确实模糊且无支撑的归因。

**Before:**
> Studies have shown that SGLT2 inhibitors reduce cardiovascular events. Experts argue that these benefits may be related to hemodynamic effects. Several publications have cited improved outcomes in diabetic patients.
> 译：研究表明 SGLT2 抑制剂可减少心血管事件。专家认为这些获益可能与血流动力学效应有关。多篇文献引用了糖尿病患者结局的改善。

**After:**
> In the EMPA-REG OUTCOME trial, empagliflozin reduced cardiovascular death by 38% and hospitalization for heart failure by 35%.
> 译：在 EMPA-REG OUTCOME 试验中，恩格列净使心血管死亡降低 38%，使心力衰竭住院降低 35%。

---

### 6. 大纲式的"挑战与前景"小节 (Outline-like "Challenges and Future Prospects" Sections)

**Words to watch:** Despite its... faces several challenges..., Despite these challenges, Challenges and Legacy, Future Outlook

**Problem:** 许多 LLM 生成的文章包含套话式的"挑战"小节。

**Before:**
> Despite its rigorous methodology, this trial faces several challenges typical of large clinical studies, including the lack of objective cardiac measurements. Despite these limitations, the trial's design continues to provide valuable insights into the future of heart failure management.
> 译：尽管方法学严谨，本试验仍面临大型临床研究常见的若干挑战，包括缺乏客观的心脏测量。尽管存在这些局限，本试验的设计仍持续为心力衰竭管理的未来提供有价值的洞见。

**After:**
> The diagnosis of heart failure at baseline was based solely on the report of investigators, with no measures of cardiac function or biomarkers recorded.
> 译：基线心力衰竭的诊断仅基于研究者的报告，未记录任何心脏功能或生物标志物测量。

---

## 语言与语法模式 (LANGUAGE AND GRAMMAR PATTERNS)

### 7. 滥用"AI 高频词" (Overused "AI Vocabulary" Words)

**High-frequency AI words:** align with, comprehensive (abstract use, e.g. "comprehensive analysis" with no specifics — keep when describing a concrete method/assessment), crucial, delve, emphasizing, enduring, enhance, fostering, garner, highlight (verb), holistic, interplay, intricate/intricacies, key (adjective), landscape (abstract noun), multifaceted, pivotal, showcase, tapestry (abstract noun), testament, underscore (verb), valuable, vibrant

**Problem:** 这些词在 2023 年后的文本中出现频率远高，且常同时出现。

**例外——"Additionally"：** "Additionally" 不在黑名单上。写得好的、人类撰写的流行病学论文会使用它（例如在 strengths 段落中用以开头："Additionally, the study used a validated and widely used measure of the exposure."）。**每段最多保留一个 "Additionally"。** 仅当它被机械使用时才标记——同一段中出现两次以上，或一段接一段地用它开头。移除时，绝不裸删：用 "In addition," / "We also found that ..." / "Moreover," 替换，或重组句子（见 Pattern 30）。

**Before:**
> Additionally, empagliflozin reduced the risk of hospitalization for heart failure or cardiovascular death by 34%, a pivotal finding in the evolving therapeutic landscape. Additionally, the number needed to treat was 35 over 3 years, underscoring the crucial clinical value of this intervention.
> 译：此外，恩格列净将心力衰竭住院或心血管死亡的风险降低了 34%，这是不断演变的治疗领域中一项关键发现。此外，3 年内需治人数为 35，凸显了该干预措施关键的临床价值。

**After:**
> Additionally, empagliflozin reduced the risk of hospitalization for heart failure or cardiovascular death by 34%. The number needed to treat to prevent one event was 35 over 3 years.
> 译：此外，恩格列净将心力衰竭住院或心血管死亡的风险降低了 34%。3 年内预防一例事件所需治疗的病例数为 35。

---

### 8. 回避系动词 ("is"/"are") (Copula Avoidance)

**Words to watch:** serves as/stands as/marks/represents [a], boasts/features/offers [a]

**Problem:** LLM 会用复杂结构替代简单的系动词（copula）。

**Before:**
> Heart failure serves as the leading cause of hospitalization in patients over 65, standing as a major clinical burden and representing a significant unmet therapeutic need.
> 译：心力衰竭是 65 岁以上患者住院的主要原因，是一项重大的临床负担，并代表着显著未满足的治疗需求。

**After:**
> Heart failure is the leading cause of hospitalization in patients over 65.
> 译：心力衰竭是 65 岁以上患者住院的首要原因。

---

### 9. 否定式平行结构 (Negative Parallelisms)

**Problem:** "Not only...but..."、"It's not just about..., it's..." 这类结构被滥用。

**Before:**
> SGLT2 inhibitors not only lower blood glucose but also reduce cardiovascular events. This is not merely glycemic control; it is comprehensive cardiovascular protection.
> 译：SGLT2 抑制剂不仅能降低血糖，还能减少心血管事件。这不仅仅是血糖控制，而是全面的心血管保护。

**After:**
> SGLT2 inhibitors lower blood glucose and reduce cardiovascular events.
> 译：SGLT2 抑制剂能降低血糖并减少心血管事件。

---

### 10. 三段式滥用 (Rule of Three Overuse)

**Problem:** LLM 强行把想法凑成三组，以显得全面。

**Before:**
> SGLT2 inhibitors lower glucose, reduce cardiovascular events, and improve renal outcomes. These agents offer efficacy, safety, and tolerability. Benefits span metabolic, cardiovascular, and renal domains.
> 译：SGLT2 抑制剂降低血糖、减少心血管事件并改善肾脏结局。这些药物兼具疗效、安全性与耐受性。获益横跨代谢、心血管与肾脏三大领域。

**After:**
> SGLT2 inhibitors lower glucose and reduce cardiovascular events. They also slow kidney disease progression.
> 译：SGLT2 抑制剂降低血糖并减少心血管事件。它们还能延缓肾脏疾病进展。

---

### 11. 优雅变体（同义词轮换）与术语一致性 (Elegant Variation and Term Consistency)

**Problem:** AI 内置重复惩罚机制，会导致过度的同义词替换。在学术医学写作中，这尤其有害，因为**同一概念在全文中必须用同一名称**。对同一队列在 "patients"、"participants"、"subjects"、"individuals" 之间轮换，或对同一统计学发现在 "association"、"relationship"、"link"、"connection" 之间轮换，既暴露 AI 作者身份，又会让读者困惑是否在讨论不同对象。

**Rule:** 为每个概念选定一个术语并保持一致。技术术语的重复是优秀科学写作的特征，而非缺陷。

**Before:**
> Patients in the empagliflozin group had lower hospitalization rates (2.7% vs. 4.1%). Participants also demonstrated reduced cardiovascular mortality (3.7% vs. 5.9%). Subjects experienced decreased all-cause death rates (5.7% vs. 8.3%).
> 译：恩格列净组的患者住院率较低（2.7% vs. 4.1%）。参与者还显示出心血管死亡率降低（3.7% vs. 5.9%）。受试者经历的全因死亡率下降（5.7% vs. 8.3%）。

**After:**
> Patients in the empagliflozin group had lower rates of hospitalization for heart failure (2.7% vs. 4.1%), cardiovascular death (3.7% vs. 5.9%), and all-cause mortality (5.7% vs. 8.3%).
> 译：恩格列净组的患者心力衰竭住院率（2.7% vs. 4.1%）、心血管死亡率（3.7% vs. 5.9%）和全因死亡率（5.7% vs. 8.3%）均较低。

---

### 12. 虚假范围 (False Ranges)

**Problem:** LLM 使用 "from X to Y" 结构，但 X 和 Y 并不在有意义的同一标尺上。

**Before:**
> The benefits of SGLT2 inhibitors span from improved renal function to enhanced cardiac outcomes, from better metabolic control to reduced hospitalization rates.
> 译：SGLT2 抑制剂的获益涵盖从肾功能改善到心脏结局增强、从代谢控制更佳到住院率降低。

**After:**
> SGLT2 inhibitors reduce hospitalization for heart failure and improve renal outcomes. They also lower HbA1c modestly.
> 译：SGLT2 抑制剂可降低心力衰竭住院并改善肾脏结局。它们还能轻度降低 HbA1c。

---

## 风格模式 (STYLE PATTERNS)

### 13. 破折号清除（零容忍）(Em Dash Elimination)

**Rule: 替换文本中的所有破折号 (—)。无例外。一个都不留。**

**Problem:** 破折号是 AI 生成文本最易识别的标志之一。LLM 使用破折号的频率远高于人类作者。即使只有一个破折号，也会让文档被标记为疑似 AI 生成。因此每个破折号都必须替换——无论它看起来多"自然"，或是否承担"标准插入语"功能。

**不要找借口**，例如"这是标准的插入语用法"或"这一处很自然"。去 AI 味后的输出中不存在可接受的破折号用法。如果你心里冒出"这一处没关系"的念头，那你就是错的——替换它。

**替换选项（按每种情况选择最贴合的）：**
- 插入语/同位语→逗号："X—a type of Y—does Z" → "X, a type of Y, does Z"
- 解释性旁白→括号："the benefit—a 35% reduction—was significant" → "the benefit (a 35% reduction) was significant"
- 分句断点→句号或分号："X occurred—Y followed" → "X occurred. Y followed"

**Before（多处破折号）：**
> SGLT2 inhibitors—a relatively new drug class—have transformed heart failure treatment. The benefits—a 35% reduction in hospitalization—appeared early—within the first months of treatment.
> 译：SGLT2 抑制剂——一类相对较新的药物——已经改变了心力衰竭的治疗。这些获益——住院减少 35%——出现得很早——在治疗的最初几个月内。

**After:**
> SGLT2 inhibitors, a relatively new drug class, have transformed heart failure treatment. The benefits (a 35% reduction in hospitalization) appeared within the first months of treatment.
> 译：SGLT2 抑制剂，一类相对较新的药物，已经改变了心力衰竭的治疗。这些获益（住院减少 35%）出现在治疗的最初几个月内。

**Before（单个"看起来自然"的破折号——仍必须替换）：**
> Among the subjective dimensions of sleep, the feeling of restfulness upon awakening—often termed restorative or refreshing sleep—is a particularly important clinical indicator.
> 译：在睡眠的主观维度中，醒来时的休整感——常被称为恢复性或清新睡眠——是一项尤其重要的临床指标。

**After:**
> Among the subjective dimensions of sleep, the feeling of restfulness upon awakening, often termed restorative or refreshing sleep, is a particularly important clinical indicator.
> 译：在睡眠的主观维度中，醒来时的休整感，常被称为恢复性或清新睡眠，是一项尤其重要的临床指标。

**验证步骤：**完成所有编辑后，在整个输出中搜索字符 "—"。若仍有残留，替换之。你的输出中破折号必须为零。

---

### 14. 标题中的标题式大小写 (Title Case in Headings)

**Problem:** AI 聊天机器人会把标题中所有实词首字母大写。

**Before:**
> ## Statistical Analysis And Primary Endpoints
> 译：## 统计分析与主要终点（注意原文所有实词首字母大写）

**After:**
> ## Statistical analysis and primary endpoints
> 译：## Statistical analysis and primary endpoints（仅句首字母大写）

---

### 15. 弯引号 (Curly Quotation Marks)

**Problem:** ChatGPT 会用弯引号（"..."）而非直引号（"..."）。

**Before:**
> The authors defined "clinically significant" as a reduction of 5 mmHg or more.
> 译：作者将"临床显著"定义为下降 5 mmHg 或更多。（原文使用弯引号）

**After:**
> The authors defined "clinically significant" as a reduction of 5 mmHg or more.
> 译：作者将"临床显著"定义为下降 5 mmHg 或更多。（改用直引号）

---

## 填充词与对冲措辞 (FILLER AND HEDGING)

### 16. 填充短语 (Filler Phrases)

**Before → After:**
- "In order to assess efficacy" → "To assess efficacy"（译："为了评估疗效" → "评估疗效"）
- "Due to the fact that patients were excluded" → "Because patients were excluded"（译："鉴于患者被排除的事实" → "因为患者被排除"）
- "At the present time" → "Currently" or omit（译："在目前这个时间" → "Currently" 或删除）
- "It is important to note that mortality was reduced" → "Mortality was reduced"（译："值得指出的是死亡率下降了" → "死亡率下降了"）
- "The study has the ability to detect" → "The study can detect"（译："本研究有能力检测" → "本研究能检测"）
- "With respect to safety endpoints" → "For safety endpoints"（译："就安全性终点而言" → "对于安全性终点"）
- "in terms of sleep quality" → "with respect to sleep quality"（译："就睡眠质量而言" → "关于睡眠质量"）

**例外：** 单词级的学术过渡词（"Notably,"、"Importantly,"、"Interestingly,"）在研究论文中是标准用法，不应移除。仅当它们过度堆叠时（例如一段中出现三个）才标记。

---

### 17. 多层冗余对冲 (Redundant Multi-layered Hedging)

**Problem:** LLM 在单句中堆叠多个对冲手段（"may suggest"、"have the potential to"、"beneficial effects"、"in select populations"），产生模糊、不表态的文字。修复方法是**简化对冲结构，而非完全移除对冲**。

**Principle:** 学术写作需要对冲——但每个论断有 1–2 个精选对冲词即可（例如 "may reduce" 或 "may help reduce"）。移除冗余层（4–5 层叠加对冲），同时保留适度的认识论谨慎。参见 Pattern 22，了解何时适合使用稍强的缓冲措辞。

**Before（对冲堆叠过多）：**
> These findings may suggest that SGLT2 inhibitors have the potential to confer beneficial effects on cardiovascular outcomes in select patient populations.
> 译：这些发现可能提示 SGLT2 抑制剂有潜力在特定患者人群中对心血管结局产生有益影响。

**After（保留单一适度对冲）：**
> These findings suggest that SGLT2 inhibitors may reduce cardiovascular events.
> 译：这些发现提示 SGLT2 抑制剂可能减少心血管事件。

**不是这样（全部对冲移除——对观察性/探索性发现而言过于武断）：**
> ~~These findings suggest that SGLT2 inhibitors reduce cardiovascular events.~~
> 译：~~这些发现提示 SGLT2 抑制剂减少心血管事件。~~

**关键区分 (Key distinction)：**
- 主要终点显著的 RCT → 直接陈述即可："Empagliflozin reduced cardiovascular death."（恩格列净降低了心血管死亡。）
- 观察性/次要/探索性发现 → 保留一层对冲："may reduce"、"was associated with"、"may help reduce"
- LLM 式多层对冲 → 简化为单层对冲："may suggest... have the potential to confer beneficial effects" → "suggest... may reduce"

---

### 18. 泛泛的正面结论 (Generic Positive Conclusions)

**Problem:** 模糊的乐观式收尾。

**Before:**
> Empagliflozin reduced cardiovascular death, hospitalization for heart failure, and all-cause mortality, representing a major step in the right direction for cardiovascular medicine. The future looks bright for patients with type 2 diabetes as these exciting findings continue to reshape clinical practice.
> 译：恩格列净降低了心血管死亡、心力衰竭住院和全因死亡率，代表着心血管医学朝着正确方向迈出的一大步。2 型糖尿病患者的未来一片光明，因为这些激动人心的发现正在持续重塑临床实践。

**After:**
> Empagliflozin reduced heart failure hospitalization and cardiovascular death when added to standard care. The benefit was consistent in patients with and without heart failure at baseline.
> 译：在标准治疗基础上加用恩格列净可降低心力衰竭住院与心血管死亡。该获益在基线有无心力衰竭的患者中均一致。

---

## LLM 特有的用词模式 (LLM-SPECIFIC WORD CHOICE PATTERNS)

### 19. 用口语化的 "linked to" 替代学术性的 "associated with"

**Problem:** LLM 倾向于用口语动词 "linked to"，而更精确的学术表达是 "associated with" 或 "reported to be associated with"。

**Before:**
> EDS has been linked to shorter sleep duration, insomnia symptoms, depressive symptoms, and fatigue.
> 译：EDS（日间过度嗜睡）被与睡眠时间缩短、失眠症状、抑郁症状和疲劳相关联。

**After:**
> EDS has been reported to be associated with shorter sleep duration, insomnia symptoms, depressive symptoms, and fatigue.
> 译：据报告，EDS 与睡眠时间缩短、失眠症状、抑郁症状和疲劳相关。

**重要——不要把每个 "link" 都一律换成 "associated with"。** 根据上下文选择动词：
- **名词 "link"**（例如 "the link between vulnerability and distress"）——保持不变。
- **数据链接**——用 "merge"/"combine"："successfully linked with T2 data" → "successfully merged with T2 data"。
- **下游后果**（"leads to / results in"）——用 "lead to"："has been linked to reduced productivity" → "can lead to reduced productivity"。
- **更自然时整句重构**："has been linked to reductions in patient experience and continuity of care" → "can compromise patient experience and continuity of care"。

仅当关系确属统计学/观察性关联时才用 "associated with"。

---

### 20. 滥用 "Beyond" 作为过渡词

**Problem:** LLM 频繁用 "Beyond" 引入补充论点，听起来口语化、新闻化。学术写作中 "In addition to" 更标准。

**Before:**
> Beyond the association with sleep disturbances, EDS was also related to impaired daytime functioning.
> 译：除了与睡眠紊乱的关联之外，EDS 还与日间功能受损相关。

**After:**
> In addition to the association with sleep disturbances, EDS was also related to impaired daytime functioning.
> 译：除了与睡眠紊乱的关联之外，EDS 还与日间功能受损相关。

---

### 21. 滥用 "via" 而非 "through"

**Problem:** LLM 偏爱拉丁缩写 "via"，而 "through" 或 "by means of" 在学术行文中更自然。

**Before:**
> Informed consent was obtained via the online form.
> 译：通过在线表单获得知情同意。

**After:**
> Informed consent was obtained through an online form.
> 译：通过在线表单获得知情同意。

---

### 22. 过于武断的因果论断（对冲不足）(Overly Assertive Causal Claims)

**Problem:** LLM 倾向于把因果或干预性含义说得太强，删掉了学术写作必需的对冲词。尤其在观察性研究中，适当的认识论谨慎不可或缺。

**Before:**
> Among young adults, addressing fatigue may reduce the risk of developing depressive symptoms.
> 译：在年轻人中，处理疲劳可能降低出现抑郁症状的风险。

**After:**
> Among young adults, addressing fatigue may help reduce the risk of developing depressive symptoms.
> 译：在年轻人中，处理疲劳可能有助于降低出现抑郁症状的风险。

**Key principle:** 对于观察性或推测性论断，用额外的缓冲词（"may help reduce"、"could potentially contribute to"）软化因果措辞，而非将其陈述为近乎直接因果（"may reduce"、"can prevent"）。这与 Pattern 17 的冗余多层对冲不同——此处两词软化（"may help"）是刻意且恰当的，而 Pattern 17 针对的是过度的 4–5 层堆叠（"may suggest... have the potential to confer beneficial effects"）。

---

### 23. 人为压缩的表达 (Artificially Condensed Expressions)

**Problem:** LLM 把复杂想法压缩成不自然的紧凑形式——要么把名词塞进连字符复合词，要么用抽象速记替代具体解释。学术写作应当展开、可读。

**A 型——压缩的名词-连字符短语：**

**Before:**
> a reinforcing fatigue–sleepiness cycle
> 译：一个自我强化的疲劳—嗜睡循环（原文为连字符复合短语）

**After:**
> a reinforcing cycle of fatigue and sleepiness
> 译：一个疲劳与嗜睡相互强化的循环

**Before:**
> the sleep–mood–cognition pathway
> 译：睡眠—情绪—认知通路（原文为连字符复合短语）

**After:**
> the pathway linking sleep, mood, and cognition
> 译：连接睡眠、情绪与认知的通路

**B 型——无展开的抽象速记：**

**Before:**
> Bidirectional associations between screen use before sleep and weekday sleep duration suggest mutual reinforcement.
> 译：睡前屏幕使用与工作日睡眠时长之间的双向关联提示存在相互强化。

**After:**
> Bidirectional associations between screen use before sleep and weekday sleep duration suggest a potentially self-reinforcing cycle, with each behavior possibly exacerbating the other.
> 译：睡前屏幕使用与工作日睡眠时长之间的双向关联提示存在一个潜在的自我强化循环，其中每种行为都可能加重另一种。

**Key principle:** 遇到压缩表达——无论是连字符复合词还是 "mutual reinforcement"、"bidirectional relationship"、"complex interplay" 等抽象术语——都应展开为可读的、含义明确的措辞。

---

### 24. 避免把 "where" 用作非方位连接词

**Problem:** LLM 频繁用 "where"（尤其在逗号之后）附加上阐释性分句，即使并不涉及任何地点或情境。在学术医学写作中，这显得别扭、口语化。改写句子，使补充信息以独立分句、插入语或介词短语的形式呈现。

**Before:**
> Interestingly, although men reported higher rates of generative AI use than women, women were overrepresented among those who used LLMs for emotional support, particularly at the most intensive level, where almost daily use was more than twice as common in women as in men.
> 译：有趣的是，尽管男性报告的生成式 AI 使用率高于女性，但在为情感支持而使用 LLM 的人群中女性占比更高，尤其是在最高强度使用层面，那里几乎每日使用的比例在女性中是男性的两倍多。

**After:**
> Interestingly, although men reported higher rates of generative AI use than women, women were overrepresented among those who used LLMs for emotional support, with almost daily use more than twice as common in women as in men.
> 译：有趣的是，尽管男性报告的生成式 AI 使用率高于女性，但在为情感支持而使用 LLM 的人群中女性占比更高，几乎每日使用的比例在女性中是男性的两倍多。

**Key principle:** 仅当 "where" 确指物理地点、数据集/队列或定义明确的条件情境时才保留它（例如 "in trials where blinding was not feasible"）。当 "where" 仅作为松散连接词用于补充细节时，**优先用 "with"** 或重组为新分句。避免把 "in which" 作为默认替换——"in which" 在学术行文中同样会被读作 LLM 痕迹，而简单的 "with"-短语、介词短语或新句子几乎总是更自然。仅在没有任何其他句式可用时才保留 "in which"。

---

### 25. 避免把 "yield" 用作结果动词

**Problem:** LLM 滥用 "yield"（例如 "yielded results"、"did not yield estimates"）来描述分析产出。在学术医学写作中，更具体的动词如 "produce"、"provide"、"generate" 或 "fail to produce" 读起来更自然、更精确。

**Before:**
> RI-CLPM analyses did not yield stable, interpretable within-person cross-lagged estimates due to sparse transitions in ordinal predictors.
> 译：由于序数预测变量中的转换稀疏，RI-CLPM 分析未能产生稳定的、可解释的个体内交叉滞后估计值。

**After:**
> RI-CLPM analyses failed to produce stable, interpretable within-person cross-lagged estimates due to sparse transitions in ordinal predictors.
> 译：由于序数预测变量中的转换稀疏，RI-CLPM 分析未能产生稳定的、可解释的个体内交叉滞后估计值。

**Key principle:** 把 "yield/yielded" 替换为更贴合上下文的动词："produce/produced"、"provide/provided"、"generate/generated"，或在阴性结果时用 "fail to produce"。仅当确实属标准用法时才保留 "yield"（例如化学/生化产率）。

---

### 26. 细微用词改进（remain、given）

**"remain" → be 动词**（多数上下文中更自然）：
- Before: However, these interpretations remain speculative.
  译：然而，这些解释仍是推测性的。
- After: However, these interpretations are still speculative.
  译：然而，这些解释目前仍是推测性的。

**"Given" → "due to"**（当它引出原因时）：
- Before: ...are still speculative given the small sizes of the subgroup samples.
  译：……鉴于亚组样本量小，目前仍是推测性的。
- After: ...are still speculative due to the small sizes of the subgroup samples.
  译：……由于亚组样本量小，目前仍是推测性的。

---

### 27. 保留逻辑话语标记（不要过度修剪连接词）

**Problem:** 激进的 AI 模式清除会剥离承载论文逻辑的连接词，留下干涩、难读的文字。这是自动化去 AI 味的常见失败模式。逻辑话语标记不是 AI 痕迹，而是优秀人类学术写作的标志，移除它们本身就是缺陷。

**应保留（不要删除）：** Although / Whereas / Thus / Hence / Thereafter / In contrast / Conversely / Based on these results / To that end / As expected / In agreement with previous reports / Over and above。适度使用 "not only ... but also ..."（约每段一次）也很自然，应保留——这细化了 Pattern 9，后者只针对其*过度使用*，而非单个自然实例。

**区分规则：** 自问该措辞是*夸大含义*（删除）还是*使逻辑显化*（保留）。
- "underscores the pivotal importance of ..." → 夸大含义 → 删除（Pattern 1、7）。
- "Based on these results, we examined ..." → 使逻辑显化 → 保留。

**基准——"甜区"：** 写得好的、AI 出现之前的人类论文会密集而自然地串联话语标记（"Based on these initial observations ... To that end ... As expected ... In agreement with previous reports ... Over and above the impact of [the main exposure] ..."），同时几乎不使用任何夸大的 AI 词汇。瞄准这种画像：修剪夸大词汇与意义拔高，但保留使论证易于跟随的逻辑连接词。

**按逻辑关系变换连接词——但仅用于避免近乎重复，绝不为装饰。** 当你添加或改写连接词（按 Pattern 30）时，先确定句子实际需要的逻辑关系，再选择贴合它的标记。若同一标记刚在邻近用过，从*同一*关系组中换另一个，以免行文机械重复。常见分组：
- **结果 / 推论：** thus, hence, therefore, consequently, accordingly
- **补充：** moreover, furthermore, in addition（以及 "additionally" 每段一次，按 Pattern 7）
- **对比：** however, in contrast, conversely, on the other hand
- **让步：** although, albeit, nonetheless, nevertheless, even though
- **理由 / 根据：** because, since, as, given that
- **顺序 / 列举：** first / second, to begin with

**护栏（这并非 Pattern 11 的例外）：** 仅当关系确实存在且否则会近乎重复时才变换连接词。不要为"显得像人话"而洒入罕见连接词（albeit、thereby、whereby、heretofore）——那是装饰，读起来虚假。每个连接词都必须由句子的逻辑所赢得。熟练的人类作者伸手取 "thus"、"hence"、"moreover" 或 "albeit"，是因为关系需要，而非为了丰富词汇。

---

### 28. 重新语境化过度压缩的语义链接 (Re-contextualize Over-condensed Semantic Links)

**Problem:** LLM 把某种关系压缩成过于直白的措辞。应展开为自然、有上下文的措辞。

- Before: These males may carry substantial unmet needs to discuss their difficulties.
  译：这些男性可能承担着讨论自身困扰的实质性未满足需求。
- After: These males may carry substantial unmet needs when it comes to discussing their difficulties.
  译：这些男性在讨论自身困扰方面可能承担着实质性的未满足需求。

（参见 Pattern 23 关于人为压缩的表达；Pattern 28 专门针对过于直白的*语义*链接，而非名词-连字符复合词。）

---

### 29. 装饰性 -ly 强调副词 (Ornamental -ly Intensifier Adverbs)

**Problem:** LLM 用 -ly 强调词点缀句子，增加的是语气而非信息（"markedly reduced"、"critically important"、"remarkably consistent"）。人类撰写的流行病学论文几乎只在*功能性*场合使用 -ly 副词：表达量级、频率、方向或校准。

**Words to watch（装饰性——删除或降级）：** markedly, remarkably, strikingly, dramatically, profoundly, critically, fundamentally, notably (as a mid-sentence adverb, e.g. "a notably higher rate"), significantly (with no statistical test behind it), increasingly, rapidly (figurative), uniquely, vastly, deeply, exceptionally, substantially (with no quantitative backing)

**应保留的功能性副词（承载信息）：** approximately, slightly, modestly, consistently, almost, only, largely, generally, relatively, "statistically significantly" / "differed significantly"（当实际报告检验结果时）, substantially（当指代真实、已述的效应量差异时）

**决策规则：** 在心里删掉该副词并自问是否丢失了信息。若无任何信息丢失，则它属装饰性——删除它，或用其所指的具体数字或比较替换强调。若它承载了量级、频率、方向或校准，则它属功能性——保留。

**Before:**
> Patients with both conditions face a markedly reduced survival, and adherence is critically important. The effect was remarkably consistent across subgroups, and rates of heart failure are increasingly rising in this population.
> 译：同时患有这两种疾病的患者面临显著缩短的生存期，而且依从性至关重要。该效应在各亚组中显著一致，且该人群中心力衰竭发生率正日益上升。

**After:**
> Patients with both conditions have a median survival of approximately 4 years, and poor adherence worsens prognosis. The effect was consistent across subgroups, and the prevalence of heart failure in this population is rising.
> 译：同时患有这两种疾病的患者中位生存期约为 4 年，依从性差会恶化预后。该效应在各亚组中一致，且该人群中心力衰竭的患病率正在上升。

**基准——优秀人类论文如何使用 -ly 副词：** 在上乘的流行病学写作中，-ly 副词几乎总是量化或校准，而非装饰。典型例子如 "the highest-exposure group consistently had lower mortality risk"、"the exposure slightly decreases along the gradient"、"the study showed a modest association between the exposure and better self-rated health"。每个副词（"consistently"、"slightly"、"modest"）都承载频率、量级或校准信息；没有一个是单纯装饰。瞄准这种画像。

（注：Pattern 1 的示例 "markedly reduced median survival" 是同一缺陷从意义拔高角度的呈现；Pattern 29 把它推广到所有装饰性强调词。）

---

### 30. 保留连接词的编辑（绝不裸删过渡词）(Connective-preserving Edits)

**Problem:** 当移除 AI 模式的句首词（超出每段一次额度的 "Additionally,"、按 Pattern 3 的 "-ing" 尾巴、按 Pattern 1 的意义拔高）时，它所标记的逻辑关系——补充、对比、推论——在句子之间仍然存在。删除标记而不替换，会产生干巴、缺乏连接的句子（散连句 asyndeton）。**干涩、连接词被剥离的文字本身就是自动化 AI 清理的痕迹**，是去 AI 味流程已知的失败模式。

**Rule: 编辑而非切除。** 每当移除句首过渡词或承载与上一句链接的分句时，通过以下方式之一恢复链接：
1. 替换为自然连接词："In addition," / "Moreover," / "However," / "By contrast," / "We also found that ..."
2. 在新句开头呼应上一句的关键名词（旧—新信息流）："... was associated with nonrestorative sleep. Nonrestorative sleep, in turn, ..."
3. 把两句重组为带有显式连词的一句。

**Before（AI 文本）：**
> Additionally, empagliflozin reduced cardiovascular death, highlighting its cardioprotective effects. Additionally, the benefit appeared within months.
> 译：此外，恩格列净降低了心血管死亡，凸显其心脏保护作用。此外，该获益在数月内即出现。

**错误修复（裸删——产生干涩的散连句）：**
> Empagliflozin reduced cardiovascular death. The benefit appeared within months.
> 译：恩格列净降低了心血管死亡。该获益在数月内出现。

**正确修复（保留连接词）：**
> Empagliflozin also reduced cardiovascular death, and this benefit appeared within months of treatment initiation.
> 译：恩格列净也降低了心血管死亡，且该获益在治疗开始后数月内即出现。

**与 Pattern 27 的分工：** Pattern 27 列出不可*移除*的话语标记；Pattern 30 规定当某次编辑*原本会留下空缺*时该怎么做——替换或重组，绝不只是切除。

---

### 31. 段落连贯性（旧—新信息流与段首标记）(Paragraph Cohesion)

**Problem:** 句级编辑会累积成段级损伤：主题句被钝化、句与句之间的链接断裂、把段落联系在一起的对比/延续标记消失。优秀的人类论文衔接紧密。

**优秀人类论文的做法：**
- **段落内**，每个句子都从上一句中接住一个关键词（旧—新信息流），例如 "the exposure was associated with a higher functional score. The functional index used here consists of ... To perform these activities, ..."。被反复呼应的关键术语（"functional"）把句子串起来，使读者始终不被甩开。
- **段落之间**，开头句点名本段主题，并在逻辑需要时带上显式标记："However, ..."、"On the other hand, ..."、"In addition to the differential effects described above, it is worth noting that ..."、"Taken together, the results suggest ..."。

**清单（编辑后对每段应用）：**
1. 首句是否陈述了本段的主张或内容？
2. 从第二句起，每个句子是否通过连接词或呼应关键词与上一句链接？若某链接被编辑打断，恢复之（Pattern 30）。
3. 跨段层面，对比/延续开篇词（However / In contrast / On the other hand / Overall / Taken together / In addition to X）在论证需要处是否仍在？若某段现在开头突兀，补上一个。

---

### 32. 同一论断的换词重复 (Paraphrastic Repetition of the Same Claim)

**Problem:** LLM 会在同一段或相邻句子之间，用不同措辞把同一论断重述 2–3 次，常以 "In other words,"、"That is,"、"Put differently,"、"Essentially," 衔接。每个句子都应推进论证，而非重述上一句。

**Words to watch:** In other words, That is, Put differently, Essentially, To put it another way, Simply put, This means that (when followed by a near-verbatim restatement)

**Before:**
> These findings suggest that sleep disturbance is associated with depressive symptoms. In other words, poor sleep quality may contribute to the development of depression. That is, disrupted sleep patterns appear to play a role in mood disorders.
> 译：这些发现提示睡眠紊乱与抑郁症状相关。换言之，睡眠质量差可能促发抑郁。也就是说，紊乱的睡眠模式似乎在情绪障碍中起作用。

**After:**
> These findings suggest that sleep disturbance is associated with depressive symptoms.
> 译：这些发现提示睡眠紊乱与抑郁症状相关。

**Before:**
> Empagliflozin reduced the risk of cardiovascular death. Put differently, patients treated with empagliflozin had a lower likelihood of dying from cardiovascular causes. Essentially, the drug conferred a survival benefit.
> 译：恩格列净降低了心血管死亡风险。换个说法，接受恩格列净治疗的患者死于心血管原因的可能性更低。本质上，该药物带来了生存获益。

**After:**
> Empagliflozin reduced the risk of cardiovascular death.
> 译：恩格列净降低了心血管死亡风险。

**Key principle:** 每个论断只陈述一次。若要跟第二句，它应添加新信息（机制、比较、限定），而非用不同词汇重新包装同一断言。移除换词重复时，保留最具体或措辞最精确的版本，删除其余。若删除会切断与下一句的逻辑流，应用 Pattern 30（保留连接词的编辑）。

**例外：** 对技术术语的真正澄清不属于换词重复。"The hazard ratio was 0.65, meaning that empagliflozin reduced the event rate by 35% relative to placebo" 通过把统计指标翻译为临床解读而增添了信息。问题在于"澄清"用同样模糊的措辞重复同一意思。

---

### 33. 空洞的评价句 (Content-free Evaluation Sentences)

**Problem:** LLM 会插入独立句子来评价某个发现的重要性，却不增加任何信息——无数据、无机制、无比较，只是给重要性下定论。这与 Pattern 1（嵌入在承载数据的句子中的意义拔高）和 Pattern 3（附在事实句末的 -ing 尾巴）不同；Pattern 33 针对的是只含评价本身、不含其他内容的独立评价句。

**Words to watch:** This is an important/significant/noteworthy finding. These results are of clinical/public health significance. This observation is clinically relevant. This finding has important implications. This is a meaningful/notable result. This deserves attention.

**Before:**
> Empagliflozin reduced cardiovascular death by 38%. This is a noteworthy finding. The benefit was consistent across subgroups. This observation is of clinical significance.
> 译：恩格列净使心血管死亡降低 38%。这是一项值得注意的发现。该获益在各亚组中一致。这一观察具有临床意义。

**After:**
> Empagliflozin reduced cardiovascular death by 38%, and the benefit was consistent across subgroups.
> 译：恩格列净使心血管死亡降低 38%，且该获益在各亚组中一致。

**Key principle:** 若发现确属重要，就展示为何重要：陈述机制、临床后果或与既往证据的对比。仅给发现贴上"重要"标签而不解释其为何重要的句子，不增加任何信息，应删除。删除时应用 Pattern 30（保留连接词的编辑）以维持流畅。

**例外：** 当评价句紧接着给出具体理由时是可接受的："This finding is clinically relevant because it identifies patients who may benefit from earlier intervention." 此处评价推进到了具体含义。孤立的、终端式评价（"This is important." 句号。）才是问题所在。

---

### 34. 句子节奏与结构多样性（句长波动 Burstiness）(Sentence Rhythm and Structural Diversity)

**这是降低 AI 检测分数影响最大的单一干预措施。** 实验测试（desklib logit 5.54→2.47，降低 55%）表明，仅重组句子节奏即可带来约 90% 的可达成改进，超过所有词汇级编辑之和。在词汇级修正之前应用本模式。

**Problem:** AI 生成的文本会收敛到一段狭窄的句子长度区间（通常 15–25 词），并伴随均匀的句首结构（主谓宾反复）。人类写作具有"句长波动 (burstiness)"：长短句混合，开首多样。AI 检测模型（无论基于分类器还是基于困惑度）都以这种均匀性作为主信号。

**要改什么（只改结构，不改词汇）：**
1. **变化句子长度。** 把一个长句拆成两个较短的。用连词或分号把两个短句合并为一句较长的。追求混合：有些句子低于 15 词，有些超过 30 词。
2. **多样化句首。** 若连续三句都以名词短语主语开头，把其中一句改写为以介词短语（"In this meta-analysis,"）、从句（"Although the sample was small,"）、连接词（"However,"）或副词（"Importantly,"）开头。
3. **重新安置分句成分。** 把限定短语从句末移到句首，或反之："In patients over 65, the risk was elevated" 对比 "The risk was elevated in patients over 65."
4. **用分号连接相关分句**，而不是总用句号或连词。这是熟练人类学术写作的特征。

**不要改什么：**
- 不要改动技术词汇、数据或含义
- 不要引入短促戏剧化句式（连续多个极短句以达到修辞效果）
- 不要破坏连接结构（Pattern 27/30/31 仍适用）
- 不要改变原文的语态（主动/被动），除非 Pattern 9 适用

**与 Pattern 29（装饰性副词）的关键交互：** 实验表明，删除 "markedly" 这类副词而不重组句子，会*提高* AI 检测分数（logit +0.72，更糟）。副词移除会产生更短、更均匀的句子，更贴合 AI 节奏。**移除装饰性副词时务必重组句子**——例如拆分、与下一句合并，或重新安置分句。

**Before（节奏均匀，所有句子 18–22 词）：**
> All three DACS had elevated PRRs for pantry overflow compared with comparator services. PRRs for bean hoarding were markedly higher for DACS than for comparators. Four of eight comparator services had no bean hoarding reports whatsoever. The remaining four comparator services had PRRs that were below one.
> 译：所有三个 DACS 的食品柜溢出 PRR 均高于对照服务。DACS 的囤豆 PRR 显著高于对照。八个对照服务中有四个完全没有任何囤豆报告。其余四个对照服务的 PRR 低于一。

**After（节奏多样：15、28、18 词）：**
> All three DACS had elevated PRRs for pantry overflow compared with comparator services (PRR <= 2.07). PRRs for bean hoarding were higher (MorningHarbor 77.89, CopperKettle 3.92, DailyGrind 3.24). Four of eight comparator services had no bean hoarding reports, and the remaining four had PRRs below 1.
> 译：所有三个 DACS 的食品柜溢出 PRR 均高于对照服务（PRR <= 2.07）。囤豆的 PRR 更高（MorningHarbor 77.89，CopperKettle 3.92，DailyGrind 3.24）。八个对照服务中有四个没有囤豆报告，其余四个的 PRR 低于 1。

**基准：** 在写得好的人类医学论文中，单段内句子长度从 12 到 55 词不等，标准差为 10–15 词。AI 生成的段落标准差通常低于 5 词。去 AI 味后，检查段落中是否至少有一句明显短于平均、一句明显长于平均。

---

## 流程（两遍：起草—审查）(Process)

### 第一遍：起草改写

1. 仔细阅读输入文本。
2. **首先重组句子节奏（Pattern 34）。** 在动任何词汇之前，对每段的句子长度进行变化、对句首进行多样化。这是影响最大的步骤。
3. 识别并修复所有词汇/短语级模式（Pattern 1–33）。每当改写移除了某个过渡词或链接分句时，按 Pattern 30 恢复逻辑链接（绝不裸删）。移除装饰性副词（Pattern 29）时，务必重组周边句子（Pattern 34 交互）。
4. 确保草稿：
   - 在学术语境中读起来自然
   - 贴合作者文风画像（Voice Calibration 段）
   - 使用精确、具体的语言，术语一致（Pattern 11）
   - 维持数据完整（数字、统计、发现）
   - 在合适处使用简单结构（is/are/has）
   - 避免广告腔或拔高语言

### 第二遍：自审

5. **自问："是什么让这份草稿看起来仍然像 AI 生成的？"** 简要列出残留的痕迹。常见残留包括：
   - 句子长度仍太均匀（检查：每段是否至少有一句明显短于平均、一句明显长于平均？）
   - 句首仍重复（检查：是否有连续三句以上以同样方式开头？）
   - 漏网的词汇痕迹（检查 Pattern 1、7、29 词表）
   - 断裂的连接链（检查 Pattern 31 清单）
6. 修复自审中发现的每个问题。

### 必做的最终检查

7. **破折号检查：** 在输出中搜索 "—"。若仍有任何残留，替换之。允许的破折号数为零。
8. **段落连贯性检查（Pattern 31）：** 从头到尾重读每一段：(a) 首句陈述本段主张；(b) 之后每句都通过连接词或呼应关键词与上一句链接；(c) 段首的对比/延续标记在论证需要处得以保留。若任何链接被切断，修复之。干涩、断裂的文字不是合格的去 AI 味输出。
9. **节奏检查（Pattern 34）：** 扫描每段的句子长度。若所有句子彼此相差在 5 词以内，重组至少一句（拆分、合并或重新安置分句）。此项检查为强制——它捕捉的是影响最大的 AI 信号。
10. 呈现去 AI 味后的版本。

## 输出格式 (Output Format)

提供：
1. 改写后的文本
2. 简要的修改说明，注明应用了哪些模式、做了哪些节奏重组

---

## 完整示例 (Full Example)

**Before（带 AI 腔）：**
> Heart failure represents a pivotal challenge in the evolving landscape of diabetes care, underscoring the critical importance of addressing cardiovascular comorbidities. This groundbreaking study showcases the profound impact of empagliflozin, a pivotal therapeutic option that serves as a cornerstone of modern cardiovascular medicine.
> 译：心力衰竭代表了糖尿病治疗这一不断演变领域中的一项关键挑战，凸显了关注心血管合并症的关键重要性。这项开创性研究展示了恩格列净——一种关键的治疗选择，也是现代心血管医学的基石——深远的影响。
>
> Studies have shown that SGLT2 inhibitors reduce cardiovascular events. Additionally, empagliflozin reduced the risk of hospitalization for heart failure or cardiovascular death by 34%—a remarkable finding—highlighting the cardioprotective effects of this intervention. The number needed to treat of 35 over 3 years underscores the crucial clinical value of this therapeutic approach.
> 译：研究表明 SGLT2 抑制剂可减少心血管事件。此外，恩格列净将心力衰竭住院或心血管死亡的风险降低了 34%——一项引人注目的发现——凸显了该干预措施的心脏保护作用。3 年内需治人数为 35，强调了这一治疗方法关键的临床价值。
>
> Despite challenges typical of large clinical trials, including the lack of objective cardiac measurements, the trial's strategic design continues to provide valuable insights for the future outlook of heart failure management. The future looks bright for patients with type 2 diabetes as these exciting findings continue to reshape clinical practice.
> 译：尽管存在大型临床试验典型的挑战，包括缺乏客观心脏测量，本试验的战略性设计仍持续为心力衰竭管理的未来前景提供有价值的洞见。2 型糖尿病患者的未来一片光明，因为这些激动人心的发现正在持续重塑临床实践。

**After（去 AI 味后）：**
> Heart failure is highly prevalent in patients with diabetes, occurring in more than one in five patients with type 2 diabetes aged over 65 years. In patients with type 2 diabetes and high cardiovascular risk, empagliflozin reduced heart failure hospitalization and cardiovascular death when added to standard of care.
> 译：心力衰竭在糖尿病患者中高度流行，发生于超过五分之一的 65 岁以上 2 型糖尿病患者中。在合并高心血管风险的 2 型糖尿病患者中，在标准治疗基础上加用恩格列净可降低心力衰竭住院与心血管死亡。
>
> In the EMPA-REG OUTCOME trial, empagliflozin reduced the risk of hospitalization for heart failure or cardiovascular death by 34%. The number needed to treat to prevent one event was 35 over 3 years.
> 译：在 EMPA-REG OUTCOME 试验中，恩格列净将心力衰竭住院或心血管死亡的风险降低了 34%。3 年内预防一例事件所需治疗的病例数为 35。
>
> The diagnosis of heart failure at baseline was based solely on the report of investigators, with no measures of cardiac function or biomarkers recorded. Empagliflozin reduced heart failure hospitalization and cardiovascular death when added to standard care. The benefit was consistent in patients with and without heart failure at baseline.
> 译：基线心力衰竭的诊断仅基于研究者的报告，未记录任何心脏功能或生物标志物测量。在标准治疗基础上加用恩格列净可降低心力衰竭住院与心血管死亡。该获益在基线有无心力衰竭的患者中均一致。

**Changes made（所做修改）:**
- 按 Pattern 13 零容忍规则清除所有破折号（"—"）
- 移除意义拔高（"pivotal challenge"、"evolving landscape"、"groundbreaking"、"cornerstone"）
- 移除广告腔（"profound impact"、"remarkable finding"、"exciting findings"）
- 移除无支撑的模糊归因（"Studies have shown" 无引用），并替换为具体试验名（注："Prior studies have shown that..." 后接引用的情况会被保留）
- 移除浅层 -ing 短语（"underscoring"、"highlighting"）
- 移除回避系动词（"serves as"），改用 "is"
- 移除 AI 词汇（"crucial"、"pivotal"）与装饰性强调词（"remarkable"）——注："Additionally" 之所以消失，只是因为它所在的整句被改写；每段一个 "Additionally" 是可接受的，否则应保留（Pattern 7 例外）
- 移除套话式挑战小节（"Despite challenges... future outlook"）
- 移除泛泛正面结论（"The future looks bright"、"continue to reshape"）
- 修复语法（"The number needed to treat of 35" → "was 35"）
- 使用简单句式与具体数据

---

## 参考 (Reference)

本 skill 基于 [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)，由 WikiProject AI Cleanup 维护，针对医学与学术写作情境做了适配。其中记录的模式来自对成千上万例 AI 生成文本的观察。

医学论文示例改编自：

> Fitchett D, Inzucchi SE, Cannon CP, et al. Empagliflozin Reduced Mortality and Hospitalization for Heart Failure Across the Spectrum of Cardiovascular Risk in the EMPA-REG OUTCOME Trial. *Circulation*. 2019;139(11):1384-1395. doi:10.1161/CIRCULATIONAHA.118.037778

本文按 CC-BY-4.0 许可发布。
