---
title: Rust 实现一个自己的编码助手
date: 2026-03-17 10:46:21
tags: Rust
---

### 用 Rust 手搓一个 AI 编码助手：从原理到实现，300 行代码打造你的终端 Copilot

在之前的系列文章中，我们分别用 Rust + rig-core 实现了 {% post_link Rust-Agent-入门 'AI Agent 对话' %}、{% post_link Rust-RAG实战 'RAG 检索增强生成' %} 和 {% post_link Rust-Tool-Call入门 'Tool Call 工具调用' %}。今天，我们要把这些能力**融合**起来，做一件更酷的事——**用 Rust 从零构建一个像 Claude Code / Cursor 一样的终端编码助手**。

它能读文件、写文件、执行 Shell 命令，还能流式输出、多轮对话、自动处理超时。最关键的是，**整个项目只有 300 行 Rust 代码**。

如果你跟着本文走完，你会深刻理解：

- 编码助手的核心架构是什么
- `tokio::process::Command` 异步执行命令的底层原理
- `tokio::time::timeout` 超时控制机制
- 流式输出（Streaming）+ 多轮对话（Multi-turn）的实现
- 输出截断、错误处理等工程细节

---

## 为什么要自己造一个？

市面上的 AI 编码助手（Cursor、Claude Code、GitHub Copilot）功能确实强大，但你有没有想过：

- 它们的核心原理是什么？
- 为什么 AI 能帮你执行命令、读写文件？
- 背后的 Tool Call 机制到底怎么工作的？

**理解原理、不是使用工具，才是工程师的核心竞争力。** 自己动手实现一遍，比读十篇科普文章更有用。

更何况，我们用的是 Rust——内存安全、零成本抽象、编译期检查——天然适合构建这种需要高可靠性的工具。

---

## 回顾：从对话到工具调用的进化之路

在正式开始之前，先回顾下我们系列文章的知识脉络，理解为什么一个编码助手需要这些能力：

```
① Agent 基础对话        → LLM 能听懂你说话、按角色回答问题
      ↓
② RAG 检索增强          → LLM 能读你的文档、基于私有知识回答
      ↓
③ Tool Call 工具调用     → LLM 能主动调用函数、执行具体操作
      ↓
④ 编码助手（本文）       → 组合以上能力 + 流式输出 + 多轮对话 + 命令执行
```

| 能力 | 作用 | 对应文章 |
|------|------|---------|
| 基础对话 | 理解用户意图，生成自然语言回答 | Rust Agent 入门 |
| RAG | 让 LLM 基于你的代码库/文档回答问题 | Rust RAG 入门 |
| Tool Call | 让 LLM 动手执行操作（读写文件、跑命令） | Rust Tool Call 入门 |
| 流式输出 | 像打字机一样实时显示回答，而非等全部生成完 | **本文** |
| 多轮对话 | 记住上下文，支持连续交互 | **本文** |
| 命令超时 | 防止命令卡死，给出友好提示 | **本文** |

一句话概括：**编码助手 = Agent + Tool Call + 流式输出 + 多轮对话 + 工程化处理**。

---

## 整体架构设计

我们的编码助手叫 `rcode`，它的架构非常清晰：

```
┌──────────────────────────────────────────┐
│              用户终端 (REPL)              │
│  > 帮我看看 src/main.rs 有什么问题       │
└───────────────┬──────────────────────────┘
                │ 用户输入
                ▼
┌──────────────────────────────────────────┐
│            rig-core Agent                │
│  ┌─────────────────────────────────────┐ │
│  │  System Prompt（角色设定）           │ │
│  │  对话历史（多轮上下文）              │ │
│  │  工具列表（bash/read/write）         │ │
│  └─────────────────────────────────────┘ │
└───────────────┬──────────────────────────┘
                │ 发送给 LLM
                ▼
┌──────────────────────────────────────────┐
│          LLM (qwen2.5:7b via Ollama)     │
│                                          │
│  分析意图 → 决定是否调用工具              │
│  ├── 直接回答 → 流式输出文本              │
│  └── 需要工具 → 返回工具调用请求          │
│       ├── bash: 执行 Shell 命令           │
│       ├── read_file: 读取文件内容         │
│       └── write_file: 创建/修改文件       │
└───────────────┬──────────────────────────┘
                │ 工具结果 / 流式文本
                ▼
┌──────────────────────────────────────────┐
│         流式输出到终端 + 更新对话历史      │
└──────────────────────────────────────────┘
```

