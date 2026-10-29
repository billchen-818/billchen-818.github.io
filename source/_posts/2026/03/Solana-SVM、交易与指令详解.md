---
title: Solana SVM、交易与指令详解
date: 2026-03-03 15:48:28
tags: Solana
---

> Solana 之所以能实现极高的吞吐量和亚秒级确认，背后的核心引擎就是 **SVM（Solana Virtual Machine）**。本文将从 SVM 架构出发，深入讲解 Solana 的交易（Transaction）结构、指令（Instruction）机制、交易生命周期，并配合大量代码示例和图解，帮助初学者从零到精通 Solana 的交易系统。

---

## 一、SVM（Solana Virtual Machine）概述

### 1.1 什么是 SVM？

**SVM（Solana Virtual Machine）** 是 Solana 区块链的执行引擎，负责处理和执行链上的所有交易与智能合约（Program）。它类似于以太坊的 EVM（Ethereum Virtual Machine），但在架构设计上有着本质区别。

```
┌──────────────────────────────────────────────────────────────┐
│                    Solana 区块链架构                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   用户/DApp ──► 交易（Transaction）──► 验证节点（Validator）    │
│                                           │                  │
│                                    ┌──────▼──────┐           │
│                                    │    SVM      │           │
│                                    │  执行引擎    │           │
│                                    │             │           │
│                                    │ ┌─────────┐ │           │
│                                    │ │ BPF/SBF │ │           │
│                                    │ │ Runtime  │ │           │
│                                    │ └─────────┘ │           │
│                                    │ ┌─────────┐ │           │
│                                    │ │ Sealevel│ │           │
│                                    │ │ 并行引擎 │ │           │
│                                    │ └─────────┘ │           │
│                                    │ ┌─────────┐ │           │
│                                    │ │ Bank    │ │           │
│                                    │ │ 状态管理 │ │           │
│                                    │ └─────────┘ │           │
│                                    └─────────────┘           │
│                                           │                  │
│                                    ┌──────▼──────┐           │
│                                    │  账户存储    │           │
│                                    │ AccountsDB  │           │
│                                    └─────────────┘           │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 SVM 核心组件

| 组件 | 功能 | 说明 |
|------|------|------|
| **BPF/SBF Runtime** | 字节码执行 | 执行编译后的智能合约（eBPF → SBF） |
| **Sealevel** | 并行执行引擎 | 支持数千笔交易并行处理 |
| **Bank** | 状态管理 | 管理账户状态、余额、Slot 信息 |
| **AccountsDB** | 持久化存储 | 高性能账户数据持久化 |
| **Transaction Processor** | 交易处理器 | 验证签名、扣费、调度执行 |

### 1.3 SVM vs EVM 对比

```
┌─────────────────────────┬───────────────────────┐
│       SVM (Solana)      │      EVM (Ethereum)   │
├─────────────────────────┼───────────────────────┤
│  基于 BPF/SBF 字节码     │  基于 EVM 字节码       │
│  支持并行执行（Sealevel） │  串行执行              │
│  程序与数据分离           │  合约 = 代码 + 数据    │
│  账户模型驱动            │  合约驱动              │
│  编译型（Rust/C）        │  Solidity/Vyper       │
│  计算单元（CU）计量       │  Gas 计量             │
│  65,000 TPS+            │  ~15-30 TPS           │
│  ~400ms 出块             │  ~12s 出块             │
│  状态需预声明             │  状态动态访问          │
└─────────────────────────┴───────────────────────┘
```

### 1.4 SVM 并行执行原理 —— Sealevel

Sealevel 是 Solana 实现高吞吐量的秘密武器。它通过分析每笔交易**声明的账户读写集**，判断哪些交易可以并行执行。

```
                        交易池 (Transaction Pool)
                    ┌────┬────┬────┬────┬────┬────┐
                    │ T1 │ T2 │ T3 │ T4 │ T5 │ T6 │
                    └─┬──┴─┬──┴─┬──┴─┬──┴─┬──┴──┬─┘
                      │    │    │    │    │     │
              ┌───────▼────▼────┼────┼────▼─────┤
              │  账户依赖分析    │    │          │
              │  (Sealevel)     │    │          │
              └───────┬─────────┘    │          │
                      │              │          │
          ┌───────────▼───┐  ┌──────▼──┐  ┌───▼────────┐
          │   并行批次 1   │  │ 批次 2   │  │  批次 3    │
          │               │  │         │  │            │
          │  T1: 读A,写B  │  │ T3:写A  │  │ T5: 读C    │
          │  T2: 读C,写D  │  │ T4:读A  │  │ T6: 写E    │
          │  (无冲突,并行)  │  │(依赖A)  │  │(无冲突)    │
          └───────────────┘  └─────────┘  └────────────┘
                  │                │              │
                  ▼                ▼              ▼
          ┌──────────────────────────────────────────┐
          │        CPU 核心并行执行                     │
          │   Core1: T1    Core2: T2                  │
          │   然后 Core1: T3  Core2: T4               │
          │   然后 Core1: T5  Core2: T6               │
          └──────────────────────────────────────────┘
```

**并行规则**：
- 如果两笔交易**不涉及相同的可写账户**，它们可以并行执行
- 只读账户可以被多笔交易同时访问
- 这就是为什么 Solana 交易必须**预先声明**所有要访问的账户

> **关键理解**：Solana 要求交易提前声明账户列表，不是为了限制开发者，而是为了让 Sealevel 能分析依赖关系、实现大规模并行。

---

## 二、交易（Transaction）结构详解

### 2.1 交易全景图

一笔 Solana 交易由 **签名（Signatures）** 和 **消息（Message）** 两大部分组成：

```
┌──────────────────────────────────────────────────────────┐
│                  Solana Transaction                       │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Signatures (签名数组)                   │  │
│  │  ┌──────────┐ ┌──────────┐                         │  │
│  │  │ Sig #1   │ │ Sig #2   │  ...                    │  │
│  │  │ (64字节)  │ │ (64字节)  │                         │  │
│  │  └──────────┘ └──────────┘                         │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │              Message (消息体)                       │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │          Message Header (消息头)              │  │  │
│  │  │  • num_required_signatures: u8               │  │  │
│  │  │  • num_readonly_signed_accounts: u8          │  │  │
│  │  │  • num_readonly_unsigned_accounts: u8        │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │      Account Keys (账户公钥数组)              │  │  │
│  │  │  [Pubkey1, Pubkey2, Pubkey3, ...]            │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │      Recent Blockhash (最近区块哈希)           │  │  │
│  │  │  用于防重放 & 交易过期（~60秒有效期）           │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  │                                                    │  │
│  │  ┌──────────────────────────────────────────────┐  │  │
│  │  │      Instructions (指令数组)                  │  │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌──────────┐     │  │  │
│  │  │  │ Instr #1 │ │ Instr #2 │ │ Instr #3 │     │  │  │
│  │  │  └──────────┘ └──────────┘ └──────────┘     │  │  │
│  │  └──────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 2.2 交易的 Rust 数据结构

