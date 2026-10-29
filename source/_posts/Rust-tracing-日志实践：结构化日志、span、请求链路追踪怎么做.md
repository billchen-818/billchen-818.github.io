---
title: Rust tracing 日志实践：结构化日志、span、请求链路追踪怎么做
date: 2026-04-24 08:52:55
tags: Rust
---

## 引言

写 Rust 服务写到后面，很多人都会遇到一个很现实的问题：

> 程序明明跑起来了，但一出问题，根本不知道它到底在做什么。

刚开始写 demo 的时候，这个问题通常不明显。

你可能只会写一些简单输出：

```rust
println!("server started");
println!("query user id = {}", user_id);
println!("db error: {:?}", err);
```

在单文件 demo 里，这些输出看起来还能接受。

但只要项目开始变得像一个真正的服务，问题马上就会暴露出来：

- 请求一多，日志互相穿插，根本看不出哪条属于哪个请求
- 异步任务切换之后，日志上下文丢失
- 你能看到一句“查询失败”，但不知道是哪个接口、哪个用户、哪个 request id
- 日志是一大段字符串，后续没法做检索、聚合和统计
- 想看一条请求从入口到数据库调用的完整链路，非常费劲

这些问题说明：

> 真正有工程价值的日志，不是“打印了什么”，而是“是否携带了足够稳定的上下文”。

这也正是 Rust 里 `tracing` 生态解决的问题。

和传统的“只输出一行文本”不同，`tracing` 更强调三件事：

1. 结构化日志：日志不是纯文本拼接，而是带字段的事件
2. span 上下文：一段操作可以带着上下文向下传递
3. 链路追踪：同一条请求在不同函数、不同任务中的日志能串起来

如果你前面已经写过 axum、状态管理、中间件、错误处理，那么这一篇其实是一个非常自然的下一步：

> 把“服务能跑”推进到“服务可观测、可排查、可维护”。

这篇文章我会围绕下面几个问题展开：

1. `tracing` 和普通日志库到底差别在哪
2. 什么是结构化日志，为什么它适合服务端程序
3. `span` 到底是什么，和日志事件是什么关系
4. 如何在 axum 里做请求链路追踪
5. 如何把 request id、用户 id、handler、数据库操作放到同一条上下文里
6. 怎样写出一套“能跑、能看、后面还能接日志平台”的基础方案

文章里会给出一套可运行代码，并尽量解释清楚每一层设计的理由。

---

## 一、先回答根问题：为什么 `println!` 不够用？

很多人第一次接触日志，都不是从日志系统开始，而是从调试输出开始。

这完全正常。

例如：

```rust
println!("create user request arrived");
println!("user id = {}", user_id);
println!("insert user success");
```

这在本地调试时非常直接。

但一旦进入服务端场景，它会出现几个典型问题。

### 1.1 日志缺少统一格式

不同人、不同模块，输出风格通常完全不一样：

- 有人写英文
- 有人写中文
- 有人只打一段文本
- 有人自己拼时间、模块名、参数

最后整个日志流既不整齐，也难以检索。

### 1.2 日志缺少稳定字段

比如你想问：

- 哪个 request 失败了
- 哪个用户调用了这个接口
- 这个错误来自哪个 handler
- 这条日志属于哪一次数据库查询

如果日志只是字符串，这些信息就只能靠肉眼猜。

### 1.3 异步程序天然更依赖上下文

在同步程序里，一段代码通常就是顺着往下执行。

但在异步程序里：

- 任务会切换
- future 会被挂起和恢复
- 不同请求的日志会交错输出

这时你最需要的不是“多打一条日志”，而是：

> 让日志自动带着当前执行上下文一起流动。

### 1.4 日志不只是给人看，也是给系统读的

如果后面你想接入：

- Loki
- Elasticsearch
- Datadog
- OpenTelemetry Collector

那么纯文本日志的价值会很有限。

机器更喜欢的是带字段的结构化日志，例如：

```json
{
  "timestamp": "2026-04-07T10:20:30Z",
  "level": "INFO",
  "request_id": "req_123",
  "user_id": 42,
  "path": "/users/42",
  "message": "query user success"
}
```

