---
title: 多签（Multisig）深入解析：从近期重大安全事故说起
date: 2026-05-18 15:37:43
tags: 区块链
---

2025 年 2 月 21 日，加密货币交易所 ByBit 遭遇史上最大规模单次盗窃，约 **15 亿美元** 的 ETH 被黑客转走。

攻击者是朝鲜国家黑客组织 Lazarus Group。他们并不是直接爆破私钥，而是入侵了 Safe{Wallet}（前身 Gnosis Safe）的前端服务，篡改了 JavaScript 脚本，让 ByBit 的多签操作员在看到"正常转账界面"的同时，实际签署的却是一笔恶意合约升级交易。

这件事令人不安的地方在于：

**ByBit 用的就是多签钱包。**

不是单签，不是简单的热钱包。是号称行业最佳实践的 3-of-3 多签冷钱包。

然而还是被偷了。

---

这就引出了本文想深入讨论的核心问题：

- 多签到底是什么，它解决的是什么问题
- 多签有哪几种实现方式，各有什么权衡
- 密码学层面的多签（阈值签名）和合约层面的多签有什么根本区别
- ByBit 这类攻击说明了什么：多签的局限与真正的安全边界在哪里
- 用 Rust 实现一个 m-of-n 多签验证器是什么感觉

---

## 一、先从单签的根本脆弱性说起

区块链上最基础的资产控制模型，是"谁拥有私钥，谁就控制资产"。

这个设计很优雅，但它把所有风险集中到了一个点：

```
私钥 ──► 签名 ──► 交易上链 ──► 资产转移
```

私钥丢了？资产永久消失。
私钥泄露？资产即刻被盗。
私钥被单点持有？一次内鬼攻击就够了。

历史上的惨痛案例：

| 时间 | 事件 | 损失 |
|------|------|------|
| 2022-03 | Ronin Bridge 被盗（9 个验证节点中 5 个私钥被盗） | $6.25 亿 |
| 2022-02 | Wormhole 跨链桥漏洞 | $3.2 亿 |
| 2024-10 | Radiant Capital（多签操作员设备遭恶意软件植入） | $5500 万 |
| 2025-02 | ByBit（Safe 前端被篡改，多签操作员被欺骗签名） | $15 亿 |

注意：后两个案例用的都是多签，但依然被盗。后面我们会详细分析原因。

---

## 二、多签（Multisig）的基本概念：m-of-n

多签的核心思想很简单：

> 不再是"一把锁一把钥匙"，而是"一把锁需要 m 把钥匙中的任意 m 把才能打开"。

形式化地写是 **m-of-n**：

- `n`：总共有 n 个参与方，各持有一份私钥
- `m`：需要其中至少 m 个参与方共同签名，交易才有效（`1 ≤ m ≤ n`）

常见配置：

| 配置 | 场景 |
|------|------|
| 2-of-3 | 个人备份：手机 + 硬件钱包 + 纸钱包，坏掉一个也能用 |
| 3-of-5 | 团队金库：5 个高管，需要 3 个同意才能动资金 |
| 5-of-9 | 大型协议：分布在全球的节点，防止单点被攻破 |
| 1-of-2 | 两个人共用账户，任一方可操作（低安全，高便捷） |

m-of-n 的安全逻辑：

- **攻击者**需要同时控制 m 个独立密钥，成本远高于单签
- **内部恶意方**需要串通至少 m 个成员才能盗取资产
- **密钥丢失**：只要丢失的数量不超过 `n - m`，资产仍可恢复

---

## 三、多签的三种实现方式

### 3.1 脚本层多签（Bitcoin P2MS / P2SH）

Bitcoin 是最早原生支持多签的公链。它在脚本层面直接实现了 m-of-n：

```
// P2MS (Pay to MultiSig) 解锁脚本
OP_0
<签名1>
<签名2>
// 锁定脚本
OP_2 <公钥A> <公钥B> <公钥C> OP_3 OP_CHECKMULTISIG
```

