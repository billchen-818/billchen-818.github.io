---
title: Rust 错误处理完全指南
date: 2026-02-25 14:38:32
tags: Rust
---

> Rust 没有异常（Exception）机制，而是采用**类型系统**来处理错误。这种设计让错误处理变得显式、可靠，编译器会强制你处理每一个可能的错误——再也不会有"忘记 try-catch"的问题。

---

## 一、Rust 错误处理的两大类别

| 类别 | 类型 | 说明 | 典型场景 |
|------|------|------|----------|
| **不可恢复错误** | `panic!` | 程序遇到不可修复的错误，立即终止 | 数组越界、不变量被破坏 |
| **可恢复错误** | `Result<T, E>` | 操作可能失败，但可以优雅处理 | 文件不存在、网络超时 |

---

## 二、不可恢复错误：`panic!`

### 2.1 基本用法

当程序遇到无法继续执行的情况时，使用 `panic!` 终止程序：

```rust
fn main() {
    panic!("程序崩溃了！");
}
```

输出：
```
thread 'main' panicked at '程序崩溃了！', src/main.rs:2:5
```

### 2.2 隐式 panic

有些操作在失败时会自动 panic：

```rust
fn main() {
    // 数组越界 —— 自动 panic
    let v = vec![1, 2, 3];
    println!("{}", v[99]);   // thread 'main' panicked at 'index out of bounds'

    // unwrap 在值为 None 时 panic
    let x: Option<i32> = None;
    x.unwrap();              // thread 'main' panicked at 'called `Option::unwrap()` on a `None` value'
}
```

### 2.3 查看完整的 panic 调用栈

```bash
# 设置环境变量，显示完整回溯信息
RUST_BACKTRACE=1 cargo run

# 更详细的回溯
RUST_BACKTRACE=full cargo run
```

### 2.4 何时使用 panic!

- ✅ 原型开发、快速验证想法
- ✅ 测试代码中断言失败
- ✅ 逻辑上"不可能"发生的情况（代表代码 bug）
- ❌ 不要用于可预期的失败（文件不存在、用户输入错误等）

---

## 三、可恢复错误：`Option<T>`

`Option` 用于表示"值可能不存在"的情况，替代其他语言中的 `null`。

### 3.1 Option 的定义

```rust
// 标准库中的定义
enum Option<T> {
    Some(T),    // 有值
    None,       // 无值
}
```

### 3.2 基本使用

```rust
fn find_user(id: u32) -> Option<String> {
    match id {
        1 => Some(String::from("Alice")),
        2 => Some(String::from("Bob")),
        _ => None,
    }
}

fn main() {
    // 方式一：match 匹配
    match find_user(1) {
        Some(name) => println!("找到用户: {}", name),
        None => println!("用户不存在"),
    }

    // 方式二：if let 简洁写法
    if let Some(name) = find_user(2) {
        println!("找到用户: {}", name);
    }
}
```

### 3.3 Option 的常用方法

```rust
fn main() {
    let some_value: Option<i32> = Some(42);
    let no_value: Option<i32> = None;

    // unwrap —— 有值返回，无值 panic（仅用于确定有值或快速原型）
    let val = some_value.unwrap();           // 42
    // no_value.unwrap();                    // ❌ panic!

    // unwrap_or —— 提供默认值
    let val = no_value.unwrap_or(0);         // 0

    // unwrap_or_else —— 通过闭包计算默认值（惰性求值）
    let val = no_value.unwrap_or_else(|| {
        println!("使用默认值");
        100
    });

    // expect —— 类似 unwrap，但可自定义 panic 信息
    let val = some_value.expect("值不应为空"); // 42

    // is_some / is_none —— 检查是否有值
    assert!(some_value.is_some());
    assert!(no_value.is_none());

    // map —— 对内部值进行转换
    let doubled = some_value.map(|x| x * 2);     // Some(84)
    let doubled = no_value.map(|x| x * 2);       // None

    // and_then（flatMap）—— 链式操作，避免 Option 嵌套
    let result = some_value
        .and_then(|x| if x > 10 { Some(x) } else { None })
        .and_then(|x| Some(x.to_string()));
    // Some("42")

    // filter —— 根据条件过滤
    let filtered = some_value.filter(|&x| x > 50);  // None（42 不大于 50）

    // or —— 如果是 None，返回备选 Option
    let val = no_value.or(Some(99));                 // Some(99)

    // zip —— 合并两个 Option
    let a = Some(1);
    let b = Some("hello");
    let zipped = a.zip(b);                           // Some((1, "hello"))
}
```

