---
title: Rust axum 与 tower 关系详解：Service、Layer 与中间件本质
date: 2026-04-21 17:14:23
tags: Rust
---

## 引言

很多人学 axum 的时候，会先从这些 API 开始：

- `Router::new()`
- `route()`
- `State<T>`
- `Json<T>`
- `middleware::from_fn(...)`

用一段时间之后，通常会对 axum 形成一个比较直观的印象：

> 它是一个写 Web API 很舒服的 Rust 框架。

这个结论当然没错，但如果只停留在这个层面，后面一旦碰到下面这些问题，就很容易开始糊：

- 为什么 axum 中间件看起来像一层层包上去
- 为什么 `layer(...)` 的感觉和普通函数调用完全不同
- `from_fn` 明明只是一个函数，为什么能成为中间件
- 为什么很多 tower 的组件能直接拿到 axum 里用
- `Router`、`Service`、`Layer` 到底谁包谁

这些问题如果不搞清楚，axum 很容易被学成“会写一些常用 API，但不知道底层模型”。

而一旦你开始理解 tower，这些原本看起来像零散技巧的东西会突然串起来：

- 中间件为什么能叠加
- 为什么状态、提取器和中间件的边界能划分得这么清楚
- 为什么 axum 能和很多 tower 生态组件自然兼容
- 为什么 `Router` 最后本质上也可以看成一个服务

可以直接先给一句结论：

> axum 更像是一个构建 Web API 的高层框架，而 tower 提供的是更底层、更通用的服务抽象。

换句话说：

> axum 负责把 HTTP Web 开发做得好用，tower 负责定义“请求是如何被服务处理和包装的”。

这篇文章我会尽量不用过于学院派的方式，而是从实际写 axum 时最容易接触到的地方切进去，把这几个问题讲清楚：

1. tower 到底是什么
2. `Service` 和 `Layer` 的核心抽象分别代表什么
3. axum 为什么构建在 tower 之上
4. `middleware::from_fn` 为什么只是更易用的封装
5. `Router::layer` 背后到底发生了什么
6. 为什么理解 tower 后，axum 中间件就不再神秘

如果你已经写过 axum 的中间件、提取器、状态管理、错误处理和认证，这一篇基本就是把这些“会用的能力”反向打通到底层设计的一步。

---

## 一、先别急着看代码：tower 解决的是什么问题？

很多人一开始会把 tower 理解成“Rust Web 框架的某个底层库”。

这个理解不算错，但还不够准确。

tower 真正想解决的问题不是“怎么写 Web 页面”或者“怎么定义路由”，而是更通用的一个问题：

> 一个请求来了，应该怎样交给某个服务处理；以及在这个服务外面，怎样再包上一层又一层通用能力？

注意这里的关键词不是“HTTP 页面”，而是：

- 请求
- 服务
- 包装

这意味着 tower 的抽象天然是通用的。

它可以用于：

- HTTP 服务
- RPC 服务
- 客户端请求链
- 限流、超时、重试、负载均衡等横切能力

也就是说，tower 的视角并不是“这是一个 Web 接口”，而更像是：

> 这是一个接收请求并返回响应的服务单元。

只要你接受这个视角，后面的很多设计都会顺下来。

---

## 二、tower 的第一个核心抽象：`Service`

如果要把 tower 的设计压缩成一句话，那几乎就是：

> `Service` 表示一个可以接收请求并产出响应的东西。

在概念层面，你完全可以先把它理解成：

```text
Request -> Service -> Response
```

只不过 tower 把这件事抽象成了 trait。

先看一个简化理解版：

```rust
trait Service<Request> {
    type Response;
    type Error;
    type Future;

    fn call(&mut self, req: Request) -> Self::Future;
}
```

你不需要一上来就记住完整签名，先抓住最关键的含义就够了：

- 输入一个请求
- 返回一个将来会产出结果的异步任务
- 最终得到响应或者错误

### 2.1 为什么它不是一个普通函数？

很多人第一次看到 `Service` 会想：

“这不就是个 `async fn(Request) -> Result<Response, Error>` 吗？”

某种意义上，是的。

但 trait 的价值在于：

- 它把“可处理请求的对象”统一成一种抽象
- 这样任何符合这个抽象的东西，都可以继续被别的组件包装
- 包装之后，依然还是一个 `Service`

这最后一点非常关键。

因为它意味着：

> 服务可以被包装，而包装之后仍然是服务。

这正是中间件能够层层叠加的根本原因。

---

## 三、tower 的第二个核心抽象：`Layer`

如果 `Service` 解决的是“谁来处理请求”，那 `Layer` 解决的就是：

> 怎么在一个服务外面再包一层逻辑，并返回一个新的服务？

