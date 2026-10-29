---
title: Rust Tool Call入门
date: 2026-03-16 16:24:20
tags: Rust
---

在前两篇文章中，我们用 Rust + rig-core 实现了 {% post_link Rust-Agent-入门 'AI Agent 对话' %} 和 {% post_link Rust-RAG实战 'RAG 检索增强生成' %}。但你有没有想过：**如果 LLM 不只是聊天，还能帮你查天气、做计算、调接口呢？** 这就是 **Tool Call（工具调用）** 的能力——它让 LLM 从"只会说话"进化为"能动手干活"的智能体。

本文将带你深入理解 Tool Call 的核心原理，并用 Rust + rig-core + Ollama 在本地实现一个支持多工具调用的 AI Agent。

---

## 什么是 Tool Call？

Tool Call（工具调用），也叫 Function Calling（函数调用），是指 **LLM 在对话过程中，根据用户意图主动选择并调用外部工具（函数）** 的能力。

传统 LLM 对话流程：

```
用户提问 → LLM 生成文本回答（纯靠"记忆"）
```

有了 Tool Call 后：

```
用户提问 → LLM 分析意图 → 决定调用哪个工具 → 传入参数 → 获取工具返回结果 → 结合结果生成最终回答
```

### 一个直观的例子

当用户问："上海今天天气怎么样？"

- **没有 Tool Call**：LLM 只能说"我无法获取实时天气信息"或者编造一个答案。
- **有 Tool Call**：LLM 识别出需要调用 `get_weather` 工具，传入参数 `city: "上海"`，获取真实天气数据后回答。

### Tool Call vs RAG

你可能会想：这和 RAG 有什么区别？

| 特性 | RAG | Tool Call |
|------|-----|-----------|
| 核心思路 | 先检索文档，再生成回答 | 先调用函数，再生成回答 |
| 数据来源 | 预先索引的文档库 | 实时调用的外部 API/函数 |
| 适用场景 | 基于静态知识库的问答 | 需要实时数据或执行操作的场景 |
| 触发方式 | 每次都检索 | LLM 自主判断是否需要调用 |

一句话总结：**RAG 让 LLM "开卷考试"，Tool Call 让 LLM "动手实验"。** 两者可以组合使用，构建更强大的 Agent。

---

## Tool Call 的工作原理

Tool Call 的完整流程可以分为四个阶段：

### 1. 工具注册（Tool Registration）

在启动 Agent 之前，我们需要告诉 LLM 有哪些工具可用。每个工具需要提供：

- **名称（name）**：工具的唯一标识，如 `get_weather`
- **描述（description）**：工具的功能说明，让 LLM 理解什么时候该用它
- **参数定义（parameters）**：工具接受的输入参数及其类型

```
可用工具列表：
├── get_weather: 获取天气信息，参数: { city: String }
├── get_local_time: 获取本地时间，参数: 无
└── add: 执行加法操作，参数: { x: u32, y: u32 }
```

### 2. 意图识别与工具选择（Intent Recognition）

当用户发送消息后，LLM 会分析用户意图，判断：

- 是否需要调用工具？（普通聊天就直接回答）
- 调用哪个工具？
- 传入什么参数？

LLM 的输出不再是普通文本，而是一个结构化的工具调用请求：

```json
{
  "tool": "get_weather",
  "arguments": {
    "city": "上海"
  }
}
```

### 3. 工具执行（Tool Execution）

框架（rig-core）收到 LLM 的工具调用请求后，会：

1. 根据工具名称找到对应的 Rust 函数
2. 反序列化参数
3. 执行函数，获取返回值

### 4. 结果整合（Result Integration）

工具执行完毕后，框架将工具返回的结果重新注入给 LLM，LLM 结合工具结果生成最终的自然语言回答。

```
工具返回: { city: "上海", temperature: 30, weather: "Sunny" }
LLM 最终回答: "上海的天气是晴朗，温度是30度。"
```

整个流程的时序图：

