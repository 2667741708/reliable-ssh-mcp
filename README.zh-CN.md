# reliable-ssh-mcp 中文说明

[English](README.md) | 简体中文

`reliable-ssh-mcp` 是一个运行在本机的 STDIO MCP 服务。它把 Codex、GPT
等 AI 发出的远程操作转换成结构化 SSH 调用，可管理 Linux/OpenSSH、
Windows/OpenSSH，以及使用固定主机密钥的 Windows/Plink 主机。

它的主要目标不是取代 SSH，而是减少以下常见错误：

- PowerShell、SSH、远端 shell 多层解析造成的引号错误；
- 把 Windows 路径误发给 Linux，或把 Bash 命令误发给 PowerShell；
- SSH 中断后重复执行写文件、启动训练等有副作用的命令；
- 下载文件时写入错误项目目录或覆盖已有文件；
- 长时间训练依赖当前 SSH 窗口，断线后任务一起结束。

当前版本是 `0.9.1`。本版本强化只读命令参数策略、增加结构化 MCP 输出、
统一运行时与软件包版本，并修复帮助命令和审计判定。版本变化请查看：

- [中文版更新日志](CHANGELOG.zh-CN.md)
- [英文更新日志](CHANGELOG.md)

## 零基础推荐阅读顺序

这份中文版按照学习和实际使用顺序排列。第一次使用时建议依次阅读：

1. **先理解四层结构**：知道 Codex、MCP、SSH 和远端程序分别负责什么。
2. **首次启动单台服务器**：先让一个已有 SSH 别名正常工作。
3. **认识结构化工具**：尽量不用容易出错的长 shell 字符串。
4. **配置本机根目录**：确定上传和下载只能落在哪些项目目录。
5. **跨系统脚本和行尾**：让 Linux、Windows 自动使用正确解释器和行尾。
6. **连接池和长期任务**：区分“SSH 连接保持”和“tmux 任务持久化”。
7. **多服务器与跳板机**：只有需要管理多台机器时再配置 Fleet。
8. **密码、安全和发布**：最后理解凭据、私有配置与 npm/GitHub 发布边界。
9. **开发者检查流程**：修改代码后使用固定检查工具和验证流水线。

如果只想尽快开始，先读“首次启动单台服务器”“结构化工具”和“本机根目录”。

## 先理解四层结构

一次远程任务通常经过四层：

```text
Codex / GPT
    ↓ MCP 工具调用
本机 reliable-ssh-mcp
    ↓ SSH / Plink
远端常驻 Python 执行器
    ↓ 精确 argv 或匹配的脚本解释器
远端程序、文件或 tmux 任务
```

本机 Windows 使用 PowerShell，不代表远端也是 PowerShell。AI 应先调用
`probe_identity`，根据返回的 `execution_context` 判断远端操作系统、可用
shell、Python 路径、路径分隔符和原生行尾。

## 首次启动单台服务器

前提：本机你已经能在本机的 OpenSSH 配置中使用一个别名连接服务器，并已完成
主机密钥校验和认证。

在项目目录中启动：

```powershell
node .\src\index.js `
  --ssh-target example-gpu `
  --expected-hostname gpu-host.example `
  --expected-ip 192.0.2.10 `
  --local-root project=.
```

这里的示例地址属于文档地址段，必须替换成自己的 SSH 别名和身份信息。

启动后建议按顺序验证：

1. `probe_identity`：确认连到的是预期主机；
2. `get_execution_policy`：查看允许的程序、路径、模板和 Python；
3. `list_local_roots`：确认上传下载对应哪个本机目录；
4. 用一个无副作用命令测试 `exec_argv`；
5. 再进行文件传输或启动任务。

源代码或传输配置发生变化后，需要重新连接或重启 MCP。`reload_config`
只重新加载执行策略，不会加载新的 JavaScript 或 SSH 传输参数。

## 优先使用结构化工具

推荐工具如下：