**特点**：
- 多签逻辑由比特币脚本虚拟机执行，不依赖任何合约或第三方
- 所有公钥暴露在链上（P2SH 在赎回前隐藏，但花费时仍要暴露）
- Gas（手续费）比单签高，因为脚本更复杂

### 3.2 合约层多签（Ethereum Gnosis Safe）

Ethereum 上没有原生脚本多签，但可以用智能合约实现：

```
用户 A 提交交易 ──►
用户 B 确认交易 ──►  Safe 合约收集签名 ──► 达到 m 个后执行交易
用户 C 确认交易 ──►
```

Gnosis Safe（现在叫 Safe{Wallet}）是这个领域的事实标准，管理着数千亿美元资产。

**特点**：
- 灵活性极高，可以编程各种策略（时间锁、白名单、限额等）
- 多签逻辑在合约里，合约本身可升级——**这正是 ByBit 被攻击的关键点**
- 操作员看到的是 dApp 前端，前端被篡改就可能被欺骗

### 3.3 密码学层多签（MuSig2 / FROST / 阈值 ECDSA）

这是最本质的多签：直接在密码学层面合并多个参与方的签名，产生一个**看起来和普通单签完全一样**的签名。

**代表协议**：
- **Schnorr + MuSig2**：Bitcoin Taproot 使用，n 个参与方共同生成一个聚合公钥，协作产生单一 Schnorr 签名
- **FROST**（Flexible Round-Optimized Schnorr Threshold Signature）：真正的阈值签名，m-of-n 语义，签名过程中不重建完整私钥
- **阈值 ECDSA**：MPC（多方计算）实现的 ECDSA 阈值签名，用于不支持 Schnorr 的链

**密码学多签的最大优势**：

链上看不出来是多签，也不暴露参与方数量和公钥集合，隐私性和手续费都和单签相同。

---

## 四、密码学基础：为什么签名可以"合并"

要理解密码学多签，先要了解 ECDSA 和 Schnorr 签名的基本结构。

### 4.1 ECDSA 签名回顾

设私钥为 $d$，对应公钥 $Q = d \cdot G$（$G$ 是椭圆曲线基点）。

签名一条消息 $m$：

1. 随机生成 nonce $k$，计算 $R = k \cdot G$，取 $r = R_x \bmod n$
2. 计算 $s = k^{-1}(H(m) + r \cdot d) \bmod n$
3. 签名为 $(r, s)$

验证时：检查 $R' = s^{-1} H(m) \cdot G + s^{-1} r \cdot Q$ 的 x 坐标是否等于 $r$。

ECDSA 的问题是 nonce $k$ 的相关性——多方协同产生签名时需要避免 nonce 泄露私钥，这使得阈值 ECDSA 的协议设计非常复杂。

### 4.2 Schnorr 签名的线性性质

Schnorr 签名的结构：

1. 随机 nonce $r$，计算 $R = r \cdot G$
2. 计算挑战值 $e = H(R \| Q \| m)$
3. 签名为 $(R, s)$，其中 $s = r + e \cdot d$

验证：$s \cdot G = R + e \cdot Q$

Schnorr 的神奇之处：**签名分量 $s$ 是线性的**。

多个参与方各自有私钥 $d_1, d_2, \ldots$，公钥聚合为 $Q = Q_1 + Q_2 + \ldots$，各方分别计算 $s_i = r_i + e \cdot d_i$，然后直接相加：

$$s = s_1 + s_2 + \ldots = (r_1 + r_2 + \ldots) + e \cdot (d_1 + d_2 + \ldots)$$

验证时：

$$s \cdot G = R + e \cdot Q \quad \checkmark$$

这就是 MuSig2 的核心思想。

---

## 五、Rust 实现：m-of-n 多签验证器

下面我们用 Rust 实现一个基于 secp256k1 ECDSA 的 **m-of-n 签名收集与验证系统**，模拟合约层多签的核心逻辑（类似 Gnosis Safe 的链下签名收集流程）。

