---
title: Solana 账户模型详解
date: 2026-02-27 11:29:04
tags: Solana
---

> Solana 的账户模型是其区块链架构的核心基石。与以太坊的"智能合约=代码+数据"模式不同，Solana 采用了**程序与数据分离**的独特设计。本文将深入剖析 Solana 的账户体系，涵盖各种账户类型、PDA 账户机制，并配合代码示例和图解，帮助你全面掌握 Solana 账户模型。

## 一、Solana 账户模型总览

### 1.1 核心概念

在 Solana 中，**一切皆账户（Everything is an Account）**。无论是用户钱包、代币余额、还是智能合约（Program），都以账户的形式存储在链上。

每个账户由以下字段组成：

| 字段 | 类型 | 说明 |
|------|------|------|
| `lamports` | `u64` | 账户余额（单位：lamport，1 SOL = 10⁹ lamports） |
| `data` | `Vec<u8>` | 存储的数据（字节数组） |
| `owner` | `Pubkey` | 拥有该账户的程序（Program） |
| `executable` | `bool` | 是否为可执行程序 |
| `rent_epoch` | `u64` | 下次需要支付租金的 epoch |

```
┌─────────────────────────────────────────────┐
│              Solana Account                  │
├─────────────────────────────────────────────┤
│  Public Key (地址): 32 bytes                 │
├─────────────────────────────────────────────┤
│  lamports:    1_000_000_000  (1 SOL)        │
│  data:        [0u8; 128]    (128 字节数据)   │
│  owner:       11111...1111  (System Program) │
│  executable:  false                          │
│  rent_epoch:  365                            │
└─────────────────────────────────────────────┘
```

### 1.2 账户模型设计哲学

```
  以太坊模型                         Solana 模型
┌──────────────┐              ┌──────────────┐    ┌──────────────┐
│  Smart       │              │   Program    │    │    Account   │
│  Contract    │              │  (可执行)     │    │   (数据存储)  │
│              │              │              │    │              │
│ ┌──────────┐ │              │  只含代码     │    │  只含数据     │
│ │  代码     │ │              │  不可修改     │    │  可读可写     │
│ ├──────────┤ │     vs       │  无状态      │    │  有状态       │
│ │  状态     │ │  ========>  │              │    │              │
│ │  数据     │ │              │  owner:      │    │  owner:      │
│ └──────────┘ │              │  BPFLoader   │    │  某个Program  │
└──────────────┘              └──────────────┘    └──────────────┘
                                     │                   ▲
                                     │     拥有 & 操作     │
                                     └───────────────────┘
```

> **关键原则**：在 Solana 中，**只有账户的 owner 程序才能修改该账户的数据**。这是 Solana 安全模型的基石。

---

## 二、Solana 账户类型全景图

```
                        ┌─────────────────────┐
                        │   Solana Accounts    │
                        └─────────┬───────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            │                     │                     │
   ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
   │  系统账户        │  │  程序账户        │  │  数据账户        │
   │  System Account  │  │  Program Account │  │  Data Account   │
   │                  │  │                  │  │                  │
   │  • 用户钱包      │  │  • Native Program│  │  • Token Account │
   │  • 普通SOL账户   │  │  • BPF Program   │  │  • PDA Account   │
   │                  │  │  • Upgradeable   │  │  • Mint Account  │
   └──────────────────┘  └──────────────────┘  │  • Associated    │
                                               │    Token Account │
                                               └──────────────────┘
```

### 2.1 系统账户（System Account）

系统账户是最基础的账户类型，即普通的**用户钱包**。

**特征**：
- `owner` = System Program (`11111111111111111111111111111111`)
- `executable` = false
- `data` = 空（0 字节）
- 由 Ed25519 密钥对生成

```rust
use solana_sdk::signature::Keypair;
use solana_sdk::signer::Signer;

// 生成新的密钥对（即创建新账户）
let keypair = Keypair::new();
let public_key = keypair.pubkey();

println!("公钥（地址）: {}", public_key);
// 输出类似: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
```

