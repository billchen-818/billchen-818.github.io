---
title: Solana Anchor 框架总结
date: 2026-03-06 13:21:31
tags: Solana
---

> Anchor 是 Solana 生态中最主流的链上程序（Smart Contract）开发框架，类似于以太坊的 Hardhat/Foundry。它提供了 **IDL 自动生成、账户序列化/反序列化、安全校验宏** 等能力，让开发者可以快速开发、测试与部署 Solana 程序。

---

## 一、Anchor 框架总览

### 1.1 Anchor 是什么？

Anchor 是 Solana 程序开发的全栈框架，核心能力包括：

| 能力 | 说明 |
|------|------|
| **Rust 宏** | 通过 `#[program]`、`#[derive(Accounts)]` 等宏，自动生成序列化/反序列化与安全校验代码 |
| **IDL 生成** | 自动生成 Interface Definition Language 文件，供前端/客户端调用 |
| **CLI 工具** | 提供 `anchor init`、`anchor build`、`anchor test`、`anchor deploy` 等命令 |
| **TypeScript SDK** | 内置 `@coral-xyz/anchor` 客户端 SDK，方便编写测试和前端集成 |
| **本地验证器** | 集成 `solana-test-validator`，支持本地测试 |

### 1.2 Anchor 与原生 Solana 对比

```
  原生 Solana Program                   Anchor Program
┌─────────────────────────┐      ┌─────────────────────────┐
│  手动解析指令数据         │      │  自动反序列化指令数据     │
│  手动校验账户             │      │  宏自动生成校验逻辑       │
│  手动序列化/反序列化      │      │  Borsh 自动处理          │
│  手动编写 IDL            │      │  自动生成 IDL            │
│  ~200 行代码             │      │  ~50 行代码              │
│  容易出安全漏洞           │      │  内置安全检查             │
└─────────────────────────┘      └─────────────────────────┘
```

### 1.3 Anchor 程序架构

```
┌────────────────────────────────────────────────────────────────┐
│                    Anchor 程序架构                               │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   Client (TS/JS)                                               │
│       │                                                        │
│       │  通过 IDL 调用                                          │
│       ▼                                                        │
│   ┌──────────────────────────────────────────┐                 │
│   │           Anchor Program (Rust)          │                 │
│   ├──────────────────────────────────────────┤                 │
│   │                                          │                 │
│   │  #[program] ─── 定义指令处理函数          │                 │
│   │       │                                  │                 │
│   │       ├─── initialize()                  │                 │
│   │       ├─── add()                         │                 │
│   │       └─── subtract()                    │                 │
│   │                                          │                 │
│   │  #[derive(Accounts)] ─── 定义账户结构     │                 │
│   │       │                                  │                 │
│   │       ├─── 账户校验 (owner, signer)      │                 │
│   │       ├─── 账户初始化 (init, payer)      │                 │
│   │       └─── 约束检查 (constraint, has_one)│                 │
│   │                                          │                 │
│   │  #[account] ─── 定义数据账户结构          │                 │
│   │       │                                  │                 │
│   │       └─── 自动实现序列化/反序列化        │                 │
│   │                                          │                 │
│   └──────────────────────────────────────────┘                 │
│       │                                                        │
│       ▼                                                        │
│   ┌──────────────────────────────────────────┐                 │
│   │         Solana Runtime (SVM)             │                 │
│   │    读写账户数据 / 扣除 Rent / CPI 调用    │                 │
│   └──────────────────────────────────────────┘                 │
└────────────────────────────────────────────────────────────────┘
```

---

## 二、环境准备

### 2.1 安装 Rust

```bash
# 安装 Rust（如果尚未安装）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 验证安装
rustc --version
cargo --version
```

### 2.2 安装 Solana CLI

```bash
# 安装 Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# 添加到 PATH（根据终端提示操作）
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 验证安装
solana --version
```

### 2.3 安装 Node.js & npm

```bash
# 使用 nvm 安装 Node.js（推荐）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20

# 验证
node --version
npm --version
```

### 2.4 安装 Anchor CLI

```bash
# 使用 AVM（Anchor Version Manager）安装
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install latest
avm use latest

# 验证
anchor --version
```

### 2.5 配置 Solana 钱包

