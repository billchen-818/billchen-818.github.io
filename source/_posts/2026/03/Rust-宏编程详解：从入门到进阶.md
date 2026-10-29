---
title: Rust 宏编程详解：从入门到进阶
date: 2026-03-04 16:38:47
tags: Rust
---

宏（Macro）是 Rust 中最强大也最独特的特性之一。它允许我们编写**能生成代码的代码**，即所谓的"元编程"（Metaprogramming）。日常开发中，`println!`、`vec!`、`#[derive(Debug)]` 这些耳熟能详的工具，背后都是宏在发挥作用。

本文将从浅到深，系统讲解 Rust 宏的两大类型：**声明式宏（Declarative Macros）** 和 **过程宏（Procedural Macros）**，并通过大量代码和案例帮助你掌握宏编程的核心技巧。

---

## 一、为什么需要宏？

在开始之前，先搞清楚一个问题：Rust 已经有了泛型和 trait，为什么还需要宏？

| 特性 | 泛型/Trait | 宏 |
|------|-----------|-----|
| 作用时机 | 编译期类型检查 | 编译前代码展开 |
| 参数数量 | 固定 | **可变参数** |
| 能力范围 | 类型抽象 | **语法扩展、代码生成** |
| 典型场景 | 通用数据结构 | DSL、减少样板代码 |

简单来说，宏能做到函数做不到的事情：

- **可变参数**：`println!("hello {} {}", a, b)` 接受任意数量的参数
- **代码生成**：`#[derive(Debug, Clone)]` 自动为结构体实现 trait
- **语法扩展**：`vec![1, 2, 3]` 创造全新的语法形式

---

## 二、声明式宏（macro_rules!）

声明式宏是 Rust 中最常用的宏形式，使用 `macro_rules!` 定义，本质上是**模式匹配 + 代码模板替换**。

### 2.1 第一个宏：say_hello!

```rust
macro_rules! say_hello {
    () => {
        println!("Hello, Macro!");
    };
}

fn main() {
    say_hello!(); // 输出: Hello, Macro!
}
```

语法拆解：
- `macro_rules! say_hello`：定义一个名为 `say_hello` 的宏
- `() => { ... }`：当匹配到空参数 `()` 时，展开为 `{ ... }` 中的代码
- 调用时使用 `!`：`say_hello!()`

### 2.2 带参数的宏

宏可以捕获不同类型的参数，使用 `$名称:类型` 的语法：

```rust
macro_rules! greet {
    ($name:expr) => {
        println!("Hello, {}!", $name);
    };
}

fn main() {
    greet!("Rust");       // Hello, Rust!
    greet!(42);           // Hello, 42!
    greet!(1 + 2);        // Hello, 3!
}
```

其中 `$name:expr` 表示捕获一个**表达式（expression）**，绑定到 `$name`。

### 2.3 常用的捕获类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `expr` | 表达式 | `1 + 2`, `"hello"`, `func()` |
| `ident` | 标识符 | `x`, `MyStruct`, `foo` |
| `ty` | 类型 | `i32`, `Vec<String>`, `&str` |
| `pat` | 模式 | `_`, `Some(x)`, `1..=5` |
| `stmt` | 语句 | `let x = 1` |
| `block` | 代码块 | `{ println!("hi"); }` |
| `item` | 条目 | `fn foo() {}`, `struct Bar;` |
| `literal` | 字面量 | `42`, `"hello"`, `true` |
| `tt` | 单个 token tree | 几乎匹配任何 token |
| `path` | 路径 | `std::io::Result` |

### 2.4 多分支匹配

宏可以定义多个匹配分支，就像 `match` 表达式一样：

```rust
macro_rules! calculate {
    // 加法
    (add $a:expr, $b:expr) => {
        $a + $b
    };
    // 乘法
    (mul $a:expr, $b:expr) => {
        $a * $b
    };
    // 默认：取反
    (neg $a:expr) => {
        -$a
    };
}

fn main() {
    let sum = calculate!(add 3, 5);    // 8
    let product = calculate!(mul 4, 6); // 24
    let neg = calculate!(neg 10);       // -10
    
    println!("sum={}, product={}, neg={}", sum, product, neg);
}
```

