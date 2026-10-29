---
title: solana-spl-token介绍
date: 2025-08-13 09:25:13
tags: Solana
---

## SPL代币标准

代币是数字资产，代表对多种类型资产的所有权或权利，这些资产包括金融工具、房地产、知识产权、虚拟商品等。代币化实现了资产产权的数字化，是管理同质化代币和非同质化代币的重要组成部分。

- 同质化代币：同类型同价值且可以互换和分割的资产，例如USDC。类似于以太坊中的ERC20标准。
- 非同质化：代表不可分割资产的所有权，例如艺术品。类似于以太坊中的ERC721标准。

在solana中，这些代币统称为SPL(Solana Program Library)代币，下面是一些SPL基本概念：

- 代币程序：包含了在网络上与代币交互的索引指令逻辑，涵盖了同质化代币和非同质化代币的管理。
- 铸币账户：代表一种特定类型的代币，存储该代币的全局元数据，例如总供应量和铸币权限。
- 代币账户：用于记录某个地址拥有的特定类型代币（由铸币账户定义）的数量，以便跟踪个人的代币持有情况。

### 代币程序

solana上所有代币实际上都是由代币程序拥有的数据账户。

一些常用的指令：

- InitializeMint：创建一个新的铸币账户，用于表示新的代币类型。
- InitializeAccount：创建一个新的代币账户，用于持有特定类型代币（由铸币账户定义）的单位。
- MintTo：创建特定类型代币的新单位并将其添加到代币账户，这会增加代币的供应量，并且只能由铸币账户的铸币权限地址执行。
- Transfer：将特定类型代币的单位从一个代币账户转移到另一个代币账户。

### 铸币账户

Solana上的代币通过由Token Program所拥有的铸币账户（Mint Account）的地址来唯一标识。

这些铸币账户实际上充当特定代币的全局计数器，并存储以下数据：

- 总供应量Total Supply：该代币的总供应量，表示发行的代币数量；
- 铸币权限（Mint Authority）：有权铸造新单位代币的地址。如果没有设置铸币权限，代币就不能再增加供应量。
- 冻结权限（Freeze Authority）：有权冻结代币账户的地址，用于防止某些账户进行代币转账。
- 代币精度Decimals：定义该代币的最小单位是多少（例如，USDC 使用 6 位小数）。

铸币账户代码：

```rust
pub struct Mint {
    /// Optional authority used to mint new tokens. The mint authority may only
    /// be provided during mint creation. If no mint authority is present
    /// then the mint has a fixed supply and no further tokens may be
    /// minted.
    pub mint_authority: COption<Pubkey>,
    /// Total supply of tokens.
    pub supply: u64,
    /// Number of base 10 digits to the right of the decimal place.
    pub decimals: u8,
    /// Is `true` if this structure has been initialized
    pub is_initialized: bool,
    /// Optional authority to freeze token accounts.
    pub freeze_authority: COption<Pubkey>,
}
```

### 代币账户

为了跟踪特定代币每个单位的所有权，需要创建由Token Program管理的另一种类型数据账户，这种账户被称为Token Account（代币账户）。

代币账户中存储的数据通常包括以下内容：

- Mint:表示该代币账户所持有的代币类型，即关联的铸币账户地址；
- Owner:授权管理该代币账户的程序账户地址（代币程序），只有这个程序账户可以从中转出代币。
- Amount:该代币账户当前持有的代币数量（单位）。

代币账户代码定义如下：

```rust
pub struct Account {
    /// The mint associated with this account
    pub mint: Pubkey,
    /// The owner of this account.
    pub owner: Pubkey,
    /// The amount of tokens this account holds.
    pub amount: u64,
    /// If `delegate` is `Some` then `delegated_amount` represents
    /// the amount authorized by the delegate
    pub delegate: COption<Pubkey>,
    /// The account's state
    pub state: AccountState,
    /// If is_native.is_some, this is a native token, and the value logs the
    /// rent-exempt reserve. An Account is required to be rent-exempt, so
    /// the value is used by the Processor to ensure that wrapped SOL
    /// accounts do not drop below this threshold.
    pub is_native: COption<u64>,
    /// The amount delegated
    pub delegated_amount: u64,
    /// Optional authority to close the account.
    pub close_authority: COption<Pubkey>,
}
```

