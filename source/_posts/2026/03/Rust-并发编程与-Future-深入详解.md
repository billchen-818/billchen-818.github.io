---
title: Rust 并发编程与 Future 深入详解
date: 2026-03-05 15:57:00
tags: Rust
---

## 一、并发与并行：从概念说起

在深入 Rust 的并发编程之前，我们需要先厘清两个经常被混淆的概念：**并发（Concurrency）** 和 **并行（Parallelism）**。

### 1.1 并发（Concurrency）

**并发**是指多个任务在**逻辑上同时推进**，但不一定在物理上同时执行。就像一个厨师在同时做三道菜——他在切菜的间隙去搅拌锅里的汤，再回来继续切菜。任何一个时刻，厨师只在做一件事，但三道菜都在推进。

```
┌──────────────────────────────────────────────────┐
│              并发（单核 CPU）                       │
│                                                    │
│  时间轴 ──────────────────────────────►            │
│                                                    │
│  任务A  ██░░██░░██                                 │
│  任务B  ░░██░░██░░██                               │
│  任务C  ░░░░░░██░░░░██                             │
│                                                    │
│  █ = 正在执行   ░ = 等待/挂起                       │
│  → 同一时刻只有一个任务在执行                        │
└──────────────────────────────────────────────────┘
```

### 1.2 并行（Parallelism）

**并行**是指多个任务在**物理上同时执行**，需要多核 CPU 或多台机器。就像三个厨师同时做三道菜，真正的同时进行。

```
┌──────────────────────────────────────────────────┐
│              并行（多核 CPU）                       │
│                                                    │
│  时间轴 ──────────────────────────────►            │
│                                                    │
│  核心1  ████████████  （任务A）                     │
│  核心2  ████████████  （任务B）                     │
│  核心3  ████████████  （任务C）                     │
│                                                    │
│  → 同一时刻多个任务真正在执行                        │
└──────────────────────────────────────────────────┘
```

### 1.3 关键区别

| 特性 | 并发（Concurrency） | 并行（Parallelism） |
|------|---------------------|---------------------|
| 定义 | 多个任务交替推进 | 多个任务同时执行 |
| 硬件要求 | 单核即可 | 多核/多处理器 |
| 关注点 | 任务的**结构和组织** | 任务的**同时执行** |
| 典型场景 | I/O 密集型（网络、文件） | CPU 密集型（计算、渲染） |
| Rust 实现 | async/await、协程 | 多线程、Rayon |

> **Rob Pike 的经典总结**：*"Concurrency is about dealing with lots of things at once. Parallelism is about doing lots of things at once."*
> 并发是关于**同时处理**很多事情，并行是关于**同时做**很多事情。

---

## 二、Rust 的线程并发基础

Rust 通过**所有权系统**和**类型系统**在编译期就消除了数据竞争，这是 Rust 并发编程最大的优势。

### 2.1 创建线程

```rust
use std::thread;
use std::time::Duration;

fn main() {
    // 创建一个新线程
    let handle = thread::spawn(|| {
        for i in 1..=5 {
            println!("子线程: 计数 {}", i);
            thread::sleep(Duration::from_millis(100));
        }
    });

    // 主线程继续执行
    for i in 1..=3 {
        println!("主线程: 计数 {}", i);
        thread::sleep(Duration::from_millis(150));
    }

    // 等待子线程完成
    handle.join().unwrap();
    println!("所有线程完成！");
}
```

**输出示例**：
```
主线程: 计数 1
子线程: 计数 1
子线程: 计数 2
主线程: 计数 2
子线程: 计数 3
主线程: 计数 3
子线程: 计数 4
子线程: 计数 5
所有线程完成！
```

### 2.2 线程间数据传递：move 闭包

Rust 的所有权系统要求在线程间传递数据时**转移所有权**：

```rust
use std::thread;

fn main() {
    let data = vec![1, 2, 3, 4, 5];

    // ❌ 编译错误！闭包可能在 data 被释放后仍访问它
    // let handle = thread::spawn(|| {
    //     println!("数据: {:?}", data);
    // });

    // ✅ 使用 move 转移所有权到新线程
    let handle = thread::spawn(move || {
        println!("数据: {:?}", data);
        let sum: i32 = data.iter().sum();
        println!("总和: {}", sum);
    });

    // ❌ 此时 data 已被移走，主线程不能再使用
    // println!("{:?}", data);

    handle.join().unwrap();
}
```

### 2.3 消息传递：Channel

Rust 标准库提供了 `mpsc`（多生产者，单消费者）通道：

```rust
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn main() {
    let (tx, rx) = mpsc::channel();

    // 克隆发送端，支持多个生产者
    let tx2 = tx.clone();

    // 生产者 1
    thread::spawn(move || {
        let messages = vec!["你好", "来自", "线程1"];
        for msg in messages {
            tx.send(msg.to_string()).unwrap();
            thread::sleep(Duration::from_millis(200));
        }
    });

    // 生产者 2
    thread::spawn(move || {
        let messages = vec!["消息", "来自", "线程2"];
        for msg in messages {
            tx2.send(msg.to_string()).unwrap();
            thread::sleep(Duration::from_millis(300));
        }
    });

    // 消费者（主线程）
    for received in rx {
        println!("收到: {}", received);
    }
}
```

