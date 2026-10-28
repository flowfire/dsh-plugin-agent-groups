# dsh-plugin-agent-groups

> A DeepSeek Harness (DSH) plugin for multi-session collaboration groups.

## 问题

DSH 的每个会话拥有独立的上下文、模型路由和工作目录。当一项任务需要多个角色并行推进时（例如后端 / 前端 / 测试，或采集端 / 服务端），用户通常只能：

1. 在会话之间手工复制粘贴结论；
2. 把多个角色塞进同一个会话；
3. 用插入式消息打断正在运行的会话。

这三种方式分别带来转发遗漏与时序错乱、角色上下文互相污染、打断工具调用与推理过程的问题。

本插件把多个**已打开**的会话组织成一个协作群：成员保留各自的上下文与角色设定，插件只采集每轮结束后的最终输出，按时间线排队，再合并投递。不存在手工转发，也不会向正在运行的会话插入消息。

## 设计概览

| 组件 | 职责 |
| --- | --- |
| 群 | 两个及以上 live Session，加每个成员的群内名字与角色设定 |
| 时间线 | 按序记录成员最终输出、发起者发言和系统事件 |
| 投递器 | 成员空闲时，把未读时间线合并成一份 digest，通过 `agent.followup()` 送达 |
| 协议注入 | 通过动态 `systemPrompt.section()` 注入固定协议与成员角色 |
| 面板 | 全局面板用于建群与管理；右侧栏 tab 用于群运行期间持续观察 |

## 安装

要求：

- DeepSeek Harness 0.2.x
- Node.js 22.19+ 或 24+

社区标准安装：

```bash
dsh plugin --profile web add github:flowfire/dsh-plugin-agent-groups
```

源码安装：

```bash
git clone https://github.com/flowfire/dsh-plugin-agent-groups.git
```

然后在 DSH 中通过 `plugin_manager` 的 `install_bundle` 安装该目录。安装后刷新页面，侧边栏出现「多会话协作群」。

## 快速开始

1. 在浏览器中打开至少两个会话（必须是 live Session）；
2. 点击侧边栏「多会话协作群」→「新建群」；
3. 勾选会话，为每个成员填写群内名字与角色设定；
4. 选择「创建并开始」，或取消「创建后立即唤醒成员」仅建群；
5. 群运行后，点击「在右侧栏打开」以获得不被会话切换打断的观察视图。

## 概念

### 群与成员

```text
Group
├── id, name, status, createdAt
├── members[]  (sessionId, name, persona, delivered, turns)
└── timeline[] (seq, kind, name, text, time, turn, eventSeq)
```

- 一个会话同一时间只能属于一个未结束的群。
- 子会话（`header.origin === 'subagent'`）不会出现在可选列表中。
- 成员名字在群内唯一；重名会自动追加序号。

### 成员状态

| 状态 | 含义 |
| --- | --- |
| `active` | 在群内，可收发消息 |
| `exited` | 输出 `【退出会话】` 后离群 |
| `removed` | 被发起者移出 |
| `offline` | 派生状态：Session 当前没有 live Agent |

### 群状态

| 状态 | 含义 |
| --- | --- |
| `active` | 正常转发与投递 |
| `paused` | 停止转发与投递，成员仍保留 |
| `ended` | 不再收发消息，时间线与成员列表保留只读 |

成员退出后若 active 成员不足两人，群自动进入 `ended`。

### 关键字

| 关键字 | 匹配规则 | 行为 |
| --- | --- | --- |
| `【静默】` | 去掉首尾空白后完全相等 | 不写入时间线、不转发、不计轮次；成员保持 `active` |
| `【退出会话】` | 去掉首尾空白后完全相等 | 成员转为 `exited`，追加系统消息，可能触发群结束 |

协议同时禁止“收到”“继续待命”“我在”等无信息量的占位输出。

## 运行机制

### 事件采集

插件监听 `session/event`，只处理群成员的 Session：

```text
assistant/message
  -> 缓存该 (session, turn) 的最后一条非空 text 内容

turn/end
  -> 取出该 turn 缓存的文本
  -> seq <= member.joinedSeq：丢弃（加入群之前的历史）
  -> 文本 == 【静默】     ：丢弃，不记录
  -> 文本 == 【退出会话】 ：成员退出
  -> 其他                ：追加到时间线，触发投递
```

只取 `assistant/message` 的 `text` block；`tool-call`、命令输出和中间过程不会进入时间线。

### 投递流程

```text
append timeline entry
  -> scheduleDelivery(group, deliveryDelayMs)
  -> for each active member:
       agent = ctx.agents.get(member.sessionId)
       agent 不存在            -> 跳过（等待 resume）
       agent.status === running -> 跳过（等本轮结束）
       unread = timeline[seq > member.delivered, 排除自己]
       unread 为空             -> 跳过
       digest = 按时间线合并 unread
       member.delivered = 最新 seq
       agent.followup(digest)
```

