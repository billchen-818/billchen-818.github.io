---
title: 深入理解 Rust 智能指针：从原理到实战
date: 2026-06-01 09:49:25
tags: Rust
---

## 引言

在 Rust 中，指针这个概念无处不在。最常见的指针就是引用（`&T`），它只是借用数据，不拥有数据。但在很多场景下，仅靠引用是不够的：

- 你想让数据分配在堆上，而不是栈上
- 你想让多个所有者共享同一份数据
- 你想在运行时动态决定数据的类型
- 你想在不可变结构中实现内部可变性

这些需求，普通引用都无法满足。Rust 为此提供了**智能指针**。

智能指针不同于普通引用的关键在于：

> 智能指针不仅持有指向数据的指针，还拥有元数据和额外能力（如自动释放内存、引用计数等）。

实际上，`String` 和 `Vec<T>` 本质上也是智能指针——它们拥有自己的堆内存，并在 Drop 时自动释放。

这篇文章会从浅到深，按以下层级讲解 Rust 智能指针：

- `Box<T>`：最简单的堆分配智能指针
- `Deref` 和 `Drop` trait：智能指针的核心机制
- `Rc<T>` 和 `Arc<T>`：引用计数与共享所有权
- `Cell<T>` 和 `RefCell<T>`：内部可变性
- `Cow<T>`：写时克隆
- `Pin<T>`：固定内存位置
- 自定义智能指针
- 各智能指针实现的 trait 总览

目标不是罗列 API，而是让你理解每种智能指针**为什么存在**、**什么时候用**、**底层怎么工作**。

---

## 一、Box\<T\>：最基础的堆分配智能指针

### 1.1 为什么需要 Box

Rust 默认将数据分配在栈上。栈分配快，但有两个限制：

1. **栈上数据的大小必须在编译期确定**
2. **栈的空间有限**，不适合存放大型数据

`Box<T>` 的作用很简单：把数据从栈移到堆上，同时保持唯一所有权。

```rust
fn main() {
    let x = Box::new(42);
    println!("x = {}", x); // 输出：x = 42
}
```

这里 `x` 是一个 `Box<i32>`，它在栈上只占一个指针大小（8 字节），而实际的 `42` 存储在堆上。当 `x` 离开作用域时，堆上的内存自动释放。

### 1.2 Box 的典型使用场景

**场景一：递归类型**

Rust 中的递归类型如果不使用 Box，编译器无法确定类型的大小：

```rust
// 编译失败：递归类型具有无限大小
// enum List {
//     Cons(i32, List),
//     Nil,
// }

// 使用 Box 打断无限递归
enum List {
    Cons(i32, Box<List>),
    Nil,
}

fn main() {
    let list = List::Cons(1,
        Box::new(List::Cons(2,
            Box::new(List::Cons(3,
                Box::new(List::Nil)
            ))
        ))
    );
    print_list(&list);
}

fn print_list(list: &List) {
    match list {
        List::Cons(val, next) => {
            print!("{} -> ", val);
            print_list(next);
        }
        List::Nil => println!("Nil"),
    }
}
// 输出：1 -> 2 -> 3 -> Nil
```

为什么 `Box` 能解决这个问题？因为 `Box<List>` 的大小是固定的——就是一个指针的大小（8 字节），不管它指向的 `List` 有多复杂。

**场景二：Trait 对象**

当你需要在运行时处理不同类型但它们实现了同一个 trait 时：

```rust
trait Animal {
    fn speak(&self);
}

struct Dog;
struct Cat;

impl Animal for Dog {
    fn speak(&self) {
        println!("汪汪！");
    }
}

impl Animal for Cat {
    fn speak(&self) {
        println!("喵喵！");
    }
}

fn main() {
    let animals: Vec<Box<dyn Animal>> = vec![
        Box::new(Dog),
        Box::new(Cat),
        Box::new(Dog),
    ];

    for animal in &animals {
        animal.speak();
    }
}
// 输出：
// 汪汪！
// 喵喵！
// 汪汪！
```

`Box<dyn Animal>` 是一个胖指针，包含两个指针：一个指向数据，一个指向 vtable（虚函数表）。

**场景三：转移大型数据的所有权而不拷贝**

