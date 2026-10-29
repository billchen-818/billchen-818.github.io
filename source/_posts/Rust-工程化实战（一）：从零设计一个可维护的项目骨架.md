---
title: Rust 工程化实战（一）：从零设计一个可维护的项目骨架
date: 2026-06-03 08:10:26
tags: Rust
---

这是 Rust 工程化实战系列的第一篇。

这个系列的出发点不是"写出能跑的代码"，而是"写出能长期维护的代码"。

能跑和能维护，这两件事差距很大。

很多 Rust 项目写到一定规模之后，都会碰到同样的问题：

- 模块之间的依赖越来越乱，改一处牵动多处
- 业务逻辑和基础设施代码搅在一起，想换数据库要改一堆业务代码
- 测试越来越难写，因为业务方法里直接依赖了数据库连接
- 新人接手项目，读完代码还是不清楚哪层负责什么
- `main.rs` 越来越大，什么都往里塞

这些问题不是 Rust 特有的，但 Rust 的类型系统和模块系统提供了一套非常好的工具来解决它们——前提是你得在项目早期就把骨架设计清楚。

这一篇我会围绕几个核心问题展开：

1. 可维护项目骨架的核心原则是什么
2. 单 crate 项目内部应该怎么组织
3. 什么时候该升级到 workspace 多 crate
4. 多 crate 下的层次划分和依赖方向应该怎么定
5. 公开接口边界怎么控制

文章配套的完整示例工程在 `workspaces/skeleton-demo`，可以直接运行和参考。

---

## 一、先说结论：三条基本原则

可维护的项目骨架，核心就三条：

**1. 依赖方向必须单向**

业务逻辑不应该依赖具体的基础设施实现。应该反过来：基础设施去实现业务定义的接口。

**2. 边界用编译器来守**

不要靠"约定"或者"注意不要这样写"来维护边界。在需要边界的地方，用模块可见性或 crate 拆分来让编译器强制执行。

**3. 公开接口显式控制**

对外暴露的 API 应该是经过设计的，而不是"反正没写 `pub(crate)` 就默认对外可见了"。每个 `pub` 都应该是有意识的决定。

后面所有的具体做法都是这三条原则的落地。

---

## 二、从一个"失控的项目"看问题

先看一个典型的"能跑但难维护"的项目结构：

```
src/
├── main.rs
├── db.rs        // 直接包含 sqlx 调用
├── handler.rs   // HTTP handler，直接 import db.rs 里的函数
├── model.rs     // 数据模型，但同时有数据库映射和业务逻辑
├── config.rs    // 配置，直接用 std::env::var
└── error.rs     // 错误类型，但耦合了 sqlx::Error
```

这种结构的问题在于：

- `handler.rs` 直接调用 `db.rs` 里的函数 → 没有业务层，业务逻辑散落各处
- `model.rs` 既有 `#[derive(sqlx::FromRow)]`，又有业务方法 → 数据库结构和业务模型没有分离
- `error.rs` 里有 `sqlx::Error` → 想换数据库，错误类型也要跟着改
- 测试：你没办法在不启动数据库的情况下测试 handler，因为它直接依赖了 `db.rs`

这些问题在项目小的时候感觉不明显，但它们是未来所有维护痛苦的根源。

---

## 三、单 crate 项目的内部组织

不是所有项目都需要多 crate。

如果你的项目：

- 只有一个运行入口
- 没有被其他项目复用的需求
- 规模还不算大（几千行以内）

那单 crate 就完全够用，关键是**模块内部的层次划分**要清晰。

一个清晰的单 crate 结构应该长这样：

```
src/
├── main.rs        // 只做组装：创建依赖、启动服务
├── error.rs       // 统一错误类型
│
├── domain/        // 纯业务逻辑：不 import 任何基础设施
│   ├── mod.rs
│   ├── user.rs    // 用户实体和业务规则
│   └── service.rs // 业务操作的入口
│
├── port/          // 接口定义：domain 需要什么，在这里声明
│   ├── mod.rs
│   └── user_repo.rs  // trait UserRepository
│
└── infra/         // 具体实现：实现 port 里定义的 trait
    ├── mod.rs
    └── memory.rs  // InMemoryUserStore
```

每一层的职责是清晰的：

| 目录 | 职责 | 允许依赖 |
|------|------|----------|
| `domain/` | 业务实体、规则、服务 | 只依赖 `error.rs` 和 `port/` |
| `port/` | trait 接口定义 | 只依赖 `domain/` 里的类型 |
| `infra/` | 具体实现 | 可以依赖外部 crate（sqlx、redis 等） |
| `main.rs` | 组装和启动 | 可以依赖所有层 |

这个结构重要的地方在于**依赖方向**：

```
infra → port ← domain
          ↑
        main
```

