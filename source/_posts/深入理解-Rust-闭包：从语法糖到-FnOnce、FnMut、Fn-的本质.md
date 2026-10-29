---
title: 深入理解 Rust 闭包：从语法糖到 FnOnce、FnMut、Fn 的本质
date: 2026-06-01 09:54:18
tags: Rust
---

## 引言

闭包是 Rust 中最常用的特性之一。迭代器链、异步回调、线程启动、错误处理——几乎所有场景都离不开闭包。

很多人初学闭包时，写个 `|x| x + 1` 觉得"不就是匿名函数吗"，但真到了下面这些场景就会卡住：

- 为什么这个闭包能传给 `map`，那个却不行？
- `FnOnce`、`FnMut`、`Fn` 到底有什么区别？
- 闭包到底是怎么捕获变量的？为什么有时候编译器报"value moved"？
- `move` 关键字到底做了什么？什么时候必须加？

这些问题的本质是：**闭包不是简单的匿名函数，它是一个捕获了上下文环境的匿名结构体**。

这篇文章会从浅到深讲清楚：

1. 闭包的基本语法
2. 闭包如何捕获变量（不可变借用、可变借用、所有权转移）
3. `Fn`、`FnMut`、`FnOnce` 三个 trait 的定义与关系
4. 编译器如何推断闭包类型
5. `move` 闭包
6. 闭包作为参数和返回值
7. 闭包的底层实现原理
8. 实战场景与最佳实践

---

## 一、闭包的基本语法

### 1.1 最简形式

```rust
fn main() {
    // 普通函数
    fn add_one(x: i32) -> i32 { x + 1 }

    // 闭包：用 |参数| 表达式 的形式定义
    let add_one = |x: i32| -> i32 { x + 1 };

    // 闭包可以省略类型标注（编译器自动推断）
    let add_one = |x| x + 1;

    println!("{}", add_one(5)); // 6
}
```

闭包的语法非常灵活，以下写法都合法：

```rust
fn main() {
    let f1 = |x: i32, y: i32| -> i32 { x + y };  // 完整标注
    let f2 = |x, y| x + y;                         // 省略类型和花括号
    let f3 = || 42;                                 // 无参数
    let f4 = || { println!("hello"); };             // 无返回值
    let f5 = |x: &str| x.len();                    // 引用参数

    println!("{}", f1(1, 2)); // 3
    println!("{}", f2(3, 4)); // 7
    println!("{}", f3());     // 42
    f4();                     // hello
    println!("{}", f5("rust")); // 4
}
```

### 1.2 闭包 vs 函数的核心区别

闭包和函数最大的不同在于：**闭包可以捕获定义时所在环境中的变量**。

```rust
fn main() {
    let name = String::from("Rust");

    // 闭包捕获了外部变量 name
    let greet = || println!("Hello, {}!", name);

    greet(); // Hello, Rust!

    // 普通函数做不到这一点
    // fn greet_fn() { println!("Hello, {}!", name); } // 编译错误
}
```

这就是"闭包"名字的由来——它"封闭"了自己定义时的环境。

---

## 二、闭包如何捕获变量

这是理解闭包的关键。Rust 编译器会为每个闭包生成一个匿名结构体，并根据闭包体中对变量的使用方式，自动选择最"轻量"的捕获方式：

| 优先级 | 捕获方式 | 对应操作 | 类似于 |
|--------|---------|---------|--------|
| 1（最优先） | 不可变借用 | 只读取变量 | `&T` |
| 2 | 可变借用 | 修改变量 | `&mut T` |
| 3（最后手段）| 所有权转移 | 消耗变量 | `T` |

### 2.1 不可变借用捕获

```rust
fn main() {
    let message = String::from("hello");

    let print_msg = || {
        // 只读取 message，编译器选择不可变借用
        println!("{}", message);
    };

    print_msg();
    print_msg(); // 可以多次调用

    // message 仍然可用，因为只是被借用了
    println!("原始: {}", message);
}
```

