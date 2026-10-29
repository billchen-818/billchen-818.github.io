---
title: Rust axum 状态管理与共享数据详解：State、Arc、Mutex、RwLock 与工程实践
date: 2026-04-18 16:39:05
tags: Rust
---

## 引言

学 axum 的时候，很多人一开始最关心的是：

- 路由怎么写
- handler 怎么收参数
- 中间件怎么挂

但只要你开始写一个稍微像样的 Web 服务，很快就会碰到另一个更实际的问题：

> 这些共享对象到底该放哪？

例如：

- 数据库连接池要怎么传给每个 handler
- 配置对象要怎么共享
- 缓存客户端要不要全局单例
- 统计计数器要怎么安全更新
- 某些状态到底该用 `Arc`，还是 `Mutex`，还是 `RwLock`

这些问题如果处理得不好，项目很容易出现两种极端：

- 要么所有东西都塞进 `main.rs`
- 要么一看到共享数据就无脑上锁

前者会让代码组织越来越乱，后者会让并发模型越来越脆弱。

在 axum 里，状态管理并不是一个零散技巧，而是整个 Web 工程设计里非常核心的一层。

这篇文章我会尽量把“会用”和“为什么这么用”一起讲清楚，重点回答这些问题：

1. axum 里的 `State<T>` 到底是什么
2. 什么数据适合直接放进状态里
3. 为什么很多共享数据要配合 `Arc`
4. `Mutex` 和 `RwLock` 应该怎么选
5. 数据库连接池、配置、缓存客户端这些工程对象该怎么组织
6. 什么样的状态设计是合理的，什么样的是危险的

如果你已经写完了 axum 的中间件和提取器，这一篇基本就是下一步最自然的进阶内容。

---

## 一、先回答最核心的问题：什么是状态管理？

先不要急着看 API，先把概念定清楚。

所谓状态管理，本质上是在回答一个问题：

> 对于多个请求都要用到的数据，我们应该如何在应用里组织、共享和访问它？

在 Web 服务里，常见的“状态”通常包括下面这些：

- 应用配置，例如端口、数据库地址、第三方服务配置
- 数据库连接池
- Redis 客户端或其他缓存客户端
- 业务服务对象
- 统计计数器、限流器、内存缓存
- 启动后就长期存在的只读字典或规则数据

这些数据有一个共同点：

- 它们不是某一个请求独有的
- 它们通常在应用启动时创建
- 它们会被很多 handler 反复访问

所以状态管理的重点从来不只是“共享”，而是同时处理好三件事：

1. 生命周期：什么时候创建，活多久
2. 并发安全：多个请求同时访问时是否安全
3. 可维护性：代码结构是否清晰，依赖关系是否明确

如果只顾着让代码“先能跑”，通常很快就会遇到后遗症。

---

## 二、axum 里的 `State<T>` 到底是什么？

在 axum 里，最常见的状态注入方式就是 `State<T>`。

先看一个最基础的例子：

```rust
use axum::{
	extract::State,
	routing::get,
	Router,
};

#[derive(Clone)]
struct AppState {
	app_name: String,
}

async fn health(State(state): State<AppState>) -> String {
	format!("{} is running", state.app_name)
}

#[tokio::main]
async fn main() {
	let state = AppState {
		app_name: "axum-demo".to_string(),
	};

	let app = Router::new()
		.route("/health", get(health))
		.with_state(state);

	let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
		.await
		.unwrap();

	axum::serve(listener, app).await.unwrap();
}
```

这个例子里最关键的只有两步：

1. 用 `with_state(state)` 把状态挂到 Router 上
2. 在 handler 里通过 `State(state)` 把它提取出来

这说明 `State<T>` 的本质不是某种“神秘全局变量”，而是：

> Router 持有一份应用状态，handler 通过 Extractor 按类型拿到它。

这件事很重要，因为它带来两个直接好处：

- 依赖是显式的，handler 参数就能看出它依赖什么
- 状态注入和业务逻辑解耦，不需要手动层层传参

### 2.1 为什么 `AppState` 通常要实现 `Clone`？

你会发现很多示例里的状态结构体都会写：

```rust
#[derive(Clone)]
struct AppState {
	// ...
}
```

原因不是“写着好看”，而是 axum 在路由和服务构建过程中，通常要求状态是可克隆的。

但这里要注意一个容易误解的点：

> `Clone` 不等于深拷贝所有数据。

如果你的 `AppState` 里面放的是：

- `Arc<T>`
- 数据库连接池
- Redis 客户端

那么它们的 `Clone` 往往只是复制一个轻量句柄，而不是重新拷贝整份底层资源。