你可以先把它理解成：

```text
old service --layer--> new service
```

也就是说，`Layer` 本身通常不直接处理请求，它做的是“包装服务”。

一个非常粗略的概念模型可以写成这样：

```rust
trait Layer<S> {
    type Service;

    fn layer(&self, inner: S) -> Self::Service;
}
```

它表达的含义是：

- 你先给我一个原始服务 `inner`
- 我把它包起来
- 然后返回一个新的服务

所以如果说 `Service` 更像“执行者”，那 `Layer` 更像“包装器工厂”。

### 3.1 为什么这个抽象对中间件这么重要？

因为中间件从本质上看，从来不是“在 handler 前后插两句代码”这么简单。

更准确地说，中间件是在做这件事：

> 把原来的服务包起来，在请求进入和响应返回时增加额外行为。

所以一旦你理解 `Layer`，就会发现 axum 里这句代码的意味其实很明确：

```rust
.layer(middleware::from_fn(my_middleware))
```

它不是“神奇地把函数插到路由前面”，而是在说：

> 用这个 layer 去包装当前这棵路由服务树。

---

## 四、把 `Service` 和 `Layer` 连起来看

到这里，其实已经能看到 tower 最核心的组合方式了：

1. 有一个原始 `Service`
2. 用一个 `Layer` 去包装它
3. 得到一个新的 `Service`
4. 新的 `Service` 还能继续被下一个 `Layer` 包装

于是就形成了这样的链：

```text
Layer C
  -> Layer B
    -> Layer A
      -> Handler Service
```

请求进入时：

```text
request
 -> Layer C 包出来的 service
 -> Layer B 包出来的 service
 -> Layer A 包出来的 service
 -> handler
```

响应返回时：

```text
handler
 -> Layer A
 -> Layer B
 -> Layer C
 -> response
```

这就是很多人常说的“洋葱模型”。

但如果只说“洋葱模型”，理解其实还停留在形容层面。

一旦你加上 tower 视角，这件事就会变得更具体：

> 每一层中间件，本质上都是一个包装前一个 `Service` 的新 `Service`。

这句话是理解 axum 中间件的核心。

---

## 五、axum 为什么要构建在 tower 之上？

这个问题可以从两个方向回答。

### 5.1 从工程复用角度看

如果 axum 自己重新发明一套“服务 + 中间件”模型，那么它会立刻遇到几个问题：

- 很多通用中间件生态无法复用
- 自己要维护一整套底层抽象
- 其他库很难和它互操作

而 tower 已经给出了比较成熟的抽象：

- `Service`
- `Layer`
- 一整套围绕服务链的生态组件

所以 axum 直接站在 tower 上，能天然获得很多好处：

- 更强的生态兼容性
- 不必重复发明底层模型
- 中间件、超时、限流、重试等能力更容易组合

### 5.2 从职责分层角度看

axum 擅长的是：

- 路由
- 提取器
- 状态管理
- 响应建模
- Web 场景下的开发体验

tower 擅长的是：

- 服务抽象
- 中间件包装
- 通用请求链能力

这两层职责分得其实很自然：

- axum 负责“Web 框架应该好用”
- tower 负责“服务链应该怎么组织”

所以说 axum 构建在 tower 之上，并不是某种历史偶然，而是非常合理的分层。

---

## 六、在 axum 里，什么东西最终是 `Service`？

这是理解 axum 与 tower 关系时非常关键的一步。

很多人会下意识认为，只有 handler 才是“处理请求的东西”。

从业务语义看，这当然没错。

但从 tower 视角看，事情更广：

- 一个 handler 最终可以被适配成 `Service`
- 一个路由项可以是 `Service`
- 整个 `Router` 也可以看成一个 `Service`

也就是说，axum 并不是把 tower 放在某个“隐藏的内部角落”，而是整套路由系统最终都落在了 tower 的服务模型上。

这也是为什么：

- `Router` 能被 `.layer(...)`
- 一些 tower 中间件能直接挂到 axum 上
- axum 最终可以交给底层 server 作为一个服务去跑

所以如果要把这层关系说得再直白一点：

> 在 axum 里，路由树最终也会被组织成一个 tower `Service`。

---

## 七、`middleware::from_fn` 到底是什么？

这是 axum 用户最容易接触到，但也最容易误解的地方之一。

很多人会觉得：

> `from_fn` 就是 axum 中间件本身。

其实更准确的说法应该是：

> `from_fn` 是 axum 提供的一个“把函数适配成中间件 layer”的便捷入口。

例如下面这段熟悉的代码：