```
用户 → Agent → LLM（分析意图）
                  ↓
              需要调用工具？
              ├── 否 → 直接生成回答 → 返回用户
              └── 是 → 输出工具调用请求
                        ↓
                  Agent 执行工具函数
                        ↓
                  将工具结果回传 LLM
                        ↓
                  LLM 生成最终回答 → 返回用户
```

---

## 模型选择：不是所有模型都支持 Tool Call

这是一个非常重要的注意事项：**并非所有 LLM 都支持 Tool Call 能力**。

### 哪些模型支持？

| 模型 | 是否支持 Tool Call | 说明 |
|------|-------------------|------|
| qwen2.5 | ✅ 支持 | 对中文支持好，推荐使用 |
| llama3.1 / llama3.2 | ✅ 支持 | Meta 开源模型 |
| mistral | ✅ 支持 | Mistral AI 开源模型 |
| deepseek-r1 | ❌ 不支持 | 推理模型，专注思维链推理 |
| deepseek-v2 | ✅ 支持 | DeepSeek 对话模型 |

### 踩坑记录

如果你使用不支持 Tool Call 的模型（如 `deepseek-r1:8b`），会收到类似下面的错误：

```
thread 'main' panicked at src/main.rs:30:50:
called `Result::unwrap()` on an `Err` value: CompletionError(HttpError(
  InvalidStatusCodeWithMessage(400, 
  "{\"error\":\"registry.ollama.ai/library/deepseek-r1:8b does not support tools\"}")))
```

由于 `deepseek-r1` 是专注于思维链推理的模型，Ollama 官方明确标注其不支持 tools 能力，因此无法用于 Tool Call 场景。

**解决方案**：需要安装一个支持 Tool Call 的模型。本项目推荐使用 `qwen2.5:7b`，它对中文支持好且完整支持函数调用：

```bash
# 安装支持 Tool Call 的 qwen2.5 模型
ollama pull qwen2.5:7b
```

安装完成后，将代码中的模型名从 `deepseek-r1:8b` 改为 `qwen2.5:7b` 即可：

```rust
// ❌ deepseek-r1 不支持 Tool Call
let agent = client.agent("deepseek-r1:8b")

// ✅ 改用 qwen2.5，支持 Tool Call
let agent = client.agent("qwen2.5:7b")
```

---

## 用 Rust 实现 Tool Call 实战

了解了原理，我们来看如何用 Rust + rig-core 实现一个支持多工具调用的 Agent。

### 技术栈

| 组件 | 选择 | 说明 |
|------|------|------|
| 语言 | Rust | 高性能、类型安全 |
| LLM 框架 | rig-core | Rust 生态的 AI Agent 框架 |
| LLM 模型 | qwen2.5:7b | 支持 Tool Call，中文友好 |
| 模型运行 | Ollama | 本地模型推理服务 |

### 前置准备

确保 Ollama 已安装并拉取模型：

```bash
# 拉取支持 Tool Call 的模型
ollama pull qwen2.5:7b
```

### 项目结构

```
tool/
├── Cargo.toml
└── src/
    ├── main.rs        # 入口：构建 Agent，注册工具
    ├── lib.rs         # 模块导出
    ├── weather.rs     # 天气查询工具
    ├── local.rs       # 本地时间工具
    └── add.rs         # 加法运算工具
```

### 项目依赖

`Cargo.toml` 配置：

```toml
[package]
name = "tool"
version = "0.1.0"
edition = "2024"

[dependencies]
anyhow = "1.0.102"
chrono = "0.4.44"
rig-core = "0.32.0"
serde = { version = "1.0.228", features = ["serde_derive"] }
serde_json = "1.0.149"
thiserror = "2.0.18"
tokio = { version = "1.50.0", features = ["macros", "rt", "rt-multi-thread"] }
```

关键依赖说明：