```typescript
// 使用 @solana/web3.js 创建钱包
import { Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";

// 生成新密钥对
const wallet = Keypair.generate();
console.log("公钥:", wallet.publicKey.toBase58());
console.log("私钥:", wallet.secretKey);

// 连接到 devnet 并空投 SOL
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const airdropSig = await connection.requestAirdrop(
  wallet.publicKey,
  2 * LAMPORTS_PER_SOL
);
await connection.confirmTransaction(airdropSig);

// 查询账户信息
const accountInfo = await connection.getAccountInfo(wallet.publicKey);
console.log("余额:", accountInfo.lamports / LAMPORTS_PER_SOL, "SOL");
console.log("Owner:", accountInfo.owner.toBase58());
// Owner: 11111111111111111111111111111111 (System Program)
```

### 2.2 程序账户（Program Account）

程序账户存储可执行的代码（类似以太坊的智能合约）。

**特征**：
- `executable` = true
- `data` = 编译后的 BPF 字节码
- 程序账户**不存储状态**，状态存储在独立的数据账户中

```
┌─────────────────────────────────────────────────────┐
│                  程序账户体系                          │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────┐   ┌───────────────┐                │
│  │ Native      │   │ BPF/SBF       │                │
│  │ Programs    │   │ Programs      │                │
│  │             │   │               │                │
│  │ • System    │   │ ┌───────────┐ │                │
│  │   Program   │   │ │ Program   │ │                │
│  │ • Token     │   │ │ Account   │ │                │
│  │   Program   │   │ │executable │ │                │
│  │ • Stake     │   │ │ =true     │ │                │
│  │   Program   │   │ └─────┬─────┘ │                │
│  │ • Vote      │   │       │       │                │
│  │   Program   │   │ ┌─────▼─────┐ │                │
│  │ • BPF       │   │ │ Program   │ │                │
│  │   Loader    │   │ │ Data Acct │ │                │
│  └─────────────┘   │ │ (字节码)   │ │                │
│                     │ └───────────┘ │                │
│                     └───────────────┘                │
└─────────────────────────────────────────────────────┘
```

#### 原生程序（Native Programs）

| 程序名称 | 地址 | 功能 |
|---------|------|------|
| System Program | `11111111111111111111111111111111` | 创建账户、转账 SOL |
| Token Program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | SPL Token 操作 |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | 新一代 Token 标准 |
| Associated Token | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | 管理关联代币账户 |
| Stake Program | `Stake11111111111111111111111111111111111111` | 质押管理 |
| Vote Program | `Vote111111111111111111111111111111111111111` | 验证者投票 |

#### 可升级程序结构

```
  可升级程序（Upgradeable Program）架构：

  ┌──────────────┐         ┌──────────────────┐
  │  Program     │         │  ProgramData     │
  │  Account     │────────▶│  Account         │
  │              │  指向    │                  │
  │  executable  │         │  实际的字节码      │
  │  = true      │         │  upgrade_auth     │
  │              │         │  slot (部署slot)   │
  └──────────────┘         └──────────────────┘
        ▲                          ▲
        │                          │
  用户通过此地址                 升级权限由
  调用程序                     upgrade_authority 控制
```

### 2.3 数据账户（Data Account）

数据账户用于存储程序运行时的状态。

```rust
use anchor_lang::prelude::*;

// 使用 Anchor 框架定义数据账户
#[account]
pub struct UserProfile {
    pub authority: Pubkey,    // 32 bytes
    pub name: String,         // 4 + len bytes
    pub level: u8,            // 1 byte
    pub experience: u64,      // 8 bytes
    pub created_at: i64,      // 8 bytes
}

// 计算账户所需空间
impl UserProfile {
    pub const MAX_NAME_LEN: usize = 32;
    pub const SPACE: usize = 8   // Anchor discriminator
        + 32                      // authority (Pubkey)
        + 4 + Self::MAX_NAME_LEN  // name (String)
        + 1                       // level (u8)
        + 8                       // experience (u64)
        + 8;                      // created_at (i64)
}
```

---

## 三、Token 相关账户

### 3.1 Mint Account（代币铸造账户）

每种 SPL Token 都有一个唯一的 Mint Account，定义代币的属性。

