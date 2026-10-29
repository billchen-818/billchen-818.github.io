---
title: Rust语言编程入门
date: 2026-02-24 14:15:54
tags: Rust
---

## 1. Rust 简介

Rust 是一门由 Mozilla 研发的系统级编程语言，专注于 **安全性**、**并发性** 和 **高性能**。它在没有垃圾回收机制的前提下，通过独特的 **所有权系统** 保证内存安全，是替代 C/C++ 的现代化选择。

### 核心优势

- **内存安全**：编译期消除空指针、悬垂指针、数据竞争等问题
- **零成本抽象**：高层抽象不带来额外运行时开销
- **无垃圾回收**：通过所有权系统管理内存，性能可预测
- **优秀的并发模型**：在编译期就能防止数据竞争
- **丰富的类型系统**：强类型 + 类型推导，代码更安全也更简洁

---

## 2. 环境搭建

### 安装 Rust

通过官方工具 `rustup` 安装：

```bash
# macOS / Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 验证安装
rustc --version
cargo --version
```

### 核心工具链

| 工具 | 说明 |
|------|------|
| `rustc` | Rust 编译器 |
| `cargo` | 包管理器 & 构建工具 |
| `rustup` | 工具链管理器 |
| `rustfmt` | 代码格式化工具 |
| `clippy` | 代码静态分析工具 |

### 创建项目

```bash
# 创建新项目
cargo new hello_rust
cd hello_rust

# 运行项目
cargo run

# 编译（调试模式）
cargo build

# 编译（发布模式，开启优化）
cargo build --release
```

---

## 3. 基本语法

### 3.1 Hello, World!

```rust
fn main() {
    println!("Hello, World!");
}
```

> `println!` 是一个 **宏**（macro），不是函数，注意后面的 `!`。

### 3.2 变量与可变性

Rust 中的变量 **默认不可变**（immutable），需要显式声明 `mut` 才能修改。

```rust
fn main() {
    let x = 5;          // 不可变变量
    // x = 6;           // ❌ 编译错误！

    let mut y = 10;     // 可变变量
    y = 20;             // ✅ 可以修改

    let z: i32 = 42;    // 显式指定类型

    // 变量遮蔽（Shadowing）
    let x = x + 1;      // ✅ 重新绑定，允许改变类型
    let x = "hello";    // ✅ 甚至可以变成不同类型
}
```

### 3.3 常量

```rust
const MAX_POINTS: u32 = 100_000;  // 常量必须标注类型，使用大写蛇形命名
```

---

## 4. 数据类型

### 4.1 标量类型

```rust
fn main() {
    // 整数类型：i8, i16, i32, i64, i128, isize
    //          u8, u16, u32, u64, u128, usize
    let a: i32 = -42;
    let b: u64 = 100;

    // 浮点数：f32, f64（默认 f64）
    let pi: f64 = 3.14159;

    // 布尔类型
    let is_active: bool = true;

    // 字符类型（4 字节，支持 Unicode）
    let c: char = '中';
    let emoji: char = '🦀';
}
```

### 4.2 复合类型

```rust
fn main() {
    // 元组（Tuple）—— 固定长度，可包含不同类型
    let tup: (i32, f64, char) = (500, 6.4, 'A');
    let (x, y, z) = tup;           // 解构
    let first = tup.0;             // 索引访问

    // 数组（Array）—— 固定长度，同一类型
    let arr: [i32; 5] = [1, 2, 3, 4, 5];
    let first = arr[0];

    let zeros = [0; 10];           // 10 个 0
}
```

---

## 5. 函数

```rust
// 基本函数
fn add(x: i32, y: i32) -> i32 {
    x + y   // 最后一个表达式作为返回值（无分号）
}

// 无返回值（返回单元类型 ()）
fn greet(name: &str) {
    println!("Hello, {}!", name);
}

// 提前返回
fn abs(x: i32) -> i32 {
    if x < 0 {
        return -x;
    }
    x
}

fn main() {
    let result = add(3, 5);
    println!("3 + 5 = {}", result);
    greet("Rust");
}
```

---

## 6. 控制流

### 6.1 条件判断

```rust
fn main() {
    let number = 7;

    if number > 5 {
        println!("大于 5");
    } else if number > 0 {
        println!("大于 0 但不大于 5");
    } else {
        println!("小于等于 0");
    }

    // if 是表达式，可以用于赋值
    let status = if number > 0 { "正数" } else { "非正数" };
}
```