- `probe_identity`：检查主机名、IP、操作系统、GPU 和执行环境；
- `exec_argv`：以参数数组执行一个程序，不让 shell 重新解析参数；
- `run_script`：根据已验证的目标自动选择 Bash/Sh 或 PowerShell；
- `stat_path`：读取远端路径元数据；
- `read_file`：读取 UTF-8 或 Base64 文件；
- `write_file`：默认以原子方式写入文件；
- `list_local_roots`：列出允许用于传输的本机根目录；
- `upload_file`、`download_file`：在命名根目录内传输文件；
- `connection_status`：查看连接池健康状态；
- `start_remote_session`：在 tmux 中启动持久任务；
- `read_remote_log`：增量读取训练或任务日志。

能使用 `exec_argv` 时，不要把程序和参数拼成一个 shell 字符串。例如把
程序写入 `program`，每个参数分别放入 `args`，可以避免空格、中文、引号、
括号和特殊字符被错误解释。

工具同时返回供人阅读的 JSON 文本和等价的 `structuredContent.data`。
错误结果使用 `structuredContent.error`；策略拒绝还会尽量返回稳定错误码和
非执行型的 `next_step` 说明，便于客户端调整方案而不是反复请求用户批准。

## 安全模型与只读策略

MCP 的只读、破坏性等注解只用于帮助客户端判断，服务器端策略才是最终边界。
在 Fleet 的 `readonly` 模式下，把程序名写进 `readOnlyPrograms` 只是第一步；
该程序还必须具有内置的正向参数 profile，并且每个参数都符合 profile。
没有 profile 的程序返回 `READONLY_PROFILE_UNAVAILABLE`，不支持的参数返回
`READONLY_PROFILE_DENIED`；两者都会直接拒绝，不会要求用户批准绕过。
`find`、`sed`、`journalctl`、`ip` 等复杂程序在 `readonly` 模式下
不受支持；只有新增经过代码审查和测试的专用只读 profile 或工具后才能开放。
经过审查的模板可以在 `restricted` 策略下使用，但模板不能绕过只读 argv profile。

只读 Git 状态必须把全局保护参数放在子命令之前：

```text
git --no-pager --no-optional-locks status --short --branch
```

程序白名单能够降低误操作，但不是操作系统安全沙箱。如果可能接收不可信提示词
或由不可信模型操作，应同时使用低权限 SSH 账户、远端文件权限、容器或服务级隔离。

本项目不会自动：

- 把用户批准变成绕过本机 Roots、凭据保护或主机身份检查的万能开关；
- 在故障后重放普通命令、文件写入、上传或训练启动；
- 一条路线失败后自动切换路线；
- 读取有效命名 Roots 以外的本机文件；
- 接受未知 SSH 主机密钥或扫描未声明网段。

## 本机根目录与文件传输

传输工具不接受任意本机绝对路径。首先选择 `list_local_roots` 返回的根名称，
然后提供相对于该根的 `local_path`。

配置一个项目根：

```powershell
node .\src\index.js --ssh-target example-gpu --local-root project=.
```

配置多个命名根：

```powershell
node .\src\index.js `
  --ssh-target example-gpu `
  --local-root project=. `
  --local-root 'shared=${RELIABLE_SSH_SHARED_ROOT}'
```

关键规则：

- `.` 相对于 MCP 进程的工作目录解析；
- 每个项目可以使用自己的 `project=.`；
- 共享目录通过用户配置或环境变量提供；
- 工具参数中的绝对本机路径默认拒绝；
- 下载先写临时文件，再原子重命名；
- 默认不覆盖已经存在的目标文件；
- 下载保持远端原始字节，不擅自修改行尾。

## 跨系统脚本和行尾

多行脚本优先使用 `run_script`。它会根据 `probe_identity` 已确认的远端环境
选择解释器，并使用远端目标系统所需的编码和行尾。

UTF-8 写入或上传支持：

- `auto`：默认值；Shell/POSIX 文件使用 LF，Windows 批处理文件使用 CRLF，
  其他确认是文本的文件使用目标平台原生行尾；
- `preserve`：逐字节保持；
- `lf`：确认是文本后强制使用 LF；
- `crlf`：确认是文本后强制使用 CRLF。

Base64、包含 NUL 的文件、无效 UTF-8、疑似二进制和超过规范化限制的文件
始终保持原始字节。

## 健康感知连接池

版本 0.9.0 使用 `health-pool-v2`：

- 第一条经过身份验证的连接可立即服务请求；
- 备用连接在后台补齐，不阻塞健康请求；
- 空闲连接使用轻量 `ping` 心跳，不反复启动 hostname 或 GPU 子进程；
- 繁忙连接跳过心跳；
- 超过约 60 秒没有成功响应的空闲连接，使用前先 `ping`；
- 身份缓存五分钟后过期，连接代数变化或没有新鲜连接时也会失效；
- 新连接执行任何用户操作前都必须验证远端身份；
- 只有内置 `probe_identity` 和 `ping` 在传输故障后可重试一次；
- 用户命令、文件写入和训练启动绝不自动重放；
- 不自动切换到另一条 SSH 路线。

示例：

```powershell
node .\src\index.js `
  --ssh-target example-gpu `
  --pool-size 2 `
  --keepalive-interval 30 `
  --heartbeat-interval 60
