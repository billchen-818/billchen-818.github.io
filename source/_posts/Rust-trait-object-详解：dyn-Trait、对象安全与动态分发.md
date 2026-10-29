---
title: Rust trait object 详解：dyn Trait、对象安全与动态分发
date: 2026-05-18 14:10:09
tags: Rust
---

很多人第一次接触 Rust trait object，都会觉得它有点别扭。

一方面，它看起来像“接口对象”：

- `&dyn Trait`
- `Box<dyn Trait>`

另一方面，它又总是伴随着一堆限制：

- 为什么有的 trait 能写成 `dyn Trait`，有的不能？
- 为什么带泛型方法的 trait 往往不对象安全？
- 为什么返回 `Self` 的方法经常会出问题？
- 既然泛型更快，为什么还需要 trait object？

如果只背结论，这一块会非常碎。

真正更有用的理解方式是把这几个问题串起来：

1. `dyn Trait` 到底解决什么问题
2. 它和泛型分别对应什么分发方式
3. 对象安全规则本质上在保护什么
4. 工程里什么时候该用，什么时候不该用

这一篇我不打算把它写成“语法罗列”，而是尽量从运行模型和设计取舍上把 trait object 讲清楚。

文中的完整可运行示例在 `workspaces/trait-object-demo`。

---

## 一、先说结论：trait object 解决的是“异构值的统一处理”

Trait 很多人已经熟悉了。

比如我们先定义一个绘制接口：

```rust
trait Draw {
    fn draw(&self);
}
```

然后让不同组件实现它：

```rust
struct Button {
    label: String,
}

struct SelectBox {
    options: Vec<String>,
}

impl Draw for Button {
    fn draw(&self) {
        println!("render button => label={}", self.label);
    }
}

impl Draw for SelectBox {
    fn draw(&self) {
        println!("render select box => options={:?}", self.options);
    }
}
```

如果你只是写这样一个函数：

```rust
fn render_one<T: Draw>(item: &T) {
    item.draw();
}
```

那这里其实还不需要 trait object。

因为这个函数一次只处理一种具体类型。调用 `render_one(&button)` 时，编译器知道 `T = Button`；调用 `render_one(&select_box)` 时，编译器知道 `T = SelectBox`。

真正的问题出现在这里：

```rust
struct Screen {
    components: Vec<Box<dyn Draw>>,
}
```

这时候我们想做的是：

> 在同一个集合里，同时放入多个不同具体类型，但把它们都当成“能 draw 的东西”统一处理。

这才是 trait object 最典型、最核心的用途。

如果没有 `dyn Draw`，`Vec<T>` 里的 `T` 必须是同一个具体类型，你没法同时把 `Button` 和 `SelectBox` 塞进去。

所以从工程角度讲：

> trait object 不是“trait 的另一种写法”，而是“当具体类型不再统一时，仍然保留统一行为抽象”的手段。

---

## 二、`dyn Trait` 到底是什么？

先看常见写法：

- `&dyn Draw`
- `Box<dyn Draw>`
- `Arc<dyn Draw + Send + Sync>`

它们的共同点是：

> `dyn Trait` 本身不是一个普通的具体类型，而是一种动态大小类型（DST, Dynamically Sized Type），必须放在指针后面使用。

也就是说，你不能直接这样写：

```rust
// 错误示意
// let x: dyn Draw = ...;
```

而必须写成引用、Box、Arc 这类“带间接层”的形式：

```rust
let a: &dyn Draw = &button;
let b: Box<dyn Draw> = Box::new(button);
```

为什么？

因为编译器在编译期并不知道 `dyn Draw` 背后到底是 `Button`、`SelectBox`，还是别的实现类型。既然具体类型不确定，大小也就不能在编译期固定下来，所以需要通过指针间接访问。

这里可以先记一个非常实用的判断：

