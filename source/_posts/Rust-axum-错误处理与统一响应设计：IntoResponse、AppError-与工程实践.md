---
title: Rust axum 错误处理与统一响应设计：IntoResponse、AppError 与工程实践
date: 2026-04-19 19:20:59
tags: Rust
---

## 引言

很多人刚学 axum 的时候，会先觉得它的 handler 写起来很舒服。

比如下面这种代码，看起来就很直观：

```rust
use axum::{routing::get, Json, Router};
use serde::Serialize;

#[derive(Serialize)]
struct UserResponse {
    id: u64,
    name: String,
}

async fn get_user() -> Json<UserResponse> {
    Json(UserResponse {
        id: 1,
        name: "chen".to_string(),
    })
}

let app = Router::new().route("/users/1", get(get_user));
```

但是只要接口开始变多，你很快就会遇到这些问题：

- 查询数据库失败了，应该返回什么
- 参数校验失败了，应该返回什么
- 业务上“用户不存在”和系统上“数据库挂了”要不要一样处理
- 前端到底应该收到怎样统一的 JSON 结构
- handler 里是不是要到处写 `StatusCode::INTERNAL_SERVER_ERROR`

如果这些问题没有提前设计，代码通常会迅速变成这样：

- 每个 handler 都在自己拼错误响应
- 响应 JSON 结构一会儿这样，一会儿那样
- 业务错误和系统错误混在一起
- 日志层、接口层、服务层的职责边界越来越模糊

而错误处理这件事，一旦项目长起来，影响的从来不只是“代码好不好看”，还会直接影响：

- 接口一致性
- 排查问题的效率
- 前后端协作成本
- 服务可维护性

在 axum 里，错误处理真正的关键不是背几个返回类型，而是理解下面几层关系：

1. handler 返回值为什么能自动变成 HTTP 响应
2. `Result<T, E>` 在 axum 里是怎么工作的
3. `IntoResponse` 到底扮演什么角色
4. 如何设计自己的 `AppError`
5. 如何做统一成功/失败响应结构
6. 如何把业务错误和系统错误分层

这篇文章我会围绕这几件事展开，尽量把“API 会用”和“工程上该怎么设计”一起讲清楚。

---

## 一、先理解根问题：axum 为什么能把返回值变成响应？

先看两个最常见的 handler：

```rust
async fn ping() -> &'static str {
    "pong"
}
```

```rust
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}
```

这两个函数都没有手动构造 `Response`，但 axum 依然知道怎么把它们返回给客户端。

原因在于：

> axum 并不要求 handler 必须显式返回 `Response`，它只要求返回值能转换成 `Response`。

这层转换能力的核心，就是 `IntoResponse`。

你可以把它先粗略理解为：

> 只要一个类型实现了 `IntoResponse`，axum 就知道如何把它变成 HTTP 响应。

所以：

- `&'static str` 可以作为响应
- `String` 可以作为响应
- `Json<T>` 可以作为响应
- `(StatusCode, String)` 可以作为响应
- 你自己定义的错误类型，只要实现了 `IntoResponse`，也可以作为响应

这就是整个错误处理设计的基础。

---

## 二、为什么 `Result<T, E>` 在 axum 里这么常见？

只要接口稍微有点真实业务，handler 就几乎不可能永远成功。

例如：

- 数据库查询可能失败
- 用户可能不存在
- token 可能无效
- JSON 反序列化可能失败

所以 handler 很自然会写成 `Result<T, E>`。

例如：

```rust
use axum::{http::StatusCode, Json};
use serde::Serialize;

#[derive(Serialize)]
struct UserResponse {
    id: u64,
    name: String,
}

async fn get_user() -> Result<Json<UserResponse>, StatusCode> {
    let user = UserResponse {
        id: 1,
        name: "chen".to_string(),
    };

    Ok(Json(user))
}
```

这段代码之所以成立，不是因为 `Result` 有什么特权，而是因为 axum 能处理这样的规则：

- `Ok(T)`：把 `T` 转成响应
- `Err(E)`：把 `E` 转成响应

前提只有一个：

> `T` 和 `E` 都必须实现 `IntoResponse`。

这句话非常关键，因为它解释了 axum 错误处理的核心机制：

> 在 axum 看来，“错误”本质上也只是另一种响应。