```rust
fn main() {
    let large_data = Box::new([0u8; 1_000_000]); // 1MB 数据在堆上
    let moved = large_data; // 只移动了 8 字节的指针，而不是拷贝 1MB
    println!("len = {}", moved.len());
}
```

### 1.3 Box 的内存布局

```
栈上                     堆上
┌──────────┐            ┌──────────┐
│ Box<i32> │ ────────>  │   42     │
│ (8 bytes)│            │ (4 bytes)│
└──────────┘            └──────────┘
```

当 `Box` 离开作用域时：
1. 先调用 `T` 的 `drop`（如果 T 实现了 Drop）
2. 然后释放堆上的内存

### 1.4 Box 实现的关键 Trait

| Trait | 作用 |
|-------|------|
| `Deref<Target=T>` | 允许 `*box_val` 解引用到 `T` |
| `DerefMut<Target=T>` | 允许 `*box_val` 可变解引用到 `T` |
| `Drop` | 自动释放堆内存 |
| `AsRef<T>` | 可以转换为 `&T` |
| `AsMut<T>` | 可以转换为 `&mut T` |
| `Borrow<T>` | 可用于 HashMap 查找等场景 |
| `Display`（当 T: Display） | 可以直接 `println!` |
| `Clone`（当 T: Clone） | 深拷贝堆上的数据 |
| `PartialEq`, `Eq`, `PartialOrd`, `Ord`, `Hash` | 委托给内部类型 |

---

## 二、Deref 和 Drop：智能指针的核心 Trait

任何类型只要实现了 `Deref` 和 `Drop` 这两个 trait，就可以被称为智能指针。这两个 trait 是智能指针的灵魂。

### 2.1 Deref Trait：解引用与自动解引用转换

`Deref` trait 定义在标准库中：

```rust
pub trait Deref {
    type Target: ?Sized;
    fn deref(&self) -> &Self::Target;
}

pub trait DerefMut: Deref {
    fn deref_mut(&mut self) -> &mut Self::Target;
}
```

#### 显式解引用

当你对智能指针使用 `*` 操作符时，实际上调用的是 `deref()` 方法：

```rust
fn main() {
    let x = Box::new(5);

    // 这两行效果一样
    let y = *x;                // 语法糖
    let z = *(x.deref());     // 实际发生的事

    println!("y = {}, z = {}", y, z);
}
```

编译器遇到 `*x` 时，实际执行的是 `*(x.deref())`：先调用 `deref()` 得到 `&T`，再对 `&T` 解引用得到 `T`。

#### 自动解引用转换（Deref Coercion）

这是 Rust 中最优雅的设计之一。编译器会自动插入 `deref()` 调用来完成类型转换：

```rust
fn hello(name: &str) {
    println!("Hello, {}!", name);
}

fn main() {
    let name = Box::new(String::from("Rust"));

    // name 的类型是 Box<String>
    // 编译器自动执行：
    // &Box<String> -> &String（通过 Box 的 Deref）
    // &String -> &str（通过 String 的 Deref）
    hello(&name);
}
```

自动解引用转换链条：

```
&Box<String>
    │ Box::deref()
    ▼
&String
    │ String::deref()
    ▼
&str
```

**转换规则：**

| 原始类型 | 目标类型 | 要求 |
|---------|---------|------|
| `&T` | `&U` | T: Deref\<Target=U\> |
| `&mut T` | `&mut U` | T: DerefMut\<Target=U\> |
| `&mut T` | `&U` | T: Deref\<Target=U\> |

注意：`&T` 不能自动转换为 `&mut U`，因为这违反了借用规则。

#### 自定义类型实现 Deref

```rust
use std::ops::Deref;

struct MyBox<T>(T);

impl<T> MyBox<T> {
    fn new(x: T) -> MyBox<T> {
        MyBox(x)
    }
}

impl<T> Deref for MyBox<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0
    }
}

fn main() {
    let x = MyBox::new(42);
    assert_eq!(*x, 42);

    let s = MyBox::new(String::from("hello"));
    // 自动解引用：&MyBox<String> -> &String -> &str
    let r: &str = &s;
    println!("{}", r);
}
```

#### `->` 箭头操作符的原理

在 C/C++ 中，`->` 用于通过指针访问成员。Rust 中没有 `->` 操作符，取而代之的是 **自动解引用（auto-deref）机制**。

当你使用 `.` 运算符调用方法时，Rust 编译器会自动进行以下尝试：