整个系统只有一个文件 `src/main.rs`，大约 300 行，包含：

- 3 个工具定义（`ReadFile`、`WriteFile`、`Bash`）
- 1 个主循环（REPL 交互 + 流式输出 + 多轮对话管理）

---

## 技术栈

| 组件 | 选择 | 说明 |
|------|------|------|
| 语言 | Rust | 高性能、内存安全、类型强 |
| LLM 框架 | rig-core 0.32 | Rust 生态 Agent 框架，支持 Tool Call + Streaming |
| LLM 模型 | qwen2.5:7b | 支持 Tool Call，中文友好 |
| 运行时 | Ollama | 本地模型推理，兼容 OpenAI API |
| 异步运行时 | tokio | Rust 异步生态的事实标准 |
| 流式处理 | futures | 提供 `StreamExt` 用于处理异步流 |

### 项目依赖

```toml
[package]
name = "rcode"
version = "0.1.0"
edition = "2024"

[dependencies]
anyhow = "1.0.102"
futures = "0.3.32"
rig-core = "0.32.0"
serde = { version = "1.0.228", features = ["derive"] }
serde_json = "1.0.149"
tokio = { version = "1.50.0", features = ["process", "rt", "macros", "rt-multi-thread"] }
```

注意 tokio 的 features：

- **`process`**：启用 `tokio::process::Command`，用于异步执行子进程
- **`rt`**：tokio 运行时核心
- **`macros`**：启用 `#[tokio::main]` 宏
- **`rt-multi-thread`**：多线程运行时，充分利用多核

---

## 深入解析：三大核心工具的实现

编码助手的"手"和"眼"就是它的工具。我们为 rcode 定义了三个工具：

### 工具一：ReadFile —— 读取文件内容

```rust
#[derive(Deserialize, Serialize)]
pub struct ReadFile;

#[derive(Deserialize, Serialize)]
pub struct ReadFileArgs {
    path: String,
}

impl Tool for ReadFile {
    const NAME: &'static str = "read_file";
    type Error = ToolError;
    type Args = ReadFileArgs;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "读取文件内容".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The path to the file to read"
                    }
                },
                "required": ["path"]
            }),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        std::fs::read_to_string(&args.path)
            .map_err(|e| ToolError::ToolCallError(
                format!("Failed to read file: {}", e).into()
            ))
    }
}
```

这是最简单的工具实现。几个关键点：

1. **`parameters` 用 JSON Schema 描述**：和之前 Tool Call 文章中用 `serde_json::to_value` 不同，这里直接用 `json!` 宏手写 JSON Schema。好处是 LLM 能更准确地理解参数含义，因为 schema 里有 `description` 字段。

2. **错误处理用 `ToolError`**：rig-core 内置的错误类型，比自定义错误类型更方便，它能把错误信息自动回传给 LLM，让 AI 知道"工具调用失败了"，进而调整策略。

3. **同步 I/O 在异步上下文中**：`std::fs::read_to_string` 是阻塞操作。在这里用它没问题，因为文件读取通常很快。如果是读取大文件或网络文件系统，应该换用 `tokio::fs::read_to_string`。

### 工具二：WriteFile —— 创建/修改文件