`domain` 定义规则，`port` 声明接口，`infra` 实现接口。`domain` 完全不知道 `infra` 的存在。

### 3.1 用可见性控制边界

在单 crate 里，可以用 Rust 的可见性修饰来替代 crate 边界：

```rust
// domain/user.rs

// 对外完全可见
pub struct User { ... }

// 只在 domain 模块内可见，不泄漏给 infra 或 main
pub(super) fn validate_email(email: &str) -> bool { ... }

// 只在 crate 内可见，不能被外部 crate 依赖（如果后来变成库）
pub(crate) struct UserBuilder { ... }
```

Rust 可见性体系：

| 修饰符 | 可见范围 |
|--------|----------|
| 无修饰（`pub`） | 对所有人可见 |
| `pub(crate)` | 只在本 crate 内可见 |
| `pub(super)` | 只在父模块可见 |
| 无修饰（私有） | 只在当前模块可见 |

好的实践是：**默认私有，按需开放**。不要因为懒得想就把所有东西都写 `pub`。

---

## 四、什么时候升级到 workspace 多 crate

单 crate 项目有几个明确的升级信号：

**1. 出现了稳定、需要跨项目复用的能力**

比如：你写了一套业务规则，另一个服务也要用。这时候把它提取成独立 crate，就可以像普通依赖一样引用。

**2. 有多个二进制入口**

比如：一个 HTTP 服务 + 一个后台任务 CLI + 一个数据库迁移工具。它们共用相同的业务逻辑，但入口不同。这时候业务逻辑作为库 crate，三个入口作为独立的 bin crate 更合理。

**3. 需要用边界来强制隔离**

单 crate 里，你可以用 `pub(crate)` 来"软隔离"，但仍然可以绕过。一旦拆成不同 crate，你就没法访问其他 crate 里不是 `pub` 的东西——这是**硬边界**，编译器强制执行。

**4. 编译速度开始影响开发效率**

Rust 按 crate 做增量编译。把很少变化的稳定代码（比如核心业务逻辑）拆成独立 crate，能显著减少不必要的重编译。

---

## 五、多 crate workspace 的目录结构

本文示例工程 `workspaces/skeleton-demo` 就是一个完整的多 crate workspace。

整体结构：

```
skeleton-demo/
├── Cargo.toml          # workspace 根配置
├── apps/               # 二进制入口层
│   └── server/
│       ├── Cargo.toml
│       └── src/
│           └── main.rs
└── crates/             # 库 crate 层
    ├── core/           # 业务核心，无外部依赖
    │   ├── Cargo.toml
    │   ├── src/
    │   │   ├── lib.rs
    │   │   ├── error.rs
    │   │   ├── model/
    │   │   │   └── user.rs
    │   │   ├── port/
    │   │   │   └── user_repo.rs
    │   │   └── service/
    │   │       └── user.rs
    │   └── tests/
    │       └── user_service_test.rs
    └── infra/          # 具体实现，依赖 core
        ├── Cargo.toml
        └── src/
            ├── lib.rs
            └── memory/
                └── user_store.rs
```

目录约定：

- `apps/`：放所有二进制入口。每个 app 是一个独立的 Cargo package，负责"组装"。
- `crates/`：放所有库 crate。这里的东西不包含 main，只提供能力。

### 5.1 workspace 根配置

```toml
# Cargo.toml（workspace 根）
[workspace]
members = [
    "apps/server",
    "crates/core",
    "crates/infra",
]
resolver = "2"

[workspace.package]
edition = "2024"
version = "0.1.0"

# 在根 Cargo.toml 统一声明内部依赖，所有 member 共用
[workspace.dependencies]
core = { path = "crates/core" }
infra = { path = "crates/infra" }
```

把版本和路径集中管理，所有 member 使用 `core.workspace = true` 引用，避免重复声明。

---

## 六、核心层（core crate）的设计

`core` crate 是整个项目的心脏。

它的关键属性是：

> **不依赖任何外部 crate**（除标准库）。

`core/Cargo.toml` 里 `[dependencies]` 应该是空的（或只包含纯数据类型工具，如 `chrono`、`uuid`）。这个约束让你随时可以独立编译、独立测试 core，而不需要启动任何基础设施。

### 6.1 领域模型：用强类型表达业务概念