```rust
// Solana SDK 中的 Transaction 定义
pub struct Transaction {
    /// 签名列表，与 message.account_keys 中需要签名的账户一一对应
    pub signatures: Vec<Signature>,
    
    /// 交易消息体
    pub message: Message,
}

pub struct Message {
    /// 消息头，描述账户权限分布
    pub header: MessageHeader,
    
    /// 所有涉及的账户公钥（有严格排序规则）
    pub account_keys: Vec<Pubkey>,
    
    /// 最近的区块哈希（防止重放攻击）
    pub recent_blockhash: Hash,
    
    /// 指令列表（按顺序执行）
    pub instructions: Vec<CompiledInstruction>,
}

pub struct MessageHeader {
    /// 需要签名的账户数量
    pub num_required_signatures: u8,
    
    /// 需要签名但只读的账户数量
    pub num_readonly_signed_accounts: u8,
    
    /// 不需要签名且只读的账户数量
    pub num_readonly_unsigned_accounts: u8,
}
```

### 2.3 Account Keys 排序规则

交易中的账户列表有严格的排序规则，这对理解交易结构非常重要：

```
Account Keys 数组排列顺序：

索引:  0        1        2        3        4        5
     ┌────────┬────────┬────────┬────────┬────────┬────────┐
     │ 签名者  │ 签名者  │ 签名者  │ 非签名  │ 非签名  │ 非签名  │
     │ 可写   │ 可写    │ 只读   │ 可写    │ 只读   │ 只读    │
     └────────┴────────┴────────┴────────┴────────┴────────┘
     ◄── 需签名 & 可写 ──►◄ 签名只读►◄─ 无需签名可写 ─►◄ 只读 ──►

     header.num_required_signatures = 3   (前3个需要签名)
     header.num_readonly_signed = 1       (签名者中1个只读，即索引2)
     header.num_readonly_unsigned = 2     (非签名者中2个只读，即索引4,5)

     Fee Payer = account_keys[0]  （第一个账户始终是手续费支付者）
```

### 2.4 Recent Blockhash 与交易有效期

```
┌─────────────────────────────────────────────────────────┐
│              Recent Blockhash 机制                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Slot 100    Slot 101    Slot 102   ...   Slot 250     │
│  ┌──────┐   ┌──────┐   ┌──────┐         ┌──────┐      │
│  │Block │──►│Block │──►│Block │──► ···──►│Block │      │
│  │Hash_A│   │Hash_B│   │Hash_C│         │Hash_X│      │
│  └──────┘   └──────┘   └──────┘         └──────┘      │
│                                                         │
│  交易使用 Hash_A 作为 recent_blockhash                    │
│                                                         │
│  ✅ Slot 100-250: 交易有效（约 60-90 秒）                 │
│  ❌ Slot 251+:    交易过期，自动丢弃                      │
│                                                         │
│  作用：                                                  │
│  1. 防止重放攻击（同一交易不能被提交两次）                   │
│  2. 交易自动过期（无需手动取消）                           │
│  3. 节点只需保留最近 ~150 个 blockhash                    │
└─────────────────────────────────────────────────────────┘
```

### 2.5 交易大小限制

```
┌─────────────────────────────────────────────────────┐
│         Solana 交易大小限制: 1232 字节                │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Signatures:  64 bytes × N 个签名者                  │
│  Header:      3 bytes                               │
│  Account Keys: 32 bytes × M 个账户                   │
│  Blockhash:   32 bytes                              │
│  Instructions: 可变大小                              │
│                                                     │
│  ───────────────────────────────────────────────     │
│  总计 ≤ 1232 bytes (IPv6 MTU)                       │
│                                                     │
│  实际约束：                                          │
│  • 最多约 30-35 个账户                               │
│  • 单笔交易最多包含的指令数量有限                      │
│  • 超出限制需要使用 Versioned Transaction             │
│    或 Address Lookup Table (ALT)                    │
└─────────────────────────────────────────────────────┘
```

---

## 三、指令（Instruction）结构详解

### 3.1 指令是什么？

**指令（Instruction）** 是 Solana 交易中的最小执行单元。一笔交易可以包含一条或多条指令，每条指令告诉一个特定的程序（Program）去做一件事。

```
┌──────────────────────────────────────────────────────┐
│                   Instruction（指令）                  │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─────────────────────┐                             │
│  │  program_id          │  要调用哪个程序？             │
│  │  (Pubkey)           │  例: Token Program          │
│  └─────────────────────┘                             │
│                                                      │
│  ┌─────────────────────┐                             │
│  │  accounts            │  需要操作哪些账户？           │
│  │  (Vec<AccountMeta>) │  包含读/写、签名权限          │
│  └─────────────────────┘                             │
│                                                      │
│  ┌─────────────────────┐                             │
│  │  data                │  传什么参数给程序？           │
│  │  (Vec<u8>)          │  序列化后的指令数据           │
│  └─────────────────────┘                             │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### 3.2 指令的 Rust 数据结构

```rust
/// 用户构建交易时使用的 Instruction
pub struct Instruction {
    /// 要调用的程序的公钥
    pub program_id: Pubkey,
    
    /// 该指令涉及的账户列表（含权限信息）
    pub accounts: Vec<AccountMeta>,
    
    /// 指令数据（序列化后的参数）
    pub data: Vec<u8>,
}

/// 账户元信息 —— 描述每个账户的权限
pub struct AccountMeta {
    /// 账户公钥
    pub pubkey: Pubkey,
    
    /// 是否需要签名
    pub is_signer: bool,
    
    /// 是否可写
    pub is_writable: bool,
}

// AccountMeta 的便捷构造方法
impl AccountMeta {
    /// 可写 + 需签名
    pub fn new(pubkey: Pubkey, is_signer: bool) -> Self {
        Self { pubkey, is_signer, is_writable: true }
    }
    
    /// 只读 + 需签名/不需签名
    pub fn new_readonly(pubkey: Pubkey, is_signer: bool) -> Self {
        Self { pubkey, is_signer, is_writable: false }
    }
}
```

### 3.3 CompiledInstruction（编译后的指令）

在交易内部，指令以压缩形式存储（使用索引而非完整公钥）：

```rust
/// 交易 Message 中实际存储的编译后指令
pub struct CompiledInstruction {
    /// program_id 在 account_keys 数组中的索引
    pub program_id_index: u8,
    
    /// 各账户在 account_keys 数组中的索引列表
    pub accounts: Vec<u8>,
    
    /// 指令数据
    pub data: Vec<u8>,
}
```

```
Instruction → CompiledInstruction 的转换过程：

原始 Instruction:
  program_id: TokenProgram (TProg111...)
  accounts: [
    { pubkey: Alice (AAA...), is_signer: true, is_writable: true },
    { pubkey: Bob   (BBB...), is_signer: false, is_writable: true },
  ]
  data: [3, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0]  // Transfer 1000

                    ║
                    ▼   编译过程（公钥 → 索引）

