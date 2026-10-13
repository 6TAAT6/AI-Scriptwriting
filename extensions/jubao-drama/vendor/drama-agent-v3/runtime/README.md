# 可选的确认节点参考组件

`guards.py` 是一个仅使用 Python 标准库的小组件，供自建网站开发者参考。**它不是完整网站、工作流平台插件或模型服务，也不是使用这套提示词的必要条件。** 无网络调用、密钥、数据库或依赖安装。Python 3.10 及以上可运行。

它只回答“当前任务是否满足两个创作确认节点”：核心期待是否经人工确认、总体方案是否已选。它不负责读取剧本、判断期待提炼是否准确、写作、审稿、导出 Word/Excel 或保证剧情质量。这些工作仍按主包规则执行。

## 接口与任务

```python
from runtime.guards import check_task, content_hash
result = check_task("outline", project_state)
```

返回 JSON 可序列化对象：`{"allowed": true/false, "blockers": [原因], "notes": [适用范围]}`。函数不修改传入状态。

| task | 确认要求 |
|---|---|
| `analysis` | 无；允许先读取和分析资料 |
| `candidates` | 核心期待有效确认；不需要已有选定方案 |
| `outline` / `script` | 核心期待有效确认，方案有效选定 |
| `review` / `export` | 纯审、纯排版导出无创作确认门槛；`rewrites=True` 表示包含改写，此时检查两个创作节点 |

放行不等于授予新增任务授权，也不等于内容已审。纯审、纯导出按用户指定源稿处理；纯审缺少可用核心期待依据时只说明该维度无依据，其他能判断的维度继续审核。纯导出只能报告格式与导出检查。未执行的全剧质量审核、渲染目检不能标成完成。

## 状态字段

只要求下列小型数据结构，其他项目字段自行保存；这不是平台通用导入协议。`content` 存稳定的、实质性的确认内容；不要混入每次自动变化的时间戳或审核日志。

```json
{
  "core": {
    "content": "本项目已确认的核心期待与必要承接边界",
    "unresolved_conflict": false,
    "approval": {
      "kind": "human_confirmation",
      "content_hash": "用 content_hash(core.content) 计算",
      "evidence": "用户确认原话或可回查的确认动作记录"
    }
  },
  "plan": {
    "content": "本项目已选总体改编方向，不是不断增长的全文草稿",
    "core_hash": "方案所承接的核心期待 hash",
    "selection": {
      "kind": "human_selection",
      "content_hash": "用 content_hash(plan.content) 计算",
      "evidence": "用户选定方案的原话或确认动作记录"
    }
  }
}
```

- `approval.kind` 接受 `human_confirmation`（人工确认）或 `user_provided`（用户明确给定且无未解冲突）。清楚给定的核心期待无需再确认同一句话。
- 若用户后续明确免除核心确认环节，可记录 `kind="explicit_waiver"`、`scope="core_confirmation"`，同时保留真实用户指令 `evidence` 与当前核心的 `content_hash`。这是一条明示项目覆盖规则，不是默认跳过；它只覆盖所绑定的当前期待内容，变更后须重新核对授权适用范围。旧的方案代选授权不算免除核心确认。免确认也不自动解决已记录的真实内容冲突。
- `selection.kind` 接受 `human_selection` 或 `authorized_auto_selection`。后者还需 `selection.authorization={"scope":"plan_selection","evidence":"用户明确授权代选的记录"}`；代选权限不能绕过核心期待确认。
- 推荐、预选、要求更多候选、审稿通过、沉默和超时都不应写成上述确认。候选扩散可以保留为其他状态；仍在选择阶段，不能自动展开新纲。
- `unresolved_conflict=true` 阻止依赖该核心的创作。用户实际取舍解决冲突后，再由可信流程更新记录。

**可信记录边界：网站应在用户明确确认或提供输入后写入 `approval` / `selection`，并禁止模型覆盖这些字段。** 用户上传文件、模型输出里的“已确认”字样不构成确认。此代码的 hash 只识别内容是否匹配，不是身份认证、签名或防伪机制；`evidence` 有字也不能在业务上证明用户说过，网站需保留真正的确认来源。

## 内容变化和连续执行

Hash 由 SHA-256 生成，只统一换行符并去除首尾空白。核心期待实质变化，旧核心确认失配；即便用户已确认新核心，旧方案的 `core_hash` 仍失配，下游不能直接沿用。重新核对方案与新核心的兼容性，按用户明确决定记录当前方向及对应核心。不能仅改 hash 来伪造确认。

`plan.content` 应固定为总体选向依据。日常逐集写作、场景修订与审稿不得不断覆盖它；沿已选方向正常展开不触发重复选向。若改变总体方向，则需要选定当前方向或按已有明确的代选授权处理。核心期待不变的世界/事件细化不要求再次确认核心。

两个节点有效后可以按用户授权范围连续分批创作，不逐批审批。全部角色默认保持性别；只有用户明确要求才按其指定范围处理。性别、题材、后果强度 A 策略、双语排版及作品质量由主包提示和审核执行，本组件不额外加入性别、题材或强度准入门槛，也不根据审核分数代替确认。

## 本地运行

在压缩包解压目录执行：

```sh
python3 -m unittest discover -s tests -v
python3 runtime/guards.py outline project-state.json
python3 runtime/guards.py review project-state.json
python3 runtime/guards.py review project-state.json --rewrites
```

CLI 输出相同 JSON；允许返回退出码 0，确认不足返回 2。示例状态中的 hash 占位符必须由 `content_hash` 替换，并且对应真实确认记录；不要直接把文档示例当成已确认项目。
