---
title: Rust workspace 多 crate 项目组织实战：什么时候拆包，怎么拆才合理
date: 2026-05-13 07:44:37
tags: Rust
---

## 引言

很多人写 Rust 项目写到一段时间后，都会碰到一个很别扭的问题：

> 代码还没大到失控，但已经开始觉得“所有东西都塞在一个 crate 里有点挤了”。

这时候通常会出现两种相反的倾向。

第一种是完全不拆。

于是项目会慢慢变成这样：

- `main.rs` 越来越大
- `mod service`、`mod db`、`mod http`、`mod config` 一层套一层
- 内部模块越来越多，但边界其实很模糊
- 想复用一部分能力时，只能复制代码

第二种是拆得过早、拆得过碎。

比如项目刚起步，就先拆出：

- `common`
- `utils`
- `core`
- `model`
- `infra`
- `application`

最后 crate 名字看起来很专业，但真正的依赖关系反而更乱，新增一个字段都要改三四个包。

这说明：

> Rust workspace 的重点，不是“把一个项目拆成多个 crate”，而是“在真正有边界的地方建立边界”。

这一篇我会围绕几个最核心的问题展开：

1. Rust workspace 到底解决什么问题
2. 什么时候应该继续放在一个 crate 里，什么时候该拆
3. 拆包时最稳妥的边界应该怎么找
4. 多 crate 项目应该怎样组织目录和依赖方向
5. 怎么避免把 workspace 拆成一套看起来高级、实际很难维护的结构

文章最后会给一套可以直接运行的示例工程，目录在 `workspaces/workspace-demo`。

---

## 一、先回答根问题：workspace 解决的到底是什么？

很多人第一次接触 Rust workspace，会把它理解成“一个大仓库里放多个 crate”。

这当然没错，但还不够。

从工程角度看，workspace 主要解决的是下面几类问题。

### 1.1 让多个 crate 共享同一套构建上下文

比如：

- 共用一个 `Cargo.lock`
- 共用一个 `target/`
- 统一执行 `cargo check`、`cargo test`、`cargo fmt`

这意味着：

> 你可以把项目拆成多个 crate，但仍然像管理一个项目一样管理它们。

### 1.2 让边界从“目录约定”变成“编译器约束”

如果你只有一个 crate，那么很多所谓的“层次边界”其实只是目录约定。

例如：

- `service` 不应该直接依赖 `http`
- `domain` 不应该读环境变量
- 业务模型不应该依赖具体数据库库

但在单 crate 里，这些边界很多时候只是靠自觉。

而一旦拆成不同 crate，边界会变成真正的依赖关系：

- 某个 crate 有没有权限依赖另一个 crate
- 哪些类型能被复用
- 哪些实现细节不会泄漏出去

这些都会由编译器帮你守住。

### 1.3 让“可复用部分”和“组装部分”分开

项目里通常会同时存在两种东西：

1. 稳定、可复用、和运行入口无关的能力
2. 负责把配置、日志、存储、HTTP、CLI 这些东西真正组装起来的入口代码

把这两类东西混在一起时，代码会越来越难维护。

而 workspace 很适合把它们拆开：

- 库 crate 存放稳定能力
- 二进制 crate 存放启动和组装逻辑

---

## 二、什么时候不该拆？

这部分很重要。

因为很多人看完 workspace 介绍之后，最容易犯的错不是“不会拆”，而是“什么都想拆”。

下面这些场景，通常还不值得上多 crate。

### 2.1 项目规模还很小，而且边界非常稳定地集中在一个地方

如果你的项目当前就是：

- 一个二进制程序
- 模块数不多
- 只有一个运行入口
- 没有明确的复用需求

那先保持单 crate 往往更合适。

因为这时候最大的成本通常不是“crate 太少”，而是“业务本身还在快速变化”。

过早拆包会让你在结构上投入太多精力。

### 2.2 只是为了“看起来更架构化”而拆

如果拆包理由只是：

- 想让目录看起来更专业
- 想模仿某个大型项目
- 想先把分层框架搭满

那大概率会适得其反。

Rust 的 crate 边界是强边界，不是轻量目录。

