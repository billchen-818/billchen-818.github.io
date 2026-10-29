---
title: Rust Pin 与 Unpin 彻底讲清楚：异步底层为什么离不开它们
date: 2026-05-28 12:59:31
tags: Rust
---

很多人第一次接触 `Pin` 和 `Unpin`，都会有一种非常强烈的感受：

> 这东西看起来像 Rust 里最不讲人话的一块。

原因也很现实。

因为你刚看到它们时，通常会同时碰到这些词：

- Future
- 自引用
- 地址稳定
- `Pin<&mut T>`
- `Pin<Box<T>>`
- `PhantomPinned`

如果只是背定义，很容易越看越碎：

- `Pin` 到底在 pin 什么
- 为什么 `Pin` 不是“把值锁死不能改”
- 为什么有些类型默认就是 `Unpin`
- 为什么 async/await 底层会和这套机制强相关
- 为什么很多地方看起来像普通引用，一加 `Pin` 就完全变味了

这说明：

> Pin/Unpin 的真正难点，不在 API，而在于你是否先理解“移动一个值”到底会破坏什么。

这一篇我会围绕下面几个问题展开：

1. 值被移动到底意味着什么
2. 为什么有些类型必须保证地址稳定
3. `Pin` 和 `Unpin` 分别在表达什么约束
4. 为什么 Future 底层离不开它们

文中的完整示例工程在 `workspaces/pin-demo`。

---

## 一、先说结论：`Pin` 约束的是“位置不能再变”，不是“值不能改”

很多人第一次看到 `Pin`，会本能地把它理解成：

> 这个值被固定住了，所以不能修改。

这个理解不准确。

`Pin` 真正想表达的是：

> 这个值一旦进入某种 pinned 状态，就不应该再被移动到别的内存位置。

注意这里的重点是“不能再移动”，不是“不能再修改内部字段”。

只要不破坏 pinning 约束，很多 pinned 值仍然可以修改内部内容。

所以理解 `Pin` 的第一步不是去记方法名，而是先把这两个概念分开：

- 修改一个值的内容
- 移动一个值在内存中的位置

这两件事不是一回事。

---

## 二、Rust 里“移动一个值”到底是什么意思？

Rust 里说 move，很多人第一反应是“所有权转移”。

这没错，但如果讨论 `Pin`，还要再多看一层：

> 一个值被 move 到新变量、新容器或者新位置时，它在内存中的实际地址可能发生变化。

这对大多数普通类型根本不是问题。

例如：

- `u64`
- `String`
- 普通结构体

它们通常并不依赖“我必须永远待在某个固定地址上”。

所以即使值被移动，只要所有权和借用规则没被破坏，程序依然是安全的。

但问题在于：

> 不是所有类型都能无视“地址变化”这件事。

---

## 三、什么类型会真的在乎“自己是不是被移动了”？

最典型的，就是带有“自引用关系”的值。

什么意思？

就是一个值内部的某部分，持有了指向它自己另一部分的引用或指针。

一旦这个值整体被搬家，内部原先记录的地址关系就可能失效。

这正是 `Pin` 存在的根本背景。

### 3.1 一个最小直觉示例

看示例工程 `workspaces/pin-demo/src/main.rs` 里的这个结构：

```rust
struct MovableBuffer {
    text: String,
    text_ptr: *const String,
}
```

它有两个字段：

- 一个真实数据 `text`
- 一个保存 `text` 地址的裸指针 `text_ptr`

然后初始化指针：

```rust
fn init(&mut self) {
    self.text_ptr = &self.text;
}
```

接着我们先报告一次地址，再把整个值 move 到另一个变量里：

```rust
let mut movable = MovableBuffer::new("hello");
movable.init();
movable.report("movable before move");
let moved = movable;
moved.report("movable after move");
```

运行结果可以看到类似输出：

```text
movable before move: field addr=0x..., stored addr=0x..., same=true
movable after move: field addr=0x..., stored addr=0x..., same=false
```

这里最值得注意的是最后那个 `same=false`。

它意味着：

- `text` 字段的新地址已经变了
- 但 `text_ptr` 里记录的仍然是旧地址

也就是说，值一旦移动，内部依赖旧地址的关系就坏掉了。

这就是 `Pin` 要解决的问题模型。

### 3.2 一个很重要的提醒

这里我没有去解引用那个过期指针。

因为一旦真的拿它当有效引用使用，就会进入未定义行为风险。

这个示例只是为了帮助你建立“地址关系会失效”的直觉，而不是鼓励你去写自引用裸指针代码。

