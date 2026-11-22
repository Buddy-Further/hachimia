# MCP 去重探针——真机验证记录（PR #1 复核第 4 项）

日期：2026-11-22。agy 1.5.14，已登录（Google 账号）。零 quota：全程没发 prompt。

## 问题

`agy acp` 启动时自己加载 `~/.gemini/config/mcp_config.json`，而网关又把同一份文件
转成 `mcpServers` 经 `session/new|load|resume` 再发一遍。两边都有同一个服务器时，
会双起、或报名字冲突吗？

## 方法

测试服务器 `echo-test`（一个记每次启动 pid 的 MCP 服务器）。每个臂都是全新
`agy acp` 进程，只做 initialize + 一次 session/new，不发 prompt；每次臂前截断
echo 日志。`~/.gemini/config/mcp_config.json` 事先快照、事后按快照恢复（sha256
前后一致，恢复后 `agy mcp list` 显示无服务器）。

| 臂 | mcp_config.json | session/new mcpServers | echo-test 启动次数 |
|----|-----------------|------------------------|--------------------|
| A——只配文件 | 有 echo-test | `[]` | 1 |
| B——只传 session/new | `{}` | `[echo-test]` | 1 |
| C——两边都有（本题） | 有 echo-test | `[echo-test]` | 1 |

臂 C：`session/new` 成功、无错误、无冲突；agy 服务端日志写
`Preloading 1 MCP servers of the session`——恰好一个，不是两个。

## 结论

agy 1.5.14 按名字去重：同一个服务器在 `mcp_config.json` 和 `session/new`
mcpServers 里都出现时，只起一个进程。决定：**文件里的服务器照常经
session/new 发，不过滤**；真正“只靠 session/new”的只有设备 MCP（它从不在
`mcp_config.json` 里）。边界已写进 `gateway/gw/mcp-acp.mjs` 头注释，并有测试钉住。

## 附注（不影响结论）

- 结论只在一个服务器名（echo-test）上测过；泛化到多服务器靠的是“按名字去重”
  这一机制本身，未逐个名字测。
- 臂 A 里启动发生在 initialize/session-new 前后，而不是进程刚起时——自动加载
  是在建会前后触发的，与去重结论无关。
- 臂 C 的 echo 进程被起后、探针杀进程前没收到任何 MCP 请求（没发 prompt 就
  不会握手）；去重读的是进程数，两次独立加载会是两个进程，所以不影响结论。
- 臂 A 服务端日志里有一行 plugin MCP 的警告（`Not reloading plugin MCP
  servers: cannot get the signed-in user`）——plugin MCP 是另一套机制，与本题
  的 `mcp_config.json` 服务器无关。