这也是为什么很多工程里的 `AppState` 看起来是“可 Clone 的”，但实际并不会造成昂贵复制。

---

## 三、哪些数据适合放进 `AppState`？

不是所有数据都适合塞进状态对象。

一个很实用的判断标准是：

> 如果某个对象会在应用启动后长期存在，并被多个请求重复使用，那么它通常适合放进 `AppState`。

常见适合放进去的内容有：

- 只读配置对象
- 数据库连接池
- Redis 客户端
- HTTP 客户端
- 业务服务对象
- 共享缓存句柄

例如：

```rust
use std::sync::Arc;

#[derive(Clone)]
struct AppConfig {
	app_name: String,
	enable_metrics: bool,
}

#[derive(Clone)]
struct UserService {
	// 这里可以持有数据库池或仓储对象
}

#[derive(Clone)]
struct AppState {
	config: Arc<AppConfig>,
	user_service: UserService,
}
```

这样做的核心好处是：

- 启动时一次性组装依赖
- handler 不关心对象怎么初始化
- 状态结构本身就表达了系统的核心依赖关系

### 3.1 哪些东西不适合直接塞进去？

反过来，这几类内容要谨慎处理：

- 每个请求独有的数据
- 生命周期很短的临时对象
- 需要按请求动态变化的上下文
- 大量频繁写入且锁竞争严重的可变数据

例如“当前登录用户”就不应该放进全局 `AppState`，因为它属于单个请求上下文，更适合放在 request extensions 或自定义 Extractor 的语义里。

再比如“某个 handler 临时计算出的中间结果”，也不应该变成全局共享状态。

所以一个简单判断是：

> 全局状态负责“应用级共享依赖”，请求上下文负责“请求级动态数据”。

---

## 四、为什么很多状态都要配合 `Arc`？

只要一提到 Rust 共享状态，很多人第一反应就是：

`Arc`。

这当然不算错，但更关键的是要知道它到底解决了什么问题。

`Arc<T>` 的核心作用是：

> 让多个所有者可以安全共享同一份堆上数据。

在 axum 项目里，常见场景是：

- 整个应用要共享一份配置
- 多个 handler 要共享一份服务对象
- 某些只读规则表不想每次复制

例如：

```rust
use std::sync::Arc;

#[derive(Debug)]
struct AppConfig {
	app_name: String,
	api_version: String,
}

#[derive(Clone)]
struct AppState {
	config: Arc<AppConfig>,
}
```

这里把配置放到 `Arc` 里，意味着：

- 配置对象只有一份底层数据
- `AppState` 被克隆时，只会增加引用计数
- 不会反复拷贝大对象

### 4.1 什么情况下不一定要 `Arc`？

如果你的状态字段本身就是轻量、可复制或内部已经做了共享管理，那未必还需要额外包一层 `Arc`。

例如很多数据库连接池类型本身就是轻量句柄，可直接 `Clone`。

这时候更合理的写法通常是：

```rust
#[derive(Clone)]
struct AppState {
	db: sqlx::PgPool,
}
```

而不是：

```rust
#[derive(Clone)]
struct AppState {
	db: Arc<sqlx::PgPool>,
}
```

后者不一定错，但通常是多包了一层，没有明显收益。

所以要记住：

> `Arc` 是共享所有权工具，不是所有状态字段的默认包装纸。

---

## 五、可变共享状态：什么时候该用 `Mutex`？

只读共享数据相对简单，真正麻烦的是可变共享数据。

例如你可能会有这样的需求：

- 统计访问次数
- 维护一个内存缓存
- 保存在线用户列表
- 更新某个运行时配置

这类数据就不能只靠 `Arc<T>`，因为 `Arc` 只解决共享所有权，不解决内部可变性的并发安全。

这时就需要同步原语，最常见的就是 `Mutex<T>`。

先看一个最简单的例子：

```rust
use axum::{
	extract::State,
	routing::get,
	Router,
};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct AppState {
	counter: Arc<Mutex<u64>>,
}

async fn visit(State(state): State<AppState>) -> String {
	let mut counter = state.counter.lock().unwrap();
	*counter += 1;
	format!("visit count = {}", *counter)
}

#[tokio::main]
async fn main() {
	let state = AppState {
		counter: Arc::new(Mutex::new(0)),
	};

	let app = Router::new()
		.route("/visit", get(visit))
		.with_state(state);

	let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
		.await
		.unwrap();

	axum::serve(listener, app).await.unwrap();
}
```

这里的逻辑很直白：

- `Arc` 负责共享同一个计数器
- `Mutex` 负责保证同一时刻只有一个请求能修改它

