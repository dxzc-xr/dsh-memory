# dsh-memory

跨会话的 Markdown 记忆插件，给 [DeepSeek Harness][dsh] 用。

每轮对话开始时把「全局记忆 + 当前工作目录的项目记忆」自动注入上下文；模型用 `remember` 工具把值得长期保留的事实写回 Markdown 文件。记忆就是普通 `.md`，用任何编辑器都能改。

> 姊妹项目 [dsh-scenes](../dsh-scenes)：把「场景」做成一等公民，场景私有记忆直接复用本插件的项目记忆机制。

## 它做什么

| 动作 | 说明 |
|---|---|
| 注入 | 每轮第一步，把记忆作为一条带标记的上下文消息插入请求。记忆文件没变就只注入一次；指纹变了才重新注入 |
| 写入 | 注册 `remember` 工具，模型调用后把一条记忆追加进对应 Markdown 文件 |

## 记忆文件放在哪

```
$DSH_HOME/memory/用户档案.md                 # 全局记忆：跨所有会话/目录生效
$DSH_HOME/memory/项目/<归一化的 cwd>.md      # 项目记忆：按工作目录隔离
```

`$DSH_HOME` 默认 `~/.dsh`，可用环境变量覆盖。

## 工具

### `remember`

| 参数 | 类型 | 说明 |
|---|---|---|
| `text` | string，**必填** | 要记住的内容。一条一事，不超过 2000 字 |
| `scope` | `project` \| `global` | `project` = 只在当前工作目录生效（默认）；`global` = 对所有会话生效 |

返回 `{ ok, scope, file }`。

## 可调参数（源码内常量）

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_ENTRY_CHARS` | 2000 | 单条记忆字符上限 |
| `MAX_INJECT_CHARS` | 8000 | 单次注入预算。超出时保留开头、省略中段，并注明「已截断」 |

## 安装

本插件依赖 `@deepseek-ai/*` 宿主模块，但**不写死导入**：以 `file://`（插件市场热挂载）或 profile 依赖两种方式加载都能用；导入失败时退回等价的本地实现，并在诊断日志里写明走了哪条路。

**方式 A · profile 依赖（推荐，长期使用）**

在 profile 的 `package.json` 里加一条 link 依赖：

```json
{
  "dependencies": {
    "dsh-memory": "link:/绝对路径/dsh-memory"
  }
}
```

**方式 B · 插件市场热挂载**

把本目录以 `file://` URL 挂载即可，不需要先 `npm install`。

两种方式都靠 `cordis.patch.yml` 把插件插进宿主：

```yaml
- insert:
    - id: dsh-memory
      name: 'dsh-memory'
```

## 设计取向

- **纯文件、无数据库**：记忆可读、可 diff、可版本控制，坏了能手工修。
- **按 cwd 归一化分项目**：同一个模型在不同项目里不会串记忆。
- **注入有预算**：记忆长了先截断，不静默撑爆上下文。
- **写入门槛写在描述里**：工具描述明确要求「只记稳定信息，不记一次性过程细节」，靠提示词约束质量，而不是靠代码猜。

## License

MIT

[dsh]: https://github.com/deepseek-ai