这和很多初学者的直觉不一样。我们平时会把“成功返回”和“错误返回”看成两套完全不同的逻辑，但在 axum 这一层抽象里，它们最后都会被归约成同一件事：

> 生成一个 HTTP 响应。

---

## 三、最基础的错误处理写法

在刚开始写接口时，最常见的做法通常是直接返回状态码或者元组。

例如：

```rust
use axum::{
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Serialize;

#[derive(Serialize)]
struct UserResponse {
    id: u64,
    name: String,
}

async fn get_user() -> Result<Json<UserResponse>, (StatusCode, String)> {
    let found = false;

    if !found {
        return Err((StatusCode::NOT_FOUND, "user not found".to_string()));
    }

    Ok(Json(UserResponse {
        id: 1,
        name: "chen".to_string(),
    }))
}
```

这种写法的优点很明显：

- 简单
- 直接
- 学习成本低

但缺点也会很快暴露：

- 错误结构不统一
- handler 里到处拼字符串
- 业务错误难以复用
- 一旦错误场景变多，代码会迅速散掉

所以这种方式适合 demo，不太适合中型项目。

---

## 四、`IntoResponse` 到底解决了什么？

要真正把 axum 的错误处理吃透，必须对 `IntoResponse` 有更具体的理解。

可以把它理解成一条规则：

> 某个类型如果知道如何把自己变成 HTTP 响应，它就应该实现 `IntoResponse`。

这意味着，`IntoResponse` 并不只用于“正常响应”，也非常适合“错误响应”。

例如我们可以定义一个简单错误类型：

```rust
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

enum AppError {
    NotFound,
    Unauthorized,
    Internal,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFound => {
                (StatusCode::NOT_FOUND, "resource not found").into_response()
            }
            AppError::Unauthorized => {
                (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
            }
            AppError::Internal => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal server error").into_response()
            }
        }
    }
}
```

这样 handler 就可以写成：

```rust
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
struct UserResponse {
    id: u64,
    name: String,
}

async fn get_user() -> Result<Json<UserResponse>, AppError> {
    let found = false;

    if !found {
        return Err(AppError::NotFound);
    }

    Ok(Json(UserResponse {
        id: 1,
        name: "chen".to_string(),
    }))
}
```

和前一种写法相比，它真正的价值不只是“少写点字符串”，而是：

> 错误开始从零散文本，变成系统中的一个明确类型。

这会直接改变整个项目的可维护性。

---

## 五、为什么要自定义 `AppError`？

一旦项目进入真实开发阶段，错误来源就会迅速增多：

- 参数校验错误
- 认证失败
- 资源不存在
- 数据库错误
- 外部服务调用失败
- 内部逻辑异常

如果这些错误都直接在 handler 里用 `(StatusCode, String)` 表达，那么你会很快遇到两个问题：

1. handler 里业务逻辑和错误拼装逻辑混在一起
2. 整个项目没有统一的错误语义模型

自定义 `AppError` 的意义就在于：

> 用类型系统把错误语义收拢起来。

例如：

```rust
enum AppError {
    BadRequest(String),
    Unauthorized(String),
    NotFound(String),
    Conflict(String),
    Internal(String),
}
```

这个设计比直接返回元组更强的地方在于：

- 错误种类是被枚举出来的
- 不同错误可以映射到不同 HTTP 状态码
- 上层调用方可以继续基于错误类型做处理
- 后续接入日志、监控、统一错误码时更容易扩展

### 5.1 一个更实用的 `AppError` 实现

下面给一个更接近工程实践的例子：

```rust
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

enum AppError {
    BadRequest(String),
    Unauthorized(String),
    NotFound(String),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, "BAD_REQUEST", message),
            AppError::Unauthorized(message) => {
                (StatusCode::UNAUTHORIZED, "UNAUTHORIZED", message)
            }
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, "NOT_FOUND", message),
            AppError::Internal(message) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", message)
            }
        };

        (status, Json(ErrorBody { code, message })).into_response()
    }
}
```

这样之后，错误响应就不再只是一个裸字符串，而是一个统一结构的 JSON：

```json
{
  "code": "NOT_FOUND",
  "message": "user not found"
}
```

这一步非常重要，因为从这里开始，你就已经进入“接口规范化”的阶段了。

---

## 六、统一成功响应和失败响应，到底该不该做？

这是一个很常见、也很值得认真回答的问题。

很多团队喜欢把所有接口都包成统一结构，例如：