```rust
impl Tool for WriteFile {
    const NAME: &'static str = "write_file";
    type Error = ToolError;
    type Args = WriteFileArgs;
    type Output = String;

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        // 自动创建父目录
        if let Some(parent) = std::path::Path::new(&args.path).parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|e| {
                ToolError::ToolCallError(
                    format!("Failed to create directories: {}", e).into()
                )
            })?;
        }

        std::fs::write(&args.path, &args.content)
            .map_err(|e| ToolError::ToolCallError(
                format!("Failed to write file: {}", e).into()
            ))?;
        Ok("File written successfully".to_string())
    }
}
```

亮点是 **自动创建父目录**。当 LLM 决定创建 `src/utils/helper.rs` 时，即使 `src/utils/` 目录不存在，工具也会自动创建。这种细节决定了编码助手的可用性。

注意这里用了 Rust 2024 edition 的 `let-else` 链式语法：

```rust
if let Some(parent) = path.parent() && !parent.as_os_str().is_empty() {
```

这是 Rust 语言持续进化的一个缩影——语法越来越简洁，但安全性丝毫不减。

### 工具三：Bash —— 这才是重头戏

这是整个项目最复杂也最精华的部分。一个编码助手 90% 的能力来自于"能执行命令"，而正确地、安全地执行命令，涉及到异步进程管理、超时控制、输出处理等多个核心知识点。

---

## 深入原理：tokio::process::Command 异步命令执行

### 为什么不能用 std::process::Command？

Rust 标准库提供了 `std::process::Command`，可以执行子进程。但它有一个致命问题：**阻塞**。

```rust
// ❌ 标准库方式 —— 阻塞当前线程
let output = std::process::Command::new("bash")
    .arg("-c")
    .arg("sleep 10 && echo done")
    .output()  // 这里会阻塞 10 秒！
    .unwrap();
```

在一个异步应用中，阻塞线程意味着：

- 整个 tokio 运行时的线程池被占用
- 其他异步任务无法被调度
- 如果所有线程都被阻塞，整个应用就"卡死"了

### tokio::process::Command 的原理

`tokio::process::Command` 是标准库 `Command` 的异步封装。它的核心原理：

```
                       ┌──────────────────────┐
tokio::process::Command │                      │
       spawn()  ──────► │   操作系统子进程      │
                       │  (bash -c "...")      │
                       └──────────┬───────────┘
                                  │
                       ┌──────────▼───────────┐
                       │  tokio 事件循环监听    │
                       │  子进程的 fd/信号      │
                       │  (epoll/kqueue)       │
                       └──────────┬───────────┘
                                  │
                    子进程结束时触发事件
                                  │
                       ┌──────────▼───────────┐
                       │  唤醒对应的 Future     │
                       │  child.wait().await   │
                       │  返回 ExitStatus      │
                       └──────────────────────┘
```

关键区别：

| 特性 | std::process::Command | tokio::process::Command |
|------|----------------------|------------------------|
| 等待方式 | 阻塞线程（`wait()`） | 异步等待（`wait().await`） |
| 线程占用 | 占用一个 OS 线程 | 不占用线程，内核事件驱动 |
| 并发能力 | 每个命令需要一个线程 | 可以同时等待成千上万个子进程 |
| 底层机制 | `waitpid()` 系统调用（阻塞） | epoll/kqueue 事件通知 + SIGCHLD 信号 |

简单来说，`tokio::process::Command` 利用操作系统的事件通知机制（macOS 上是 kqueue，Linux 上是 epoll），**在子进程运行期间不占用任何线程**，只在子进程结束时通过事件回调来唤醒等待的 Future。

### rcode 中的命令执行实现

```rust
impl Bash {
    async fn run(&self, args: BashArgs) -> Result<String, ToolError> {
        // 1. 异步启动子进程
        let mut child = Command::new("bash")
            .arg("-c")
            .arg(&args.command)
            .stdout(std::process::Stdio::piped())  // 捕获标准输出
            .stderr(std::process::Stdio::piped())  // 捕获标准错误
            .spawn()
            .map_err(|e| ToolError::ToolCallError(
                format!("Failed to spawn command: {}", e).into()
            ))?;
        // ...
    }
}
```