### 2.2 可变借用捕获

```rust
fn main() {
    let mut count = 0;

    let mut increment = || {
        // 修改了 count，编译器选择可变借用
        count += 1;
        println!("count = {}", count);
    };

    increment(); // count = 1
    increment(); // count = 2
    increment(); // count = 3

    // 闭包不再使用后，可变借用释放
    println!("最终: {}", count); // 最终: 3
}
```

注意两个关键点：
1. 闭包绑定 `increment` 必须声明为 `mut`，因为调用它会改变捕获的状态
2. 在闭包存活期间，`count` 不能被其他地方访问（Rust 的可变借用独占规则）

```rust
fn main() {
    let mut count = 0;

    let mut increment = || { count += 1; };

    // println!("{}", count); // 编译错误！increment 持有 count 的可变借用
    increment();
    increment();

    // increment 不再使用，可变借用释放
    println!("{}", count); // 正常：2
}
```

### 2.3 所有权转移捕获

```rust
fn main() {
    let name = String::from("Rust");

    let consume = || {
        // drop 需要所有权，编译器选择转移所有权
        drop(name);
        println!("name 已被释放");
    };

    consume();
    // consume(); // 编译错误！闭包只能调用一次，因为 name 已经被消耗
    // println!("{}", name); // 编译错误！name 已被移走
}
```

### 2.4 编译器的自动推断示例

```rust
fn main() {
    let s = String::from("hello");

    // 场景1：只读 -> 不可变借用
    let f1 = || println!("{}", s);

    // 场景2：push 需要 &mut -> 可变借用
    let mut v = vec![1, 2, 3];
    let mut f2 = || v.push(4);

    // 场景3：传入接受所有权的函数 -> 所有权转移
    let s2 = String::from("world");
    let f3 = || { let _ = s2; }; // s2 被移入闭包
}
```

---

## 三、FnOnce、FnMut、Fn：三个闭包 Trait

Rust 用三个 trait 来描述闭包的能力。理解它们是理解闭包的核心。

### 3.1 Trait 定义

```rust
// 只能调用一次（消耗 self）
pub trait FnOnce<Args> {
    type Output;
    fn call_once(self, args: Args) -> Self::Output;
}

// 可以多次调用，但可能修改状态（&mut self）
pub trait FnMut<Args>: FnOnce<Args> {
    fn call_mut(&mut self, args: Args) -> Self::Output;
}

// 可以多次调用，不修改状态（&self）
pub trait Fn<Args>: FnMut<Args> {
    fn call(&self, args: Args) -> Self::Output;
}
```

### 3.2 继承关系

这三个 trait 存在继承关系：

```
        Fn
        │  （Fn 继承 FnMut）
        ▼
      FnMut
        │  （FnMut 继承 FnOnce）
        ▼
      FnOnce
```

也就是说：

- 实现了 `Fn` 的闭包，自动实现了 `FnMut` 和 `FnOnce`
- 实现了 `FnMut` 的闭包，自动实现了 `FnOnce`
- 实现了 `FnOnce` 的闭包，不一定实现 `FnMut` 或 `Fn`

这个继承关系非常合理：能只读访问的闭包，当然也能可变访问；能多次调用的闭包，当然也能调用一次。

### 3.3 用 self 参数理解三个 Trait

| Trait | self 类型 | 含义 | 可调用次数 |
|-------|----------|------|-----------|
| `FnOnce` | `self` | 消耗闭包自身 | 最多一次 |
| `FnMut` | `&mut self` | 可变借用闭包 | 多次 |
| `Fn` | `&self` | 不可变借用闭包 | 多次 |

### 3.4 FnOnce：只能调用一次

```rust
fn consume_closure<F: FnOnce() -> String>(f: F) {
    let result = f(); // 调用时消耗了 f
    println!("{}", result);
    // let result2 = f(); // 编译错误！f 已被消耗
}

fn main() {
    let name = String::from("Rust");

    // 这个闭包移走了 name 的所有权，只能调用一次
    let closure = || {
        let s = name; // name 被移入闭包体
        format!("Hello, {}", s)
    };

    consume_closure(closure);
    // consume_closure(closure); // 编译错误！closure 已被消耗
}
```