### 3.4 Option 在实际场景中的应用

```rust
// 在集合中查找元素
fn main() {
    let numbers = vec![1, 5, 9, 14, 20];

    // Vec::iter().find() 返回 Option
    let first_even = numbers.iter().find(|&&x| x % 2 == 0);
    match first_even {
        Some(n) => println!("第一个偶数: {}", n),
        None => println!("没有偶数"),
    }

    // HashMap::get() 返回 Option
    use std::collections::HashMap;
    let mut scores = HashMap::new();
    scores.insert("Alice", 95);

    let alice_score = scores.get("Alice");   // Some(&95)
    let bob_score = scores.get("Bob");       // None

    // 字符串解析
    let parsed: Option<i32> = "42".parse().ok();      // Some(42)
    let failed: Option<i32> = "abc".parse().ok();     // None
}
```

---

## 四、可恢复错误：`Result<T, E>`

`Result` 是 Rust 错误处理的核心，用于表示"操作可能成功也可能失败"。

### 4.1 Result 的定义

```rust
// 标准库中的定义
enum Result<T, E> {
    Ok(T),      // 成功，携带结果值
    Err(E),     // 失败，携带错误信息
}
```

### 4.2 基本使用

```rust
use std::fs::File;
use std::io::Read;

fn main() {
    // File::open 返回 Result<File, io::Error>
    let file_result = File::open("hello.txt");

    // 方式一：match 处理
    let mut file = match file_result {
        Ok(f) => f,
        Err(e) => {
            println!("打开文件失败: {}", e);
            return;
        }
    };

    let mut content = String::new();
    match file.read_to_string(&mut content) {
        Ok(bytes) => println!("读取了 {} 字节: {}", bytes, content),
        Err(e) => println!("读取失败: {}", e),
    }
}
```

### 4.3 根据错误类型分别处理

```rust
use std::fs::File;
use std::io::ErrorKind;

fn main() {
    let file = match File::open("config.toml") {
        Ok(f) => f,
        Err(e) => match e.kind() {
            // 文件不存在 → 创建文件
            ErrorKind::NotFound => match File::create("config.toml") {
                Ok(fc) => {
                    println!("配置文件不存在，已创建");
                    fc
                }
                Err(ce) => panic!("创建文件失败: {}", ce),
            },
            // 权限不足
            ErrorKind::PermissionDenied => {
                panic!("没有权限打开文件");
            }
            // 其他错误
            other => panic!("打开文件时发生未知错误: {:?}", other),
        },
    };
}
```

### 4.4 使用闭包简化（推荐）

```rust
use std::fs::File;
use std::io::ErrorKind;

fn main() {
    // 用 unwrap_or_else 替代嵌套 match
    let file = File::open("config.toml").unwrap_or_else(|error| {
        if error.kind() == ErrorKind::NotFound {
            File::create("config.toml").unwrap_or_else(|e| {
                panic!("创建文件失败: {}", e);
            })
        } else {
            panic!("打开文件失败: {}", error);
        }
    });
}
```

### 4.5 Result 的常用方法

