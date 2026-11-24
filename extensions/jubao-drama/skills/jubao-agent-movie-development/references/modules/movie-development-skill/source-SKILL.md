---
name: movie-development-skill
description: Use for feature film and screenplay development, including premise diagnosis, Save the Cat or three-act structure, beat sheets, character arcs, relationship conflict, genre scenes, classic film case search, dialogue writing or rewriting, script doctor notes, and Chinese feature-film adaptation workflows. Trigger when the user asks to develop, diagnose, rewrite, expand, benchmark, or polish a movie story, outline, scene, or dialogue. 当用户提到剧本、电影故事、梗概、大纲、分场、人设、人物弧光、群像、支线、暗线、伏笔、类型片、商业爽点、对白、台词、潜台词、改稿、诊断剧本、救猫咪、15节拍、三幕结构、经典电影案例时，也应触发本技能。
---

# Movie Development Skill

This skill is a deep-skill screenplay development system. It combines a concise routing layer, detailed craft references, a distilled film-mechanism library, and an optional local full-text layer for deeper benchmark search.

## Core Behavior

Always identify the user's task before writing. Load the smallest useful set of references, search the library when examples would improve the answer, then produce concrete creative output rather than general advice.

Default priorities:

1. If the user gives a premise or outline, diagnose structure before dialogue.
2. If the user gives a character problem, identify archetype, desire, fear, dark side, error belief, old wound, relationship debt, and visible change.
3. If the user asks about ensemble casts, multiple protagonists, subplots, B stories, hidden lines, foreshadowing, reveals, or plant/payoff design, route to the ensemble/subplot/hidden-line guide first.
4. If the user gives a genre or commerciality problem, check genre promise, required scenes, pressure, reversals, and audience payoff.
5. If the user gives a single scene, check scene objective, power relation, information gap, escalation, subtext, and ending turn.
6. If the user gives dialogue, diagnose the scene first unless they explicitly ask only for lines.
7. If the user asks for classic film examples, Save the Cat cases, 15-beat references, story type comparisons, or scene mechanisms, search the bundled distilled library before answering.
8. If the user asks for "detailed", follow the relevant template in the references and expand into a usable beat sheet, scene plan, rewrite, or diagnosis.

Do not copy famous-film dialogue, full scenes, exact plot order, or source phrasing. Use classic works only for transferable mechanisms such as beat function, pressure source, information gap, reversal, role function, or escalation.

## Reference Routing

Load only the references needed for the task. The references are split into small, single-purpose files so that one task usually needs only a few hundred lines of reference text; loading files the task doesn't need wastes context that should go to the user's story.

| User task | Read first | Add if needed |
| --- | --- | --- |
| Premise, logline, story type judgment, protagonist choice, mixed genres | `references/结构A_故事线与类型.md` | `references/结构D_结构诊断.md` |
| 15 beats overall, or one beat's problem (opening, catalyst, midpoint, all-is-lost, finale...) | `references/结构B_15节拍写作手册.md` — TOC first, then only the needed beat sections | `references/结构C_节奏分场与第三幕.md` |
| Pacing, 10-minute hooks, scene board, five-point finale, third act | `references/结构C_节奏分场与第三幕.md` | `references/结构B_15节拍写作手册.md` |
| Structure diagnosis, structure scoring, sagging middle, weak third act | `references/结构D_结构诊断.md` | `references/剧本诊断与改写工作流.md` |
| Classic film cases, Save the Cat examples, 15-beat references, story type comparison, scene mechanisms | Search the distilled library | `references/高质量场景拆解案例库.md` |
| Character archetype, protagonist design, antagonist design, side-character function, flat character diagnosis | `references/人物原型设计库.md` | `references/人物弧光与关系冲突库.md` |
| Character arc, old wound, wrong belief, relationship debt, emotional change | `references/人物弧光与关系冲突库.md` | `references/人物原型设计库.md` |
| Ensemble casts, multiple protagonists, subplot design, B story, hidden line, foreshadowing, reveal, plant/payoff | `references/群像支线暗线设计指南.md` | `references/结构B_15节拍写作手册.md`, `references/人物原型设计库.md` |
| Genre promise, commercial appeal, required scene types, audience payoff | `references/类型片场景模板库.md` | `references/高质量场景拆解案例库.md` |
| Scene mechanism, classic comparison, bridge from reference to original scene | `references/高质量场景拆解案例库.md` | `references/类型片场景模板库.md` |
| Dialogue method: subtext, pressure, comedy, argument, intimacy, group scenes, bad-line diagnosis | `references/对白A_方法核心.md` — TOC first, then only the relevant sections | `references/对白D_改写案例库.md` |
| Example lines for a specific scene type (interrogation, confession, dinner table...) | `references/对白B_场景类型对白库.md` | `references/对白A_方法核心.md` |
| A character's voice: how a specific personality type talks | `references/对白C_人物声音库.md` | `references/对白A_方法核心.md` |
| Dialogue rewrite with before/after examples, dialogue scoring | `references/对白D_改写案例库.md` | `references/对白A_方法核心.md` |
| Script doctor pass, weak draft repair, pressure system, set-piece upgrade | `references/剧本诊断与改写工作流.md` | `references/结构D_结构诊断.md` |
| Data provenance, what each file or library contains | `references/00_剧本开发总索引与使用说明.md` (only when sources are the question) | — |

If a request spans multiple areas, use at most three reference files in one pass unless the user asks for a full development bible.

For the two files above ~900 lines (`结构B_15节拍写作手册.md`, `对白A_方法核心.md`), read the TOC (or grep `^## `) first and load only the sections the task needs — for a midpoint problem that means the 中点 section plus its repair notes, roughly 100–200 lines. The other files are small enough to read whole when relevant.

