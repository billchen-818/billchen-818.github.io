---
title: Rust 测试体系设计：单元测试、集成测试、异步测试与测试数据管理
date: 2026-05-20 10:27:45
tags: Rust
---

很多人刚开始写 Rust 测试时，思路都很直接：

- 给几个函数加上 `#[test]`
- 跑一下 `cargo test`
- 看到绿色通过，就觉得测试差不多了

这在小 demo 阶段通常没问题。

但只要项目开始变成“长期维护”的程序，测试问题就会立刻从“有没有”变成“怎么组织”：

- 哪些逻辑应该写成单元测试，哪些应该放进集成测试
- 异步代码到底该怎么测，难道每个地方都直接上 `#[tokio::test]`
- 测试数据到底写死在代码里，还是单独放 fixture
- 一个测试失败时，到底说明业务规则错了，还是说明组装方式错了
- 为什么测试一多，跑起来反而越来越慢，改起来越来越脆

这说明：

> Rust 里的测试，不是“补几条断言”这么简单，而是一套边界清晰、反馈分层的工程设计。

这一篇我想讲的核心，不是某个测试宏怎么写，而是下面几件事：

1. 单元测试、集成测试、异步测试分别应该验证什么
2. 为什么测试边界如果没分清，后面测试会越来越贵
3. 测试数据和测试辅助代码应该怎么组织，才不会把工程拖乱
4. 怎样让测试真正成为重构保护网，而不是形式化负担

文中的完整示例工程在 `workspaces/testing-demo`。

---

## 一、先说结论：测试不是按“框架能力”分，而是按“反馈层次”分

很多人学测试时，会先接触这些词：

- 单元测试
- 集成测试
- 异步测试
- 端到端测试

然后很容易把它们理解成“几种不同语法”。

但从工程角度看，更有用的理解方式是：

> 不同类型的测试，对应的是不同层次的反馈。

例如：

- 单元测试回答的是“这段局部逻辑本身对不对”
- 集成测试回答的是“对外暴露的能力组合起来对不对”
- 异步测试回答的是“这段依赖运行时调度的逻辑，在异步上下文里对不对”

这几个问题不是互相替代的。

所以测试体系设计的第一步，不是先写代码，而是先分清你到底要验证哪一层。

如果这一点没想清楚，后面就很容易出现两个极端：

- 什么都写成单元测试，结果外部接口一改全漏掉
- 什么都写成集成测试，结果运行很慢、定位很差、维护成本很高

---

## 二、一个可维护的测试体系，通常至少分三层

我更推荐把大多数 Rust 项目的测试，先拆成三层来看：

1. 纯逻辑层：验证局部规则、边界条件、错误分支
2. 对外接口层：验证公开 API 的组合行为
3. 运行时层：验证异步代码、调度、超时、状态变化

在示例工程里，这三层分别对应：

- 源码内部的单元测试 `workspaces/testing-demo/src/service.rs`
- `tests/` 目录下的集成测试 `workspaces/testing-demo/tests/task_service.rs`
- 带 `#[tokio::test]` 的异步测试 `workspaces/testing-demo/tests/task_service.rs`

配套还有两块很关键的组织代码：

- 测试辅助模块 `workspaces/testing-demo/tests/support/mod.rs`
- 测试数据文件 `workspaces/testing-demo/tests/fixtures/tasks.txt`

这套结构的重点不是“目录摆得好看”，而是：

> 让不同测试只关注自己该验证的那一层，而不是互相越界。

---

## 三、单元测试：优先测试局部规则，而不是整个流程

示例里的 `TaskService` 有一个私有函数 `normalize_title`，负责做标题规整和校验：

```rust
fn normalize_title(title: &str) -> Result<String, TaskError> {
    let trimmed = title.trim();

    if trimmed.is_empty() {
        return Err(TaskError::EmptyTitle);
    }

    if trimmed.chars().count() > 40 {
        return Err(TaskError::TitleTooLong);
    }

    Ok(trimmed.to_string())
}
```

对应的单元测试也很直接：

```rust
#[test]
fn normalize_title_rejects_blank_input() {
    let error = normalize_title("   ").unwrap_err();
    assert_eq!(error, TaskError::EmptyTitle);
}
```

这类测试最适合验证：

- 边界值
- 错误分支
- 纯逻辑转换
- 私有辅助函数的行为

它们的特点通常是：

- 跑得快
- 失败定位准
- 不依赖外部组装上下文

所以单元测试最适合承担的是“第一层反馈”。

也就是：

> 每次改一点小逻辑，都能立刻知道有没有把局部规则改坏。

### 3.1 单元测试里最容易犯的错

最常见的错误，不是单元测试写少了，而是“把本来应该拆开的逻辑混在一个函数里”，导致根本找不到值得单测的边界。

如果你发现一个函数：

- 既做输入校验
- 又做状态更新
- 还顺带访问外部资源

