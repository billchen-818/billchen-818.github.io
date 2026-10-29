---
title: Rust Tokio 异步并发编程入门学习总结
date: 2026-02-26 10:19:14
tags: Rust
---

## 一、什么是 Tokio？

Tokio 是 Rust 生态系统中最流行的异步运行时（async runtime），它为编写高性能的异步应用程序提供了完整的工具集。Tokio 让你能够使用 `async/await` 语法编写并发代码，在单线程或多线程环境中高效地处理成千上万的并发任务。

### 核心特性

- **异步运行时**：提供任务调度器和事件循环
- **异步 I/O**：高性能的网络和文件系统操作
- **定时器和延迟**：精确的异步时间控制
- **同步原语**：异步版本的 Mutex、Semaphore 等
- **多线程支持**：可配置的工作线程池

## 二、异步编程基础概念

### 2.1 同步 vs 异步

**同步代码**执行时会阻塞当前线程，直到操作完成：
```rust
// 同步代码 - 阻塞 2 秒
std::thread::sleep(std::time::Duration::from_secs(2));
println!("完成!");
```

**异步代码**可以在等待时让出执行权，让其他任务运行：
```rust
// 异步代码 - 不阻塞线程
tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
println!("完成!");
```

### 2.2 Future 和 async/await

- `Future` 是 Rust 中表示异步计算的 trait
- `async` 关键字将函数转换为返回 Future 的函数
- `await` 关键字等待 Future 完成并获取结果

## 三、Tokio 入门实践

### 3.1 添加依赖

在 `Cargo.toml` 中添加：
```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
```

### 3.2 第一个 Tokio 程序

```rust
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() {
    println!("Hello, Tokio!");
    
    // 异步睡眠 1 秒
    sleep(Duration::from_secs(1)).await;
    
    println!("一秒后...");
}
```

**关键点**：
- `#[tokio::main]` 宏自动创建 Tokio 运行时并执行 async main 函数
- `sleep().await` 异步等待，不阻塞线程

### 3.3 并发执行多个任务

```rust
use tokio::time::{sleep, Duration};

async fn task1() {
    for i in 1..=3 {
        println!("任务1: 步骤 {}", i);
        sleep(Duration::from_millis(500)).await;
    }
}

async fn task2() {
    for i in 1..=3 {
        println!("任务2: 步骤 {}", i);
        sleep(Duration::from_millis(300)).await;
    }
}

#[tokio::main]
async fn main() {
    // 并发执行两个任务
    tokio::join!(task1(), task2());
    println!("所有任务完成!");
}
```

**输出示例**：
```
任务1: 步骤 1
任务2: 步骤 1
任务2: 步骤 2
任务1: 步骤 2
任务2: 步骤 3
任务1: 步骤 3
所有任务完成!
```

## 四、Tokio 核心概念

### 4.1 Spawn：生成独立任务

使用 `tokio::spawn` 创建在后台运行的独立任务：

```rust
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() {
    // 生成一个后台任务
    let handle = tokio::spawn(async {
        sleep(Duration::from_secs(1)).await;
        println!("后台任务完成!");
        "返回值"
    });
    
    println!("主任务继续执行...");
    
    // 等待后台任务完成并获取返回值
    let result = handle.await.unwrap();
    println!("任务返回: {}", result);
}
```

### 4.2 多个任务的不同等待策略

#### 等待所有任务完成：`join!`

```rust
use tokio::time::{sleep, Duration};

async fn fetch_user(id: u32) -> String {
    sleep(Duration::from_millis(100)).await;
    format!("用户{}", id)
}

#[tokio::main]
async fn main() {
    let start = std::time::Instant::now();
    
    // 并发执行，等待所有任务完成
    let (user1, user2, user3) = tokio::join!(
        fetch_user(1),
        fetch_user(2),
        fetch_user(3)
    );
    
    println!("{}, {}, {}", user1, user2, user3);
    println!("耗时: {:?}", start.elapsed()); // 约 100ms
}
```

#### 等待第一个完成：`select!`

```rust
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() {
    let task1 = async {
        sleep(Duration::from_secs(1)).await;
        "任务1完成"
    };
    
    let task2 = async {
        sleep(Duration::from_millis(500)).await;
        "任务2完成"
    };
    
    // 等待第一个完成的任务
    tokio::select! {
        result = task1 => println!("先完成: {}", result),
        result = task2 => println!("先完成: {}", result),
    }
}
```