```rust
use axum::{
    extract::Request,
    middleware::Next,
    response::Response,
};

async fn access_log(request: Request, next: Next) -> Response {
    println!("before handler");

    let response = next.run(request).await;

    println!("after handler");
    response
}
```

挂载方式：

```rust
use axum::{middleware, routing::get, Router};

async fn ping() -> &'static str {
    "pong"
}

let app = Router::new()
    .route("/ping", get(ping))
    .layer(middleware::from_fn(access_log));
```

这套写法之所以容易用，是因为 axum 已经帮你把这些麻烦事都封装掉了：

- 如何把这个 async 函数包装成 tower 可接受的形式
- 如何生成一个符合中间件语义的 layer
- 如何把 `Next` 适配成“下一个服务”调用入口

所以 `from_fn` 的价值并不是重新定义了中间件模型，而是：

> 它把 tower 风格的中间件包装，变成了更适合日常开发的函数式写法。

---

## 八、为什么 `Next` 看起来像函数调用，其实背后还是服务链？

这是很多人第一次学 axum 中间件时的一个错觉来源。

因为代码长这样：

```rust
let response = next.run(request).await;
```

看起来非常像：

- 调用下一个函数
- 然后拿回结果

但从 tower 视角看，`Next` 背后表达的其实是：

> 调用中间件链中的下一个 `Service`。

也就是说，这里并不是普通意义上的“函数嵌套调用”，而是：

- 当前包装层拿到请求
- 决定是否继续往下传
- 如果继续，就把请求交给内部那个被包装的服务
- 等内部服务返回，再决定怎么处理响应

所以 `Next` 只是一个开发体验层面的简化接口，目的是让你不用亲自处理 tower 那套更底层的服务对象。

这也是为什么学 axum 时，如果只记 `next.run(request).await` 的表面写法，后面很容易模糊；但一旦知道它本质上是在调用“下一个服务”，很多设计就都顺了。

---

## 九、`Router::layer` 和 `route_layer` 为什么会有区别？

理解这个问题，也很依赖 tower 视角。

很多人会把这两个 API 看成只是“作用范围不同”。

这当然是表面现象，但背后更准确的理解是：

- `.layer(...)`：给当前整个路由服务树再包一层
- `.route_layer(...)`：只给当前这条路由对应的服务包一层

换句话说，它们的区别不只是“谁生效”，而是：

> 你到底是在包装哪一个 `Service`。

例如：

```rust
let app = Router::new()
    .route("/public", get(public_handler))
    .route("/private", get(private_handler).route_layer(auth_layer))
    .layer(log_layer);
```

从服务链角度看更像这样：

- `/public`：只被 `log_layer` 包裹
- `/private`：先被 `auth_layer` 包裹，再被 `log_layer` 包裹

理解这一点后，你会对中间件执行顺序、作用范围、组合结果都有更稳的判断。

---

## 十、一个最小化的自定义 `Layer` / `Service` 示例

为了真正看见 tower 模型，我们可以写一个极简版本的自定义层。

这段代码不追求覆盖所有泛型细节，重点是帮助建立形状感。

```rust
use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};
use tower::{Layer, Service};

#[derive(Clone)]
struct LogLayer;

impl<S> Layer<S> for LogLayer {
    type Service = LogService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        LogService { inner }
    }
}

#[derive(Clone)]
struct LogService<S> {
    inner: S,
}

impl<S, Request> Service<Request> for LogService<S>
where
    S: Service<Request> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request) -> Self::Future {
        println!("before inner service");

        let mut inner = self.inner.clone();
        Box::pin(async move {
            let response = inner.call(request).await?;
            println!("after inner service");
            Ok(response)
        })
    }
}
```

先不要被泛型吓到，先看结构：

1. `LogLayer` 负责把 `inner service` 包起来
2. `LogService` 真正持有被包装的内部服务
3. `call()` 里先做前置逻辑，再调用内部服务，再做后置逻辑

这不就是我们平时理解的中间件吗？

是的。

而这正说明：

> axum 中间件背后的真实形状，本质上就是这种“包装服务再返回新服务”的模型。

### 10.1 为什么平时不直接这么写？

因为它过于底层。

在日常写业务时，直接写 tower 级别的 `Layer` / `Service` 有几个现实问题：

- 泛型和 trait 约束比较重
- 心智负担高
- 简单场景下不如 `from_fn` 高效

所以 axum 才会提供更高层的封装。

但理解这段代码的价值在于：

> 它把“中间件不是魔法，而是服务包装”这件事彻底具象化了。

---

## 十一、既然 `from_fn` 很方便，什么时候还需要自己写 `Layer` / `Service`？

绝大多数业务中间件，其实 `from_fn` 就够了。

例如：