Transaction.message.account_keys:
  索引 0: Alice   (AAA...)   ← 签名者, 可写, Fee Payer
  索引 1: Bob     (BBB...)   ← 非签名者, 可写
  索引 2: TProg   (TProg...) ← 非签名者, 只读

CompiledInstruction:
  program_id_index: 2        // TokenProgram 在索引 2
  accounts: [0, 1]           // Alice=0, Bob=1
  data: [3, 0, 0, 0, 232, 3, 0, 0, 0, 0, 0, 0]
```

### 3.4 AccountMeta 权限组合

```
┌──────────────────────────────────────────────────────┐
│           AccountMeta 四种权限组合                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────┬───────────┬──────────┬───────────┐ │
│  │   权限组合    │ is_signer │is_writable│  用途     │ │
│  ├──────────────┼───────────┼──────────┼───────────┤ │
│  │ 签名 + 可写   │   true    │   true   │ 付费者    │ │
│  │              │           │          │ 转出方    │ │
│  ├──────────────┼───────────┼──────────┼───────────┤ │
│  │ 签名 + 只读   │   true    │  false   │ 多签中    │ │
│  │              │           │          │ 的授权者  │ │
│  ├──────────────┼───────────┼──────────┼───────────┤ │
│  │ 无签名 + 可写 │  false    │   true   │ 接收方    │ │
│  │              │           │          │ 数据账户  │ │
│  ├──────────────┼───────────┼──────────┼───────────┤ │
│  │ 无签名 + 只读 │  false    │  false   │ 程序ID   │ │
│  │              │           │          │ Sysvar   │ │
│  └──────────────┴───────────┴──────────┴───────────┘ │
└──────────────────────────────────────────────────────┘
```

---

## 四、交易生命周期

### 4.1 交易从构建到确认的完整流程

```
┌──────────────────────────────────────────────────────────────────┐
│                    Solana 交易生命周期                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ① 构建交易 ──► ② 签名 ──► ③ 发送到 RPC ──► ④ 转发到 Leader      │
│                                                                  │
│       ┌──────────────────────────────────────────────────┐       │
│       │                Leader 验证节点                     │       │
│       │                                                  │       │
│       │  ⑤ 签名验证 ──► ⑥ 预检查 ──► ⑦ 加载账户           │       │
│       │                                                  │       │
│       │  ⑧ SVM 执行 ──► ⑨ 记录结果 ──► ⑩ 广播区块         │       │
│       │                                                  │       │
│       └──────────────────────────────────────────────────┘       │
│                                                                  │
│  ⑪ 其他验证节点验证 ──► ⑫ 达到确认级别 ──► ⑬ 最终确定（Finalized）│
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 各阶段详解

```
阶段              说明                                   失败原因
─────────────────────────────────────────────────────────────────────
① 构建交易        创建指令、组装交易                       格式错误
② 签名           用私钥对 Message 签名                    签名不匹配
③ 发送 RPC       通过 sendTransaction 发送               RPC 节点故障
④ 转发 Leader    RPC 转发给当前 Slot 的 Leader            网络延迟
⑤ 签名验证       验证所有签名是否有效                      签名无效
⑥ 预检查         检查 blockhash 是否过期、费用是否足够      blockhash过期
                                                        余额不足
⑦ 加载账户       从 AccountsDB 加载所有声明的账户          账户不存在
⑧ SVM 执行       执行所有指令                             程序错误
                                                        计算超限(CU)
⑨ 记录结果       将交易结果写入区块                        -
⑩ 广播区块       Leader 将区块广播给网络                   -
⑪ 验证确认       其他节点验证区块                          -
⑫ 确认级别       processed → confirmed → finalized       -
⑬ 最终确定       达到 2/3 超级多数确认                     -
```

### 4.3 确认级别（Commitment Levels）

```
┌─────────────────────────────────────────────────────────────┐
│                    确认级别 (Commitment)                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  processed        confirmed          finalized              │
│  ─────────►       ─────────────►     ────────────────►      │
│                                                             │
│  ┌──────────┐     ┌──────────────┐   ┌─────────────────┐   │
│  │ Leader   │     │ 超级多数投票  │   │ 超级多数已root   │   │
│  │ 已处理    │     │ (66%+ stake) │   │  不可回滚        │   │
│  │          │     │              │   │                 │   │
│  │ 速度:最快 │     │ 速度:中等     │   │ 速度:最慢        │   │
│  │ 安全:最低 │     │ 安全:中等     │   │ 安全:最高        │   │
│  │ ~0.5s    │     │ ~5-6s        │   │ ~12-15s         │   │
│  └──────────┘     └──────────────┘   └─────────────────┘   │
│                                                             │
│  推荐使用场景：                                               │
│  • processed  → UI 即时反馈                                  │
│  • confirmed  → 大多数 DApp（默认推荐）                       │
│  • finalized  → 涉及大额资金、交易所充提                      │
└─────────────────────────────────────────────────────────────┘
```

---

## 五、计算预算（Compute Budget）

### 5.1 计算单元（Compute Units, CU）

Solana 使用 **计算单元（CU）** 来度量交易消耗的计算资源，类似以太坊的 Gas。

```
┌─────────────────────────────────────────────────────────┐
│                  计算预算 (Compute Budget)                │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  每笔交易默认：                                           │
│  • 200,000 CU / 指令（默认上限）                          │
│  • 1,400,000 CU / 交易（最大上限）                        │
│                                                         │
│  每个区块：                                               │
│  • 48,000,000 CU / 区块（总上限）                         │
│                                                         │
│  常见操作的 CU 消耗：                                     │
│  ┌────────────────────────┬───────────┐                  │
│  │ 操作                    │ CU 消耗   │                  │
│  ├────────────────────────┼───────────┤                  │
│  │ 创建账户                │ ~3,000    │                  │
│  │ SOL 转账                │ ~450      │                  │
│  │ SPL Token 转账          │ ~4,000    │                  │
│  │ 日志输出 (msg!)         │ ~100/条   │                  │
│  │ SHA256 哈希             │ ~100/64B  │                  │
│  │ 系统调用 (CPI)          │ ~1,000+   │                  │
│  └────────────────────────┴───────────┘                  │
│                                                         │
│  优先费 (Priority Fee)：                                  │
│  price = micro_lamports / CU                            │
│  费用 = price × requested_CU                             │
└─────────────────────────────────────────────────────────┘
```

### 5.2 设置 Compute Budget 指令

```rust
use solana_sdk::compute_budget::ComputeBudgetInstruction;

// 1. 设置计算单元上限（默认 200,000）
let set_cu_limit = ComputeBudgetInstruction::set_compute_unit_limit(300_000);

// 2. 设置优先费（提高交易被打包的优先级）
// 单位: micro-lamports per CU
let set_priority_fee = ComputeBudgetInstruction::set_compute_unit_price(50_000);

// 将 Compute Budget 指令加入交易
let transaction = Transaction::new_signed_with_payer(
    &[
        set_cu_limit,          // 指令 1: 调整 CU 上限
        set_priority_fee,      // 指令 2: 设置优先费
        transfer_instruction,  // 指令 3: 实际业务指令
    ],
    Some(&payer.pubkey()),
    &[&payer],
    recent_blockhash,
);
```