关键行为：

- 使用 `agent.followup()` 进入下一轮，不使用 `steer()`，因此不会插入或打断当前 turn。
- 成员忙时其未读消息持续累积；成员空闲后一次性收到合并结果。
- 投递游标 `member.delivered` 在发送前推进；发送失败会回滚。
- 单份 digest 上限 48000 字符，超出时优先保留最近的消息。

### 提示词注入

插件在 Host 根上下文注册一个动态 section：

```js
ctx.systemPrompt.section({
  name: 'agent-groups:protocol',
  order: 10050,
  text: (assembly) => buildProtocolPrompt(assembly.agent),
})
```

每次 assembly 时按当前成员关系计算内容，包含：

1. 群名与成员身份；
2. 成员角色设定；
3. 当前 active 成员列表与职责摘要；
4. 固定协议（只读，用户不可修改）；
5. 暂停状态提示（仅 `paused` 时）。

群结束或成员退出后，section 返回空字符串，不再污染该会话的 system prompt。

### 发起者发言

时间线下方的输入框以固定身份 `发起者` 写入同一条时间线：

- 复用同一套投递游标与合并逻辑；
- 不占成员轮次，不计入 `maxMessages`；
- 群非 `active` 时前端禁用，Host 端同样拒绝；
- 在成员 system prompt 中作为群内固定身份出现，但不替代成员自己的职责判断。

### 持久化

群状态写入：

```text
$DSH_HOME/storages/agent-groups/state.json
```

未设置 `DSH_HOME` 时为 `~/.dsh/storages/agent-groups/state.json`。

- 写入采用临时文件 + `rename` 的原子替换；
- 状态变更后 120ms 防抖落盘；
- 内存时间线最多保留 2000 条；
- HTTP 快照只返回最近 500 条；
- 客户端面板每 1.8s 轮询一次，渲染最近 300 条。

插件不新增 Session 事件类型，也不写会话日志。群消息通过正常的 `followup` 进入成员会话，因此成员会话中可以看到收到的群聊时间线。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: agent-groups
  name: dsh-plugin-agent-groups
  config:
    maxMessages: 80        # 每个群允许的成员发言条数，达到后自动暂停
    deliveryDelayMs: 150   # 合并投递的防抖窗口（毫秒）
    storePath: /path/to/state.json
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `maxMessages` | `80` | 成员发言上限，`10`–`500`；发起者发言不计入 |
| `deliveryDelayMs` | `150` | 同一窗口内的多条消息合并为一次投递 |
| `storePath` | 见上文 | 群状态文件路径 |

## HTTP 接口

Host 暴露一个只读/操作端点：

```text
/plugins/dsh-plugin-agent-groups/api
```

- `GET` 返回 `{ groups, sessions, defaults, now }`；
- `POST` 接受 `{ action, ... }`，`action` 包括：
  `create`、`pause`、`resume`、`dissolve`、`delete`、`rename`、
  `updateMember`、`removeMember`、`addMember`、`kickoff`、`say`。

该端点仅用于本地面板，不提供远程鉴权。

## 兼容性与依赖

Host 侧依赖：

- `ctx.agents`：读取成员 Agent，调用 `followup()`
- `ctx.sessions`、`ctx.sessionTitle`：列出 live Session 与标题
- `ctx.systemPrompt`：注册动态 section
- `ctx.webServer`：注册 HTTP 端点

Client 侧依赖：

- `slots`、`locale`
- `uiWorkspace`（打开来源会话）
- `layout`（切回对话面板）
- `sidebarRight`、`sidebarRightTabs`（右侧栏 tab）

## 已知限制

- 只接受当前已打开的 Session；插件不会自动 `resume` 未打开的会话。
- 一个 Session 同一时间只能属于一个未结束的群。
- 主面板会在任意会话产生新活动时被 DSH 切回对话；群运行期间建议使用右侧栏。
- 成员在暂停期间产生的输出不会补记，恢复后只处理新输出。
- 群状态是进程内状态加 JSON 快照；插件重启时活动群会恢复，但不会重放暂停期间错过的输出。

## 开发

```text
index.js            Host：群状态、事件采集、投递、持久化、HTTP
client.js           Client：侧边栏入口、全局面板、右侧栏 tab
cordis.patch.yml    Bundle 安装行
package.json        Bundle / Client 声明与仓库元数据
locale/*.json       插件标题与描述
icon.svg            侧边栏图标
```

本地检查：

```bash
node --check index.js
node --check client.js
node -e "for (const f of ['package.json','locale/zh.json','locale/en.json']) JSON.parse(require('node:fs').readFileSync(f,'utf8'))"
```

CI 执行相同的语法与清单校验。

## License

[MIT](LICENSE)