这就是为什么工程里越来越倾向于结构化日志。

---

## 二、`tracing` 和传统日志的差别到底是什么？

先给一个非常粗糙但实用的理解：

- `log` 更像“打一条日志”
- `tracing` 更像“在一个带上下文的执行过程里记录事件”

也就是说，`tracing` 不只关心一条文本消息，还关心：

- 当前在哪个 span 里
- 当前 span 带了哪些字段
- 这条事件是在什么上下文里发生的
- 这个上下文能不能继续往下传递

所以在 `tracing` 里，最核心的两个概念就是：

1. `event`
2. `span`

### 2.1 什么是 event？

event 就是一条具体发生的事情。

例如：

```rust
tracing::info!(user_id = 42, "query user success");
```

这条信息里包含两部分：

- 文本消息：`query user success`
- 结构化字段：`user_id = 42`

### 2.2 什么是 span？

span 表示一段带上下文的执行范围。

例如：

```rust
let span = tracing::info_span!("http_request", request_id = %request_id, path = %path);
let _guard = span.enter();
```

你可以先把它理解成：

> 从这里开始，后续在这个范围内发生的日志，都自动带上 `request_id` 和 `path` 这类上下文。

这就是 `tracing` 最有价值的地方：

> 不是你手动给每一条日志都重复拼上 request id，而是上下文自动跟着执行过程往下走。

### 2.3 为什么 span 对 Web 服务特别重要？

因为一次 HTTP 请求天然就是一个“范围”。

例如一条请求会经历：

- 进入路由
- 参数提取
- 调用 service
- 查询数据库
- 组装响应

如果整条请求都有一个共同的 span，那么你在任何一层打日志，都能带上同一个 request id、path、method、user id。

这就是请求链路追踪的基础。

---

## 三、先给一个最小可运行方案

下面先不讲太复杂的整合，先给一套可以直接跑起来的最小项目。

这个示例做几件事：

1. 初始化 `tracing_subscriber`
2. 启动一个 axum 服务
3. 给每条请求生成 request id
4. 为每个请求建立 span
5. 在 handler 和 service 里输出结构化日志

### 3.1 `Cargo.toml`

```toml
[package]
name = "tracing-demo"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "fmt", "json"] }
uuid = { version = "1", features = ["v4"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

### 3.2 `src/main.rs`

```rust
use axum::{
    extract::{MatchedPath, Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::time::sleep;
use tracing::{error, info, info_span, Instrument};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    app_name: Arc<String>,
}

#[derive(Serialize)]
struct UserResponse {
    id: u64,
    name: String,
}

#[derive(Debug)]
enum AppError {
    NotFound,
    Internal,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFound => {
                (StatusCode::NOT_FOUND, "user not found").into_response()
            }
            AppError::Internal => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
            }
        }
    }
}

#[tokio::main]
async fn main() {
    init_tracing();

    let state = AppState {
        app_name: Arc::new("tracing-demo".to_string()),
    };

    let app = Router::new()
        .route("/ping", get(ping))
        .route("/users/{id}", get(get_user))
        .with_state(state)
        .layer(middleware::from_fn(request_context_middleware));

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    info!(%addr, "starting server");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind failed");

    axum::serve(listener, app).await.expect("server failed");
}

fn init_tracing() {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,axum=info,tracing_demo=debug"));

    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            fmt::layer()
                .with_target(true)
                .with_thread_ids(true)
                .with_thread_names(true),
        )
        .init();
}

async fn request_context_middleware(mut request: Request, next: Next) -> Response {
    let request_id = Uuid::new_v4().to_string();
    let method = request.method().clone();
    let path = request
        .extensions()
        .get::<MatchedPath>()
        .map(|matched| matched.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());

    request.extensions_mut().insert(RequestId(request_id.clone()));

    let span = info_span!(
        "http_request",
        request_id = %request_id,
        method = %method,
        path = %path,
    );

    async move {
        info!("request started");

        let mut response = next.run(request).await;
        response.headers_mut().insert(
            "x-request-id",
            HeaderValue::from_str(&request_id).unwrap_or(HeaderValue::from_static("invalid-request-id")),
        );

        info!(status = %response.status(), "request finished");
        response
    }
    .instrument(span)
    .await
}