宏会**从上到下**尝试匹配每个分支，使用第一个成功匹配的分支。

### 2.5 重复匹配（可变参数的核心）

重复匹配是声明式宏最强大的特性，使用 `$(...)*` 或 `$(...)+` 语法：

- `$(...)*`：匹配零次或多次
- `$(...)+`：匹配一次或多次
- `$(...),*`：用逗号分隔的零次或多次

**案例1：实现自己的 vec! 宏**

```rust
macro_rules! my_vec {
    // 匹配逗号分隔的元素列表
    ( $( $elem:expr ),* ) => {
        {
            let mut v = Vec::new();
            $( v.push($elem); )*   // 对每个捕获的元素执行 push
            v
        }
    };
    // 支持尾部逗号
    ( $( $elem:expr ),+ , ) => {
        my_vec![ $( $elem ),* ]
    };
}

fn main() {
    let v1 = my_vec![1, 2, 3, 4, 5];
    let v2 = my_vec!["hello", "world"];
    let v3: Vec<i32> = my_vec![];
    let v4 = my_vec![10, 20, 30,]; // 尾部逗号也 OK
    
    println!("{:?}", v1);  // [1, 2, 3, 4, 5]
    println!("{:?}", v2);  // ["hello", "world"]
    println!("{:?}", v3);  // []
    println!("{:?}", v4);  // [10, 20, 30]
}
```

关键语法解析：
```
$( $elem:expr ),*
^^  ^^^^^^^^^^^  ^
|   |            |
|   |            +--- 分隔符: 逗号
|   +--- 重复的内容: 每次捕获一个 expr
+--- 重复标记

$( v.push($elem); )*
^^                 ^
|                  +--- 对应地展开多次
+--- 展开时使用捕获的变量
```

**案例2：创建 HashMap 的宏**

```rust
use std::collections::HashMap;

macro_rules! hashmap {
    ( $( $key:expr => $value:expr ),* $(,)? ) => {
        {
            let mut map = HashMap::new();
            $( map.insert($key, $value); )*
            map
        }
    };
}

fn main() {
    let scores = hashmap! {
        "Alice" => 95,
        "Bob" => 87,
        "Charlie" => 92,
    };
    
    for (name, score) in &scores {
        println!("{}: {}", name, score);
    }
}
```

> 注意 `$(,)?` 是匹配可选的尾部逗号，`?` 代表零次或一次。

### 2.6 实战案例：简易测试框架

来写一个更实用的宏——一个简易的测试断言框架：

```rust
macro_rules! assert_equal {
    ($left:expr, $right:expr) => {
        if $left != $right {
            panic!(
                "断言失败!\n  左值: {:?}\n  右值: {:?}\n  位置: {}:{}",
                $left,
                $right,
                file!(),
                line!()
            );
        }
    };
    ($left:expr, $right:expr, $($msg:tt)+) => {
        if $left != $right {
            panic!(
                "断言失败: {}\n  左值: {:?}\n  右值: {:?}\n  位置: {}:{}",
                format!($($msg)+),
                $left,
                $right,
                file!(),
                line!()
            );
        }
    };
}

macro_rules! run_tests {
    ( $( $name:ident : $body:block ),* $(,)? ) => {
        $(
            print!("测试 {} ... ", stringify!($name));
            let result = std::panic::catch_unwind(|| $body);
            match result {
                Ok(_) => println!("✅ 通过"),
                Err(_) => println!("❌ 失败"),
            }
        )*
    };
}

fn main() {
    run_tests! {
        test_addition: {
            assert_equal!(2 + 2, 4);
        },
        test_string: {
            assert_equal!("hello".to_uppercase(), "HELLO");
        },
        test_vec_len: {
            let v = vec![1, 2, 3];
            assert_equal!(v.len(), 3, "向量长度应为 {}", 3);
        },
    }
}
```