```typescript
import { ComputeBudgetProgram, Transaction } from "@solana/web3.js";

// 设置计算单元上限
const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: 300_000,
});

// 设置优先费（micro-lamports per CU）
const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: 50_000,
});

const transaction = new Transaction()
  .add(modifyComputeUnits)
  .add(addPriorityFee)
  .add(transferInstruction);
```

---

## 六、实战代码示例

### 6.1 SOL 转账 —— 完整示例

#### TypeScript 版本（@solana/web3.js）

```typescript
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

async function transferSOL() {
  // 1. 建立连接
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // 2. 创建发送者钱包（实际项目中从密钥文件加载）
  const sender = Keypair.generate();

  // 3. 空投 2 SOL 到发送者（仅 devnet）
  const airdropSig = await connection.requestAirdrop(
    sender.publicKey,
    2 * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(airdropSig, "confirmed");
  console.log("✅ 空投完成，余额: 2 SOL");

  // 4. 接收者地址
  const receiver = new PublicKey(
    "DemoReceiverAddress1111111111111111111111111"
  );

  // 5. 构建转账指令
  const transferInstruction = SystemProgram.transfer({
    fromPubkey: sender.publicKey,  // 发送者（签名者 + 可写）
    toPubkey: receiver,            // 接收者（可写）
    lamports: 0.5 * LAMPORTS_PER_SOL, // 转账 0.5 SOL
  });

  // 6. 构建交易
  const transaction = new Transaction().add(transferInstruction);

  // 7. 签名并发送交易
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [sender],  // 签名者列表
    { commitment: "confirmed" }
  );

  console.log("✅ 交易成功！");
  console.log("签名:", signature);
  console.log(
    `浏览器查看: https://explorer.solana.com/tx/${signature}?cluster=devnet`
  );
}

transferSOL().catch(console.error);
```

#### Rust 版本（solana-sdk）

```rust
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    native_token::LAMPORTS_PER_SOL,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. 连接到 devnet
    let rpc_url = "https://api.devnet.solana.com".to_string();
    let client = RpcClient::new_with_commitment(
        rpc_url, 
        CommitmentConfig::confirmed()
    );

    // 2. 创建发送者密钥对
    let sender = Keypair::new();
    println!("发送者地址: {}", sender.pubkey());

    // 3. 请求空投（仅 devnet）
    let airdrop_sig = client.request_airdrop(
        &sender.pubkey(), 
        2 * LAMPORTS_PER_SOL
    )?;
    client.confirm_transaction(&airdrop_sig)?;
    println!("✅ 空投 2 SOL 完成");

    // 4. 接收者地址
    let receiver = Keypair::new();
    
    // 5. 构建转账指令
    let transfer_ix = system_instruction::transfer(
        &sender.pubkey(),     // from（签名者 + 可写）
        &receiver.pubkey(),   // to（可写）
        LAMPORTS_PER_SOL / 2, // 0.5 SOL
    );

    // 6. 获取最新 blockhash
    let recent_blockhash = client.get_latest_blockhash()?;

    // 7. 构建并签名交易
    let transaction = Transaction::new_signed_with_payer(
        &[transfer_ix],           // 指令列表
        Some(&sender.pubkey()),   // Fee Payer
        &[&sender],               // 签名者列表
        recent_blockhash,         // 最新 blockhash
    );

    // 8. 发送交易
    let signature = client.send_and_confirm_transaction(&transaction)?;
    println!("✅ 交易成功！签名: {}", signature);

    // 9. 查询结果
    let balance = client.get_balance(&receiver.pubkey())?;
    println!("接收者余额: {} SOL", balance as f64 / LAMPORTS_PER_SOL as f64);

    Ok(())
}
```

### 6.2 多指令交易 —— 批量操作

一笔交易可以包含多条指令，它们**原子性执行**（全部成功或全部回滚）：

```typescript
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

async function multiInstructionTransaction() {
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const payer = Keypair.generate();

  // 空投
  const sig = await connection.requestAirdrop(
    payer.publicKey,
    5 * LAMPORTS_PER_SOL
  );
  await connection.confirmTransaction(sig);

  // 创建 3 个接收者
  const receiver1 = Keypair.generate();
  const receiver2 = Keypair.generate();
  const receiver3 = Keypair.generate();

  // 构建包含多条指令的交易
  const transaction = new Transaction();

  // 指令 1: 设置优先费
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 10_000,
    })
  );

  // 指令 2: 转 1 SOL 给 receiver1
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: receiver1.publicKey,
      lamports: 1 * LAMPORTS_PER_SOL,
    })
  );

  // 指令 3: 转 0.5 SOL 给 receiver2
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: receiver2.publicKey,
      lamports: 0.5 * LAMPORTS_PER_SOL,
    })
  );

  // 指令 4: 转 0.3 SOL 给 receiver3
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: receiver3.publicKey,
      lamports: 0.3 * LAMPORTS_PER_SOL,
    })
  );

  // 原子性发送 —— 4 条指令全部成功或全部回滚
  const txSig = await sendAndConfirmTransaction(
    connection,
    transaction,
    [payer]
  );

  console.log("✅ 批量转账成功:", txSig);
  console.log("Receiver1:", await connection.getBalance(receiver1.publicKey));
  console.log("Receiver2:", await connection.getBalance(receiver2.publicKey));
  console.log("Receiver3:", await connection.getBalance(receiver3.publicKey));
}

multiInstructionTransaction();
```

```
多指令交易执行流程：

Transaction {
  instructions: [
    Instr#1: ComputeBudget::SetPrice(10000),
    Instr#2: SystemProgram::Transfer(payer → R1, 1 SOL),
    Instr#3: SystemProgram::Transfer(payer → R2, 0.5 SOL),
    Instr#4: SystemProgram::Transfer(payer → R3, 0.3 SOL),
  ]
}

SVM 执行：
  ┌─────────────────────────────────────────────┐
  │ 执行 Instr#1 ✅ → 设置优先费参数             │
  │ 执行 Instr#2 ✅ → payer -1 SOL, R1 +1 SOL   │
  │ 执行 Instr#3 ✅ → payer -0.5 SOL, R2 +0.5   │
  │ 执行 Instr#4 ✅ → payer -0.3 SOL, R3 +0.3   │
  │                                             │
  │ 全部成功 → 提交状态变更 ✅                    │
  └─────────────────────────────────────────────┘

如果 Instr#3 失败（如余额不足）：
  ┌─────────────────────────────────────────────┐
  │ 执行 Instr#1 ✅                              │
  │ 执行 Instr#2 ✅                              │
  │ 执行 Instr#3 ❌ → 错误！                     │
  │                                             │
  │ 整笔交易回滚 → 所有变更撤销 ❌                 │
  │ （但仍扣除手续费）                            │
  └─────────────────────────────────────────────┘