```
                消息传递模型 (Channel)

    生产者1 ──tx──┐
                   ├──► Channel ──rx──► 消费者
    生产者2 ──tx2─┘

    特点：所有权在发送时转移，天然避免数据竞争
```

### 2.4 共享状态：Mutex 与 Arc

当多个线程需要访问同一份数据时，使用 `Mutex`（互斥锁）+ `Arc`（原子引用计数）：

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    // Arc<Mutex<T>>：线程安全的共享可变数据
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];

    for i in 0..10 {
        let counter = Arc::clone(&counter);
        let handle = thread::spawn(move || {
            // 获取锁，修改数据
            let mut num = counter.lock().unwrap();
            *num += 1;
            println!("线程 {} 将计数器增加到 {}", i, *num);
            // 锁在 num 离开作用域时自动释放
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    println!("最终计数: {}", *counter.lock().unwrap());
}
```

```
            共享状态模型 (Mutex + Arc)

     线程1 ──┐                  ┌── lock() ──► 读/写数据
              │                  │
     线程2 ──┼── Arc 引用 ──► Mutex<T> ──► unlock()
              │                  │
     线程3 ──┘                  └── 同一时刻只有一个线程持有锁
```

### 2.5 Rust 并发安全保障：Send 和 Sync

Rust 通过两个标记 trait 在**编译期**保证线程安全：

```rust
// Send：类型的值可以安全地在线程间转移所有权
// 大多数类型都实现了 Send，例外：Rc<T>

// Sync：类型的引用可以安全地在线程间共享
// 如果 &T 是 Send，那么 T 就是 Sync

// 示例：为什么 Rc 不能跨线程？
use std::rc::Rc;

fn main() {
    let data = Rc::new(42);
    
    // ❌ 编译错误！Rc 没有实现 Send
    // thread::spawn(move || {
    //     println!("{}", data);
    // });

    // ✅ 使用 Arc 替代 Rc
    use std::sync::Arc;
    let data = Arc::new(42);
    let data_clone = Arc::clone(&data);
    
    thread::spawn(move || {
        println!("{}", data_clone);  // ✅ Arc 实现了 Send
    });
}
```

| Trait | 含义 | 典型类型 |
|-------|------|----------|
| `Send` | 可以跨线程转移所有权 | 大部分类型，`Arc<T>`, `Mutex<T>` |
| `!Send` | 不能跨线程转移 | `Rc<T>`, `*mut T` |
| `Sync` | 引用可以跨线程共享 | 不可变类型，`Mutex<T>`, `Arc<T>` |
| `!Sync` | 引用不能跨线程共享 | `Cell<T>`, `RefCell<T>` |

---

## 三、从线程到异步：为什么需要 async/await？

### 3.1 线程的代价

线程虽然强大，但创建和维护线程有不小的开销：

```
┌─────────────────────────────────────────────────────────┐
│                线程 vs 异步任务 资源对比                    │
│                                                           │
│  对比维度          线程（Thread）      异步任务（Task）     │
│  ─────────────    ─────────────      ──────────────       │
│  内存开销          ~8MB 栈空间         ~几百字节             │
│  创建成本          系统调用，较高       用户态，极低          │
│  上下文切换        内核态切换，慢       用户态切换，快         │
│  10K 连接         需要 10K 线程       只需几个线程           │
│  适用场景          CPU 密集型          I/O 密集型            │
└─────────────────────────────────────────────────────────┘
```

### 3.2 异步编程的核心思想

异步编程的核心是：**在等待 I/O 时不阻塞线程，而是切换到其他任务执行。**

```
        异步任务调度示意图（单线程）

时间 ──────────────────────────────────────────►

任务A  [执行] [等待I/O...        ] [继续执行] [完成]
                ↓ 让出线程                ↑ I/O就绪
任务B          [执行] [等待I/O..] [继续]  
                       ↓ 让出      ↑ I/O就绪
任务C                 [执行] [完成]

关键：线程始终在忙碌，没有空等！
```

### 3.3 第一个 async/await 示例

```rust
use std::time::Duration;
use tokio::time::sleep;

// async fn 返回一个实现了 Future 的匿名类型
async fn fetch_data(id: u32) -> String {
    println!("[任务{}] 开始获取数据...", id);
    // 模拟网络请求，异步等待不阻塞线程
    sleep(Duration::from_millis(100 * id as u64)).await;
    println!("[任务{}] 数据获取完成！", id);
    format!("数据-{}", id)
}

#[tokio::main]
async fn main() {
    let start = std::time::Instant::now();
    
    // 顺序执行：总耗时 = 100 + 200 + 300 = 600ms
    // let r1 = fetch_data(1).await;
    // let r2 = fetch_data(2).await;
    // let r3 = fetch_data(3).await;
    
    // 并发执行：总耗时 ≈ max(100, 200, 300) = 300ms
    let (r1, r2, r3) = tokio::join!(
        fetch_data(1),
        fetch_data(2),
        fetch_data(3)
    );
    
    println!("结果: {}, {}, {}", r1, r2, r3);
    println!("总耗时: {:?}", start.elapsed());
}
```

**输出**：
```
[任务1] 开始获取数据...
[任务2] 开始获取数据...
[任务3] 开始获取数据...
[任务1] 数据获取完成！
[任务2] 数据获取完成！
[任务3] 数据获取完成！
结果: 数据-1, 数据-2, 数据-3
总耗时: 301.xxms
```

---

## 四、深入 Future Trait

现在我们来真正深入理解 Rust 异步编程的核心——`Future` trait。

### 4.1 Future Trait 定义

`Future` 是 Rust 标准库中定义的 trait，所有异步操作都基于它：

```rust
use std::pin::Pin;
use std::task::{Context, Poll};

pub trait Future {
    /// Future 完成时产出的值的类型
    type Output;

    /// 尝试推进 Future 到完成状态
    /// 
    /// 返回值：
    /// - Poll::Ready(val)  → Future 已完成，返回结果
    /// - Poll::Pending     → Future 尚未完成，稍后再来轮询
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
}

// Poll 枚举定义
pub enum Poll<T> {
    Ready(T),    // 完成
    Pending,     // 未完成
}
```

### 4.2 理解 Poll 机制

Future 不是自动推进的，需要被**执行器（Executor）反复 poll**：

```
        Future 的 Poll 机制

    ┌──────────┐         poll()         ┌──────────┐
    │          │ ──────────────────────► │          │
    │ Executor │                         │  Future  │
    │ (执行器) │ ◄────────────────────── │          │
    │          │    Poll::Pending        │          │
    └──────────┘    (未完成,稍后再来)     └──────────┘
         │                                    │
         │          poll()                    │
         │ ──────────────────────────────►    │
         │                                    │
         │ ◄──────────────────────────────    │
         │    Poll::Ready(value)              │
         │    (完成！这是结果)                  │
         ▼                                    ▼

    关键：
    1. Executor 调用 poll() 推进 Future
    2. 返回 Pending 时，Future 注册 Waker
    3. 当条件就绪，Waker 通知 Executor 再次 poll
    4. 返回 Ready(value) 时，Future 完成
```

### 4.3 async fn 的本质

`async fn` 其实是编译器的语法糖，会被转换成返回 `Future` 的函数：

```rust
// 我们写的代码：
async fn hello() -> String {
    "Hello".to_string()
}

// 编译器大致生成的等价代码：
fn hello() -> impl Future<Output = String> {
    // 返回一个匿名的 Future 类型
    async {
        "Hello".to_string()
    }
}
```

更复杂的例子——带 `.await` 的 async fn 会被编译成**状态机**：

```rust
// 我们写的代码：
async fn two_steps() -> u32 {
    let a = step_one().await;   // 第一个 await 点
    let b = step_two(a).await;  // 第二个 await 点
    a + b
}

// 编译器生成的状态机（简化示意）：
enum TwoStepsStateMachine {
    // 初始状态：还没开始
    Start,
    // 等待 step_one 完成
    WaitingStepOne {
        future: StepOneFuture,
    },
    // 等待 step_two 完成
    WaitingStepTwo {
        a: u32,
        future: StepTwoFuture,
    },
    // 已完成
    Done,
}
```

```
    async fn 编译为状态机示意图

    ┌─────────┐  poll()   ┌──────────────────┐  poll()   ┌──────────────────┐
    │  Start  │ ────────► │ WaitingStepOne   │ ────────► │ WaitingStepTwo   │
    │         │           │ (等待step_one)    │           │ (等待step_two)    │
    └─────────┘           └──────────────────┘           └──────────────────┘
                                │                              │
                                │ Pending                      │ Pending
                                ▼                              ▼
                          等I/O就绪后                      等I/O就绪后
                          Waker唤醒                       Waker唤醒
                          再次poll                        再次poll
                                                               │
                                                               │ Ready(a + b)
                                                               ▼
                                                        ┌──────────┐
                                                        │   Done   │
                                                        │ 返回结果  │
                                                        └──────────┘
```

### 4.4 Waker：唤醒机制

`Waker` 是 Future 和 Executor 之间的桥梁。当 Future 返回 `Pending` 时，它需要保存 `Waker`，在条件就绪时调用 `waker.wake()` 通知 Executor 重新 poll：

```rust
use std::task::{Context, Poll, Waker};
use std::pin::Pin;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// 一个简单的定时器 Future
struct TimerFuture {
    shared_state: Arc<Mutex<SharedState>>,
}

struct SharedState {
    completed: bool,
    waker: Option<Waker>,
}

impl Future for TimerFuture {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut shared_state = self.shared_state.lock().unwrap();
        
        if shared_state.completed {
            // 定时器到期，返回 Ready
            Poll::Ready(())
        } else {
            // 定时器未到期，保存 Waker，返回 Pending
            shared_state.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}

impl TimerFuture {
    fn new(duration: Duration) -> Self {
        let shared_state = Arc::new(Mutex::new(SharedState {
            completed: false,
            waker: None,
        }));

        let thread_shared_state = Arc::clone(&shared_state);
        
        // 在后台线程中计时
        thread::spawn(move || {
            thread::sleep(duration);
            let mut shared_state = thread_shared_state.lock().unwrap();
            shared_state.completed = true;
            
            // 唤醒 Executor，告诉它可以再次 poll 了
            if let Some(waker) = shared_state.waker.take() {
                waker.wake();  // ← 关键！通知 Executor
            }
        });

        TimerFuture { shared_state }
    }
}
```

```
    Waker 唤醒机制流程

    ┌──────────┐                      ┌──────────────┐
    │ Executor │ ── 1. poll() ──────► │ TimerFuture  │
    │          │                      │              │
    │          │ ◄── 2. Pending ───── │ 保存 Waker   │
    │          │     (还没好)          │              │
    │  暂停    │                      └──────┬───────┘
    │  该任务   │                             │
    │          │                      ┌──────▼───────┐
    │          │                      │ 后台线程计时   │
    │          │                      │ sleep(...)    │
    │          │                      │              │
    │          │ ◄── 3. wake() ────── │ 时间到了！    │
    │          │     (醒醒,该干活了)    │ 调用 Waker   │
    │          │                      └──────────────┘
    │          │                      ┌──────────────┐
    │          │ ── 4. poll() ──────► │ TimerFuture  │
    │          │                      │              │
    │          │ ◄── 5. Ready(()) ─── │ completed!   │
    │          │     (完成了!)         │              │
    └──────────┘                      └──────────────┘
```

---

## 五、手动实现自己的 Future

### 5.1 实战：实现一个 CountdownFuture

让我们实现一个更实用的 Future——倒计时器，每次 poll 时递减计数：

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

/// 倒计时 Future：每次 poll 时计数减一，到 0 时完成
struct CountdownFuture {
    count: u32,
}

impl CountdownFuture {
    fn new(count: u32) -> Self {
        CountdownFuture { count }
    }
}

impl Future for CountdownFuture {
    type Output = String;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.count == 0 {
            println!("  🎉 倒计时完成！");
            Poll::Ready("发射！".to_string())
        } else {
            println!("  ⏳ 倒计时: {}...", self.count);
            self.count -= 1;
            // 关键：立即唤醒自己，让 Executor 再次 poll
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

#[tokio::main]
async fn main() {
    let result = CountdownFuture::new(5).await;
    println!("结果: {}", result);
}
```

**输出**：
```
  ⏳ 倒计时: 5...
  ⏳ 倒计时: 4...
  ⏳ 倒计时: 3...
  ⏳ 倒计时: 2...
  ⏳ 倒计时: 1...
  🎉 倒计时完成！
结果: 发射！
```

### 5.2 实战：实现一个 Yield Future

模拟协程的 `yield` 操作——主动让出执行权一次：

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

/// YieldNow：让出一次执行权，下次 poll 时立即完成
struct YieldNow {
    yielded: bool,
}

impl YieldNow {
    fn new() -> Self {
        YieldNow { yielded: false }
    }
}

impl Future for YieldNow {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.yielded {
            // 第二次 poll：直接完成
            Poll::Ready(())
        } else {
            // 第一次 poll：标记已让出，唤醒后再完成
            self.yielded = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

// 方便使用的函数
fn yield_now() -> YieldNow {
    YieldNow::new()
}

#[tokio::main]
async fn main() {
    println!("步骤 1");
    yield_now().await;   // 主动让出一次
    println!("步骤 2");
    yield_now().await;   // 再让出一次
    println!("步骤 3");
}
```

### 5.3 实战：实现一个组合 Future（链式操作）

实现一个 `AndThen` Future，将两个 Future 串联起来：

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

/// 状态枚举：跟踪当前执行到哪一步
enum AndThenState<FutA, FutB> {
    /// 正在等待第一个 Future 完成
    WaitingA(FutA),
    /// 第一个完成了，正在等待第二个
    WaitingB(FutB),
    /// 全部完成
    Done,
}

/// AndThen Future：先执行 A，用 A 的结果创建 B，再执行 B
struct AndThen<FutA, F, FutB>
where
    FutA: Future,
    F: FnOnce(FutA::Output) -> FutB,
    FutB: Future,
{
    state: AndThenState<FutA, FutB>,
    func: Option<F>,
}

impl<FutA, F, FutB> AndThen<FutA, F, FutB>
where
    FutA: Future,
    F: FnOnce(FutA::Output) -> FutB,
    FutB: Future,
{
    fn new(future_a: FutA, func: F) -> Self {
        AndThen {
            state: AndThenState::WaitingA(future_a),
            func: Some(func),
        }
    }
}

impl<FutA, F, FutB> Future for AndThen<FutA, F, FutB>
where
    FutA: Future + Unpin,
    F: FnOnce(FutA::Output) -> FutB + Unpin,
    FutB: Future + Unpin,
{
    type Output = FutB::Output;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        loop {
            match &mut self.state {
                AndThenState::WaitingA(fut_a) => {
                    // poll 第一个 Future
                    match Pin::new(fut_a).poll(cx) {
                        Poll::Ready(result_a) => {
                            // A 完成了，用结果创建 B
                            let func = self.func.take().unwrap();
                            let fut_b = func(result_a);
                            self.state = AndThenState::WaitingB(fut_b);
                            // 继续 loop，立即 poll B
                        }
                        Poll::Pending => return Poll::Pending,
                    }
                }
                AndThenState::WaitingB(fut_b) => {
                    // poll 第二个 Future
                    let result = Pin::new(fut_b).poll(cx);
                    if result.is_ready() {
                        self.state = AndThenState::Done;
                    }
                    return result;
                }
                AndThenState::Done => {
                    panic!("AndThen polled after completion!");
                }
            }
        }
    }
}

// 使用示例
#[tokio::main]
async fn main() {
    let future = AndThen::new(
        async { 
            println!("步骤1: 获取用户ID");
            42u32 
        },
        |user_id| async move {
            println!("步骤2: 根据ID {} 获取用户名", user_id);
            format!("用户_{}", user_id)
        },
    );

    let result = future.await;
    println!("最终结果: {}", result);
}
```

**输出**：
```
步骤1: 获取用户ID
步骤2: 根据ID 42 获取用户名
最终结果: 用户_42
```

---

## 六、Pin 与 Unpin：为什么 Future 需要 Pin？

### 6.1 自引用结构问题

`async fn` 生成的状态机可能包含**自引用结构**——结构体中的某个字段引用了自身的另一个字段：

```rust
// async fn 生成的状态机可能类似这样：
struct AsyncStateMachine {
    data: String,
    // reference 指向 data 的内容！
    // 如果结构体被移动（move），reference 会变成悬垂指针！
    reference: *const String,
}
```

```
    自引用结构体的移动问题

    移动前（正确）:                   移动后（错误❌）:
    ┌──────────────────┐             ┌──────────────────┐
    │ data: "hello"    │ ◄─┐        │ (已被移走)         │ ←── reference 
    │                  │   │        │                    │     仍指向这里！
    │ reference: ──────┼───┘        │                    │     悬垂指针！
    └──────────────────┘             └──────────────────┘

    新地址:                          
    ┌──────────────────┐             
    │ data: "hello"    │  ← 数据搬到这里了
    │                  │    但 reference 没更新！
    │ reference: ──────┼──► 指向旧地址（野指针）
    └──────────────────┘             
```

### 6.2 Pin 的解决方案

`Pin<P>` 是一个智能指针包装器，保证被包装的值**不会被移动**：

```rust
use std::pin::Pin;
use std::marker::PhantomPinned;

struct SelfReferential {
    data: String,
    // 自引用的裸指针
    self_ref: *const String,
    // 标记为 !Unpin，禁止移动
    _marker: PhantomPinned,
}

impl SelfReferential {
    fn new(data: &str) -> Pin<Box<Self>> {
        let res = SelfReferential {
            data: data.to_string(),
            self_ref: std::ptr::null(),
            _marker: PhantomPinned,
        };
        
        let mut boxed = Box::pin(res);
        
        // 设置自引用
        let self_ptr: *const String = &boxed.data;
        unsafe {
            let mut_ref: Pin<&mut Self> = Pin::as_mut(&mut boxed);
            Pin::get_unchecked_mut(mut_ref).self_ref = self_ptr;
        }
        
        boxed
    }
    
    fn get_data(&self) -> &str {
        &self.data
    }
    
    fn get_self_ref(&self) -> &String {
        unsafe { &*self.self_ref }
    }
}

fn main() {
    let pinned = SelfReferential::new("Hello, Pin!");
    
    println!("data: {}", pinned.get_data());
    println!("self_ref: {}", pinned.get_self_ref());
    
    // ❌ 以下操作无法编译，因为值被 Pin 住了
    // let moved = *pinned;  // 不能移动
}
```

### 6.3 Unpin Trait

`Unpin` 是一个自动 trait，表示类型**即使被 Pin 住也可以安全移动**：

```rust
// 大部分基础类型都是 Unpin 的
// u32: Unpin ✅
// String: Unpin ✅
// Vec<T>: Unpin ✅
// 
// async 块生成的 Future 通常是 !Unpin 的
// (因为可能包含自引用)

use std::pin::Pin;

fn example() {
    let mut num = 42u32;
    let pinned = Pin::new(&mut num);  // u32 是 Unpin，所以可以用 Pin::new
    
    // Unpin 类型即使被 Pin 住也能取出
    let unpinned: &mut u32 = Pin::into_inner(pinned);
    *unpinned = 100;
}
```

```
    Pin 与 Unpin 关系图

    ┌──────────────────────────────────────────────────────┐
    │                     所有类型                           │
    │                                                        │
    │   ┌──────────────────────┐  ┌────────────────────┐    │
    │   │   Unpin 类型         │  │  !Unpin 类型        │    │
    │   │                      │  │                      │    │
    │   │  u32, String, Vec    │  │  async 块的 Future   │    │
    │   │  大部分标准库类型      │  │  包含自引用的结构体   │    │
    │   │                      │  │                      │    │
    │   │  Pin 对它们无效       │  │  Pin 保证不被移动     │    │
    │   │  可以自由 move        │  │  必须通过 Pin 访问    │    │
    │   └──────────────────────┘  └────────────────────┘    │
    └──────────────────────────────────────────────────────┘
```

---

## 七、深入实战：构建简易 Executor

理解原理的最好方式就是自己实现一个。让我们构建一个**最简单的 Future 执行器**：

### 7.1 完整代码

```rust
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

/// 任务：一个被 Pin 住的、可以 Send 的 Future
type Task = Pin<Box<dyn Future<Output = ()> + Send>>;

/// 简易执行器
struct SimpleExecutor {
    /// 待执行的任务队列
    task_queue: VecDeque<Task>,
}

impl SimpleExecutor {
    fn new() -> Self {
        SimpleExecutor {
            task_queue: VecDeque::new(),
        }
    }

    /// 添加任务到队列
    fn spawn(&mut self, future: impl Future<Output = ()> + Send + 'static) {
        self.task_queue.push_back(Box::pin(future));
    }

    /// 运行所有任务直到完成
    fn run(&mut self) {
        while let Some(mut task) = self.task_queue.pop_front() {
            // 创建一个简单的 Waker
            let waker = create_waker();
            let mut context = Context::from_waker(&waker);
            
            // Poll 任务
            match task.as_mut().poll(&mut context) {
                Poll::Ready(()) => {
                    // 任务完成，不再放回队列
                    println!("  [Executor] 任务完成 ✓");
                }
                Poll::Pending => {
                    // 任务未完成，放回队列末尾继续轮询
                    println!("  [Executor] 任务未完成，重新入队");
                    self.task_queue.push_back(task);
                }
            }
        }
    }
}

/// 创建一个最简单的 Waker（什么都不做，仅满足接口要求）
fn create_waker() -> Waker {
    fn no_op(_: *const ()) {}
    fn clone(data: *const ()) -> RawWaker {
        RawWaker::new(data, &VTABLE)
    }

    static VTABLE: RawWakerVTable = RawWakerVTable::new(
        clone,      // clone
        no_op,      // wake
        no_op,      // wake_by_ref
        no_op,      // drop
    );

    unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) }
}

// === 测试用的 Future ===

/// 倒计时 Future
struct Countdown {
    name: &'static str,
    count: u32,
}

impl Future for Countdown {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if self.count == 0 {
            println!("  [{}] 完成！🎉", self.name);
            Poll::Ready(())
        } else {
            println!("  [{}] 倒计时: {}", self.name, self.count);
            self.count -= 1;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

fn main() {
    println!("=== 简易 Executor 演示 ===\n");
    
    let mut executor = SimpleExecutor::new();
    
    // 添加两个任务
    executor.spawn(Countdown { name: "火箭A", count: 3 });
    executor.spawn(Countdown { name: "火箭B", count: 2 });
    
    // 运行所有任务
    executor.run();
    
    println!("\n=== 所有任务执行完毕 ===");
}
```

**输出**：
```
=== 简易 Executor 演示 ===

  [火箭A] 倒计时: 3
  [Executor] 任务未完成，重新入队
  [火箭B] 倒计时: 2
  [Executor] 任务未完成，重新入队
  [火箭A] 倒计时: 2
  [Executor] 任务未完成，重新入队
  [火箭B] 倒计时: 1
  [Executor] 任务未完成，重新入队
  [火箭A] 倒计时: 1
  [Executor] 任务未完成，重新入队
  [火箭B] 完成！🎉
  [Executor] 任务完成 ✓
  [火箭A] 完成！🎉
  [Executor] 任务完成 ✓

=== 所有任务执行完毕 ===
```

### 7.2 执行过程分析

```
    SimpleExecutor 执行流程

    任务队列                    执行器动作
    ═══════                    ═════════

    ┌──────┬──────┐
    │ 火箭A │ 火箭B │           初始状态
    └──────┴──────┘

    ┌──────┐
    │ 火箭B │ ← poll 火箭A     火箭A: count=3→2, Pending, 重新入队
    └──────┘
         ┌──────┐
         │ 火箭A │

    ┌──────┐
    │ 火箭A │ ← poll 火箭B     火箭B: count=2→1, Pending, 重新入队
    └──────┘
         ┌──────┐
         │ 火箭B │

    ┌──────┐
    │ 火箭B │ ← poll 火箭A     火箭A: count=2→1, Pending, 重新入队
    └──────┘
         ┌──────┐
         │ 火箭A │

    ┌──────┐
    │ 火箭A │ ← poll 火箭B     火箭B: count=1→0, Pending, 重新入队
    └──────┘

    ← poll 火箭A               火箭A: count=1→0, Pending, 重新入队

    ← poll 火箭B               火箭B: count=0, Ready! ✓ 完成

    ← poll 火箭A               火箭A: count=0, Ready! ✓ 完成

    队列空, 全部完成！
```

---

## 八、高级话题：异步 Trait 与实际应用

### 8.1 在 Trait 中使用 async（Rust 1.75+）

从 Rust 1.75 开始，可以直接在 trait 中定义 `async fn`：

```rust
trait HttpClient {
    async fn get(&self, url: &str) -> Result<String, String>;
    async fn post(&self, url: &str, body: &str) -> Result<String, String>;
}

struct MyClient;

impl HttpClient for MyClient {
    async fn get(&self, url: &str) -> Result<String, String> {
        // 模拟异步 HTTP GET 请求
        println!("GET {}", url);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        Ok(format!("Response from {}", url))
    }

    async fn post(&self, url: &str, body: &str) -> Result<String, String> {
        println!("POST {} body={}", url, body);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        Ok(format!("Created at {}", url))
    }
}

#[tokio::main]
async fn main() {
    let client = MyClient;
    let response = client.get("https://api.example.com/data").await.unwrap();
    println!("{}", response);
}
```

### 8.2 实战：异步重试器

实现一个通用的异步重试 Future：

```rust
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

/// 异步重试器：自动重试失败的异步操作
struct Retry<F, Fut, T, E>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    /// 创建新 Future 的工厂函数
    factory: F,
    /// 当前正在执行的 Future
    current_future: Option<Pin<Box<Fut>>>,
    /// 最大重试次数
    max_retries: u32,
    /// 当前重试次数
    current_attempt: u32,
}

impl<F, Fut, T, E> Retry<F, Fut, T, E>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    fn new(factory: F, max_retries: u32) -> Self {
        let current_future = None;
        Retry {
            factory,
            current_future,
            max_retries,
            current_attempt: 0,
        }
    }
}

impl<F, Fut, T, E> Future for Retry<F, Fut, T, E>
where
    F: Fn() -> Fut + Unpin,
    Fut: Future<Output = Result<T, E>> + Unpin,
    E: std::fmt::Display,
{
    type Output = Result<T, E>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        loop {
            // 如果没有正在执行的 Future，创建一个
            if self.current_future.is_none() {
                let fut = (self.factory)();
                self.current_future = Some(Box::pin(fut));
            }

            // poll 当前的 Future
            let fut = self.current_future.as_mut().unwrap();
            match Pin::new(fut).poll(cx) {
                Poll::Ready(Ok(value)) => {
                    println!("  ✅ 第 {} 次尝试成功！", self.current_attempt + 1);
                    return Poll::Ready(Ok(value));
                }
                Poll::Ready(Err(e)) => {
                    self.current_attempt += 1;
                    println!("  ❌ 第 {} 次尝试失败: {}", self.current_attempt, e);
                    
                    if self.current_attempt >= self.max_retries {
                        println!("  💀 达到最大重试次数，放弃");
                        return Poll::Ready(Err(e));
                    }
                    
                    // 重置 Future，下一次循环会创建新的
                    self.current_future = None;
                    // 继续 loop 立即重试
                }
                Poll::Pending => {
                    return Poll::Pending;
                }
            }
        }
    }
}

// 使用示例
use std::sync::atomic::{AtomicU32, Ordering};

static CALL_COUNT: AtomicU32 = AtomicU32::new(0);

async fn unreliable_operation() -> Result<String, String> {
    let count = CALL_COUNT.fetch_add(1, Ordering::SeqCst);
    
    if count < 2 {
        // 前两次模拟失败
        Err(format!("网络超时 (第{}次调用)", count + 1))
    } else {
        // 第三次成功
        Ok("获取到重要数据！".to_string())
    }
}

#[tokio::main]
async fn main() {
    println!("=== 异步重试器演示 ===\n");
    
    let result = Retry::new(
        || unreliable_operation(),
        5,  // 最多重试 5 次
    ).await;
    
    match result {
        Ok(data) => println!("\n最终结果: {}", data),
        Err(e) => println!("\n最终失败: {}", e),
    }
}
```

**输出**：
```
=== 异步重试器演示 ===

  ❌ 第 1 次尝试失败: 网络超时 (第1次调用)
  ❌ 第 2 次尝试失败: 网络超时 (第2次调用)
  ✅ 第 3 次尝试成功！

最终结果: 获取到重要数据！
```

### 8.3 Stream：异步迭代器

`Stream` 是 `Future` 的迭代版本，可以产出多个值：

```rust
use std::pin::Pin;
use std::task::{Context, Poll};

/// Stream trait（简化版，实际定义在 futures crate 中）
trait Stream {
    type Item;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>;
}

/// 一个产出斐波那契数列的 Stream
struct FibonacciStream {
    a: u64,
    b: u64,
    count: usize,
    max: usize,
}

impl FibonacciStream {
    fn new(max: usize) -> Self {
        FibonacciStream { a: 0, b: 1, count: 0, max }
    }
}

impl Stream for FibonacciStream {
    type Item = u64;

    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.count >= self.max {
            // 序列结束
            Poll::Ready(None)
        } else {
            let value = self.a;
            let next = self.a + self.b;
            self.a = self.b;
            self.b = next;
            self.count += 1;
            Poll::Ready(Some(value))
        }
    }
}
```

使用 `tokio_stream` 库的例子：

```rust
use tokio_stream::{self, StreamExt};
use tokio::time::{interval, Duration};

#[tokio::main]
async fn main() {
    // 从迭代器创建 Stream
    let mut stream = tokio_stream::iter(vec![1, 2, 3, 4, 5])
        .map(|x| x * 2)
        .filter(|x| *x > 4);

    while let Some(value) = stream.next().await {
        println!("值: {}", value);
    }
    // 输出: 6, 8, 10
    
    // 定时 Stream
    let mut interval_stream = tokio_stream::wrappers::IntervalStream::new(
        interval(Duration::from_millis(500))
    );
    
    let mut count = 0;
    while let Some(_tick) = interval_stream.next().await {
        count += 1;
        println!("Tick #{}", count);
        if count >= 3 { break; }
    }
}
```

---

## 九、全景总结

### 9.1 Rust 并发编程模型总览

```
    ┌─────────────────────────────────────────────────────────────┐
    │                  Rust 并发编程全景图                          │
    │                                                              │
    │   ┌─────────────────────────────────────────────────────┐   │
    │   │                应用层                                 │   │
    │   │  tokio::spawn  |  join!  |  select!  |  Stream       │   │
    │   └────────────────────────┬────────────────────────────┘   │
    │                            │                                 │
    │   ┌────────────────────────▼────────────────────────────┐   │
    │   │              运行时层（Runtime）                      │   │
    │   │  Tokio / async-std / smol                            │   │
    │   │  任务调度 | 事件循环 | I/O 驱动 | 定时器              │   │
    │   └────────────────────────┬────────────────────────────┘   │
    │                            │                                 │
    │   ┌────────────────────────▼────────────────────────────┐   │
    │   │              语言层                                   │   │
    │   │  async/await 语法 → 编译为状态机 (impl Future)        │   │
    │   │  Pin<&mut Self> 保证自引用安全                        │   │
    │   └────────────────────────┬────────────────────────────┘   │
    │                            │                                 │
    │   ┌────────────────────────▼────────────────────────────┐   │
    │   │              核心 Trait 层                            │   │
    │   │  Future { poll() → Poll<T> }                         │   │
    │   │  Waker → 唤醒通知机制                                 │   │
    │   │  Send + Sync → 编译期线程安全                         │   │
    │   └────────────────────────┬────────────────────────────┘   │
    │                            │                                 │
    │   ┌────────────────────────▼────────────────────────────┐   │
    │   │              操作系统层                               │   │
    │   │  epoll(Linux) | kqueue(macOS) | IOCP(Windows)        │   │
    │   │  线程 | 内存 | 文件描述符                              │   │
    │   └─────────────────────────────────────────────────────┘   │
    └─────────────────────────────────────────────────────────────┘
```

### 9.2 核心知识点速查

| 概念 | 说明 | 关键代码 |
|------|------|----------|
| **Future** | 异步计算的核心 trait | `fn poll(Pin<&mut Self>, &mut Context) -> Poll<T>` |
| **async/await** | Future 的语法糖 | `async fn foo() -> T` / `result.await` |
| **Poll** | Future 的返回状态 | `Poll::Ready(T)` / `Poll::Pending` |
| **Waker** | 唤醒 Executor 的机制 | `cx.waker().wake_by_ref()` |
| **Pin** | 防止值被移动 | `Pin<&mut Self>`, `Box::pin(future)` |
| **Unpin** | 标记可安全移动的类型 | 大部分基础类型自动实现 |
| **Send** | 可跨线程转移 | `impl Future + Send` |
| **Sync** | 引用可跨线程共享 | `Arc<Mutex<T>>` |
| **Executor** | Future 的驱动器 | Tokio runtime, `block_on()` |
| **Stream** | 异步迭代器 | `fn poll_next() -> Poll<Option<T>>` |

### 9.3 最佳实践

```rust
// ✅ 推荐做法
// 1. CPU 密集型任务用 spawn_blocking
tokio::task::spawn_blocking(|| {
    // 在专用线程池中执行 CPU 密集型计算
    heavy_computation()
}).await.unwrap();

// 2. I/O 密集型任务用 async
async fn fetch_all(urls: Vec<String>) -> Vec<String> {
    let futures: Vec<_> = urls.into_iter()
        .map(|url| async move { reqwest::get(&url).await.unwrap().text().await.unwrap() })
        .collect();
    futures::future::join_all(futures).await
}

// 3. 使用 select! 实现超时
use tokio::time::{timeout, Duration};

async fn with_timeout() -> Result<String, &'static str> {
    match timeout(Duration::from_secs(5), long_running_task()).await {
        Ok(result) => Ok(result),
        Err(_) => Err("操作超时！"),
    }
}

// 4. 避免在 async 中持有 Mutex 跨越 await 点
async fn bad_example(mutex: &tokio::sync::Mutex<Vec<u32>>) {
    // ❌ 不推荐：锁跨越了 await 点
    // let mut guard = mutex.lock().await;
    // some_async_op().await;  // 持有锁的同时 await
    // guard.push(1);

    // ✅ 推荐：缩小锁的范围
    {
        let mut guard = mutex.lock().await;
        guard.push(1);
    } // 锁在这里释放
    some_async_op().await;  // await 时不持有锁
}
```

---

## 十、学习路线图

```
    Rust 并发编程学习路径

    入门 ─────────────────────────────────────────────────────►  精通

    ┌────────┐   ┌──────────┐   ┌──────────────┐   ┌─────────────┐
    │ 第一阶段 │   │ 第二阶段  │   │  第三阶段     │   │  第四阶段    │
    │         │   │          │   │              │   │             │
    │ • 线程   │   │ • async  │   │ • Future     │   │ • 自定义     │
    │ • move  │   │ • await  │   │   trait 原理  │   │   Executor  │
    │ • 通道   │   │ • tokio  │   │ • Pin/Unpin  │   │ • 零成本抽象 │
    │ • Mutex │   │ • join!  │   │ • Waker 机制  │   │ • 性能优化   │
    │ • Arc   │   │ • select!│   │ • 状态机原理   │   │ • lock-free │
    └────────┘   └──────────┘   └──────────────┘   └─────────────┘
       基础            应用            深入              专家
```

> **建议**：先掌握线程和基本的 async/await 用法，能够使用 Tokio 编写异步程序。然后再深入 Future trait 和 Pin 的原理。最后尝试自己实现 Executor 和自定义 Future，这将让你对 Rust 异步编程有真正透彻的理解。

---