- **rig-core**：核心 Agent 框架，提供 `Tool` trait 和 Agent 构建能力
- **serde / serde_json**：序列化/反序列化工具参数和返回值
- **thiserror**：优雅的错误类型定义
- **chrono**：获取本地时间（供 LocalTime 工具使用）

---

### 第一步：定义工具——天气查询

我们从最经典的天气查询工具开始。在 rig-core 中，实现一个 Tool 需要四个要素：

1. **工具结构体**：标识工具本身
2. **参数类型（Args）**：LLM 传入的参数
3. **输出类型（Output）**：工具返回的结果
4. **错误类型（Error）**：工具可能的错误

`src/weather.rs`：

```rust
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct Weather;

#[derive(Debug, Deserialize, Serialize)]
pub struct WeatherArgs {
    city: String,
}

#[derive(Debug, Serialize)]
pub struct WeatherResult {
    city: String,
    temperature: i32,
    weather: String,
}

#[derive(Debug, thiserror::Error)]
#[error("天气工具错误")]
pub struct WeatherError;

impl Tool for Weather {
    const NAME: &'static str = "get_weather";
    type Args = WeatherArgs;
    type Error = WeatherError;
    type Output = WeatherResult;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "获取天气信息".to_string(),
            parameters: serde_json::to_value(WeatherArgs {
                city: "城市名称".to_string(),
            })
            .unwrap(),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        Ok(get_weather(args).await)
    }
}

async fn get_weather(args: WeatherArgs) -> WeatherResult {
    WeatherResult {
        city: args.city,
        temperature: 30,
        weather: "Sunny".to_string(),
    }
}
```

逐一拆解：

- **`const NAME`**：工具名称，LLM 通过这个名字来调用工具。
- **`type Args`**：参数类型，需要实现 `Deserialize`，因为 LLM 输出的是 JSON，框架会自动反序列化。
- **`type Output`**：返回类型，需要实现 `Serialize`，框架会将结果序列化后传回给 LLM。
- **`definition()`**：返回工具的元信息（名称、描述、参数 schema），这些信息会随 prompt 一起发送给 LLM，帮助它理解工具能力。
- **`call()`**：实际执行逻辑。这里用了一个模拟返回，实际项目中你可以调用真实的天气 API。

> 💡 **重点理解**：`definition()` 返回的 `parameters` 字段不是"默认值"，而是"参数 schema"。它告诉 LLM 这个工具需要一个名为 `city` 的字符串参数。LLM 看到这个 schema 后，就知道调用时应该传什么样的参数。

---

### 第二步：定义工具——本地时间

一个不需要参数的工具示例。

`src/local.rs`：

```rust
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct LocalTime;

#[derive(Debug, thiserror::Error)]
#[error("本地时间工具错误")]
pub struct LocalTimeError;

impl Tool for LocalTime {
    const NAME: &'static str = "get_local_time";
    type Args = ();
    type Error = LocalTimeError;
    type Output = String;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "获取本地时间".to_string(),
            parameters: serde_json::to_value(()).unwrap(),
        }
    }

    async fn call(&self, _args: Self::Args) -> Result<Self::Output, Self::Error> {
        Ok(chrono::Local::now().to_rfc3339())
    }
}
```

这个工具展示了最简形态：**无参数输入，直接返回当前时间字符串**。`type Args = ()` 表示不需要任何参数。

---

### 第三步：定义工具——加法计算

展示如何传递多个参数。

`src/add.rs`：

```rust
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct Add;

#[derive(Debug, Deserialize, Serialize)]
pub struct AddArgs {
    x: u32,
    y: u32,
}

#[derive(Debug, Serialize)]
pub struct AddResult {
    sum: u32,
}

#[derive(Debug, thiserror::Error)]
#[error("加法工具错误")]
pub struct AddError;

impl Tool for Add {
    const NAME: &'static str = "add";
    type Args = AddArgs;
    type Error = AddError;
    type Output = AddResult;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "执行加法操作".to_string(),
            parameters: serde_json::to_value(AddArgs { x: 0, y: 0 }).unwrap(),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        Ok(get_add(args).await)
    }
}

async fn get_add(args: AddArgs) -> AddResult {
    AddResult {
        sum: args.x + args.y,
    }
}
```