输出：
```
测试 test_addition ... ✅ 通过
测试 test_string ... ✅ 通过
测试 test_vec_len ... ✅ 通过
```

### 2.7 递归宏

宏可以在展开时调用自身，实现递归逻辑：

```rust
macro_rules! count {
    // 基准情况：没有 token 了
    () => { 0usize };
    // 递归：丢弃一个 token，对剩余部分递归
    ($head:tt $($tail:tt)*) => {
        1usize + count!($($tail)*)
    };
}

macro_rules! tuple_from_values {
    // 基准情况：单个值
    ($value:expr) => { ($value,) };
    // 递归情况：多个值
    ($head:expr, $($tail:expr),+) => {
        {
            let rest = tuple_from_values!($($tail),+);
            // 这里只是演示递归概念
            ($head, rest)
        }
    };
}

fn main() {
    let c = count!(a b c d e);
    println!("Token 数量: {}", c); // Token 数量: 5

    let t = tuple_from_values!(1, "hello", 3.14);
    println!("{:?}", t); // (1, ("hello", (3.14,)))
}
```

### 2.8 宏的作用域和导出

宏的作用域规则与普通函数不同：

```rust
// 方式1：在 crate 内部使用 #[macro_export]
#[macro_export]
macro_rules! public_macro {
    () => { println!("我是公开的宏"); };
}

// 方式2：在模块中使用 #[macro_use]
#[macro_use]
mod my_macros {
    macro_rules! internal_macro {
        () => { println!("我来自 my_macros 模块"); };
    }
}

// 方式3：Rust 2018+ 可以用路径引用
// use my_crate::public_macro;
```

---

## 三、过程宏（Procedural Macros）

过程宏是 Rust 的另一类宏，更加强大灵活。它接收 Rust 代码作为输入，**以编程方式**生成新的代码作为输出。

过程宏分为三种：

| 类型 | 语法 | 用途 |
|------|------|------|
| **派生宏（Derive）** | `#[derive(MyMacro)]` | 为类型自动实现 trait |
| **属性宏（Attribute）** | `#[my_attr]` | 修饰函数、结构体等 |
| **函数式宏（Function-like）** | `my_macro!(...)` | 类似声明式宏但更灵活 |

> ⚠️ 过程宏必须定义在独立的 crate 中，`Cargo.toml` 中需要设置 `proc-macro = true`。

### 3.1 准备工作

创建一个过程宏 crate：

```toml
# my_macros/Cargo.toml
[package]
name = "my_macros"
version = "0.1.0"
edition = "2021"

[lib]
proc-macro = true

[dependencies]
syn = { version = "2", features = ["full"] }
quote = "1"
proc-macro2 = "1"
```

三个核心依赖：
- **`syn`**：解析 Rust 代码为语法树（AST）
- **`quote`**：将语法树转回 Rust 代码
- **`proc-macro2`**：`proc-macro` 的包装，便于测试

### 3.2 派生宏（Derive Macro）

派生宏是最常用的过程宏，`#[derive(Debug, Clone, Serialize)]` 都是派生宏。

**案例：实现一个 `HelloMacro` 派生宏**

定义 trait：

```rust
// hello_trait/src/lib.rs
pub trait HelloMacro {
    fn hello();
}
```

实现派生宏：

```rust
// hello_macro_derive/src/lib.rs
use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, DeriveInput};

#[proc_macro_derive(HelloMacro)]
pub fn hello_macro_derive(input: TokenStream) -> TokenStream {
    // 解析输入的 Rust 代码为语法树
    let input = parse_macro_input!(input as DeriveInput);
    
    // 获取类型名称
    let name = &input.ident;
    let name_str = name.to_string();
    
    // 使用 quote! 生成代码
    let expanded = quote! {
        impl HelloMacro for #name {
            fn hello() {
                println!("Hello! 我是 {} 结构体，由 HelloMacro 派生宏自动实现！", #name_str);
            }
        }
    };
    
    // 返回生成的代码
    TokenStream::from(expanded)
}
```

使用：

