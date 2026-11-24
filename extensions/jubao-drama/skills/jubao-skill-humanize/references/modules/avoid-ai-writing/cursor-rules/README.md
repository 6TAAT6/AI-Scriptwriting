# Cursor 规则 — avoid-ai-writing

这是一个开箱即用的 [Cursor](https://cursor.sh) 规则，把 [`avoid-ai-writing`](../SKILL.md) skill 移植到 Cursor 的 `.mdc` 规则格式。功能与上游 skill 完全一致——同样的级别词表、同样的上下文画像、同样的检测/改写模式。

## 安装

把 `avoid-ai-writing.mdc` 复制到你项目的 `.cursor/rules/` 目录下：

```sh
mkdir -p .cursor/rules
curl -o .cursor/rules/avoid-ai-writing.mdc \
  https://raw.githubusercontent.com/conorbronsdon/avoid-ai-writing/main/cursor-rules/avoid-ai-writing.mdc
```

默认情况下，该规则会在 `.md`、`.mdx`、`.txt`、`.rst`、`.adoc` 文件上激活（通过 frontmatter 中的 `globs` 字段控制）。如果你想让它作用于其他文件类型，可在规则文件中编辑 globs；或者把 `alwaysApply: true` 设为 true，让它对每次 Cursor 会话都生效。

## 触发短语

安装完成后，可以这样的口吻让 Cursor 工作：

- *"去掉这一段的 AI 痕迹。"*
- *"审查这篇草稿有没有 AI 写作套路。"*
- *"让这段读起来不那么像 AI。"*
- *"以检测模式运行 avoid-ai-writing。"*（只标记，不改写）

## 旧版 Cursor 项目

如果你用的 Cursor 版本仍然使用 `.cursorrules`（位于仓库根目录的单文件），可以把 `avoid-ai-writing.mdc` 的正文（`---` frontmatter 以下的部分）直接追加到现有的 `.cursorrules` 文件末尾。新版 Cursor 项目应当优先使用 `.cursor/rules/*.mdc` 这种目录式组织。

## 更新

本文件由 [`SKILL.md`](../SKILL.md) 经 [`scripts/sync-cursor-rules.sh`](../scripts/sync-cursor-rules.sh) 生成：包含 Cursor 专用的 frontmatter（版本号取自 SKILL.md），并针对引用本仓库内文件的三处片段做了三处可移植性改写——一份拷出去的规则没法运行 `node detector/validate.js`，所以那一处检查被改成了手动检查。CI 会在每次 SKILL.md 变更时重新生成该规则，并在已提交的副本发生漂移时让构建失败，这样两者就不会再悄无声息地分叉。（它们曾经分叉过一次：这份移植版停留在 v3.16.0，而 SKILL.md 已经到了 v3.22.3，正是那次事故催生了这道防护。）请不要手动编辑 `.mdc`——应当编辑 SKILL.md，然后重新运行脚本。
