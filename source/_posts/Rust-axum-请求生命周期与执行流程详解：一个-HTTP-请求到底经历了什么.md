---
title: Rust axum 请求生命周期与执行流程详解：一个 HTTP 请求到底经历了什么
date: 2026-04-14 10:14:12
tags: Rust
---

## 引言

学 axum 的时候，很多知识点通常是分开学的：

- 路由怎么匹配
- Extractor 怎么提取参数
- Middleware 怎么拦截请求
- `State<T>` 怎么注入共享依赖
- handler 怎么返回响应
- 错误为什么能自动变成 HTTP 响应

单看每一块都不算难，但很多人学到后面会遇到一个更本质的问题：

> 一个 HTTP 请求从进入 axum 到最终返回响应，中间到底经历了什么？

这个问题如果不彻底搞清楚，前面那些知识点就很容易变成“分散的 API 记忆”，而不是一条完整链路。

例如下面这些困惑，本质上都在问同一件事：

- 路由匹配是在中间件前还是中间件后发生
- `Path`、`Query`、`Json` 到底什么时候提取
- 为什么 body 提取器不能随便写多个
- `State` 是在哪一步拿到的
- handler 抛出的错误是在哪一层变成响应的
- 中间件到底包的是 handler，还是整个路由树

这些问题如果单个去答，当然都能答；但一旦放回“请求生命周期”这条主线里，理解会稳很多。

所以这篇文章的目标很明确：

> 不再只讲单个功能点，而是从一个请求的完整生命周期出发，把 axum 里最核心的执行链路串起来。

这篇会重点回答下面这些问题：

1. 一个请求进入 axum 后，先发生什么
2. 路由匹配在整个流程里的位置是什么
3. Middleware 和 Extractor 各自处于哪一层
4. handler 参数是什么时候被提取出来的
5. handler 返回值和错误是怎么转换成响应的
6. 响应返回时又会经历哪些层

如果你已经看过前面的中间件、提取器、状态管理、错误处理、认证、tower 和 sqlx 实战，这一篇基本就是把整套知识连成一条完整运行链路的收束篇。

---

## 一、先给结论：一次请求的主干流程长什么样？

先不陷入细节，先看整体形状。

对于一个典型的 axum 应用，一次请求大致会经历下面这条链：

```text
客户端请求
  -> 外层中间件
  -> Router 路由匹配
  -> 某条路由上的中间件
  -> Extractor 提取参数
  -> handler 执行业务逻辑
  -> 返回值 / 错误 转换成 Response
  -> 中间件后置处理
  -> 响应返回客户端
```

如果你更喜欢“洋葱模型”的视角，也可以理解成：

- 请求进入时，一层层往里走
- 响应返回时，再一层层往外走

但这里有一个非常重要的补充：

> 并不是所有事情都只是“包一层”。

因为路由匹配、参数提取、handler 调用、错误转响应，这些都分别发生在不同节点上。

所以更准确的理解方式不是一句“洋葱模型”就结束，而是：

> 中间件负责包裹服务链，Extractor 负责在 handler 调用前准备输入，handler 负责业务逻辑，响应转换负责把结果收束成 HTTP Response。

---

## 二、请求进入应用的第一站：最外层服务链

如果你前面已经看过 tower 那篇，这里会非常自然。

axum 应用最终会被组织成一棵 tower `Service` 树。也就是说，从底层视角看，请求进来之后，并不是“直接冲进某个 handler”，而是：

> 先进入当前应用对应的服务链。

如果你给整个 `Router` 挂过 `.layer(...)`，那么这些 layer 包出来的服务就是最外层入口。

例如：

```rust
let app = Router::new()
    .route("/users/{id}", get(get_user))
    .layer(log_layer)
    .layer(trace_layer);
```

从执行链角度看，请求不是直接进 `get_user`，而是先进入：

- 最外层 `trace_layer` 包出来的服务
- 再进入 `log_layer` 包出来的服务
- 再进入内部的路由服务

所以第一步一定要建立这个意识：

> 请求进入 axum 时，首先面对的不是 handler，而是整棵被 layer 包裹过的服务树。

---

## 三、路由匹配到底发生在什么时候？

这是很多人第一次系统思考生命周期时最关心的点。

结论先说：

> 在进入 Router 对应的内部服务后，axum 才会根据请求的方法和路径去做路由匹配。

也就是说，路由匹配并不是一个“独立于服务链之外的神秘过程”，它本身就是 Router 这个服务内部要做的事。

例如：

```rust
let app = Router::new()
    .route("/users/{id}", get(get_user))
    .route("/articles/{id}", get(get_article));
```

当请求进来时，Router 会根据：

- HTTP method
- 路径模式

去决定当前应该进入哪一个路由分支。

所以从生命周期上看，可以先粗略理解成：