**什么时候闭包是 FnOnce？**

当闭包体内将捕获的变量**移出**（转移所有权）时，这个闭包只能实现 `FnOnce`，因为第二次调用时变量已经不在了。

```rust
fn main() {
    let data = vec![1, 2, 3];

    // data 被移入闭包，然后传给了 drop
    let f = || drop(data);

    f();
    // f(); // 编译错误!
}
```

### 3.5 FnMut：可以修改捕获的变量

```rust
fn call_twice<F: FnMut()>(mut f: F) {
    f();
    f();
}

fn main() {
    let mut total = 0;

    let mut adder = || {
        total += 10; // 修改了 total
    };

    call_twice(&mut adder);
    println!("total = {}", total); // 20
}
```

**什么时候闭包是 FnMut（但不是 Fn）？**

当闭包体内**修改**了捕获的变量时：

```rust
fn main() {
    let mut log = Vec::new();

    let mut logger = || {
        log.push("event"); // 修改了 log
    };

    logger();
    logger();
    println!("{:?}", log); // ["event", "event"]
}
```

### 3.6 Fn：纯只读访问

```rust
fn call_many_times<F: Fn() -> String>(f: F) {
    println!("{}", f());
    println!("{}", f());
    println!("{}", f());
}

fn main() {
    let prefix = String::from("Hello");

    let greeter = || {
        // 只读取 prefix，不修改、不移走
        format!("{}, World!", prefix)
    };

    call_many_times(greeter);
    // 闭包调用完后 prefix 仍然可用
    println!("prefix 还在: {}", prefix);
}
```

### 3.7 三者对比的完整示例

```rust
fn main() {
    // === Fn: 只读捕获 ===
    let name = String::from("Alice");
    let fn_closure = || println!("Hi, {}", name);
    fn_closure();
    fn_closure(); // 可以多次调用
    println!("name 还在: {}", name); // name 仍然可用

    // === FnMut: 可变借用捕获 ===
    let mut count = 0;
    let mut fn_mut_closure = || {
        count += 1;
        println!("count = {}", count);
    };
    fn_mut_closure(); // count = 1
    fn_mut_closure(); // count = 2

    // === FnOnce: 所有权转移捕获 ===
    let data = String::from("important data");
    let fn_once_closure = || {
        let moved = data; // 所有权转移
        println!("消耗了: {}", moved);
    };
    fn_once_closure();
    // fn_once_closure(); // 编译错误！
}
```

---

## 四、move 关键字：强制转移所有权

### 4.1 move 的作用

默认情况下，编译器会选择最轻量的捕获方式。`move` 关键字强制闭包对所有捕获的变量获取所有权，而不是借用。

```rust
fn main() {
    let name = String::from("Rust");

    // 不加 move：编译器选择不可变借用
    let closure1 = || println!("{}", name);
    closure1();
    println!("name 还在: {}", name); // name 仍可用

    // 加 move：强制转移所有权
    let closure2 = move || println!("{}", name);
    closure2();
    // println!("{}", name); // 编译错误！name 已被移入闭包
}
```

### 4.2 move 不改变闭包的 Trait 类型

这是一个常见的误解。很多人以为 `move` 闭包一定是 `FnOnce`，但实际上：

**`move` 只影响捕获方式，不影响闭包实现哪个 Trait。**

```rust
fn main() {
    let name = String::from("Rust");

    // 虽然用了 move（name 被移入闭包），
    // 但闭包体内只是读取 name，所以这个闭包实现了 Fn
    let closure = move || println!("{}", name);

    // 可以多次调用
    closure();
    closure();
    closure();

    // 可以传给要求 Fn 的函数
    fn takes_fn(f: impl Fn()) {
        f();
        f();
    }
    takes_fn(closure);
}
```

关键区分：