```
┌─────────────────────────────────────┐
│           Mint Account              │
├─────────────────────────────────────┤
│  mint_authority:   Pubkey | None    │  ← 谁能铸造新代币
│  supply:           u64             │  ← 当前总供应量
│  decimals:         u8              │  ← 精度（如 6 = USDC）
│  is_initialized:   bool            │  ← 是否已初始化
│  freeze_authority: Pubkey | None    │  ← 谁能冻结账户
├─────────────────────────────────────┤
│  owner: Token Program               │
│  data size: 82 bytes                │
└─────────────────────────────────────┘
```

```typescript
import {
  createMint,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// 创建新的代币 Mint
const mint = await createMint(
  connection,        // 连接
  payer,             // 付款人
  mintAuthority,     // 铸造权限
  freezeAuthority,   // 冻结权限 (可为 null)
  9                  // decimals 精度
);

console.log("Mint 地址:", mint.toBase58());

// 查询 Mint 信息
const mintInfo = await getMint(connection, mint);
console.log("总供应量:", mintInfo.supply);
console.log("精度:", mintInfo.decimals);
console.log("铸造权限:", mintInfo.mintAuthority?.toBase58());
```

### 3.2 Token Account（代币账户）

每个用户持有某种代币时，需要一个对应的 Token Account。

```
  一个用户持有多种代币的结构：

  ┌──────────┐
  │  User    │
  │  Wallet  │     Token Account (USDC)        Token Account (SOL-wrapped)
  │  (系统   │    ┌──────────────────┐        ┌──────────────────┐
  │   账户)  │───▶│ mint: USDC Mint  │        │ mint: wSOL Mint  │
  │          │    │ owner: User      │        │ owner: User      │
  └──────────┘    │ amount: 1000.00  │        │ amount: 5.5      │
                  │ delegate: None   │        │ delegate: None   │
                  │ state: Init      │        │ state: Init      │
                  └──────────────────┘        └──────────────────┘
                           │                           │
                           ▼                           ▼
                  ┌──────────────────┐        ┌──────────────────┐
                  │  USDC Mint Acct  │        │  wSOL Mint Acct  │
                  │  decimals: 6     │        │  decimals: 9     │
                  │  supply: 10B     │        │  supply: 1M      │
                  └──────────────────┘        └──────────────────┘
```

```
┌─────────────────────────────────────┐
│          Token Account               │
├─────────────────────────────────────┤
│  mint:             Pubkey           │  ← 属于哪种代币
│  owner:            Pubkey           │  ← 代币持有者
│  amount:           u64             │  ← 代币数量
│  delegate:         Pubkey | None    │  ← 委托人
│  state:            AccountState     │  ← 状态(初始化/冻结)
│  is_native:        u64 | None       │  ← 是否为原生 SOL 包装
│  delegated_amount: u64             │  ← 委托数量
│  close_authority:  Pubkey | None    │  ← 关闭权限
├─────────────────────────────────────┤
│  owner: Token Program                │
│  data size: 165 bytes                │
└─────────────────────────────────────┘
```

### 3.3 Associated Token Account（ATA，关联代币账户）

ATA 是一种**确定性派生**的 Token Account，通过用户钱包地址和 Mint 地址可以唯一确定。

```
  ATA 地址推导过程：

  ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
  │  User Wallet │     │  Token Mint  │     │  Token Program   │
  │  Address     │     │  Address     │     │  ID              │
  └──────┬───────┘     └──────┬───────┘     └────────┬─────────┘
         │                    │                      │
         └────────────┬───────┘──────────────────────┘
                      │
                      ▼
           ┌─────────────────────┐
           │  PDA 推导 (seeds)    │
           │                     │
           │  seeds = [          │
           │    wallet_address,  │
           │    token_program_id,│
           │    mint_address     │
           │  ]                  │
           │  program =          │
           │  AToken Program     │
           └──────────┬──────────┘
                      │
                      ▼
           ┌─────────────────────┐
           │  Associated Token   │
           │  Account (ATA)      │
           │                     │
           │  确定性、唯一的       │
           │  代币账户地址         │
           └─────────────────────┘
```

