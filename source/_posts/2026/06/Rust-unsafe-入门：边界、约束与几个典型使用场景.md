---
title: Rust unsafe 入门：边界、约束与几个典型使用场景
date: 2026-06-03 08:09:12
tags: Rust
---

很多人对 Rust `unsafe` 的第一印象是：

> 这是一个关闭安全检查的开关，用了之后程序就可能崩溃。

这个理解有一半对，有一半不对。

`unsafe` 确实意味着"编译器不再帮你检查某些事情"，但它不是"关掉所有保护"。

更准确的理解是：

> `unsafe` 是一份协议。它告诉编译器："这里有一些你无法验证的约束，我来负责保证它们成立。"

所以 `unsafe` 的本质不是"危险代码"，而是"责任转移"。

这一篇我想围绕几个问题把 `unsafe` 讲清楚：

1. `unsafe` 到底解锁了哪几项能力
2. 为什么 Rust 需要这个机制
3. 如何正确使用 `unsafe`：不是"别用"，而是"怎么用对"
4. 几个典型使用场景，配完整可运行示例

文中的完整示例工程在 `workspaces/unsafe-demo`。

---

## 一、先说结论：`unsafe` 只解锁五项能力

Rust 的 `unsafe` 并不是一个开关，把所有安全检查都关掉。

它只额外允许你做五件事：

1. **解引用裸指针**（`*const T` / `*mut T`）
2. **调用 `unsafe` 函数或方法**（包括 C FFI）
3. **访问或修改 `static mut` 全局变量**
4. **实现 `unsafe trait`**（比如手动实现 `Send` / `Sync`）
5. **在 `union` 中访问字段**

除了这五项之外，`unsafe` 块里的代码和普通代码没有任何区别：

- 借用检查仍然生效（除非你用裸指针绕过）
- 类型系统仍然工作
- 生命周期推断仍然运行

所以这五项能力是精确的、有限的，不是"什么都可以做"。

---

## 二、为什么 Rust 需要 `unsafe`？

Rust 的借用检查器非常强大，但它的能力有一个边界：

> 它只能证明"在给定的规则下是安全的"，无法证明"在更广泛的不变量下也是安全的"。

有些操作，安全性依赖于某些**程序员知道、但编译器无法验证**的前提条件。

几个典型的例子：

**裸指针解引用**

```rust
let x = 42;
let ptr: *const i32 = &x;
unsafe { println!("{}", *ptr); }
```

编译器不知道 `ptr` 是否有效、是否对齐、是否已经悬空。这些性质取决于运行时状态，静态分析无法判断。你必须自己保证这些条件成立，然后用 `unsafe` 声明这个事实。

**FFI 调用**

```rust
unsafe extern "C" {
    fn abs(x: i32) -> i32;
}
```

外部 C 函数的行为是 Rust 编译器无法知道的。类型签名是你声明的，而不是从 C 代码里自动推导出来的。它是否真的存在、是否真的有这个签名，编译器无法验证。

**`static mut` 全局变量**

全局可变状态在多线程环境下会有数据竞争。编译器无法在静态分析阶段确定你是否真的在单线程里用它。

**手动实现 `Send` / `Sync`**

`Send` 和 `Sync` 是 `unsafe trait`，它们的含义是一个关于线程安全的承诺。编译器没有办法检查这个承诺是否成立，只能靠程序员来保证。

---

## 三、`unsafe` 的正确使用方式：封装，不是暴露

`unsafe` 最重要的使用原则是：

> **把 `unsafe` 封装在安全的接口后面，而不是直接暴露给调用方。**

这是 Rust 标准库处理 `unsafe` 的核心策略，也是大部分优秀库的通行做法。

具体来说：

- 模块或函数的**公开接口**应该是安全的
- `unsafe` 的具体操作藏在实现内部
- 实现内部必须维护"安全不变量"（Safety Invariant）
- 每个 `unsafe` 块旁边应该有注释，解释**为什么**这样做是安全的

举一个最简单的例子。

如果你直接把裸指针暴露给调用方：

```rust
// 危险：调用方可以任意解引用，没有任何保证
pub fn get_raw_ptr(v: &Vec<i32>) -> *const i32 {
    v.as_ptr()
}
```

那安全性就完全依赖于调用方能不能正确使用裸指针，这是不可维护的。

但如果你把裸指针操作封装起来，只暴露安全的接口：