```rust
use hello_trait::HelloMacro;
use hello_macro_derive::HelloMacro;

#[derive(HelloMacro)]
struct Pancakes;

#[derive(HelloMacro)]
struct Waffles;

fn main() {
    Pancakes::hello(); // Hello! 我是 Pancakes 结构体，由 HelloMacro 派生宏自动实现！
    Waffles::hello();  // Hello! 我是 Waffles 结构体，由 HelloMacro 派生宏自动实现！
}
```

### 3.3 实战：自动生成 Builder 模式

Builder 模式是一个经典的样板代码场景，非常适合用派生宏来消除：

```rust
// builder_macro/src/lib.rs
use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, DeriveInput, Data, Fields};

#[proc_macro_derive(Builder)]
pub fn builder_derive(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    let name = &input.ident;
    let builder_name = syn::Ident::new(
        &format!("{}Builder", name),
        name.span(),
    );

    // 提取结构体字段
    let fields = match &input.data {
        Data::Struct(data) => match &data.fields {
            Fields::Named(fields) => &fields.named,
            _ => panic!("Builder 仅支持命名字段的结构体"),
        },
        _ => panic!("Builder 仅支持结构体"),
    };

    // 为 Builder 生成 Option 包装的字段
    let builder_fields = fields.iter().map(|f| {
        let name = &f.ident;
        let ty = &f.ty;
        quote! { #name: Option<#ty> }
    });

    // 生成 setter 方法
    let builder_setters = fields.iter().map(|f| {
        let name = &f.ident;
        let ty = &f.ty;
        quote! {
            pub fn #name(mut self, value: #ty) -> Self {
                self.#name = Some(value);
                self
            }
        }
    });

    // 生成 build 方法中的字段赋值
    let build_fields = fields.iter().map(|f| {
        let name = &f.ident;
        let name_str = name.as_ref().unwrap().to_string();
        quote! {
            #name: self.#name.ok_or(format!("字段 '{}' 未设置", #name_str))?
        }
    });

    // Builder 初始化字段（全部为 None）
    let builder_defaults = fields.iter().map(|f| {
        let name = &f.ident;
        quote! { #name: None }
    });

    let expanded = quote! {
        pub struct #builder_name {
            #(#builder_fields,)*
        }

        impl #builder_name {
            #(#builder_setters)*

            pub fn build(self) -> Result<#name, String> {
                Ok(#name {
                    #(#build_fields,)*
                })
            }
        }

        impl #name {
            pub fn builder() -> #builder_name {
                #builder_name {
                    #(#builder_defaults,)*
                }
            }
        }
    };

    TokenStream::from(expanded)
}
```

使用效果：

```rust
use builder_macro::Builder;

#[derive(Builder, Debug)]
struct Server {
    host: String,
    port: u16,
    max_connections: u32,
    timeout_ms: u64,
}

fn main() {
    let server = Server::builder()
        .host("127.0.0.1".to_string())
        .port(8080)
        .max_connections(1000)
        .timeout_ms(5000)
        .build()
        .expect("构建 Server 失败");

    println!("{:#?}", server);
    // Server {
    //     host: "127.0.0.1",
    //     port: 8080,
    //     max_connections: 1000,
    //     timeout_ms: 5000,
    // }
    
    // 缺少字段会报错
    let result = Server::builder()
        .host("localhost".to_string())
        .build();
    println!("{:?}", result); // Err("字段 'port' 未设置")
}
```

### 3.4 属性宏（Attribute Macro）

属性宏可以附加在函数、结构体等条目上，对其进行变换：

```rust
// my_macros/src/lib.rs
use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, ItemFn};

/// 计时属性宏：自动记录函数执行时间
#[proc_macro_attribute]
pub fn timed(_attr: TokenStream, item: TokenStream) -> TokenStream {
    let input = parse_macro_input!(item as ItemFn);
    
    let fn_name = &input.sig.ident;
    let fn_name_str = fn_name.to_string();
    let fn_block = &input.block;
    let fn_sig = &input.sig;
    let fn_vis = &input.vis;
    let fn_attrs = &input.attrs;
    
    let expanded = quote! {
        #(#fn_attrs)*
        #fn_vis #fn_sig {
            let __start = std::time::Instant::now();
            let __result = (|| #fn_block)();
            let __duration = __start.elapsed();
            println!("[⏱ {}] 耗时: {:?}", #fn_name_str, __duration);
            __result
        }
    };
    
    TokenStream::from(expanded)
}
```