成功：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "id": 1,
    "name": "chen"
  }
}
```

失败：

```json
{
  "code": 10001,
  "message": "user not found",
  "data": null
}
```

这种设计有没有价值？有。

它的优势通常在于：

- 前端处理逻辑统一
- 业务错误码可控
- 更容易对接内部平台规范

但也有代价：

- 会增加响应封装层级
- 如果设计不清楚，容易和 HTTP 状态码重复表达
- 有些团队最后会把所有错误都包成 200，反而破坏 HTTP 语义

所以更稳妥的思路通常是：

> 保留正确的 HTTP 状态码，同时让 JSON body 保持统一格式。

也就是说：

- 成功时返回 `200/201/...` 和统一成功 body
- 失败时返回 `4xx/5xx` 和统一错误 body

这样可以同时兼顾：

- HTTP 协议语义
- 前后端统一结构
- 监控和排障可读性

---

## 七、如何设计统一响应结构？

一个常见做法是定义统一响应包裹类型：

```rust
use serde::Serialize;

#[derive(Serialize)]
struct ApiResponse<T> {
    code: i32,
    message: String,
    data: Option<T>,
}
```

然后给它加上一些辅助构造函数：

```rust
impl<T> ApiResponse<T> {
    fn success(data: T) -> Self {
        Self {
            code: 0,
            message: "ok".to_string(),
            data: Some(data),
        }
    }
}

impl ApiResponse<()> {
    fn error(code: i32, message: String) -> Self {
        Self {
            code,
            message,
            data: None,
        }
    }
}
```

然后业务成功响应就可以写成：

```rust
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
struct UserDto {
    id: u64,
    name: String,
}

async fn get_user() -> Json<ApiResponse<UserDto>> {
    Json(ApiResponse::success(UserDto {
        id: 1,
        name: "chen".to_string(),
    }))
}
```

### 7.1 成功响应统一，不代表错误也必须手动重复拼装

很多人到这一步会继续在 handler 里手动写：

```rust
Err((StatusCode::NOT_FOUND, Json(ApiResponse::<()>::error(10001, "user not found".to_string()))))
```

这当然能工作，但很快就会变得丑陋。

更好的方式是把这部分逻辑继续塞回 `AppError` 的 `IntoResponse` 实现里。

这样 handler 只负责返回语义化错误：

```rust
return Err(AppError::NotFound("user not found".to_string()));
```

而 HTTP 状态码和 JSON 错误包裹结构，都由错误类型统一决定。

这才是更干净的设计。

---

## 八、一个完整一点的统一错误响应实现

下面给一个相对完整、又不至于太重的实现方式。

```rust
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Serialize)]
struct ApiResponse<T> {
    code: i32,
    message: String,
    data: Option<T>,
}

impl<T> ApiResponse<T> {
    fn success(data: T) -> Self {
        Self {
            code: 0,
            message: "ok".to_string(),
            data: Some(data),
        }
    }
}

impl ApiResponse<()> {
    fn error(code: i32, message: String) -> Self {
        Self {
            code,
            message,
            data: None,
        }
    }
}