```rust
fn parse_number(s: &str) -> Result<i32, std::num::ParseIntError> {
    s.parse::<i32>()
}

fn main() {
    let ok_result = parse_number("42");
    let err_result = parse_number("abc");

    // unwrap / expect
    let val = ok_result.unwrap();                    // 42
    let val = parse_number("42").expect("解析失败"); // 42

    // unwrap_or / unwrap_or_else / unwrap_or_default
    let val = err_result.unwrap_or(0);                             // 0
    let val = parse_number("abc").unwrap_or_else(|_| -1);          // -1
    let val: i32 = parse_number("abc").unwrap_or_default();        // 0 (i32 的 default)

    // map —— 转换成功值
    let doubled = parse_number("21").map(|n| n * 2);   // Ok(42)

    // map_err —— 转换错误值
    let result = parse_number("abc")
        .map_err(|e| format!("解析错误: {}", e));      // Err("解析错误: ...")

    // and_then —— 链式操作
    let result = parse_number("42")
        .and_then(|n| {
            if n > 0 { Ok(n) } else { Err("must be positive".parse::<i32>().unwrap_err()) }
        });

    // is_ok / is_err
    assert!(parse_number("42").is_ok());
    assert!(parse_number("abc").is_err());

    // ok() —— Result 转 Option（丢弃错误信息）
    let opt: Option<i32> = parse_number("42").ok();     // Some(42)

    // err() —— 提取错误
    let opt_err = parse_number("abc").err();             // Some(ParseIntError)
}
```

---

## 五、`?` 运算符：错误传播的利器

`?` 是 Rust 中最优雅的错误处理方式，它会自动传播错误，大幅减少样板代码。

### 5.1 基本用法

```rust
use std::fs;
use std::io;

// 不用 ? 的写法（繁琐）
fn read_file_verbose(path: &str) -> Result<String, io::Error> {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return Err(e),
    };
    Ok(content)
}

// 使用 ? 的写法（简洁）
fn read_file(path: &str) -> Result<String, io::Error> {
    let content = fs::read_to_string(path)?;   // 失败时自动 return Err(e)
    Ok(content)
}

// 更简洁：直接返回
fn read_file_short(path: &str) -> Result<String, io::Error> {
    fs::read_to_string(path)
}
```

### 5.2 链式调用

```rust
use std::fs::File;
use std::io::{self, Read};

fn read_username() -> Result<String, io::Error> {
    let mut s = String::new();
    File::open("username.txt")?.read_to_string(&mut s)?;
    Ok(s)
}
```

### 5.3 在 Option 上使用 `?`

```rust
fn first_even(numbers: &[i32]) -> Option<i32> {
    let first = numbers.first()?;   // 如果是 None，提前返回 None
    if first % 2 == 0 {
        Some(*first)
    } else {
        None
    }
}

// 链式使用
fn get_middle_char(s: &str) -> Option<char> {
    let len = s.len();
    if len == 0 {
        return None;
    }
    s.chars().nth(len / 2)
}

fn get_user_initial(user_id: u32) -> Option<char> {
    let name = find_user_name(user_id)?;   // None 则直接返回 None
    let initial = name.chars().next()?;     // None 则直接返回 None
    Some(initial.to_uppercase().next()?)
}

fn find_user_name(id: u32) -> Option<String> {
    match id {
        1 => Some(String::from("alice")),
        _ => None,
    }
}
```

### 5.4 在 main 函数中使用 `?`

```rust
use std::fs;
use std::io;

// main 也可以返回 Result
fn main() -> Result<(), io::Error> {
    let content = fs::read_to_string("config.toml")?;
    println!("配置: {}", content);
    Ok(())
}
```

使用 `Box<dyn Error>` 处理不同类型的错误：

```rust
use std::error::Error;
use std::fs;

fn main() -> Result<(), Box<dyn Error>> {
    let content = fs::read_to_string("data.txt")?;         // io::Error
    let number: i32 = content.trim().parse()?;              // ParseIntError
    println!("数字: {}", number);
    Ok(())
}
```

---

## 六、自定义错误类型

### 6.1 简单的自定义错误

