---
title: Rust RESTful API 学习总结
date: 2026-02-28 14:24:34
tags: Rust
---

## 1. 为什么选择 Rust 进行 Web 开发？

在构建高性能、高并发的网络服务时，Rust 正变得越来越受欢迎。主要原因包括：

*   **内存安全**：Rust 的所有权模型在编译阶段就消除了数据竞争和空指针引用，不需要垃圾回收（GC），避免了 GC 带来的性能抖动。
*   **高性能**：Rust 编译为原生机器码，运行速度媲美 C/C++，非常适合处理高吞吐量的 API 请求。
*   **强大的类型系统**：利用枚举（Enum）和模式匹配（Pattern Matching）可以优雅地处理业务逻辑和错误。
*   **成熟的生态**：Tokio 异步运行时和 Serde 序列化库已经成为工业级标准。

## 2. 技术选型

在 Rust 生态中，构建 RESTful API 有多种优秀的框架选择：

*   **Axum**：基于 Tokio 和 Tower，人体工程学设计极佳，与 Rust 异步生态融合最好，是目前最受推崇的框架之一。
*   **Actix-web**：历史悠久，性能极其强悍，常年在 TechEmpower 榜单霸榜。
*   **Rocket**：注重易用性和类型安全，语法类似 Python 的 Flask 或 Java 的 Spring Boot。
*   **Warp**：基于 Filter（过滤器）链式组合的设计理念，非常函数式。

**本次实战选用 Axum**，因为它简单易用且背靠 Tokio 团队。

## 3. 初探：内存版 User CRUD API

我们将构建一个简单的内存版用户管理系统，包含创建用户及获取用户信息的接口。

### 3.1 添加依赖

在 `Cargo.toml` 中添加必要的库：

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
axum = "0.7"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = "0.3"
```

### 3.2 核心代码实现 (`main.rs`)

我们将实现以下功能：
1.  启动 HTTP 服务器。
2.  应用状态共享（模拟数据库）。
3.  路由处理：
    *   `POST /users`: 创建用户
    *   `GET /users/:id`: 获取用户

```rust
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};
use tokio::net::TcpListener;

// 1. 定义数据模型
#[derive(Debug, Serialize, Clone)]
struct User {
    id: u64,
    username: String,
    email: String,
}

#[derive(Debug, Deserialize)]
struct CreateUserPayload {
    username: String,
    email: String,
}

// 2. 定义应用状态（AppState）
// 使用 RwLock 实现线程安全的读写，Arc 用于跨线程共享所有权
type UserDb = Arc<RwLock<HashMap<u64, User>>>;

#[tokio::main]
async fn main() {
    // 初始化日志
    tracing_subscriber::fmt::init();

    // 初始化模拟数据库
    let db = UserDb::default();

    // 3. 构建路由
    let app = Router::new()
        .route("/users", post(create_user))
        .route("/users/:id", get(get_user))
        .with_state(db);

    // 4. 启动服务器
    let listener = TcpListener::bind("0.0.0.0:3000").await.unwrap();
    println!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.unwrap();
}

// Handler: 创建用户
async fn create_user(
    State(db): State<UserDb>,
    Json(payload): Json<CreateUserPayload>,
) -> (StatusCode, Json<User>) {
    let mut users = db.write().unwrap();
    
    let id = (users.len() as u64) + 1;
    let user = User {
        id,
        username: payload.username,
        email: payload.email,
    };

    users.insert(id, user.clone());

    // 返回 201 Created 和创建的用户数据
    (StatusCode::CREATED, Json(user))
}

// Handler: 获取用户
async fn get_user(
    Path(id): Path<u64>,
    State(db): State<UserDb>,
) -> Result<Json<User>, StatusCode> {
    let users = db.read().unwrap();

    if let Some(user) = users.get(&id) {
        Ok(Json(user.clone()))
    } else {
        // 如果找不到用户，返回 404 Not Found
        Err(StatusCode::NOT_FOUND)
    }
}
```

## 4. 进阶：构建生产级 API

在实际项目中，我们不能只用内存 HashMap，还需要解决数据库持久化、配置管理、日志追踪和自动化测试等问题。

### 4.1 升级依赖配置

修改 `Cargo.toml`，引入生产环境必备库：

```toml
[dependencies]
# Web 框架
axum = "0.7"
tokio = { version = "1", features = ["full"] }

# 序列化
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# 数据库 (PostgreSQL)
sqlx = { version = "0.7", features = ["runtime-tokio-rustls", "postgres"] }

# 配置管理
config = "0.13"

# 日志与追踪
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

# 中间件（CORS, Trace 等）
tower = { version = "0.4", features = ["util"] }
tower-http = { version = "0.5", features = ["cors", "trace"] }
```

### 4.2 配置管理

生产环境通常通过环境变量或配置文件来管理设置。这里使用 `config` crate 实现分层配置加载。

```rust
// config.rs
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Settings {
    pub database_url: String,
    pub server_port: u16,
}