```rust
// crates/core/src/model/user.rs

// 用强类型表达 ID，避免 u64 满天飞导致的语义混淆
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct UserId(u64);

impl UserId {
    pub fn new(id: u64) -> Self { UserId(id) }
    pub fn value(self) -> u64 { self.0 }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserRole { Regular, Admin }

/// 用户实体：字段私有，只能通过方法访问
/// 构造时统一验证，不允许创建出不合法的 User
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    id: UserId,
    name: String,
    email: String,
    role: UserRole,
}

impl User {
    pub fn new(
        id: UserId,
        name: impl Into<String>,
        email: impl Into<String>,
        role: UserRole,
    ) -> Result<Self, CoreError> {
        let name = name.into();
        let name = name.trim();
        if name.is_empty() {
            return Err(CoreError::EmptyName);
        }
        // ...邮箱格式验证...
        Ok(Self { id, name: name.to_string(), email: email.into(), role })
    }

    // 业务操作：不是简单的字段赋值，而是包含业务规则
    pub fn promote_to_admin(&mut self) {
        self.role = UserRole::Admin;
    }
}
```

这里有几个值得注意的细节：

**字段全部私有**：`User` 的字段没有任何 `pub`。这意味着不能在 `core` 外部直接构造或修改 `User`，必须通过方法。这样可以保证"不合法的 User 永远不存在"。

**强类型 ID**：`UserId(u64)` 而不是裸 `u64`。这在编译期就能防止把 `OrderId` 误传给需要 `UserId` 的函数。

### 6.2 端口（Port）：定义接口，不实现

```rust
// crates/core/src/port/user_repo.rs

use crate::{CoreError, model::user::{User, UserId}};

/// 用户仓储接口
///
/// core crate 声明"需要什么"，不管"怎么实现"。
/// 这是依赖倒置原则在 Rust 里最直接的表达。
pub trait UserRepository {
    fn next_id(&self) -> UserId;
    fn save(&mut self, user: User) -> Result<(), CoreError>;
    fn find_by_id(&self, id: UserId) -> Option<User>;
    fn find_by_email(&self, email: &str) -> Option<User>;
    fn update(&mut self, user: User) -> Result<(), CoreError>;
    fn list(&self) -> Vec<User>;
}
```

这个 trait 完全在 `core` crate 里定义。`infra` crate 去实现它，`core` 完全不知道 `infra` 的存在。

### 6.3 服务层：业务逻辑的入口

```rust
// crates/core/src/service/user.rs

pub struct UserService<R> {
    repo: R,
}

impl<R: UserRepository> UserService<R> {
    pub fn new(repo: R) -> Self { Self { repo } }

    pub fn register(&mut self, name: &str, email: &str) -> Result<User, CoreError> {
        // 业务规则：邮箱不能重复
        if self.repo.find_by_email(email).is_some() {
            return Err(CoreError::EmailAlreadyExists { email: email.to_string() });
        }
        let id = self.repo.next_id();
        let user = User::new(id, name, email, UserRole::Regular)?;
        self.repo.save(user.clone())?;
        Ok(user)
    }

    pub fn promote_to_admin(&mut self, id: UserId) -> Result<User, CoreError> {
        let mut user = self.get(id)?;
        user.promote_to_admin();
        self.repo.update(user.clone())?;
        Ok(user)
    }
    // ...
}
```

`UserService<R>` 对 `R: UserRepository` 泛型。它只和接口打交道，不知道背后是内存存储、SQLite 还是 PostgreSQL。

### 6.4 core 的公开接口

```rust
// crates/core/src/lib.rs

mod error;
pub mod model;
mod port;
mod service;

// 只暴露外层真正需要的符号
pub use error::CoreError;
pub use model::user::{User, UserId, UserRole};
pub use port::user_repo::UserRepository;
pub use service::user::UserService;
```

`port` 和 `service` 模块本身是私有的（没有 `pub mod`），但通过 `pub use` 把需要暴露的类型重新导出。外层 crate 看到的是一个扁平的 API，而不是内部的模块树。

---

## 七、基础设施层（infra crate）的设计

`infra` crate 的职责是实现 `core` 定义的接口。

```toml
# crates/infra/Cargo.toml
[dependencies]
core.workspace = true
# 如果是真实项目，这里还会有：
# sqlx = { version = "...", features = [...] }
# redis = "..."
```

具体实现：

```rust
// crates/infra/src/memory/user_store.rs

use core::{CoreError, UserRepository, model::user::{User, UserId}};

#[derive(Debug, Default)]
pub struct InMemoryUserStore {
    next_id: u64,
    users: BTreeMap<u64, User>,
}

impl UserRepository for InMemoryUserStore {
    fn next_id(&self) -> UserId { UserId::new(self.next_id) }

    fn save(&mut self, user: User) -> Result<(), CoreError> {
        // 检查邮箱唯一性
        let email = user.email().to_string();
        if self.users.values().any(|u| u.email() == email) {
            return Err(CoreError::EmailAlreadyExists { email });
        }
        self.users.insert(user.id().value(), user);
        self.next_id += 1;
        Ok(())
    }
    // ...
}
```

未来需要换成真实数据库时，只需要：

