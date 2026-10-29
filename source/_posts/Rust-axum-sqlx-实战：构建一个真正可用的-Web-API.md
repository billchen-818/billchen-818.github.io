---
title: Rust axum + sqlx 实战：构建一个真正可用的 Web API
date: 2026-04-22 08:31:37
tags: Rust
---

## 引言

学 axum 的时候，很多人很快能把路由、提取器、中间件写起来；学 sqlx 的时候，也能很快跑通数据库连接和基本查询。

但只要一到真正做 Web API，问题立刻就不再是“某个单点 API 会不会用”，而是：

> axum 和 sqlx 到底应该怎么一起组织，才能写出一个像样的服务？

例如这些问题，几乎每个项目都会碰到：

- 数据库连接池应该怎么注入到 handler
- handler 能不能直接写 SQL
- service、repository 要不要分层
- 事务应该放在哪一层处理
- 查询失败、资源不存在、参数非法应该怎么映射成 HTTP 错误
- 如何避免 `main.rs` 越写越大

如果这些问题没有设计好，项目通常很快会滑向两个极端：

- 要么为了快，把所有逻辑都塞进 handler
- 要么一开始就过度设计，写一大堆抽象但跑不动业务

真正可维护的方案，通常不是这两个极端里的任何一个，而是：

> 在足够简单和足够清晰之间找到平衡。

axum 和 sqlx 其实非常适合做这件事。

因为它们分别擅长不同层面：

- axum 擅长 HTTP 层、路由层、提取器和响应模型
- sqlx 擅长数据库访问、连接池、事务和类型映射

只要边界划分得当，这两者可以组合得非常顺手。

这篇文章我会围绕一个“用户接口”的小实战，把下面这些问题串起来：

1. axum + sqlx 的最基本集成方式
2. 连接池为什么适合放进 `State`
3. handler、service、repository 怎么分工
4. 查询和写入接口应该怎么组织
5. 事务应该放在哪一层处理
6. 常见错误如何映射成 HTTP 响应
7. 初学者最容易踩的坑有哪些

如果你已经写过前面的状态管理、错误处理、认证、tower 原理篇，这一篇基本就是往真正项目落地的关键一步。

---

## 一、先回答根问题：为什么 axum + sqlx 这么常见？

先不谈生态热度，先看它们在职责上的契合度。

对于一个典型的 Web API 服务，通常会有这样几层事情：

1. 收到 HTTP 请求
2. 解析路径参数、查询参数、JSON body
3. 执行业务逻辑
4. 查询或修改数据库
5. 返回 HTTP 响应

而 axum 和 sqlx 刚好分别对其中不同部分做得很舒服：

- axum 负责第 1、2、5 层
- sqlx 主要负责第 4 层
- 第 3 层则由你自己的 service 层来组织

所以从架构上看，这个组合天然就比较干净：

- Web 层不需要知道太多数据库细节
- 数据访问层不需要依赖 HTTP 抽象
- 业务逻辑可以放在中间层承上启下

这也是为什么很多 Rust API 项目会很自然地走向 `axum + sqlx` 这个组合。

---

## 二、先看最小可用集成：连接池怎么注入到 axum？

最基础的落地方式其实不复杂：

1. 应用启动时创建数据库连接池
2. 把连接池放进 `AppState`
3. 用 `with_state(...)` 挂到 Router
4. handler 里通过 `State<AppState>` 提取连接池

例如：

```rust
use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use sqlx::PgPool;

#[derive(Clone)]
struct AppState {
    db: PgPool,
}

#[derive(Serialize)]
struct UserDto {
    id: i64,
    name: String,
}

async fn get_user(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<UserDto>, String> {
    let row = sqlx::query_as::<_, (i64, String)>(
        "select id, name from users where id = $1"
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .map_err(|err| err.to_string())?;

    Ok(Json(UserDto {
        id: row.0,
        name: row.1,
    }))
}
```

这个版本已经足够把 axum 和 sqlx 接起来了。

但如果项目稍微长一点，这种写法也会马上暴露问题：