---

### 第四步：模块导出

`src/lib.rs`：

```rust
pub mod add;
pub mod local;
pub mod weather;
```

---

### 第五步：构建 Agent 并注册工具

`src/main.rs` 是整个项目的入口，负责创建 Agent 并把所有工具"挂载"上去。

```rust
use anyhow::Result;
use rig::{
    client::{CompletionClient, Nothing},
    completion::Prompt,
    providers::ollama,
};
use std::env;
use tool::{add, local, weather};

#[tokio::main]
async fn main() -> Result<()> {
    let question = env::args()
        .nth(1)
        .expect("请提供一个问题作为命令行参数，例如: cargo run -- \"你的问题\"");

    let client = ollama::Client::new(Nothing)?;

    let weather_tool = weather::Weather;
    let local_time_tool = local::LocalTime;
    let add_tool = add::Add;

    let agent = client
        .agent("qwen2.5:7b")
        .preamble("你是一个智能助手，可以使用以下工具来回答用户的问题：")
        .tool(weather_tool)
        .tool(local_time_tool)
        .tool(add_tool)
        .build();

    let response = agent.prompt(&question).await.unwrap();

    println!("Agent: {}", response);
    Ok(())
}
```

关键代码解析：

1. **`ollama::Client::new(Nothing)`**：创建一个连接本地 Ollama 的客户端，`Nothing` 表示不需要额外配置（Ollama 默认跑在 `localhost:11434`）。
2. **`.agent("qwen2.5:7b")`**：指定使用 `qwen2.5:7b` 模型（必须支持 Tool Call）。
3. **`.preamble(...)`**：设置系统提示词，引导 LLM 的行为。
4. **`.tool(weather_tool)`**：注册工具。可以链式调用注册多个工具。
5. **`.build()`**：构建 Agent 实例。
6. **`agent.prompt(&question)`**：发送用户问题。rig-core 会自动处理工具调用的完整流程——如果 LLM 决定调用工具，框架会执行工具、回传结果，最终返回整合后的回答。

---

### 运行测试

编译并运行：

```bash
# 查询天气
cargo run -- "上海天气怎么样？"
# Agent: 上海的天气是晴朗，温度是30度 Celsius。

# 获取时间
cargo run -- "现在几点了？"
# Agent: 现在的本地时间是2026年3月16日...

# 执行计算
cargo run -- "帮我算一下 123 + 456"
# Agent: 123 + 456 = 579

# 普通聊天（不触发工具）
cargo run -- "你好，介绍一下你自己"
# Agent: 你好！我是一个智能助手...
```

可以看到，LLM 会根据用户意图 **自主决定** 是否需要调用工具，以及调用哪一个工具。这就是 Tool Call 的魅力——Agent 拥有了"判断力"和"执行力"。

---

## rig-core 中 Tool trait 详解

理解 `Tool` trait 是掌握 rig-core 工具调用的关键。下面是完整的 trait 定义及各部分的作用：

```rust
pub trait Tool: Send + Sync {
    /// 工具名称，LLM 通过此名称识别和调用工具
    const NAME: &'static str;

    /// 工具接受的输入参数类型
    /// 需要实现 Deserialize（从 LLM 的 JSON 输出反序列化）
    /// 和 Serialize（序列化为参数 schema 供 LLM 理解）
    type Args: for<'a> Deserialize<'a> + Serialize + Send;

    /// 工具可能返回的错误类型
    type Error: std::error::Error + Send + Sync;

    /// 工具的输出类型
    /// 需要实现 Serialize（序列化后回传给 LLM）
    type Output: Serialize;

    /// 返回工具的定义信息（名称、描述、参数 schema）
    /// 这些信息会包含在发送给 LLM 的 prompt 中
    async fn definition(&self, prompt: String) -> ToolDefinition;

    /// 实际执行工具逻辑
    /// 框架收到 LLM 的工具调用请求后，会调用此方法
    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error>;
}
```