1. 请求进入外层服务链
2. 到达 Router
3. Router 决定命中哪条路由
4. 再进入这条路由对应的内部处理逻辑

### 3.1 如果路由没匹配上会怎样？

如果没有任何路由匹配成功，axum 就会直接生成对应的错误响应，例如常见的：

- `404 Not Found`
- 某些情况下的方法不匹配也可能体现为路由层面的失败

这意味着：

> 请求并不一定会走到 handler；很多请求会在更前面的路由阶段就结束。

---

## 四、`layer(...)` 和 `route_layer(...)` 在生命周期里分别处于哪里？

这一点如果放回请求链里看，会比单独背 API 名字清楚得多。

### 4.1 `Router::layer(...)`

这个 layer 包的是当前整个 Router 服务树。

所以它的位置更靠外。

它适合做的事情通常是：

- 全局日志
- trace
- 超时
- 压缩
- 跨域

也就是说，请求往往会先经过这些“全局层”，再进入具体路由匹配。

### 4.2 `route_layer(...)`

这个 layer 包的是某一条具体路由对应的服务。

所以它的位置更靠内，往往是在：

- Router 已经匹配到这条路由之后
- handler 真正执行之前

这就是为什么认证中间件特别适合写成：

```rust
get(profile).route_layer(middleware::from_fn(auth_middleware))
```

因为它只作用于某条受保护路由，而不是整个应用。

### 4.3 把它们放回完整链路里

如果有下面这个应用：

```rust
let app = Router::new()
    .route("/public", get(public_handler))
    .route(
        "/profile",
        get(profile).route_layer(middleware::from_fn(auth_middleware)),
    )
    .layer(middleware::from_fn(log_middleware));
```

那么访问 `/profile` 的生命周期会更接近这样：

```text
request
 -> log_middleware
 -> Router 路由匹配到 /profile
 -> auth_middleware
 -> Extractor
 -> profile handler
 -> 响应返回
 -> auth_middleware 后置逻辑
 -> log_middleware 后置逻辑
```

这个顺序一旦建立，很多问题就会清楚很多。

---

## 五、Extractor 是在什么时候执行的？

如果说路由匹配解决的是“去哪一个 handler”，那 Extractor 解决的就是：

> 在调用这个 handler 之前，先把它需要的输入参数准备好。

例如这个 handler：

```rust
async fn get_user(
    Path(id): Path<u64>,
    Query(query): Query<UserQuery>,
    State(state): State<AppState>,
    user: CurrentUser,
) -> Json<UserResponse> {
    // ...
}
```

这意味着在真正调用 `get_user(...)` 之前，axum 必须先做这些事：

- 从路径里解析 `id`
- 从 query string 里解析 `query`
- 从应用状态里提取 `state`
- 从 request extensions 里提取 `CurrentUser`

所以 Extractor 的位置非常明确：

> 它发生在路由已经匹配成功之后、handler 真正执行之前。

### 5.1 为什么说 Extractor 不是中间件？

因为它们的职责完全不同。

中间件是在包裹整个服务处理链：

- 可以决定是否放行
- 可以在请求前后都做事情

Extractor 是在为当前 handler 准备参数：

- 更像输入装配
- 不负责包裹整条请求链

所以它们虽然都发生在 handler 之前，但处在不同抽象层。

---

## 六、`Path`、`Query`、`State`、`Json` 的提取顺序该怎么理解？

很多人会问：

> 这些参数到底谁先执行？

如果从使用者视角看，最重要的不是死记某个“源码层面的精确顺序”，而是理解两件事：

1. 它们都发生在 handler 调用前
2. body 提取器和非 body 提取器在语义上必须区分开

例如：

- `Path`、`Query`、`State`、请求头、extensions 这类提取通常不消费 body
- `Json`、`Form`、`Bytes`、`String` 这类提取通常会消费 body

这就解释了一个非常重要的限制：

> 请求体通常只能被消费一次。

所以像下面这种写法就很危险：

```rust
async fn wrong_handler(
    Json(a): Json<A>,
    body: String,
) {
    // 两者都要读 body
}
```

并不是因为“参数太多”，而是因为：

- `Json<A>` 需要读 body
- `String` 也需要读 body

而 body 不是可以随便重复读的普通值。

所以在请求生命周期里，body 提取器之所以特殊，不是因为它更高级，而是因为它有资源消费约束。

---

## 七、`State<T>` 是在哪一步拿到的？

`State<T>` 很容易被误解成某种“全局变量读取”。

其实从生命周期看，它只是 handler 参数准备阶段的一部分。

也就是说，在路由匹配完成之后、handler 真正执行之前，axum 会把 Router 上挂着的状态按类型提取出来，交给参数列表中的 `State<T>`。

这说明两点：

1. `State<T>` 本质上也是 Extractor
2. 它属于应用级共享依赖注入，而不是请求级上下文注入

