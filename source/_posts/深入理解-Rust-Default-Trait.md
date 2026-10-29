---
title: 深入理解 Rust Default Trait
date: 2026-05-29 16:58:57
tags: Rust
---

## 引言

在 Rust 中使用结构体或枚举时，我们经常需要一种方法来创建一个"标准"或"初始"实例，而无需每次都手动指定所有字段。尤其对于字段较多的复杂类型，手动逐一设置每个字段会非常繁琐。

那么，有没有一种方式可以方便地创建一个"合理"的默认实例呢？

答案就是 `std::default::Default` trait。它为类型提供了一种标准化的方式来定义默认值。只要一个类型实现了 `Default`，我们就可以轻松获得一个默认实例，简化初始化流程，让代码更加简洁——尤其是在处理配置结构体或可选字段时特别好用。

## 为什么需要默认值？

假设我们有如下结构体定义：

```rust
// 学生信息
struct StudentInfo {
    name: String,
    age: u32,
    email: String,
    courses: Vec<CourseInfo>,
}

// 课程信息：课程名称、分数、授课教师
struct CourseInfo {
    course_name: String,
    score: f32,
    teacher_name: String,
}
```

每次创建实例时，我们都需要填充所有字段：

```rust
fn main() {
    let _ = StudentInfo {
        name: String::from("Alice"),
        age: 20,
        email: String::from("alice@example.com"),
        courses: vec![
            CourseInfo {
                course_name: String::from("Math"),
                score: 95.0,
                teacher_name: String::from("Mr. Smith"),
            },
            CourseInfo {
                course_name: String::from("English"),
                score: 88.5,
                teacher_name: String::from("Ms. Johnson"),
            },
        ],
    };
}
```

如果每次都要逐一初始化，确实很麻烦。有没有什么办法能给结构体设置一组默认值呢？

在 Rust 中，`Default` trait 正是为此而生——它提供了一个 `default()` 方法，用于返回一个填充了默认值的实例。

## Default Trait 长什么样？

`Default` trait 定义在标准库的 `std::default::Default` 中，非常简洁：

```rust
pub trait Default: Sized {
    fn default() -> Self;
}
```

`default()` 是一个关联函数，不接受任何参数，返回一个填充了默认值的类型实例。

Rust 中许多基本类型和标准库类型已经内置了 `Default` 实现，比如：

- 数值类型默认为 `0`
- `bool` 默认为 `false`
- `String` 默认为 `""`（空字符串）
- `Vec<T>` 默认为 `vec![]`（空向量）

## 如何为自己的类型实现 Default？

有两种方式：

1. **使用 `#[derive(Default)]` 宏**——简单省事
2. **手动实现 `impl Default for T`**——灵活可控

### 方式一：使用 #[derive(Default)]

如果结构体中的**所有字段**都已经实现了 `Default`，我们可以直接用 `derive` 属性让编译器自动生成实现(我们可以使用`cargo expand`命令去查看编译器生成的代码)：

```rust
#[derive(Debug, Default)]
struct StudentInfo {
    name: String,
    age: u32,
    email: String,
}
```

```rust
fn main() {
    // 手动指定所有字段
    let si = StudentInfo {
        name: String::from("Alice"),
        age: 20,
        email: String::from("alice@example.com"),
    };
    println!("{:?}", si);

    // 使用默认值
    let s = StudentInfo::default();
    println!("{:?}", s);
}
```

`s` 的输出结果为：

```
StudentInfo { name: "", age: 0, email: "" }
```

可以看到，派生的默认值就是各类型的"零值"——`String` 为空字符串，`u32` 为 0。这不一定是我们想要的"业务默认值"，但在很多场景下已经够用了。

#### 枚举类型的 derive

对于枚举，同样可以派生 `Default`，但需要使用 `#[default]` 属性**显式标记**其中一个单元变体（不携带数据的变体）作为默认值：

```rust
#[derive(Default, Debug)]
enum LogLevel {
    Debug,
    Info,
    #[default] // 标记 Warning 为默认级别
    Warning,
    Error,
}
```

```rust
fn main() {
    let level: LogLevel = LogLevel::default();
    println!("Default log level: {:?}", level);
    // 输出: Default log level: Warning
}
```

### 方式二：手动实现 Default

当 `derive` 不适用时——比如某些字段没有实现 `Default`，或者我们需要自定义特定的默认值——就需要手动实现了。

以下面的结构体为例：

```rust
#[derive(Debug)]
struct StudentInfo {
    name: String,
    age: u32,
    email: String,
    courses: Vec<CourseInfo>,
}

#[derive(Debug)]
struct CourseInfo {
    course_name: String,
    score: f32,
    teacher_name: String,
}
```

我们希望默认的学生名为 `"alice"`、年龄为 `12`、邮箱为合法的默认邮箱，课程默认包含 Rust 和 Blockchain 两门。实现代码如下：

```rust
impl Default for StudentInfo {
    fn default() -> Self {
        StudentInfo {
            name: String::from("alice"),
            age: 12,
            email: String::from("alice@example.com"),
            courses: vec![
                CourseInfo {
                    course_name: String::from("Rust"),
                    score: 100.0,
                    teacher_name: String::from("Rust_Teacher"),
                },
                CourseInfo {
                    course_name: String::from("Blockchain"),
                    score: 90.0,
                    teacher_name: String::from("Blockchain_Teacher"),
                },
            ],
        }
    }
}
```

```rust
fn main() {
    let s = StudentInfo::default();
    println!("{:?}", s);
}
```

运行 `cargo run`，输出：

```
StudentInfo { name: "alice", age: 12, email: "alice@example.com", courses: [CourseInfo { course_name: "Rust", score: 100.0, teacher_name: "Rust_Teacher" }, CourseInfo { course_name: "Blockchain", score: 90.0, teacher_name: "Blockchain_Teacher" }] }
```

> ⚠️ **注意**：对于同一个类型，`#[derive(Default)]` 和手动 `impl Default` 不能同时使用，二者只能选其一。

## 实战技巧：结合结构体更新语法

一旦类型实现了 `Default`，有一个特别实用的模式：**结构体更新语法（Struct Update Syntax）**。

我们只需指定需要修改的字段，其余字段自动使用默认值填充：

```rust
fn main() {
    let s = StudentInfo {
        name: String::from("Bob"),
        age: 22,
        ..StudentInfo::default() // 其余字段使用默认值
    };

    println!("{:?}", s);
}
```

输出：

```
StudentInfo { name: "Bob", age: 22, email: "alice@example.com", courses: [CourseInfo { course_name: "Rust", score: 100.0, teacher_name: "Rust_Teacher" }, CourseInfo { course_name: "Blockchain", score: 90.0, teacher_name: "Blockchain_Teacher" }] }
```

`..StudentInfo::default()` 这个语法可以让我们只关注需要变化的字段，其余的交给默认值。在构建配置项、测试数据等场景下非常实用。

## 总结

| 特性 | 说明 |
|------|------|
| `Default` trait | 为类型提供标准化的默认值创建方式 |
| `#[derive(Default)]` | 自动派生，要求所有字段都实现 `Default` |
| 手动 `impl Default` | 完全自定义默认值，灵活可控 |
| 结构体更新语法 | `..Type::default()` 只覆盖需要修改的字段 |
| 枚举默认值 | 使用 `#[default]` 标记默认变体 |

`Default` trait 虽然简单，但在实际项目中使用频率非常高。掌握它，能让你的 Rust 代码更加简洁优雅。