- 你要“借用地看待一个 trait object”，常用 `&dyn Trait`
- 你要“拥有并保存一批不同实现类型”，常用 `Box<dyn Trait>`
- 你要“跨线程共享并拥有它”，常用 `Arc<dyn Trait + Send + Sync>`

---

## 三、trait object 和泛型的根本区别：静态分发 vs 动态分发

这部分是整篇文章的主轴。

### 3.1 泛型对应静态分发

比如：

```rust
trait Speaker {
    fn speak(&self) -> String;
}

fn broadcast_static<T: Speaker>(speakers: &[T]) {
    for speaker in speakers {
        println!("{}", speaker.speak());
    }
}
```

这里的核心不是“写法像模板”，而是：

> 编译器会为每个具体类型生成专门代码，这个过程通常叫单态化（monomorphization）。

也就是说，如果你分别用 `User` 和 `Robot` 调用类似的泛型逻辑，编译器最终生成的是不同的具体版本。

这意味着：

- 方法调用目标在编译期就确定了
- 优化空间更大，容易内联
- 往往性能更好
- 但可能带来代码膨胀

### 3.2 trait object 对应动态分发

再看另一种写法：

```rust
fn broadcast_dynamic(speakers: &[&dyn Speaker]) {
    for speaker in speakers {
        println!("{}", speaker.speak());
    }
}
```

这里 `speakers` 里每个元素背后的具体类型都可能不同。

这时编译器做不到“提前把调用目标写死”，只能在运行时根据对象携带的类型信息，找到对应实现再调用。

这就是动态分发。

### 3.3 一个更准确的理解

很多文章会简单说：

> 泛型快，trait object 慢。

这句话不能说错，但太粗糙。

更准确的说法应该是：

- 泛型把“选择具体实现”这件事提前到编译期
- trait object 把“选择具体实现”这件事推迟到运行期

所以二者不是单纯性能高低关系，而是两种不同的建模方式。

我自己的经验是：

> 如果你一开始就知道集合里永远只会放同一种类型，那优先用泛型；如果你需要一个稳定抽象边界来承接“不同实现”，trait object 才真正有意义。

换句话说，`dyn Trait` 的价值不在于“更灵活”，而在于“让异构实现能在同一个抽象边界后面被统一组织”。

---

## 四、动态分发到底怎么做到的？

这一块不需要钻到编译器源码，但至少要知道一个基本模型。

当你拿到一个 `&dyn Trait` 或 `Box<dyn Trait>` 时，它背后通常不是只有一个普通地址，而可以理解成“胖指针（fat pointer）”：

1. 一部分指向实际数据
2. 一部分指向对应 trait 的虚表（vtable）

vtable 里会放这类信息：

- 如何调用这个类型对该 trait 的方法实现
- 类型大小信息
- 类型对齐信息
- 析构相关信息

于是调用：

```rust
speaker.speak()
```

大致可以理解成：

1. 先通过 trait object 拿到 vtable
2. 再从 vtable 中找到 `speak` 对应的函数入口
3. 最后把真实数据指针传进去完成调用

这就是为什么动态分发会多一层间接跳转。

也正因为有这层间接：

- 编译器通常更难内联
- 某些优化机会会变少
- 但换来了运行时按真实类型分派的能力

这里有一个很重要但很容易被忽视的点：

> trait object 的代价不仅是“慢一点点”，更是“编译器看见的信息变少了”。

这会影响的不只是一次函数调用，还可能影响整段代码的优化路径。

所以别把 `dyn Trait` 当成“默认抽象方式”。如果没有异构集合、插件边界、运行时替换实现这类需求，用泛型通常更直接。

---

## 五、什么叫对象安全（object safety）？

现在进入最容易卡住的一块。

所谓对象安全，说白一点，就是：

> 一个 trait 能不能被安全地做成 trait object，也就是能不能写成 `dyn Trait` 来用。

例如下面这个 trait 就是对象安全的：

```rust
trait Draw {
    fn draw(&self);
}
```

因此你可以写：

```rust
let item: Box<dyn Draw> = Box::new(Button {
    label: "OK".to_string(),
});
```