```rust
use std::fmt;

// 定义错误枚举
#[derive(Debug)]
enum AppError {
    NotFound(String),
    PermissionDenied,
    InvalidInput { field: String, message: String },
    DatabaseError(String),
}

// 实现 Display trait（用户友好的错误信息）
impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::NotFound(resource) => write!(f, "未找到: {}", resource),
            AppError::PermissionDenied => write!(f, "权限不足"),
            AppError::InvalidInput { field, message } => {
                write!(f, "输入无效 - {}: {}", field, message)
            }
            AppError::DatabaseError(msg) => write!(f, "数据库错误: {}", msg),
        }
    }
}

// 实现 Error trait
impl std::error::Error for AppError {}

// 使用自定义错误
fn get_user(id: u32) -> Result<String, AppError> {
    if id == 0 {
        return Err(AppError::InvalidInput {
            field: String::from("id"),
            message: String::from("ID 不能为 0"),
        });
    }
    if id > 1000 {
        return Err(AppError::NotFound(format!("用户 {}", id)));
    }
    Ok(format!("User_{}", id))
}

fn main() {
    match get_user(0) {
        Ok(user) => println!("用户: {}", user),
        Err(e) => eprintln!("错误: {}", e),
        // 输出: 错误: 输入无效 - id: ID 不能为 0
    }
}
```

### 6.2 实现 `From` trait 自动转换错误

`?` 运算符会自动调用 `From::from()` 转换错误类型，因此实现 `From` 可以让不同错误类型无缝转换。

```rust
use std::fmt;
use std::io;
use std::num::ParseIntError;

#[derive(Debug)]
enum AppError {
    Io(io::Error),
    Parse(ParseIntError),
    Custom(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Io(e) => write!(f, "IO 错误: {}", e),
            AppError::Parse(e) => write!(f, "解析错误: {}", e),
            AppError::Custom(msg) => write!(f, "错误: {}", msg),
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AppError::Io(e) => Some(e),
            AppError::Parse(e) => Some(e),
            AppError::Custom(_) => None,
        }
    }
}

// 实现 From，自动转换
impl From<io::Error> for AppError {
    fn from(e: io::Error) -> Self {
        AppError::Io(e)
    }
}

impl From<ParseIntError> for AppError {
    fn from(e: ParseIntError) -> Self {
        AppError::Parse(e)
    }
}

// 现在可以在同一个函数中用 ? 处理不同类型的错误
fn read_and_parse(path: &str) -> Result<i32, AppError> {
    let content = std::fs::read_to_string(path)?;    // io::Error → AppError::Io
    let number = content.trim().parse::<i32>()?;      // ParseIntError → AppError::Parse
    if number < 0 {
        return Err(AppError::Custom("数字不能为负".into()));
    }
    Ok(number)
}

fn main() {
    match read_and_parse("number.txt") {
        Ok(n) => println!("读取到数字: {}", n),
        Err(e) => {
            eprintln!("发生错误: {}", e);
            // 获取底层错误
            if let Some(source) = std::error::Error::source(&e) {
                eprintln!("原因: {}", source);
            }
        }
    }
}
```

---

## 七、使用 `thiserror` 简化自定义错误（推荐）

手动实现 `Display`、`Error`、`From` 非常繁琐，`thiserror` 库通过派生宏自动完成。

```toml
# Cargo.toml
[dependencies]
thiserror = "1"
```

```rust
use thiserror::Error;

#[derive(Debug, Error)]
enum AppError {
    #[error("文件未找到: {0}")]
    NotFound(String),

    #[error("权限不足: {action}")]
    PermissionDenied { action: String },

    #[error("IO 错误")]
    Io(#[from] std::io::Error),              // 自动实现 From<io::Error>

    #[error("解析错误")]
    Parse(#[from] std::num::ParseIntError),  // 自动实现 From<ParseIntError>

    #[error("数据库连接失败: {0}")]
    Database(String),

    #[error(transparent)]                     // 透传底层错误的信息
    Other(#[from] Box<dyn std::error::Error + Send + Sync>),
}

fn process_file(path: &str) -> Result<i32, AppError> {
    let content = std::fs::read_to_string(path)?;       // 自动转换
    let number: i32 = content.trim().parse()?;           // 自动转换
    Ok(number * 2)
}

fn main() {
    match process_file("data.txt") {
        Ok(result) => println!("结果: {}", result),
        Err(e) => eprintln!("错误: {}", e),
    }
}
```