一旦拆了，后面每次调整依赖、移动类型、改公共接口，成本都是真的。

### 2.3 你还说不清每个 crate 的职责是什么

一个非常直接的判断标准是：

> 如果你不能用一句话说清这个 crate 的职责，那通常还不该拆。

例如：

- `task-domain`：定义任务领域模型和业务规则
- `task-store`：提供任务仓储的内存实现
- `task-cli`：负责应用启动和命令行输出

这是清楚的。

而像下面这些名字，通常风险就比较高：

- `common`
- `core`
- `base`
- `utils`

它们太容易变成“什么都往里塞”的垃圾桶 crate。

---

## 三、什么时候值得拆？

真正值得拆包的时机，通常来自这几个信号。

### 3.1 有明确的复用边界

比如：

- 领域模型想同时给 HTTP 服务和 CLI 工具复用
- 一套协议类型需要被 client 和 server 共用
- 一套核心计算逻辑不应该依赖具体运行入口

这时把可复用部分抽成独立库 crate 就很自然。

### 3.2 有明确的依赖方向需要被保护

例如你希望：

- 领域层不依赖存储实现
- 业务逻辑不依赖 CLI 或 HTTP 细节
- 公共协议不依赖运行时框架

这种时候，crate 是非常强的边界工具。

### 3.3 二进制入口已经明显承担了过多职责

如果一个 `main.rs` 已经同时负责：

- 配置加载
- 路由注册
- 业务逻辑
- 存储初始化
- 定时任务

那通常说明你至少应该把“可复用逻辑”和“程序入口”分开。

### 3.4 不同部分的变化频率已经明显不同

这是一个很实用的判断方式。

例如：

- 领域模型变化较慢
- 存储实现可能会改
- 运行入口和组装代码变化更频繁

如果把这些东西塞在一起，改动会互相污染。

而拆成 crate 之后，不同变化频率的代码就能更自然地隔离开。

---

## 四、拆包时最应该看什么：不是“层数”，而是边界

很多人第一次拆 Rust 项目，会优先按“经典分层”来拆：

- controller
- service
- repository
- model

这并不是绝对错误，但经常会拆得太教科书。

更稳妥的思路通常是看下面三件事：

### 4.1 这部分代码是否需要独立复用？

如果答案是“会”，那就有成为独立 crate 的潜力。

### 4.2 这部分代码是否应该独立演化？

如果某部分的改动频率、依赖关系、测试方式和其他代码显著不同，也很适合拆开。

### 4.3 这部分代码的依赖是否应该被严格限制？

例如领域模型就很适合保持“向内收敛”，尽量少依赖外部实现细节。

所以比起“先按名词分层”，更推荐的思路是：

> 按职责边界、依赖方向和变化频率拆，而不是按流行术语拆。

---

## 五、一个更实用的拆法：二进制 crate + 领域 crate + 基础设施 crate

为了把这个问题讲清楚，我们直接看一套具体示例。

完整目录在 `workspaces/workspace-demo`。

这个示例包含 3 个 crate：

1. `task-cli`：二进制入口，负责组装程序
2. `task-domain`：领域模型、仓储接口、业务规则
3. `task-store`：基于内存的仓储实现

目录结构如下：

```text
workspace-demo/
├── Cargo.toml
├── apps/
│   └── task-cli/
│       ├── Cargo.toml
│       └── src/
│           └── main.rs
└── crates/
    ├── task-domain/
    │   ├── Cargo.toml
    │   ├── src/
    │   │   ├── error.rs
    │   │   ├── lib.rs
    │   │   ├── repository.rs
    │   │   ├── service.rs
    │   │   └── task.rs
    │   └── tests/
    │       └── task_flow.rs
    └── task-store/
        ├── Cargo.toml
        └── src/
            └── lib.rs
```

这套结构背后有几个很关键的判断：

- 运行入口和业务规则分开
- 领域逻辑不依赖具体存储实现
- 存储实现依赖领域接口，而不是反过来

这比“随便拆几个名字很大但职责含糊的 crate”更稳。

---

## 六、先看 workspace 根配置