```

### 6.3 创建账户并初始化数据 —— 自定义 Program 交互

```rust
use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_instruction,
    transaction::Transaction,
};

/// 自定义程序的数据结构
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct CounterAccount {
    pub count: u64,
    pub authority: Pubkey,
}

/// 自定义程序的指令枚举
#[derive(BorshSerialize, BorshDeserialize)]
pub enum CounterInstruction {
    /// 初始化计数器
    Initialize,
    /// 增加计数
    Increment { amount: u64 },
    /// 减少计数
    Decrement { amount: u64 },
}

fn build_initialize_transaction(
    payer: &Keypair,
    counter_account: &Keypair,
    program_id: &Pubkey,
    recent_blockhash: Hash,
) -> Transaction {
    // 计算存储 CounterAccount 所需的空间
    let space = 8 + 32; // u64(8 bytes) + Pubkey(32 bytes) = 40 bytes
    
    // 计算租金豁免所需的最低余额
    let rent = Rent::default().minimum_balance(space);

    // 指令 1: 创建账户（System Program）
    let create_account_ix = system_instruction::create_account(
        &payer.pubkey(),           // 资金来源（付租金）
        &counter_account.pubkey(), // 新账户地址
        rent,                      // 需要存入的 lamports
        space as u64,              // 数据空间大小
        program_id,                // 新账户的 owner
    );

    // 指令 2: 初始化计数器（自定义 Program）
    let init_data = CounterInstruction::Initialize
        .try_to_vec()
        .unwrap();
    
    let initialize_ix = Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(counter_account.pubkey(), false), // 可写
            AccountMeta::new(payer.pubkey(), true),            // 签名者 + 可写
            AccountMeta::new_readonly(
                solana_sdk::sysvar::rent::id(), false          // Rent sysvar
            ),
        ],
        data: init_data,
    };

    // 构建包含两条指令的交易
    Transaction::new_signed_with_payer(
        &[create_account_ix, initialize_ix],
        Some(&payer.pubkey()),
        &[payer, counter_account], // 两个账户都需要签名
        recent_blockhash,
    )
}
```

### 6.4 CPI（Cross-Program Invocation）—— 跨程序调用

CPI 是 Solana 中程序之间相互调用的机制：

```
┌──────────────────────────────────────────────────────────┐
│                CPI（跨程序调用）示例                        │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  用户发起交易：调用 Program A                               │
│                                                          │
│  ┌─────────────────────────────┐                         │
│  │       Program A             │                         │
│  │                             │                         │
│  │  1. 处理业务逻辑             │                         │
│  │  2. 构建 CPI 指令            │                         │
│  │  3. invoke() 调用 Program B │                         │
│  │        │                    │                         │
│  └────────┼────────────────────┘                         │
│           │                                              │
│           ▼  CPI                                         │
│  ┌─────────────────────────────┐                         │
│  │       Program B             │                         │
│  │  (例如 Token Program)       │                         │
│  │                             │                         │
│  │  执行 Token 转账            │                         │
│  │  返回结果给 Program A       │                         │
│  └─────────────────────────────┘                         │
│                                                          │
│  CPI 调用深度限制: 最多 4 层                               │
│  Program A → B → C → D (最多4层嵌套)                      │
└──────────────────────────────────────────────────────────┘
```

**Anchor 框架中的 CPI 示例**：

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("YourProgramId11111111111111111111");

#[program]
pub mod my_program {
    use super::*;

    /// 通过 CPI 调用 Token Program 进行转账
    pub fn transfer_tokens(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
        // 构建 CPI 上下文
        let cpi_accounts = Transfer {
            from: ctx.accounts.from_token_account.to_account_info(),
            to: ctx.accounts.to_token_account.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        
        // 执行 CPI 调用
        token::transfer(cpi_ctx, amount)?;
        
        msg!("✅ CPI 转账成功: {} tokens", amount);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(mut)]
    pub from_token_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub to_token_account: Account<'info, TokenAccount>,
    
    /// 转出方的授权者，必须签名
    pub authority: Signer<'info>,
    
    /// Token Program（CPI 目标）
    pub token_program: Program<'info, Token>,
}
```

**使用 PDA 签名的 CPI（invoke_signed）**：

```rust
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::invoke_signed,
    pubkey::Pubkey,
    system_instruction,
};

/// 使用 PDA 作为签名者进行 CPI
pub fn cpi_with_pda_signer(
    program_id: &Pubkey,
    pda_account: &AccountInfo,
    recipient: &AccountInfo,
    system_program: &AccountInfo,
    amount: u64,
    bump_seed: u8,
) -> ProgramResult {
    // PDA 的种子
    let seeds: &[&[u8]] = &[
        b"vault",          // 固定种子
        &[bump_seed],      // bump seed
    ];
    let signer_seeds: &[&[&[u8]]] = &[seeds];

    // 构建转账指令
    let transfer_ix = system_instruction::transfer(
        pda_account.key,
        recipient.key,
        amount,
    );

    // 使用 PDA 签名执行 CPI
    invoke_signed(
        &transfer_ix,
        &[
            pda_account.clone(),
            recipient.clone(),
            system_program.clone(),
        ],
        signer_seeds, // PDA 签名种子
    )?;

    Ok(())
}
```

---

## 七、Versioned Transaction 与 Address Lookup Tables

### 7.1 为什么需要 Versioned Transaction？

传统交易（Legacy Transaction）受限于 1232 字节的大小限制，当涉及大量账户时容易超出。**Versioned Transaction** 配合 **Address Lookup Table (ALT)** 解决了这个问题。

```
┌──────────────────────────────────────────────────────────┐
│         Legacy vs Versioned Transaction                   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Legacy Transaction:                                     │
│  ┌─────────────────────────────────────────────┐         │
│  │ account_keys: [                              │         │
│  │   Pubkey1 (32 bytes),  ← 完整公钥            │         │
│  │   Pubkey2 (32 bytes),                        │         │
│  │   Pubkey3 (32 bytes),                        │         │
│  │   ...                                        │         │
│  │   Pubkey20 (32 bytes), ← 20个 = 640 bytes!   │         │
│  │ ]                                            │         │
│  │ 空间很快用完 😢                               │         │
│  └─────────────────────────────────────────────┘         │
│                                                          │
│  Versioned Transaction (v0):                             │
│  ┌─────────────────────────────────────────────┐         │
│  │ account_keys: [                              │         │
│  │   Pubkey1 (32 bytes),  ← 只放必须签名的       │         │
│  │   Pubkey2 (32 bytes),                        │         │
│  │ ]                                            │         │
│  │ address_table_lookups: [                     │         │
│  │   { table: ALT_Pubkey,                       │         │
│  │     writable_indexes: [0, 3, 7],  ← 只需1字节 │         │
│  │     readonly_indexes: [1, 2, 5],             │         │
│  │   }                                          │         │
│  │ ]                                            │         │
│  │ 节省大量空间 🎉                               │         │
│  └─────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────┘
```

### 7.2 使用 Address Lookup Table