1. 首先尝试直接调用 `T` 的方法
2. 然后尝试 `&T` 的方法
3. 然后尝试 `&mut T` 的方法
4. 如果 `T` 实现了 `Deref`，则尝试 `<T as Deref>::Target` 的方法
5. 递归重复以上过程

```rust
fn main() {
    let boxed_str = Box::new(String::from("hello"));

    // 调用 String::len()
    // 编译器自动执行：boxed_str.deref().len()
    // 即：Box<String> -> &String -> len()
    println!("长度：{}", boxed_str.len());

    // 调用 str::is_empty()
    // 编译器自动执行：boxed_str.deref().deref().is_empty()
    // 即：Box<String> -> &String -> &str -> is_empty()
    println!("是否为空：{}", boxed_str.is_empty());
}
```

这就是为什么 Rust 不需要 `->` 操作符——`.` 运算符通过 Deref 链自动完成了。

### 2.2 Drop Trait：自动清理资源

`Drop` trait 让你在值离开作用域时执行自定义清理逻辑：

```rust
pub trait Drop {
    fn drop(&mut self);
}
```

```rust
struct Resource {
    name: String,
}

impl Drop for Resource {
    fn drop(&mut self) {
        println!("释放资源：{}", self.name);
    }
}

fn main() {
    let r1 = Resource { name: String::from("数据库连接") };
    let r2 = Resource { name: String::from("文件句柄") };
    println!("资源已创建");
} // r2 先释放，r1 后释放（与创建顺序相反）

// 输出：
// 资源已创建
// 释放资源：文件句柄
// 释放资源：数据库连接
```

**Drop 的关键规则：**

1. **不能手动调用 `drop` 方法**（会导致双重释放），但可以使用 `std::mem::drop` 提前释放：

```rust
fn main() {
    let r = Resource { name: String::from("临时资源") };
    println!("使用资源");

    // r.drop(); // 编译错误！不能手动调用 drop

    drop(r); // 正确：使用 std::mem::drop 提前释放
    println!("资源已提前释放");
}
```

2. **Drop 顺序**：变量按声明的逆序 drop，结构体字段按声明顺序 drop。

3. **Drop 与 Copy 互斥**：实现了 `Drop` 的类型不能实现 `Copy`，因为 Copy 的语义是简单位拷贝，而 Drop 意味着析构时有副作用，两者冲突。

---

## 三、Rc\<T\>：单线程引用计数

### 3.1 为什么需要 Rc

Rust 的所有权规则是：一个值只有一个所有者。但有些场景下，一份数据确实需要被多个地方同时"拥有"。

比如图数据结构中，多个边可能指向同一个节点。此时就需要 `Rc<T>`（Reference Counting）。

```rust
use std::rc::Rc;

fn main() {
    let data = Rc::new(vec![1, 2, 3]);

    let a = Rc::clone(&data); // 引用计数 +1
    let b = Rc::clone(&data); // 引用计数 +1

    println!("引用计数：{}", Rc::strong_count(&data)); // 3
    println!("a = {:?}", a);
    println!("b = {:?}", b);

    drop(a);
    println!("drop a 后引用计数：{}", Rc::strong_count(&data)); // 2

    drop(b);
    println!("drop b 后引用计数：{}", Rc::strong_count(&data)); // 1
} // data 的引用计数降为 0，堆上的 Vec 被释放
```

### 3.2 Rc 的内存布局

```
栈上                         堆上
┌─────────┐               ┌────────────────────┐
│ Rc<T> a │ ──────────>   │ strong_count: 3     │
└─────────┘       ┌────>  │ weak_count: 1       │
┌─────────┐       │       │ data: Vec<1,2,3>    │
│ Rc<T> b │ ──────┘       └────────────────────┘
└─────────┘       │
┌─────────┐       │
│ Rc<T> c │ ──────┘
└─────────┘
```

所有 `Rc` 指针都指向同一块堆内存，该内存包含引用计数和实际数据。

### 3.3 Rc::clone vs clone

需要注意，`Rc::clone(&data)` 并不做深拷贝。它只是增加引用计数，这是 O(1) 操作。而 `data.clone()` 虽然效果一样，但习惯上用 `Rc::clone()` 来明确表达意图。

### 3.4 Weak 引用：打破循环引用