那往往不是测试难写，而是代码边界本身就不清楚。

这也是我一直很认同的一点：

> 很多测试问题，最终都不是测试技术问题，而是代码设计问题。

---

## 四、集成测试：验证公开能力，而不是内部实现细节

Rust 的 `tests/` 目录很有价值的一点是：

> 它会把你的 crate 当成外部使用者来测试。

这意味着在 `tests/task_service.rs` 里，你只能通过公开 API 去验证行为，而不是直接碰内部私有实现。

例如示例中的这条测试：

```rust
#[test]
fn add_task_trims_title_before_storing() {
    let mut service = support::fixture_service();

    let id = service
        .add_task(NewTask {
            title: "  write async section  ".to_string(),
            priority: Priority::High,
        })
        .unwrap();

    let created = service.tasks().iter().find(|task| task.id == id).unwrap();
    assert_eq!(created.title, "write async section");
    assert_eq!(created.status, TaskStatus::Todo);
}
```

这里并没有去直接测试 `normalize_title` 这个内部函数，而是通过 `add_task` 这个公开入口，确认对外行为是否正确。

这类测试最适合验证：

- 一个公开方法的整体行为
- 多个内部逻辑组合后的最终结果
- 对外返回的数据结构和状态变化

### 4.1 集成测试的价值，不是“更高级”，而是“更接近真实使用方式”

很多人会误以为集成测试比单元测试高级，所以写得越多越好。

其实不是。

它的价值主要在于：

> 它更接近外部调用者真正看到的世界。

单元测试能告诉你某个内部规则没坏。

但只有集成测试能告诉你：

- 公共 API 还能不能正常用
- 公开行为是否还是预期的
- 模块之间组装起来以后有没有跑偏

所以它的重要性不在于“层级更高”，而在于“视角不同”。

---

## 五、异步测试：不要把它理解成“单元测试前面多写一个宏”

Rust 异步测试最容易被误解成这句：

> 把 `#[test]` 换成 `#[tokio::test]` 就行了。

这当然是表面写法，但真正要理解的是：

> 异步测试的重点不在宏，而在于你正在验证一段依赖运行时的逻辑。

示例里的异步方法是：

```rust
pub async fn pending_count_after_sync(&self) -> usize {
    sleep(Duration::from_millis(5)).await;
    self.tasks
        .iter()
        .filter(|task| task.status == TaskStatus::Todo)
        .count()
}
```

对应测试：

```rust
#[tokio::test(flavor = "current_thread")]
async fn pending_count_supports_async_tests() {
    let service = support::fixture_service();
    let pending_count = service.pending_count_after_sync().await;

    assert_eq!(pending_count, 2);
}
```

这里有两个值得注意的点。

### 5.1 异步测试验证的是“运行时上下文下的行为”

一段逻辑只要涉及：

- `async fn`
- `await`
- 超时
- 并发任务
- 调度顺序

那它就已经不再只是普通纯函数测试了。

这时你要测试的不只是结果值，还包括它在异步上下文里是否按预期推进。

### 5.2 测试运行时也应该尽量克制

示例里用的是：

```rust
#[tokio::test(flavor = "current_thread")]
```

这不是必须，但它体现了一个很实用的态度：

> 如果测试不需要多线程运行时，就不要默认把运行环境放大。

因为测试环境越重：

- 运行越慢
- 排查越复杂
- 偶发性问题越难定位

异步测试不是越“接近生产环境”越好，而是越“刚好满足验证目标”越好。

---

## 六、测试数据管理：别让 fixture 到处散落

测试写到后面，最容易变乱的其实不是断言，而是测试数据。

比如：

- 每个测试都手写一份任务列表
- 同样的数据在多个测试文件里复制
- 测试辅助函数和测试数据混在一起
- 改一个字段，十几个测试同时碎掉

示例里把这块拆成了两部分：

1. 测试辅助模块 `workspaces/testing-demo/tests/support/mod.rs`
2. 测试 fixture 文件 `workspaces/testing-demo/tests/fixtures/tasks.txt`

辅助模块里对外暴露一个统一入口：

```rust
pub fn fixture_service() -> TaskService {
    TaskService::with_tasks(load_tasks_from_fixture())
}
```

它的好处很直接：

- 测试代码不需要知道 fixture 如何加载
- fixture 格式变了，只改一处
- 多个测试可以复用相同初始状态

这块我自己的经验是：

> 测试数据不是越“就近写”越好，而是越“能稳定复用”越好。

当然，也不是所有数据都要抽成文件。

如果只是一个很小、很局部、只服务单个测试的数据，内联写在测试里反而更清楚。

真正值得抽出来的，通常是：

- 多个测试共享的数据
- 结构稍复杂的数据
- 会反复演进的数据场景

---

## 七、单元测试和集成测试到底怎么分？一个实用判断法