```typescript
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

// 方法1：计算 ATA 地址
const ata = await getAssociatedTokenAddress(
  mintAddress,           // 代币 Mint 地址
  walletAddress,         // 用户钱包地址
);
console.log("ATA 地址:", ata.toBase58());

// 方法2：获取或创建 ATA（推荐）
const tokenAccount = await getOrCreateAssociatedTokenAccount(
  connection,
  payer,                 // 付费者
  mintAddress,           // 代币 Mint
  walletAddress,         // 所有者
);
console.log("ATA:", tokenAccount.address.toBase58());
console.log("余额:", tokenAccount.amount);
```

---

## 四、PDA 账户（Program Derived Address）

### 4.1 什么是 PDA？

**PDA（Program Derived Address）** 是 Solana 中最重要的概念之一。它是一种**由程序确定性派生**的特殊地址，**没有对应的私钥**，因此只能由其关联的程序来签名操作。

```
  普通账户 vs PDA 账户：

  普通账户 (Keypair)                 PDA 账户
  ┌──────────────────┐             ┌──────────────────┐
  │  有私钥 ✅        │             │  无私钥 ❌        │
  │  用户可签名 ✅     │             │  用户不能签名 ❌   │
  │  在 Ed25519       │             │  不在 Ed25519     │
  │  曲线上 ✅        │             │  曲线上 ❌        │
  │                   │             │                   │
  │  地址 = 公钥      │             │  地址 = 哈希推导   │
  │                   │             │  程序可代签 ✅     │
  └──────────────────┘             └──────────────────┘
```

### 4.2 PDA 推导原理

```
  PDA 推导流程：

  ┌─────────────────────────────────────────────────┐
  │                                                 │
  │   seeds (种子)          program_id (程序地址)     │
  │   ┌──────────┐         ┌──────────────┐         │
  │   │ "user"   │         │ Program ID   │         │
  │   │ user_pk  │         │              │         │
  │   └─────┬────┘         └──────┬───────┘         │
  │         │                     │                 │
  │         └──────────┬──────────┘                 │
  │                    │                            │
  │                    ▼                            │
  │         ┌──────────────────┐                    │
  │         │   SHA256 Hash    │                    │
  │         │                  │                    │
  │         │ sha256(seeds +   │                    │
  │         │  program_id +    │                    │
  │         │  "ProgramDerived │                    │
  │         │   Address")      │                    │
  │         └────────┬─────────┘                    │
  │                  │                              │
  │                  ▼                              │
  │         ┌──────────────────┐                    │
  │         │ 在 Ed25519 曲线上?│                    │
  │         └────────┬─────────┘                    │
  │                  │                              │
  │           ┌──────┴──────┐                       │
  │           │             │                       │
  │         Yes ❌         No ✅                     │
  │           │             │                       │
  │     bump -= 1      找到有效 PDA!                 │
  │     重新计算        返回 (address, bump)          │
  │                                                 │
  │   bump 从 255 递减到 0，直到找到不在曲线上的点       │
  │   第一个有效的 bump 称为 "canonical bump"          │
  │                                                 │
  └─────────────────────────────────────────────────┘
```

### 4.3 PDA 代码实现

#### Rust (Anchor) 实现