- handler 里直接写 SQL
- handler 同时处理 HTTP、数据库、错误映射
- 一旦接口变多，复制逻辑会越来越多

所以它适合作为“起点”，但通常不应该是“终点”。

---

## 三、为什么连接池适合放在 `State` 里？

如果你前面已经看过状态管理那篇，这里会很自然。

数据库连接池具有几个典型特点：

- 应用启动时创建
- 生命周期覆盖整个服务进程
- 会被多个请求共享使用
- 本身就是为并发访问设计的

这几条几乎完全符合应用级共享状态的定义。

所以它非常适合放进 `AppState`。

例如：

```rust
#[derive(Clone)]
struct AppState {
    db: sqlx::PgPool,
}
```

这里有一个非常值得强调的点：

> 连接池不是“单个数据库连接”，而是“可并发共享的连接管理器”。

所以在大多数情况下，你不需要再给它外面套一层 `Mutex`。

错误方向往往像这样：

```rust
// 通常没有必要
Arc<Mutex<PgPool>>
```

这会平白增加锁竞争，还破坏连接池本身的设计初衷。

---

## 四、handler、service、repository 到底怎么分层？

这是 axum + sqlx 实战里最关键的设计问题之一。

很多人一开始会问：

> 我是不是一定要严格三层架构？

答案不是绝对的。

更重要的问题其实是：

> 哪些职责应该分开，哪些不用一上来就拆得过细？

一个很实用、也很适合中小项目的划分方式通常是：

### 4.1 handler 层

负责：

- 接收 HTTP 请求
- 提取 Path / Query / Json / State
- 调用 service
- 返回 HTTP 响应

不适合负责：

- 大量业务判断
- 复杂 SQL 拼装
- 事务编排

### 4.2 service 层

负责：

- 承载业务逻辑
- 编排多个数据操作
- 决定事务边界
- 返回业务错误

### 4.3 repository 层

负责：

- 和数据库直接交互
- 查询、插入、更新、删除
- 把数据映射成领域对象或 DTO

这三层不是为了“看起来高级”，而是为了避免 handler 变成混合怪。

一旦某个接口稍微复杂一点，你就会明显感觉到分层的价值。

---

## 五、一个更像真实项目的目录和结构

先给一个很常见、也比较稳妥的项目结构示意：

```text
src/
  main.rs
  app_state.rs
  error.rs
  response.rs
  user/
    mod.rs
    handler.rs
    service.rs
    repository.rs
    model.rs
```

大致分工可以是：

- `main.rs`：启动应用、初始化连接池、组装路由
- `app_state.rs`：定义 `AppState`
- `error.rs`：统一错误类型
- `response.rs`：统一响应结构
- `user/handler.rs`：用户相关 HTTP 入口
- `user/service.rs`：用户业务逻辑
- `user/repository.rs`：用户数据库访问
- `user/model.rs`：请求/响应对象和数据库模型

当然，小项目不必强行拆得这么细，但这个方向通常比“所有东西都塞进 main.rs”健康得多。

---

## 六、先搭一个完整示例：用户查询与创建接口

下面给一个稍微完整一点的例子，把查询、创建、错误处理和状态注入都串起来。

### 6.1 依赖

先看 `Cargo.toml`：

```toml
[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "postgres"] }
tracing = "0.1"
tracing-subscriber = "0.3"
```

### 6.2 完整示例代码