```bash
# 生成新的密钥对（开发用）
solana-keygen new --outfile ~/.config/solana/id.json

# 切换到开发网（Devnet）
solana config set --url https://api.devnet.solana.com

# 获取空投（每次最多 2 SOL）
solana airdrop 2

# 查看余额
solana balance

# 查看当前配置
solana config get
```

输出示例：

```
Config File: /Users/yourname/.config/solana/cli/config.yml
RPC URL: https://api.devnet.solana.com
WebSocket URL: wss://api.devnet.solana.com/ (computed)
Keypair Path: /Users/yourname/.config/solana/id.json
Commitment: confirmed
```

### 2.6 环境检查清单

```
┌─────────────────────────────────────────────────────────┐
│                    环境检查清单 ✓                         │
├──────────────┬──────────────────────────────────────────┤
│  工具         │  命令                                    │
├──────────────┼──────────────────────────────────────────┤
│  Rust        │  rustc --version    (>= 1.75.0)         │
│  Cargo       │  cargo --version                         │
│  Solana CLI  │  solana --version   (>= 1.18.0)         │
│  Node.js     │  node --version     (>= 18.0.0)         │
│  npm         │  npm --version                           │
│  Anchor      │  anchor --version   (>= 0.30.0)         │
│  钱包        │  solana address     (显示公钥地址)        │
│  余额        │  solana balance     (>= 2 SOL)          │
│  网络        │  solana config get  (确认为 devnet)       │
└──────────────┴──────────────────────────────────────────┘
```

---

## 三、Anchor 项目详解

### 3.1 新建项目

```bash
# 创建新的 Anchor 项目
anchor init my_calculator
cd my_calculator
```

### 3.2 项目目录结构

```
my_calculator/
├── Anchor.toml              # Anchor 配置文件（网络、程序 ID、部署配置）
├── Cargo.toml               # Rust 工作空间配置
├── package.json             # Node.js 依赖（测试用）
├── tsconfig.json            # TypeScript 配置
│
├── programs/                # 链上程序（智能合约）目录
│   └── my_calculator/
│       ├── Cargo.toml       # 程序的 Rust 依赖
│       ├── Xargo.toml       # 交叉编译配置
│       └── src/
│           └── lib.rs       # 🔥 程序主入口（核心代码在这里）
│
├── tests/                   # 测试目录
│   └── my_calculator.ts     # 🧪 TypeScript 测试文件
│
├── migrations/              # 部署迁移脚本
│   └── deploy.ts
│
└── target/                  # 编译输出（build 后生成）
    ├── idl/                 # 📋 自动生成的 IDL 文件
    │   └── my_calculator.json
    ├── types/               # 📋 自动生成的 TypeScript 类型
    │   └── my_calculator.ts
    └── deploy/              # 编译后的 .so 程序文件
        └── my_calculator-keypair.json
```

### 3.3 Anchor.toml 配置文件

```toml
[features]
seeds = false
skip-lint = false

[programs.localnet]
my_calculator = "你的ProgramID"   # 程序 ID（build 后自动生成）

[programs.devnet]
my_calculator = "你的ProgramID"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"               # 默认使用本地网络
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

### 3.4 常用 Anchor CLI 命令

```bash
# 初始化项目
anchor init <project_name>

# 编译程序
anchor build

# 运行测试（自动启动本地验证器）
anchor test

# 仅运行测试（不重启验证器）
anchor test --skip-local-validator

# 部署到指定网络
anchor deploy --provider.cluster devnet

# 查看程序 ID（密钥对）
solana address -k target/deploy/my_calculator-keypair.json

# 生成新的程序密钥对
anchor keys list
anchor keys sync
```

### 3.5 Anchor 核心宏说明

```
┌──────────────────────────────────────────────────────────────┐
│                   Anchor 核心宏体系                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  #[program]                                                  │
│  ├── 定义程序模块，包含所有指令处理函数                         │
│  ├── 每个 pub fn 自动成为一个可调用的指令                      │
│  └── 函数签名：fn xxx(ctx: Context<T>, args...) -> Result<()>│
│                                                              │
│  #[derive(Accounts)]                                         │
│  ├── 定义指令所需的账户结构                                    │
│  ├── 自动生成账户校验逻辑                                     │
│  └── 常用属性:                                                │
│      ├── #[account(init, payer, space)]  初始化新账户          │
│      ├── #[account(mut)]                 可变账户              │
│      ├── #[account(has_one)]             所有权校验            │
│      └── #[account(seeds, bump)]         PDA 账户             │
│                                                              │
│  #[account]                                                  │
│  ├── 定义链上存储的数据结构                                    │
│  ├── 自动实现 Borsh 序列化/反序列化                            │
│  └── 自动添加 8 字节的 discriminator（鉴别器）                 │
│                                                              │
│  #[error_code]                                               │
│  ├── 定义自定义错误枚举                                       │
│  └── 每个变体可附加 #[msg("...")] 错误信息                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 四、示例合约：计算器程序