async fn ping(State(state): State<AppState>) -> Json<serde_json::Value> {
    info!(app_name = %state.app_name.as_ref(), "ping called");
    Json(serde_json::json!({ "message": "pong" }))
}

async fn get_user(
    State(_state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<u64>,
    request_id: RequestId,
) -> Result<Json<UserResponse>, AppError> {
    info!(user_id = id, request_id = %request_id.0, "handler received request");

    let user = find_user(id)
        .instrument(info_span!("find_user", user_id = id))
        .await?;

    info!(user_id = user.id, user_name = %user.name, "handler returning user");
    Ok(Json(user))
}

async fn find_user(id: u64) -> Result<UserResponse, AppError> {
    info!(user_id = id, "query user from service layer");

    sleep(Duration::from_millis(80)).await;

    if id == 404 {
        error!(user_id = id, "user not found in service layer");
        return Err(AppError::NotFound);
    }

    if id == 500 {
        error!(user_id = id, "unexpected database failure");
        return Err(AppError::Internal);
    }

    Ok(UserResponse {
        id,
        name: format!("user-{}", id),
    })
}

#[derive(Clone, Debug)]
struct RequestId(String);

impl<S> axum::extract::FromRequestParts<S> for RequestId
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<RequestId>()
            .cloned()
            .ok_or(AppError::Internal)
    }
}
```

### 3.3 如何运行

```bash
cargo run
```

然后用另一个终端请求：

```bash
curl http://127.0.0.1:3000/ping
curl http://127.0.0.1:3000/users/1
curl http://127.0.0.1:3000/users/404
curl http://127.0.0.1:3000/users/500
```

你会看到类似这样的日志：

```text
INFO http_request{request_id=6bc1... method=GET path=/users/{id}}: request started
INFO http_request{request_id=6bc1... method=GET path=/users/{id}}: handler received request user_id=1 request_id=6bc1...
INFO http_request{request_id=6bc1... method=GET path=/users/{id}}:find_user{user_id=1}: query user from service layer
INFO http_request{request_id=6bc1... method=GET path=/users/{id}}: handler returning user user_id=1 user_name=user-1
INFO http_request{request_id=6bc1... method=GET path=/users/{id}}: request finished status=200 OK
```

注意这里最关键的一点：

> 同一条请求里的日志，已经自动挂在同一个 `http_request` span 下了。

---

## 四、先别急着背 API，先理解这套代码到底解决了什么

如果你只是照着把代码抄下来，确实也能跑。但这篇真正重要的不是“把 subscriber 初始化一下”，而是理解每一层设计在解决什么问题。

### 4.1 `tracing_subscriber` 负责把“记录行为”真正输出出来

`tracing` 只是定义了一套事件和 span 的接口。

真正决定日志如何输出的是 subscriber。

这段代码：

```rust
tracing_subscriber::registry()
    .with(env_filter)
    .with(fmt::layer())
    .init();