```rust
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    user_service: Arc<UserService>,
}

#[derive(Clone)]
struct UserService {
    repo: UserRepository,
}

impl UserService {
    async fn get_user(&self, id: i64) -> Result<UserDto, AppError> {
        self.repo.find_by_id(id).await
    }

    async fn create_user(&self, input: CreateUserRequest) -> Result<UserDto, AppError> {
        if input.name.trim().is_empty() {
            return Err(AppError::BadRequest("name cannot be empty".to_string()));
        }

        if input.email.trim().is_empty() {
            return Err(AppError::BadRequest("email cannot be empty".to_string()));
        }

        self.repo.insert(input).await
    }
}

#[derive(Clone)]
struct UserRepository {
    db: PgPool,
}

impl UserRepository {
    async fn find_by_id(&self, id: i64) -> Result<UserDto, AppError> {
        let row = sqlx::query_as::<_, (i64, String, String)>(
            "select id, name, email from users where id = $1"
        )
        .bind(id)
        .fetch_optional(&self.db)
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "query user by id failed");
            AppError::Internal("internal server error".to_string())
        })?;

        let row = row.ok_or_else(|| AppError::NotFound("user not found".to_string()))?;

        Ok(UserDto {
            id: row.0,
            name: row.1,
            email: row.2,
        })
    }

    async fn insert(&self, input: CreateUserRequest) -> Result<UserDto, AppError> {
        let row = sqlx::query_as::<_, (i64, String, String)>(
            "insert into users (name, email) values ($1, $2) returning id, name, email"
        )
        .bind(&input.name)
        .bind(&input.email)
        .fetch_one(&self.db)
        .await
        .map_err(|err| {
            tracing::error!(error = %err, "insert user failed");
            AppError::Internal("internal server error".to_string())
        })?;

        Ok(UserDto {
            id: row.0,
            name: row.1,
            email: row.2,
        })
    }
}

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
    NotFound(String),
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, 40001, message),
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, 40401, message),
            AppError::Internal(message) => {
                (StatusCode::INTERNAL_SERVER_ERROR, 50001, message)
            }
        };

        let body = ApiResponse::<()>::error(code, message);
        (status, Json(body)).into_response()
    }
}

#[derive(Serialize)]
struct UserDto {
    id: i64,
    name: String,
    email: String,
}

#[derive(Deserialize)]
struct CreateUserRequest {
    name: String,
    email: String,
}

async fn get_user(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ApiResponse<UserDto>>, AppError> {
    let user = state.user_service.get_user(id).await?;
    Ok(Json(ApiResponse::success(user)))
}

async fn create_user(
    State(state): State<AppState>,
    Json(payload): Json<CreateUserRequest>,
) -> Result<(StatusCode, Json<ApiResponse<UserDto>>), AppError> {
    let user = state.user_service.create_user(payload).await?;
    Ok((StatusCode::CREATED, Json(ApiResponse::success(user))))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let db = PgPool::connect("postgres://postgres:postgres@localhost/app")
        .await
        .unwrap();

    let repo = UserRepository { db };
    let service = UserService { repo };

    let state = AppState {
        user_service: Arc::new(service),
    };

    let app = Router::new()
        .route("/users/{id}", get(get_user))
        .route("/users", post(create_user))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .unwrap();

    axum::serve(listener, app).await.unwrap();
}
```

这个例子虽然不大，但已经把一条比较健康的主线串起来了：

- `AppState` 放共享 service
- handler 只处理 HTTP 层
- service 做业务校验
- repository 负责 SQL 与数据库交互
- `AppError` 统一对外错误模型

这比把所有逻辑都写在一个 handler 里稳定得多。

---

## 七、为什么不建议一开始就在 handler 里写大量 SQL？

不是说绝对不能写，而是随着项目变大，它几乎一定会带来下面这些问题：

- handler 同时处理 HTTP、SQL、错误映射、业务逻辑
- 代码复用变差
- 测试边界不清楚
- SQL 调整时要在多个 handler 里同步修改

一个小接口里，直接在 handler 写一两条 SQL 还能接受；但只要出现下面这些情况，就应该考虑抽出去：

- 同一类查询被多个接口复用
- 有非平凡业务校验
- 需要事务
- 需要组合多个数据操作

所以更稳妥的经验是：

> handler 可以很薄，但不要过度薄；SQL 可以先直写，但一旦开始重复，就该收进 repository。

---

## 八、service 层到底有什么价值？

很多人一开始会觉得 service 层像“为了分层而分层”。

其实不是。

它真正的价值主要体现在两个地方：

### 8.1 承载业务规则

例如：

- 名字不能为空
- 邮箱必须唯一
- 订单创建前要先校验库存
- 删除用户前要先检查关联资源