### 6.1 根 `Cargo.toml`

```toml
[workspace]
members = [
    "apps/task-cli",
    "crates/task-domain",
    "crates/task-store",
]
resolver = "2"

[workspace.package]
edition = "2021"
version = "0.1.0"

[workspace.dependencies]
task-domain = { path = "crates/task-domain" }
task-store = { path = "crates/task-store" }
```

这里有几个重点。

### 6.2 `members` 决定工作空间包含哪些 crate

所有子 crate 都在这里统一声明。

这样你就可以在 workspace 根目录直接执行：

```bash
cargo check
cargo test
cargo run -p task-cli
```

### 6.3 `workspace.dependencies` 可以减少依赖重复声明

这样做的好处是：

- 子 crate 引用内部依赖更统一
- 版本和路径集中管理
- 后续改动不需要到处同步

---

## 七、领域 crate 该放什么，不该放什么？

这个问题几乎决定了整个 workspace 后面会不会越长越歪。

在这个示例里，`task-domain` 放的是三类东西：

1. 领域实体 `Task`
2. 领域错误 `DomainError`
3. 业务接口 `TaskRepository` 和 `TaskService`

它不放这些东西：

- CLI 输出逻辑
- 具体数据库实现
- 环境变量读取
- 框架初始化代码

也就是说：

> 领域 crate 负责表达“任务系统应该怎么工作”，而不是“程序今天怎么启动”。

### 7.1 `task-domain/src/task.rs`

```rust
use crate::error::DomainError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    id: u64,
    title: String,
    status: TaskStatus,
}

impl Task {
    pub fn new(id: u64, title: impl Into<String>) -> Result<Self, DomainError> {
        let title = title.into();
        let title = title.trim();

        if title.is_empty() {
            return Err(DomainError::EmptyTitle);
        }

        Ok(Self {
            id,
            title: title.to_string(),
            status: TaskStatus::Pending,
        })
    }

    pub fn complete(&mut self) -> Result<(), DomainError> {
        if self.status == TaskStatus::Done {
            return Err(DomainError::TaskAlreadyDone { id: self.id });
        }

        self.status = TaskStatus::Done;
        Ok(())
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn status(&self) -> &TaskStatus {
        &self.status
    }
}
```

这里的重点不是代码本身复杂，而是它保持了非常干净的依赖：

- 只依赖标准库和本 crate 的错误类型
- 不知道存储细节
- 不知道 CLI、HTTP、数据库

这种代码天然更容易测试和复用。

### 7.2 `task-domain/src/repository.rs`

```rust
use crate::{error::DomainError, task::Task};

pub trait TaskRepository {
    fn next_id(&self) -> u64;
    fn insert(&mut self, task: Task);
    fn get(&self, id: u64) -> Option<Task>;
    fn update(&mut self, task: Task) -> Result<(), DomainError>;
    fn list(&self) -> Vec<Task>;
}
```

这个接口非常关键。

它表达的是：

> 领域服务需要一个能存取任务的仓储，但并不关心仓储具体是内存、文件还是数据库。

这就是很典型、也很适合放在领域 crate 里的抽象。

### 7.3 `task-domain/src/service.rs`

```rust
use crate::{error::DomainError, repository::TaskRepository, task::Task};

pub struct TaskService<R> {
    repository: R,
}

impl<R> TaskService<R>
where
    R: TaskRepository,
{
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn create_task(&mut self, title: &str) -> Result<Task, DomainError> {
        let id = self.repository.next_id();
        let task = Task::new(id, title)?;
        self.repository.insert(task.clone());
        Ok(task)
    }

    pub fn complete_task(&mut self, id: u64) -> Result<Task, DomainError> {
        let mut task = self
            .repository
            .get(id)
            .ok_or(DomainError::TaskNotFound { id })?;

        task.complete()?;
        self.repository.update(task.clone())?;
        Ok(task)
    }

    pub fn list_tasks(&self) -> Vec<Task> {
        self.repository.list()
    }
}
```

这里业务规则就被稳定收口在领域 crate 里了。

后面你无论是：