### 5.1 项目依赖

```toml
[package]
name = "multisig"
version = "0.1.0"
edition = "2024"

[dependencies]
k256 = { version = "0.13.4", features = ["ecdsa"] }
rand = "0.10.1"
rand_core = "0.6.4"
serde_json = "1.0.149"
sha2 = "0.11.0"
thiserror = "2.0.18"
```

### 5.2 核心数据结构

```rust
// src/sig/sig.rs
use k256::ecdsa::signature::Verifier;
use k256::ecdsa::{Signature, SigningKey, VerifyingKey};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// 多签配置
#[derive(Debug, Clone)]
pub struct MultiSigPolicy {
    /// 最少需要多少个签名
    pub threshold: usize,
    /// 所有授权参与方的公钥（indexed by participant ID）
    pub participants: Vec<VerifyingKey>,
}

/// 单个参与方的部分签名
#[derive(Debug, Clone)]
pub struct PartialSignature {
    /// 参与方在 participants 列表中的索引
    pub participant_idx: usize,
    /// 签名字节（DER 编码）
    pub signature: Signature,
}

/// 多签会话——收集签名的过程
pub struct MultiSigSession {
    pub policy: MultiSigPolicy,
    /// 待签消息（原始字节，验证时会先做 SHA-256）
    pub message: Vec<u8>,
    /// 已收集的签名
    pub collected: HashMap<usize, Signature>,
}

#[derive(Debug, thiserror::Error)]
pub enum MultiSigError {
    #[error("participant index {0} out of range")]
    InvalidParticipant(usize),
    #[error("signature from participant {0} is invalid")]
    InvalidSignature(usize),
    #[error("duplicate signature from participant {0}")]
    DuplicateSignature(usize),
    #[error("threshold not met: need {need}, got {got}")]
    ThresholdNotMet { need: usize, got: usize },
}
```

### 5.3 多签会话实现

```rust
// src/sig/sig.rs

impl MultiSigPolicy {
    /// 创建一个 m-of-n 策略
    pub fn new(threshold: usize, participants: Vec<VerifyingKey>) -> Self {
        assert!(
            threshold > 0 && threshold <= participants.len(),
            "threshold must satisfy 1 ≤ m ≤ n"
        );
        Self {
            threshold,
            participants,
        }
    }

    /// 生成 n 个随机密钥对（用于测试）
    pub fn generate_test_keys(n: usize) -> (Vec<SigningKey>, Self) {
        let signing_keys: Vec<SigningKey> =
            (0..n).map(|_| SigningKey::random(&mut OsRng)).collect();
        let verifying_keys: Vec<VerifyingKey> =
            signing_keys.iter().map(|sk| *sk.verifying_key()).collect();
        (signing_keys, Self::new(n, verifying_keys)) // 暂时 n-of-n，调用方可按需修改
    }
}

impl MultiSigSession {
    pub fn new(policy: MultiSigPolicy, message: Vec<u8>) -> Self {
        Self {
            policy,
            message,
            collected: HashMap::new(),
        }
    }

    /// 消息摘要（所有操作都基于此摘要）
    pub fn message_digest(&self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        // 加入域分隔前缀，防止跨协议签名重放
        hasher.update(b"multisig-v1:");
        hasher.update(&self.message);
        hasher.finalize().into()
    }

    /// 参与方提交签名
    pub fn submit_signature(
        &mut self,
        participant_idx: usize,
        signature: Signature,
    ) -> Result<(), MultiSigError> {
        // 边界检查
        if participant_idx >= self.policy.participants.len() {
            return Err(MultiSigError::InvalidParticipant(participant_idx));
        }
        // 防止重复提交
        if self.collected.contains_key(&participant_idx) {
            return Err(MultiSigError::DuplicateSignature(participant_idx));
        }
        // 验证签名有效性——注意：这里验证的是摘要
        let digest = self.message_digest();
        let vk = &self.policy.participants[participant_idx];
        vk.verify(&digest, &signature)
            .map_err(|_| MultiSigError::InvalidSignature(participant_idx))?;

        self.collected.insert(participant_idx, signature);
        Ok(())
    }

    /// 当前有效签名数量
    pub fn signature_count(&self) -> usize {
        self.collected.len()
    }

    /// 是否已满足阈值
    pub fn is_complete(&self) -> bool {
        self.collected.len() >= self.policy.threshold
    }

    /// 最终验证并导出已收集的签名列表
    /// 返回满足阈值的参与方索引列表
    pub fn finalize(&self) -> Result<Vec<usize>, MultiSigError> {
        if !self.is_complete() {
            return Err(MultiSigError::ThresholdNotMet {
                need: self.policy.threshold,
                got: self.collected.len(),
            });
        }
        let mut indices: Vec<usize> = self.collected.keys().copied().collect();
        indices.sort(); // 确定性顺序
        Ok(indices)
    }
}
```