```rust
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod pda_example {
    use super::*;

    // 创建 PDA 账户
    pub fn initialize_user(
        ctx: Context<InitializeUser>,
        name: String,
    ) -> Result<()> {
        let user_profile = &mut ctx.accounts.user_profile;
        user_profile.authority = ctx.accounts.authority.key();
        user_profile.name = name;
        user_profile.bump = ctx.bumps.user_profile;
        Ok(())
    }

    // 使用 PDA 签名进行 CPI 调用
    pub fn transfer_from_vault(
        ctx: Context<TransferFromVault>,
        amount: u64,
    ) -> Result<()> {
        let authority_key = ctx.accounts.authority.key();

        // 构建 PDA signer seeds
        let seeds = &[
            b"vault",
            authority_key.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // CPI: 从 PDA vault 转账
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.authority.to_account_info(),
            },
            signer_seeds,
        );

        anchor_lang::system_program::transfer(transfer_ctx, amount)?;
        Ok(())
    }
}

// 初始化用户 PDA 账户的上下文
#[derive(Accounts)]
pub struct InitializeUser<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,                                    // 创建新账户
        payer = authority,                       // 付费者
        space = UserProfile::SPACE,              // 账户大小
        seeds = [b"user", authority.key().as_ref()],  // PDA seeds
        bump,                                    // 自动计算 bump
    )]
    pub user_profile: Account<'info, UserProfile>,

    pub system_program: Program<'info, System>,
}

// 金库转账上下文
#[derive(Accounts)]
pub struct TransferFromVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", authority.key().as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct UserProfile {
    pub authority: Pubkey,
    pub name: String,
    pub bump: u8,
}

impl UserProfile {
    pub const SPACE: usize = 8 + 32 + (4 + 32) + 1;
}

#[account]
pub struct Vault {
    pub authority: Pubkey,
    pub bump: u8,
}
```

#### TypeScript 客户端实现

```typescript
import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

const PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

// ============================================
// 方法1：使用 findProgramAddressSync 推导 PDA
// ============================================
const [userProfilePDA, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("user"),                    // seed: "user"
    walletKeypair.publicKey.toBuffer(),     // seed: 用户公钥
  ],
  PROGRAM_ID
);

console.log("PDA 地址:", userProfilePDA.toBase58());
console.log("Bump:", bump);

// ============================================
// 方法2：使用 createProgramAddressSync（已知 bump）
// ============================================
const pdaAddress = PublicKey.createProgramAddressSync(
  [
    Buffer.from("user"),
    walletKeypair.publicKey.toBuffer(),
    Buffer.from([bump]),  // 传入已知的 bump
  ],
  PROGRAM_ID
);

// ============================================
// 使用 Anchor 调用初始化 PDA 账户
// ============================================
const program = anchor.workspace.PdaExample;

const tx = await program.methods
  .initializeUser("Alice")
  .accounts({
    authority: walletKeypair.publicKey,
    userProfile: userProfilePDA,
    systemProgram: SystemProgram.programId,
  })
  .signers([walletKeypair])
  .rpc();

console.log("交易签名:", tx);

// 读取 PDA 账户数据
const account = await program.account.userProfile.fetch(userProfilePDA);
console.log("用户名:", account.name);
console.log("权限:", account.authority.toBase58());
console.log("Bump:", account.bump);
```

### 4.4 PDA 的典型应用场景

```
  ┌───────────────────────────────────────────────────────────────┐
  │                    PDA 常见使用场景                             │
  ├───────────────────────────────────────────────────────────────┤
  │                                                               │
  │  1️⃣  确定性数据存储                                            │
  │  ┌─────────┐  seeds=["profile", user]  ┌──────────────┐      │
  │  │  User   │ ──────────────────────▶  │ UserProfile  │      │
  │  │  Wallet │                          │ PDA Account  │      │
  │  └─────────┘                          └──────────────┘      │
  │                                                               │
  │  2️⃣  程序金库 / 资金托管                                       │
  │  ┌─────────┐  seeds=["vault"]  ┌──────────────────┐          │
  │  │ Program │ ────────────────▶ │ Vault PDA        │          │
  │  │         │                   │ (持有 SOL/Token)  │          │
  │  └─────────┘                   └──────────────────┘          │
  │                                                               │
  │  3️⃣  权限管理 / 签名代理                                       │
  │  ┌─────────┐  seeds=["auth"]  ┌──────────────────┐           │
  │  │ Program │ ───────────────▶ │ Authority PDA    │           │
  │  │         │                  │ (CPI 签名)       │           │
  │  └─────────┘                  └──────────────────┘           │
  │                                                               │
  │  4️⃣  映射关系 (类似 HashMap)                                   │
  │  seeds=["order", user, order_id]  ──▶  OrderAccount           │
  │  seeds=["bid", auction, bidder]   ──▶  BidAccount             │
  │  seeds=["ticket", event, seat]    ──▶  TicketAccount          │
  │                                                               │
  │  5️⃣  跨程序调用签名 (CPI Signer)                               │
  │  Program A ──CPI──▶ Program B                                 │
  │  PDA of A 可作为 B 中的 signer                                 │
  │                                                               │
  └───────────────────────────────────────────────────────────────┘
```