```

可以粗略理解成：

- `registry()`：作为整个订阅器根节点
- `EnvFilter`：决定哪些级别、哪些模块要输出
- `fmt::layer()`：决定怎样把事件格式化到终端

如果你没有初始化 subscriber，那么即使代码里写了 `info!`、`warn!`、`error!`，很多时候你也看不到任何输出。

### 4.2 `info!` 不是“拼字符串”，而是在记录字段

例如：

```rust
info!(user_id = id, user_name = %user.name, "handler returning user");
```

这里要注意两点：

- `"handler returning user"` 是人类看的消息
- `user_id = id`、`user_name = %user.name` 是结构化字段

也就是说，日志不再只是：

```text
handler returning user: user-1
```

而是一个带明确键值的事件。

这会直接影响后续：

- 日志可读性
- 日志检索能力
- 对接 JSON 日志平台的便利程度

### 4.3 middleware 建立的是“请求级 span”

这段代码是整篇最核心的地方之一：

```rust
let span = info_span!(
    "http_request",
    request_id = %request_id,
    method = %method,
    path = %path,
);
```

它的含义不是“打印一行请求开始”。

它真正做的是：

> 为当前请求建立一个统一的上下文范围。

后续这个请求里的日志，只要发生在这个 span 内部，就会自动携带：

- `request_id`
- `method`
- `path`

这比你在每一条日志里手动拼接这些字段，要稳得多。

### 4.4 `RequestId` extractor 体现了“上下文注入”的完整链路

前面你已经写过 Extractor 和 Middleware，这里其实是一个非常典型的组合：

1. 中间件生成 request id
2. 把它塞进 request extensions
3. handler 通过自定义 extractor 提取它

也就是说：

> middleware 负责生成上下文，extractor 负责把上下文交给业务函数使用。

这套设计和前面认证文章里“中间件注入用户上下文”的思路几乎完全一致。

---

## 五、什么是结构化日志，为什么它比“整句日志”更适合工程？

“结构化日志”这个词听起来有点抽象，但其实很简单。

先看两种写法的差别。

### 5.1 纯文本日志

```rust
println!("query user success, id={}, name={}", user.id, user.name);
```

输出看起来可能是：

```text
query user success, id=1, name=user-1
```

人眼能看懂，但机器很难稳定解析。

### 5.2 结构化日志

```rust
info!(user_id = user.id, user_name = %user.name, "query user success");
```

输出看起来也许还是一行文本，但底层语义已经不同了：

- 消息是消息
- 字段是字段

后面你如果改成 JSON 输出，效果会更明显：

```json
{
  "timestamp": "2026-04-07T10:20:30Z",
  "level": "INFO",
  "fields": {
    "message": "query user success",
    "user_id": 1,
    "user_name": "user-1"
  }
}
```

### 5.3 结构化日志真正带来的价值

它至少解决三件事：

1. 字段统一

你可以稳定地用：

- `request_id`
- `user_id`
- `path`
- `status`

而不是每个地方自己随手起名字。

2. 方便检索和聚合

例如后面接日志平台时，你就可以直接查询：

- `request_id = xxx`
- `status >= 500`
- `user_id = 42`

3. 机器比人更容易消费

很多时候日志的最终消费者不是开发者本人，而是：

- 告警系统
- 日志检索系统
- 可观测性平台

所以“字段化”非常重要。

---

## 六、span 到底应该怎么用？

很多人第一次学 `tracing`，最大的疑问通常不是 `info!`，而是：

> span 到底什么时候该建，建多大，建几层？

这里有个非常实用的经验：

> span 应该围绕“有独立上下文价值的一段操作”来建。

在 Web 服务里，最常见的几类 span 通常是：

### 6.1 请求级 span

例如：

- request id
- method
- path
- user id

这类字段适合放在最外层请求 span 上。

### 6.2 业务操作级 span

例如：

- `create_order`
- `find_user`
- `refresh_token`

这类 span 适合包裹某个明确业务动作。

### 6.3 外部依赖调用 span

例如：

- 数据库查询
- Redis 调用
- 第三方 HTTP 请求

这类 span 适合定位性能瓶颈和失败点。

所以一个比较健康的层次通常是：

```text
http_request
  -> service_operation
    -> db_query
```

这会比只有一层大 span，或者到处乱建 span，更容易看懂。

### 6.4 `instrument` 非常适合给异步函数挂 span

在异步 Rust 里，一个非常常见的写法是：

```rust
find_user(id)
    .instrument(info_span!("find_user", user_id = id))
    .await?;