```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

async function useAddressLookupTable() {
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const payer = Keypair.generate();

  // 空投
  await connection.requestAirdrop(payer.publicKey, 5 * LAMPORTS_PER_SOL);

  // ─── 步骤 1: 创建 Address Lookup Table ───
  const slot = await connection.getSlot();
  const [createLutIx, lutAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: slot,
    });

  // ─── 步骤 2: 向 LUT 中添加地址 ───
  const addresses = Array.from({ length: 20 }, () =>
    Keypair.generate().publicKey
  );

  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lutAddress,
    addresses: addresses,
  });

  // 发送创建 + 扩展 LUT 的交易
  // ...（省略发送逻辑）

  // ─── 步骤 3: 等待 LUT 激活后使用 ───
  const lutAccount = await connection.getAddressLookupTable(lutAddress);

  // ─── 步骤 4: 构建 Versioned Transaction ───
  const transferIxs = addresses.map((addr) =>
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: addr,
      lamports: 0.001 * LAMPORTS_PER_SOL,
    })
  );

  // 使用 V0 消息格式
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: transferIxs,
  }).compileToV0Message([lutAccount.value!]); // 传入 LUT

  const versionedTx = new VersionedTransaction(messageV0);
  versionedTx.sign([payer]);

  // 发送 Versioned Transaction
  const txSig = await connection.sendTransaction(versionedTx);
  console.log("✅ Versioned Transaction 发送成功:", txSig);
}
```

---

## 八、交易错误处理与调试

### 8.1 常见交易错误

```
┌──────────────────────────────────────────────────────────────┐
│                    常见交易错误及解决方案                       │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  错误                          │ 原因              │ 解决方案 │
│  ─────────────────────────────┼──────────────────┼─────────│
│  BlockhashNotFound            │ blockhash 过期    │ 重新获取 │
│  InsufficientFundsForRent     │ 租金不足          │ 充值     │
│  InsufficientFunds            │ SOL 余额不足      │ 充值     │
│  AccountNotFound              │ 账户不存在        │ 先创建   │
│  InvalidAccountData           │ 数据格式错误      │ 检查序列 │
│  InvalidProgramId             │ 程序ID错误        │ 核实地址 │
│  SignatureVerification        │ 签名无效          │ 检查私钥 │
│  TransactionTooLarge          │ 交易超过1232字节  │ 用 ALT  │
│  ComputationalBudgetExceeded  │ CU 超限          │ 设置上限 │
│  AccountBorrowFailed          │ 账户被重复引用    │ 检查账户 │
│  ProgramFailedToComplete      │ 程序执行超时      │ 优化代码 │
│  PrivilegeEscalation          │ 权限提升错误      │ 检查权限 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 8.2 错误处理最佳实践

```typescript
import {
  Connection,
  Transaction,
  sendAndConfirmTransaction,
  TransactionExpiredBlockheightExceededError,
  SendTransactionError,
} from "@solana/web3.js";

async function sendWithRetry(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  maxRetries: number = 3
): Promise<string> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // 每次重试都获取新的 blockhash
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;

      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        signers,
        {
          commitment: "confirmed",
          maxRetries: 3,
        }
      );

      console.log(`✅ 交易成功 (第 ${attempt} 次尝试)`);
      return signature;
    } catch (error) {
      console.error(`❌ 第 ${attempt} 次尝试失败:`, error);

      if (error instanceof TransactionExpiredBlockheightExceededError) {
        console.log("⏰ Blockhash 已过期，重新获取...");
        continue; // 重试
      }

      if (error instanceof SendTransactionError) {
        const logs = error.logs;
        if (logs) {
          console.log("📋 程序日志:");
          logs.forEach((log) => console.log("  ", log));
        }
      }

      if (attempt === maxRetries) {
        throw error; // 最后一次重试仍失败
      }
    }
  }
  throw new Error("交易发送失败");
}
```

### 8.3 模拟交易（Simulate）

在实际发送前先模拟执行，检查是否会成功：

```typescript
async function simulateBeforeSend(
  connection: Connection,
  transaction: Transaction
) {
  // 模拟交易执行
  const simulation = await connection.simulateTransaction(transaction);

  if (simulation.value.err) {
    console.error("❌ 模拟失败:", simulation.value.err);
    console.log("📋 日志:");
    simulation.value.logs?.forEach((log) => console.log("  ", log));
    return false;
  }

  console.log("✅ 模拟成功");
  console.log("消耗 CU:", simulation.value.unitsConsumed);
  console.log("📋 日志:");
  simulation.value.logs?.forEach((log) => console.log("  ", log));
  return true;
}

// 使用方式
const success = await simulateBeforeSend(connection, transaction);
if (success) {
  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
}
```

---

## 九、Anchor 框架中的交易与指令

### 9.1 Anchor 如何简化指令定义

Anchor 是 Solana 最流行的开发框架，它大幅简化了指令的定义和账户验证：

```rust
use anchor_lang::prelude::*;

declare_id!("Counter11111111111111111111111111111");

#[program]
pub mod counter {
    use super::*;

    /// 初始化计数器
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = 0;
        counter.authority = ctx.accounts.authority.key();
        msg!("计数器已初始化，count = 0");
        Ok(())
    }

    /// 增加计数
    pub fn increment(ctx: Context<Increment>, amount: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter.count
            .checked_add(amount)
            .ok_or(ErrorCode::Overflow)?;
        msg!("计数增加到: {}", counter.count);
        Ok(())
    }

    /// 减少计数
    pub fn decrement(ctx: Context<Decrement>, amount: u64) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        require!(counter.count >= amount, ErrorCode::Underflow);
        counter.count -= amount;
        msg!("计数减少到: {}", counter.count);
        Ok(())
    }
}

/// 初始化指令的账户约束
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// 新的计数器账户
    /// init: 自动创建账户
    /// payer: 谁支付租金
    /// space: 数据大小 = 8(discriminator) + 8(u64) + 32(Pubkey)
    #[account(init, payer = authority, space = 8 + 8 + 32)]
    pub counter: Account<'info, Counter>,
    
    /// 初始化者（费用支付者）
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// System Program（创建账户需要）
    pub system_program: Program<'info, System>,
}

/// Increment 指令的账户约束
#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(
        mut, 
        has_one = authority  // 验证 authority 是否匹配
    )]
    pub counter: Account<'info, Counter>,
    pub authority: Signer<'info>,
}

/// Decrement 指令的账户约束
#[derive(Accounts)]
pub struct Decrement<'info> {
    #[account(
        mut, 
        has_one = authority
    )]
    pub counter: Account<'info, Counter>,
    pub authority: Signer<'info>,
}

/// 计数器数据账户结构
#[account]
pub struct Counter {
    pub count: u64,
    pub authority: Pubkey,
}