逐行解析：

1. **`Command::new("bash").arg("-c").arg(&args.command)`**：用 bash 执行命令。`-c` 参数表示后面跟的是要执行的命令字符串。这意味着用户（通过 LLM）可以执行任何合法的 shell 命令，包括管道、重定向等。

2. **`.stdout(Stdio::piped()).stderr(Stdio::piped())`**：将子进程的标准输出和标准错误**管道化**，这样我们就能在 Rust 代码中读取命令的输出，而不是让它直接打印到终端。

3. **`.spawn()`**：启动子进程。注意这里是 `spawn()` 而不是 `output()`。`spawn()` 立即返回一个 `Child` 句柄，子进程在后台运行。这是异步模式的关键——我们拿到句柄后，可以对子进程做更精细的控制（比如超时）。

---

## 深入原理：tokio::time::timeout 超时控制

### 为什么需要超时？

想象一下这个场景：用户让 AI 执行 `cargo build`，编译一个大项目，可能需要几分钟。又或者用户不小心触发了一个死循环脚本。如果没有超时机制，整个程序就会"挂"在那里，无法响应。

### tokio::time::timeout 的原理

`tokio::time::timeout` 是 tokio 提供的超时控制原语。它的工作原理：

```rust
// 伪代码：timeout 的内部实现逻辑
async fn timeout<F: Future>(duration: Duration, future: F) -> Result<F::Output, Elapsed> {
    tokio::select! {
        result = future => Ok(result),      // Future 先完成 → 返回结果
        _ = tokio::time::sleep(duration) => Err(Elapsed),  // 定时器先到 → 返回超时
    }
}
```

本质上是一个**竞赛（Race）**：

```
                  ┌── future 完成 ──→ Ok(result)
                  │
tokio::select! ──┤
                  │
                  └── sleep 到期 ──→ Err(Elapsed)
```

两个 Future 同时被 poll，谁先完成就返回谁的结果。这里没有线程被阻塞，不需要额外创建线程，一切都在 tokio 事件循环中完成。

### rcode 中的超时实现——优雅的"警告式超时"

rcode 的超时策略很有意思：**不是超时就杀进程，而是先给用户一个警告，然后继续等**。

```rust
const WARNING_TIMEOUT_SECS: u64 = 60;

let warning_duration = Duration::from_secs(WARNING_TIMEOUT_SECS);
let status = match tokio::time::timeout(warning_duration, child.wait()).await {
    // 情况一：60 秒内命令正常完成
    Ok(result) => result.map_err(|e| {
        ToolError::ToolCallError(format!("Command failed: {}", e).into())
    })?,

    // 情况二：超过 60 秒，命令仍在运行
    Err(_) => {
        // 不是杀掉进程！而是打印一条警告
        eprintln!(
            "\n[Command running for >{}s. Press Ctrl+C to interrupt]",
            WARNING_TIMEOUT_SECS
        );
        io::stderr().flush().ok();

        // 然后继续等待命令完成（无超时限制）
        child.wait().await.map_err(|e| {
            ToolError::ToolCallError(format!("Command failed: {}", e).into())
        })?
    }
};
```

为什么这样设计？

1. **编译命令可能就是慢**：`cargo build` 大项目可能需要几分钟，直接杀掉不合理。
2. **用户需要知情权**：如果命令运行超过 60 秒，用户应该知道"还在跑"，而不是以为程序卡了。
3. **保留中断权**：用户看到提示后，可以自己按 `Ctrl+C` 来中断。

这是一个非常实用的工程模式：