### 5.4 参与方签名

```rust
// src/sig/mod.rs
mod sig;

use k256::ecdsa::signature::Signer;
use k256::ecdsa::{Signature, SigningKey};

pub use sig::MultiSigPolicy;
pub use sig::MultiSigSession;

/// 参与方使用自己的私钥对会话消息签名
pub fn sign_session(session: &MultiSigSession, signing_key: &SigningKey) -> Signature {
    let digest = session.message_digest();
    // k256 的 sign 方法内部使用 RFC6979 确定性 nonce，安全可靠
    signing_key.sign(&digest)
}
```

### 5.5 完整演示

```rust
// src/main.rs

use multisig::MultiSigPolicy;
use multisig::MultiSigSession;
use multisig::sign_session;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("=== m-of-n 多签演示 ===\n");

    // 创建 3-of-5 多签策略
    let n = 5;
    let m = 3;
    let (signing_keys, mut policy) = MultiSigPolicy::generate_test_keys(n);
    policy.threshold = m; // 覆盖为 3-of-5

    println!("策略: {m}-of-{n} 多签");
    println!("参与方数量: {}", policy.participants.len());

    // 创建一笔需要审批的"转账提案"
    let proposal = serde_json::json!({
        "action": "transfer",
        "to": "0xdeadbeef...",
        "amount": "1000000000000000000", // 1 ETH in wei
        "nonce": 42,
    });
    let message = proposal.to_string().into_bytes();

    println!("\n待审批消息: {}", String::from_utf8_lossy(&message));

    // 创建多签会话
    let mut session = MultiSigSession::new(policy.clone(), message);

    // 模拟参与方逐一签名
    for i in 0..n {
        let sig = sign_session(&session, &signing_keys[i]);
        match session.submit_signature(i, sig) {
            Ok(()) => println!("参与方 {i} 签名成功，当前签名数: {}", session.signature_count()),
            Err(e) => println!("参与方 {i} 签名失败: {e}"),
        }
        if session.is_complete() {
            println!("\n✓ 已达到阈值 {m}，无需等待剩余参与方");
            break;
        }
    }

    // 最终确认
    let approved_by = session.finalize()?;
    println!("\n交易已获批准，批准方索引: {approved_by:?}");

    // 演示：阈值不足时的错误处理
    println!("\n--- 演示阈值不足的情况 ---");
    let mut insufficient_session = MultiSigSession::new(policy.clone(), b"another tx".to_vec());
    let sig0 = sign_session(&insufficient_session, &signing_keys[0]);
    let sig1 = sign_session(&insufficient_session, &signing_keys[1]);
    insufficient_session.submit_signature(0, sig0)?;
    insufficient_session.submit_signature(1, sig1)?;
    match insufficient_session.finalize() {
        Err(e) => println!("预期错误: {e}"),
        Ok(_) => println!("不应该到这里"),
    }

    // 演示：伪造签名被拒绝
    println!("\n--- 演示伪造签名被拒绝 ---");
    let mut forge_session = MultiSigSession::new(policy.clone(), b"tx to forge".to_vec());
    // 参与方 0 用自己的私钥签，但声称是参与方 1 的签名
    let forged_sig = sign_session(&forge_session, &signing_keys[0]);
    match forge_session.submit_signature(1, forged_sig) {
        Err(e) => println!("伪造签名被拒绝: {e}"),
        Ok(_) => println!("不应该通过"),
    }

    Ok(())
}
```

