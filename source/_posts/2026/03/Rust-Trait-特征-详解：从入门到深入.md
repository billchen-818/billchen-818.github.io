---
title: Rust Trait (特征) 详解：从入门到深入
date: 2026-03-02 13:33:32
tags: Rust
---

Trait（特征）是 Rust 中非常核心的概念，它类似于其他语言中的接口（Interface），用于定义共享的行为。

## 1. 什么是 Trait？

Trait 告诉 Rust 编译器某个特定类型拥有可能与其他类型共享的功能。通过 trait 我们可以以抽象的方式定义共享的行为。我们可以使用 trait bounds（trait 约束）来指定泛型是任何拥有特定行为的类型。

## 2. 定义与实现 Trait

### 2.1 定义一个 Trait

使用 `trait` 关键字来声明一个 trait。这里我们定义一个 `Summary` trait，它包含一个 `summarize` 方法。

```rust
pub trait Summary {
    fn summarize(&self) -> String;
}
```

### 2.2 为类型实现 Trait

假设我们有两个结构体：`NewsArticle`（新闻文章）和 `Tweet`（推文）。我们可以为它们分别实现 `Summary` trait。

```rust
pub struct NewsArticle {
    pub headline: String,
    pub location: String,
    pub author: String,
    pub content: String,
}

impl Summary for NewsArticle {
    fn summarize(&self) -> String {
        format!("{}, by {} ({})", self.headline, self.author, self.location)
    }
}

pub struct Tweet {
    pub username: String,
    pub content: String,
    pub reply: bool,
    pub retweet: bool,
}

impl Summary for Tweet {
    fn summarize(&self) -> String {
        format!("{}: {}", self.username, self.content)
    }
}

fn main() {
    let tweet = Tweet {
        username: String::from("horse_ebooks"),
        content: String::from("Rust 语言真棒！"),
        reply: false,
        retweet: false,
    };

    println!("新推文: {}", tweet.summarize());
}
```

### 2.3 默认实现 (Default Implementations)

有时为 trait 中的某些或全部方法提供默认的行为是很有用的。

```rust
pub trait Summary {
    // 默认实现
    fn summarize(&self) -> String {
        String::from("(Read more...)")
    }
}

// 即使 NewsArticle 没有具体实现 summarize，它也可以使用默认实现
// impl Summary for NewsArticle {} 
```

## 3. Trait 作为参数 (Trait Bound)

我们不仅可以为类型实现 trait，还可以定义函数来接收实现了特定 trait 的类型。

### 3.1 `impl Trait` 语法

这是最简单的写法，也是语法糖。

```rust
pub fn notify(item: &impl Summary) {
    println!("Breaking news! {}", item.summarize());
}
```

### 3.2 Trait Bound 语法

这与上面的写法等价，但在处理更复杂的泛型约束时更强大。

```rust
pub fn notify<T: Summary>(item: &T) {
    println!("Breaking news! {}", item.summarize());
}
```

### 3.3 多重约束

如果我们需要参数同时实现多个 trait，可以使用 `+` 语法。

```rust
use std::fmt::Display;

pub fn notify(item: &(impl Summary + Display)) {
    // ...
}

// 或者
pub fn notify<T: Summary + Display>(item: &T) {
    // ...
}
```

### 3.4 `where` 子句

当约束过多时，函数签名会变得难以阅读。`where` 子句可以将约束后置。

```rust
fn some_function<T, U>(t: &T, u: &U) -> i32
where
    T: Display + Clone,
    U: Clone + Debug,
{
    // ...
    0
}
```

## 4. 返回实现了 Trait 的类型

我们可以使用 `impl Trait` 来隐藏具体的返回类型，只承诺返回类型实现了某个 trait。这在闭包和迭代器中非常常用。

```rust
fn returns_summarizable() -> impl Summary {
    Tweet {
        username: String::from("horse_ebooks"),
        content: String::from("of course, as you probably already know, people"),
        reply: false,
        retweet: false,
    }
}
```

**注意**：这种语法只能返回一种具体的类型。不能在一个分支返回 `Tweet`，另一个分支返回 `NewsArticle`。如果需要这样做，必须使用 Trait 对象（如 `Box<dyn Summary>`）。

## 5. 常见的标准库 Trait

Rust 标准库中有许多非常重要且常用的 Trait。

### 5.1 `Debug` 与 `Display`

*   `Debug` (`{:?}`):用于程序员调试，几乎所有类型都可以通过 `#[derive(Debug)]` 自动实现。
*   `Display` (`{}`): 用于向用户展示，必须手动实现。

```rust
use std::fmt;

struct Point {
    x: i32,
    y: i32,
}

// 手动实现 Display
impl fmt::Display for Point {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({}, {})", self.x, self.y)
    }
}
```

### 5.2 `Copy` 与 `Clone`

*   `Clone`: 用于显式地创建值的深拷贝 (`obj.clone()`)。
*   `Copy`: 一种特殊的标记 trait (Marker Trait)。如果一个类型实现了 `Copy`，它的值在赋值给另一个变量时会自动复制（按位拷贝），而不是移动（Move）。
    *   只有所有成员都实现了 `Copy` 的类型才能实现 `Copy`。
    *   实现了 `Drop` 的类型不能实现 `Copy`。

```rust
#[derive(Debug, Copy, Clone)]
struct Vector2 {
    x: f64,
    y: f64,
}
```

### 5.3 `Drop`

`Drop` trait 允许我们在值离开作用域时执行自定义代码（通常用于资源清理，如关闭文件、释放内存）。

```rust
struct CustomSmartPointer {
    data: String,
}

impl Drop for CustomSmartPointer {
    fn drop(&mut self) {
        println!("Dropping CustomSmartPointer with data `{}`!", self.data);
    }
}
```

### 5.4 `From` 与 `Into`

这两个 trait 用于类型转换。通常如果你实现了 `From`，系统会自动为你提供 `Into` 的实现。

```rust
struct Number {
    value: i32,
}

impl From<i32> for Number {
    fn from(item: i32) -> self {
        Number { value: item }
    }
}

fn main() {
    let num = Number::from(30);
    // 或者使用 Into (由编译器自动生成)
    let num2: Number = 30.into();
}
```

### 5.5 `Iterator`

Rust 中所有迭代器的核心。

```rust
pub trait Iterator {
    type Item; // 关联类型
    fn next(&mut self) -> Option<Self::Item>;
}
```

## 6. Trait 对象 (Trait Objects)

泛型 (`fn foo<T: Trait>(t: T)`) 是静态分发 (Static Dispatch)，编译器会为每个具体类型生成代码（单态化），性能最好。

Trait 对象 (`Box<dyn Trait>` 或 `&dyn Trait`) 是动态分发 (Dynamic Dispatch)，允许在运行时处理不同类型，但有微小的运行时开销（vtable 查找）。

```rust
pub struct Screen {
    pub components: Vec<Box<dyn Draw>>,
}

pub trait Draw {
    fn draw(&self);
}

// 可以在同一个 Vec 中存放不同类型，只要它们都实现了 Draw
impl Screen {
    pub fn run(&self) {
        for component in self.components.iter() {
            component.draw();
        }
    }
}
```