### 6.2 循环

```rust
fn main() {
    // loop —— 无限循环
    let mut count = 0;
    let result = loop {
        count += 1;
        if count == 10 {
            break count * 2;    // break 可以返回值
        }
    };

    // while 循环
    let mut n = 3;
    while n > 0 {
        println!("{}!", n);
        n -= 1;
    }

    // for 循环（推荐方式）
    let arr = [10, 20, 30, 40, 50];
    for element in arr.iter() {
        println!("值: {}", element);
    }

    // 范围迭代
    for i in 0..5 {
        println!("i = {}", i);     // 0, 1, 2, 3, 4
    }

    for i in (1..=3).rev() {
        println!("倒数: {}", i);   // 3, 2, 1
    }
}
```

---

## 7. 所有权系统（核心概念）

所有权是 Rust 最独特的特性，它让 Rust 无需垃圾回收器即可保证内存安全。

### 7.1 所有权规则

1. Rust 中每个值都有一个 **所有者**（owner）
2. 值在任意时刻有且只有 **一个所有者**
3. 当所有者离开作用域时，值将被 **自动丢弃**（drop）

```rust
fn main() {
    let s1 = String::from("hello");
    let s2 = s1;        // s1 的所有权转移（move）给 s2
    // println!("{}", s1);  // ❌ 编译错误！s1 已失效

    let s3 = s2.clone(); // 深拷贝，s2 仍然有效
    println!("s2 = {}, s3 = {}", s2, s3);  // ✅
}
```

### 7.2 引用与借用

```rust
// 不可变引用（可以有多个）
fn calculate_length(s: &String) -> usize {
    s.len()
}

// 可变引用（同一作用域只能有一个）
fn push_str(s: &mut String) {
    s.push_str(" world");
}

fn main() {
    let mut s = String::from("hello");

    let len = calculate_length(&s);       // 不可变借用
    println!("长度: {}", len);

    push_str(&mut s);                     // 可变借用
    println!("修改后: {}", s);

    // 规则：不可变引用和可变引用不能同时存在
    let r1 = &s;
    let r2 = &s;       // ✅ 多个不可变引用
    // let r3 = &mut s; // ❌ 已有不可变引用时不能可变借用
    println!("{}, {}", r1, r2);
}
```

### 7.3 生命周期（Lifetime）

生命周期确保引用始终有效，编译器通常能自动推断，复杂场景需手动标注。

```rust
// 'a 是生命周期标注，表示返回值的生命周期与参数一致
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}

fn main() {
    let s1 = String::from("long string");
    let result;
    {
        let s2 = String::from("hi");
        result = longest(s1.as_str(), s2.as_str());
        println!("最长的是: {}", result);
    }
}
```

---

## 8. 结构体与枚举

### 8.1 结构体（Struct）

```rust
// 定义结构体
struct User {
    username: String,
    email: String,
    age: u32,
    active: bool,
}

// 为结构体实现方法
impl User {
    // 关联函数（类似构造函数）
    fn new(username: String, email: String, age: u32) -> Self {
        User {
            username,
            email,
            age,
            active: true,
        }
    }

    // 方法（&self 为不可变引用）
    fn summary(&self) -> String {
        format!("{} <{}>, {}岁", self.username, self.email, self.age)
    }

    // 可变方法
    fn deactivate(&mut self) {
        self.active = false;
    }
}

fn main() {
    let mut user = User::new(
        String::from("张三"),
        String::from("zhangsan@example.com"),
        25,
    );
    println!("{}", user.summary());
    user.deactivate();
}
```

### 8.2 枚举（Enum）

```rust
// 枚举可以携带数据
enum Message {
    Quit,
    Echo(String),
    Move { x: i32, y: i32 },
    Color(u8, u8, u8),
}

impl Message {
    fn call(&self) {
        match self {
            Message::Quit => println!("退出"),
            Message::Echo(text) => println!("回显: {}", text),
            Message::Move { x, y } => println!("移动到 ({}, {})", x, y),
            Message::Color(r, g, b) => println!("颜色: ({}, {}, {})", r, g, b),
        }
    }
}

// Option 枚举 —— Rust 用它替代 null
fn find_item(id: u32) -> Option<String> {
    if id == 1 {
        Some(String::from("找到了"))
    } else {
        None
    }
}

fn main() {
    let msg = Message::Move { x: 10, y: 20 };
    msg.call();

    // 处理 Option
    match find_item(1) {
        Some(item) => println!("{}", item),
        None => println!("未找到"),
    }

    // 更简洁的写法
    if let Some(item) = find_item(1) {
        println!("{}", item);
    }
}
```