```

`connection_status` 中应看到：

- `implementation: "health-pool-v2"`；
- `health`、`last_success_at` 和 `last_error`；
- 心跳、重连、只读探测重试和连接代数。

连接池只保证控制通道健康，不保证普通 SSH 前台任务在断线后继续运行。

## 使用 tmux 保持长期任务

训练和长时间任务应使用 `start_remote_session`。它在远端创建独立 tmux
会话，并把标准输出和标准错误写入持久日志：

```text
~/.local/state/reliable-ssh-mcp/sessions/<session>/output.log
```

即使原 SSH 或 MCP 连接关闭，tmux 中的任务仍可继续。重新连接后可以使用：

- `list_remote_sessions`：查看任务；
- `remote_session_status`：查看运行状态、退出码和日志大小；
- `read_remote_session`：读取当前 tmux 窗口；
- `read_remote_log`：按偏移增量读取日志；
- `send_remote_session_input`：发送明确的交互输入；
- `stop_remote_session`：显式停止任务。

Linux 目标需要安装 `tmux`、`bash` 和 `tee`。缺少依赖时服务会返回错误，
不会偷偷退化为依赖当前 SSH 连接的前台任务。

## 使用 Fleet 管理多台服务器

从公开示例创建自己的本地配置：

```powershell
Copy-Item -LiteralPath .\config\fleet.example.json -Destination .\config\fleet.json
```

真实的 `config/fleet.json` 被 Git 忽略，因为通常包含主机名、IP、密钥路径、
本机目录和审计日志位置。

启动 Fleet：

```powershell
node .\src\index.js --fleet-config .\config\fleet.json
```

Fleet 支持：

- 多个命名服务器和多条明确路线；
- OpenSSH `ProxyJump` 跳板；
- 每台服务器独立的权限策略和工具组；
- 持久连接池、端口转发和 SOCKS5；
- 文件与目录传输；
- 服务器分组、硬件清单和运行提示；
- 受控的局域网发现和临时接入。

如果只操作一台服务器，优先使用固定的单服务器 MCP，工具面更小、更容易审计。

## 通过跳板机发现局域网服务器

必须先在私有 Fleet 配置中声明：

- 哪台服务器是跳板机；
- 允许扫描的 CIDR；
- 允许端口；
- 最大主机数量；
- 新接入主机的默认权限。

推荐流程：

1. `list_bastions` 查看边界；
2. `discover_lan_hosts` 只扫描允许的网段和端口；
3. `inspect_lan_host_key` 读取公钥指纹；
4. 通过独立可信渠道核对指纹；
5. `onboard_discovered_host` 使用该指纹建立临时严格 known-hosts 文件；
6. 确认无误后再把主机写入用户自己的私有 Fleet 配置。

临时接入的服务器在 MCP 进程退出后消失。系统不会自动扫描任意网段，也不会
自动接受未知主机密钥。

## Windows、Plink 与临时密码

Plink 模式必须配置固定 `hostKey`，并使用批处理模式，不能静默接受变化后的
主机密钥。

对于用户已经授权的登录密码，可使用 `provide_connection_password` 把密码
提供给当前 MCP 进程，然后调用 `probe_identity` 验证登录。密码：

- 不出现在 Plink 命令参数中；
- 不写入审计日志；
- 只写入权限受限的临时文件；
- 重启后需要重新提供；
- 不会改变远端账户密码；
- 不能用于绕过执行策略。

`clear_connection_password` 会清理临时密码并关闭空闲连接。存在进行中的操作时
会拒绝清理。该功能不是永久密码保险库，也不会替代 SSH 密钥或操作系统凭据管理器。

## 服务器清单和统一注册表

每台服务器可以配置 `serverInfo` 或 `serverInfoFile`，记录描述、CPU、内存、
存储、GPU、操作系统、来源和使用提示。清单是人工提供的描述，不代表实时可用容量。

注册表版本 2 可以让同一台物理服务器的多条连接路线共享：

- 身份要求；
- 硬件清单；
- 权限策略；
- 工具组。

连接地址、ProxyJump、Plink/OpenSSH 等传输差异放在各自路线中。系统不会在
路线失败后自动换路，也不会在另一条路线重放命令。

## 私有配置与公开发布

不得提交或打包以下内容：

- 真实 `config/fleet.json`；
- 密码、私钥、令牌和临时密码文件；
- 用户自己的 IP、主机名、密钥路径和固定共享目录；
- 本机迁移脚本、备份、运行日志和 canary 产物。

npm 包使用 `files` 白名单。发布前必须检查实际打包清单：

```powershell
npm pack --dry-run --json
```

### MCP Client Roots 模式

`--client-roots fallback` 是默认模式：启动参数或环境变量已配置 Roots 时优先使用，
只有没有显式配置时才查询 MCP 客户端。`merge` 会把客户端提供的 `file://` Roots
加入显式 Roots；`disabled` 完全忽略客户端 Roots。非文件 URI 会被忽略，最终有效
目录始终可通过 `list_local_roots` 检查，传输路径仍必须是某个命名 Root 下的相对路径。