```
┌────────────┐     ┌────────────────┐     ┌──────────────┐
│ 0~60 秒    │ ──→ │ 安静等待       │ ──→ │ 正常返回结果  │
│ 命令完成    │     │ 不打扰用户     │     │              │
└────────────┘     └────────────────┘     └──────────────┘

┌────────────┐     ┌────────────────┐     ┌──────────────┐
│ 超过 60 秒  │ ──→ │ 打印警告提示   │ ──→ │ 继续等待     │
│ 命令未完成  │     │ 用户可 Ctrl+C  │     │ 直到命令完成  │
└────────────┘     └────────────────┘     └──────────────┘
```

### 如果真要"硬超时"怎么办？

如果你的场景要求必须在某个时间内结束（比如 API 服务），可以改成：

```rust
// 硬超时：超时直接杀进程
match tokio::time::timeout(Duration::from_secs(300), child.wait()).await {
    Ok(result) => { /* 正常完成 */ },
    Err(_) => {
        child.kill().await.ok();  // 杀掉子进程
        return Err("Command timed out after 300s".into());
    }
}
```

`child.kill()` 会向子进程发送 SIGKILL 信号，强制终止。注意这是不可恢复的——子进程没有机会做清理工作。更温和的方式是先发 SIGTERM，等几秒后再 SIGKILL。

---

## 输出处理：大输出截断

命令执行后，我们需要读取输出。但有些命令的输出可能非常大（比如 `cat` 一个大文件），直接传给 LLM 会导致 token 超限或响应变慢。

```rust
const MAX_OUTPUT_BYTES: usize = 50 * 1024;  // 50KB 上限

// 读取 stdout 和 stderr（异步读取）
if let Some(mut stdout) = stdout {
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::new();
    stdout.read_to_end(&mut buf).await.ok();
    stdout_content = String::from_utf8_lossy(&buf).to_string();
}

// ... 拼接输出 ...

// 截断过大的输出
let total_bytes = output.len();
if total_bytes > MAX_OUTPUT_BYTES {
    output.truncate(MAX_OUTPUT_BYTES);
    // 确保不会截断在 UTF-8 多字节字符的中间
    while !output.is_char_boundary(output.len()) {
        output.pop();
    }
    output.push_str(&format!(
        "\n... [output truncated, {} bytes total]",
        total_bytes
    ));
}
```

这里有一个容易被忽视的细节：**UTF-8 安全截断**。

UTF-8 编码中，中文字符占 3 个字节，如果你在第 2 个字节处截断，就会产生一个不合法的 UTF-8 序列。`is_char_boundary()` 方法检查某个位置是否是合法的字符边界：

```
"你好" 的 UTF-8 编码：[0xE4, 0xBD, 0xA0, 0xE5, 0xA5, 0xBD]
                     ↑         ↑         ↑
                   边界       不是边界    边界
```

`while !output.is_char_boundary(output.len())` 会一直回退，直到找到一个合法的字符边界。这种细节在 Python 等语言中不需要关心（因为字符串是 Unicode 的），但在 Rust 中，字节级别的操作让你必须显式处理。

### 退出码处理与输出组装

```rust
let mut output = if status.success() {
    // 命令成功：输出 stdout，如果有 stderr 也附上
    let mut out = stdout_content;
    if !stderr_content.is_empty() {
        if !out.is_empty() { out.push('\n'); }
        out.push_str("stderr:\n");
        out.push_str(&stderr_content);
    }
    out
} else {
    // 命令失败：输出退出码 + stdout + stderr
    let mut out = format!("Exit code: {}\n", status.code().unwrap_or(-1));
    if !stdout_content.is_empty() {
        out.push_str("stdout:\n");
        out.push_str(&stdout_content);
        out.push('\n');
    }
    if !stderr_content.is_empty() {
        out.push_str("stderr:\n");
        out.push_str(&stderr_content);
    }
    out
};
```

这段代码的设计意图：

- **命令成功**时，LLM 主要关心 stdout（命令输出），stderr 作为补充信息。
- **命令失败**时，LLM 需要知道退出码和错误信息（stderr），才能帮用户排查问题。
- **`status.code().unwrap_or(-1)`**：如果进程被信号杀死（如 SIGKILL），`code()` 返回 `None`，这时用 -1 作为兜底值。