### 5.1 这个例子为什么“能用”，但不一定“理想”？

因为它虽然正确，但也暴露了真实工程里的几个问题：

- 锁会带来竞争
- `std::sync::Mutex` 在异步环境里要格外小心
- 如果临界区过大，很容易把并发性能拖垮

所以这个例子更适合用来理解模型，而不是直接照抄到所有场景。

---

## 六、异步环境里为什么要谨慎对待锁？

这是状态管理里最容易被忽略，但又最关键的部分之一。

axum 运行在异步运行时上，很多 handler 都是 `async fn`。而异步函数里一旦涉及锁，就要特别注意两件事：

1. 不要轻易在持锁状态下跨 `await`
2. 不要让锁保护的临界区过大

例如下面这种写法就是典型危险信号：

```rust
async fn wrong_handler(State(state): State<AppState>) {
	let mut guard = state.cache.lock().unwrap();

	// 错误方向：持锁期间做异步等待
	let data = fetch_remote_data().await;

	guard.insert("key".to_string(), data);
}
```

问题在于：

- 锁还没释放
- 当前任务却在等待异步操作
- 其他请求可能一直拿不到锁

更合理的写法通常是缩小临界区：

```rust
async fn better_handler(State(state): State<AppState>) {
	let data = fetch_remote_data().await;

	let mut guard = state.cache.lock().unwrap();
	guard.insert("key".to_string(), data);
}
```

核心原则很简单：

> 把需要加锁的代码范围压到最小，只保护真正需要共享修改的那一小段。

### 6.1 `std::sync::Mutex` 和 `tokio::sync::Mutex` 怎么选？

这也是一个非常高频的问题。

可以先记一个实用判断：

- 如果临界区很小，而且不会跨 `await`，`std::sync::Mutex` 往往就够用
- 如果锁内逻辑必须跨异步等待，才考虑 `tokio::sync::Mutex`

但即使是 `tokio::sync::Mutex`，也不意味着“可以放心把一大段异步逻辑包在锁里”。

因为问题的根源不只是“能不能 await”，而是：

> 一旦锁持有时间太长，系统吞吐量就会明显下降。

所以比“选哪种锁”更重要的，是先思考：

- 这个共享可变状态真的必要吗
- 能不能改成消息传递
- 能不能改成分片缓存
- 能不能把更新频率降低

很多并发问题不是靠换锁类型解决的，而是靠重新设计数据流解决的。

---

## 七、读多写少的场景：什么时候用 `RwLock`？

如果某个共享数据的访问模式是：

- 读很多
- 写很少

那 `RwLock<T>` 往往比 `Mutex<T>` 更合适。

它的核心语义是：

- 多个读可以并发进行
- 写时必须独占

一个典型场景是运行时规则表或只偶尔更新的配置缓存。

```rust
use axum::{extract::State, routing::get, Router};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;

#[derive(Clone)]
struct AppState {
	feature_flags: Arc<RwLock<HashMap<String, bool>>>,
}

async fn feature_enabled(State(state): State<AppState>) -> String {
	let flags = state.feature_flags.read().await;
	let enabled = flags.get("new-homepage").copied().unwrap_or(false);
	format!("new-homepage = {}", enabled)
}

async fn enable_feature(State(state): State<AppState>) -> String {
	let mut flags = state.feature_flags.write().await;
	flags.insert("new-homepage".to_string(), true);
	"ok".to_string()
}
```

这个例子里：

- 高频读取可以共享读锁
- 少量写入时才独占写锁

### 7.1 `RwLock` 也不是银弹

很多人会想：既然读能并发，那是不是 `RwLock` 总比 `Mutex` 更高级？

不是。

因为 `RwLock` 也有成本：

- 实现更复杂
- 读写切换有额外开销
- 如果写入并不稀少，收益未必明显

所以是否使用 `RwLock`，应该由数据访问模式决定，而不是“看起来更厉害”决定。

---

## 八、工程里最常见的状态：数据库连接池怎么放？

这是实际项目里最常见的状态之一，而且很适合拿来理解“共享状态不等于共享可变裸对象”。

以 `sqlx::PgPool` 为例，通常会这么组织：

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
struct UserResponse {
	id: i64,
	name: String,
}