使用：

```rust
use my_macros::timed;

#[timed]
fn heavy_computation() -> u64 {
    let mut sum = 0u64;
    for i in 0..10_000_000 {
        sum += i;
    }
    sum
}

#[timed]
fn quick_task() -> &'static str {
    "done"
}

fn main() {
    let result = heavy_computation();
    println!("计算结果: {}", result);
    // [⏱ heavy_computation] 耗时: 12.345ms
    // 计算结果: 49999995000000
    
    quick_task();
    // [⏱ quick_task] 耗时: 42ns
}
```

### 3.5 函数式过程宏（Function-like Macro）

函数式过程宏看起来像声明式宏的调用方式，但内部使用过程宏的编程能力：

```rust
// my_macros/src/lib.rs
use proc_macro::TokenStream;
use quote::quote;
use syn::{parse_macro_input, LitStr, Token, punctuated::Punctuated};
use syn::parse::{Parse, ParseStream};

// 定义 SQL 查询宏的输入格式
struct SqlInput {
    table: LitStr,
    fields: Vec<LitStr>,
}

impl Parse for SqlInput {
    fn parse(input: ParseStream) -> syn::Result<Self> {
        // 解析: "users", fields: ["name", "age", "email"]
        let table: LitStr = input.parse()?;
        input.parse::<Token![,]>()?;
        
        let ident: syn::Ident = input.parse()?;
        assert_eq!(ident.to_string(), "fields");
        input.parse::<Token![:]>()?;
        
        let content;
        syn::bracketed!(content in input);
        let fields: Punctuated<LitStr, Token![,]> = 
            content.parse_terminated(LitStr::parse, Token![,])?;
        
        Ok(SqlInput {
            table,
            fields: fields.into_iter().collect(),
        })
    }
}

#[proc_macro]
pub fn sql_select(input: TokenStream) -> TokenStream {
    let SqlInput { table, fields } = parse_macro_input!(input as SqlInput);
    
    let table_str = table.value();
    let field_strs: Vec<String> = fields.iter().map(|f| f.value()).collect();
    let fields_joined = field_strs.join(", ");
    let sql = format!("SELECT {} FROM {}", fields_joined, table_str);
    
    let expanded = quote! {
        #sql.to_string()
    };
    
    TokenStream::from(expanded)
}
```

使用：

```rust
use my_macros::sql_select;

fn main() {
    let query = sql_select!("users", fields: ["name", "age", "email"]);
    println!("{}", query);
    // 输出: SELECT name, age, email FROM users
}
```

---

## 四、高级技巧与最佳实践

### 4.1 宏调试：展开查看

调试宏最有效的方式是查看展开后的代码：

```bash
# 使用 cargo-expand 工具（需要安装）
cargo install cargo-expand

# 展开所有宏
cargo expand

# 只展开特定模块
cargo expand module_name
```

对于声明式宏，也可以用 `trace_macros!`：

```rust
#![feature(trace_macros)]

trace_macros!(true);
let v = my_vec![1, 2, 3];
trace_macros!(false);
```

### 4.2 宏中的类型安全

结合 trait bound 让宏更加类型安全：

```rust
macro_rules! typed_map {
    ($key_type:ty => $value_type:ty; $( $k:expr => $v:expr ),* $(,)?) => {
        {
            let mut map: std::collections::HashMap<$key_type, $value_type> = 
                std::collections::HashMap::new();
            $(
                let key: $key_type = $k;
                let value: $value_type = $v;
                map.insert(key, value);
            )*
            map
        }
    };
}

fn main() {
    let ages = typed_map! {
        String => u32;
        "Alice".to_string() => 30,
        "Bob".to_string() => 25,
    };
    println!("{:?}", ages);
    
    // 以下会编译报错：类型不匹配
    // let wrong = typed_map! {
    //     i32 => i32;
    //     "oops" => 1,   // &str 不是 i32
    // };
}
```