### 4.5 PDA 签名机制 (invoke_signed)

PDA 没有私钥，但程序可以通过 `invoke_signed` 为其"签名"：

```rust
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::invoke_signed,
    pubkey::Pubkey,
    system_instruction,
};

pub fn transfer_sol_from_pda(
    program_id: &Pubkey,
    pda_account: &AccountInfo,
    recipient: &AccountInfo,
    system_program: &AccountInfo,
    amount: u64,
    user_pubkey: &Pubkey,
    bump_seed: u8,
) -> ProgramResult {
    // 定义 PDA 的 seeds（必须与推导时一致）
    let seeds: &[&[u8]] = &[
        b"vault",
        user_pubkey.as_ref(),
        &[bump_seed],
    ];

    // 使用 invoke_signed 代替 invoke
    // Runtime 会验证 seeds + program_id 确实能推导出该 PDA 地址
    invoke_signed(
        &system_instruction::transfer(
            pda_account.key,
            recipient.key,
            amount,
        ),
        &[
            pda_account.clone(),
            recipient.clone(),
            system_program.clone(),
        ],
        &[seeds],  // signer_seeds
    )?;

    Ok(())
}
```

```
  invoke_signed 签名验证流程：

  ┌──────────────┐
  │  Program A   │
  │              │
  │ invoke_signed│
  │ (instruction,│
  │  accounts,   │
  │  signer_seeds│──────┐
  │  )           │      │
  └──────────────┘      │
                        ▼
              ┌──────────────────┐
              │  Solana Runtime  │
              │                  │
              │  验证:            │
              │  hash(seeds +    │
              │  program_id)     │
              │  == pda_address? │
              └────────┬─────────┘
                       │
                 ┌─────┴─────┐
                 │           │
               Yes ✅      No ❌
                 │           │
           标记 PDA      交易失败
           为 signer     返回错误
                 │
                 ▼
         ┌──────────────┐
         │  Program B   │
         │  (被调用方)   │
         │              │
         │  看到 PDA 是  │
         │  合法 signer  │
         └──────────────┘
```

---

## 五、账户的租金机制（Rent）

### 5.1 Rent 机制说明

Solana 要求账户存储数据需要支付**租金**。如果账户余额达到 **Rent-Exempt（免租）** 阈值，则永远不需要支付租金。

```
  租金机制示意图：

  ┌──────────────────────────────────────────────┐
  │              账户余额 vs 租金                   │
  ├──────────────────────────────────────────────┤
  │                                              │
  │  余额                                        │
  │   ▲                                          │
  │   │                                          │
  │   │  ═══════════════════  Rent-Exempt 阈值    │
  │   │  ─ ─ ─ ─ ─ ─ ─ ─ ─   (约 2年租金)        │
  │   │                                          │
  │   │  ✅ 余额 >= 阈值: 永不扣租                  │
  │   │  ❌ 余额 < 阈值:  每个 epoch 扣租           │
  │   │  💀 余额 = 0:     账户被回收               │
  │   │                                          │
  │   └──────────────────────────▶ 时间            │
  └──────────────────────────────────────────────┘
```

```typescript
// 计算 Rent-Exempt 所需的最低余额
const dataSize = 165; // Token Account 的数据大小
const rentExemptBalance = await connection.getMinimumBalanceForRentExemption(dataSize);
console.log(`${dataSize} 字节账户需要: ${rentExemptBalance / LAMPORTS_PER_SOL} SOL`);
// 约 0.00203928 SOL
```

```rust
// Anchor 中创建账户时自动计算租金
#[derive(Accounts)]
pub struct CreateAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 8,  // discriminator + pubkey + u64
        // Anchor 自动计算并收取 rent-exempt 金额
    )]
    pub my_account: Account<'info, MyData>,

    pub system_program: Program<'info, System>,
}
```