这也是为什么：

- 数据库连接池适合放在 `State`
- 当前登录用户不适合放在 `State`

因为它们分别属于两种完全不同的生命周期。

---

## 八、认证用户上下文是在流程里的哪一站进入 handler 的？

这个问题很适合把前面的认证和 Extractor 内容串起来。

典型流程通常是这样的：

1. 请求进入认证中间件
2. 中间件校验 token 或 JWT
3. 中间件解析出 `CurrentUser`
4. 中间件把 `CurrentUser` 写入 request extensions
5. 请求继续往下走
6. 当前路由的 handler 参数里声明了 `user: CurrentUser`
7. 自定义 Extractor 从 extensions 里把它取出来

也就是说：

- 用户身份确认发生在中间件阶段
- 用户参数提取发生在 Extractor 阶段

这两个步骤不是重复，而是分工：

- Middleware 负责“把用户上下文准备好”
- Extractor 负责“把准备好的上下文变成 handler 参数”

这就是为什么前面一直强调：

> 中间件做认证，Extractor 做参数注入，handler / service 做授权。

把这三层拆开以后，请求链就非常清楚了。

---

## 九、handler 是什么时候真正被调用的？

只有当下面这些条件都满足后，handler 才会真正执行：

1. 请求成功通过外层中间件
2. Router 成功匹配到具体路由
3. 路由级中间件没有提前拦截
4. handler 所需 Extractor 全部提取成功

这意味着：

> handler 从来不是“请求一进来就立刻执行”的。

而是整个请求链路经过多轮检查、提取、包装之后，最终才真正进入业务函数。

这也是为什么很多错误根本不是在 handler 里出现的。

例如：

- 路由不匹配
- JSON 解析失败
- 缺少认证上下文
- 中间件直接返回 401

这些情况都可能让请求在到达 handler 之前就结束。

---

## 十、handler 返回值是怎么变成响应的？

一旦 handler 真的执行了，接下来就进入“结果收束”阶段。

例如 handler 可能返回：

- `String`
- `Json<T>`
- `(StatusCode, Json<T>)`
- `Result<T, AppError>`

这时候 axum 会做的事情可以概括成一句话：

> 把 handler 返回值转换成标准 HTTP Response。

这背后的核心机制就是前面讲过的 `IntoResponse`。

也就是说，无论 handler 返回的是成功值还是错误值，最后都要落到同一个终点：

> 变成一个 `Response`。

### 10.1 为什么 `Result<T, E>` 能工作？

因为对 axum 来说：

- `Ok(T)`：把 `T` 转成响应
- `Err(E)`：把 `E` 转成响应

前提只是：

- `T: IntoResponse`
- `E: IntoResponse`

所以错误并不是某种“脱离响应系统的特殊东西”，它本质上也是另一种响应路径。

这对理解请求生命周期非常重要，因为它说明：

> 失败路径和成功路径，在收束阶段会重新汇合到 Response 上。

---

## 十一、错误到底是在哪一层变成 HTTP 响应的？

这个问题值得单独讲，因为它经常被模糊化。

如果说得足够精炼，答案其实是：

> 在某个阶段一旦拿到了一个实现了 `IntoResponse` 的错误值，它就已经可以被收束为 HTTP 响应。

这件事可能发生在多个位置：

### 11.1 中间件阶段

例如认证失败：

```rust
return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
```

这时请求根本不会继续走向 handler。

### 11.2 Extractor 阶段

例如：

- `Json<T>` 反序列化失败
- 自定义 `CurrentUser` Extractor 没拿到用户上下文

这时 handler 也不会执行，而错误会被直接转换成响应。

### 11.3 handler / service 阶段

例如：

- 用户不存在
- 参数业务校验失败
- 数据库出错后映射为 `AppError`

这时错误会在 handler 返回 `Result<_, AppError>` 时被收束成响应。

所以更完整的理解应该是：

> “错误变成 HTTP 响应”不是只发生在某一层，而是任何一层只要产出了可转响应的错误，都可能在那里结束本次请求。

---

## 十二、响应返回时，中间件后置逻辑是怎么执行的？

这是“洋葱模型”真正直观的地方。

以一个典型中间件为例：

```rust
async fn log_middleware(request: Request, next: Next) -> Response {
    println!("before");

    let response = next.run(request).await;

    println!("after");
    response
}
```

这里的流程其实很清楚：

1. 请求进入当前中间件
2. 执行前置逻辑 `before`
3. 调用 `next.run(request).await` 进入下一层
4. 下一层返回响应
5. 当前中间件继续执行后置逻辑 `after`
6. 把响应返回给更外层

所以响应返回并不是“一步跳回客户端”，而是沿着请求进入时的反方向一层层退出来。

这也是为什么：

- 日志统计能拿到耗时
- trace 中间件能补充响应信息
- 一些统一 header 注入可以放在返回路径上做