很多人最常问的问题就是这个：

> 到底什么应该写在 `src` 里的 `#[cfg(test)]`，什么应该写在 `tests/`？

我通常用下面这个判断法：

### 7.1 如果你在验证“内部规则”，优先单元测试

例如：

- 字符串规整
- 状态转换边界
- 错误分支
- 私有辅助函数

### 7.2 如果你在验证“公开行为”，优先集成测试

例如：

- `add_task` 之后对象状态是否正确
- 某个公开 API 是否仍符合预期
- 模块组合之后的对外结果是否稳定

### 7.3 如果测试依赖运行时，明确把它当成异步测试处理

例如：

- `async fn`
- 并发逻辑
- 定时器
- channel
- 重试与超时

这个分法最大的价值是：

> 让每种测试只承担自己该承担的反馈责任。

一旦你把这个责任划清，测试数量变多也不容易失控。

---

## 八、为什么有些测试越写越脆？

这是我很想强调的一点。

很多项目不是没有测试，而是测试越来越难维护。

通常有几个典型原因：

### 8.1 过度断言实现细节

比如本来只需要断言最终行为，却把中间状态、内部顺序、临时结构全断言了一遍。

这样代码稍微重构一下，测试就碎，但业务其实没坏。

### 8.2 一个测试覆盖太多责任

如果一条测试同时验证：

- 输入校验
- 状态更新
- 输出格式
- 异步流程

那它一旦失败，定位成本会很高。

### 8.3 测试数据构造成本太高

如果每个测试都要手搓一大堆初始化状态，后面大家就会越来越不想补测试。

所以从维护角度看，一个好的测试不只是“能抓 bug”，还应该满足：

- 失败定位快
- 重构时稳定
- 新人容易读懂
- 新场景容易补充

这比单纯提高覆盖率数字更有意义。

---

## 九、完整示例：一个最小但结构完整的测试 demo

示例工程 `workspaces/testing-demo` 里一共放了几类东西：

1. 领域模型 `workspaces/testing-demo/src/task.rs`
2. 服务逻辑和单元测试 `workspaces/testing-demo/src/service.rs`
3. 集成测试 `workspaces/testing-demo/tests/task_service.rs`
4. smoke test `workspaces/testing-demo/tests/smoke.rs`
5. 测试辅助模块 `workspaces/testing-demo/tests/support/mod.rs`
6. fixture 文件 `workspaces/testing-demo/tests/fixtures/tasks.txt`

这套结构虽然很小，但已经能覆盖一篇工程实战文章最核心的几个点：

- 局部逻辑如何单测
- 公开行为如何集成测试
- 异步逻辑如何运行在测试 runtime 里
- 测试数据如何复用和收口

---

## 十、实际运行结果

在 `workspaces/testing-demo` 下执行：

```bash
cargo test
```

当前示例已经可以稳定通过，运行结果会看到：

```text
running 3 tests
...
test result: ok. 3 passed

running 1 test
...
test result: ok. 1 passed

running 4 tests
...
test result: ok. 4 passed
```

这 3 组结果分别对应：

- `src/lib.rs` 下的单元测试
- `smoke.rs` 的最小公开能力验证
- `task_service.rs` 的集成测试和异步测试

---

## 十一、我对 Rust 测试体系的几个判断

这部分是我自己的经验总结。

### 11.1 先追求反馈质量，不要先追求测试数量

如果测试很多，但定位很慢、维护很痛苦，那它们的价值会快速下降。

### 11.2 单元测试不是越细越好，集成测试也不是越大越好

真正关键的是：

> 每条测试验证的责任是否单一。

### 11.3 异步测试的重点不是宏，而是运行时语义

不要只记 `#[tokio::test]` 的写法，要先想清楚这段逻辑到底依赖了什么异步行为。

### 11.4 测试数据管理是测试工程化的一半

很多测试后期失控，并不是断言写错了，而是 fixture、helper、初始化状态完全失去组织。

### 11.5 好的测试体系，本质上是在保护重构

如果一套测试不能让你更放心地改代码，那它的工程价值就会打折。

---

## 结语

Rust 的测试能力本身并不复杂，复杂的是你怎么把它们组织成一套长期可维护的反馈系统。

如果只是写几个 `#[test]`，很多项目也能动起来；但一旦系统开始长大，你就会发现，真正重要的不是“有没有测试”，而是：

- 哪一层逻辑由哪一层测试负责
- 哪些规则应该局部验证，哪些应该从公开接口验证
- 异步逻辑是否在合适的运行时里被验证
- 测试数据和辅助代码有没有被稳定组织起来

所以这篇文章如果只留一句建议，我会写这句：

> 测试不是给代码加附件，而是给系统建立分层反馈。

一旦你用这个视角去看单元测试、集成测试、异步测试和 fixture 管理，它们就不再是零散技巧，而会变成一套真正有工程价值的测试体系。