### 4.3 通道（Channel）：任务间通信

Tokio 提供多种通道类型，最常用的是 `mpsc`（多生产者单消费者）：

```rust
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

#[tokio::main]
async fn main() {
    // 创建容量为 32 的通道
    let (tx, mut rx) = mpsc::channel(32);
    
    // 生产者任务
    tokio::spawn(async move {
        for i in 1..=5 {
            tx.send(format!("消息 {}", i)).await.unwrap();
            sleep(Duration::from_millis(200)).await;
        }
    });
    
    // 消费者：接收消息
    while let Some(msg) = rx.recv().await {
        println!("收到: {}", msg);
    }
    
    println!("通道已关闭");
}
```

### 4.4 共享状态：Arc 和 Mutex

在多个任务间共享可变状态：

```rust
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() {
    // 使用 Arc 共享所有权，Mutex 保护可变访问
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];
    
    for i in 0..10 {
        let counter = Arc::clone(&counter);
        let handle = tokio::spawn(async move {
            let mut num = counter.lock().await;
            *num += 1;
            println!("任务 {} 增加计数器", i);
        });
        handles.push(handle);
    }
    
    // 等待所有任务完成
    for handle in handles {
        handle.await.unwrap();
    }
    
    println!("最终计数: {}", *counter.lock().await);
}
```

**注意**：必须使用 `tokio::sync::Mutex`，不能使用 `std::sync::Mutex`，因为后者会阻塞线程。

## 五、实战案例

### 5.1 并发 HTTP 请求模拟

```rust
use tokio::time::{sleep, Duration};
use std::time::Instant;

async fn fetch_url(url: &str, delay_ms: u64) -> Result<String, String> {
    println!("开始请求: {}", url);
    sleep(Duration::from_millis(delay_ms)).await;
    
    // 模拟偶尔失败
    if delay_ms > 500 {
        Ok(format!("成功获取: {}", url))
    } else {
        Err(format!("请求失败: {}", url))
    }
}

#[tokio::main]
async fn main() {
    let start = Instant::now();
    
    let urls = vec![
        ("https://api1.example.com", 300),
        ("https://api2.example.com", 600),
        ("https://api3.example.com", 400),
    ];
    
    let mut tasks = vec![];
    
    for (url, delay) in urls {
        let task = tokio::spawn(async move {
            fetch_url(url, delay).await
        });
        tasks.push(task);
    }
    
    // 收集所有结果
    for task in tasks {
        match task.await.unwrap() {
            Ok(result) => println!("✓ {}", result),
            Err(err) => println!("✗ {}", err),
        }
    }
    
    println!("总耗时: {:?}", start.elapsed());
}
```

### 5.2 简单的异步 Web 服务器框架

```rust
use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:8080").await?;
    println!("服务器监听 127.0.0.1:8080");
    
    loop {
        // 接受新连接
        let (mut socket, addr) = listener.accept().await?;
        println!("新连接: {}", addr);
        
        // 为每个连接生成独立任务
        tokio::spawn(async move {
            let mut buffer = [0; 1024];
            
            // 读取数据
            match socket.read(&mut buffer).await {
                Ok(n) if n > 0 => {
                    let request = String::from_utf8_lossy(&buffer[..n]);
                    println!("收到请求:\n{}", request);
                    
                    // 发送响应
                    let response = "HTTP/1.1 200 OK\r\n\
                                   Content-Type: text/plain\r\n\
                                   \r\n\
                                   Hello from Tokio!";
                    socket.write_all(response.as_bytes()).await.ok();
                }
                _ => println!("连接关闭: {}", addr),
            }
        });
    }
}
```

### 5.3 超时控制

```rust
use tokio::time::{sleep, Duration, timeout};

async fn long_running_task() -> String {
    sleep(Duration::from_secs(3)).await;
    "任务完成".to_string()
}

#[tokio::main]
async fn main() {
    // 设置 1 秒超时
    match timeout(Duration::from_secs(1), long_running_task()).await {
        Ok(result) => println!("成功: {}", result),
        Err(_) => println!("任务超时!"),
    }
    
    // 设置 5 秒超时
    match timeout(Duration::from_secs(5), long_running_task()).await {
        Ok(result) => println!("成功: {}", result),
        Err(_) => println!("任务超时!"),
    }
}
```