```rust
pub struct MySlice<'a, T> {
    ptr: *const T,
    len: usize,
    _marker: std::marker::PhantomData<&'a T>,
}

impl<'a, T> MySlice<'a, T> {
    pub fn from_slice(s: &'a [T]) -> Self {
        MySlice { ptr: s.as_ptr(), len: s.len(), _marker: std::marker::PhantomData }
    }

    pub fn get(&self, index: usize) -> Option<&T> {
        if index >= self.len {
            return None;
        }
        // Safety: index < self.len，ptr 指向有效的对齐内存，
        // 生命周期由 PhantomData 绑定到 'a
        unsafe { Some(&*self.ptr.add(index)) }
    }
}
```

现在 `get` 是完全安全的：

- 超出范围会返回 `None`，不会越界
- 生命周期由编译器保证，不会悬空
- 调用方完全不需要关心内部有 `unsafe`

这就是"封装 `unsafe`"的意义。

---

## 四、五项能力逐一讲解

### 4.1 解引用裸指针

裸指针是 Rust 里唯一不受借用规则约束的指针类型。

**创建**裸指针是安全的，因为你还没有使用它：

```rust
let x = 42_i32;
let ptr_const: *const i32 = &x;          // 从共享引用创建
let ptr_mut: *mut i32 = &mut y;          // 从可变引用创建
let ptr_dangling = 0x1234usize as *const i32;  // 直接从地址创建，潜在危险
```

**解引用**裸指针才需要 `unsafe`，因为此时编译器无法保证它有效：

```rust
unsafe {
    println!("{}", *ptr_const);  // 必须自己保证 ptr_const 有效、对齐、不悬空
}
```

裸指针还允许你绕过借用规则，同时持有多个可变指针：

```rust
let mut val = 100_i32;
let p1: *mut i32 = &mut val;
let p2: *mut i32 = &mut val;  // 编译器不阻止

unsafe {
    *p1 = 200;
    println!("{}", *p2);  // 200，同一块内存
}
```

这在 Rust 普通代码里是不允许的（不能同时有两个 `&mut val`），但裸指针可以。这也是它危险的地方：使用不当会导致数据竞争或未定义行为。

**指针算术**也是裸指针的典型用法：

```rust
let data: [i32; 5] = [10, 20, 30, 40, 50];
let ptr: *const i32 = data.as_ptr();

unsafe {
    for i in 0..5_usize {
        println!("data[{}] = {}", i, *ptr.add(i));
    }
}
```

`ptr.add(i)` 把指针向后移动 `i * sizeof(i32)` 个字节。这是标准库内部遍历内存的常见模式。

完整代码见 `workspaces/unsafe-demo/src/main.rs`。

### 4.2 调用 `unsafe` 函数

声明为 `unsafe fn` 的函数，要求调用方在调用时承诺满足该函数的前提条件（precondition）。

最简单的例子：

```rust
// Safety 文档：调用方必须保证 ptr 非空、对齐、且指向有效的 i32
unsafe fn read_unchecked(ptr: *const i32) -> i32 {
    unsafe { *ptr }
}
```

在 `unsafe` 块里调用它：

```rust
let x: i32 = 777;
let result = unsafe { read_unchecked(&x as *const i32) };
println!("{}", result);  // 777
```

标准库里有大量这类函数，最常见的是跳过检查的快速路径版本：

```rust
// 有检查版本（安全）
let s = std::str::from_utf8(bytes)?;

// 无检查版本（unsafe），调用方保证 bytes 是合法 UTF-8
let s = unsafe { std::str::from_utf8_unchecked(bytes) };
```

`from_utf8_unchecked` 在字节序列确实是有效 UTF-8 的前提下，省去了 O(n) 的检查开销。标准库用它来优化热路径。

### 4.3 FFI（外部函数接口）

调用 C 函数是 `unsafe` 最常见的使用场景之一：

```rust
unsafe extern "C" {
    fn abs(x: i32) -> i32;
}

fn main() {
    let result = unsafe { abs(-42) };
    println!("{}", result);  // 42
}
```

为什么是 `unsafe`？

因为 C 函数的行为、调用约定、内存布局，Rust 编译器全都无法验证。`unsafe extern "C"` 这个声明是你对编译器的承诺：

> 我知道这个函数存在，它的签名就是这样，它的行为符合我的预期。

这个承诺如果错了，后果由你负责。

### 4.4 `unsafe trait` 与 `unsafe impl`

有些 trait 的实现本身携带了某种"无法被编译器自动验证的契约"。

最典型的就是 `Send` 和 `Sync`。

```rust
// Send 和 Sync 在标准库里是这样定义的：
pub unsafe auto trait Send { }
pub unsafe auto trait Sync { }
```

`unsafe trait` 意味着：实现这个 trait 的代码，必须手动保证某个编译器无法检查的约束。