## 审计日志

`--audit-log` 或每台 Fleet 服务器的 `auditLog` 会记录脱敏 JSONL 事件。记录包含
工具、时间、允许/拒绝状态、参数元数据和哈希，但不包含 stdout、stderr、stdin、
脚本正文、文件内容、密码或密码哈希。辅助审计写入失败会报警，但不会阻断主要 SSH
操作。策略拒绝、工具组禁用和传输能力不支持会被记录为未允许。

## Windows 持久连接说明

连接池通过 SSH 标准输入发送短 Python 执行器源码，并按 UTF-8 精确字节数读取，
避免把完整守护程序塞进 Windows SSH 的长命令行。远端 Python 使用 `-X utf8`。
注册表版本 2 应把 `remotePython` 放在具体路线中；Windows 主机应使用实际路径检查
目录，不要盲信继承的 `USERPROFILE` 或 `COMPUTERNAME`。修改 MCP JavaScript 后必须
重启 MCP，单纯关闭 SSH 池不会加载新代码。这个机制不会让 Linux 专属的 tmux、
`df` 或 `systemctl` 在 Windows 上自动可用。

## 开发者代码检查流程

项目级 [AGENTS.md](AGENTS.md) 要求 Codex 使用固定流程。

查看带行号的代码：

```powershell
npm run inspect -- lines --file src/connection-pool.js --start 279 --end 340
```

复杂正则不要直接写进 PowerShell。把它放入被忽略的 JSON 查询文件，例如
`staging/query.json`，然后运行：

```powershell
npm run inspect -- search --query staging/query.json
```

完整发布前检查：

```powershell
npm run verify
```

对不允许改动远端内容的生产服务器，使用完全只读的 smoke 测试。它检查输出
Schema、身份、路径元数据和可选的只读 profile 命令，不会调用任何远端写入或
删除工具：

```powershell
npm run smoke:readonly -- --fleet-config .\config\fleet.json --server readonly_host
```

它按固定顺序执行：

1. 未暂存和已暂存 diff 的空白检查；
2. JavaScript 语法检查；
3. 完整测试套件；
4. npm 打包干运行和文件清单输出。

更详细的原理见[代码检查说明](docs/code-inspection.md)。连接池本次修复的
技术记录见[连接健康修复报告](docs/connection-health-20260910.md)。

## 版本更新说明在哪里

根目录中的更新日志是正式入口：

- [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)：中文版；
- [CHANGELOG.md](CHANGELOG.md)：英文版。

README 用来说明“当前版本如何使用”，Changelog 用来说明“每个版本相对上个
版本改变了什么”。提交记录用于追踪具体代码，而不能代替面向用户的版本说明。