`Rc` 的一个陷阱是循环引用会导致内存泄漏：

```rust
use std::rc::{Rc, Weak};
use std::cell::RefCell;

#[derive(Debug)]
struct Node {
    value: i32,
    parent: RefCell<Weak<Node>>,     // 弱引用指向父节点
    children: RefCell<Vec<Rc<Node>>>, // 强引用指向子节点
}

fn main() {
    let leaf = Rc::new(Node {
        value: 3,
        parent: RefCell::new(Weak::new()),
        children: RefCell::new(vec![]),
    });

    println!("leaf 的强引用计数: {}", Rc::strong_count(&leaf)); // 1

    let branch = Rc::new(Node {
        value: 5,
        parent: RefCell::new(Weak::new()),
        children: RefCell::new(vec![Rc::clone(&leaf)]),
    });

    // 设置 leaf 的父节点为 branch（使用弱引用）
    *leaf.parent.borrow_mut() = Rc::downgrade(&branch);

    println!("branch 的强引用计数: {}", Rc::strong_count(&branch)); // 1
    println!("branch 的弱引用计数: {}", Rc::weak_count(&branch));   // 1
    println!("leaf 的强引用计数: {}", Rc::strong_count(&leaf));     // 2

    // 通过 Weak 访问父节点
    if let Some(parent) = leaf.parent.borrow().upgrade() {
        println!("leaf 的父节点值: {}", parent.value); // 5
    }
}
```

**Weak 的关键特性：**

- `Rc::downgrade(&rc)` 创建 Weak 引用
- `weak.upgrade()` 返回 `Option<Rc<T>>`，如果数据已释放则返回 `None`
- Weak 引用不增加 strong_count，不阻止数据释放
- 用于解决循环引用问题

### 3.5 Rc 实现的关键 Trait

| Trait | 作用 |
|-------|------|
| `Deref<Target=T>` | 直接访问内部数据 |
| `Drop` | 减少引用计数，计数为 0 时释放 |
| `Clone` | 增加引用计数（非深拷贝） |
| `Display`（当 T: Display） | 委托给内部类型 |
| `Debug`（当 T: Debug） | 委托给内部类型 |
| `PartialEq`, `Eq`, `PartialOrd`, `Ord` | 委托给内部类型 |
| `AsRef<T>` | 转换为 `&T` |
| `From<T>` | 从 T 构造 Rc\<T\> |

> **注意：Rc 没有实现 `DerefMut`**，因为多个 Rc 共享数据，允许可变访问会违反借用规则。要修改 Rc 内部数据，需要搭配 `RefCell`。

---

## 四、Arc\<T\>：多线程引用计数

`Arc<T>`（Atomic Reference Counting）是 `Rc<T>` 的线程安全版本。

### 4.1 Rc 不能跨线程

```rust
use std::rc::Rc;
use std::thread;

fn main() {
    let data = Rc::new(42);
    // let handle = thread::spawn(move || {
    //     println!("{}", data);
    // });
    // 编译错误：Rc<i32> cannot be sent between threads safely
    // 因为 Rc 没有实现 Send trait
}
```

### 4.2 Arc 的使用

```rust
use std::sync::Arc;
use std::thread;

fn main() {
    let data = Arc::new(vec![1, 2, 3, 4, 5]);
    let mut handles = vec![];

    for i in 0..3 {
        let data = Arc::clone(&data);
        let handle = thread::spawn(move || {
            println!("线程 {} 看到: {:?}", i, data);
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }
}
```

### 4.3 Arc + Mutex：多线程共享可变数据

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
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

    println!("最终计数: {}", *counter.lock().unwrap()); // 10
}
```

### 4.4 Rc vs Arc 对比

| 特性 | Rc\<T\> | Arc\<T\> |
|------|---------|----------|
| 线程安全 | 否 | 是 |
| 引用计数操作 | 普通整数运算 | 原子操作 |
| 性能 | 更快 | 稍慢（原子操作开销） |
| 实现 Send | 否 | 是（当 T: Send + Sync） |
| 实现 Sync | 否 | 是（当 T: Send + Sync） |
| 使用场景 | 单线程 | 多线程 |

---

## 五、Cell\<T\> 和 RefCell\<T\>：内部可变性

### 5.1 什么是内部可变性

Rust 的借用规则是：

- 同一时刻，要么有多个不可变引用，要么有一个可变引用
- 引用必须始终有效

内部可变性（Interior Mutability）是一种设计模式：即使持有不可变引用，也能修改内部数据。

### 5.2 Cell\<T\>：适用于 Copy 类型

`Cell<T>` 通过"整体替换"来实现内部可变性，不涉及引用，因此是安全的：

```rust
use std::cell::Cell;

