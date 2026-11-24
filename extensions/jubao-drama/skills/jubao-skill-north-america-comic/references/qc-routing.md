# 审稿资料路由与枚举适配

先执行主SKILL核心合同与项目契约；用户语言和故事决定不被原包的“出海”默认值覆盖。

- 设定审稿读取 `upstream/tiktok-short-drama/references/commands/qc-setup.md`，检查已确认世界、人物硬事实、能力代价与拒绝机制。
- 批次审稿读取 `upstream/tiktok-short-drama/references/commands/qc-episode.md`，仅对实际读过的集数、场次和原句给结论。
- 全剧审稿读取 `upstream/tiktok-short-drama/references/commands/qc-full-read.md`，先核对全剧覆盖范围；局部批次不得登记全剧通过。
- 审稿方法可补读 `upstream/drama-skills/skills/short-drama-review/source-SKILL.md` 与其 `references/review-method.md`。

这些文件统一从本技能 `references/` 起算。原文以固定commit保留，文件中的 `languageMode=overseas` 一律按 `languageMode=overseas-en-dialogue` 解释；这是历史枚举拼写纠正，不能把英文规则强施加给北美中文对白。是否做文化本地化由 `targetMarket` 与用户改编范围决定，是否做美式英语审稿由 `dialogueLanguage` 决定；两项独立，不使用含混的“海外模式”同时开关。

原文提出的中式设定阻塞项必须结合用户明确的去中国化范围与所定世界判断；不得自动禁用合理华人角色或已有多文化设定。上游固定时长、世界规模、命名、格式、额外文档、脚本和审核工具仅是参考，本接入按主SKILL约定落地。

结果按“证据—影响—建议—状态”记录；评分写明标准和材料范围，不虚报专家审读、工具扫描或模型会议。Word内容回读一致不改变文学审稿状态。需要原包未分发的材料时，说明其未接入；现有用户材料足够则继续当前范围，不假装已读缺失文件。
