---
title: Rust RAG实战
date: 2026-03-13 15:30:26
tags: AI
---

你有没有遇到过这样的场景：你让 AI 回答一个关于你公司内部文档的问题，它却一本正经地胡说八道？大语言模型（LLM）虽然强大，但它的知识是"冻结"在训练数据里的，对你的私有数据一无所知。**RAG（Retrieval-Augmented Generation，检索增强生成）** 正是解决这个问题的利器——它让 AI 先"查资料"，再"回答问题"，从根本上消除幻觉、打通私有知识库。

本文将带你从零理解 RAG 的核心原理，并使用 Rust + rig-core + Ollama，在本地构建一个能读懂 PDF 文档的 RAG 系统。

---

## 什么是 RAG？

RAG（Retrieval-Augmented Generation）是一种将 **信息检索** 与 **文本生成** 相结合的 AI 架构模式。简单来说：

> **RAG = 检索（Retrieval）+ 生成（Generation）**

传统的 LLM 对话流程是：

```
用户提问 → LLM 根据训练知识生成回答
```

RAG 的对话流程是：

```
用户提问 → 从知识库中检索相关文档片段 → 将检索结果作为上下文注入 LLM → LLM 结合上下文生成回答
```

### 为什么需要 RAG？

| 问题 | 纯 LLM | RAG |
|------|--------|-----|
| 知识时效性 | 受限于训练数据截止日期 | 可随时更新知识库 |
| 私有数据 | 完全不了解 | 可接入企业内部文档 |
| 幻觉问题 | 容易编造事实 | 基于真实文档回答，可溯源 |
| 成本 | 微调模型成本高昂 | 无需微调，只需维护文档库 |

一句话总结：**RAG 让 LLM 从"凭记忆答题"变成了"开卷考试"。**

---

## RAG 的核心架构

一个完整的 RAG 系统包含两个阶段：**离线索引阶段** 和 **在线查询阶段**。

### 离线索引阶段（Indexing）

这个阶段的目标是将你的文档数据预处理好，存入向量数据库，供后续检索使用。

```
原始文档（PDF/TXT/HTML/...）
    ↓
文档解析（提取纯文本）
    ↓
文本分块（Chunking）
    ↓
向量化（Embedding）
    ↓
存入向量数据库（Vector Store）
```

### 在线查询阶段（Querying）

用户提问时，系统实时检索最相关的文档片段，注入给 LLM 生成答案。

```
用户提问
    ↓
问题向量化（Embedding）
    ↓
在向量数据库中检索最相似的文档片段（Top-K）
    ↓
将问题 + 检索到的文档片段一起发送给 LLM
    ↓
LLM 生成基于上下文的回答
```

---

## Embedding（向量嵌入）原理

Embedding 是 RAG 的核心技术之一，理解它对掌握整个 RAG 流程至关重要。

### 什么是 Embedding？

Embedding 是一种将文本（单词、句子、段落）映射为 **高维空间中的稠密向量** 的技术。简单说，就是把人类语言翻译成计算机能理解和比较的数字列表。

例如：

```
"Rust 是一门系统编程语言" → [0.12, -0.45, 0.78, 0.33, ..., -0.21]  （维度可能是768或更高）
"Rust 注重内存安全"      → [0.15, -0.42, 0.75, 0.30, ..., -0.19]  （语义相近，向量也接近）
"今天天气真好"           → [0.88, 0.12, -0.56, 0.01, ..., 0.67]  （语义不同，向量差异大）
```

### Embedding 的核心原理

1. **语义编码**：Embedding 模型（如 `nomic-embed-text`、OpenAI 的 `text-embedding-3-small`）通过在海量文本上训练，学会了将语义相似的文本映射到向量空间中相近的位置。

2. **相似度计算**：两个向量的相似程度通常用 **余弦相似度（Cosine Similarity）** 来衡量：