| 情况 | move | 闭包体操作 | 实现的 Trait |
|------|------|-----------|-------------|
| 1 | 无 | 只读 | Fn |
| 2 | 无 | 修改 | FnMut |
| 3 | 无 | 转移出 | FnOnce |
| 4 | 有 | 只读 | **Fn**（move 不影响） |
| 5 | 有 | 修改 | **FnMut** |
| 6 | 有 | 转移出 | **FnOnce** |

### 4.3 move 的典型使用场景：跨线程

当闭包需要发送到另一个线程时，必须使用 `move`，因为当前线程中的变量可能在子线程还在运行时就被释放了：

```rust
use std::thread;

fn main() {
    let message = String::from("hello from main");

    // 不加 move 会编译错误
    // 因为 message 的引用可能比当前作用域活得短
    let handle = thread::spawn(move || {
        println!("线程说: {}", message);
    });

    // println!("{}", message); // 编译错误：message 已被移走
    handle.join().unwrap();
}
```

### 4.4 move 对 Copy 类型的影响

对于实现了 `Copy` 的类型，`move` 做的是拷贝而不是转移：

```rust
fn main() {
    let x = 42; // i32 实现了 Copy

    let closure = move || println!("x = {}", x);
    closure();

    // x 仍然可用，因为 i32 是 Copy 类型，move 只是拷贝了一份
    println!("x 仍然是: {}", x);
}
```

---

## 五、闭包作为函数参数

### 5.1 使用泛型约束（最常用）

```rust
// 接受 Fn 闭包
fn apply<F: Fn(i32) -> i32>(f: F, x: i32) -> i32 {
    f(x)
}

// 接受 FnMut 闭包
fn apply_mut<F: FnMut(i32)>(mut f: F, items: &[i32]) {
    for &item in items {
        f(item);
    }
}

// 接受 FnOnce 闭包
fn apply_once<F: FnOnce() -> String>(f: F) -> String {
    f()
}

fn main() {
    // Fn
    let double = |x| x * 2;
    println!("{}", apply(double, 5)); // 10

    // FnMut
    let mut sum = 0;
    apply_mut(|x| sum += x, &[1, 2, 3, 4, 5]);
    println!("sum = {}", sum); // 15

    // FnOnce
    let name = String::from("Rust");
    let result = apply_once(|| format!("Hello, {}", name));
    println!("{}", result); // Hello, Rust
}
```

### 5.2 使用 impl Trait 语法

```rust
fn apply(f: impl Fn(i32) -> i32, x: i32) -> i32 {
    f(x)
}

fn main() {
    println!("{}", apply(|x| x * 3, 10)); // 30
}
```

### 5.3 该选哪个 Trait？

经验法则：

- **如果你只需要调用闭包一次** → 用 `FnOnce`（最宽松，接受所有闭包）
- **如果你需要多次调用，且闭包可能修改状态** → 用 `FnMut`
- **如果你需要多次调用，且闭包不修改状态** → 用 `Fn`（最严格）

标准库的例子印证了这个原则：

```rust
// Iterator::map 需要对每个元素调用，但不需要修改：FnMut
fn map<B, F: FnMut(Self::Item) -> B>(self, f: F) -> Map<Self, F>;

// Option::map 只调用一次：FnOnce
fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Option<U>;

// thread::spawn 只执行一次：FnOnce
fn spawn<F: FnOnce() + Send + 'static>(f: F) -> JoinHandle<()>;

// Vec::retain 需要多次判断但不修改状态：FnMut
fn retain<F: FnMut(&T) -> bool>(&mut self, f: F);
```

> 注意：`Iterator::map` 用了 `FnMut` 而不是 `Fn`。这是因为将约束设为 `FnMut` 更宽容，既允许纯函数闭包，也允许带状态的闭包。实际使用中，绝大多数传给 `map` 的闭包都只是 `Fn`，但标准库选择了更灵活的约束。

---

## 六、闭包作为返回值

### 6.1 使用 impl Trait 返回闭包