---

## 八、使用 `anyhow` 快速处理错误（应用层推荐）

`anyhow` 适合**应用程序**（不是库），提供方便的错误处理，无需定义自定义错误类型。

```toml
# Cargo.toml
[dependencies]
anyhow = "1"
```

### 8.1 基本用法

```rust
use anyhow::{Result, Context, bail, ensure};

// 使用 anyhow::Result 代替 Result<T, E>
fn read_config(path: &str) -> Result<String> {
    let content = std::fs::read_to_string(path)
        .context(format!("无法读取配置文件: {}", path))?;   // 添加上下文信息
    Ok(content)
}

fn parse_port(config: &str) -> Result<u16> {
    let port: u16 = config.trim().parse()
        .context("端口号解析失败")?;

    // ensure! 宏 —— 条件不满足时返回错误
    ensure!(port >= 1024, "端口号 {} 不能小于 1024", port);

    // bail! 宏 —— 直接返回错误
    if port > 65535 {
        bail!("端口号 {} 超出范围", port);
    }

    Ok(port)
}

fn main() -> Result<()> {
    let config = read_config("server.conf")
        .context("加载服务器配置失败")?;

    let port = parse_port(&config)?;
    println!("服务器端口: {}", port);

    Ok(())
}
```

### 8.2 错误链（Error Chain）

`anyhow` 自动维护错误链，方便调试：

```rust
use anyhow::{Result, Context};

fn connect_db(url: &str) -> Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "连接被拒绝"))
        .context(format!("无法连接数据库: {}", url))?;
    Ok(())
}

fn init_app() -> Result<()> {
    connect_db("postgres://localhost/mydb")
        .context("应用初始化失败")?;
    Ok(())
}

fn main() {
    if let Err(e) = init_app() {
        // 打印完整的错误链
        eprintln!("错误: {}", e);
        for cause in e.chain().skip(1) {
            eprintln!("  原因: {}", cause);
        }
        // 输出:
        // 错误: 应用初始化失败
        //   原因: 无法连接数据库: postgres://localhost/mydb
        //   原因: 连接被拒绝
    }
}
```

### 8.3 `thiserror` vs `anyhow` 选择指南

| 场景 | 推荐 | 原因 |
|------|------|------|
| **编写库（library）** | `thiserror` | 用户需要匹配具体错误类型进行处理 |
| **编写应用（binary）** | `anyhow` | 快速方便，关注错误信息而非类型 |
| **需要精确错误匹配** | `thiserror` | 提供枚举变体供调用者 match |
| **快速原型开发** | `anyhow` | 省去定义错误类型的工作 |
| **两者结合** | 都用 | 库用 `thiserror` 定义错误，应用用 `anyhow` 组合 |

---

## 九、高级技巧

### 9.1 为多个函数统一错误类型（类型别名）

```rust
use std::io;

// 定义一个类型别名，避免重复写错误类型
type Result<T> = std::result::Result<T, io::Error>;

fn read_file(path: &str) -> Result<String> {
    std::fs::read_to_string(path)
}

fn write_file(path: &str, content: &str) -> Result<()> {
    std::fs::write(path, content)
}
```

### 9.2 用 `map_err` 转换错误信息

```rust
fn parse_config(input: &str) -> Result<u32, String> {
    input.parse::<u32>()
        .map_err(|e| format!("配置解析失败 '{}': {}", input, e))
}

fn main() {
    match parse_config("not_a_number") {
        Ok(val) => println!("值: {}", val),
        Err(msg) => eprintln!("{}", msg),
        // 输出: 配置解析失败 'not_a_number': invalid digit found in string
    }
}
```