这些都不是纯 HTTP 逻辑，也不是纯 SQL 逻辑，最适合放在 service 层。

### 8.2 编排多个数据操作

例如创建订单时可能需要：

1. 创建订单记录
2. 扣减库存
3. 写审计日志

这类逻辑明显不是一个 repository 方法能优雅承载的。

而 service 层正好适合做这种编排。

---

## 九、事务应该放在哪一层？

这是 `axum + sqlx` 实战里很值得单独讲的一点。

结论先说：

> 事务边界通常更适合由 service 层决定，而不是 handler 层或单个 repository 层硬编码。

原因很简单。

事务本质上是在描述：

> 一组业务操作要么全部成功，要么全部失败。

这显然更接近业务编排问题，而不是 HTTP 问题。

例如创建订单时：

- 插入订单
- 插入订单项
- 扣减库存

这三步要不要放在同一个事务里，不是 handler 能决定得最清楚的，而是 service 更清楚。

### 9.1 一个事务示意例子

下面给个简化版示意：

```rust
use sqlx::{PgPool, Postgres, Transaction};

struct OrderService {
    db: PgPool,
}

impl OrderService {
    async fn create_order(&self, input: CreateOrderInput) -> Result<(), AppError> {
        let mut tx = self.db.begin().await.map_err(|err| {
            tracing::error!(error = %err, "begin transaction failed");
            AppError::Internal("internal server error".to_string())
        })?;

        insert_order(&mut tx, &input).await?;
        insert_order_items(&mut tx, &input).await?;
        decrease_stock(&mut tx, &input).await?;

        tx.commit().await.map_err(|err| {
            tracing::error!(error = %err, "commit transaction failed");
            AppError::Internal("internal server error".to_string())
        })?;

        Ok(())
    }
}

struct CreateOrderInput;

async fn insert_order(
    _tx: &mut Transaction<'_, Postgres>,
    _input: &CreateOrderInput,
) -> Result<(), AppError> {
    Ok(())
}

async fn insert_order_items(
    _tx: &mut Transaction<'_, Postgres>,
    _input: &CreateOrderInput,
) -> Result<(), AppError> {
    Ok(())
}

async fn decrease_stock(
    _tx: &mut Transaction<'_, Postgres>,
    _input: &CreateOrderInput,
) -> Result<(), AppError> {
    Ok(())
}
```

这个例子最重要的不是语法，而是边界：

- service 决定事务起止
- repository 或底层数据函数在事务上下文里执行具体 SQL

这通常比“handler 开事务”或者“每个 repository 自己偷偷开事务”更清晰。

---

## 十、查询接口和写入接口，有哪些设计差异？

很多人写第一个 CRUD 项目时，会把查询和写入用完全一样的思路处理。

这当然不是完全不行，但实际上它们关注点并不完全相同。

### 10.1 查询接口更关注

- 路径参数和查询参数提取
- 列表分页
- 结果映射
- 资源不存在如何处理

### 10.2 写入接口更关注

- JSON 请求体校验
- 幂等性
- 冲突处理
- 事务
- 创建成功后返回 201 或 204

这意味着在实际设计里：

- 查询接口通常重点是“怎么拿到数据”
- 写入接口通常重点是“怎么安全、清晰地修改数据”

所以别把所有接口都按一个模板硬套。

---

## 十一、sqlx 查询方式该怎么选？

在 sqlx 里，你会很快碰到几种常见方式：

- `query()`
- `query_as()`
- `query!()`
- `query_as!()`

如果先用一个工程上够用的视角来理解，可以这样看：

### 11.1 `query()`

适合：

- 自己手动取列
- 对映射控制比较细

### 11.2 `query_as()`

适合：

- 想直接把结果映射成元组或结构体
- 让 repository 代码更整洁

例如上面大量示例里用的就是 `query_as()`。

### 11.3 `query!()` / `query_as!()`

适合：

- 想要更强的编译期校验
- 项目愿意配合 sqlx 的数据库模式校验流程