fn main() {
    let x = Cell::new(42);

    // 即使 x 是不可变绑定，也能修改内部值
    x.set(100);
    println!("x = {}", x.get()); // 100

    // Cell 通过值的拷贝来读取，要求 T: Copy
    let val = x.get();
    println!("val = {}", val);
}
```

**Cell 的工作原理：**

- `get()` 返回值的拷贝（要求 T: Copy）
- `set()` 替换内部的值
- 不提供内部数据的引用，从而绕开借用检查
- 零运行时开销

**Cell 在结构体中的使用：**

```rust
use std::cell::Cell;

struct Counter {
    count: Cell<u32>,
}

impl Counter {
    fn new() -> Self {
        Counter { count: Cell::new(0) }
    }

    // 注意：&self 是不可变引用，但仍然可以修改 count
    fn increment(&self) {
        self.count.set(self.count.get() + 1);
    }

    fn get(&self) -> u32 {
        self.count.get()
    }
}

fn main() {
    let counter = Counter::new();
    counter.increment();
    counter.increment();
    counter.increment();
    println!("计数: {}", counter.get()); // 3
}
```

### 5.3 RefCell\<T\>：运行时借用检查

`Cell` 只能用于 Copy 类型。对于 String、Vec 等非 Copy 类型，需要使用 `RefCell<T>`。

`RefCell` 将借用检查从编译期推迟到运行时：

```rust
use std::cell::RefCell;

fn main() {
    let data = RefCell::new(vec![1, 2, 3]);

    // borrow() 返回 Ref<T>，类似 &T
    {
        let borrowed = data.borrow();
        println!("数据: {:?}", borrowed);
    }

    // borrow_mut() 返回 RefMut<T>，类似 &mut T
    {
        let mut borrowed_mut = data.borrow_mut();
        borrowed_mut.push(4);
        println!("修改后: {:?}", borrowed_mut);
    }

    // 运行时违反借用规则会 panic
    // let r1 = data.borrow();
    // let r2 = data.borrow_mut(); // panic! 已有不可变借用时不能可变借用
}
```

### 5.4 Rc\<RefCell\<T\>\>：共享的可变数据

这是 Rust 中最常见的组合模式之一——Rc 提供多重所有权，RefCell 提供内部可变性：

```rust
use std::rc::Rc;
use std::cell::RefCell;

#[derive(Debug)]
struct SharedList {
    data: Rc<RefCell<Vec<String>>>,
}

impl SharedList {
    fn new() -> Self {
        SharedList {
            data: Rc::new(RefCell::new(Vec::new())),
        }
    }

    fn share(&self) -> SharedList {
        SharedList {
            data: Rc::clone(&self.data),
        }
    }

    fn push(&self, item: &str) {
        self.data.borrow_mut().push(item.to_string());
    }

    fn print(&self) {
        println!("{:?}", self.data.borrow());
    }
}