---

## 流式输出：StreamExt + Multi-Turn

### 为什么需要流式输出？

普通的 `prompt().await` 是"一次性返回"——LLM 生成完所有内容后才返回结果。对于长回答，用户要等十几秒甚至更久才能看到第一个字。

流式输出让 LLM 生成一个 token 就立即返回一个 token，像打字机一样逐字显示，大幅提升用户体验。

### 流式输出的实现

```rust
use futures::StreamExt;
use rig::agent::MultiTurnStreamItem;
use rig::streaming::{StreamedAssistantContent, StreamingPrompt};

let mut stream = agent
    .stream_prompt(input)           // 流式发送 prompt
    .with_history(history.clone())  // 附带对话历史
    .multi_turn(100)                // 最多 100 轮工具调用
    .await;

let mut response_text = String::new();

while let Some(chunk) = stream.next().await {
    match chunk {
        // 文本片段——逐字打印
        Ok(MultiTurnStreamItem::StreamAssistantItem(
            StreamedAssistantContent::Text(text),
        )) => {
            print!("{}", text.text);
            stdout.flush()?;
            response_text.push_str(&text.text);
        }

        // 工具调用——打印调用信息
        Ok(MultiTurnStreamItem::StreamAssistantItem(
            StreamedAssistantContent::ToolCall { tool_call, .. },
        )) => {
            println!("\n[Calling tool: {}]", tool_call.function.name);
        }

        // 工具结果返回
        Ok(MultiTurnStreamItem::StreamUserItem(
            rig::streaming::StreamedUserContent::ToolResult { tool_result, .. },
        )) => {
            println!("[Tool result received for: {}]", tool_result.id);
        }

        // 最终响应（包含 token 使用统计）
        Ok(MultiTurnStreamItem::FinalResponse(final_response)) => {
            let usage = final_response.usage();
            input_tokens = usage.input_tokens;
            output_tokens = usage.output_tokens;
        }

        Err(e) => {
            eprintln!("\nError: {}", e);
            break;
        }
        _ => {}
    }
}
```

逐一讲解：

#### 1. `stream_prompt` vs `prompt`

```rust
// 非流式：等所有内容生成完才返回
let response = agent.prompt("问题").await?;

// 流式：返回一个 Stream，每生成一个片段就 yield 一次
let stream = agent.stream_prompt("问题").with_history(history).multi_turn(100).await;
```

#### 2. `multi_turn(100)` 是什么？

这是 rig-core 的一个重要特性。在一次交互中，LLM 可能需要**多次工具调用**：

```
用户: "帮我看看 src/main.rs 有什么问题，然后修复它"

LLM 第 1 轮: 调用 read_file("src/main.rs") → 读取文件内容
LLM 第 2 轮: 分析后调用 write_file("src/main.rs", 修复后的内容) → 写入修复
LLM 第 3 轮: 调用 bash("cargo build") → 验证修复是否成功
LLM 第 4 轮: 生成总结文本 → 告诉用户修复完成
```

`multi_turn(100)` 表示允许在一次 prompt 中最多进行 100 轮工具调用。这使得 LLM 可以自主完成复杂的多步骤任务。

#### 3. `StreamExt::next()`

`futures::StreamExt` 为 `Stream` trait 提供了 `next()` 方法，它返回一个 `Option`：

- `Some(item)`：流中还有数据
- `None`：流结束

`while let Some(chunk) = stream.next().await` 是标准的异步流消费模式。

---

## 多轮对话：上下文管理

编码助手的另一个关键能力是**记住上下文**。用户可能连续问几个相关的问题：

```
> 帮我创建一个新文件 utils.rs
> 把刚才那个文件加上错误处理
> 跑一下测试看看
```