---

## 六、账户所有权与安全模型

### 6.1 所有权规则

```
  ┌────────────────────────────────────────────────────────┐
  │              Solana 账户所有权规则                        │
  ├────────────────────────────────────────────────────────┤
  │                                                        │
  │  规则 1: 只有 owner 可以修改 data                        │
  │  ┌──────────┐    修改 data ✅    ┌──────────┐          │
  │  │ Program A│ ──────────────▶  │ Account  │          │
  │  │ (owner)  │                  │ owner: A │          │
  │  └──────────┘                  └──────────┘          │
  │                                                        │
  │  ┌──────────┐    修改 data ❌    ┌──────────┐          │
  │  │ Program B│ ───────✗────▶   │ Account  │          │
  │  │ (非owner)│                  │ owner: A │          │
  │  └──────────┘                  └──────────┘          │
  │                                                        │
  │  规则 2: 只有 owner 可以扣减 lamports                    │
  │  (任何程序都可以增加 lamports)                            │
  │                                                        │
  │  规则 3: 只有 System Program 可以分配账户空间              │
  │                                                        │
  │  规则 4: 只有 owner 可以变更 owner                       │
  │  (新 owner 必须是一个程序)                               │
  │                                                        │
  │  规则 5: 新创建的账户 owner 默认是 System Program         │
  │                                                        │
  └────────────────────────────────────────────────────────┘
```

### 6.2 常见安全检查

```rust
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SecureOperation<'info> {
    // ✅ 检查签名者
    pub authority: Signer<'info>,

    // ✅ 检查 PDA seeds 和 bump
    #[account(
        mut,
        seeds = [b"user", authority.key().as_ref()],
        bump = user_profile.bump,
        // ✅ 检查 authority 匹配
        has_one = authority,
    )]
    pub user_profile: Account<'info, UserProfile>,

    // ✅ 检查 Token Account 的 mint 和 owner
    #[account(
        mut,
        token::mint = mint,
        token::authority = authority,
    )]
    pub token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}
```

---

## 七、实战示例：完整的 PDA 应用

### 7.1 计数器程序（Counter Program）

一个经典的 PDA 应用示例——每个用户拥有自己的计数器：

```rust
use anchor_lang::prelude::*;

declare_id!("Counter111111111111111111111111111111111111");

#[program]
pub mod counter {
    use super::*;

    /// 初始化用户的计数器 PDA
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.authority = ctx.accounts.user.key();
        counter.count = 0;
        counter.bump = ctx.bumps.counter;

        msg!("Counter initialized for user: {}", counter.authority);
        Ok(())
    }

    /// 递增计数器
    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter.count.checked_add(1)
            .ok_or(ErrorCode::Overflow)?;

        msg!("Count is now: {}", counter.count);
        Ok(())
    }

    /// 重置计数器
    pub fn reset(ctx: Context<Reset>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = 0;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = Counter::SPACE,
        seeds = [b"counter", user.key().as_ref()],
        bump,
    )]
    pub counter: Account<'info, Counter>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"counter", user.key().as_ref()],
        bump = counter.bump,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub counter: Account<'info, Counter>,
}

#[derive(Accounts)]
pub struct Reset<'info> {
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"counter", user.key().as_ref()],
        bump = counter.bump,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub counter: Account<'info, Counter>,
}

#[account]
pub struct Counter {
    pub authority: Pubkey,  // 32 bytes
    pub count: u64,         // 8 bytes
    pub bump: u8,           // 1 byte
}

impl Counter {
    pub const SPACE: usize = 8 + 32 + 8 + 1; // 49 bytes
}

#[error_code]
pub enum ErrorCode {
    #[msg("Counter overflow")]
    Overflow,
    #[msg("Unauthorized access")]
    Unauthorized,
}
```

### 7.2 客户端交互

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { Counter } from "../target/types/counter";

// 设置 Provider
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.Counter as Program<Counter>;
const user = provider.wallet.publicKey;

// 推导 PDA 地址
const [counterPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("counter"), user.toBuffer()],
  program.programId
);