运行输出类似：

```
=== m-of-n 多签演示 ===

策略: 3-of-5 多签
参与方数量: 5

待审批消息: {"action":"transfer","amount":"1000000000000000000","nonce":42,"to":"0xdeadbeef..."}
参与方 0 签名成功，当前签名数: 1
参与方 1 签名成功，当前签名数: 2
参与方 2 签名成功，当前签名数: 3

✓ 已达到阈值 3，无需等待剩余参与方

交易已获批准，批准方索引: [0, 1, 2]

--- 演示阈值不足的情况 ---
预期错误: threshold not met: need 3, got 2

--- 演示伪造签名被拒绝 ---
伪造签名被拒绝: signature from participant 1 is invalid
```

---

## 六、Shamir 秘密共享：另一种"分散私钥"的思路

多签是"每人持有完整私钥，需要 m 人签名"。

还有另一种方案：**Shamir 秘密共享（Shamir's Secret Sharing，SSS）**——把私钥本身拆成 n 份碎片（称为 share），需要凑齐 m 份才能还原出私钥。

数学原理：

> 一个 m-1 次多项式由 m 个点唯一确定。把秘密藏在多项式的常数项，n 个人各持有多项式上的一个点。任意 m 个人可以用拉格朗日插值还原多项式，少于 m 个人则完全无法获取任何信息。

```rust
// src/shamir.rs
/// 简单的 Shamir 秘密共享实现（教学用途，字段为 u64，生产环境应使用大质数有限域）
///
/// 注意：生产环境请使用 vsss-rs 等专业库
pub mod shamir {
    use rand::RngExt;

    // 使用一个足够大的质数作为有限域模数
    // 生产环境应使用 2^256 级别的质数（与私钥空间匹配）
    const PRIME: u64 = 2_305_843_009_213_693_951; // 梅森素数 2^61 - 1

    fn mod_add(a: u64, b: u64) -> u64 {
        ((a as u128 + b as u128) % PRIME as u128) as u64
    }

    fn mod_mul(a: u64, b: u64) -> u64 {
        ((a as u128 * b as u128) % PRIME as u128) as u64
    }

    /// 模逆元（费马小定理：a^(p-2) mod p）
    fn mod_inv(a: u64) -> u64 {
        mod_pow(a, PRIME - 2)
    }

    fn mod_pow(mut base: u64, mut exp: u64) -> u64 {
        let mut result = 1u64;
        base %= PRIME;
        while exp > 0 {
            if exp & 1 == 1 {
                result = mod_mul(result, base);
            }
            exp >>= 1;
            base = mod_mul(base, base);
        }
        result
    }

    /// 将秘密 secret 拆分为 n 份，需要 threshold 份才能还原
    pub fn split(secret: u64, threshold: usize, n: usize) -> Vec<(u64, u64)> {
        assert!(threshold >= 2 && threshold <= n);
        assert!(secret < PRIME);

        let mut rng = rand::rng();

        // 构造一个随机的 (threshold-1) 次多项式，常数项为 secret
        // f(x) = secret + a1*x + a2*x^2 + ... + a_{t-1}*x^{t-1}
        let mut coefficients = vec![secret];
        for _ in 1..threshold {
            coefficients.push(rng.random_range(1..PRIME));
        }

        // 计算 n 个点 (i, f(i))，i 从 1 开始（避免 x=0）
        (1..=(n as u64))
            .map(|x| {
                let y = coefficients
                    .iter()
                    .enumerate()
                    .fold(0u64, |acc, (i, &coef)| {
                        mod_add(acc, mod_mul(coef, mod_pow(x, i as u64)))
                    });
                (x, y)
            })
            .collect()
    }

    /// 用拉格朗日插值从 shares 还原秘密（shares 数量需 ≥ threshold）
    pub fn combine(shares: &[(u64, u64)]) -> u64 {
        // 计算 f(0) 的拉格朗日插值
        shares.iter().enumerate().fold(0u64, |acc, (i, &(xi, yi))| {
            let lagrange = shares.iter().enumerate().fold(1u64, |prod, (j, &(xj, _))| {
                if i == j {
                    prod
                } else {
                    // 分子：(0 - xj) mod p = (p - xj) mod p
                    let num = (PRIME - xj) % PRIME;
                    // 分母：(xi - xj) mod p
                    let den = if xi > xj {
                        xi - xj
                    } else {
                        PRIME - (xj - xi) % PRIME
                    };
                    mod_mul(prod, mod_mul(num, mod_inv(den)))
                }
            });
            mod_add(acc, mod_mul(yi, lagrange))
        })
    }
}
```