闭包的具体类型是编译器生成的匿名类型，无法直接写出来。需要用 `impl Trait`：

```rust
fn make_adder(x: i32) -> impl Fn(i32) -> i32 {
    move |y| x + y
}

fn main() {
    let add5 = make_adder(5);
    let add10 = make_adder(10);

    println!("{}", add5(3));  // 8
    println!("{}", add10(3)); // 13
}
```

这里必须用 `move`，因为 `x` 是函数参数，函数结束后 `x` 就被释放了。闭包必须拥有 `x` 的所有权才能在函数返回后继续使用。

### 6.2 使用 Box\<dyn Fn\> 返回不同闭包

当需要根据条件返回不同的闭包时，`impl Trait` 不够用（因为每个闭包的具体类型不同），需要用 trait 对象：

```rust
fn make_operation(op: &str) -> Box<dyn Fn(f64, f64) -> f64> {
    match op {
        "add" => Box::new(|a, b| a + b),
        "mul" => Box::new(|a, b| a * b),
        "max" => Box::new(|a, b| a.max(b)),
        _ => Box::new(|_, _| 0.0),
    }
}

fn main() {
    let ops = vec!["add", "mul", "max"];
    let a = 3.0;
    let b = 4.0;

    for op in ops {
        let f = make_operation(op);
        println!("{}: {}", op, f(a, b));
    }
}
// 输出：
// add: 7
// mul: 12
// max: 4
```

### 6.3 返回闭包的工厂模式

```rust
fn make_greeting(lang: &str) -> Box<dyn Fn(&str) -> String + '_> {
    match lang {
        "en" => Box::new(|name| format!("Hello, {}!", name)),
        "zh" => Box::new(|name| format!("你好，{}！", name)),
        "ja" => Box::new(|name| format!("こんにちは、{}！", name)),
        _ => Box::new(|name| format!("Hi, {}!", name)),
    }
}

fn main() {
    let greet_en = make_greeting("en");
    let greet_zh = make_greeting("zh");

    println!("{}", greet_en("Rust"));  // Hello, Rust!
    println!("{}", greet_zh("Rust"));  // 你好，Rust！
}
```

---

## 七、闭包的底层实现原理

### 7.1 闭包就是匿名结构体

编译器为每个闭包生成一个匿名结构体，捕获的变量就是结构体的字段。我们可以手动模拟编译器的行为：

```rust
// 原始闭包代码
fn closure_version() {
    let x = 10;
    let y = 20;
    let add = |z| x + y + z;
    println!("{}", add(30)); // 60
}

// 编译器实际生成的等价代码（伪代码风格）
fn desugared_version() {
    let x = 10;
    let y = 20;

    // 编译器为闭包生成匿名结构体
    struct ClosureAnonymous<'a> {
        x: &'a i32, // 不可变借用
        y: &'a i32, // 不可变借用
    }

    // 实现 FnOnce
    impl<'a> FnOnce<(i32,)> for ClosureAnonymous<'a> {
        type Output = i32;
        fn call_once(self, (z,): (i32,)) -> i32 {
            self.x + self.y + z
        }
    }

    // 因为只是读取，还实现了 FnMut 和 Fn
    // impl FnMut<(i32,)> for ClosureAnonymous<'_> { ... }
    // impl Fn<(i32,)> for ClosureAnonymous<'_> { ... }

    let add = ClosureAnonymous { x: &x, y: &y };
    println!("{}", add.call_once((30,))); // 60
}
```

### 7.2 不同捕获方式对应不同的字段类型

```rust
fn main() {
    let a = String::from("hello");
    let mut b = Vec::new();
    let c = String::from("world");

    let mut closure = || {
        println!("{}", a);  // 只读 -> 捕获 &String
        b.push(1);          // 修改 -> 捕获 &mut Vec<i32>
        drop(c);            // 消耗 -> 捕获 String（所有权）
    };

    closure();
}

// 编译器生成的匿名结构体等价于：
// struct Closure<'a> {
//     a: &'a String,         // 不可变借用
//     b: &'a mut Vec<i32>,   // 可变借用
//     c: String,             // 所有权
// }
// 因为 c 被 drop 了，这个闭包只能实现 FnOnce
```