但不是所有 trait 都能这么做。

### 5.1 为什么 Rust 要有对象安全限制？

本质原因很简单：

> trait object 在调用方法时，只知道“这里有个实现了某 trait 的值”，但不知道它的具体类型。

如果一个方法的设计强依赖“具体类型本身”，那么在只拿着 `dyn Trait` 的情况下，编译器就没法把调用规则定义清楚。

对象安全规则，本质上是在拒绝这类“离开具体类型就说不清怎么调用”的接口设计。

这是我觉得理解对象安全最关键的一句话。

---

## 六、哪些 trait 不对象安全？

### 6.1 返回 `Self` 的方法通常不行

看一个很典型的例子：

```rust
trait CloneLike {
    fn clone_like(&self) -> Self;
}
```

为什么这很难做成 `dyn CloneLike`？

因为如果你手里只有一个 `&dyn CloneLike`，调用：

```rust
// 伪代码
let x = obj.clone_like();
```

返回值到底是什么具体类型？

- `Button`？
- `SelectBox`？
- 其他实现类型？

编译器只看到 `dyn CloneLike`，并不知道 `Self` 具体是谁，于是返回值大小和布局都没法在调用点确定。

这类接口天然依赖具体类型，因此不适合作为 trait object 的公共方法。

### 6.2 带泛型参数的方法通常不行

例如：

```rust
trait Serializer {
    fn serialize_into<T: std::io::Write>(&self, writer: &mut T);
}
```

这个问题的根本点在于：

> 泛型方法不是一个固定函数入口，而是一族针对不同 `T` 单态化后的函数。

而 vtable 需要的是“可以稳定放进去的方法入口”。

如果你想把一个泛型方法塞进 trait object 的分发表里，编译器就会碰到一个问题：

> 到底要为哪些 `T` 预先准备入口？

这在开放世界里是说不完的，因此这种方法通常会破坏对象安全。

### 6.3 不带接收者的方法也往往有问题

比如：

```rust
trait Factory {
    fn create() -> Self;
}
```

这类方法没有 `self`，本质上更像“和具体实现类型绑定的关联函数”。

一旦你只有 `dyn Factory`，就没有一个明确的具体类型上下文让这个 `create` 成立。

---

## 七、那这些 trait 就完全不能写了吗？不是，关键是拆边界

对象安全不是在告诉你“这种接口错误”，而是在提醒你：

> 这个接口不适合直接暴露成 trait object 边界。

这时更成熟的做法通常不是硬拗，而是重新拆分职责。

### 7.1 给不对象安全的方法加 `where Self: Sized`

例如：

```rust
trait Notifier {
    fn notify(&self);

    fn into_box(self) -> Box<Self>
    where
        Self: Sized,
    {
        Box::new(self)
    }
}
```

这段设计的含义是：

- `notify(&self)` 可以通过 trait object 调用
- `into_box(self)` 只能在具体类型已知时调用

也就是说，你明确告诉编译器：

> 这个方法不是给 `dyn Trait` 用的，它只服务于具体类型上下文。

这是 Rust 里非常常见也非常合理的手法。

### 7.2 把“对象安全接口”和“构造/泛型能力”拆成两个 trait

例如不要强行把所有能力都塞进一个 trait：

```rust
trait Message {
    fn encode(&self) -> Vec<u8>;
}

trait MessageFactory: Sized {
    fn decode(bytes: &[u8]) -> Self;
}
```

这时：

- `Message` 适合作为 `dyn Message`
- `MessageFactory` 则保留在具体类型层面使用

这个拆分很符合工程直觉。

因为“一个值如何被统一操作”和“某个具体类型如何被构造出来”，本来就是两种不同职责。

### 7.3 把返回 `Self` 改成返回装箱 trait object

有时候你确实需要“克隆一个抽象对象”，常见做法是改成：

```rust
trait CloneableMessage {
    fn clone_box(&self) -> Box<dyn CloneableMessage>;
}
```