```

这行代码的含义是：

> 把这个 future 的执行过程放进 `find_user` 这个 span 里。

这是异步场景下非常自然、也非常推荐的写法。

它比手动 `enter()` 再管理 guard 更不容易出错。

---

## 七、请求链路追踪到底在追什么？

很多人说“链路追踪”，容易直接想到分布式系统、OpenTelemetry、Jaeger。

这些当然都和 tracing 有关系，但如果只从本地服务实践出发，先理解一个更朴素的版本就够了：

> 请求链路追踪，本质上是让同一条请求路径上的关键日志能够被稳定串起来。

例如一个最常见的问题排查流程可能是：

1. 某个接口返回 500
2. 你先拿到 `x-request-id`
3. 根据 `request_id` 检索日志
4. 看到该请求进入了哪个 handler
5. 看到调用了哪个 service
6. 看到在哪一步报错

这就是最基本的链路追踪价值。

### 7.1 为什么 request id 很重要？

因为它是同一条请求最稳定的外部标识。

即使你暂时没有完整接入分布式 trace id，光有 request id 也已经足够解决大量排查问题。

所以通常建议：

- 每条请求都有 request id
- 响应 header 回传 `x-request-id`
- 关键日志都能挂上 request id

这样前端、后端、测试同学排查问题时会方便很多。

### 7.2 路径最好记录“匹配路由”而不是原始 URI

例如：

- 原始路径：`/users/42`
- 匹配路由：`/users/{id}`

为什么后者更重要？

因为你做日志统计和聚合时，更希望知道：

> 是哪个接口模板出了问题，而不是某个具体参数值。

所以示例里用了 `MatchedPath`。

这会让日志在观察层面更稳定。

---

## 八、如何切换到 JSON 日志输出？

开发阶段我们通常更喜欢人眼易读的文本格式。

但如果准备接日志平台，JSON 输出通常更合适。

在 `tracing_subscriber` 里切换也很直接：

```rust
tracing_subscriber::registry()
    .with(env_filter)
    .with(fmt::layer().json())
    .init();