### 9.3 组合多个 Option/Result

```rust
fn main() {
    // 多个 Option 组合
    let a: Option<i32> = Some(10);
    let b: Option<i32> = Some(20);
    let c: Option<i32> = None;

    // zip 合并
    let sum = a.zip(b).map(|(x, y)| x + y);  // Some(30)
    let sum = a.zip(c).map(|(x, y)| x + y);  // None

    // 将 Vec<Result<T, E>> 转为 Result<Vec<T>, E>
    let results: Vec<Result<i32, String>> = vec![
        Ok(1),
        Ok(2),
        Ok(3),
    ];
    let collected: Result<Vec<i32>, String> = results.into_iter().collect();
    assert_eq!(collected, Ok(vec![1, 2, 3]));

    // 如果有一个 Err，整体就是 Err
    let results: Vec<Result<i32, String>> = vec![
        Ok(1),
        Err(String::from("失败")),
        Ok(3),
    ];
    let collected: Result<Vec<i32>, String> = results.into_iter().collect();
    assert_eq!(collected, Err(String::from("失败")));
}
```

### 9.4 `ok_or` / `ok_or_else`：Option 转 Result

```rust
fn find_user(id: u32) -> Option<String> {
    if id == 1 { Some(String::from("Alice")) } else { None }
}

fn get_user(id: u32) -> Result<String, String> {
    // Option 转 Result
    find_user(id).ok_or(format!("用户 {} 不存在", id))
}

fn get_user_lazy(id: u32) -> Result<String, String> {
    // 惰性版本，只在 None 时计算错误消息
    find_user(id).ok_or_else(|| {
        eprintln!("查询用户 {} 失败", id);
        format!("用户 {} 不存在", id)
    })
}

fn main() {
    println!("{:?}", get_user(1));    // Ok("Alice")
    println!("{:?}", get_user(99));   // Err("用户 99 不存在")
}
```

### 9.5 自定义 panic 行为

```rust
use std::panic;

fn main() {
    // 捕获 panic（不推荐常用，但在特殊场景有用）
    let result = panic::catch_unwind(|| {
        println!("正常代码");
        panic!("出错了！");
    });

    match result {
        Ok(_) => println!("一切正常"),
        Err(_) => println!("捕获到了 panic"),
    }

    // 设置自定义 panic 处理器
    panic::set_hook(Box::new(|info| {
        eprintln!("❌ 程序异常: {}", info);
        // 可以在这里写日志、发送告警等
    }));
}
```

---

## 十、实战项目：构建健壮的文件处理器

综合运用所学知识，构建一个完整的错误处理示例：