### 7.3 闭包的大小

因为闭包是结构体，所以它是有大小的（zero-sized 除外）：

```rust
use std::mem::size_of_val;

fn main() {
    // 不捕获任何变量：零大小
    let f1 = || 42;
    println!("f1 size: {}", size_of_val(&f1)); // 0

    // 捕获一个 i32 的引用
    let x = 10;
    let f2 = || x + 1;
    println!("f2 size: {}", size_of_val(&f2)); // 8（一个引用的大小）

    // 捕获一个 String 的所有权
    let s = String::from("hello");
    let f3 = move || println!("{}", s);
    println!("f3 size: {}", size_of_val(&f3)); // 24（String 结构体大小）

    // 捕获多个变量
    let a = 1i32;
    let b = 2i64;
    let c = 3u8;
    let f4 = move || a as i64 + b + c as i64;
    println!("f4 size: {}", size_of_val(&f4)); // 16（对齐后）
}
```

### 7.4 每个闭包的类型都是唯一的

即使两个闭包的签名完全相同，它们的类型也不同：

```rust
fn main() {
    let f1 = |x: i32| x + 1;
    let f2 = |x: i32| x + 1;

    // f1 和 f2 的类型不同！编译器为每个闭包生成了不同的匿名类型
    // let f3: _ = if true { f1 } else { f2 }; // 编译错误！类型不匹配

    // 如果需要统一类型，使用 trait 对象
    let f3: Box<dyn Fn(i32) -> i32> = if true {
        Box::new(f1)
    } else {
        Box::new(f2)
    };

    println!("{}", f3(10)); // 11
}
```

---

## 八、函数指针 fn 与闭包 Trait 的关系

Rust 还有一个函数指针类型 `fn`（小写），它和闭包 trait `Fn`（大写）不同：

```rust
fn add_one(x: i32) -> i32 {
    x + 1
}

fn main() {
    // fn 是函数指针类型
    let f: fn(i32) -> i32 = add_one;
    println!("{}", f(5)); // 6

    // 不捕获变量的闭包可以转为函数指针
    let g: fn(i32) -> i32 = |x| x + 1;
    println!("{}", g(5)); // 6

    // 捕获了变量的闭包不能转为函数指针
    let y = 10;
    // let h: fn(i32) -> i32 = |x| x + y; // 编译错误！
}
```

关系图：

```
fn（函数指针）
 │  实现了
 ├── Fn
 ├── FnMut
 └── FnOnce
```

所有函数指针都自动实现了三个闭包 trait。所以你可以把普通函数传给接受闭包的地方：

```rust
fn double(x: i32) -> i32 {
    x * 2
}

fn main() {
    let v: Vec<i32> = vec![1, 2, 3, 4, 5];

    // 直接传函数名，等价于传闭包 |x| double(x)
    let doubled: Vec<i32> = v.iter().map(|&x| double(x)).collect();
    println!("{:?}", doubled); // [2, 4, 6, 8, 10]

    // 也可以用函数指针
    let doubled2: Vec<i32> = v.into_iter().map(double).collect();
    println!("{:?}", doubled2); // [2, 4, 6, 8, 10]
}
```

---

## 九、实战场景

### 9.1 迭代器链中的闭包

```rust
fn main() {
    let words = vec!["hello", "world", "rust", "is", "awesome"];

    let result: String = words
        .iter()
        .filter(|w| w.len() > 3)           // Fn: 只读判断
        .map(|w| w.to_uppercase())          // FnMut: 创建新值
        .collect::<Vec<_>>()
        .join(", ");

    println!("{}", result); // HELLO, WORLD, RUST, AWESOME
}
```

### 9.2 带状态的闭包