/// 自定义错误
#[error_code]
pub enum ErrorCode {
    #[msg("计数器溢出")]
    Overflow,
    #[msg("计数器下溢")]
    Underflow,
}
```

### 9.2 客户端调用 Anchor 程序

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Counter } from "../target/types/counter";
import { Keypair, SystemProgram } from "@solana/web3.js";

async function main() {
  // 配置 Anchor Provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // 获取程序接口
  const program = anchor.workspace.Counter as Program<Counter>;

  // 生成计数器账户
  const counterAccount = Keypair.generate();

  // ─── 调用 initialize 指令 ───
  const initTx = await program.methods
    .initialize()
    .accounts({
      counter: counterAccount.publicKey,
      authority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([counterAccount])
    .rpc();

  console.log("✅ 初始化交易:", initTx);

  // ─── 调用 increment 指令 ───
  const incrTx = await program.methods
    .increment(new anchor.BN(5))  // amount = 5
    .accounts({
      counter: counterAccount.publicKey,
      authority: provider.wallet.publicKey,
    })
    .rpc();

  console.log("✅ 增加计数交易:", incrTx);

  // ─── 读取账户数据 ───
  const counterData = await program.account.counter.fetch(
    counterAccount.publicKey
  );
  console.log("当前计数:", counterData.count.toString()); // 输出: 5
  console.log("Authority:", counterData.authority.toString());

  // ─── 调用 decrement 指令 ───
  const decrTx = await program.methods
    .decrement(new anchor.BN(2))  // amount = 2
    .accounts({
      counter: counterAccount.publicKey,
      authority: provider.wallet.publicKey,
    })
    .rpc();

  console.log("✅ 减少计数交易:", decrTx);

  const finalData = await program.account.counter.fetch(
    counterAccount.publicKey
  );
  console.log("最终计数:", finalData.count.toString()); // 输出: 3
}

main();
```

---

## 十、Native Program 指令参考

### 10.1 System Program 常用指令

```
┌──────────────────────────────────────────────────────────┐
│           System Program (11111111111111111111111111111)  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  指令                 │ 功能               │ 常见场景     │
│  ────────────────────┼───────────────────┼────────────  │
│  CreateAccount       │ 创建新账户          │ 初始化数据   │
│  Transfer            │ 转移 SOL           │ 支付/转账    │
│  Assign              │ 更改 owner         │ 分配给程序   │
│  Allocate            │ 分配空间           │ 预分配data   │
│  CreateAccountWithSeed│ 带种子创建账户     │ 确定性地址   │
│  AdvanceNonceAccount │ 推进 Nonce         │ 离线交易     │
│  InitializeNonceAccount│ 初始化 Nonce     │ 离线交易     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

```rust
use solana_sdk::system_instruction;

// ── CreateAccount: 创建新账户 ──
let create_ix = system_instruction::create_account(
    &payer,          // 付费者
    &new_account,    // 新账户
    rent_lamports,   // 租金
    space as u64,    // 数据空间
    &program_id,     // owner（新账户的拥有者）
);

// ── Transfer: 转移 SOL ──
let transfer_ix = system_instruction::transfer(
    &from,          // 发送者
    &to,            // 接收者
    lamports,       // 金额（lamports）
);

// ── Assign: 更改账户的 owner ──
let assign_ix = system_instruction::assign(
    &account,       // 账户
    &new_owner,     // 新 owner
);

// ── Allocate: 为账户分配空间 ──
let allocate_ix = system_instruction::allocate(
    &account,       // 账户
    space as u64,   // 空间大小
);
```

### 10.2 Token Program 常用指令

```typescript
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  transfer,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

async function tokenOperations(connection, payer) {
  // ── 创建代币 Mint ──
  const mint = await createMint(
    connection,
    payer,              // Fee payer
    payer.publicKey,    // Mint Authority（铸币权）
    payer.publicKey,    // Freeze Authority（冻结权，可为null）
    9,                  // Decimals（小数位数）
  );
  console.log("Mint 地址:", mint.toBase58());

  // ── 创建关联代币账户 (ATA) ──
  const tokenAccount = await createAssociatedTokenAccount(
    connection,
    payer,              // Fee payer
    mint,               // 代币 Mint
    payer.publicKey,    // 账户拥有者
  );
  console.log("Token Account:", tokenAccount.toBase58());

  // ── 铸造代币 ──
  await mintTo(
    connection,
    payer,              // Fee payer
    mint,               // Mint
    tokenAccount,       // 目标 Token Account
    payer,              // Mint Authority（签名者）
    1_000_000_000,      // 数量（含小数，9位 = 1个代币）
  );

  // ── 转移代币 ──
  const recipient = Keypair.generate();
  const recipientATA = await createAssociatedTokenAccount(
    connection, payer, mint, recipient.publicKey
  );

  await transfer(
    connection,
    payer,              // Fee payer
    tokenAccount,       // 发送方 Token Account
    recipientATA,       // 接收方 Token Account
    payer,              // 发送方 Authority（签名者）
    500_000_000,        // 转 0.5 个代币
  );

  // ── 查询余额 ──
  const info = await getAccount(connection, tokenAccount);
  console.log("余额:", info.amount.toString()); // 500000000 (0.5 token)
}
```

---

## 十一、交易调试与监控工具

### 11.1 Solana Explorer

访问 [https://explorer.solana.com](https://explorer.solana.com) 可以查看任何交易的详细信息：

```
浏览器中一笔交易的信息结构：

┌───────────────────────────────────────────────────┐
│  Transaction: 5xYz...AbCd                         │
├───────────────────────────────────────────────────┤
│                                                   │
│  Status: ✅ Success / ❌ Failed                    │
│  Block: #123456789                                │
│  Timestamp: 2024-01-15 10:30:45 UTC               │
│  Fee: 0.000005 SOL (5000 lamports)               │
│  Compute Units: 12,345 / 200,000                  │
│                                                   │
│  ┌─ Account Inputs ──────────────────────────┐   │
│  │ #0 💰📝 Fee Payer (AAA...)   -0.500005 SOL│   │
│  │ #1    📝 Receiver  (BBB...)  +0.500000 SOL│   │
│  │ #2       System Program                    │   │
│  └────────────────────────────────────────────┘   │
│                                                   │
│  ┌─ Instructions ────────────────────────────┐   │
│  │ #1 System Program: Transfer                │   │
│  │    From: AAA... → To: BBB...               │   │
│  │    Amount: 500,000,000 lamports            │   │
│  └────────────────────────────────────────────┘   │
│                                                   │
│  ┌─ Program Logs ────────────────────────────┐   │
│  │ Program 1111...1111 invoke [1]             │   │
│  │ Program 1111...1111 success                │   │
│  └────────────────────────────────────────────┘   │
│                                                   │
└───────────────────────────────────────────────────┘
```

### 11.2 CLI 调试命令

```bash
# 查看交易详情
solana confirm -v <TRANSACTION_SIGNATURE>

# 获取账户信息
solana account <ACCOUNT_ADDRESS>

# 查看程序日志
solana logs <PROGRAM_ID>

# 监听所有交易日志（实时）
solana logs --url devnet

# 模拟交易（不实际执行）
# 使用 solana-test-validator 进行本地测试
solana-test-validator

# 空投 SOL（仅 devnet/testnet）
solana airdrop 2 <ADDRESS> --url devnet