### 4.1 完整合约代码

编辑 `programs/my_calculator/src/lib.rs`：

```rust
use anchor_lang::prelude::*;

// 声明程序 ID（anchor build 后自动替换）
declare_id!("你的ProgramID");

#[program]
pub mod my_calculator {
    use super::*;

    /// 初始化计算器账户
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let calculator = &mut ctx.accounts.calculator;
        calculator.result = 0;
        calculator.owner = ctx.accounts.user.key();
        msg!("Calculator initialized! Owner: {}", calculator.owner);
        Ok(())
    }

    /// 加法运算
    pub fn add(ctx: Context<Calculate>, a: i64, b: i64) -> Result<()> {
        let calculator = &mut ctx.accounts.calculator;
        calculator.result = a
            .checked_add(b)
            .ok_or(ErrorCode::Overflow)?;
        msg!("{} + {} = {}", a, b, calculator.result);
        Ok(())
    }

    /// 减法运算
    pub fn subtract(ctx: Context<Calculate>, a: i64, b: i64) -> Result<()> {
        let calculator = &mut ctx.accounts.calculator;
        calculator.result = a
            .checked_sub(b)
            .ok_or(ErrorCode::Underflow)?;
        msg!("{} - {} = {}", a, b, calculator.result);
        Ok(())
    }

    /// 乘法运算
    pub fn multiply(ctx: Context<Calculate>, a: i64, b: i64) -> Result<()> {
        let calculator = &mut ctx.accounts.calculator;
        calculator.result = a
            .checked_mul(b)
            .ok_or(ErrorCode::Overflow)?;
        msg!("{} × {} = {}", a, b, calculator.result);
        Ok(())
    }

    /// 除法运算
    pub fn divide(ctx: Context<Calculate>, a: i64, b: i64) -> Result<()> {
        require!(b != 0, ErrorCode::DivisionByZero);
        let calculator = &mut ctx.accounts.calculator;
        calculator.result = a
            .checked_div(b)
            .ok_or(ErrorCode::Overflow)?;
        msg!("{} ÷ {} = {}", a, b, calculator.result);
        Ok(())
    }
}

/// ========== 账户结构定义 ==========

/// Initialize 指令所需的账户
#[derive(Accounts)]
pub struct Initialize<'info> {
    /// 新建计算器数据账户
    /// - init: 创建账户
    /// - payer: 由 user 支付创建费用
    /// - space: 8 (discriminator) + Calculator 数据大小
    #[account(
        init,
        payer = user,
        space = 8 + Calculator::INIT_SPACE
    )]
    pub calculator: Account<'info, Calculator>,

    /// 签名者（支付创建费用）
    #[account(mut)]
    pub user: Signer<'info>,

    /// System Program（创建账户需要）
    pub system_program: Program<'info, System>,
}

/// Calculate 指令所需的账户
#[derive(Accounts)]
pub struct Calculate<'info> {
    /// 计算器数据账户（可变，需要写入结果）
    /// has_one = owner: 校验 calculator.owner == owner.key()
    #[account(mut, has_one = owner)]
    pub calculator: Account<'info, Calculator>,

    /// 所有者（必须签名）
    pub owner: Signer<'info>,
}

/// ========== 数据账户结构 ==========

/// 计算器数据账户
#[account]
#[derive(InitSpace)]
pub struct Calculator {
    /// 所有者公钥
    pub owner: Pubkey,     // 32 bytes
    /// 运算结果
    pub result: i64,       // 8 bytes
}

/// ========== 自定义错误 ==========

#[error_code]
pub enum ErrorCode {
    #[msg("Math overflow occurred")]
    Overflow,
    #[msg("Math underflow occurred")]
    Underflow,
    #[msg("Division by zero")]
    DivisionByZero,
}
```