async fn get_user(
	State(state): State<AppState>,
	Path(id): Path<i64>,
) -> Result<Json<UserResponse>, String> {
	let row = sqlx::query_as::<_, (i64, String)>(
		"select id, name from users where id = $1"
	)
	.bind(id)
	.fetch_one(&state.db)
	.await
	.map_err(|err| err.to_string())?;

	Ok(Json(UserResponse {
		id: row.0,
		name: row.1,
	}))
}
```

这里有一个经常被初学者忽略的点：

> 连接池本身就是为并发共享设计的。

也就是说，你共享的不是“一个数据库连接”，而是“一个连接池句柄”。

请求来了之后：

- handler 通过池去借连接
- 用完之后归还
- 池负责整体复用和并发控制

所以对连接池这类对象，通常不需要你再手动包一层 `Mutex`。

错误方向往往长这样：

```rust
// 通常没有必要
Arc<Mutex<PgPool>>
```

这类写法会平白增加锁竞争，还破坏连接池本身的并发能力。

---

## 九、状态结构应该怎么设计？

状态管理真正有深度的地方，不在于会不会写 `State<T>`，而在于：

> 你的 `AppState` 到底应该长什么样。

### 9.1 小项目的状态结构

对于小项目，通常直接一个统一状态结构体就足够了：

```rust
#[derive(Clone)]
struct AppState {
	config: Arc<AppConfig>,
	db: sqlx::PgPool,
	redis: redis::Client,
}
```

这种写法简单直接，适合：

- 接口不多
- 服务边界比较单一
- 项目还处于快速迭代阶段

### 9.2 中型项目更推荐“状态里放服务，而不是到处放基础设施”

当项目变大后，如果 `AppState` 里全是基础设施对象，handler 往往会慢慢演变成这样：

- 自己查数据库
- 自己拼缓存 key
- 自己做业务判断
- 自己处理事务

这会让 handler 越来越像“脚本入口”，而不是清晰的接口层。

更好的方式通常是：

```rust
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
	config: Arc<AppConfig>,
	user_service: Arc<UserService>,
	order_service: Arc<OrderService>,
}
```

也就是说：

- 基础设施对象先组装成 service
- service 再统一放进状态
- handler 只和 service 对话

这样 handler 会清爽很多，例如：

```rust
async fn get_user(
	State(state): State<AppState>,
	Path(id): Path<i64>,
) -> Result<Json<UserDto>, AppError> {
	let user = state.user_service.get_user(id).await?;
	Ok(Json(user))
}
```

这种设计的好处是：

- 业务逻辑更集中
- handler 更薄
- 单元测试更容易做
- 后续重构底层依赖时影响更小

---

## 十、一个更像真实项目的完整示例

下面给一个稍微完整一点的例子，把配置、连接池和 service 放进统一状态里。

```rust
use axum::{
	extract::{Path, State},
	http::StatusCode,
	response::IntoResponse,
	routing::get,
	Json, Router,
};
use serde::Serialize;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
struct AppConfig {
	app_name: String,
}

#[derive(Clone)]
struct UserService {
	db: PgPool,
}

impl UserService {
	async fn get_user(&self, id: i64) -> Result<UserDto, AppError> {
		let row = sqlx::query_as::<_, (i64, String)>(
			"select id, name from users where id = $1"
		)
		.bind(id)
		.fetch_one(&self.db)
		.await
		.map_err(|_| AppError::NotFound)?;

		Ok(UserDto {
			id: row.0,
			name: row.1,
		})
	}
}

#[derive(Clone)]
struct AppState {
	config: Arc<AppConfig>,
	user_service: Arc<UserService>,
}

#[derive(Serialize)]
struct UserDto {
	id: i64,
	name: String,
}

enum AppError {
	NotFound,
}

impl IntoResponse for AppError {
	fn into_response(self) -> axum::response::Response {
		match self {
			AppError::NotFound => (StatusCode::NOT_FOUND, "user not found").into_response(),
		}
	}
}

async fn get_user(
	State(state): State<AppState>,
	Path(id): Path<i64>,
) -> Result<Json<UserDto>, AppError> {
	let user = state.user_service.get_user(id).await?;
	Ok(Json(user))
}

async fn health(State(state): State<AppState>) -> String {
	format!("{} is running", state.config.app_name)
}