impl Settings {
    pub fn new() -> Result<Self, config::ConfigError> {
        let builder = config::Config::builder()
            // 读取 config/Default.toml
            .add_source(config::File::with_name("config/Default"))
            // 允许环境变量覆盖，例如 APP_DATABASE_URL
            .add_source(config::Environment::with_prefix("APP"));
            
        builder.build()?.try_deserialize()
    }
}
```

### 4.3 完整的应用状态初始化与中间件

我们将内存 `HashMap` 替换为 `sqlx::PgPool`，并添加日志和 CORS 中间件。

```rust
// main.rs (进阶版片段)
use axum::{
    routing::{get, post},
    Router,
};
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use tower_http::{cors::{Any, CorsLayer}, trace::TraceLayer};

// 引入 config 模块
mod config;

// 应用状态：直接持有数据库连接池
#[derive(Clone)]
struct AppState {
    db: sqlx::PgPool,
}

#[tokio::main]
async fn main() {
    // 1. 初始化日志追踪
    tracing_subscriber::fmt()
        .with_env_filter("debug,axum::rejection=trace")
        .init();

    // 2. 加载配置
    let settings = config::Settings::new().expect("Config load failed");

    // 3. 连接数据库 (PostgreSQL)
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&settings.database_url)
        .await
        .expect("Database connection failed");
    
    let state = AppState { db: pool };

    // 4. 构建路由与中间件
    let app = Router::new()
        // 添加请求日志追踪
        .layer(TraceLayer::new_for_http()) 
        // 添加 CORS (跨域资源共享)
        .layer(
            CorsLayer::new()
                .allow_origin(Any) // 生产环境请指定具体域名
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST]),
        )
        .route("/users", post(create_user_db))
        .with_state(state); // 状态注入

    // 5. 启动服务
    let addr = SocketAddr::from(([0, 0, 0, 0], settings.server_port));
    tracing::info!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
```

### 4.4 数据库操作 Handler

使用 `sqlx` 宏进行编译时检查 SQL 语句。

```rust
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct CreateUserPayload {
    username: String,
    email: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct User {
    id: i32,
    username: String,
    email: String,
}

async fn create_user_db(
    State(state): State<AppState>,
    Json(payload): Json<CreateUserPayload>,
) -> Result<Json<User>, String> {
    // 使用 sqlx::query_as! 进行编译时 SQL 检查
    // 或者使用 query_as::<_, User> 动态检查
    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (username, email) VALUES ($1, $2) RETURNING id, username, email"
    )
    .bind(payload.username)
    .bind(payload.email)
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;

    Ok(Json(user))
}
```

### 4.5 单元测试与集成测试

Axum 的 Router 实现了 `tower::Service`，这使得测试非常容易，无需启动 HTTP 服务器。

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::get,
    };
    use tower::ServiceExt; // for `oneshot`

    #[tokio::test]
    async fn test_hello_user() {
        // 构建用于测试的 App
        let app = Router::new().route("/", get(|| async { "Hello, World!" }));

        // 发送模拟请求
        let response = app
            .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }
}
```

## 5. 关键知识点总结

### 5.1 提取器 (Extractors)
Axum 的强大之处在于**提取器**。在 Handler 函数签名中声明的参数，Axum 会自动从请求中解析数据。
*   `Json(payload)`: 自动将 Request Body 解析为 Struct（反序列化）。
*   `Path(id)`: 解析 URL 路径参数，如 `/users/1` 中的 `1`。
*   `State(db)`: 获取全局共享的应用状态（数据库连接池等）。

### 5.2 状态共享 (State Management)
Restful API 通常是无状态的，但我们需要持久化数据。
*   Rust 中使用 `Arc` (Atomic Reference Counting) 来让多个线程共享同一份数据。
*   如果数据可变，需要包裹在 `Mutex` 或 `RwLock` 内部（内部可变性模式）。
*   在真实项目中，这里通常会存放 `sqlx::PgPool` (PostgreSQL 连接池)。

### 5.3 错误处理
Rust 的结果返回非常灵活。Handler 可以返回任何实现了 `IntoResponse` trait 的类型。
*   简单场景：直接返回 `StatusCode`。
*   复杂场景：返回 `Result<Json<T>, AppError>`。这允许我们定义统一的错误处理枚举，将业务错误自动转换为对应的 HTTP 响应。

```rust
// 简单的自定义错误扩展示例
enum AppError {
    UserNotFound,
    DatabaseError(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, error_message) = match self {
            AppError::UserNotFound => (StatusCode::NOT_FOUND, "User not found"),
            AppError::DatabaseError(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.as_str()),
        };
        (status, Json(json!({ "error": error_message }))).into_response()
    }
}
```