### 4.2 代码结构解析

```
┌────────────────────────────────────────────────────────────────────┐
│                    lib.rs 代码结构解析                               │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  use anchor_lang::prelude::*;      ← 导入 Anchor 预置模块          │
│                                                                    │
│  declare_id!("...");               ← 声明程序链上地址               │
│                                                                    │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ #[program]                                          │          │
│  │ mod my_calculator {                                 │          │
│  │     fn initialize(ctx) → 初始化计算器                │          │
│  │     fn add(ctx, a, b)  → 加法                       │          │
│  │     fn subtract(ctx, a, b) → 减法                   │          │
│  │     fn multiply(ctx, a, b) → 乘法                   │          │
│  │     fn divide(ctx, a, b)   → 除法                   │          │
│  │ }                                                   │          │
│  └──────────────────────────────────────────────────────┘          │
│                                                                    │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ #[derive(Accounts)]                                 │          │
│  │ struct Initialize {                                 │          │
│  │     calculator: Account<Calculator>  ← init 新账户   │          │
│  │     user: Signer                     ← 付款签名者    │          │
│  │     system_program: Program<System>  ← 系统程序      │          │
│  │ }                                                   │          │
│  │                                                     │          │
│  │ struct Calculate {                                  │          │
│  │     calculator: Account<Calculator>  ← mut 可变账户  │          │
│  │     owner: Signer                    ← 所有者签名    │          │
│  │ }                                                   │          │
│  └──────────────────────────────────────────────────────┘          │
│                                                                    │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ #[account]                                          │          │
│  │ struct Calculator {                                 │          │
│  │     owner: Pubkey   (32 bytes)                      │          │
│  │     result: i64     (8 bytes)                       │          │
│  │ }                                                   │          │
│  │                                                     │          │
│  │ 总空间 = 8 (discriminator) + 32 + 8 = 48 bytes     │          │
│  └──────────────────────────────────────────────────────┘          │
│                                                                    │
│  ┌──────────────────────────────────────────────────────┐          │
│  │ #[error_code]                                       │          │
│  │ enum ErrorCode { Overflow, Underflow, DivByZero }   │          │
│  └──────────────────────────────────────────────────────┘          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 4.3 账户约束详解

Anchor 提供了丰富的账户约束属性，下面是常用约束：

| 约束 | 用法 | 说明 |
|------|------|------|
| `init` | `#[account(init, payer = x, space = n)]` | 创建并初始化新账户 |
| `mut` | `#[account(mut)]` | 标记账户可变（可写入） |
| `has_one` | `#[account(has_one = field)]` | 校验账户字段与另一个账户 key 匹配 |
| `seeds` | `#[account(seeds = [b"xxx"], bump)]` | PDA 账户推导 |
| `close` | `#[account(close = target)]` | 关闭账户，将 lamports 转给 target |
| `constraint` | `#[account(constraint = expr)]` | 自定义布尔约束 |
| `realloc` | `#[account(realloc = n, ...)]` | 重新分配账户空间 |

**PDA 账户示例：**

```rust
#[derive(Accounts)]
#[instruction(seed_value: String)]
pub struct CreatePDA<'info> {
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 4 + 200,
        seeds = [b"my_seed", user.key().as_ref()],
        bump
    )]
    pub pda_account: Account<'info, MyData>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}
```

### 4.4 Anchor 账户类型说明

| 类型 | 说明 |
|------|------|
| `Account<'info, T>` | 已反序列化的数据账户，自动校验 owner 和 discriminator |
| `Signer<'info>` | 必须签名的账户 |
| `Program<'info, T>` | 程序账户（如 System Program、Token Program） |
| `SystemAccount<'info>` | 普通系统账户（不反序列化） |
| `UncheckedAccount<'info>` | 不进行任何校验的账户（⚠️ 需手动校验，危险） |
| `AccountInfo<'info>` | 原始账户信息 |
| `AccountLoader<'info, T>` | 用于 Zero-Copy 反序列化的大账户 |

---

## 五、测试

### 5.1 TypeScript 测试代码