### 4.3 内部规则模式（Internal Rules）

使用 `@` 前缀定义内部辅助规则，避免污染公共 API：

```rust
macro_rules! css {
    // 公共入口
    ($($property:ident : $value:expr);* $(;)?) => {
        {
            let mut styles = Vec::new();
            $(
                styles.push(css!(@format $property, $value));
            )*
            styles.join("; ")
        }
    };
    
    // 内部规则：格式化单条样式
    (@format $property:ident, $value:expr) => {
        format!("{}: {}", css!(@kebab $property), $value)
    };
    
    // 内部规则：转 kebab-case（简化版）
    (@kebab $name:ident) => {
        stringify!($name).replace('_', "-")
    };
}

fn main() {
    let style = css! {
        background_color: "red";
        font_size: "16px";
        margin_top: "10px"
    };
    println!("{}", style);
    // 输出: background-color: red; font-size: 16px; margin-top: 10px
}
```

### 4.4 TT Muncher 模式

TT Muncher（Token Tree 吞噬器）是一种逐个消耗 token 的递归模式，用于处理复杂语法：

```rust
macro_rules! command {
    // 终止条件
    (@run $cmd:expr) => {
        println!("执行命令: {}", $cmd);
    };
    
    // 匹配 pipe 操作
    (@run $cmd:expr; pipe $($rest:tt)*) => {
        print!("{} | ", $cmd);
        command!(@run $($rest)*);
    };
    
    // 匹配 then 操作
    (@run $cmd:expr; then $($rest:tt)*) => {
        println!("执行命令: {}", $cmd);
        command!(@run $($rest)*);
    };
    
    // 入口
    ($($tokens:tt)*) => {
        command!(@run $($tokens)*);
    };
}

fn main() {
    command!("ls -la" ; pipe "grep .rs" ; pipe "wc -l");
    // 输出:
    // ls -la | grep .rs | 执行命令: wc -l
    
    command!("cargo build" ; then "cargo test" ; then "cargo run");
    // 输出:
    // 执行命令: cargo build
    // 执行命令: cargo test
    // 执行命令: cargo run
}
```

---

## 五、实战综合案例：迷你 ORM 宏

最后，来一个完整的综合案例——用声明式宏实现一个迷你 ORM 风格的定义：

