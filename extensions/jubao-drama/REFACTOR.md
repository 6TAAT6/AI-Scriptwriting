# 创作记忆重构（2026-10-14）

基线：测试版 `20261014-quality-flexibility-test-r1`。重构环境：`/home/admin1/services/jubao-hermes-refactor`，网页 `http://192.168.10.36:10649/`，后端 `127.0.0.1:10650`。

## 要解决的问题与根因

| 现象 | 根因 |
|---|---|
| 上下文幻觉 | 105 万窗口按默认 50% 才压缩，模型实际收到几十万 token 的历史；`drama_project_status`/`drama_submit` 每次回传含原稿和全部归档的完整项目 JSON，归档每次深拷贝，体积越改越大。 |
| 忘记用户要求 | 压缩是有损摘要；补救用的正则要求合同漏识别即丢失，“换个故事”类句子会清空全部要求。 |
| 世界观越写越大 | 没有权威设定记录，人物、规则、物件只存在于聊天历史；约束只有一句提示词。 |

## 新结构

```
用户消息 ──► pre_llm_call ──► 创作胶囊（只附加在本轮，不写历史）
                               ├─ 要求清单：生效要求，置顶优先
                               ├─ 设定库：核心设定全量 + 与本轮相关的其他条目
                               └─ 连续性：最近一次记录的末态
          └─► 后台要求提取（辅助模型结构化输出）──► 要求清单（下一轮生效；本轮原文已在上下文）

模型 ──► drama_story_bible ──► record：非核心条目直接记录（可查可撤销）
                           └─► propose：核心变更 ──► 原生审批卡片 ──► 用户确认后写入

稿件核验 ──► requirement_checks（字数、集数、范围等确定性检查，保留）
         └─► 独立语义审稿（对照要求清单 + 设定库，新增核心设定判 revise）
```

- **作用域**：一个“创作范围”= 侧栏项目；不在项目里的聊天以会话链根为范围。同一项目内的多个聊天共享要求清单和设定库。
- **压缩**：创作账号设置 `compression.threshold_tokens`，在约 16 万 token 时压缩，并开启旧工具结果的确定性裁剪。被压缩掉的事实由胶囊每轮补回。
- **记忆后端接口**：`memory/` 定义 `StoryMemory`，当前实现为 SQLite（条目名命中 + FTS5 trigram）。OpenViking 不另建适配器：Hermes 自带 `plugins/memory/openviking`，在 profile 配置 `memory.provider: openviking` 即可启用。

## 保留

账号与容器隔离、审批卡片、独立审稿回执、稿件版本、Word/Excel 导出、资料分页读取与哈希校验、全部模型配置、7 个 Agent 与 4 个 skill 的名称。

## 替换

- `task_requirements.py`（已删除）/ `task_requirement_extract.py` 的正则合同 → `ledger.py` + 结构化提取；`task_requirement_extract.py` 仅保留本轮真实用户原话的来源核对。
- `requirement_control.pre_llm_call` 的合同注入 → `capsule.py`。
- `requirement_policy.py` 的固定世界观提示 → 设定库核心条目。
- 项目状态类工具回传完整 JSON → 精简回执（`project_view.py`）。

旧表保留只读，迁移脚本把旧合同中的生效要求导入要求清单（标记“迁移”），不删除任何旧数据。