fn main() {
    let list1 = SharedList::new();
    let list2 = list1.share();
    let list3 = list1.share();

    list1.push("来自 list1");
    list2.push("来自 list2");
    list3.push("来自 list3");

    // 三个列表看到的数据完全一样
    list1.print(); // ["来自 list1", "来自 list2", "来自 list3"]
    list2.print(); // ["来自 list1", "来自 list2", "来自 list3"]
}
```

### 5.5 Cell vs RefCell 对比

| 特性 | Cell\<T\> | RefCell\<T\> |
|------|----------|-------------|
| 适用类型 | T: Copy | 任意类型 |
| 借用检查 | 无需（通过值拷贝） | 运行时检查 |
| 获取引用 | 不能（只能 get/set） | 可以（borrow/borrow_mut） |
| Panic 风险 | 无 | 违反借用规则时会 panic |
| 线程安全 | 否 | 否 |
| 性能开销 | 零额外开销 | 维护借用计数 |

### 5.6 Cell 和 RefCell 实现的关键 Trait

**Cell\<T\>：**

| Trait | 说明 |
|-------|------|
| `Send`（当 T: Send时） | 可以发送到其他线程（但不是 Sync） |
| `Clone`（当 T: Copy） | 克隆内部值 |
| `Default`（当 T: Default） | 创建默认值 |
| `PartialEq`（当 T: PartialEq + Copy） | 比较内部值 |
| `From<T>` | 从 T 构造 |

**RefCell\<T\>：**

| Trait | 说明 |
|-------|------|
| `Send`（当 T: Send） | 可以发送到其他线程 |
| `!Sync` | 不能跨线程共享引用 |
| `Clone`（当 T: Clone） | 深拷贝内部数据 |
| `Default`（当 T: Default） | 创建默认值 |
| `From<T>` | 从 T 构造 |

> **注意：Cell 和 RefCell 都没有实现 `Deref`**。它们不是传统意义上的"指向数据"的指针，而是"包装数据"的容器。访问内部数据必须通过 `get()`/`set()` 或 `borrow()`/`borrow_mut()`。

---

## 六、Cow\<T\>：写时克隆

### 6.1 什么是 Cow

`Cow`（Clone on Write）是一个枚举，可以持有借用数据或拥有数据：

```rust
pub enum Cow<'a, B: ?Sized + ToOwned + 'a> {
    Borrowed(&'a B),
    Owned(<B as ToOwned>::Owned),
}
```

核心思想是：**如果只读，就用借用；需要修改时，才克隆一份拥有的副本**。

### 6.2 基本使用

```rust
use std::borrow::Cow;

fn process_name(name: &str) -> Cow<str> {
    if name.contains(' ') {
        // 需要修改，创建新的 String
        let trimmed = name.trim().to_string();
        Cow::Owned(trimmed)
    } else {
        // 不需要修改，直接借用
        Cow::Borrowed(name)
    }
}

fn main() {
    let name1 = process_name("Rust");        // Borrowed，零拷贝
    let name2 = process_name(" Rust Lang "); // Owned，发生了克隆

    println!("{}", name1); // Rust
    println!("{}", name2); // Rust Lang

    // Cow 实现了 Deref，可以直接当 &str 用
    let len: usize = name1.len();
    println!("长度: {}", len);
}
```

### 6.3 Cow 配合 to_mut 实现延迟克隆

```rust
use std::borrow::Cow;

fn ensure_uppercase(input: &str) -> Cow<str> {
    if input.chars().all(|c| c.is_uppercase() || !c.is_alphabetic()) {
        Cow::Borrowed(input)
    } else {
        Cow::Owned(input.to_uppercase())
    }
}

fn main() {
    let s1 = ensure_uppercase("HELLO");     // 不克隆
    let s2 = ensure_uppercase("hello");     // 克隆

    match &s1 {
        Cow::Borrowed(_) => println!("s1 是借用的"),
        Cow::Owned(_) => println!("s1 是拥有的"),
    }
    match &s2 {
        Cow::Borrowed(_) => println!("s2 是借用的"),
        Cow::Owned(_) => println!("s2 是拥有的"),
    }
}
// 输出：
// s1 是借用的
// s2 是拥有的
```

### 6.4 Cow 实现的关键 Trait

| Trait | 说明 |
|-------|------|
| `Deref<Target=B>` | 无论 Borrowed 还是 Owned 都能当 &B 用 |
| `Clone` | 克隆底层数据 |
| `Display`（当 B: Display） | 委托给内部数据 |
| `Eq`, `Ord`, `Hash` 等 | 委托给内部数据 |
| `From<&'a B>` | 创建 Borrowed 变体 |
| `From<Owned>` | 创建 Owned 变体 |
| `AsRef<B>` | 转换为 &B |

---

## 七、Pin\<T\>：固定内存位置

### 7.1 为什么需要 Pin

Rust 中的大部分类型都可以安全地在内存中移动。但某些类型包含自引用结构（一个字段指向自身的另一个字段），移动后内部指针会失效。

`async/await` 是 Pin 最重要的使用场景——编译器生成的 Future 可能包含自引用。

### 7.2 Unpin 和 !Unpin

- 实现了 `Unpin` 的类型可以自由移动（几乎所有类型默认实现 Unpin）
- `!Unpin` 的类型被 Pin 后不能移动

```rust
use std::pin::Pin;
use std::marker::PhantomPinned;

struct SelfRef {
    data: String,
    ptr: *const String, // 指向 data 的裸指针
    _pin: PhantomPinned, // 标记为 !Unpin
}

impl SelfRef {
    fn new(data: &str) -> Pin<Box<Self>> {
        let s = SelfRef {
            data: data.to_string(),
            ptr: std::ptr::null(),
            _pin: PhantomPinned,
        };
        let mut boxed = Box::pin(s);

        // 安全地设置自引用指针
        let self_ptr: *const String = &boxed.data;
        unsafe {
            let mut_ref = Pin::as_mut(&mut boxed);
            Pin::get_unchecked_mut(mut_ref).ptr = self_ptr;
        }

        boxed
    }

    fn get_data(&self) -> &str {
        &self.data
    }

    fn get_ptr_data(&self) -> &str {
        unsafe { &*self.ptr }
    }
}

fn main() {
    let pinned = SelfRef::new("hello");
    println!("data: {}", pinned.get_data());
    println!("ptr -> data: {}", pinned.get_ptr_data());

    // 以下操作无法编译，因为 SelfRef 是 !Unpin：
    // let moved = *pinned; // 错误!
}
```

### 7.3 Pin 在 async 中的作用

```rust
use std::pin::Pin;
use std::future::Future;

// Future trait 的定义要求 &mut self 被 Pin 包裹
// pub trait Future {
//     type Output;
//     fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>;
// }

async fn example() -> i32 {
    let x = 42;
    // await 点之间可能产生自引用
    some_async_fn().await;
    x // x 的引用必须在 await 之后依然有效
}

async fn some_async_fn() {}

fn use_future(fut: Pin<Box<dyn Future<Output = i32>>>) {
    // fut 被固定在内存中，不会被移动
    // 这保证了 Future 内部的自引用是安全的
    let _ = fut;
}
```

### 7.4 Pin 实现的关键 Trait

| Trait | 说明 |
|-------|------|
| `Deref<Target=T>`（当 P: Deref） | Pin\<P\> 可以解引用访问底层数据 |
| `DerefMut`（当 P: DerefMut, T: Unpin） | 只有 Unpin 类型才能获取 &mut T |
| `Display`, `Debug` 等 | 委托给内部指针 |
| `Future`（当 P: DerefMut, P::Target: Future） | Pin\<Box\<dyn Future\>\> 本身就是 Future |

---

## 八、自定义智能指针

了解了 Deref 和 Drop 之后，我们可以实现自己的智能指针。下面实现一个简单的带日志的 Box：

```rust
use std::ops::{Deref, DerefMut};
use std::fmt;

struct LogBox<T: fmt::Debug> {
    name: String,
    data: Box<T>,
}

impl<T: fmt::Debug> LogBox<T> {
    fn new(name: &str, data: T) -> Self {
        println!("[{}] 创建，值为 {:?}", name, data);
        LogBox {
            name: name.to_string(),
            data: Box::new(data),
        }
    }
}

impl<T: fmt::Debug> Deref for LogBox<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.data
    }
}

impl<T: fmt::Debug> DerefMut for LogBox<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.data
    }
}

impl<T: fmt::Debug> Drop for LogBox<T> {
    fn drop(&mut self) {
        println!("[{}] 释放，最终值为 {:?}", self.name, self.data);
    }
}

fn main() {
    let mut x = LogBox::new("计数器", 0i32);

    *x += 1;
    *x += 1;
    *x += 1;

    println!("当前值: {}", *x);

    // 自动解引用：直接调用 i32 的方法
    println!("绝对值: {}", x.abs());
}

// 输出：
// [计数器] 创建，值为 0
// 当前值: 3
// 绝对值: 3
// [计数器] 释放，最终值为 3
```

---

## 九、智能指针 Trait 实现总览

下面汇总所有主要智能指针实现的 trait：

| Trait | Box\<T\> | Rc\<T\> | Arc\<T\> | Cell\<T\> | RefCell\<T\> | Cow\<B\> | Pin\<P\> |
|-------|---------|---------|----------|----------|-------------|---------|---------|
| Deref | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| DerefMut | ✅ | ❌ | ❌ | ❌ | ❌ | ❌* | ✅** |
| Drop | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Clone | ✅*** | ✅ | ✅ | ✅**** | ✅**** | ✅ | ✅ |
| Send | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sync | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Display | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Debug | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| AsRef\<T\> | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| From\<T\> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

说明：
- \* Cow 的 `to_mut()` 方法可以获取 `&mut`，但不是通过 DerefMut trait
- \** Pin\<P\> 只在 T: Unpin 时实现 DerefMut
- \*** Box::clone 是深拷贝（当 T: Clone）
- \**** 需要 T: Copy（Cell）或 T: Clone（RefCell）

---

## 十、如何选择智能指针

根据场景选择合适的智能指针：

```
需要堆分配？
├── 是，且只有一个所有者 ─────────> Box<T>
├── 是，且需要多个所有者
│   ├── 单线程 ──────────────────> Rc<T>
│   └── 多线程 ──────────────────> Arc<T>
└── 不需要堆分配

需要内部可变性？
├── T 是 Copy 类型 ──────────────> Cell<T>
├── T 不是 Copy 类型（单线程）───> RefCell<T>
└── 多线程 ──────────────────────> Mutex<T> / RwLock<T>

需要共享 + 可变？
├── 单线程 ──────────────────────> Rc<RefCell<T>>
└── 多线程 ──────────────────────> Arc<Mutex<T>>

有时候只读有时候需要修改？──────> Cow<T>

需要固定内存位置（async）？─────> Pin<Box<T>>
```

---

## 十一、常见误区与最佳实践

### 误区一：到处用 Rc\<RefCell\<T\>\>

有些从 GC 语言转来的开发者会把 `Rc<RefCell<T>>` 当成万能方案。这样做的问题是：

- 把编译期检查推迟到了运行时
- RefCell 违反借用规则时直接 panic
- 失去了 Rust 最大的优势

**推荐做法：** 先尝试用所有权和借用解决问题，只在确实需要共享可变性时才使用 `Rc<RefCell<T>>`。

### 误区二：用 Box 包装所有东西

```rust
// 不推荐
fn process(data: Box<Vec<i32>>) { ... }

// 推荐：Vec 本身已经在堆上分配了数据
fn process(data: Vec<i32>) { ... }
// 或者只是借用
fn process(data: &[i32]) { ... }
```

### 误区三：混淆 Rc::clone 和深拷贝

```rust
use std::rc::Rc;

let a = Rc::new(vec![1, 2, 3]);
let b = Rc::clone(&a);  // 只增加引用计数，a 和 b 指向同一数据
let c = (*a).clone();    // 深拷贝：c 是一个全新的 Vec<i32>
```

### 最佳实践总结

1. **默认用栈**：除非有明确需求，不要用 Box
2. **优先编译时检查**：尽量避免 RefCell，让编译器帮你抓 bug
3. **单线程用 Rc，多线程用 Arc**：不要在单线程中使用 Arc（有不必要的原子操作开销）
4. **用 Cow 优化频繁的条件克隆**：减少不必要的内存分配
5. **使用 Weak 打破循环引用**：任何图状数据结构都应考虑 Weak

---

## 总结

Rust 的智能指针体系是围绕所有权、借用、生命周期这三大核心概念构建的。每种智能指针都在解决特定的问题：

| 智能指针 | 核心能力 | 关键限制 |
|---------|---------|---------|
| `Box<T>` | 堆分配 + 唯一所有权 | 单一所有者 |
| `Rc<T>` | 共享所有权（引用计数） | 单线程、不可变 |
| `Arc<T>` | 线程安全的共享所有权 | 不可变（需配合 Mutex） |
| `Cell<T>` | 内部可变性（Copy 类型） | T 必须是 Copy |
| `RefCell<T>` | 内部可变性（运行时检查） | 可能 panic |
| `Cow<B>` | 写时克隆 | 需要 ToOwned |
| `Pin<P>` | 固定内存位置 | 主要用于 async |

理解智能指针的关键：

1. **Deref** 让智能指针透明地行为如引用，支持自动解引用转换
2. **Drop** 确保资源正确释放，实现 RAII
3. 选择智能指针的依据是**所有权语义**和**线程安全需求**

当你不确定该用哪种智能指针时，回到最基本的问题：**谁拥有这份数据？有多少人需要访问它？需要跨线程吗？需要修改吗？**

答案自然就出来了。