- 写 CLI
- 接 HTTP
- 换成数据库实现

都不用改这些核心规则。

---

## 八、基础设施 crate 为什么依赖领域，而不是领域依赖基础设施？

这是多 crate 设计里最重要的依赖方向之一。

在示例里，`task-store` 是这样定义的：

```rust
use std::collections::BTreeMap;
use task_domain::{DomainError, Task, TaskRepository};

#[derive(Debug, Default)]
pub struct InMemoryTaskRepository {
    next_id: u64,
    tasks: BTreeMap<u64, Task>,
}
```

它实现了 `TaskRepository`，但接口定义本身仍然在 `task-domain` 里。

这意味着依赖方向是：

`task-cli -> task-store -> task-domain`

而不是：

`task-domain -> task-store`

为什么这个方向更合理？

因为领域规则应该尽量稳定、尽量靠内层。

而基础设施实现：

- 更容易变化
- 更接近外部世界
- 更可能被替换

所以更自然的方式就是：

> 外层依赖内层，具体实现依赖抽象，而不是抽象依赖实现。

---

## 九、二进制 crate 负责什么？

`task-cli` 是示例里唯一的二进制 crate。

它的职责非常明确：

1. 创建具体仓储实现
2. 组装 `TaskService`
3. 调用业务能力
4. 把结果输出给用户

### 9.1 `apps/task-cli/src/main.rs`

```rust
use task_domain::{TaskService, TaskStatus};
use task_store::InMemoryTaskRepository;

fn main() {
    let repository = InMemoryTaskRepository::new();
    let mut service = TaskService::new(repository);

    let first = service.create_task("write workspace article").unwrap();
    let second = service.create_task("extract stable domain crate").unwrap();
    let done = service.complete_task(first.id()).unwrap();

    println!("created task #{}, title={}", second.id(), second.title());
    println!("completed task #{}, status={:?}", done.id(), done.status());

    for task in service.list_tasks() {
        let status = match task.status() {
            TaskStatus::Pending => "pending",
            TaskStatus::Done => "done",
        };

        println!("task #{}, title={}, status={}", task.id(), task.title(), status);
    }
}
```

你会发现这里没有什么“核心规则”。

因为入口 crate 的重点本来就不应该是业务规则，而是组装和调用。

这正是把二进制 crate 单独拿出来的意义。

---

## 十、这套结构为什么比“一个超大 crate”更稳？

先说结论：

> 它不是因为 crate 变多了而更好，而是因为边界终于变得可验证了。

具体来说，至少有这几个收益。

### 10.1 业务规则被独立保护起来了

`task-domain` 不需要知道：

- 程序从命令行启动还是 HTTP 启动
- 仓储是内存版还是数据库版
- 输出打到终端还是日志系统

所以它更容易保持稳定。

### 10.2 外层实现可以替换

今天你用 `task-store` 的内存实现，明天你完全可以再加一个：

- `task-store-sqlite`
- `task-store-postgres`

只要它们实现相同的 `TaskRepository` 接口，领域服务就不用重写。

### 10.3 测试粒度更清晰

领域 crate 可以单独测试业务规则。

例如示例里就在 `workspaces/workspace-demo/crates/task-domain/tests/task_flow.rs` 里对任务流转做了测试。

这类测试非常快，也非常稳定。

### 10.4 构建和阅读入口都更清楚

新人看到这个 workspace 时，通常很容易建立心智模型：

- `task-cli` 是入口
- `task-domain` 是核心规则
- `task-store` 是具体实现

这比一大堆目录互相 import 更容易理解。

---

## 十一、几个很常见的错误拆法

这一节通常比“如何拆”更重要。

### 11.1 错误拆法一：先造一个 `common` crate

这是最常见的问题之一。

很多项目刚开始拆包，就先建一个 `common` 或 `utils`。

短期看它很方便，长期几乎一定会出现这些情况：

- 什么都往里塞
- 依赖方向越来越混乱
- crate 名字看起来通用，职责却越来越不清楚

如果一个 crate 的职责无法被一句话说清，通常就有问题。

### 11.2 错误拆法二：按目录名机械拆，而不是按边界拆