### 自定义工具的模板

如果你要实现自己的工具，可以参考以下模板：

```rust
use rig::{completion::ToolDefinition, tool::Tool};
use serde::{Deserialize, Serialize};

// 1. 工具结构体
#[derive(Deserialize, Serialize)]
pub struct MyTool;

// 2. 参数类型
#[derive(Debug, Deserialize, Serialize)]
pub struct MyToolArgs {
    // 定义你的参数字段
    pub query: String,
}

// 3. 输出类型
#[derive(Debug, Serialize)]
pub struct MyToolOutput {
    pub result: String,
}

// 4. 错误类型
#[derive(Debug, thiserror::Error)]
#[error("工具执行失败")]
pub struct MyToolError;

// 5. 实现 Tool trait
impl Tool for MyTool {
    const NAME: &'static str = "my_tool";
    type Args = MyToolArgs;
    type Error = MyToolError;
    type Output = MyToolOutput;

    async fn definition(&self, _prompt: String) -> ToolDefinition {
        ToolDefinition {
            name: Self::NAME.to_string(),
            description: "描述你的工具功能".to_string(),
            parameters: serde_json::to_value(MyToolArgs {
                query: "参数说明".to_string(),
            }).unwrap(),
        }
    }

    async fn call(&self, args: Self::Args) -> Result<Self::Output, Self::Error> {
        // 实现你的业务逻辑
        Ok(MyToolOutput {
            result: format!("处理结果: {}", args.query),
        })
    }
}
```

---

## 与前两篇文章的关系

回顾我们的系列文章，三者串联起了 Rust AI 应用开发的完整能力谱：

```
Rust Agent 入门（基础对话）
    ↓ 加入知识库检索
Rust RAG 入门（检索增强生成）
    ↓ 加入工具调用
Rust Tool Call 入门（工具调用）← 你在这里
    ↓ 三者组合
全能 AI Agent = 对话 + 知识检索 + 工具执行
```

| 能力 | 实现方式 | 解决的问题 |
|------|---------|-----------|
| 基础对话 | Agent + preamble | LLM 按角色设定回答 |
| 知识增强 | RAG + 向量检索 | 让 LLM 基于私有文档回答 |
| 工具调用 | Tool Call | 让 LLM 执行实际操作 |

在实际项目中，这三种能力经常组合使用。比如一个客服 Agent 可以同时：

- 用 **RAG** 检索产品文档回答用户问题
- 用 **Tool Call** 查询订单状态、提交工单
- 用 **对话能力** 进行自然流畅的交互

---

## 总结

本文我们深入介绍了 Tool Call 的核心原理，并用 Rust + rig-core + Ollama 实现了一个支持多工具调用的 AI Agent。

**核心要点回顾：**

- **Tool Call** 让 LLM 从"纯文本生成"进化为"能调用外部函数"的智能体，极大扩展了 AI 的应用边界。
- **工作流程**：工具注册 → LLM 意图识别 → 工具执行 → 结果整合，rig-core 框架封装了整个流程，开发者只需实现 `Tool` trait。
- **模型选择很重要**：不是所有模型都支持 Tool Call，推理模型（如 deepseek-r1）不支持，需要选择 qwen2.5、llama3.1 等支持 function calling 的模型。
- **rig-core 的 Tool trait** 设计简洁强大：通过 Rust 的类型系统，参数和返回值都有编译期检查，比动态语言的实现更安全可靠。

至此，我们的 Rust AI 三部曲——**Agent 对话、RAG 检索、Tool Call 调用**——已经全部完成。掌握了这三大核心能力，你就拥有了用 Rust 构建生产级 AI 应用的完整工具箱。接下来，尝试将它们组合起来，打造属于你自己的全能 AI Agent 吧！