比如，假设你有一个包含裸指针的类型，默认不是 `Send`，但你确定它的使用模式是线程安全的：

```rust
pub struct RawBuffer {
    ptr: *mut u8,
    len: usize,
}

// Safety: RawBuffer 独占其内存，不与任何其他所有者共享
unsafe impl Send for RawBuffer {}

// Safety: as_slice() 只提供只读访问，多线程同时读取是安全的
unsafe impl Sync for RawBuffer {}
```

写了 `unsafe impl Send` 之后，这个类型就可以跨线程传递：

```rust
let buf = RawBuffer::new(8);
std::thread::spawn(move || {
    println!("{:?}", buf.as_slice());
}).join().unwrap();
```

如果没有 `unsafe impl Send`，上面的 `spawn` 会编译报错。

### 4.5 访问 `static mut`

全局可变状态需要在 `unsafe` 里访问：

```rust
static mut COUNTER: u64 = 0;

unsafe {
    COUNTER += 1;
    let val = std::ptr::addr_of!(COUNTER).read();
    println!("{}", val);
}
```

为什么危险？

因为 `static mut` 在整个程序生命周期里都存在，如果多个线程同时访问，就会出现数据竞争（这是未定义行为）。编译器静态分析阶段无法知道你是否真的在单线程环境里使用它。

**实践建议**：绝大多数时候，应该用 `AtomicU64` 或 `Mutex<u64>` 替代 `static mut`。`static mut` 只适合确实不需要并发保护的极少数场景（比如嵌入式中断处理程序里的单核状态）。

---

## 五、最重要的实践：写 Safety 注释

每一个 `unsafe` 块或 `unsafe fn`，旁边都应该有一段注释，解释**为什么这里是安全的**。

这不仅仅是风格问题，而是工程必须。原因有三：

**强迫你自己想清楚**

写注释的过程会逼你明确：我依赖的前提条件是什么，这些条件是否真的成立。

**让后来的人能审查**

三个月后，别人（或者你自己）再来看这段代码，需要知道当初写这个 `unsafe` 的依据是什么，才能判断后续修改有没有破坏这个前提。

**帮助找 Bug**

很多 `unsafe` 相关的 bug，正是因为某个隐含的前提被后来的代码修改给打破了。有了 Safety 注释，就有了检查点。

通行的格式是在 `unsafe` 块上方写 `// Safety:` 开头的注释：

```rust
pub fn get(&self, index: usize) -> Option<&T> {
    if index >= self.len {
        return None;
    }
    // Safety: 上方已经做了边界检查，index < self.len；
    // self.ptr 在整个生命周期内有效；
    // PhantomData<&'a T> 保证返回引用的生命周期不超过 self
    unsafe { Some(&*self.ptr.add(index)) }
}
```

---

## 六、典型使用场景

### 6.1 实现自定义数据结构（手动内存管理）

标准库里的 `Vec`、`HashMap`、`String` 内部都大量使用了 `unsafe`。这是因为高性能的数据结构往往需要直接操控内存布局，而这超出了借用检查器的能力范围。

示例工程里有一个简化版的 `MyVec<T>`，演示了核心思路：

```rust
pub struct MyVec<T> {
    ptr: *mut T,
    len: usize,
    cap: usize,
}

impl<T> MyVec<T> {
    pub fn push(&mut self, value: T) {
        if self.len == self.cap {
            self.grow();  // 内部用 alloc/realloc，全部 unsafe
        }
        // Safety: grow() 保证 self.len < self.cap，
        // ptr.add(self.len) 在分配范围内
        unsafe {
            self.ptr.add(self.len).write(value);
        }
        self.len += 1;
    }

    pub fn get(&self, index: usize) -> Option<&T> {
        if index >= self.len { return None; }
        // Safety: index < self.len，ptr 有效，生命周期绑定 &self
        unsafe { Some(&*self.ptr.add(index)) }
    }
}
```

关键点：

- `push` 和 `get` 都是**安全的公开接口**
- `unsafe` 在内部，调用方完全感知不到
- 每个 `unsafe` 块旁边都有明确的 Safety 注释

完整实现包括 `grow`、`Drop`、`Send`/`Sync` 标记，见 `workspaces/unsafe-demo/src/main.rs`。

### 6.2 封装裸指针切片

`std::slice::from_raw_parts` 是另一个常见场景：把一段裸内存变成 Rust 切片。

```rust
pub fn as_slice(&self) -> &[u8] {
    // Safety: ptr 由 Vec::as_mut_ptr() 分配，len 与分配大小匹配，
    // 生命周期绑定到 &self，不会悬空
    unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
}
```