每一轮都依赖前面的上下文。实现方式其实很简单：

```rust
let mut history: Vec<Message> = Vec::new();

loop {
    // ... 读取用户输入 ...

    // 发送时附带历史记录
    let stream = agent
        .stream_prompt(input)
        .with_history(history.clone())
        .multi_turn(100)
        .await;

    // ... 处理流式输出 ...

    // 将这一轮对话存入历史
    history.push(Message::user(input));
    if !response_text.is_empty() {
        history.push(Message::assistant(response_text));
    }
}
```

每轮对话结束后，将用户消息和助手回复都存入 `history`。下次对话时，整个历史记录会一起发送给 LLM，这样 LLM 就能"记住"之前的对话内容。

### 历史记录的代价

需要注意的是，历史记录越长，每次请求的 token 数就越大：

```
第 1 轮: [系统提示 + 用户消息 1]                    → ~500 tokens
第 5 轮: [系统提示 + 5 轮对话历史]                   → ~3000 tokens
第 20 轮: [系统提示 + 20 轮对话历史]                  → ~15000 tokens ⚠️
```

当历史记录超过模型的上下文窗口时，要么截断早期对话，要么进行摘要压缩。这是进阶优化的方向。

---

## System Prompt：塑造助手的"人格"

System Prompt（系统提示词）决定了 AI 助手的行为模式。rcode 的 System Prompt 简洁但信息量足够：

```rust
const SYSTEM_PROMPT: &str = r#"You are rcode, an interactive AI coding tool running in the terminal.

You have access to these tools:
- bash: Execute shell commands (runs in current working directory)
- read_file: Read file contents
- write_file: Create or modify files

Guidelines:
- Use bash to explore projects, run tests, git operations, etc.
- Read files before modifying them to understand context
- Be concise and focused on solving the user's problem
- When making changes, explain what you're doing briefly
"#;
```

设计原则：

1. **明确身份**：告诉 LLM 自己是谁（终端编码助手）
2. **列出工具**：明确说明有哪些工具可用，以及每个工具能做什么
3. **行为准则**：引导 LLM 先读再改、简洁回答等好习惯

好的 System Prompt 可以显著提升助手的表现。你可以根据自己的需求定制，比如加上"优先使用中文回答"或"修改文件前必须备份"等规则。

---

## REPL 主循环：把一切串起来

```rust
#[tokio::main]
async fn main() -> Result<()> {
    let client = ollama::Client::new(Nothing)?;

    let agent = client
        .agent("qwen2.5:7b")
        .preamble(SYSTEM_PROMPT)
        .tool(ReadFile)
        .tool(WriteFile)
        .tool(Bash)
        .max_tokens(8192)
        .build();

    println!("Rig Code v0.1.0");
    println!("Type 'exit' or 'quit' to exit.\n");

    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut history: Vec<Message> = Vec::new();

    loop {
        print!("> ");
        stdout.flush()?;

        let mut input = String::new();
        match stdin.read_line(&mut input) {
            Ok(0) => { println!("\nGoodbye!"); break; }     // EOF (Ctrl+D)
            Err(e) => { eprintln!("Error: {}", e); }
            Ok(_) => {
                let input = input.trim();
                if input.eq_ignore_ascii_case("exit") || input.eq_ignore_ascii_case("quit") {
                    break;
                }
                if input.is_empty() { continue; }

                // ... 流式对话处理 ...
            }
        }
    }
    Ok(())
}
```

这就是 REPL（Read-Eval-Print Loop）模式：

1. **Read**：读取用户输入
2. **Eval**：发送给 LLM，执行工具调用
3. **Print**：流式输出结果
4. **Loop**：循环往复

EOF 处理（`Ok(0)`）是个细节——当用户按 `Ctrl+D` 时，`read_line` 返回 0 个字节，表示输入流结束，程序应该优雅退出。

---

## Token 统计：一个实用的小功能