---

## 十三、把所有环节串成一个完整例子

下面给一个简化后的完整链路示意，把前面几篇内容放到同一条请求路径里。

假设应用大致长这样：

```rust
let app = Router::new()
    .route(
        "/users/{id}",
        get(get_user).route_layer(middleware::from_fn(auth_middleware)),
    )
    .layer(middleware::from_fn(log_middleware))
    .with_state(app_state);
```

handler 长这样：

```rust
async fn get_user(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<UserDto>>, AppError> {
    let user_dto = state.user_service.get_user(id, user.user_id).await?;
    Ok(Json(ApiResponse::success(user_dto)))
}
```

那么一次 `GET /users/42` 的流程可以近似理解成：

```text
1. 请求进入最外层 log_middleware
2. log_middleware 前置逻辑开始计时
3. 请求进入 Router
4. Router 匹配到 /users/{id}
5. 请求进入该路由上的 auth_middleware
6. auth_middleware 校验 token
7. auth_middleware 把 CurrentUser 写入 request extensions
8. auth_middleware 调用 next
9. axum 开始为 get_user 准备参数
10. 提取 State<AppState>
11. 提取 CurrentUser
12. 提取 Path(id)
13. 调用 get_user handler
14. handler 调用 service
15. service 调用 repository / 数据库
16. 成功返回 UserDto，或返回 AppError
17. handler 返回 Json(...) 或 Err(AppError)
18. axum 把返回值转成 HTTP Response
19. 回到 auth_middleware 后置路径
20. 回到 log_middleware 后置路径，记录耗时
21. 响应返回客户端
```

这条链路一旦建立，前面那些零散知识点就都能挂到正确位置上了。

---

## 十四、理解请求生命周期后，哪些常见困惑会自动消失？

### 14.1 为什么 body 提取器不能乱写多个？

因为参数提取发生在 handler 调用前，而 body 是一次性资源。

### 14.2 为什么中间件顺序会影响结果？

因为它们本质上是在一层层包装服务，顺序不同，进入和返回路径都不同。

### 14.3 为什么认证失败时 handler 根本不会执行？

因为请求在中间件阶段就已经被提前终止了。

### 14.4 为什么 `CurrentUser` 更适合放 extensions，而不是 `State`？

因为它属于请求级上下文，不属于应用级共享依赖。

### 14.5 为什么错误不一定是在 handler 里产生的？

因为路由匹配、Extractor、中间件本身都可能提前结束请求并生成响应。

---

## 十五、最容易踩的几个生命周期理解误区

### 15.1 以为请求一进来就会先执行 handler

实际上在 handler 前面还有：

- 外层服务链
- 路由匹配
- 路由级中间件
- 参数提取

### 15.2 把中间件和 Extractor 看成同一类东西

它们都发生在 handler 前，但职责不同：

- Middleware 包裹服务链
- Extractor 准备参数输入

### 15.3 以为错误只会在 handler 里出现

实际上很多失败都发生在 handler 之前。

### 15.4 只记 API，不记链路位置

如果只会背：

- `Path`
- `Json`
- `layer`
- `route_layer`
- `IntoResponse`

但不知道它们分别处在哪一站，后面一旦项目复杂，就很容易混乱。

---

## 十六、总结

如果把 axum 的请求生命周期压缩成一句最核心的话，其实就是：

> 请求先穿过服务链和路由系统，再由 Extractor 为 handler 准备输入，handler 执行业务逻辑后，结果再被统一收束成 Response 并沿中间件链返回。

如果把这篇文章压缩成几个最重要的结论，大概就是这些：

1. 请求进入 axum 后，首先面对的是被 layer 包裹过的服务链，而不是直接进入 handler
2. Router 在服务链内部负责路由匹配，只有匹配成功才会进入对应路由分支
3. `Router::layer(...)` 和 `route_layer(...)` 的区别，本质上是谁在包装哪一层服务
4. Extractor 发生在路由匹配成功之后、handler 调用之前
5. `State` 属于应用级依赖注入，`CurrentUser` 这类上下文更属于请求级注入
6. body 提取器之所以特殊，是因为 body 通常只能被消费一次
7. 错误可以在中间件、Extractor、handler 等多个阶段产生，并在当场被收束成响应
8. 响应返回时，会沿着中间件链反向退回，所以后置逻辑总是在 `next.run(...).await` 之后执行

如果你已经把前面的中间件、提取器、状态管理、错误处理、认证、tower、sqlx 实战都看完，那么这一篇其实就是整套 axum 系列的“总流程图”。

因为到这里，你已经不只是知道某个 API 怎么写，而是已经能把一个请求在 axum 里的整条路径从头讲到尾了。这种理解方式，比单独记住十几个 API 要稳得多，也更接近真正做项目时需要的心智模型。