例如：

- `model` crate
- `service` crate
- `repository` crate

如果这些 crate 之间的关系高度耦合，改一个字段就要全部联动，那拆出来的收益往往不大。

### 11.3 错误拆法三：把所有公共类型都过早抽出去

不是所有“被两个地方用到的类型”都值得独立成 crate。

判断关键在于：

- 它是否有稳定语义
- 是否确实形成独立复用边界
- 抽出去后依赖是否更清楚

否则很容易把代码变成“四处引用公共包，但谁都不敢改”。

### 11.4 错误拆法四：让内层 crate 依赖外层 crate

例如：

- `domain` 依赖 `http`
- `domain` 依赖具体数据库库
- `protocol` 依赖服务启动层

这种依赖方向一旦形成，后面整个结构会越来越难救。

---

## 十二、怎么判断一个 crate 拆得是否合理？

这里给几个很实用的检查问题。

如果大部分都能回答得比较清楚，通常说明拆得还算合理。

1. 能不能用一句话说明每个 crate 的职责？
2. crate 之间的依赖方向是不是单向而清楚？
3. 去掉某个具体实现 crate，核心业务是否还能成立？
4. 新增一个运行入口时，能否复用已有领域能力？
5. 你是不是在反复把类型从一个 crate 搬到另一个 crate？

如果第 5 条经常发生，通常说明当前边界还没找准。

---

## 十三、如何运行这个示例 workspace

示例目录在 `workspaces/workspace-demo`。

### 13.1 运行 CLI 示例

```bash
cd workspaces/workspace-demo
cargo run -p task-cli
```

### 13.2 跑整个 workspace 的测试

```bash
cd workspaces/workspace-demo
cargo test
```

### 13.3 查看工作空间里有哪些 crate

你也可以通过根目录直接感受到 workspace 的统一管理方式。

例如你只需要站在根目录，就能完成：

- 对全部 crate 做检查
- 只运行某一个二进制 crate
- 统一跑所有测试

这也是 workspace 在工程协作里很有价值的一点。

---

## 十四、如果项目继续变大，可以怎么演进？

这套示例只是一个起点。

如果你的项目继续变大，可以往下面这些方向演进。

### 14.1 增加新的运行入口 crate

例如除了 `task-cli`，你还可以再增加：

- `task-http`
- `task-worker`

它们都复用同一个领域 crate。

### 14.2 为不同基础设施提供多个实现 crate

例如：

- `task-store-memory`
- `task-store-postgres`

这样替换实现时，核心规则仍然不受影响。

### 14.3 把协议类型单独抽成稳定 crate

只有当协议真的需要跨 client/server 或多个服务复用时，这一步才值得做。

不要一上来就把所有 DTO 都拆出去。

---

## 十五、总结

Rust workspace 真正的价值，不是“项目看起来更大、更专业”，而是：

1. 用 crate 边界把依赖关系约束清楚
2. 把稳定核心和易变实现拆开
3. 让多个 crate 仍然共享统一的构建和测试体验

所以什么时候该拆，核心判断其实只有一句话：

> 当某部分代码已经形成清晰职责、明确依赖方向和稳定复用边界时，才值得把它拆成独立 crate。

而怎么拆，最重要的也不是套某种分层模板，而是尽量满足这几个原则：

- 一个 crate 的职责要能一句话说清
- 内层抽象不要依赖外层实现
- 不要为了“通用”过早造 `common` crate
- 先按真实边界拆，再考虑目录好不好看

如果你当前项目还只是一个中小型服务，其实完全没必要急着把所有东西变成 workspace。

但如果你已经开始出现下面这些信号：

- 入口代码承担过多职责
- 核心逻辑希望被多个入口复用
- 存储、协议、运行时框架之间边界越来越模糊

那 workspace 就很值得上了。

对大多数 Rust 工程项目来说，一个非常实用的起点往往就是这篇里的结构：

- 一个入口 crate 负责组装
- 一个领域 crate 负责核心规则
- 一个或多个实现 crate 负责具体适配

这套方式不花哨，但通常足够稳，也足够能陪项目长大。