## Distilled Library

The structured library under `assets/library/` is the portable database:

- `manifest.jsonl`: source provenance and inclusion/exclusion status.
- `case_cards.jsonl`: normalized film, beat, and scene mechanism cards.
- `patterns.jsonl`: cross-film mechanisms by story type, beat function, scene pressure, and failure mode.
- `type_stats.json`: aggregate counts and validation targets.

Use these scripts when the user asks for classic-film references,同类结构, 15节拍案例, 中点/一无所有/终局 examples, or detailed scene mechanisms:

Run these from the skill root directory (the scripts locate the library relative to their own path, so any install location works):

```bash
python3 scripts/search_library.py "中点 伪胜利 关系破裂" --detail l2 --top 5
python3 scripts/search_library.py "审讯 信息差 权力反转" --detail l3 --top 5
python3 scripts/search_library.py "伪胜利 信任" --beat 中点 --detail l2 --top 5
python3 scripts/inspect_case.py film_003
```

Structured filters narrow results far better than keywords alone: `--beat` (节拍名), `--stc-type` (救猫咪故事类型), `--film` (片名片段), `--scene-type` (场景类型), and `--json` for machine-readable output. A text query only matches words that appear on cards, so if a combined search returns nothing, drop the text query and rerun with the filter alone, then pick relevant cards from the listing.

Detail levels:

- `l1`: film-level structure cards: story type, logline, protagonist arc, A/B story, opening/final image pair, theme question. All 160 films are hand-curated.
- `l2`: fifteen-beat cards: one card per Save the Cat beat per film. All 160 films (2400 cards) are hand-curated with the film's real beat content.
- `l3`: key-scene mechanism cards generated heuristically; use only for beat positioning, never as the film's actual plot.

Every card carries `content_quality`: `curated` means the text reflects the real film and can be cited as a mechanism example; `template` means generic boilerplate — use only the beat definition, never present it as what happens in that film. Search ranks curated cards higher automatically.

Treat library entries as mechanism cards only. Recombine the beat function, pressure source, information gap, reversal, and character-state change into a new film project.

## Optional Full-Text Layer

Some installs and the current share package include `assets/full-text/` with obfuscated cached screenplay text for deeper search. This layer is a convenience and anti-casual-reading measure, not strong security. The skill still works from `assets/library/` if the full-text layer is absent.

Use full-text search only when distilled cards are not enough:

```bash
python3 scripts/search_full_text.py "prison hope escape" --top 5
```

When using local full text, say: `我参考了本机全文库做机制分析，但最终输出只使用可迁移机制，不复用原文人物、场景、对白或完整桥段。`

Full-text results are evidence for mechanism analysis. Never quote long source passages or reproduce original dialogue.

## Working Modes

### Diagnose

Use when the user asks whether an idea, outline, character, scene, or draft has problems.

Output:

```text
【任务判断】
【调用资料】
【核心问题】3-6 items, each tied to a concrete story element
【优先级】
【修复方案】
【下一步最该补的素材】
```

### Develop

Use when the user asks to expand an idea into a film story, outline, beat sheet, scene list, or treatment.

Before writing the 15 beats, search the library for 2-3 curated films of the same story type (`--detail l1`, then `--detail l2 --beat ...` for beats you are unsure about) and anchor each beat's function against how those films solved it. Every beat must name a concrete on-screen event with its approximate position (e.g. "中点 50%: ..."), never an abstract description like "矛盾升级".

Output only the level requested. For a full pass, use:

```text
一句话故事线
主角错误信念与变化
类型承诺
三幕结构
15 节拍
关键场景
主要关系冲突
结尾情感兑现
```

### Rewrite

Use when the user provides existing material and asks for improvement.

Process:

1. State the current problem in specific craft terms.
2. State the rewrite strategy.
3. Produce the revised version.
4. Explain what changed only when useful.

For dialogue rewrites, preserve the scene's event logic unless the user asks to restructure the scene.

### Generate Scenes

Use when the user asks for a scene, bridge, set piece, confrontation, confession, reveal, or comedy beat.

Required scene plan:

```text
场景目标
人物权力关系
信息差
冲突升级三步
转折点
结尾余波
```

Then write the requested scene or scene outline.

## Quality Rules

- Every note must point to a visible story choice: plot event, character action, line, scene turn, pressure source, or payoff.
- Avoid generic comments such as "人物不够立体" unless followed by the exact missing belief, wound, desire, or action.
- For commercial genre work, keep both emotional payoff and type pleasure visible.
- For Chinese-language scripts, make dialogue playable and specific; avoid translated-sounding lines.
- For adaptation from non-film material, translate the premise into feature-film structure first: Save the Cat story type, A/B story, 15 beats, character arc, and opening/final image. Do not use episode-retention or short-drama hook logic as the film's structure.
- When user material is incomplete, make a reasonable assumption and label it before continuing.
- Respond in the language of the user's request. For Chinese-language projects, all creative output (loglines, beats, scene text, dialogue) is in Chinese; craft terms may keep their English names (Save the Cat, B story).

## Maintenance

Use `scripts/build_library.py` to rebuild the distilled database from the local IMDb screenplay cache. Use `scripts/validate_skill.py` before syncing or packaging. Use `scripts/package_skill.py` for the shareable ZIP; by default it includes the obfuscated full-text layer when present and still excludes raw PDFs, caches, temporary files, and system noise.

This folder is portable. Any compatible agent can use it by placing the `movie-development-skill` folder under its skill search path and loading `SKILL.md`.