```rust
use std::collections::HashMap;

macro_rules! define_model {
    (
        model $name:ident {
            $( $field:ident : $ftype:ty ),* $(,)?
        }
    ) => {
        // 1. 定义结构体
        #[derive(Debug, Clone)]
        pub struct $name {
            $( pub $field: $ftype, )*
        }

        impl $name {
            // 2. 生成构造函数
            pub fn new($( $field: $ftype ),*) -> Self {
                Self { $( $field, )* }
            }

            // 3. 转为 HashMap
            pub fn to_map(&self) -> HashMap<&'static str, String> {
                let mut map = HashMap::new();
                $(
                    map.insert(
                        stringify!($field),
                        format!("{:?}", self.$field),
                    );
                )*
                map
            }

            // 4. 生成 INSERT SQL
            pub fn insert_sql(&self) -> String {
                let table = stringify!($name).to_lowercase();
                let columns: Vec<&str> = vec![ $( stringify!($field), )* ];
                let values: Vec<String> = vec![
                    $( format!("{:?}", self.$field), )*
                ];
                format!(
                    "INSERT INTO {} ({}) VALUES ({})",
                    table,
                    columns.join(", "),
                    values.join(", ")
                )
            }

            // 5. 字段名列表
            pub fn field_names() -> Vec<&'static str> {
                vec![ $( stringify!($field), )* ]
            }

            // 6. 生成 CREATE TABLE SQL（简化版）
            pub fn create_table_sql() -> String {
                let table = stringify!($name).to_lowercase();
                let fields: Vec<String> = vec![
                    $( format!("  {} {}", stringify!($field), stringify!($ftype)), )*
                ];
                format!(
                    "CREATE TABLE {} (\n{}\n);",
                    table,
                    fields.join(",\n")
                )
            }
        }
    };
}

// 使用宏定义模型
define_model! {
    model User {
        id: i64,
        name: String,
        email: String,
        age: u32,
    }
}

define_model! {
    model Article {
        id: i64,
        title: String,
        content: String,
        author_id: i64,
    }
}

fn main() {
    // 创建实例
    let user = User::new(
        1,
        "张三".to_string(),
        "zhangsan@example.com".to_string(),
        28,
    );

    println!("=== 用户信息 ===");
    println!("{:#?}", user);

    println!("\n=== 字段列表 ===");
    println!("{:?}", User::field_names());

    println!("\n=== INSERT SQL ===");
    println!("{}", user.insert_sql());

    println!("\n=== CREATE TABLE SQL ===");
    println!("{}", User::create_table_sql());

    println!("\n=== 转为 HashMap ===");
    for (key, value) in user.to_map() {
        println!("  {} => {}", key, value);
    }

    println!("\n=== 文章模型 ===");
    let article = Article::new(
        1,
        "Rust 宏编程".to_string(),
        "宏是 Rust 最强大的特性之一...".to_string(),
        1,
    );
    println!("{}", article.insert_sql());
}
```

输出：
```
=== 用户信息 ===
User {
    id: 1,
    name: "张三",
    email: "zhangsan@example.com",
    age: 28,
}

=== 字段列表 ===
["id", "name", "email", "age"]

=== INSERT SQL ===
INSERT INTO user (id, name, email, age) VALUES (1, "张三", "zhangsan@example.com", 28)

=== CREATE TABLE SQL ===
CREATE TABLE user (
  id i64,
  name String,
  email String,
  age u32
);

=== 转为 HashMap ===
  id => 1
  name => "张三"
  email => "zhangsan@example.com"
  age => 28

=== 文章模型 ===
INSERT INTO article (id, title, content, author_id) VALUES (1, "Rust 宏编程", "宏是 Rust 最强大的特性之一...", 1)
```

---

## 六、总结与对比

### 声明式宏 vs 过程宏

| 维度 | 声明式宏 `macro_rules!` | 过程宏 |
|------|------------------------|--------|
| 复杂度 | ⭐⭐ 较简单 | ⭐⭐⭐⭐ 较复杂 |
| 定义位置 | 任意 crate | 必须独立 crate |
| 依赖 | 无 | syn、quote、proc-macro2 |
| 能力 | 模式匹配 + 代码模板 | 完整编程能力 |
| 调试 | 较难 | 可单元测试 |
| 适用场景 | 简单代码生成、DSL | 复杂代码生成、derive |
| 卫生性 | 部分卫生 | 完全可控 |

### 何时用宏？

✅ **适合用宏的场景**：
- 减少重复的样板代码（Boilerplate）
- 需要可变参数的函数
- 自动实现 trait（derive 宏）
- 创建领域特定语言（DSL）
- 编译期验证和代码生成

❌ **不适合用宏的场景**：
- 普通函数或泛型就能解决的问题
- 逻辑非常复杂、难以调试的场景
- 团队成员不熟悉宏语法时（可读性）

### 推荐学习路径

```
1. 掌握 macro_rules! 的基本语法
       ↓
2. 练习重复匹配（$(...)*）模式
       ↓
3. 学习递归宏和 TT Muncher 模式
       ↓
4. 了解 syn、quote 库的基本用法
       ↓
5. 动手写一个 derive 宏
       ↓
6. 挑战属性宏和函数式过程宏
```

掌握 Rust 宏编程，你将解锁"让编译器为你写代码"的超能力。从 `macro_rules!` 起步，逐步深入过程宏，你会发现 Rust 的元编程世界远比想象中精彩。