```rust
fn main() {
    let mut counter = 0;

    // 用闭包实现一个 ID 生成器
    let mut next_id = || {
        counter += 1;
        counter
    };

    println!("ID: {}", next_id()); // 1
    println!("ID: {}", next_id()); // 2
    println!("ID: {}", next_id()); // 3
}
```

### 9.3 回调模式

```rust
struct EventEmitter {
    listeners: Vec<Box<dyn Fn(&str)>>,
}

impl EventEmitter {
    fn new() -> Self {
        EventEmitter { listeners: Vec::new() }
    }

    fn on(&mut self, callback: impl Fn(&str) + 'static) {
        self.listeners.push(Box::new(callback));
    }

    fn emit(&self, event: &str) {
        for listener in &self.listeners {
            listener(event);
        }
    }
}

fn main() {
    let mut emitter = EventEmitter::new();

    emitter.on(|event| println!("[日志] 收到事件: {}", event));
    emitter.on(|event| println!("[监控] 事件触发: {}", event));

    emitter.emit("用户登录");
    // 输出：
    // [日志] 收到事件: 用户登录
    // [监控] 事件触发: 用户登录
}
```

### 9.4 惰性求值与缓存

```rust
struct Lazy<T, F: FnOnce() -> T> {
    init: Option<F>,
    value: Option<T>,
}

impl<T, F: FnOnce() -> T> Lazy<T, F> {
    fn new(f: F) -> Self {
        Lazy {
            init: Some(f),
            value: None,
        }
    }

    fn get(&mut self) -> &T {
        if self.value.is_none() {
            let init = self.init.take().expect("Lazy already initialized");
            self.value = Some(init()); // FnOnce：只调用一次
        }
        self.value.as_ref().unwrap()
    }
}

fn main() {
    let mut expensive = Lazy::new(|| {
        println!("执行昂贵的计算...");
        42
    });

    println!("Lazy 已创建，但计算未执行");
    println!("第一次获取: {}", expensive.get()); // 触发计算
    println!("第二次获取: {}", expensive.get()); // 使用缓存
}
// 输出：
// Lazy 已创建，但计算未执行
// 执行昂贵的计算...
// 第一次获取: 42
// 第二次获取: 42
```

### 9.5 组合闭包

```rust
fn compose<A, B, C>(
    f: impl Fn(A) -> B,
    g: impl Fn(B) -> C,
) -> impl Fn(A) -> C {
    move |x| g(f(x))
}

fn main() {
    let double = |x: i32| x * 2;
    let add_one = |x: i32| x + 1;
    let to_string = |x: i32| format!("结果: {}", x);

    let pipeline = compose(compose(double, add_one), to_string);

    println!("{}", pipeline(5));  // 结果: 11 （5*2+1=11）
    println!("{}", pipeline(10)); // 结果: 21 （10*2+1=21）
}
```

---

## 十、闭包与生命周期

### 10.1 闭包捕获引用时的生命周期

```rust
fn make_printer(prefix: &str) -> impl Fn(&str) + '_ {
    move |msg| println!("{}: {}", prefix, msg)
}

fn main() {
    let prefix = String::from("[INFO]");
    let print = make_printer(&prefix);
    print("程序启动");   // [INFO]: 程序启动
    print("加载完成");   // [INFO]: 加载完成
}
```

`'_` 告诉编译器返回的闭包的生命周期和 `prefix` 参数的生命周期相同。

### 10.2 'static 闭包

当闭包需要在任意长的生命周期中存活时（如 `thread::spawn`），需要满足 `'static`：

```rust
use std::thread;

fn start_worker(name: String) -> thread::JoinHandle<()> {
    // move 确保闭包拥有 name 的所有权
    // 自有数据满足 'static 约束
    thread::spawn(move || {
        println!("Worker {} 开始工作", name);
    })
}

fn main() {
    let handle = start_worker(String::from("Alpha"));
    handle.join().unwrap();
}
```

---

## 十一、常见编译错误与解决方案

### 错误 1：闭包活得比捕获的引用长