1. 在 `infra` 里新增 `postgres/user_store.rs`，实现同样的 `UserRepository` trait
2. 在 `apps/server/src/main.rs` 里把 `InMemoryUserStore::new()` 换成 `PostgresUserStore::new(pool)`

业务逻辑代码（`core` crate）零修改。

---

## 八、组装层（apps/server）：唯一知道"用谁"的地方

入口层（Composition Root）有一个关键原则：

> 它是整个程序里**唯一需要知道"用哪个具体实现"**的地方。

```rust
// apps/server/src/main.rs

use core::UserService;
use infra::InMemoryUserStore;  // 只有这里知道用 InMemoryUserStore

fn main() {
    // 创建具体实现
    let store = InMemoryUserStore::new();

    // 注入到业务服务（UserService 只知道 R: UserRepository，不知道具体类型）
    let mut service = UserService::new(store);

    // 从这里开始，全部是业务操作，不再出现任何 infra 相关的名字
    let alice = service.register("alice", "alice@example.com").unwrap();
    let promoted = service.promote_to_admin(alice.id()).unwrap();
    // ...
}
```

这个文件通常很短，因为它做的事情很单一：创建依赖 → 注入 → 启动。

---

## 九、测试应该在哪里写

骨架设计正确之后，测试会变得很容易写。

### 9.1 core 的测试：不需要任何基础设施

由于 `UserService<R>` 对 R 是泛型的，测试时可以直接在测试文件里定义一个最简单的 `TestStore`，完全不依赖 `infra` crate：

```rust
// crates/core/tests/user_service_test.rs

use core::{CoreError, UserService, model::user::UserId};

// 测试用的极简存储
struct TestStore { ... }
impl UserRepository for TestStore { ... }

#[test]
fn register_creates_regular_user() {
    let mut svc = UserService::new(TestStore::new());
    let user = svc.register("alice", "alice@example.com").unwrap();
    assert_eq!(user.name(), "alice");
    assert_eq!(user.role(), &UserRole::Regular);
}

#[test]
fn register_rejects_duplicate_email() {
    let mut svc = UserService::new(TestStore::new());
    svc.register("alice", "alice@example.com").unwrap();
    let err = svc.register("alice2", "alice@example.com").unwrap_err();
    assert_eq!(err, CoreError::EmailAlreadyExists {
        email: "alice@example.com".to_string(),
    });
}
```

这 6 个测试（见 `workspaces/skeleton-demo/crates/core/tests/user_service_test.rs`）在不启动任何数据库的情况下覆盖了所有核心业务规则，运行极快。

### 9.2 测试放在哪里

| 测试类型 | 位置 | 说明 |
|----------|------|------|
| 单元测试（测内部细节） | `src/` 里的 `#[cfg(test)] mod tests` | 可以访问私有接口 |
| 集成测试（测公开 API） | `tests/` 目录 | 只通过公开接口测试，更贴近使用者视角 |
| 端到端测试 | `apps/` 下或单独 crate | 需要真实基础设施 |

本文示例选择了集成测试（`tests/` 目录），因为业务规则应该通过公开 API 来验证，而不是直接访问内部细节。

---

## 十、整体依赖方向回顾

把所有 crate 的依赖关系画出来，应该是这样的：

```
apps/server
    ├── depends on → crates/core
    └── depends on → crates/infra

crates/infra
    └── depends on → crates/core

crates/core
    └── (no external dependencies)
```

关键点：

1. **箭头方向单向**：没有循环依赖
2. **`core` 在最底层**：它不依赖任何人，只被别人依赖
3. **`infra` 只依赖 `core`**：不依赖 `apps`，不会因为入口层的变化而改变
4. **`apps` 在最顶层**：它可以依赖所有人，但也只在这一层做"组装"

---

## 十一、总结：可维护骨架的检查清单

设计完项目骨架，可以对照这个清单检查：

**依赖方向**
- [ ] `domain`（或 `core`）不依赖任何具体的基础设施库
- [ ] 没有循环依赖
- [ ] 入口层是唯一知道"用哪个具体实现"的地方

**边界管理**
- [ ] 不同职责（业务 / 接口 / 实现 / 启动）在不同的模块或 crate 里
- [ ] 公开 API 是经过设计的 `pub use` 列表，而不是所有东西都 `pub`

**可测试性**
- [ ] 业务逻辑可以在不启动任何外部服务的情况下测试
- [ ] trait 接口是否足够薄，可以用简单的测试实现替换

**可替换性**
- [ ] 基础设施实现可以被替换（换数据库、换缓存）而不需要改业务代码

满足这四类条件的骨架，才算是"可维护的"。

---

这一篇建立了项目骨架的基础。

下一篇 [Rust 工程化实战（二）：配置、日志、错误处理如何统一起来]，会在这个骨架基础上，把配置加载、日志初始化、跨层错误处理这三件事系统地接入进来。