为了让一个钱包拥有某种代币的单位，需要为这种代币(**Mint Account**)创建一个**Token Account**，并将钱包指定为该**Token Account**的所有者（即owner字段的值时钱包地址）。

> 1、一个钱包可以为同一种代币创建多个 Token Account，例如为了进行分类管理。2、每个 Token Account 只能由一个钱包拥有，并且只能存储一种类型的代币。

![账户关系](/img/solana-spl-token.png)

## 实战-创建一个SPL标准代币

### 安装spl-token-cli

在solana上，创建和管理spl代币的过程相对简化，因为solana提供了一个现成的SPL Token Program，开发者不需要编写复杂的智能合约代码，只需要使用现成的命令行工具和库。

为了使用 SPL Token Program 创建 SPL 代币，我们需要使用 Solana 提供的命令行工具 spl-token，现在来安装这个工具。

注意：需要你提前安装好 rust 和 solana 环境。

运行以下命令：

```sh
cargo install spl-token-cli
```

### 创建代币

使用spl-token命令行工具创建一个新的代币。创建代币时，solana会为你生成一个铸币账户，这个账户存储代币的必要信息，如供应量，授权账户等。

运行以下命令，创建一个新的代币：

```sh
spl-token create-token
```

输出如下：

```
Creating token 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu under program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA

Address:  7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
Decimals:  9

Signature: 2vTyBz2LtMHXPhcivLcbEFX1XNR74RvscEG2thn6BNSUYhUgDMVc27381LEf9A4GnUNCLvnxxJKnfTqTaZmFxE4E
```

生成的地址**7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu**是代币的铸币账户地址（Mint Account）,用于存储代币信息，如供应量和授权账户，代表了一种代币。

新创建的代币初始供应量为0，可以通过以下命令验证：

```sh
spl-token supply 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
```

输出如下：

```
0
```

在铸造代币之前，需要先创建一个账户(Token Account)，来持有代币的余额信息。

### 创建Token Account

在为代币铸造供应量之前，需要创建一个Token Account，用于存储代币余额，每个Token Account关联特定代币（Mint）。运行下面命令，创建：

```sh
spl-token create-account 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
```

输出如下：

```
Creating account 9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM

Signature: 5Pk9zooWKP1hDBNEuiDMPpQTcJPsnkNcpDezkgcUURwGKrEVCWSC4nT2U7XTcdpgvGoe4Tfma3YQhUCWCj86otJd
```

生成的9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM地址就是代币的账户地址，用于存储上文创建的代币的余额信息，现在这个代币的余额是0.

### 铸造代币

铸造代币的过程会增加铸币账户的供应量（Supply） 和 代币账户的余额（Balance）。以下是铸造命令格式：

```sh
spl-token mint <mint_adderss> <amount> <token_account_address>
```

例如，为刚刚创建的代币账户铸造100个代币：

```sh
spl-token mint 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu 100 9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM
```

输出如下：

```
Minting 100 tokens
  Token: 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
  Recipient: 9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM

Signature: fEKg7Y3kNN36gmFWbVxRob2GQxaMTYaNMJjLoXQ9hUPFfXxG6en8rdC9W2J37S9yqs6ATChKVczA61QxssUuH4H
```

此时可通过以下命令查看铸币账户供应量和代币账户余额：

```sh
spl-token supply 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
spl-token balance 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
```

### 查询代币和账户信息

#### 查看代币账户信息

```sh
spl-token display 9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM
```

输出如下：

```
SPL Token Account
  Address: 9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM
  Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  Balance: 100
  Decimals: 9
  Mint: 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
  Owner: Grut8Qc3QFxVxkfpsiYgLZ2ic7MJL62RVS9XoW4NQKKe
  State: Initialized
  Delegation: (not set)
  Close authority: (not set)
```

#### 查询铸币信息账户

```sh
spl-token display 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
```

输出如下：