```rust
fn bad_example() -> impl Fn() {
    let s = String::from("hello");
    // || println!("{}", s) // 错误：s 在函数结束时被释放
    move || println!("{}", s) // 修复：用 move 转移所有权
}
```

### 错误 2：FnOnce 闭包被多次调用

```rust
fn main() {
    let s = String::from("hello");
    let f = || drop(s); // FnOnce
    f();
    // f(); // 错误：cannot move out of closure because it is called more than once

    // 如果确实需要多次调用，重构闭包避免转移所有权
    let s2 = String::from("hello");
    let f2 = || println!("{}", s2); // Fn：只读，可以多次调用
    f2();
    f2();
}
```

### 错误 3：在不可变闭包中尝试修改

```rust
fn takes_fn(f: impl Fn()) {
    f();
}

fn main() {
    let mut x = 0;
    // takes_fn(|| x += 1); // 错误：要求 Fn 但闭包是 FnMut

    // 修复1：改为 FnMut
    fn takes_fn_mut(mut f: impl FnMut()) {
        f();
    }
    takes_fn_mut(|| x += 1);

    // 修复2：使用 Cell 实现内部可变性
    use std::cell::Cell;
    let x = Cell::new(0);
    takes_fn(|| x.set(x.get() + 1)); // Cell 允许在 &self 下修改
    println!("x = {}", x.get());
}
```

---

## 十二、闭包 Trait 速查表

### 判断闭包实现哪个 Trait

```
闭包体内对捕获变量的使用：
├── 没有捕获任何变量 ─────────────────> Fn + FnMut + FnOnce
├── 只读取（&T）─────────────────────> Fn + FnMut + FnOnce
├── 修改（&mut T）───────────────────> FnMut + FnOnce（不是 Fn）
└── 转移所有权（T 被移出）────────────> 仅 FnOnce
```

### 选择参数约束

```
需要调用几次？
├── 最多一次 ────────> FnOnce（最宽松，接受所有闭包）
├── 多次，可能改状态 ─> FnMut
└── 多次，不改状态 ──> Fn（最严格）
```

### 常用标准库方法的闭包约束

| 方法 | 约束 | 原因 |
|------|------|------|
| `Option::map` | `FnOnce` | 最多调用一次 |
| `Option::unwrap_or_else` | `FnOnce` | 最多调用一次 |
| `Result::map` | `FnOnce` | 最多调用一次 |
| `Iterator::map` | `FnMut` | 每个元素调用一次，允许状态 |
| `Iterator::filter` | `FnMut` | 每个元素调用一次 |
| `Iterator::for_each` | `FnMut` | 每个元素调用一次 |
| `Iterator::any` | `FnMut` | 可能调用多次 |
| `Iterator::find` | `FnMut` | 可能调用多次 |
| `Vec::sort_by` | `FnMut` | 多次比较 |
| `thread::spawn` | `FnOnce + Send + 'static` | 执行一次，跨线程 |

---

## 总结

Rust 闭包的核心知识点可以浓缩为以下几条：

1. **闭包是匿名结构体**，捕获的变量就是字段。编译器根据使用方式自动选择借用或所有权。

2. **三个 Trait 对应三种能力**：
   - `Fn`：只读访问，可多次调用
   - `FnMut`：可修改状态，可多次调用
   - `FnOnce`：可消耗捕获的值，最多调用一次
   - 继承关系：`Fn` ⊂ `FnMut` ⊂ `FnOnce`

3. **`move` 改变捕获方式，不改变 Trait 类型**。`move` 强制获取所有权，但闭包实现哪个 Trait 取决于闭包体内的操作。

4. **选择约束时尽量宽松**：如果只会调用一次，用 `FnOnce`；如果不确定，用 `FnMut`；只有确实需要并发只读调用时才用 `Fn`。

5. **每个闭包的类型都是唯一的**。需要统一类型时使用 `Box<dyn Fn(...)>` 或 `impl Fn(...)`。

理解了这些，Rust 中绝大多数闭包相关的编译错误都能迎刃而解。
