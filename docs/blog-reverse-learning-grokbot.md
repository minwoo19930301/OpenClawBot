# 对 GrokBot 的逆向学习

> 一篇记录：如何把一款现代桌面 agent 产品从二进制逆向到"可复现的架构"，再还原成一个开源实现。
> 本文所有工作均以学习与工程研究为目的，开源还原版为 clean-room 重新实现，不含原产品任何源代码。

---

## 一、为什么是 GrokBot

GrokBot 是一款 Electron 桌面应用，其核心卖点是"多 agent 协作"：用户能创建多个 agent，
它们可以 1:1 私聊、组群聊讨论、跨用户共享房间协作，还可以派生子任务与云端 agent。
我关心的不是"它能干什么"，而是"它背后是怎么组织的"：

- 多 agent 之间用什么协议通信？
- 多个 agent 同时运行时，如何调度才能不打架、不饿死用户消息？
- 群聊如何防止 agent 互相刷屏死循环？
- 消息发送如何做到超时重试也不重复？

带着这些问题，我开始了对它的逆向学习，并最终把整个架构**全量还原**成了一个开源工程。

---

## 二、逆向方法论：从 226MB 的 EXE 到 7787 个源文件

### 1. 识别技术栈

`Grok Bot.exe` 有 226MB，旁边的 `icudtl.dat`、`libEGL.dll`、`v8_context_snapshot.bin`、
`resources.pak` 一眼就是 **Electron / Chromium 全家桶**。核心逻辑都在
`resources/app.asar`（191MB）里。

### 2. 解包 app.asar

asar 是 Electron 的标准打包格式，直接用 `@electron/asar` 解包：

```bash
npx @electron/asar extract app.asar asar/
```

解开后是 `dist/` + `package.json`。package.json 直接暴露了身份：

```json
{ "name": "sand", "productName": "Grok Bot", "version": "0.16.0",
  "author": "SpaceXAI", "homepage": "https://cursor.com" }
```

依赖全部是 `@anysphere/*` workspace 包（agent-core、agent-client、agent-transcript、
agent-store-sync...）——这是 Cursor 构建链的改版，多 agent 的核心就在这些包里。

### 3. 关键捷径：sourcemap 里藏着原始源码

`dist/` 里每个 bundle 都带着 `.cjs.map`。检查后确认 **sourcemap 的
`sourcesContent` 字段完整内嵌了构建前的 TypeScript 源码**。写了一个小脚本
（`extract_sources_from_maps.py`）批量提取，一次还原出 **7787 个原始 TS 文件**，
从"逆向二进制"直接变成了"读源码"。

### 4. 架构梳理

在还原源码上做分层梳理：进程拓扑 → 传输协议 → 调度内核 → 消息语义 → 状态模型，
每一步都记录证据（文件路径、常量、wire 格式），形成一份完整的架构报告与协议速查表。

---

## 三、关键发现：多 Agent 系统长什么样

### 1. 进程拓扑：四个进程，各司其职

```
Electron main --3xMessagePort--> node-agent-coordinator --HTTP/SSE--> Host(agent 运行时)
                                      |                                    |
                                      +-- local-exec-daemon <--------------+
```

- **Host**：真正的 agent 编排核心（transcript、调度、群聊、A2A、automation、memory）
- **node-agent-coordinator**：IPC 枢纽，三条 MessagePort 会话（control/data/mainData），
  对外是 HTTP 命令 + SSE 事件流
- **local-exec-daemon**：隔离本机 shell 执行
- 网络面（coordinator）与执行面（host）分离，断线自动重连、可独立恢复

### 2. 传输协议：JSON 帧 + SSE 事件族

- 桌面 ↔ 协调器：MessagePort 帧协议 `lifecycle / request / reply / event`
- 协调器 ↔ Host：命令 `POST /api/<method>`，事件走 SSE（`data: {"channel","payload"}`，
  15s 心跳、1s→10s 指数退避无限重连、Bearer 认证）
- Host 事件按 16 个"事件族"（transcript / agents / subagents / workflows / automations...）
  扇出回桌面，未知通道直通，协议演进兼容

### 3. 协调内核：排他队列 + 三 lane 优先级

每个 agent 一个队列，同一时刻只跑一个 turn；`user > agent > background` 三级优先级，
**用户消息永远最先**。卡死的 run 有 watchdog（120s+30s grace），逃逸成 zombie：
调用方立即返回（发送永不悬挂），排空/删除仍等它真正结束。