使用示例：

```rust
// examples/shamir
use multisig::shamir;

fn main() {
    let secret: u64 = 0x1fff_ffff_dead_beef; // 模拟私钥片段（需小于 PRIME = 2^61-1）

    // 拆分：3-of-5
    let shares = shamir::shamir::split(secret, 3, 5);
    println!("原始秘密: {:#018x}", secret);
    println!("生成 {} 份碎片:", shares.len());
    for (x, y) in &shares {
        println!("  share[{x}] = {y:#018x}");
    }

    // 用任意 3 份还原
    let recovered = shamir::shamir::combine(&shares[0..3]);
    println!("\n用前 3 份还原: {:#018x}", recovered);
    assert_eq!(recovered, secret, "还原失败！");
    println!("✓ 还原成功");

    // 用不同的 3 份还原
    let recovered2 = shamir::shamir::combine(&[shares[1], shares[3], shares[4]]);
    assert_eq!(recovered2, secret);
    println!("✓ 用第 2、4、5 份也能还原");

    // 2 份无法还原（结果错误但不会 panic）
    let wrong = shamir::shamir::combine(&shares[0..2]);
    println!("\n只用 2 份尝试还原: {:#018x}（应与原值不同）", wrong);
    assert_ne!(wrong, secret);
    println!("✓ 不足份数无法正确还原");
}
```

### SSS 与多签的关键区别

| 维度 | Shamir 秘密共享 | m-of-n 多签 |
|------|----------------|-------------|
| 私钥存在性 | 还原时私钥在一个地方短暂重组 | 私钥从不重组，分布式签名 |
| 重组时的风险 | 重组节点成为单点 | 无单点风险 |
| 是否需要交互 | 还原时需要汇聚 shares | 签名可以离线进行，只传签名结果 |
| 链上可见性 | 最终结果与单签相同 | 脚本/合约多签链上可见；密码学多签不可见 |
| 适用场景 | 密钥备份、种子短语分片 | 资金管理、治理决策 |

---

## 七、ByBit 事件的深层教训：多签的安全边界

回到开头的 ByBit 事件，现在可以更清晰地分析：

### 攻击链条

```
入侵 Safe{Wallet} 的 AWS S3 存储桶
    ↓
替换前端 JavaScript 文件
    ↓
ByBit 操作员打开 Safe 界面，看到"正常的 ETH 转账"
    ↓
三位操作员分别在硬件钱包上签名（以为是例行操作）
    ↓
实际签名的是"将 Safe 实现合约升级为恶意合约"的交易
    ↓
攻击者控制合约，清空所有资产
```

### 多签保护的是什么，保护不了什么