编辑 `tests/my_calculator.ts`：

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MyCalculator } from "../target/types/my_calculator";
import { assert } from "chai";

describe("my_calculator", () => {
  // 配置 provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MyCalculator as Program<MyCalculator>;

  // 生成新的 Keypair 作为 calculator 账户
  const calculator = anchor.web3.Keypair.generate();

  it("初始化计算器", async () => {
    // 调用 initialize 指令
    const tx = await program.methods
      .initialize()
      .accounts({
        calculator: calculator.publicKey,
        user: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([calculator])
      .rpc();

    console.log("Initialize tx:", tx);

    // 获取链上账户数据并验证
    const account = await program.account.calculator.fetch(
      calculator.publicKey
    );
    assert.ok(account.owner.equals(provider.wallet.publicKey));
    assert.ok(account.result.toNumber() === 0);
    console.log("Calculator owner:", account.owner.toString());
  });

  it("加法: 5 + 3 = 8", async () => {
    const tx = await program.methods
      .add(new anchor.BN(5), new anchor.BN(3))
      .accounts({
        calculator: calculator.publicKey,
        owner: provider.wallet.publicKey,
      })
      .rpc();

    console.log("Add tx:", tx);

    const account = await program.account.calculator.fetch(
      calculator.publicKey
    );
    assert.ok(account.result.toNumber() === 8);
    console.log("Result:", account.result.toNumber());
  });

  it("减法: 10 - 4 = 6", async () => {
    const tx = await program.methods
      .subtract(new anchor.BN(10), new anchor.BN(4))
      .accounts({
        calculator: calculator.publicKey,
        owner: provider.wallet.publicKey,
      })
      .rpc();

    console.log("Subtract tx:", tx);

    const account = await program.account.calculator.fetch(
      calculator.publicKey
    );
    assert.ok(account.result.toNumber() === 6);
    console.log("Result:", account.result.toNumber());
  });

  it("乘法: 7 × 8 = 56", async () => {
    const tx = await program.methods
      .multiply(new anchor.BN(7), new anchor.BN(8))
      .accounts({
        calculator: calculator.publicKey,
        owner: provider.wallet.publicKey,
      })
      .rpc();

    console.log("Multiply tx:", tx);

    const account = await program.account.calculator.fetch(
      calculator.publicKey
    );
    assert.ok(account.result.toNumber() === 56);
    console.log("Result:", account.result.toNumber());
  });

  it("除法: 100 ÷ 5 = 20", async () => {
    const tx = await program.methods
      .divide(new anchor.BN(100), new anchor.BN(5))
      .accounts({
        calculator: calculator.publicKey,
        owner: provider.wallet.publicKey,
      })
      .rpc();

    console.log("Divide tx:", tx);

    const account = await program.account.calculator.fetch(
      calculator.publicKey
    );
    assert.ok(account.result.toNumber() === 20);
    console.log("Result:", account.result.toNumber());
  });

  it("除以零应该失败", async () => {
    try {
      await program.methods
        .divide(new anchor.BN(10), new anchor.BN(0))
        .accounts({
          calculator: calculator.publicKey,
          owner: provider.wallet.publicKey,
        })
        .rpc();
      assert.fail("Should have thrown an error");
    } catch (err) {
      console.log("Expected error:", err.message);
      assert.ok(err.message.includes("DivisionByZero"));
    }
  });
});
```

### 5.2 运行测试

```bash
# 运行测试（会自动启动本地验证器、编译、部署、执行测试）
anchor test
```

测试输出示例：

```
  my_calculator
    ✔ 初始化计算器 (432ms)
    Initialize tx: 5Kz...xxx
    Calculator owner: 7nY...xxx
    ✔ 加法: 5 + 3 = 8 (456ms)
    Add tx: 3Rf...xxx
    Result: 8
    ✔ 减法: 10 - 4 = 6 (401ms)
    Subtract tx: 2Ab...xxx
    Result: 6
    ✔ 乘法: 7 × 8 = 56 (398ms)
    Multiply tx: 4Cd...xxx
    Result: 56
    ✔ 除法: 100 ÷ 5 = 20 (412ms)
    Divide tx: 6Ef...xxx
    Result: 20
    ✔ 除以零应该失败 (215ms)
    Expected error: DivisionByZero

  6 passing (2s)
```

### 5.3 测试中的核心 API

```
┌────────────────────────────────────────────────────────────────────┐
│                  Anchor TypeScript 测试 API                        │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  调用指令:                                                         │
│  program.methods                                                   │
│      .instructionName(args...)     ← 指令名 + 参数                 │
│      .accounts({ ... })            ← 传入所需账户                  │
│      .signers([...])               ← 额外签名者                   │
│      .rpc()                        ← 发送交易并确认                │
│                                                                    │
│  查询账户:                                                         │
│  program.account                                                   │
│      .accountType                  ← 账户类型名（驼峰）            │
│      .fetch(pubkey)                ← 获取单个账户数据              │
│      .all()                        ← 获取所有该类型账户             │
│      .fetchMultiple([...])         ← 批量获取                     │
│                                                                    │
│  常用工具:                                                         │
│  anchor.web3.Keypair.generate()    ← 生成新密钥对                  │
│  anchor.web3.SystemProgram.programId ← System Program ID           │
│  new anchor.BN(value)              ← 创建大数（u64/i64等）         │
│  provider.wallet.publicKey         ← 当前钱包公钥                  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 六、部署到 Devnet

### 6.1 部署步骤

```bash
# 1. 切换到 Devnet
solana config set --url https://api.devnet.solana.com

# 2. 确保有足够余额
solana balance
solana airdrop 2    # 如余额不足，申请空投

# 3. 修改 Anchor.toml 中的 cluster
#    [provider]
#    cluster = "Devnet"

# 4. 编译
anchor build

# 5. 获取程序 ID 并更新
anchor keys list
# 将输出的 Program ID 更新到：
# - lib.rs 中的 declare_id!("...")
# - Anchor.toml 中的 [programs.devnet]

# 6. 重新编译（更新 Program ID 后）
anchor build

# 7. 部署到 Devnet
anchor deploy --provider.cluster devnet
```

### 6.2 部署流程图

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  anchor  │     │  anchor  │     │  更新     │     │  anchor  │
│  build   │────►│  keys    │────►│  Program  │────►│  build   │
│          │     │  list    │     │  ID       │     │  (重新)   │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                                                        │
                                                        ▼
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  验证    │     │  查看    │     │  链上    │     │  anchor  │
│  部署    │◄────│  交易    │◄────│  确认    │◄────│  deploy  │
│  成功    │     │  hash    │     │          │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### 6.3 验证部署

```bash
# 查看部署的程序
solana program show <PROGRAM_ID>

# 在 Solana Explorer 上查看
# https://explorer.solana.com/address/<PROGRAM_ID>?cluster=devnet
```

输出示例：

```
Program Id: CalcXXX...YourProgramID
Owner: BPFLoaderUpgradeab1e11111111111111111111111
ProgramData Address: PrgDXXX...
Authority: 7nY...YourWalletAddress
Last Deployed In Slot: 123456789
Data Length: 196608 (0x30000) bytes
Balance: 1.36 SOL
```

---

## 七、Anchor 进阶概念

### 7.1 CPI（跨程序调用）

CPI 是 Solana 程序之间相互调用的机制，Anchor 简化了 CPI 的编写：

```rust
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

// CPI 调用示例：转移 SPL Token
pub fn transfer_tokens(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
    let cpi_accounts = Transfer {
        from: ctx.accounts.from_token_account.to_account_info(),
        to: ctx.accounts.to_token_account.to_account_info(),
        authority: ctx.accounts.authority.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

    token::transfer(cpi_ctx, amount)?;
    Ok(())
}

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(mut)]
    pub from_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub to_token_account: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
```

### 7.2 PDA 签名（CPI with PDA Signer）

```rust
// 使用 PDA 作为签名者进行 CPI 调用
pub fn transfer_with_pda(ctx: Context<PdaTransfer>, amount: u64) -> Result<()> {
    let seeds = &[
        b"vault",
        ctx.accounts.authority.key.as_ref(),
        &[ctx.bumps.vault],
    ];
    let signer_seeds = &[&seeds[..]];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_token.to_account_info(),
            to: ctx.accounts.user_token.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );

    token::transfer(cpi_ctx, amount)?;
    Ok(())
}
```

### 7.3 事件（Events）

```rust
// 定义事件
#[event]
pub struct CalculationEvent {
    pub operator: Pubkey,
    pub operation: String,
    pub operand_a: i64,
    pub operand_b: i64,
    pub result: i64,
    pub timestamp: i64,
}

// 在指令中触发事件
pub fn add(ctx: Context<Calculate>, a: i64, b: i64) -> Result<()> {
    let calculator = &mut ctx.accounts.calculator;
    calculator.result = a.checked_add(b).ok_or(ErrorCode::Overflow)?;

    // 触发事件
    emit!(CalculationEvent {
        operator: ctx.accounts.owner.key(),
        operation: "add".to_string(),
        operand_a: a,
        operand_b: b,
        result: calculator.result,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}
```

**TypeScript 监听事件：**

```typescript
// 监听链上事件
const listener = program.addEventListener("calculationEvent", (event, slot) => {
  console.log("Event:", event);
  console.log("Operator:", event.operator.toString());
  console.log("Operation:", event.operation);
  console.log("Result:", event.result.toNumber());
});

// 移除监听
await program.removeEventListener(listener);
```

---

## 八、安全最佳实践

### 8.1 常见安全问题

```
┌────────────────────────────────────────────────────────────────┐
│                Anchor 安全检查清单                               │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ✅ 始终使用 has_one 校验账户所有权                              │
│     #[account(mut, has_one = owner)]                           │
│                                                                │
│  ✅ 使用 constraint 添加自定义校验                               │
│     #[account(constraint = amount > 0 @ ErrorCode::Invalid)]   │
│                                                                │
│  ✅ 使用 checked_add / checked_sub 防止溢出                     │
│     a.checked_add(b).ok_or(ErrorCode::Overflow)?               │
│                                                                │
│  ✅ PDA 使用 seeds + bump 确保唯一性                            │
│     #[account(seeds = [...], bump)]                            │
│                                                                │
│  ✅ 避免使用 UncheckedAccount（除非手动校验）                    │
│     /// CHECK: 已手动校验                                      │
│     pub unsafe_account: UncheckedAccount<'info>                │
│                                                                │
│  ✅ 关闭账户时使用 close 约束，防止复活攻击                      │
│     #[account(mut, close = receiver)]                          │
│                                                                │
│  ❌ 不要信任客户端传入的数据，始终做服务端校验                    │
│  ❌ 不要忽略 Signer 检查                                       │
│  ❌ 不要在生产环境使用硬编码密钥                                 │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### 8.2 常见攻击向量

| 攻击类型 | 说明 | Anchor 防护 |
|----------|------|-------------|
| **缺少签名校验** | 未验证调用者身份 | `Signer<'info>` 自动校验 |
| **缺少所有权校验** | 未验证账户 owner | `Account<'info, T>` 自动校验 owner |
| **整数溢出** | 算术运算溢出 | 使用 `checked_*` 系列方法 |
| **账户复活** | 关闭的账户被重新使用 | `close` 约束 + discriminator 校验 |
| **PDA 替换** | 伪造 PDA 账户 | `seeds + bump` 约束自动校验 |
| **重入攻击** | 递归调用漏洞 | Solana 运行时天然防护（单线程执行） |

---

## 九、完整开发工作流

```
 ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
 │  1.初始化 │──►│ 2.编写合约│──►│ 3.编译   │──►│ 4.测试   │
 │  anchor  │   │  lib.rs  │   │  anchor  │   │  anchor  │
 │  init    │   │          │   │  build   │   │  test    │
 └─────────┘   └──────────┘   └──────────┘   └──────────┘
                                                    │
                                              ┌─────▼─────┐
                                              │ 测试通过？  │
                                              └─────┬─────┘
                                           是 │          │ 否
                                              ▼          ▼
                                        ┌──────────┐  返回步骤2
                                        │ 5.部署到  │  修复问题
                                        │  Devnet  │
                                        │  anchor  │
                                        │  deploy  │
                                        └──────────┘
                                              │
                                              ▼
                                        ┌──────────┐
                                        │ 6.集成   │
                                        │  前端    │
                                        │  测试    │
                                        └──────────┘
                                              │
                                              ▼
                                        ┌──────────┐
                                        │ 7.部署到  │
                                        │  Mainnet │
                                        └──────────┘
```

---