- 日志
- 请求 ID 注入
- 简单认证
- 统一 header 补充

这些场景的共同特点是：

- 逻辑相对直接
- 主要围绕一次请求的前后处理
- 不需要非常细粒度地控制服务行为

但如果遇到更底层或更通用的需求，自定义 `Layer` / `Service` 仍然有价值，例如：

- 做一个可复用的 tower 中间件库
- 在多个框架或多个服务端/客户端链中复用同一层逻辑
- 需要和 tower 生态深度集成
- 需要更底层地控制 readiness、包装策略或服务行为

也就是说：

- `from_fn` 更偏“axum 应用开发者友好”
- 自定义 `Layer` / `Service` 更偏“tower 级别扩展能力”

---

## 十二、为什么很多 tower 生态组件能直接接进 axum？

这件事一旦理解了前面的模型，其实就不神秘了。

因为 axum 最终也是在 tower 的服务模型上工作，所以很多 tower 生态里的 layer 天然就能拿来包 axum 的服务。

例如一些常见的 tower HTTP 能力：

- 超时
- 压缩
- trace
- 限流
- 并发限制

从本质上看，它们都在干同一类事情：

> 接受一个服务，包装它，然后返回一个新的服务。

而这恰恰就是 `Layer` 的定义。

所以 axum 与 tower 生态的兼容，并不是靠“额外适配很多特例”实现的，而是因为它们从最底层模型上就是同一套语言。

---

## 十三、理解 tower 后，对前面几篇 axum 内容会有什么帮助？

如果你前面已经写过或读过：

- 中间件
- 提取器
- 状态管理
- 错误处理
- 认证与授权

那么 tower 这层理解会让这些内容的边界变得更稳定。

### 13.1 对中间件的帮助

你会知道中间件不是“插代码”，而是“包装服务”。

### 13.2 对作用范围的帮助

你会更自然地理解：

- 为什么 `.layer(...)` 和 `.route_layer(...)` 不一样
- 为什么中间件顺序会影响执行结果

### 13.3 对生态兼容的帮助

你会知道为什么 tower 生态组件能接进 axum，而不是把它看成“框架作者帮你写了很多特殊支持”。

### 13.4 对扩展能力的帮助

当业务复杂到 `from_fn` 不够用时，你会知道下一步不是“瞎试更复杂的宏”，而是回到 `Layer` / `Service` 这套底层抽象。

---

## 十四、学习 tower 时最常见的几个误区

### 14.1 觉得 tower 是“只有框架作者才需要懂的东西”

这不完全对。

你当然不需要一开始就手写大量 `Service` 实现，但只要你在写 axum 中间件，实际上已经站在 tower 模型之上了。

所以理解 tower 不一定是为了“自己造底层轮子”，而是为了更稳定地理解 axum。

### 14.2 把 `from_fn` 当成中间件本体

它只是便捷入口，不是模型本身。

模型本身仍然是：

- 服务
- 包装服务
- 返回新服务

### 14.3 只记住“洋葱模型”这个比喻

比喻当然有用，但如果没有落到 `Service` / `Layer`，很多执行顺序和组合行为还是会模糊。

### 14.4 一看到自定义 `Layer` / `Service` 就觉得太底层，完全不看

日常开发确实不必频繁自己写，但至少应该知道它们长什么样、解决什么问题。

否则遇到复杂中间件场景时，很容易卡在“API 会用，但原理不懂”的位置上。

---

## 十五、总结

axum 和 tower 的关系，如果要压缩成最关键的一句话，其实就是：

> axum 是面向 Web 开发体验的高层框架，而 tower 提供了它底层依赖的服务与中间件抽象。

如果把这篇文章压缩成几个最重要的结论，大概就是这些：

1. tower 关注的是“请求如何被服务处理，以及服务如何被包装”
2. `Service` 表示一个能接收请求并产出响应的对象
3. `Layer` 表示一个能包装服务并返回新服务的对象
4. axum 中间件本质上不是插代码，而是包装 `Service`
5. `middleware::from_fn` 只是把 tower 风格中间件变得更容易写
6. `Router::layer` 和 `route_layer` 的区别，本质上是谁在包装哪一个服务
7. 理解 tower 之后，axum 的中间件、顺序、作用范围、生态兼容性都会更容易理解

如果你已经写完前面的中间件、提取器、状态管理、错误处理和认证授权，那么这一篇实际上是在做一件非常关键的事：

- 把前面那些“会用的能力”重新统一到底层模型上

这一步做完之后，再去写 axum 项目结构设计或者 axum + sqlx 实战，理解会稳很多。因为你不再只是会调用 API，而是已经知道这些 API 背后的服务链到底是怎么组织起来的。