$$\text{similarity}(\vec{A}, \vec{B}) = \frac{\vec{A} \cdot \vec{B}}{|\vec{A}| \times |\vec{B}|}$$

值域为 $[-1, 1]$，越接近 1 表示越相似。

3. **向量检索**：当用户提问时，先将问题转化为向量，然后在向量数据库中用相似度算法（如 ANN，近似最近邻）找到最接近的文档片段。这就是 RAG 中"检索"步骤的数学本质。

### 为什么不直接用关键词搜索？

关键词搜索是精确匹配，而 Embedding 是语义匹配：

| 搜索方式 | 查询："如何让程序更安全" |
|---------|------------------------|
| 关键词搜索 | 只能匹配包含"安全"这个词的文档 |
| 向量检索 | 能匹配到"内存安全"、"类型系统"、"所有权模型"等语义相关的内容 |

这就是为什么 RAG 系统普遍使用 Embedding + 向量检索，而不是简单的全文搜索。

---

## 文本分块（Chunking）策略

在做 Embedding 之前，需要将长文档切分成合适大小的块。分块策略直接影响检索质量。

### 为什么要分块？

- **模型限制**：Embedding 模型对输入长度有限制，不能把整本书一次性喂进去。
- **检索精度**：块太大，检索到的内容噪声多；块太小，上下文不完整。
- **LLM 上下文窗口**：检索到的片段最终要拼入 LLM 的 prompt，上下文窗口有限。

### 常见分块策略

| 策略 | 说明 | 适用场景 |
|------|------|----------|
| 固定大小分块 | 按字符数/Token 数切分 | 通用场景 |
| 段落分块 | 按段落（`\n\n`）分割 | 结构良好的文档 |
| 语义分块 | 根据语义相似度边界切分 | 高质量检索需求 |
| 递归分块 | 先按大粒度分，再逐层细分 | 复杂文档 |

本项目采用的是 **段落分块 + 字符数上限** 的策略：

```rust
fn split_into_chunks(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for para in text.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        if current.len() + para.len() + 2 > max_chars && !current.is_empty() {
            chunks.push(current.clone());
            current.clear();
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(para);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}
```

这段代码按双换行符（段落边界）分割文本，同时确保每个块不超过 `max_chars` 个字符（本项目设为 500）。

---

## 用 Rust 构建 RAG 系统实战

了解了原理，我们来看看如何用 Rust 实现一个完整的 RAG 系统。

### 技术栈

| 组件 | 选择 | 说明 |
|------|------|------|
| 语言 | Rust | 高性能、类型安全 |
| LLM 框架 | rig-core | Rust 生态的 AI Agent 框架 |
| LLM 模型 | deepseek-r1:8b | 本地运行，通过 Ollama 提供服务 |
| Embedding 模型 | nomic-embed-text | 开源嵌入模型，Ollama 直接支持 |
| 向量存储 | InMemoryVectorStore | rig-core 内置的内存向量存储 |
| 文档解析 | pdf-extract | Rust PDF 文本提取库 |

### 前置准备

确保本地已安装并运行 Ollama，并拉取所需模型：

```bash
# 拉取 LLM 模型
ollama pull deepseek-r1:8b

# 拉取 Embedding 模型
ollama pull nomic-embed-text
```

### 项目依赖

`Cargo.toml` 中的依赖配置：

```toml
[dependencies]
anyhow = "1.0.102"
pdf-extract = "0.10.0"
rig-core = "0.32.0"
tokio = { version = "1.50.0", features = ["rt", "macros", "rt-multi-thread"] }
tracing-subscriber = "0.3"
tracing = "0.1"
```

### 完整代码解析

下面是本项目 `main.rs` 的完整实现，我们逐步拆解：

#### 第一步：解析 PDF 文档

```rust
use pdf_extract::extract_text;

fn parse_pdf(file_path: &str) -> Result<String> {
    let text = extract_text(file_path)?;
    Ok(text)
}
```