虽然失去了一部分静态类型信息，但换来了对象安全。

很多成熟库都会采用类似思路。

这背后的原则是：

> 如果你希望边界保持动态抽象，那返回值也往往要继续停留在这个动态抽象层里，而不是试图“突然回到具体类型”。

---

## 八、一个完整可运行示例：异构集合为什么必须靠 trait object

下面这段代码来自 `workspaces/trait-object-demo/src/main.rs`。

```rust
trait Draw {
    fn draw(&self);
}

struct Button {
    label: String,
}

struct SelectBox {
    options: Vec<String>,
}

impl Draw for Button {
    fn draw(&self) {
        println!("render button => label={}", self.label);
    }
}

impl Draw for SelectBox {
    fn draw(&self) {
        println!("render select box => options={:?}", self.options);
    }
}

struct Screen {
    components: Vec<Box<dyn Draw>>,
}

impl Screen {
    fn run(&self) {
        for component in &self.components {
            component.draw();
        }
    }
}
```

关键点不是 `draw()` 本身，而是这一行：

```rust
components: Vec<Box<dyn Draw>>
```

它表达的是：

> `Screen` 不关心每个组件的具体类型，只关心它们是不是都能 `draw()`。

这在 UI 组件、插件系统、任务执行器、消息处理器里都非常常见。

只要你的系统需要“宿主程序定义抽象接口，具体实现由多个不同类型提供”，trait object 就很自然。

---

## 九、借用型 trait object 和拥有型 trait object

很多人学到 `dyn Trait` 之后，第一反应就是 `Box<dyn Trait>`。但实际工程里，先分清“借用”和“拥有”更重要。

### 9.1 `&dyn Trait`：我只想临时统一调用

例如：

```rust
fn broadcast_dynamic(speakers: &[&dyn Speaker]) {
    for speaker in speakers {
        println!("[dynamic] {}", speaker.speak());
    }
}
```

这里调用方仍然持有真实对象，函数只是“临时借用一组 trait object 视图”。

优点是：

- 不涉及所有权转移
- 不需要额外堆分配
- 很适合只读访问场景

### 9.2 `Box<dyn Trait>`：我要把不同实现真正装进一个容器里

例如前面的 `Screen`。

如果 `Screen` 需要长期持有这些组件，那么就必须真正拥有它们。由于具体类型不同、大小不同，最常见的做法就是装箱。

这时 `Box<dyn Trait>` 的意义不是“为了能调用 trait 方法”，而是：

> 为了让这些大小不一致的具体值，都能以统一大小的指针形式存进集合。

这个视角非常重要。

很多时候你以为自己需要 `Box<dyn Trait>`，其实只是想临时调用一下，那 `&dyn Trait` 往往更轻。

---

## 十、什么时候该优先用泛型，什么时候该用 trait object？

这是最实际的问题。

我给一个工程里很常用的判断法。

### 10.1 这些场景优先考虑泛型

如果你满足下面这些特征，通常优先泛型：

- 调用点知道具体类型
- 集合里元素类型统一
- 你希望保留编译器优化空间
- 抽象只是“代码复用”，不是运行时扩展边界

例如：

- 通用算法
- 迭代器适配器
- 零成本封装
- 库内部高频路径

### 10.2 这些场景更适合 trait object

如果你满足下面这些特征，trait object 往往更自然：

- 同一容器里要放不同具体类型
- 宿主程序只依赖抽象，不依赖实现
- 希望运行时替换不同策略/插件
- 希望稳定暴露一个面向行为的边界

例如：

- UI 组件树
- 插件系统
- 策略模式
- 消息处理器注册表
- 不同后端驱动的统一封装

### 10.3 一个我自己的经验判断

如果你还在犹豫用哪一个，我建议先问自己一句：

> 我是在抽象“同一种东西的通用算法”，还是在抽象“不同实现的统一边界”？

前者通常偏泛型。