---

## 9. 模式匹配

```rust
fn main() {
    let x = 5;

    // match 表达式（必须穷尽所有可能）
    match x {
        1 => println!("一"),
        2 | 3 => println!("二或三"),       // 多个值
        4..=9 => println!("四到九"),        // 范围
        _ => println!("其他"),              // 通配符
    }

    // 解构匹配
    let point = (3, -5);
    match point {
        (0, 0) => println!("原点"),
        (x, 0) => println!("x 轴上, x = {}", x),
        (0, y) => println!("y 轴上, y = {}", y),
        (x, y) => println!("点 ({}, {})", x, y),
    }

    // 带守卫的匹配
    let num = Some(42);
    match num {
        Some(n) if n < 0 => println!("负数"),
        Some(n) if n > 0 => println!("正数: {}", n),
        Some(0) => println!("零"),
        None => println!("无值"),
        _ => unreachable!(),
    }
}
```

---

## 10. 错误处理

Rust 没有异常机制，使用 `Result<T, E>` 和 `Option<T>` 处理错误。

```rust
use std::fs;
use std::io;

// Result 表示可能失败的操作
fn read_config(path: &str) -> Result<String, io::Error> {
    fs::read_to_string(path)
}

fn main() {
    // match 处理
    match read_config("config.toml") {
        Ok(content) => println!("配置内容: {}", content),
        Err(e) => println!("读取失败: {}", e),
    }

    // unwrap_or_else
    let content = read_config("config.toml")
        .unwrap_or_else(|_| String::from("默认配置"));

    // ? 运算符 —— 自动传播错误（只能在返回 Result 的函数中使用）
    // fn load() -> Result<String, io::Error> {
    //     let content = fs::read_to_string("file.txt")?;
    //     Ok(content)
    // }
}
```

### `?` 运算符链式调用

```rust
use std::fs::File;
use std::io::{self, Read};

fn read_username_from_file() -> Result<String, io::Error> {
    let mut s = String::new();
    File::open("username.txt")?.read_to_string(&mut s)?;
    Ok(s)
}
```

---

## 11. 泛型与 Trait

### 11.1 泛型

```rust
// 泛型函数
fn largest<T: PartialOrd>(list: &[T]) -> &T {
    let mut max = &list[0];
    for item in &list[1..] {
        if item > max {
            max = item;
        }
    }
    max
}

// 泛型结构体
struct Point<T> {
    x: T,
    y: T,
}

impl<T: std::fmt::Display> Point<T> {
    fn show(&self) {
        println!("({}, {})", self.x, self.y);
    }
}
```

### 11.2 Trait（类似接口）

```rust
// 定义 Trait
trait Summary {
    fn summarize(&self) -> String;

    // 可提供默认实现
    fn preview(&self) -> String {
        format!("{}...", &self.summarize()[..20])
    }
}

struct Article {
    title: String,
    content: String,
}

// 为类型实现 Trait
impl Summary for Article {
    fn summarize(&self) -> String {
        format!("{}: {}", self.title, self.content)
    }
}

// Trait 作为参数
fn notify(item: &impl Summary) {
    println!("新消息: {}", item.summarize());
}

// Trait Bound 写法（更灵活）
fn notify_all<T: Summary + std::fmt::Display>(item: &T) {
    println!("{}", item);
}
```

---

## 12. 集合类型

```rust
fn main() {
    // Vec<T> —— 动态数组
    let mut vec: Vec<i32> = Vec::new();
    vec.push(1);
    vec.push(2);
    vec.push(3);

    let vec2 = vec![10, 20, 30];   // 宏创建

    for v in &vec2 {
        println!("{}", v);
    }

    // HashMap<K, V> —— 哈希映射
    use std::collections::HashMap;

    let mut scores: HashMap<String, i32> = HashMap::new();
    scores.insert(String::from("Alice"), 95);
    scores.insert(String::from("Bob"), 87);

    // 查询
    if let Some(score) = scores.get("Alice") {
        println!("Alice 的分数: {}", score);
    }

    // 遍历
    for (name, score) in &scores {
        println!("{}: {}", name, score);
    }

    // String —— UTF-8 字符串
    let mut s = String::from("Hello");
    s.push_str(", Rust!");
    s.push('🦀');
    println!("{}", s);
}
```