使用 `pdf-extract` 库从 PDF 文件中提取纯文本。这是整个 RAG 流程的起点——将非结构化文档转化为可处理的文本。

#### 第二步：文本分块

```rust
let content = parse_pdf(file_path)?;
let chunks = split_into_chunks(&content, 500);
```

将提取的文本按段落分块，每块不超过 500 个字符。

#### 第三步：生成 Embedding 并存入向量存储

```rust
let embedding_model = ollama_client.embedding_model("nomic-embed-text");
let mut builder = EmbeddingsBuilder::new(embedding_model.clone());
for chunk in &chunks {
    builder = builder.document(chunk.clone())?;
}
let embeddings = builder.build().await?;

let vector_store = InMemoryVectorStore::from_documents(embeddings);
let index = vector_store.index(embedding_model);
```

这几行代码完成了三件事：
1. 使用 Ollama 的 `nomic-embed-text` 模型将每个文本块转化为向量。
2. 将所有向量存入内存向量存储。
3. 创建索引，供后续检索使用。

#### 第四步：构建 RAG Agent 并启动交互

```rust
let rag_agent = ollama_client
    .agent("deepseek-r1:8b")
    .preamble("您是一位乐于助人的助手，能够根据 PDF 文档中提供的上下文回答问题。")
    .dynamic_context(2, index)
    .build();

let bot = ChatBotBuilder::new().agent(rag_agent).build();
bot.run().await?;
```

关键在于 `.dynamic_context(2, index)` 这一行——它告诉 Agent：每次回答问题前，先从向量索引中检索最相关的 **2 个** 文档片段，作为上下文注入到 prompt 中。这就是 RAG 的核心机制。

### 运行效果

```bash
cargo run
```

系统启动后会：
1. 解析指定的 PDF 文件
2. 将文本分块并生成 Embedding
3. 进入交互式聊天模式，你可以针对 PDF 内容提问

---

## RAG 系统的优化方向

一个基础的 RAG 系统跑通后，还有很多可以优化的方向：

| 优化方向 | 说明 |
|---------|------|
| **分块策略优化** | 尝试语义分块、滑动窗口分块等更精细的策略 |
| **混合检索** | 结合向量检索 + BM25 关键词检索，提高召回率 |
| **重排序（Reranking）** | 对检索结果用交叉编码器重新打分，提升精度 |
| **持久化向量存储** | 从内存存储切换到 Qdrant、Milvus 等专业向量数据库 |
| **多文档格式支持** | 扩展支持 Word、HTML、Markdown 等更多格式 |
| **元数据过滤** | 为文档添加元数据（来源、时间），支持过滤检索 |
| **对话记忆** | 加入多轮对话上下文管理，提升交互体验 |

---

## 总结

本文从 RAG 的核心概念出发，深入介绍了 Embedding 向量嵌入原理、文本分块策略，以及完整的 RAG 系统架构，并用 Rust + rig-core + Ollama 在本地实现了一个能读懂 PDF 的 RAG 系统。

**核心要点回顾：**

- **RAG** 通过"先检索，再生成"的模式，让 LLM 能基于你的私有数据回答问题，有效减少幻觉。
- **Embedding** 将文本映射为高维向量，使得语义相似的内容在向量空间中距离相近，是实现语义检索的基础。
- **文本分块** 是连接文档和 Embedding 的桥梁，分块质量直接影响检索效果。
- **rig-core** 为 Rust 开发者提供了简洁而强大的 RAG 构建能力，从 Embedding 到向量存储到 Agent 构建，一站式搞定。

RAG 不是终点，而是 LLM 应用落地的起点。掌握了 RAG 的原理和实现，你就拥有了将 AI 能力与任何私有知识库深度融合的钥匙。接下来，不妨试试用自己的文档跑一遍，亲手感受"让 AI 开卷考试"的魅力吧！