### 4. 消息语义

- **A2A 私聊**：fire-and-forget + 对称唤醒；priority 消息可中断对方非用户工作；
  DM 抢占后 at-least-once 重驱防丢防环
- **群聊**：有界轮转（≤3 轮、≤10 条、每人每轮 ≤2 条、≤6 成员），@提及路由，
  全员 pass 收敛，用户新消息随时 supersede
- **幂等发送**：clientNonce + 输入摘要持久化账本，超时重试零双发；
  durable acceptance 让"发送"与"执行"解耦
- **跨用户房间 / 云 agent**：turn-request/result relay（预算+退避+nonce 幂等）、
  BackgroundComposer 生命周期轮询

---

## 四、开源还原：Open-Grokbot

逆向学习最好的收尾，是把学到的东西**写成能跑的代码**。我在
[**github.com/LING71671/open-grokbot**](https://github.com/LING71671/open-grokbot)
发布了全量还原实现：

- **8 个包、87 项测试全绿**：core（调度内核）/ coordinator（三端口协调器）/
  transport（帧协议+SSE 网关+local-exec）/ state（transcript+幂等账本+BCS 同步）/
  messaging（A2A+群聊+跨用户+云桥）/ llm（OpenAI 兼容+Anthropic 双 provider）/
  runner（turn 执行+组合根）/ console（HTTP+SSE 浏览器控制面）
- 支持**所有主流模型**：OpenAI 兼容协议（OpenAI/DeepSeek/豆包/Moonshot/GLM/Grok/
  Ollama/vLLM...）+ Anthropic
- **无 Electron、无 EXE**：CLI + 浏览器控制面，shell 与运行时完全解耦
- 协议文档、架构图（mermaid）、还原度矩阵齐全

> 重要声明：Open-Grokbot 是**逆向还原的独立实现，不是原始源代码**。
> 代码基于对二进制产品的静态逆向分析后 clean-room 重新编写，不含原产品任何源码/资源。
> 许可证：GNU GPL v3 only。

---

## 五、本次逆向用到的工具链：open-reverselab

本次逆向的完整工作流跑在
[**github.com/LING71671/open-reverselab**](https://github.com/LING71671/open-reverselab)
提供的开源逆向工程工作区上：

- **任务路由与知识库**：AI-USAGE 全局路由 + kb 知识库按信号检索技术文档，
  逆向开始前先查"该往哪个方向打"
- **任务上下文生成**：`ai_context.py` 一条命令生成任务上下文（board 识别、工具路由、证据要求）
- **案例管理规范**：`cases/<case>/` 维护目标索引与证据链，任务可回放
- **脚本资产**：本次的 `extract_sources_from_maps.py`（sourcemap 批量还原源码）
  就是工作区沉淀的通用脚本，已随 open-reverselab 开源
- **证据落盘规范**：样本 → exports（证据）→ notes（笔记）→ reports（报告）的分层，
  让每一次逆向都有据可查、可复现

如果你想开始自己的逆向学习，open-reverselab 是一个不错的起点：它把
"如何组织一次逆向"这件事本身开源了。

---

## 六、推广与链接

| 项目 | 链接 | 一句话 |
|---|---|---|
| **Open-Grokbot**（本次逆向的开源还原） | https://github.com/LING71671/open-grokbot | GrokBot 多 agent 架构的全量还原实现，87 测试，GPL-3.0-only |
| **Open-ReverseLab**（逆向工程开源工作区） | https://github.com/LING71671/open-reverselab | 知识库 + 工具链 + 案例规范，本次逆向的完整工作流跑在这里 |

---

## 七、结尾

逆向学习的价值不在于"复刻"，而在于**把黑盒变成白盒**：当你亲手还原过一遍
消息协议、调度内核和幂等账本之后，再看任何"多 agent"产品，脑子里都会自动
画出它的进程拓扑和消息路径。

感谢阅读。如果你对多 agent 架构感兴趣，欢迎 Star / Fork 上面的两个仓库，
一起把逆向学习这件事做得更系统。

---

*本文所述逆向与还原均基于合法授权范围内的学习研究；Open-Grokbot 为独立实现的
开源工程，与原产品无任何从属关系。*