---

## 13. 闭包与迭代器

### 13.1 闭包

```rust
fn main() {
    // 闭包 —— 可以捕获环境变量的匿名函数
    let add = |a: i32, b: i32| -> i32 { a + b };
    println!("{}", add(2, 3));

    // 类型推导，简写
    let square = |x| x * x;
    println!("{}", square(5));

    // 捕获环境变量
    let factor = 10;
    let multiply = |x| x * factor;
    println!("{}", multiply(5));   // 50
}
```

### 13.2 迭代器

```rust
fn main() {
    let numbers = vec![1, 2, 3, 4, 5];

    // 链式调用
    let sum: i32 = numbers.iter()
        .filter(|&&x| x > 2)
        .map(|&x| x * x)
        .sum();
    println!("结果: {}", sum);   // 9 + 16 + 25 = 50

    // collect 转换
    let doubled: Vec<i32> = numbers.iter()
        .map(|&x| x * 2)
        .collect();
    println!("{:?}", doubled);   // [2, 4, 6, 8, 10]
}
```

---

## 14. 并发编程

```rust
use std::thread;
use std::sync::{Arc, Mutex};

fn main() {
    // 创建线程
    let handle = thread::spawn(|| {
        for i in 1..5 {
            println!("子线程: {}", i);
        }
    });

    for i in 1..3 {
        println!("主线程: {}", i);
    }

    handle.join().unwrap();   // 等待子线程完成

    // 使用 Arc + Mutex 安全共享数据
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];

    for _ in 0..10 {
        let counter = Arc::clone(&counter);
        let handle = thread::spawn(move || {
            let mut num = counter.lock().unwrap();
            *num += 1;
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    println!("计数器: {}", *counter.lock().unwrap());   // 10
}
```

### 消息传递（Channel）

```rust
use std::sync::mpsc;
use std::thread;

fn main() {
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let messages = vec!["你好", "来自", "子线程"];
        for msg in messages {
            tx.send(msg).unwrap();
        }
    });

    for received in rx {
        println!("收到: {}", received);
    }
}
```

---

## 15. Cargo 与包管理

### Cargo.toml 配置

```toml
[package]
name = "my_project"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = { version = "1", features = ["full"] }
reqwest = "0.11"

[dev-dependencies]
assert_cmd = "2.0"
```

### 常用 Cargo 命令

```bash
cargo new project_name    # 创建项目
cargo build               # 编译
cargo run                 # 编译并运行
cargo test                # 运行测试
cargo doc --open          # 生成并打开文档
cargo fmt                 # 格式化代码
cargo clippy              # 代码检查
cargo add serde           # 添加依赖（需 cargo-edit）
cargo update              # 更新依赖
```

---

## 16. 测试

```rust
// 单元测试（写在同一文件中）
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    fn test_add_negative() {
        assert_eq!(add(-1, 1), 0);
    }

    #[test]
    #[should_panic(expected = "溢出")]
    fn test_overflow() {
        panic!("溢出");
    }
}
```

---

## 17. 常用宏速览

| 宏 | 用途 |
|------|------|
| `println!` / `eprintln!` | 标准输出 / 错误输出 |
| `format!` | 格式化字符串 |
| `vec!` | 创建 Vec |
| `dbg!` | 调试打印（含文件名和行号） |
| `todo!` | 标记未完成代码 |
| `unimplemented!` | 标记未实现代码 |
| `assert!` / `assert_eq!` / `assert_ne!` | 断言 |
| `cfg!` | 编译期条件检查 |

---

## 总结

Rust 的学习曲线虽然较陡，但一旦掌握所有权、借用和生命周期这些核心概念，就能编写出既安全又高效的代码。建议按以下路径学习：

1. **基础语法** → 变量、数据类型、函数、控制流
2. **核心概念** → 所有权、借用、生命周期
3. **类型系统** → 结构体、枚举、泛型、Trait
4. **实用技能** → 错误处理、集合、迭代器、闭包
5. **进阶主题** → 并发编程、智能指针、异步编程

### 推荐学习资源

- 📖 [The Rust Programming Language](https://doc.rust-lang.org/book/)（官方教程）
- 🏋️ [Rustlings](https://github.com/rust-lang/rustlings)（交互式练习）
- 📝 [Rust by Example](https://doc.rust-lang.org/rust-by-example/)（示例学习）
- 🔍 [crates.io](https://crates.io/)（第三方库仓库）