# 获取当前区块高度
solana block-height --url devnet

# 查看最近的交易
solana transaction-history <ADDRESS> --limit 10
```

### 11.3 程序日志（msg! 宏）

```rust
use solana_program::msg;

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    msg!("程序入口点被调用");
    msg!("程序 ID: {}", program_id);
    msg!("账户数量: {}", accounts.len());
    msg!("指令数据长度: {}", instruction_data.len());

    // 解析指令
    let instruction = instruction_data[0];
    msg!("指令类型: {}", instruction);

    match instruction {
        0 => {
            msg!("执行初始化...");
            // ... 初始化逻辑
            msg!("✅ 初始化完成");
        }
        1 => {
            let amount = u64::from_le_bytes(
                instruction_data[1..9].try_into().unwrap()
            );
            msg!("执行转账，金额: {} lamports", amount);
            // ... 转账逻辑
        }
        _ => {
            msg!("❌ 未知指令: {}", instruction);
            return Err(ProgramError::InvalidInstructionData);
        }
    }

    Ok(())
}
```

---

## 十二、最佳实践总结

### 12.1 交易构建最佳实践

```
┌──────────────────────────────────────────────────────────────┐
│                    交易构建最佳实践清单                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ✅ 合理设置 Compute Unit：                                   │
│     • 先模拟获取实际 CU 消耗                                  │
│     • 设置为实际消耗的 1.2-1.5 倍                             │
│     • 避免设置过高浪费优先费                                   │
│                                                              │
│  ✅ 使用优先费提高打包概率：                                    │
│     • 在网络拥堵时设置 priority fee                           │
│     • 使用 getRecentPrioritizationFees 获取推荐值             │
│                                                              │
│  ✅ 正确处理 Blockhash：                                      │
│     • 总是获取最新 blockhash                                  │
│     • 利用 lastValidBlockHeight 判断过期                     │
│     • 过期后重新获取并重试                                    │
│                                                              │
│  ✅ 最小化账户数量：                                           │
│     • 只声明必要的账户                                        │
│     • 超过限制时使用 Address Lookup Table                     │
│                                                              │
│  ✅ 利用交易原子性：                                           │
│     • 将关联操作放在同一笔交易中                               │
│     • 确保"全部成功或全部回滚"的语义                           │
│                                                              │
│  ✅ 发送前模拟：                                               │
│     • 使用 simulateTransaction 预检查                        │
│     • 分析 logs 排查问题                                     │
│                                                              │
│  ✅ 重试策略：                                                │
│     • 实现指数退避重试                                        │
│     • 区分可重试错误和不可重试错误                              │
│     • Blockhash 过期 → 可重试                                │
│     • 余额不足 → 不可重试                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 12.2 指令设计最佳实践

```
┌──────────────────────────────────────────────────────────────┐
│                    指令设计最佳实践清单                        │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ✅ 账户权限最小化：                                           │
│     • 只有确实需要写入的账户设为 is_writable: true             │
│     • 只有确实需要签名的账户设为 is_signer: true               │
│     • 程序和 Sysvar 始终设为 readonly                        │
│                                                              │
│  ✅ 数据序列化：                                               │
│     • 使用 Borsh 进行高效序列化                               │
│     • 指令数据第一个字节通常是指令类型标识                      │
│     • Anchor 自动使用 8 字节 discriminator                   │
│                                                              │
│  ✅ 安全检查：                                                │
│     • 验证所有账户的 owner 是否正确                            │
│     • 验证签名者权限                                          │
│     • 使用 PDA 进行确定性地址派生                             │
│     • 检查账户是否已初始化（防止重复初始化）                    │
│                                                              │
│  ✅ CPI 安全：                                                │
│     • 验证 CPI 目标程序的 program_id                         │
│     • 使用 invoke_signed 而非直接传递签名                     │
│     • 注意 CPI 深度限制（最多 4 层）                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 十三、概念总结回顾

```
┌──────────────────────────────────────────────────────────────────┐
│                  Solana SVM 交易指令知识图谱                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│                        ┌──────────┐                              │
│                        │   SVM    │                              │
│                        │ 执行引擎  │                              │
│                        └────┬─────┘                              │
│                             │                                    │
│               ┌─────────────┼──────────────┐                     │
│               │             │              │                     │
│          ┌────▼─────┐ ┌────▼─────┐ ┌──────▼────┐                │
│          │ Sealevel │ │   BPF    │ │   Bank    │                │
│          │ 并行引擎  │ │ Runtime  │ │ 状态管理   │                │
│          └──────────┘ └──────────┘ └───────────┘                │
│                             │                                    │
│                      ┌──────▼──────┐                             │
│                      │ Transaction │                             │
│                      │    交易     │                              │
│                      └──────┬──────┘                             │
│                             │                                    │
│              ┌──────────────┼───────────────┐                    │
│              │              │               │                    │
│       ┌──────▼─────┐ ┌─────▼──────┐ ┌──────▼──────┐            │
│       │ Signatures │ │  Message   │ │  Blockhash  │            │
│       │   签名      │ │   消息体    │ │  区块哈希    │            │
│       └────────────┘ └─────┬──────┘ └─────────────┘            │
│                            │                                    │
│              ┌─────────────┼──────────────┐                     │
│              │             │              │                     │
│       ┌──────▼─────┐ ┌────▼──────┐ ┌─────▼─────────┐          │
│       │   Header   │ │  Account  │ │ Instructions  │          │
│       │   消息头    │ │   Keys    │ │    指令数组    │          │
│       └────────────┘ └───────────┘ └───────┬───────┘          │
│                                            │                    │
│                                  ┌─────────▼─────────┐         │
│                                  │   Instruction     │         │
│                                  ├───────────────────┤         │
│                                  │ • program_id      │         │
│                                  │ • accounts []     │         │
│                                  │ • data []         │         │
│                                  └───────────────────┘         │
│                                                                  │
│  核心要点：                                                       │
│  • SVM 通过 Sealevel 实现交易并行执行                              │
│  • 交易由签名 + 消息体组成，消息体包含指令列表                       │
│  • 指令是最小执行单元，指定程序、账户、参数                          │
│  • 交易具有原子性，一条指令失败则全部回滚                            │
│  • 账户必须预先声明，支持读写权限控制                                │
│  • Compute Unit 是计算资源度量，类似 Gas                           │
│  • Versioned Transaction + ALT 解决交易大小限制                    │
│  • CPI 实现程序间调用，最多 4 层嵌套                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 参考资源

| 资源 | 链接 |
|------|------|
| Solana 官方文档 | https://solana.com/docs |
| Solana Cookbook | https://solanacookbook.com |
| Anchor 框架文档 | https://www.anchor-lang.com |
| Solana Playground | https://beta.solpg.io |
| Solana Explorer | https://explorer.solana.com |
| Solana Stack Exchange | https://solana.stackexchange.com |
| SVM 源码 | https://github.com/solana-labs/solana |
| @solana/web3.js | https://solana-labs.github.io/solana-web3.js |

---