在教程或通用示例里，我通常不会一开始就把重点放到 `query!` 宏上，因为它会把注意力拉到环境准备和编译期校验配置上；但在真实项目里，它确实是值得考虑的增强方向。

---

## 十二、错误处理该怎么和数据库访问结合？

如果你前面已经写过统一错误处理，这里其实就是把它落到数据库场景里。

一个比较稳妥的思路通常是：

1. repository 层捕获底层数据库错误
2. 记录内部日志
3. 转换成更稳定的 `AppError` 或 service 错误
4. 最终由 HTTP 层统一转成响应

例如：

```rust
.await
.map_err(|err| {
    tracing::error!(error = %err, "query user failed");
    AppError::Internal("internal server error".to_string())
})?
```

这里的关键点不是“少写几行”，而是：

> 不要把数据库底层错误字符串原样暴露给客户端。

客户端需要的是稳定、可消费的错误语义，不是内部 SQL 细节。

---

## 十三、axum + sqlx 实战里最常见的几个坑

### 13.1 把连接池包进 `Mutex`

通常没必要，而且会影响并发能力。

### 13.2 handler 里直接写太多 SQL

小 demo 可以接受，项目一大就会变成维护灾难。

### 13.3 所有层都直接返回 `StatusCode`

这会让 service 和 repository 层开始依赖 HTTP 语义，分层会越来越模糊。

### 13.4 事务边界乱放

如果事务逻辑散在 handler 或多个 repository 内部，后续很难维护。

### 13.5 原样暴露数据库错误

不稳定、不安全，也不利于前端处理。

### 13.6 为了“架构规范”过度拆层

小项目一上来就十几层抽象，通常不是成熟，而是负担。

更实际的做法是：

- 从清晰边界出发
- 先有 handler / service / repository 这类核心分层
- 需要时再继续细化

---

## 十四、如何判断你的 axum + sqlx 结构是不是健康？

我自己通常会用下面几个问题快速判断：

1. handler 是否主要只处理 HTTP 输入输出，而不是写满业务细节和 SQL
2. 数据库连接池是否作为应用状态共享，而不是被奇怪地加锁
3. service 是否真正承载了业务校验和事务编排
4. repository 是否专注数据库交互，而不是关心 HTTP 响应
5. 错误是否有统一模型，而不是到处手写 `StatusCode` 和字符串
6. 新增一个接口时，代码是否能自然落到既有结构中，而不是不断往 `main.rs` 里堆

如果这些问题大多能回答“是”，那这个项目结构通常已经比较稳了。

---

## 十五、总结

`axum + sqlx` 之所以是一个非常适合 Rust Web API 的组合，不只是因为它们流行，而是因为它们在职责上天然互补：

- axum 擅长 HTTP 层
- sqlx 擅长数据库层
- 中间的业务编排交给你自己的 service 层

如果把这篇文章压缩成最重要的几个结论，大概就是这些：

1. 数据库连接池非常适合放进 `State` 作为应用级共享依赖
2. handler、service、repository 分层不是形式主义，而是为了把 HTTP、业务和数据访问职责分开
3. 小项目不必过度设计，但也不要把所有逻辑都塞进 handler
4. 事务边界通常更适合由 service 层决定
5. 数据库错误应该记录内部日志，并统一映射成稳定的外部错误模型
6. 连接池通常不该再额外套 `Mutex`
7. 一个健康的 axum + sqlx 项目，新增接口时应该能很自然地落到既有分层里

如果你已经把前面的提取器、状态管理、错误处理、认证和 tower 原理串起来，那么这一篇实际上就是在把这些能力真正落到“一个能做事的 API 服务”上。

再往后继续写，一个非常自然的方向就是 axum 请求生命周期全流程。因为到这个阶段，你已经分别理解了：

- 请求怎么进入路由
- 参数怎么被提取
- 中间件怎么包装服务
- 状态怎么注入
- 错误怎么变成响应
- 数据又怎么从数据库里取出来

这时候再回头讲“一个请求在 axum 里到底经历了什么”，读者会很容易把所有知识点串成一整条链路。