```rust
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use thiserror::Error;

// ========== 1. 定义错误类型 ==========
#[derive(Debug, Error)]
enum ConfigError {
    #[error("配置文件不存在: {path}")]
    FileNotFound { path: String },

    #[error("读取文件失败: {path}")]
    ReadError {
        path: String,
        #[source]
        cause: std::io::Error,
    },

    #[error("解析失败，第 {line} 行: {message}")]
    ParseError { line: usize, message: String },

    #[error("缺少必填配置项: {0}")]
    MissingKey(String),

    #[error("配置值无效: {key} = {value} ({reason})")]
    InvalidValue {
        key: String,
        value: String,
        reason: String,
    },
}

// ========== 2. 配置解析器 ==========
struct Config {
    items: HashMap<String, String>,
}

impl Config {
    /// 从文件加载配置
    fn from_file(path: &str) -> Result<Self, ConfigError> {
        // 检查文件是否存在
        if !Path::new(path).exists() {
            return Err(ConfigError::FileNotFound {
                path: path.to_string(),
            });
        }

        // 读取文件
        let content = fs::read_to_string(path).map_err(|e| ConfigError::ReadError {
            path: path.to_string(),
            cause: e,
        })?;

        // 解析内容
        Self::parse(&content)
    }

    /// 解析配置内容（key=value 格式）
    fn parse(content: &str) -> Result<Self, ConfigError> {
        let mut items = HashMap::new();

        for (index, line) in content.lines().enumerate() {
            let line = line.trim();

            // 跳过空行和注释
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let parts: Vec<&str> = line.splitn(2, '=').collect();
            if parts.len() != 2 {
                return Err(ConfigError::ParseError {
                    line: index + 1,
                    message: format!("期望 key=value 格式，实际: '{}'", line),
                });
            }

            items.insert(
                parts[0].trim().to_string(),
                parts[1].trim().to_string(),
            );
        }

        Ok(Config { items })
    }

    /// 获取必填配置项
    fn require(&self, key: &str) -> Result<&str, ConfigError> {
        self.items
            .get(key)
            .map(|v| v.as_str())
            .ok_or_else(|| ConfigError::MissingKey(key.to_string()))
    }

    /// 获取端口配置
    fn get_port(&self) -> Result<u16, ConfigError> {
        let value = self.require("port")?;
        let port: u16 = value.parse().map_err(|_| ConfigError::InvalidValue {
            key: "port".to_string(),
            value: value.to_string(),
            reason: "必须是 0-65535 的整数".to_string(),
        })?;
        Ok(port)
    }
}

// ========== 3. 主函数 ==========
fn main() {
    match run() {
        Ok(()) => println!("✅ 程序正常退出"),
        Err(e) => {
            eprintln!("❌ {}", e);
            // 打印错误链
            let mut source = std::error::Error::source(&e);
            while let Some(cause) = source {
                eprintln!("   ↳ 原因: {}", cause);
                source = std::error::Error::source(cause);
            }
            std::process::exit(1);
        }
    }
}

fn run() -> Result<(), ConfigError> {
    let config = Config::from_file("app.conf")?;

    let host = config.require("host")?;
    let port = config.get_port()?;

    println!("🚀 服务器启动: {}:{}", host, port);
    Ok(())
}
```

---

## 十一、最佳实践总结

### 错误处理决策树

```
遇到潜在错误？
├── 不可恢复（程序 bug）→ panic!
└── 可恢复
    ├── 值可能不存在 → Option<T>
    └── 操作可能失败 → Result<T, E>
        ├── 快速原型 → unwrap() / expect()
        ├── 向上传播 → ? 运算符
        ├── 就地处理 → match / if let
        └── 提供默认值 → unwrap_or() / unwrap_or_else()
```

### 黄金准则

| 原则 | 说明 |
|------|------|
| **让错误显式可见** | 永远不要悄悄忽略错误 |
| **尽早处理或传播** | 用 `?` 传播，在最合适的层级处理 |
| **提供上下文信息** | 使用 `.context()` 或 `map_err()` 添加描述 |
| **区分库和应用** | 库用 `thiserror`，应用用 `anyhow` |
| **少用 `unwrap()`** | 仅在确定不会失败或原型代码中使用 |
| **善用类型系统** | 用 `Option` 代替 `null`，用 `Result` 代替异常 |
| **错误类型要语义化** | 自定义错误枚举，让调用者能精确匹配 |

---

## 总结

Rust 的错误处理从设计上就是**类型安全、编译时检查、零成本**的。学习路径建议：

1. **入门** → 理解 `Option` 和 `Result` 的含义
2. **基础** → 掌握 `match`、`if let`、`unwrap_or` 等处理手段
3. **进阶** → 熟练使用 `?` 运算符和错误传播
4. **实战** → 使用 `thiserror` / `anyhow` 构建完善的错误体系
5. **精通** → 设计清晰的错误层次结构，编写健壮的生产代码

掌握了错误处理，你就掌握了 Rust 编程中最重要的实践技能之一。🦀