// 初始化计数器
async function initialize() {
  const tx = await program.methods
    .initialize()
    .accounts({
      user: user,
      counter: counterPDA,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("初始化交易:", tx);
}

// 递增计数器
async function increment() {
  const tx = await program.methods
    .increment()
    .accounts({
      user: user,
      counter: counterPDA,
    })
    .rpc();

  // 读取计数器值
  const account = await program.account.counter.fetch(counterPDA);
  console.log("当前计数:", account.count.toNumber());
}

// 批量递增
async function batchIncrement(times: number) {
  for (let i = 0; i < times; i++) {
    await increment();
  }
}

// 执行
await initialize();
await batchIncrement(5);

// 最终读取
const finalAccount = await program.account.counter.fetch(counterPDA);
console.log("最终计数:", finalAccount.count.toNumber()); // 5
console.log("Authority:", finalAccount.authority.toBase58());
console.log("Bump:", finalAccount.bump);
```

---

## 八、总结与速查表

### 8.1 账户类型速查

| 账户类型 | Owner | Executable | Data | 用途 |
|---------|-------|------------|------|------|
| 系统账户 | System Program | false | 空 | 用户钱包 |
| 程序账户 | BPF Loader | true | 字节码 | 智能合约 |
| 数据账户 | 自定义 Program | false | 自定义结构 | 状态存储 |
| Mint 账户 | Token Program | false | 82 bytes | 代币定义 |
| Token 账户 | Token Program | false | 165 bytes | 代币余额 |
| ATA | Token Program | false | 165 bytes | 关联代币账户 |
| PDA 账户 | 自定义 Program | false | 自定义 | 确定性派生 |

### 8.2 PDA 使用要诀

```
  ┌─────────────────────────────────────────────────────┐
  │               PDA 最佳实践                            │
  ├─────────────────────────────────────────────────────┤
  │                                                     │
  │  ✅ 始终使用 canonical bump（findProgramAddress       │
  │     返回的第一个有效 bump）                             │
  │                                                     │
  │  ✅ 将 bump 存储在 PDA 账户数据中，避免重复计算          │
  │                                                     │
  │  ✅ seeds 设计要唯一，防止地址碰撞                      │
  │                                                     │
  │  ✅ 使用 Anchor 的 seeds 约束自动验证                   │
  │                                                     │
  │  ❌ 不要使用用户提供的 bump，始终自行推导验证             │
  │                                                     │
  │  ❌ 不要假设 PDA 初始余额为 0                          │
  │                                                     │
  │  ❌ 不要在 seeds 中使用可变长度数据而不加定界符           │
  │                                                     │
  └─────────────────────────────────────────────────────┘
```

### 8.3 完整账户关系图

```
  ┌─────────────────────────────────────────────────────────────┐
  │                                                             │
  │   User Wallet ──────┬────────── System Program (owner)      │
  │   (Keypair)         │                                       │
  │                     │                                       │
  │                     ├──▶ ATA (USDC) ─── Token Program       │
  │                     │      └──▶ USDC Mint Account           │
  │                     │                                       │
  │                     ├──▶ ATA (wSOL) ─── Token Program       │
  │                     │      └──▶ wSOL Mint Account           │
  │                     │                                       │
  │                     ├──▶ PDA: UserProfile                   │
  │                     │      seeds=["user", wallet]           │
  │                     │      owner: My Program                │
  │                     │                                       │
  │                     └──▶ PDA: Counter                       │
  │                            seeds=["counter", wallet]        │
  │                            owner: Counter Program           │
  │                                                             │
  │   My Program ──────────── BPF Loader (owner)                │
  │   (executable)     │                                        │
  │                    └──▶ ProgramData Account                 │
  │                          (存储字节码 + 升级权限)              │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

---

> **参考资源**：
> - [Solana 官方文档 - Accounts](https://solana.com/docs/core/accounts)
> - [Solana Cookbook - PDA](https://solanacookbook.com/core-concepts/pdas.html)
> - [Anchor 框架文档](https://www.anchor-lang.com/)
> - [SPL Token 文档](https://spl.solana.com/token)