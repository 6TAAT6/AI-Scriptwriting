# 检测引擎

`patterns.js` 是本 skill 模式规则的可执行表达——一个零依赖、无需构建步骤的检测引擎,用于给文本打分,识别其中的 AI 写作痕迹(AI-writing tells)。它在 Node(`>=18`)和浏览器中行为完全一致。

本 skill 的 `SKILL.md` 是人类可读的规则目录;而本引擎则是对其中"可用正则检测的子集"的确定性、可测试实现,外加若干计量文体学(stylometric)与 AI 工具指纹检测器——这些用散文描述没有意义。规则 ↔ 类别的映射关系见 [`CATEGORIES.md`](./CATEGORIES.md),它负责让两者保持同步。

## 运行方式

```bash
npm test          # 模式测试、类别契约测试与保留性测试(无依赖)
# 或直接运行:
node detector/patterns.test.js
```

```js
const AIDetector = require("./detector/patterns.js");
const result = AIDetector.analyzeText("Your text here…");
console.log(result.score, result.label, result.issues.length);
```

在浏览器中,把 `patterns.js` 作为普通脚本加载即可——它会自行注册为全局对象 `AIDetector`(其中的 `module.exports` 块有保护,仅在 CommonJS 下执行)。

## `analyzeText(text, options?)` → 返回结果

| 字段 | 类型 | 含义 |
|---|---|---|
| `score` | `0–100` | 0 = 干净,100 = AI 痕迹严重 |
| `label` | string | `Minimal` / `Some` / `Strong` / `Heavy`(或 `Empty` / `Too short` / `Text too long`) |
| `issues[]` | `{type, text, severity, …}` | 每个被检出的模式对应一条记录;`type` 键映射见 [`CATEGORIES.md`](./CATEGORIES.md) |
| `stats` | object | `wordCount`、各级别计数、`contextMode`、`denseAIVocab`、归一化标志等 |
| `document_classification` | string | 三态取值 `HUMAN_ONLY` / `MIXED` / `AI_ONLY`(结构对齐 GPTZero,便于直接替换) |
| `class_probabilities` | `{human, mixed, ai}` | 之和精确为 1.0 |
| `confidence_category` | `low` / `medium` / `high` | |
| `highlight_sentence_for_ai` | region[] | 带字节偏移的句子区间及每段区间得分,用于界面高亮 |

`options.contextMode` 接受 `general`(默认)或 `technical`;technical 模式会抑制在"贴近代码"的散文中合法的标记(例如 Title Case 标题)。无效模式会回退到 `general`,并设置 `stats.contextModeFallback`。

## `validate(original, rewritten, options?)` → 返回结果

`validate.js` 用于检查一次改写(rewrite)是否"安分守己"——即没有动到 `SKILL.md` 明令不得触碰的内容。编辑模式会写入文件,因此一旦在那里违规,后果是静默且破坏性的。

```js
const { validate, formatResult } = require("./detector/validate.js");
const result = validate(originalText, rewrittenText);
if (!result.ok) console.error(formatResult(result));
```

```bash
node detector/validate.js before.md after.md   # 出现保留性错误时以退出码 1 退出
```

**错误**(改写动了不该动的内容):围栏代码块被改动或丢失、YAML frontmatter 被修改、引用块(blockquote)被改写、表格单元格被改动、行内代码被删除、URL 或文件路径丢失、标题数量或层级被改动;以及 `residual-grew`——指改写后遗留的被标记模式比消除掉的还多。

**警告**(通常合法,偶尔是失误):标题被改写、原文中的图缺失、删去超过 40% 的词。

本 skill 文档中明确认定为正确的两类编辑被设为例外情形(carve-out),使校验器不会在本 skill 自己的指令上误报:一是从 URL 中剥离 AI 跟踪参数(`utm_source=chatgpt.com`),二是改写标题以修正 Title Case 或移除 emoji。缩进式代码块会被计数但不强制,因为四空格缩进也是 markdown 续列表项的方式。

## 给我们自己的文档打分

```bash
npm run self-scan          # 输出表格
npm run self-scan:check    # 若某文档超出预算则以退出码 1 退出(在 CI 中运行)
```

结果及据此发现的问题见 [`../PROOF.md`](../PROOF.md)。

## 设计说明

- **偏漏报倾向。** 误报(false positive)对信任的伤害大于漏报(false negative),因此 `MIXED` 区间设得很宽,而 `AI_ONLY` 需要多个相互印证的信号。
- **评分非线性。** 同一短语的重复命中会被去重;类别权重存放在 `ISSUE_WEIGHTS` 表中。
- **长度门槛。** 低于约 10 词 → `Too short`(无法评分);超过 1 万词 → `Text too long`。