```
SPL Token Mint
  Address: 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
  Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  Supply: 100000000000
  Decimals: 9
  Mint authority: Grut8Qc3QFxVxkfpsiYgLZ2ic7MJL62RVS9XoW4NQKKe
  Freeze authority: (not set)
```

可以在浏览器查看刚刚创建的代币：[代币](https://explorer.solana.com/address/7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu?cluster=devnet)

### 转账代币

使用 spl-token 工具可以进行代币的转账、查询余额等各种操作。

#### 给钱包账户转账

创建一个新钱包

```sh
solana-keygen new -o ~/.config/solana/id-02.json
```

输出如下：

```
Generating a new keypair

For added security, enter a BIP39 passphrase

NOTE! This passphrase improves security of the recovery seed phrase NOT the
keypair file itself, which is stored as insecure plain text

BIP39 Passphrase (empty for none): $(123456)
Enter same passphrase again: $(123456)

Wrote new keypair to /Users/chenmx/.config/solana/id-02.json
===============================================================================
pubkey: CuEsnnr6v9jjDhv7xNDiSXrcpAB27HTfiZM947X5rvfq
===============================================================================
Save this seed phrase and your BIP39 passphrase to recover your new keypair:
benefit west jacket suggest attack fog firm truly bullet collect lyrics captain
===============================================================================
```

新地址为：CuEsnnr6v9jjDhv7xNDiSXrcpAB27HTfiZM947X5rvfq

向新地址转账：

```sh
spl-token transfer 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu 50 CuEsnnr6v9jjDhv7xNDiSXrcpAB27HTfiZM947X5rvfq
```

会输出如下错误信息：

```
Transfer 50 tokens
  Sender: 9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM
  Recipient: CuEsnnr6v9jjDhv7xNDiSXrcpAB27HTfiZM947X5rvfq
Error: "Error: The recipient address is not funded. Add `--allow-unfunded-recipient` to complete the transfer."
```

这个错误是因为接收地址是我们刚刚创建的，还没有代币账户来存储余额，通常，有两种方法解决：

##### 接收者自己创建代币账户

1、首先，切换默认钱包至新创建的接收者钱包：

```sh
solana config set --keypair ~/.config/solana/id-02.json
solana address
solana config get
solana airdrop 5 
```

2、然后创建代币账户：

```
spl-token create-account 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
```

输出如下：

```
Creating account 5AdKdgDP8wGeYqqoYikjuezgnjccXLik5dLjaMQYgcYN

Signature: 3fSw8ZvDXdEhZQCys2VJS6HztFB96UFAUn4zPkvieZJ3VFKbsyXr2v586ziQ8PeL4rsokwzYdYR7NXHfqy6XMwZH
```

为新账户创建了代币账户5AdKdgDP8wGeYqqoYikjuezgnjccXLik5dLjaMQYgcYN，下面向新账户转账：

注意：需先切换回原来账户。

```sh
solana config set --keypair ~/.config/solana/id.json
```

再来转账：

```sh
spl-token transfer 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu 50 CuEsnnr6v9jjDhv7xNDiSXrcpAB27HTfiZM947X5rvfq
```

输出如下：

```
Transfer 50 tokens
  Sender: 9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM
  Recipient: CuEsnnr6v9jjDhv7xNDiSXrcpAB27HTfiZM947X5rvfq
  Recipient associated token account: 5AdKdgDP8wGeYqqoYikjuezgnjccXLik5dLjaMQYgcYN

Signature: 3RaopXzR3uzicVp6F4VPCr6xbfB9tvWeBXHuuSH1k9h2xAgHWMAYhLc4rULJyr7Myy2CJoTWPG2v9fDWKLGauHGD
```

##### 发送者为接收者创建代币账户

这种方法需要发送者资助一些sol给接收者，因为创建代币账户是需要租金的，代币账户虽然是接收方的，但创建时需要有人支付这笔租金。发送者选择为接收者代付这部分费用，因此称为“fund”。

运行以下命令：

```sh
# --fund-recipient 表示资助接收者 SOL 用于支付代币账户租金
# --allow-unfunded-recipient 表示允许自动为接收者创建代币账户
spl-token transfer --fund-recipient 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu 50 H1jxjEVnxKgrdN17UpU7tDzhwDBCHvKXfuzJAmcouQ9Y --allow-unfunded-recipient
```

通过输出信息可以看到，已经自动为接收者创建了一个代币账户，并成功转账了 50 个代币。

#### 给代币账户转账代币

除了给钱包转账，也可以给已存在的代币账户转账，例如向刚刚创建的代币账户转账：

```sh
spl-token transfer 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu 5 5AdKdgDP8wGeYqqoYikjuezgnjccXLik5dLjaMQYgcYN
```

输出如下：

```
Transfer 5 tokens
  Sender: 9TeAnD3b5AXnvWUqh7AFGcAQShHBD7pmRGjTcCtShfjM
  Recipient: 5AdKdgDP8wGeYqqoYikjuezgnjccXLik5dLjaMQYgcYN

Signature: zYd4cDS8psHKpWeirZ3HdoVTPHaPLD1qxmjbgjunVeppiggdQ3PFBNBgBhE7mKLpcvrMoeNyLNBN8d9svkEc3iN
```

现在，我们查看这个代币账户的余额看看效果，运行以下命令：

```sh
spl-token display 5AdKdgDP8wGeYqqoYikjuezgnjccXLik5dLjaMQYgcYN
```

输出如下：

```
SPL Token Account
  Address: 5AdKdgDP8wGeYqqoYikjuezgnjccXLik5dLjaMQYgcYN
  Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  Balance: 55
  Decimals: 9
  Mint: 7FtgPqsoJ19uSH7jHShzvwYfypRbp4GoBqBXzhBoBxcu
  Owner: CuEsnnr6v9jjDhv7xNDiSXrcpAB27HTfiZM947X5rvfq
  State: Initialized
  Delegation: (not set)
  Close authority: (not set)
```

可以看到，余额是 55 个代币，符合预期，因为第一次向钱包转账了 50 个，第二次直接向代币账户转账了 5 个。

### 配置元数据

我们的代币还没有元数据，比如name、symbol、uri等。由于我们的代币是由Token Program创建的，要想添加元数据，需要使用**Metaplex Token Metadata Program** 才能实现，而官方已经推荐使用新的代币标准（ **即 Token-2022 Program** ）。

**Token-2022** 是对 **经典 SPL Token Program** 的增强版本，支持更丰富的功能，可以直接为代币设置`名称（name）`、`符号（symbol）`和`资源定位符（URI）`等。

因此，我们重新创建一个 `Token-2022 Program` 的代币。

#### 创建一个 Token-2022 Program 的代币

```sh
# -p 指定 Token-2022 Program 的地址
# --enable-metadata 启用元数据
spl-token create-token -p TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --enable-metadata
```

输出为：

```sh
Creating token FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj under program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
To initialize metadata inside the mint, please run `spl-token initialize-metadata FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj <YOUR_TOKEN_NAME> <YOUR_TOKEN_SYMBOL> <YOUR_TOKEN_URI>`, and sign with the mint authority.

Address:  FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj
Decimals:  9

Signature: 3vA3R6hpE1Nuv4NjbbngukcS3GRUS3embkox6CtcUHg9ux6ENLVWbPMkdn7BxHZArp3mbMKnZo9Z7iPFzDs5bvwC
```

#### 为新代币初始化元数据

根据提示命令，我们为新代币添加 name 和 symbol

```sh
spl-token initialize-metadata FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj "My SPL Token" "MST" ""
```

初始化元数据后，查看代币信息：

```
spl-token display FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj
```

输出：

```
SPL Token Mint
  Address: FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj
  Program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
  Supply: 0
  Decimals: 9
  Mint authority: Grut8Qc3QFxVxkfpsiYgLZ2ic7MJL62RVS9XoW4NQKKe
  Freeze authority: (not set)
Extensions
  Metadata Pointer:
    Authority: Grut8Qc3QFxVxkfpsiYgLZ2ic7MJL62RVS9XoW4NQKKe
    Metadata address: FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj
  Metadata:
    Update Authority: Grut8Qc3QFxVxkfpsiYgLZ2ic7MJL62RVS9XoW4NQKKe
    Mint: FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj
    Name: My SPL Token
    Symbol: MST
    URI: (not set)
```

#### 创建代币账户，存储这个新代币的余额

```
spl-token create-account FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj
```

输出：

```
Creating account 6RTJVvEu6kTazPLEd6v11Hvj8Z6ciE9q9TgEX33auJQD

Signature: 3NVV5jzH3kvevusxu6WLx1tcAHLdgMjmuXiPG9SUxT6ugR3DHpuib4AmXDbH2fyVPCWKUmbgpJxcasqTzXCLCHuq
```

查看代币账户：

```
SPL Token Account
  Address: 6RTJVvEu6kTazPLEd6v11Hvj8Z6ciE9q9TgEX33auJQD
  Program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
  Balance: 0
  Decimals: 9
  Mint: FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj
  Owner: Grut8Qc3QFxVxkfpsiYgLZ2ic7MJL62RVS9XoW4NQKKe
  State: Initialized
  Delegation: (not set)
  Close authority: (not set)
Extensions:
  Immutable owner
```

### 配置区块浏览器

现在，你打开区块浏览器查看这个新代币，发现 logo 的位置依然显示 **Unknown Token**，这是为什么呢？

因为我们刚刚没有配置 `uri`！在 Solana 的代币元数据标准中，URI 字段通常用于存储指向 JSON 文件的链接。这个 JSON 文件包含代币的详细信息，例如 name、symbol 和 logo URL。

#### 选择 Web3 存储服务

市面上有众多 Web3 存储服务，例如：`IPFS`、`Web3.Storage`、`NFT.Storage`、`Arweave`、`Pinata` 等。它们大都有免费使用的空间，为了避免绑定银行卡，我选择使用 **Pinata**。

在 [https://pinata.cloud/]()注册成功后，上传文件获得 `IPFS CID`，然后就可以通过 `https://ipfs.io/ipfs/{IPFS_CID}` 公开访问我们的资源了。

> Pinata 的使用自行研究即可，非常简单。

1. 上传 Logo 图标

选择一个 logo 图标，通过 Pinata 网站上传，获得 IPFS_CID。

1. 上传 JSON 文件

我们的代币元数据如下：

```json
{
  "name": "My SPL Token",
  "symbol": "MST",
  "description": "A pig token.",
  "image": "https://ipfs.io/ipfs/{IPFS_CID}",
  "external_url": "",
  "attributes": [],
  "properties": {
    "files": [
      {
        "uri": "https://ipfs.io/ipfs/{IPFS_CID}",
        "type": "image/png"
      }
    ]
  }
}
```

这里的 image 字段写你的 logo 访问地址，然后按照同样的步骤上传至 Pinata。

我的CID是bafkreianvqy6a6lwzqzhjiyh27jl5pqsj3p2gznbz5luwqhjggcpsofiqm

JSON文件：

```json
{
  "name": "My SPL Token",
  "symbol": "MST",
  "description": "A pig token.",
  "image": "https://ipfs.io/ipfs/bafkreianvqy6a6lwzqzhjiyh27jl5pqsj3p2gznbz5luwqhjggcpsofiqm",
  "external_url": "",
  "attributes": [],
  "properties": {
    "files": [
      {
        "uri": "https://ipfs.io/ipfs/bafkreianvqy6a6lwzqzhjiyh27jl5pqsj3p2gznbz5luwqhjggcpsofiqm",
        "type": "image/png"
      }
    ]
  }
}
```

#### 更新代币元数据

获得 ipfs 链接后，我们使用以下命令更新代币的 URI 字段：

```bash
// 为上传的json文件的cid
spl-token update-metadata FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj uri "https://ipfs.io/ipfs/bafkreih4jhfqxlgpoxtlavbijbzl4u3utiubgneinane4p34k4f7z3tnqa"
```

更新成功后，再次打开 Solana 区块浏览器，就可以正常看到我们配置的 Logo 和 Name 了。

https://explorer.solana.com/address/FQCikCzDRnSZeoQieBkjPHgXhAQW8wqTEbJWSkEWcFUj?cluster=devnet