```

这样日志就会更接近：

```json
{
  "timestamp": "2026-04-07T10:20:30.123456Z",
  "level": "INFO",
  "target": "tracing_demo",
  "span": {
    "name": "http_request",
    "request_id": "6bc1...",
    "method": "GET",
    "path": "/users/{id}"
  },
  "fields": {
    "message": "handler returning user",
    "user_id": 1,
    "user_name": "user-1"
  }
}
```

这类日志后续接收集系统时就会非常自然。

通常工程上可以这样做：

- 本地开发：pretty 文本输出
- 测试/生产：JSON 输出

甚至可以通过环境变量控制。

---

## 九、如果想让 handler 自动带 span，可以怎么做？

除了手动用 `info_span!` 和 `instrument(...)`，`tracing` 生态里还常见一种写法：

```rust
#[tracing::instrument(skip(state))]
async fn get_user(
    State(state): State<AppState>,
    Path(id): Path<u64>,
) -> Result<Json<UserResponse>, AppError> {
    // ...
}
```

这会自动为函数建立 span，并记录参数。

它很方便，但要注意几个点：

### 9.1 不是所有参数都适合自动记录

例如这些通常不适合直接打出来：

- 密码
- token
- 大对象
- 整个请求体

所以常见写法是用 `skip(...)` 跳过某些参数。

### 9.2 自动记录不等于自动设计好字段

`instrument` 能帮你省一点样板代码，但字段命名、span 边界、日志粒度，仍然要自己设计。

也就是说：

> 工程化日志的重点从来不是“有没有宏”，而是“上下文设计是否合理”。

---

## 十、日志级别到底该怎么选？

如果日志级别没有设计好，最后通常会出现两种极端：

- 要么全是 `info!`，噪音巨大
- 要么出了问题也没有足够信息

一个比较稳妥的经验是：

### 10.1 `error!`

用于：

- 当前操作明确失败
- 需要重点关注
- 可能触发告警

例如：

- 数据库连接失败
- 下游服务返回不可恢复错误
- 请求处理最终返回 500

### 10.2 `warn!`

用于：

- 不完全正常，但未必是系统故障
- 值得关注但不一定报警

例如：

- 非法参数
- 限流触发
- 可预期但频繁出现的失败

### 10.3 `info!`

用于：

- 重要业务动作
- 请求入口、请求结束
- 对排查问题有帮助，但不算异常

### 10.4 `debug!`

用于：

- 更细节的过程信息
- 开发阶段排查很有用
- 生产环境通常按需打开

### 10.5 `trace!`

用于：

- 非常高频、非常细粒度的底层细节

多数业务代码其实很少需要写到这个级别。

---

## 十一、常见误区

写到这里，再把 `tracing` 最容易踩的坑收束一下。

### 11.1 把 `tracing` 继续当成“高级版 println”

如果你只是把：

```rust
println!("user id = {}", id)
```

改成：

```rust
info!("user id = {}", id)
```

那其实只换了一个宏，没有真正用到结构化日志和 span 的价值。

更合理的写法应该是：

```rust
info!(user_id = id, "query user");
```

### 11.2 到处打日志，但没有字段规范

如果有人写 `uid`，有人写 `user_id`，有人写 `id`，后面检索会非常痛苦。

所以字段命名尽量统一。

### 11.3 span 建得过大或过碎

如果整个程序只有一个超大 span，上下文会很模糊。

如果每一行代码都建一个 span，又会非常嘈杂。

最稳的办法还是围绕：

- 请求
- 业务操作
- 外部依赖调用

这几个层级去建。

### 11.4 直接把敏感信息打进日志

例如：

- token
- 密码
- 身份证号
- 完整手机号

这些信息进入日志后，后续风险会非常高。

所以日志设计其实也是安全设计的一部分。

### 11.5 只打“开始了”，不打“结果如何”

很多日志系统的问题不是没日志，而是日志只有开头，没有收尾。

例如你知道：

- 请求进来了
- 数据库查了

但最后到底是成功、失败、耗时多久，没有记录。

所以通常建议：

- 请求入口有日志
- 请求结束有日志
- 关键操作有结果日志

这样信息链才完整。

---

## 十二、如果后面要接 OpenTelemetry，该怎么看待 `tracing`？

很多人一看到 `tracing`，会马上问：

> 那它和 OpenTelemetry、Jaeger、Zipkin 是什么关系？

可以先用一句话理解：

> `tracing` 是你在 Rust 应用内记录事件和上下文的方式，OpenTelemetry 更像是把这些观测数据导出到外部系统的标准。

也就是说，这篇文章里的实践主要解决的是：

- 应用内部怎么把日志和上下文组织好
- 本地和服务端日志怎么输出得更像工程项目

而如果后面你要做更完整的分布式 trace：

- 跨服务 trace id 传播
- trace 可视化
- span duration 统计

那就可以继续往 OpenTelemetry 方向接。

但这里有个很重要的现实建议：

> 不要一上来就把问题抬到分布式链路平台，先把单服务内的 request id、结构化日志、请求 span 做扎实。

这一步做好了，后面的扩展才会顺。

---

## 十三、最后把主线收住

如果把整篇压缩成一句话，那就是：

> `tracing` 的核心价值，不是“换个日志宏”，而是让日志从离散文本变成带上下文的可观察事件流。

在 Web 服务里，这件事尤其重要，因为一次请求天然就是一条完整链路：

- 请求进入
- 路由命中
- handler 执行
- service 调用
- 数据库或外部依赖访问
- 响应返回

如果这些步骤都没有稳定上下文，排查问题就会非常痛苦。

而一旦你建立了：

- 结构化字段
- 请求级 span
- 业务级 span
- request id 回传

那么日志就不再只是“程序说了几句话”，而会变成一个真正能支撑排查、统计、观测和后续平台接入的基础设施。

这也是为什么 `tracing` 非常值得在 Rust 服务里尽早建立起来。

从实践上讲，一个足够稳妥的起点通常就是这四步：

1. 初始化 `tracing_subscriber`
2. 用结构化字段替代纯文本拼接
3. 为每条请求建立统一 span
4. 用 request id 把入口、业务和响应串起来

做到这一步，你的日志体系就已经和“只会 `println!` 的 demo”有了本质区别。

后面不管是继续扩展到：

- JSON 日志
- Loki / ELK
- OpenTelemetry
- 分布式 trace

都会顺很多。