这是 FFI 接收 C 数组时非常常见的用法：C 函数返回一个指针和长度，Rust 侧把它包装成安全的切片。

### 6.3 FFI 与 C 库集成

调用 C 标准库、系统调用，或者集成第三方 C 库，都需要 `unsafe extern "C"`：

```rust
unsafe extern "C" {
    fn abs(x: i32) -> i32;
}

let result = unsafe { abs(-42) };  // 42
```

大型 C 库的 FFI 绑定（如 `openssl-sys`、`libz-sys`）通常都是一层薄薄的 `unsafe` 声明，然后在上面再建一层安全的 Rust API。

### 6.4 手动实现 `Send` / `Sync`

当你的类型包含裸指针、或者包裹了 `*-sys` 类型时，编译器会因为裸指针不是 `Send` 而拒绝让你的类型跨线程。

如果你能保证并发安全性（比如通过外部同步、独占所有权、只读访问等），就可以手动标记：

```rust
// Safety: 独占所有权，不与其他线程共享内存
unsafe impl Send for MyBuffer {}

// Safety: 只提供不可变引用的只读视图
unsafe impl Sync for MyBuffer {}
```

这是异步运行时、网络库、嵌入式框架里的常见做法。

### 6.5 `std::mem` 系列工具

`std::mem` 模块里有几个 `unsafe` 工具值得了解：

```rust
// forget：放弃 drop，把内存管理权交出去（不是 unsafe，但要谨慎）
std::mem::forget(value);

// transmute：把一个类型强制重新解释为另一种类型（非常危险）
// Safety: 两种类型的内存布局必须完全兼容
let bytes: [u8; 4] = unsafe { std::mem::transmute(42_u32) };

// zeroed：分配零内存（主要用于 FFI，调用方必须保证零值对该类型有意义）
let raw: i32 = unsafe { std::mem::zeroed() };
```

`transmute` 是 `unsafe` 里风险最高的工具之一，使用前必须确认两种类型的 ABI 布局完全匹配，否则会产生极难调试的 UB（未定义行为）。

---

## 七、常见误区

### 误区一："能不用 unsafe 就不用"等于"完全不用"

有人把这条建议理解成：凡是能用 safe Rust 写的就绝对不碰 `unsafe`。

这方向是对的，但结论不够准确。

正确的理解是：

> 不要用 `unsafe` 去做 safe Rust 已经能做的事情。如果某个能力只有 `unsafe` 才能表达，并且它是合理的设计，那就应该用，同时做好封装和文档。

Rust 的整个内存分配器、标准库容器、操作系统接口，都建立在 `unsafe` 之上。`unsafe` 不是洪水猛兽，而是有限度的能力扩展口。

### 误区二：`unsafe` 块里的所有代码都是"危险的"

这也是常见的误解。

`unsafe` 块里的代码，安全检查大部分仍然生效。只有那五项特定能力（解引用裸指针、调用 unsafe 函数等）是"被解锁的"，其余的类型检查、借用规则（针对普通引用）、生命周期推断，一样在运行。

### 误区三：`unsafe` 会关闭所有优化保护

不会。

`unsafe` 只是声明"我知道这件事是安全的，我来负责"。编译器仍然会做所有常规的优化，Rust 的 LLVM 后端也会做 UB 相关的优化假设。

事实上，错误使用 `unsafe` 导致未定义行为（UB），往往正是因为优化器发现了 UB 并做了"合理的"但不符合你预期的优化。这也是为什么 `unsafe` 一定要维护正确的 Safety Invariant。

---

## 八、总结

`unsafe` 只有五项能力：

1. 解引用裸指针
2. 调用 `unsafe` 函数（含 FFI）
3. 访问 `static mut`
4. 实现 `unsafe trait`
5. 在 `union` 中访问字段

使用 `unsafe` 的核心原则只有一条：

> **封装**。把 `unsafe` 封装在安全接口后面，对外暴露安全的 API，对内维护 Safety Invariant，每个 `unsafe` 块配 Safety 注释。

什么时候该用 `unsafe`：

- 性能关键路径，需要跳过已知不必要的检查
- 与 C 库集成（FFI）
- 实现自定义数据结构（手动内存管理）
- 类型包含裸指针，需要手动实现 `Send` / `Sync`
- 标准库提供了 unsafe 版本的 API，且你能保证前提条件成立

什么时候不该用 `unsafe`：

- safe Rust 完全能表达这个逻辑，只是写法稍微麻烦一点
- 还没搞清楚具体的 Safety Invariant 是什么
- 只是想绕过借用检查器"试试看能不能跑"

`unsafe` 是一扇门。门本身不危险，危险的是不知道门后面有什么就走进去。