#[tokio::main]
async fn main() {
	let db = PgPool::connect("postgres://postgres:postgres@localhost/app")
		.await
		.unwrap();

	let state = AppState {
		config: Arc::new(AppConfig {
			app_name: "user-service".to_string(),
		}),
		user_service: Arc::new(UserService { db }),
	};

	let app = Router::new()
		.route("/health", get(health))
		.route("/users/{id}", get(get_user))
		.with_state(state);

	let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
		.await
		.unwrap();

	axum::serve(listener, app).await.unwrap();
}
```

这个例子里，状态分工是清楚的：

- `config` 负责应用级只读配置
- `user_service` 负责用户相关业务能力
- `PgPool` 被封装在 service 内部
- handler 不直接处理底层细节

这就是一种比较健康的状态组织方式。

---

## 十一、状态管理里最常见的几个坏味道

### 11.1 把所有东西都塞进 `AppState`

很多项目早期会这么写，短期没问题，但一旦对象越来越多，`AppState` 就会变成一个巨大的杂物箱。

如果你发现状态里已经包含：

- 十几个客户端
- 一堆无关配置
- 各种临时缓存
- 各种裸数据结构

那通常意味着该做分层了。

### 11.2 为了共享就到处上 `Arc<Mutex<T>>`

这是 Rust 初学者极其常见的模式：

“有共享数据”

“那就 `Arc<Mutex<_>>`”

这当然有时能工作，但它很容易把架构拖向另一个极端：

- 到处是锁
- 不知道谁在什么时候修改数据
- 锁竞争难分析
- handler 逻辑开始和底层同步细节强耦合

更好的顺序应该是：

1. 先问这个数据是不是真的需要全局可变共享
2. 再问能不能通过 service 封装修改路径
3. 最后才决定是否要用锁

### 11.3 把请求级数据误放进全局状态

例如：

- 当前用户
- 当前请求 ID
- 当前租户信息

这些都不应该成为全局状态的一部分。

因为它们不是“应用级共享依赖”，而是“请求级上下文”。

这类数据更适合：

- 中间件注入 extensions
- 自定义 Extractor 提取

### 11.4 在 handler 里直接操作太多共享状态

如果一个 handler 同时做这些事情：

- 拿状态
- 上锁
- 更新缓存
- 查数据库
- 写审计日志
- 拼业务响应

那说明状态组织和职责划分已经开始失衡。

handler 应该是接口层，而不是共享状态的总调度中心。

---

## 十二、如何选择：值、`Arc`、`Mutex`、`RwLock`

如果你希望快速判断，可以先用这套简化规则：

### 12.1 直接放值

适合：

- 轻量对象
- 只读配置
- 本身已经是轻量句柄的客户端或连接池

示例：

```rust
#[derive(Clone)]
struct AppState {
	db: sqlx::PgPool,
}
```

### 12.2 放 `Arc<T>`

适合：

- 较大的只读对象
- 需要多处共享所有权的 service
- 不希望克隆底层大对象

示例：

```rust
#[derive(Clone)]
struct AppState {
	config: Arc<AppConfig>,
	user_service: Arc<UserService>,
}
```

### 12.3 放 `Arc<Mutex<T>>`

适合：

- 确实需要可变共享
- 写操作较明确
- 临界区可控

示例：

```rust
#[derive(Clone)]
struct AppState {
	counter: Arc<Mutex<u64>>,
}
```

### 12.4 放 `Arc<RwLock<T>>`

适合：

- 读多写少
- 希望提升并发读能力

示例：

```rust
#[derive(Clone)]
struct AppState {
	flags: Arc<tokio::sync::RwLock<HashMap<String, bool>>>,
}
```

但请始终记住：

> 选容器只是最后一步，先搞清楚数据的访问模式和职责边界，才是更重要的事。

---

## 十三、总结

axum 的状态管理表面上看只是一个 `State<T>`，但真正需要理解的是它背后的设计问题：

- 什么是应用级共享依赖
- 什么是请求级上下文
- 什么数据应该只读共享
- 什么数据真的需要可变共享
- 如何在并发安全和代码可维护性之间取得平衡

如果把这篇文章压缩成几个最关键的结论，大概就是这些：

1. `State<T>` 是 axum 提供的应用状态注入机制
2. `AppState` 里更适合放长期存在、会被多个请求复用的对象
3. `Arc` 解决共享所有权，不等于自动解决并发修改问题
4. `Mutex` 和 `RwLock` 只该在确实需要可变共享时使用
5. 在异步环境里，持锁范围一定要尽量小，尽量不要跨 `await`
6. 数据库连接池这类对象通常本身就是并发共享句柄，不要无脑再包 `Mutex`
7. 中型项目更推荐把 service 放进状态，而不是让 handler 直接操作所有基础设施

如果你已经把 axum 的中间件、提取器和状态管理这三块串起来，那么整个请求进入应用后的主干流程其实已经非常清楚了：

- Middleware 处理横切逻辑
- Extractor 准备 handler 输入
- State 提供应用级共享依赖
- handler 聚焦业务逻辑

再往下继续写，一个非常自然的方向就是错误处理与统一响应设计。因为当状态、输入提取、横切逻辑都建立起来之后，剩下最影响工程质量的，往往就是错误模型和响应模型如何统一。