---

## 四、那为什么大多数类型又默认都没事？

因为大多数类型都实现了 `Unpin`。

你可以先把 `Unpin` 理解成这样一句话：

> 这个类型即使处在 pinned 场景里，也不真的依赖地址稳定性，所以依然可以按普通方式移动。

也就是说：

- `Pin` 是“位置稳定性约束”的容器语义
- `Unpin` 是“这个类型其实不需要这层约束”的类型语义

Rust 标准库里的大多数普通类型都是 `Unpin`。

这就是为什么你在很多地方看见 `Pin<T>`，却又感觉“好像也没发生什么特别的限制”。

因为如果底层类型本来就是 `Unpin`，那 pinning 基本就退化成普通借用或普通拥有包装。

示例里的最后一行就是这个意思：

```rust
let number = 10_u64;
let pinned_number = Pin::new(&number);
println!("u64 is Unpin, pinned value = {}", pinned_number.get_ref());
```

`u64` 本来就不在乎地址稳定性，所以把它“pin”起来，本质上没增加什么特殊约束。

---

## 五、那什么情况下一个类型会变成 `!Unpin`？

如果一个类型真的依赖“自己不能再被移动”，那它就不应该自动实现 `Unpin`。

示例里用的是：

```rust
struct PinnedBuffer {
    text: String,
    text_ptr: *const String,
    _pin: PhantomPinned,
}
```

这里的关键是 `PhantomPinned`。

它的作用不是存数据，而是告诉编译器：

> 这个类型不要自动当成 `Unpin`。

一旦类型不是 `Unpin`，你就不能再把它当成“随便 move 也无所谓”的普通值来对待。

这时候 `Pin` 才真正开始有意义。

---

## 六、`Pin<Box<T>>` 和 `Pin<&mut T>` 到底是什么关系？

这块也是很多人第一次会混的地方。

先记结论：

- `Pin<Box<T>>` 常用于“拥有一个被 pin 的值”
- `Pin<&mut T>` 常用于“临时以 pinned 方式借用这个值”

示例里是这样创建 pinned 值的：

```rust
let mut pinned = Box::pin(PinnedBuffer::new("pinned hello"));
```

这里 `Box::pin` 的作用可以理解成：

1. 先把值放到堆上
2. 再返回一个承诺“这个值不再被移动”的 pinned box

后面初始化内部指针时，用的是：

```rust
pinned.as_mut().init();
```

这里的 `as_mut()` 给你的是一个 `Pin<&mut PinnedBuffer>`。

也就是说：

- `Pin<Box<T>>` 负责拥有这个 pinned 值
- `Pin<&mut T>` 负责在后续方法里以 pinned 视角操作它

这个层次分清以后，很多 API 就容易看懂了。

---

## 七、为什么 `init(self: Pin<&mut Self>)` 这种签名这么常见？

示例里的初始化方法是：

```rust
fn init(self: Pin<&mut Self>) {
    let this = unsafe { self.get_unchecked_mut() };
    this.text_ptr = &this.text;
}
```

很多人第一次看到这种写法会疑惑：

- 为什么不能直接写 `&mut self`
- 为什么又突然冒出了 `unsafe`

这里要分两层看。

### 7.1 为什么方法参数要写成 `Pin<&mut Self>`

因为这个方法的语义不是“普通可变借用”，而是：

> 调用这个方法时，调用者必须保证这个值已经处于 pinned 状态。

只有这样，方法内部才敢基于“地址已经稳定”这个前提去建立自引用关系。

### 7.2 为什么这里会出现 `unsafe`

因为编译器无法自动替你证明：

- 你接下来对内部字段的操作不会破坏 pinning 不变量

`Pin` 本身的设计就是：

- 安全 API 尽量限制危险操作
- 真要越过某些边界，必须显式进入 `unsafe`

这里的 `unsafe { self.get_unchecked_mut() }` 不是说“Pin 不安全”，而是在表达：

> 我现在作为类型作者，手动承诺这一步没有破坏 pinning 约束。

这也是 `Pin` 这套设计比较难、但也比较严谨的地方。

---

## 八、那 Future 为什么和 Pin/Unpin 强相关？

这部分是整篇文章最重要的落点。

很多人知道异步代码底层是 Future，但不知道为什么 `Future::poll` 长这样：

```rust
fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output>
```

为什么不是普通的 `&mut self`？

根本原因就在于：

> async fn 编译后的状态机，内部可能持有指向自己内部状态的引用关系。

