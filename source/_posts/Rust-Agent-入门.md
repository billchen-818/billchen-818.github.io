---
title: Rust Agent 入门
date: 2026-03-12 10:44:35
tags: Rust
---

AI Agent 是当下最火的技术方向之一，但大多数教程都在用 Python。其实 Rust 生态中已经有了成熟的 Agent 框架——`rig-core`，它让我们可以用 Rust 的高性能和类型安全优势来构建 AI 智能体。本文将带你从零开始，使用 rig-core + 本地 Ollama 模型，用不到 20 行 Rust 代码跑通你的第一个 AI Agent。

## rig-core介绍

`rig-core` 是 Rust 生态中一个用于构建 LLM 应用和 AI Agent 的开源框架，由 [Rig](https://github.com/0xPlaygrounds/rig) 项目提供。它的设计目标是让 Rust 开发者能够以类型安全、高性能的方式快速集成大语言模型能力。

### 核心特性

- **多模型支持**：内置对 OpenAI、Anthropic、Cohere、Google Gemini 等主流模型提供商的支持，同时兼容任何 OpenAI API 格式的服务（如本地 Ollama）。
- **统一抽象层**：通过 `CompletionModel` 和 `EmbeddingModel` 等 trait，将不同模型提供商统一到相同的接口下，切换模型只需改一行代码。
- **Agent 构建**：支持为 Agent 设定系统提示词（preamble）、挂载工具（Tool）、配置上下文，轻松构建具备自主决策和工具调用能力的智能体。
- **Tool 机制**：通过实现 `Tool` trait，可以让 LLM 调用自定义的 Rust 函数，实现搜索、计算、数据库查询等外部能力的集成。
- **RAG 支持**：提供向量存储和文档嵌入的抽象，支持构建检索增强生成（RAG）管道。
- **类型安全**：充分利用 Rust 的类型系统，模型输入输出、工具参数等均有编译期检查，减少运行时错误。
- **异步优先**：基于 `tokio` 异步运行时，天然支持高并发场景。

### 基本用法示例

以下是使用 rig-core 连接本地 Ollama 进行简单对话的代码骨架：

```rust
use rig::providers::openai;

#[tokio::main]
async fn main() {
    // 创建一个兼容 OpenAI 接口的客户端，指向本地 Ollama
    let client = openai::Client::from_url("http://localhost:11434/v1", "ollama");

    // 使用本地模型构建一个 Agent
    let agent = client
        .agent("deepseek-r1:8b")
        .preamble("你是一个有帮助的AI助手，请用中文回答。")
        .build();

    // 发送 prompt 并获取回复
    let response = agent.prompt("请介绍一下Rust语言").await.unwrap();
    println!("{}", response);
}
```

### 添加依赖

在 `Cargo.toml` 中添加：

```toml
[dependencies]
anyhow = "1.0.102"
rig-core = "0.32.0"
serde = { version = "1.0.228", features = ["serde_derive"] }
tokio = { version = "1.50.0", features = ["macros", "rt", "rt-multi-thread"] }
```

rig-core 的 API 设计简洁直观，配合 Rust 的安全性和性能优势，非常适合用来构建生产级别的 AI Agent 应用。接下来我们先在本地部署 Ollama，然后用 rig-core 编写实际的测试代码。

## 本地部署ollama

Ollama 是一个开源的本地大语言模型运行框架，它让你可以在自己的电脑上轻松运行各种开源 LLM（如 Llama、Mistral、Gemma、Qwen 等），无需依赖云端 API，数据完全留在本地，兼顾隐私与便捷。

### Ollama 的核心特点

- **一键部署**：通过简单的命令行即可下载并运行模型，例如 `ollama run llama3` 就能启动 Llama 3 模型进行对话。
- **本地运行**：所有推理计算都在本地完成，不需要联网，适合对数据隐私有要求的场景。
- **兼容 OpenAI API**：Ollama 默认在 `http://localhost:11434` 提供 REST API 服务，接口格式兼容 OpenAI Chat Completions API，因此大多数支持 OpenAI 的客户端库（包括 rig-core）都可以直接对接。
- **跨平台支持**：支持 macOS、Linux 和 Windows，且对 Apple Silicon（M 系列芯片）的 GPU 加速有良好支持。
- **丰富的模型库**：内置模型仓库，支持数百个开源模型，涵盖对话、代码生成、嵌入等多种任务。

### 安装 Ollama

macOS 上可以直接通过官网或 Homebrew 安装：

```bash
# 方式一：官网下载安装包
# 访问 https://ollama.com 下载 macOS 版本

# 方式二：Homebrew 安装
brew install ollama
```

### 下载并运行模型

安装完成后，使用 `ollama run` 命令即可拉取模型并启动交互式对话：

```bash
# 运行 deepseek-r1:8b 模型（首次会自动下载）
ollama run deepseek-r1:8b

# 查看本地已下载的模型列表
ollama list
```

![图片](/img/ollama-run.png)

### 以服务方式启动

如果你需要通过 API 调用模型（我们后面的 Rust 代码就是这种方式），需要确保 Ollama 服务正在运行：

```bash
# 启动 Ollama 服务（macOS 安装后通常会自动在后台运行）
ollama serve
```

服务启动后，可以通过 `curl` 验证：

```bash
curl http://localhost:11434/api/generate -d '{
  "model": "deepseek-r1:8b",
  "prompt": "你好",
  "stream": false
}'
```

![DeepSeek 模型调用示例](/img/deep-seek.png)

## 项目搭建


我们新建cargo new agent-demo项目。

### 示例代码实现

新建一个examples目录，我们只在examples中写测试代码。

在examples里面新建文件`my_agent.rs`，在里面添加下面代码：

```rust
use anyhow::Result;
use rig::{
    client::{CompletionClient, Nothing},
    completion::Prompt,
    providers::ollama,
};

#[tokio::main]
async fn main() -> Result<()> {
    let client = ollama::Client::new(Nothing)?;
    let agent = client
        .agent("deepseek-r1:8b")
        .preamble("你是一个专业的 Rust 编程助手。")
        .build();

    let response = agent.prompt("如何优化 Rust 的内存占用？").await.unwrap();

    println!("Agent: {}", response);
    Ok(())
}
```

在Cargo.toml中添加下面依赖：

```
anyhow = "1.0.102"
rig-core = "0.32.0"
serde = { version = "1.0.228", features = ["serde_derive"] }
tokio = { version = "1.50.0", features = ["macros", "rt", "rt-multi-thread"] }
```

#### 运行示例测试

```
cargo run --example my_agent
``` 

![Rust Agent 示例一](/img/example1.png)

![Rust Agent 示例二](/img/example2.png)

![Rust Agent 示例三](/img/example3.png)

### 修改命令传参

我们再把代码修改下，移到main.rs中，如下：

```rust
use anyhow::Result;
use rig::{
    client::{CompletionClient, Nothing},
    completion::Prompt,
    providers::ollama,
};
use std::env;

#[tokio::main]
async fn main() -> Result<()> {
    let question = env::args()
        .nth(1)
        .expect("请提供一个问题作为命令行参数，例如: cargo run -- \"你的问题\"");

    let client = ollama::Client::new(Nothing)?;
    let agent = client
        .agent("deepseek-r1:8b")
        .preamble("你是一个专业的 Rust 编程助手。")
        .build();

    let response = agent.prompt(&question).await.unwrap();

    println!("Agent: {}", response);
    Ok(())
}
```

测试下：

```
cargo run -- "Rust中Copy是啥？"
```

模型回复：

![Rust Agent 运行结果一](/img/copy1.png)

![Rust Agent 运行结果二](/img/copy2.png)

## 总结

本文我们从零完成了一个 Rust AI Agent 的搭建，整个过程可以归纳为三步：

1. **认识 rig-core**：了解了这个 Rust Agent 框架的核心特性——多模型支持、统一接口抽象、类型安全、异步优先，它让 Rust 开发者也能便捷地构建 AI 应用。
2. **本地部署 Ollama**：在本地安装并运行了 deepseek-r1:8b 模型，通过兼容 OpenAI 的 API 接口为后续代码提供推理服务。
3. **编写 Agent 代码**：仅用不到 20 行 Rust 代码，就实现了与本地大模型的对话交互，并进一步支持了命令行传参的灵活调用方式。

可以看到，借助 rig-core + Ollama 的组合，用 Rust 开发 AI Agent 的门槛并不高。而 Rust 带来的内存安全、高性能和零成本抽象，使其在构建生产级 Agent 服务时具备天然优势。

当然，本文只是入门的第一步。rig-core 还支持 **Tool 调用**（让 LLM 执行自定义函数）、**RAG**（检索增强生成）、**多轮对话**等高级能力，后续文章我们会继续深入探索。

如果你对 Rust + AI 感兴趣，不妨动手跑一跑，欢迎在评论区交流你的实践心得！