enum AppError {
    BadRequest(String),
    Unauthorized(String),
    NotFound(String),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, biz_code, message) = match self {
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, 40001, message),
            AppError::Unauthorized(message) => (StatusCode::UNAUTHORIZED, 40101, message),
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, 40401, message),
            AppError::Internal(message) => {
                (StatusCode::INTERNAL_SERVER_ERROR, 50001, message)
            }
        };

        let body = ApiResponse::<()>::error(biz_code, message);
        (status, Json(body)).into_response()
    }
}
```

这一套设计带来的好处是：

- handler 可以只返回 `Result<T, AppError>`
- HTTP 状态码统一从错误类型推导
- JSON 错误结构统一
- 业务错误码统一

这基本已经是很多项目里很实用的一种中间复杂度方案了。

---

## 九、业务错误和系统错误为什么一定要分层？

这是很多项目刚开始不重视，后面会越来越痛的点。

先看两个错误：

1. 用户不存在
2. 数据库连接失败

它们看起来都属于“失败”，但性质完全不同。

### 9.1 业务错误

业务错误通常是：

- 可以预期
- 属于业务规则的一部分
- 经常需要明确返回给客户端

例如：

- 用户不存在
- 余额不足
- 订单状态不允许取消
- 验证码错误

这类错误通常应该：

- 有明确错误语义
- 有稳定的业务错误码
- 返回可理解的信息

### 9.2 系统错误

系统错误通常是：

- 非业务本意
- 更多是底层故障或异常
- 主要用于日志、排障和监控

例如：

- 数据库超时
- 网络故障
- 第三方服务异常
- 序列化异常

这类错误通常不适合原样暴露给客户端。

原因很简单：

- 信息不稳定
- 容易泄露内部细节
- 对客户端通常没有直接帮助

所以更合理的做法通常是：

- 对外返回统一、安全、稳定的错误信息
- 对内记录详细日志

也就是说：

> 客户端需要的是“可消费的错误语义”，不是你的内部堆栈细节。

---

## 十、如何把服务层错误映射到 `AppError`？

一个比较清晰的分层通常是这样：

- handler 层：HTTP 入参、HTTP 出参、响应格式
- service 层：业务逻辑、业务错误
- repository 或基础设施层：数据库/缓存/外部服务调用

这时错误的映射关系往往会分层发生。

例如：

```rust
enum ServiceError {
    UserNotFound,
    InvalidInput(String),
    DbError,
}
```

然后在 HTTP 层把它转换为 `AppError`：

```rust
impl From<ServiceError> for AppError {
    fn from(err: ServiceError) -> Self {
        match err {
            ServiceError::UserNotFound => {
                AppError::NotFound("user not found".to_string())
            }
            ServiceError::InvalidInput(message) => {
                AppError::BadRequest(message)
            }
            ServiceError::DbError => {
                AppError::Internal("internal server error".to_string())
            }
        }
    }
}
```

之后 handler 就可以很自然地写：

```rust
async fn get_user() -> Result<Json<ApiResponse<UserDto>>, AppError> {
    let user = user_service_get_user().await.map_err(AppError::from)?;
    Ok(Json(ApiResponse::success(user)))
}
```

这种设计的好处是：

- service 层不需要依赖 HTTP 状态码
- HTTP 层统一决定怎么向客户端表达错误
- 业务语义和传输语义被分开了

这通常比“所有层都直接返回 `StatusCode`”健康得多。

---

## 十一、一个更接近真实项目的完整示例

下面给一个相对完整的示例，把统一成功响应、统一错误响应和错误分层串起来。

```rust
use axum::{
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;

#[derive(Serialize)]
struct ApiResponse<T> {
    code: i32,
    message: String,
    data: Option<T>,
}

impl<T> ApiResponse<T> {
    fn success(data: T) -> Self {
        Self {
            code: 0,
            message: "ok".to_string(),
            data: Some(data),
        }
    }
}

impl ApiResponse<()> {
    fn error(code: i32, message: String) -> Self {
        Self {
            code,
            message,
            data: None,
        }
    }
}

#[derive(Serialize)]
struct UserDto {
    id: u64,
    name: String,
}

enum ServiceError {
    UserNotFound,
    DbError,
}

enum AppError {
    NotFound(String),
    Internal(String),
}

impl From<ServiceError> for AppError {
    fn from(err: ServiceError) -> Self {
        match err {
            ServiceError::UserNotFound => {
                AppError::NotFound("user not found".to_string())
            }
            ServiceError::DbError => {
                AppError::Internal("internal server error".to_string())
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, 40401, message),
            AppError::Internal(message) => {
                (StatusCode::INTERNAL_SERVER_ERROR, 50001, message)
            }
        };

        let body = ApiResponse::<()>::error(code, message);
        (status, Json(body)).into_response()
    }
}

async fn user_service_get_user(id: u64) -> Result<UserDto, ServiceError> {
    if id == 1 {
        Ok(UserDto {
            id: 1,
            name: "chen".to_string(),
        })
    } else {
        Err(ServiceError::UserNotFound)
    }
}

async fn get_user(
    Path(id): Path<u64>,
) -> Result<Json<ApiResponse<UserDto>>, AppError> {
    let user = user_service_get_user(id).await?;
    Ok(Json(ApiResponse::success(user)))
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/users/{id}", get(get_user));

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .unwrap();

    axum::serve(listener, app).await.unwrap();
}
```

这个示例虽然不大，但已经体现了一个很重要的分层思路：

- handler 负责 HTTP 层入口和出口
- service 层负责业务结果
- `AppError` 负责最终对外响应

这正是很多可维护项目的基础形态。

---

## 十二、哪些错误不该直接暴露给客户端？

这是实际项目里非常关键的一条线。

很多底层错误从技术上讲当然可以 `to_string()` 后直接返回，但工程上通常不应该这么做。

例如这些信息一般不适合直接暴露：

- 数据库表名
- SQL 语句细节
- 第三方接口地址
- 内部服务拓扑信息
- 堆栈细节

所以像下面这种写法，通常就不太理想：

```rust
map_err(|err| AppError::Internal(err.to_string()))
```

不是说永远不能这么写，而是你至少应该意识到：

> `err.to_string()` 更适合写日志，不一定适合直接发给客户端。

更稳妥的做法通常是：

- 对客户端返回稳定、泛化的错误描述
- 对日志记录完整内部错误详情

例如：

```rust
map_err(|err| {
    tracing::error!(error = %err, "query user failed");
    AppError::Internal("internal server error".to_string())
})
```

这样安全性和排障性都会更好。

---

## 十三、错误处理中最常见的几个坑

### 13.1 handler 到处手写 `(StatusCode, String)`

短期快，长期乱。

一旦接口变多，错误结构会迅速失控。

### 13.2 把所有错误都当成 500

这会让前端失去区分能力，也会让很多本来可预期的业务失败变得模糊。

例如：

- 参数错误应该是 400
- 未认证应该是 401
- 没权限通常是 403
- 资源不存在通常是 404
- 冲突通常是 409

正确使用 4xx 和 5xx，是接口语义的一部分。

### 13.3 为了统一结构，把所有失败都返回 200

这是很多内部系统常见但非常值得警惕的做法。

这样做的短期理由通常是“前端统一处理方便”，但代价很大：

- HTTP 语义失真
- 监控和告警难做
- 网关、代理、APM 工具无法正确识别失败

统一 JSON 结构没有问题，但最好不要牺牲正确的状态码。

### 13.4 业务错误和系统错误不分层

这会导致：

- service 层到处充满 `StatusCode`
- repository 层开始关心 HTTP 语义
- handler 层反而越来越重

一旦看到底层模块开始直接返回 HTTP 状态码，通常就说明分层边界有点歪了。

### 13.5 把内部错误详情直接透传出去

这既不安全，也不稳定，还会让客户端依赖不该依赖的内部实现细节。

---

## 十四、如何判断你的错误设计是不是健康的？

我自己会用下面几个问题做快速判断：

1. handler 是否只返回少量清晰的响应类型，而不是满屏手写元组
2. 业务错误是否有明确的枚举或类型模型
3. 底层错误是否在合适的位置统一映射，而不是到处散落
4. 对客户端的错误信息是否稳定、安全、可消费
5. 是否同时保留了正确的 HTTP 状态码和一致的 JSON 结构

如果这几个问题都能回答得比较稳，那你的错误处理设计通常已经不会太差。

---

## 十五、总结

axum 的错误处理表面上看像是“返回一个 `Result` 就行”，但真正有工程价值的部分在于：

- 用 `IntoResponse` 把响应转换逻辑统一起来
- 用 `AppError` 把错误语义收拢起来
- 用统一 JSON 结构把接口规范稳定下来
- 用分层映射把业务错误和系统错误区分开来

如果把这篇文章压缩成最重要的几个结论，大概就是：

1. axum 里成功和失败最后都会被转换成 HTTP 响应
2. `Result<T, E>` 能工作，是因为 `T` 和 `E` 都可以实现 `IntoResponse`
3. `AppError` 的价值不只是少写代码，而是建立统一错误语义模型
4. 统一响应结构可以做，但最好不要牺牲正确的 HTTP 状态码
5. 业务错误和系统错误要分层，不要让每一层都直接依赖 `StatusCode`
6. 对客户端返回稳定信息，对日志保留详细内部信息，通常是更健康的策略

如果你已经把前面的中间件、提取器、状态管理看完，那么这一篇会把 axum Web 服务里另一块非常关键的工程能力补上：

- 中间件解决横切逻辑
- Extractor 解决输入提取
- State 解决共享依赖
- Error Handling 解决失败路径与响应一致性

再往后继续写，一个非常自然的方向就是认证与授权，或者进一步往底层讲 axum 与 tower 的关系。因为当输入、状态、错误模型都建立起来之后，整个服务的工程骨架其实已经相当完整了。