也就是说，Future 在被 poll 的过程中，可能已经变成一种“地址稳定性有意义”的值。

如果这时候你还能随便移动它，就有可能破坏这些内部关系。

所以 `poll` 要求的不是普通可变借用，而是：

> 一个 pinned 的可变借用。

这样 Future 实现者和执行器才能建立一个共同前提：

- 只要这个 Future 开始被安全地 poll，它的地址就不应该再乱变

这就是为什么很多人说：

> Pin/Unpin 不是为了“某个冷门 API”存在的，而是 async/await 底层运行模型的重要一部分。

---

## 九、为什么说 `Pin` 不是给“普通业务对象”乱用的？

很多人学到这里，会有一种冲动：

> 那我以后是不是应该多用 `Pin`，这样更安全？

通常不是。

因为 `Pin` 解决的是一个非常具体的问题：

- 某个值真的依赖地址稳定性

如果你的类型本来就不依赖这个约束，那引入 `Pin` 只会增加理解和 API 成本。

所以在工程里，更合理的态度通常是：

### 9.1 对普通业务类型，不要主动引入 `Pin`

大多数业务结构体：

- 配置对象
- DTO
- 普通领域模型
- 一般服务状态

都不需要 pinning 语义。

### 9.2 对异步底层、自引用结构、侵入式数据结构等场景，再认真处理 `Pin`

这类场景里，`Pin` 才是真正的工具，而不是概念负担。

---

## 十、完整示例：一个最小的 Pin/Unpin 地址稳定性 demo

示例工程 `workspaces/pin-demo` 里放了三段最关键的对照：

1. 可移动值在 move 前后地址关系变化 `workspaces/pin-demo/src/main.rs`
2. `Pin<Box<T>>` 下地址保持稳定 `workspaces/pin-demo/src/main.rs`
3. `u64` 这类 `Unpin` 类型的 pinning 几乎没有额外效果 `workspaces/pin-demo/src/main.rs`

它不是一个完整异步 runtime 示例，但它把最难的核心前提讲清楚了：

- 普通值可以被移动
- 某些值一旦依赖地址关系，就不能再随便移动
- `Pin` 负责约束“不能再挪位置”
- `Unpin` 负责说明“这个类型其实不依赖这层约束”

---

## 十一、实际运行结果

在 `workspaces/pin-demo` 下执行：

```bash
cargo run
```

当前示例会输出类似结果：

```text
movable before move: field addr=0x..., stored addr=0x..., same=true
movable after move: field addr=0x..., stored addr=0x..., same=false
pinned after init: field addr=0x..., stored addr=0x..., same=true
u64 is Unpin, pinned value = 10
```

这组输出主要说明三件事：

- 普通值 move 后，内部保存的旧地址关系会失效
- pinned 值在建立地址关系后可以保持稳定
- `Unpin` 类型即使被放进 `Pin` 里，也不会真的产生额外的移动约束意义

---

## 十二、我对 Pin/Unpin 的几个判断

这部分是我自己的经验总结。

### 12.1 先理解“为什么移动会出问题”，再去看 API

如果前提没想清楚，`Pin` 的方法名和类型签名会显得非常绕。

### 12.2 `Pin` 约束的是位置，不是可变性

这是最容易被误解的地方。

### 12.3 `Unpin` 的意义不是“更高级”，而是“这个类型根本不需要地址稳定性约束”

所以大多数普通类型都是 `Unpin`，这反而是常态。

### 12.4 Future 和 Pin 的关系，不是语法巧合，而是状态机地址稳定性的需要

一旦你理解了这点，再回头看 `poll(self: Pin<&mut Self>, ...)` 就顺很多。

### 12.5 `Pin` 适合解决特定底层问题，不适合作为通用业务建模工具

不要因为它“高级”就到处引入。

---

## 结语

Pin/Unpin 这套机制之所以难，不是因为它概念很多，而是因为它要求你把“值移动”“地址稳定”“内部引用关系”这几个原本经常被忽略的层次同时想清楚。

一旦这个前提建立起来，很多原本看起来抽象的签名都会突然变得合理：

- 为什么 `Pin<&mut T>` 和 `&mut T` 不是一回事
- 为什么 `Unpin` 类型会让 pinning 看起来像没发生什么
- 为什么 async/await 底层会依赖这套语义

所以这篇文章如果只留一句建议，我会写这句：

> 不要把 `Pin` 理解成“不能改”，要把它理解成“不能再随便挪位置”。

这句想通了，后面的很多细节都会顺下来。