## 六、常见陷阱与最佳实践

### 6.1 避免阻塞操作

❌ **错误示例**：在异步代码中使用阻塞操作
```rust
#[tokio::main]
async fn main() {
    tokio::spawn(async {
        // 这会阻塞工作线程!
        std::thread::sleep(std::time::Duration::from_secs(10));
    });
}
```

✅ **正确做法**：使用 Tokio 的异步版本或 `spawn_blocking`
```rust
#[tokio::main]
async fn main() {
    // 方法1: 使用异步版本
    tokio::spawn(async {
        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
    });
    
    // 方法2: 必须阻塞时使用 spawn_blocking
    tokio::task::spawn_blocking(|| {
        // 执行 CPU 密集或阻塞操作
        std::thread::sleep(std::time::Duration::from_secs(10));
    });
}
```

### 6.2 选择合适的运行时配置

```rust
// 单线程运行时 - 适合简单场景
#[tokio::main(flavor = "current_thread")]
async fn main() {
    // ...
}

// 多线程运行时 - 默认配置，适合大多数场景
#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    // ...
}

// 手动创建运行时 - 更多控制
fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .thread_name("my-pool")
        .build()
        .unwrap();
    
    runtime.block_on(async {
        // 异步代码
    });
}
```

### 6.3 正确使用 Mutex

```rust
use tokio::sync::Mutex;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let data = Arc::new(Mutex::new(vec![1, 2, 3]));
    
    // ✅ 正确：快速释放锁
    {
        let mut d = data.lock().await;
        d.push(4);
    } // 锁在这里释放
    
    // ❌ 避免：持有锁跨越 await 点
    // let mut d = data.lock().await;
    // tokio::time::sleep(Duration::from_secs(1)).await; // 危险!
    // d.push(4);
}
```

## 七、学习总结

### 核心要点

1. **异步模型**：Tokio 使用协作式多任务，通过 `async/await` 实现高效的并发处理

2. **运行时**：`#[tokio::main]` 宏负责创建运行时和调度器，是异步程序的基础

3. **任务生成**：
   - `tokio::spawn` 创建独立任务
   - `tokio::join!` 并发等待多个任务
   - `tokio::select!` 等待第一个完成的任务

4. **通信机制**：
   - Channel（mpsc, oneshot, broadcast）用于任务间传递消息
   - Arc + Mutex 用于共享可变状态

5. **避免阻塞**：永远不要在异步代码中使用阻塞操作，使用 Tokio 提供的异步版本

### 性能优势

- **轻量级任务**：相比线程，Tokio 任务几乎零开销
- **高并发能力**：可以轻松处理数万个并发连接
- **资源利用**：充分利用 CPU 多核能力，避免线程阻塞浪费

### 适用场景

✅ **非常适合**：
- Web 服务器和 API 服务
- 网络代理和负载均衡器
- 微服务架构
- 实时数据处理
- 高并发 I/O 密集型应用

⚠️ **不太适合**：
- CPU 密集型计算（考虑 Rayon 等并行计算库）
- 简单的命令行工具（同步代码更简单）

### 继续学习

1. **官方文档**：[tokio.rs](https://tokio.rs)
2. **Tokio Tutorial**：官方教程非常详细
3. **实践项目**：
   - 构建一个聊天服务器
   - 实现一个 HTTP 代理
   - 编写异步爬虫
4. **生态系统**：
   - `reqwest`：异步 HTTP 客户端
   - `axum` / `actix-web`：Web 框架
   - `tonic`：gRPC 框架

## 八、总结

Tokio 为 Rust 提供了强大而优雅的异步编程能力。通过掌握 `async/await`、任务生成、通道通信等核心概念，你可以编写出高性能、高并发的应用程序。关键是要理解异步运行时的工作原理，避免阻塞操作，合理使用并发原语。

从简单的 Hello World 开始，逐步实践并发任务、网络编程等场景，你会发现 Tokio 在保持 Rust 安全性的同时，提供了接近原生性能的异步处理能力。继续探索和实践，你将能够构建出真正强大的异步应用！

---

*Happy Async Programming with Tokio! 🚀*