后者通常偏 trait object。

这比死记“性能优先用泛型，灵活优先用 dyn”更靠谱。

因为真正决定设计的，往往不是性能口号，而是你的依赖边界到底长什么样。

---

## 十一、对象安全不是语法障碍，而是接口设计反馈

这部分是我最想强调的“作者自己的思考”。

很多人第一次被对象安全报错卡住时，会觉得 Rust 在故意找麻烦。

但从更长线的工程视角看，对象安全其实是在逼你回答一个问题：

> 你这个 trait，到底是想表达“抽象行为边界”，还是想表达“一个带强类型能力的具体接口模板”？

这两件事很像，但并不相同。

当一个 trait 里既有：

- 面向抽象对象的行为方法
- 又有返回 `Self`、泛型方法、构造函数这类强依赖具体类型的能力

通常说明你把两个层次的职责混在一起了。

Rust 的对象安全规则并不是在限制表达力，而是在强迫你把“可动态抽象的部分”和“必须依赖具体类型的部分”拆开。

我自己越来越认同的一点是：

> 好的 trait object 边界，通常都很克制。

它们往往只暴露一组非常稳定、非常面向行为的方法，而不会把“构造、泛型扩展、类型特有能力”一起塞进去。

这和很多成熟系统里的接口设计其实是相通的。

不是能力越多越好，而是边界越稳定越值钱。

---

## 十二、trait object 的常见误区

### 12.1 误区一：只要用了 trait，就该考虑 `dyn Trait`

不是。

绝大多数 trait 在 Rust 里首先是“约束”和“抽象行为定义”，不一定非要变成 trait object。

很多 trait 更适合和泛型一起用，而不是和动态分发一起用。

### 12.2 误区二：对象安全报错说明 trait 设计错了

也不是。

更准确地说，是这个 trait 不适合直接作为 trait object 边界使用。

也许它作为泛型约束完全合理。

### 12.3 误区三：`Box<dyn Trait>` 是更高级、更工程化的抽象

这往往是反的。

如果没有异构集合、插件化、运行时替换实现这些现实需求，过早引入 `dyn Trait` 只会让代码更绕，优化空间更少，生命周期和所有权也更复杂。

---

## 十三、回到实践：一段最值得记住的话

如果你读完整篇后只记住一句话，我希望是这句：

> trait object 适合表达“我不关心你具体是谁，只关心你现在能做什么”；对象安全则是在保证这件事离开具体类型后依然说得通。

一旦你从这个角度去看：

- 为什么 `dyn Trait` 需要指针承载
- 为什么它对应动态分发
- 为什么返回 `Self` 和泛型方法容易不对象安全
- 为什么一些 trait 应该拆成两个层次

这些原本零散的规则就会变得统一起来。

---

## 十四、本文示例运行结果

在 `workspaces/trait-object-demo` 目录执行：

```bash
cargo run
```

可以看到类似输出：

```text
render button => label=OK
render select box => options=["Rust", "Go", "Java"]
[static] user alice says hello
[static] user bob says hello
[dynamic] user carol says hello
[dynamic] robot #7 is ready
serialized => {"type":"user","name":"carol"}
serialized => {"type":"robot","id":7}
```

这里前两行展示的是异构组件集合的统一调用；中间两组输出分别对应静态分发和动态分发场景，方便你对照理解二者差异。

---

## 结语

trait object 这块内容，难点从来不在语法，而在“你脑子里默认站在哪一层看问题”。

如果你总是从“某个类型有哪些方法”出发，对象安全会显得非常绕；但如果你从“我现在是不是要定义一个运行时抽象边界”出发，很多限制就会显得很自然。

所以我的建议是：

1. 先用泛型思维写清楚具体逻辑
2. 只有在确实需要异构集合或稳定动态边界时，再引入 trait object
3. 一旦碰到对象安全问题，不要急着绕语法，先检查 trait 职责是不是混了

这一套思路，比单纯记住几条规则更重要。