**多签能防护的**：
- 单个私钥泄露（还需要 m-1 个配合）
- 单台设备被黑（其他设备仍然安全）
- 内部单人作恶（需要 m 人串通）
- 物理盗窃单个硬件钱包

**多签保护不了的**：
- 所有签名者都通过同一个被攻陷的界面签名（供应链攻击）
- 签名者被社会工程学欺骗，对恶意交易数据"视而不见"
- 合约本身存在逻辑漏洞，合法签名触发了恶意路径

### 真正的防护需要什么

1. **独立验证交易数据**：每个签名者应直接解析 calldata，而不是只看 UI 描述。硬件钱包需要显示原始交易内容。

2. **多元化签名环境**：不同签名者使用不同厂商的硬件钱包，访问不同的前端界面（甚至自建界面）。

3. **时间锁（Timelock）**：高价值操作强制等待 24-72 小时，期间任何人可以发现异常并取消。

4. **交易模拟**：签名前用 Tenderly / Foundry 模拟交易执行结果，确认实际效果与预期一致。

5. **密码学多签优于合约多签**：如果用 MPC/FROST 在密码学层实现阈值签名，合约升级攻击向量直接消失——因为根本没有可升级的合约。

---

## 八、生产环境的多签方案选择

### 比特币生态

```
P2WSH 多签 → 稳定成熟，手续费可接受
Taproot + MuSig2 → 更便宜（外观与单签相同），需要多轮交互
```

推荐库：`bitcoin` crate（Rust）、`rust-musig2`

### 以太坊 / EVM 生态

```
Gnosis Safe → 最成熟，但需要警惕前端安全和合约升级风险
ERC-4337 Account Abstraction → 更灵活，原生支持复杂签名逻辑
```

ByBit 事件后，Safe 已强制增加了签名数据的链上原始数据显示。

### Solana 生态

```
Squads Protocol → Solana 上的多签标准实现（Program Derived Address + 投票机制）
SPL Token MultiSig → 原生代币多签
```

### 纯密码学方案（链无关）

```
FROST → 推荐，正式标准化（RFC 9591），Rust 有 frost-core crate
阈值 ECDSA → 用于不支持 Schnorr 的场景，实现复杂度更高
```

---

## 九、总结

多签本质上是把"单点信任"分散成"多点共识"，是区块链资产安全的重要工具。

但 ByBit 和 Radiant Capital 的案例告诉我们：

> **多签不是银弹。它保护的是密钥层的安全，而不是签名者的判断力，也不是应用层的完整性。**

真正意义上的安全，需要：

- **密钥层**：多签 / 阈值签名，分散单点风险
- **应用层**：独立验证交易内容，不依赖单一前端
- **流程层**：时间锁、冷却期、多通道确认
- **运营层**：定期轮换密钥，最小化热路径权限

密码学上的多签（FROST、MuSig2）相比合约多签，消除了合约升级这一额外攻击面，是未来值得关注的方向。

对于 Rust 开发者而言，`k256`、`ed25519-dalek`、`frost-core` 这些 crate 提供了扎实的密码学基础，可以在此之上构建真正可靠的多签系统。

---

> 示例代码仅用于教学演示。生产环境中的密码学实现请使用经过审计的专业库，并务必进行安全审计。

> 示例代码链接：[multisig](https://github.com/billchen-818/my-rust-learn/tree/master/multisig)

---

**参考资料**

- [ByBit Hack Analysis — Offchain Labs](https://offchain.medium.com/bybit-hack-analysis)
- [FROST RFC 9591](https://www.rfc-editor.org/rfc/rfc9591)
- [MuSig2: Simple Two-Round Schnorr Multisignatures — BIP 327](https://github.com/bitcoin/bips/blob/master/bip-0327.mediawiki)
- [Safe{Wallet} Incident Report](https://safe.global/blog/safe-wallet-incident)
- [k256 crate — RustCrypto](https://docs.rs/k256)
- [frost-core crate — ZF FROST](https://docs.rs/frost-core)