每轮对话结束后，rcode 会显示 token 使用量：

```rust
println!(
    "[Tokens: {} in / {} out]",
    format_number(input_tokens),
    format_number(output_tokens)
);
```

`format_number` 函数将数字格式化为千分位表示（如 `1,234`），方便阅读：

```rust
fn format_number(n: u64) -> String {
    let s = n.to_string();
    let mut result = String::new();
    for (i, c) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    result.chars().rev().collect()
}
```

算法很巧妙：从数字末尾开始遍历，每 3 位插入一个逗号，最后再翻转回来。

---

## 运行效果

```bash
cargo run
```

启动后进入交互模式：

```
Rig Code v0.1.0
Type 'exit' or 'quit' to exit.

> 帮我看看当前目录有什么文件

[Calling tool: bash]
[Tool result received for: call_1]

当前目录包含以下文件：
- Cargo.toml    # 项目配置
- src/main.rs   # 主源文件

[Tokens: 1,245 in / 89 out]

> 读一下 src/main.rs 然后帮我加上注释

[Calling tool: read_file]
[Tool result received for: call_2]
[Calling tool: write_file]
[Tool result received for: call_3]

已经为 src/main.rs 添加了详细的中文注释，主要包括：
1. 函数功能说明
2. 关键逻辑解释
3. 参数含义标注

[Tokens: 3,456 in / 234 out]
```

---

## 总结：一张图看清全貌

```
┌─────────────────────────── rcode 编码助手 ───────────────────────────┐
│                                                                      │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌────────────────────┐ │
│  │ ReadFile │  │ WriteFile │  │   Bash    │  │  System Prompt     │ │
│  │ 读取文件  │  │ 写入文件   │  │ 执行命令  │  │  角色设定 + 规则   │ │
│  └─────┬────┘  └─────┬─────┘  └─────┬─────┘  └────────┬───────────┘ │
│        │             │              │                  │             │
│        └─────────────┼──────────────┘                  │             │
│                      │  Tool Call 机制                  │             │
│                      ▼                                 │             │
│  ┌───────────────────────────────────┐                 │             │
│  │         rig-core Agent            │◄────────────────┘             │
│  │  · 流式输出 (StreamExt)           │                               │
│  │  · 多轮对话 (history)             │                               │
│  │  · 多轮工具调用 (multi_turn)      │                               │
│  └───────────────┬───────────────────┘                               │
│                  │                                                    │
│                  ▼                                                    │
│  ┌───────────────────────────────────┐                               │
│  │     LLM (qwen2.5:7b / Ollama)    │                               │
│  └───────────────────────────────────┘                               │
│                                                                      │
│  核心技术点：                                                         │
│  · tokio::process::Command  → 异步命令执行，不阻塞线程                │
│  · tokio::time::timeout     → 60s 警告式超时，优雅处理长时间命令       │
│  · futures::StreamExt       → 流式输出，逐字显示                      │
│  · UTF-8 安全截断           → 50KB 输出上限，处理多字节字符边界        │
│  · Message 历史数组          → 多轮对话上下文记忆                      │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

回顾整个系列：

1. **{% post_link Rust-Agent-入门 'Rust Agent 入门' %}**：用 20 行代码搭建了第一个 AI 对话应用
2. **{% post_link Rust-RAG实战 'Rust RAG 入门' %}**：让 AI 能读懂你的 PDF 文档，"开卷考试"
3. **{% post_link Rust-Tool-Call入门 'Rust Tool Call 入门' %}**：让 AI 会调函数、能动手干活
4. **本文**：把所有能力融合，300 行代码构建一个真正可用的编码助手

从简单对话到能读能写能执行命令的编码助手，Rust + rig-core 让我们用极少的代码实现了惊人的功能。而 Rust 带来的内存安全、类型检查和高性能，让这个工具从"玩具"变成了可以真正日常使用的"利器"。

**代码就是最好的教程，动手跑一遍吧。**
