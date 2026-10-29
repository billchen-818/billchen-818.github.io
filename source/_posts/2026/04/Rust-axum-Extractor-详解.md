---
title: Rust axum Extractor 详解
date: 2026-04-16 14:27:00
tags: Rust
---

## 引言

学 axum 的时候，很多人第一次看到 handler 都会有一个共同疑问：

为什么函数参数里直接写 `Path`、`Query`、`Json`、`State`，框架就能自动把请求里的数据解析出来？

比如下面这个 handler：

```rust
use axum::{
	extract::{Path, Query, State},
	Json,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct UserQuery {
	verbose: Option<bool>,
}

#[derive(Serialize)]
struct UserResponse {
	id: u64,
	name: String,
}

async fn get_user(
	Path(id): Path<u64>,
	Query(query): Query<UserQuery>,
	State(state): State<AppState>,
) -> Json<UserResponse> {
	let name = if query.verbose.unwrap_or(false) {
		format!("{}-detail", state.default_name)
	} else {
		state.default_name
	};

	Json(UserResponse { id, name })
}

#[derive(Clone)]
struct AppState {
	default_name: String,
}
```

这段代码读起来非常自然，但它背后其实藏着 axum 很重要的一套设计：`Extractor`。

如果你理解了 Extractor，很多之前看起来像“魔法”的东西就会变得非常清晰：

1. handler 参数为什么能自动解析
2. 路由参数、查询参数、请求体、共享状态到底是怎么进入 handler 的
3. 为什么有些参数可以随便写多个，有些却会冲突
4. 什么场景该用 Extractor，什么场景该用 Middleware
5. 如何自己实现一个业务可复用的自定义提取器

这篇文章我会从浅到深把这些问题串起来，尽量做到“能写、能懂、能判断边界”。

---

## 一、什么是 Extractor？

先用一句最直接的话来定义：

> Extractor 就是把 HTTP 请求里的某部分数据提取出来，并转换成 handler 参数的机制。

一个 HTTP 请求里通常包含很多信息：

- 路径参数，例如 `/users/42`
- 查询参数，例如 `?page=1&page_size=20`
- 请求头，例如 `Authorization`
- 请求体，例如 JSON
- 应用共享状态，例如数据库连接池、配置
- 请求扩展上下文，例如认证后的用户信息

如果没有 Extractor，handler 往往要自己处理这些细节：

- 自己拆路径参数
- 自己解析 query string
- 自己反序列化 JSON
- 自己从共享状态里拿对象

这样写当然也不是不行，但会带来明显问题：

- 业务代码混进了大量 HTTP 解析细节
- 相同的解析逻辑在多个 handler 里反复出现
- 参数校验和错误处理难以复用
- handler 变得越来越臃肿

而 Extractor 的核心价值就是：

> 把“从请求里取数据”的逻辑，从 handler 的业务逻辑里拆出去。

所以一个写得好的 handler，看起来通常更像“直接拿到了已经准备好的参数”，而不是“从底层请求对象里一层层自己抠数据”。

---

## 二、为什么 handler 参数可以自动解析？

很多人第一次学 axum，会把注意力停留在“这个类型能不能拿到值”。

但更关键的问题其实是：

> axum 凭什么知道，应该如何把请求变成这些参数？

答案是：这些参数类型实现了特定的提取 trait。

在 axum 里，Extractor 主要围绕两类能力展开：

1. 从请求头、路径、方法、URI、extensions 这类“请求元信息”里提取
2. 从请求体里提取

这两类场景看起来很像，但在设计上必须分开，因为请求体有一个重要限制：

> body 通常只能被消费一次。

这就直接决定了 axum 会区分两类提取行为：

- `FromRequestParts`：只处理请求的“头部信息和元信息”，不消费 body
- `FromRequest`：需要读取或消费 body

你可以先把它们粗略理解为：

- 前者适合 `Path`、`Query`、`State`、请求头、extensions
- 后者适合 `Json`、`String`、`Bytes`、`Form`

这个区分非常重要，因为它解释了很多初学者常见困惑。

例如下面这种写法为什么有问题：

```rust
use axum::{
	extract::Request,
	extract::Json,
};

async fn wrong_handler(
	request: Request,
	Json(payload): Json<CreateUserRequest>,
) {
	// ...
}
```

原因不是语法问题，而是语义冲突：

- `Request<Body>` 想拿到完整请求
- `Json<T>` 也要消费 body

而 body 不能被两个参数分别读两次。

所以理解 Extractor，不只是会用几个类型而已，更重要的是理解：

> handler 参数本质上是在声明“我要从请求中拿哪些部分的数据”。

---

## 三、最常见的内置 Extractor

axum 内置的 Extractor 已经覆盖了绝大多数日常场景。对于初学者来说，先把最常用的几种吃透，已经足够写出很像样的 Web 服务。

### 3.1 `Path`：提取路由路径参数

如果你的路由里有动态段，例如：

```rust
/users/{id}
```

那么就可以通过 `Path` 来拿到这个参数。

```rust
use axum::{extract::Path, routing::get, Router};

async fn get_user(Path(id): Path<u64>) -> String {
	format!("user id = {}", id)
}

let app = Router::new().route("/users/{id}", get(get_user));
```

这里要注意两个点：

- 路由写法是 `/{id}`
- `Path(u64)` 会尝试把字符串参数解析为目标类型

如果解析失败，例如访问 `/users/abc`，axum 会直接返回错误响应，而不会进入 handler。

如果路径参数不止一个，也可以提取为元组或结构体。

```rust
use axum::extract::Path;
use serde::Deserialize;

#[derive(Deserialize)]
struct ArticlePath {
	category: String,
	id: u64,
}

async fn get_article(Path(path): Path<ArticlePath>) -> String {
	format!("category={}, id={}", path.category, path.id)
}
```

### 3.2 `Query`：提取查询参数

对于 URL 后面的 query string，最常用的就是 `Query<T>`。

```rust
use axum::extract::Query;
use serde::Deserialize;

#[derive(Deserialize)]
struct Pagination {
	page: Option<u64>,
	page_size: Option<u64>,
}

async fn list_users(Query(params): Query<Pagination>) -> String {
	let page = params.page.unwrap_or(1);
	let page_size = params.page_size.unwrap_or(20);
	format!("page={}, page_size={}", page, page_size)
}
```

如果请求是：

```text
GET /users?page=2&page_size=50
```

那么 `params.page == Some(2)`，`params.page_size == Some(50)`。

一般建议把 Query 参数定义成结构体，而不是在 handler 里手动读字符串，这样更清晰，也更利于后续扩展和校验。

### 3.3 `Json`：提取 JSON 请求体

`Json<T>` 是 axum 里最常见的 body 提取器之一。

```rust
use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct CreateUserRequest {
	name: String,
	email: String,
}

#[derive(Serialize)]
struct CreateUserResponse {
	id: u64,
	name: String,
}

async fn create_user(Json(payload): Json<CreateUserRequest>) -> Json<CreateUserResponse> {
	Json(CreateUserResponse {
		id: 1,
		name: payload.name,
	})
}
```

这里的动作本质上是：

- 读取请求体
- 按 JSON 反序列化为 `CreateUserRequest`
- 成功则把值交给 handler
- 失败则直接返回错误响应

这也是为什么 `Json<T>` 通常要放在参数列表里比较靠后的位置，因为它会消费 body。

### 3.4 `State`：提取共享应用状态

在实际项目里，很多对象都需要跨 handler 共享，例如：

- 数据库连接池
- 配置对象
- 缓存客户端
- 外部服务 SDK

这类数据最常用的注入方式就是 `State<T>`。

```rust
use axum::{extract::State, routing::get, Router};

#[derive(Clone)]
struct AppState {
	app_name: String,
}

async fn health(State(state): State<AppState>) -> String {
	format!("{} is running", state.app_name)
}

let state = AppState {
	app_name: "demo-service".to_string(),
};

let app = Router::new()
	.route("/health", get(health))
	.with_state(state);
```

这意味着 handler 不需要知道状态对象是怎么创建出来的，它只声明自己“需要这个状态”。

这就是依赖注入在 axum 世界里的一个非常自然的落点。

### 3.5 请求元信息提取器

除了上面几个高频类型，axum 也允许你直接提取一些请求元信息，例如：

- `Method`
- `Uri`
- `HeaderMap`
- `Extension<T>`

例如：

```rust
use axum::http::{HeaderMap, Method, Uri};

async fn inspect_request(method: Method, uri: Uri, headers: HeaderMap) -> String {
	format!(
		"method={}, path={}, headers={}",
		method,
		uri.path(),
		headers.len()
	)
}
```

这些提取器通常不会消费 body，所以很适合拿来做请求分析、辅助判断、读取 header 等操作。

---

## 四、多个 Extractor 可以一起使用吗？

可以，而且这正是 axum handler 的强大之处。

例如下面这个 handler：

```rust
use axum::{
	extract::{Path, Query, State},
	Json,
};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
struct AppState {
	default_nickname: String,
}

#[derive(Deserialize)]
struct UserPath {
	id: u64,
}

#[derive(Deserialize)]
struct UpdateQuery {
	notify: Option<bool>,
}

#[derive(Deserialize)]
struct UpdateUserRequest {
	nickname: String,
}

#[derive(Serialize)]
struct UpdateUserResponse {
	id: u64,
	nickname: String,
	notify: bool,
}

async fn update_user(
	State(state): State<AppState>,
	Path(path): Path<UserPath>,
	Query(query): Query<UpdateQuery>,
	Json(payload): Json<UpdateUserRequest>,
) -> Json<UpdateUserResponse> {
	let nickname = if payload.nickname.is_empty() {
		state.default_nickname
	} else {
		payload.nickname
	};

	Json(UpdateUserResponse {
		id: path.id,
		nickname,
		notify: query.notify.unwrap_or(false),
	})
}
```

这个函数一次性从请求里拿了四类信息：

- `State`：共享状态
- `Path`：路由参数
- `Query`：查询参数
- `Json`：请求体

这就是 axum handler 非常舒服的地方：

> 参数列表本身就在声明这个接口依赖哪些输入。

但这里也有一个重要规则：

> 消费 body 的提取器通常只能有一个。

也就是说，下面这种写法通常就是错误方向：

```rust
async fn wrong(Json(a): Json<A>, Json(b): Json<B>) {
	// body 不可能被解析两次
}
```

body 是一个流，不是可随便复制的值。所以一旦某个 Extractor 已经把 body 读走了，后面的 body Extractor 就没有可读内容了。

---

## 五、自定义 Extractor：把通用逻辑从 handler 里拿出来

内置 Extractor 很强，但真正让 axum 变得有工程味道的，是你可以自己定义 Extractor。

这通常适合做这些事情：

- 从请求头里提取认证用户
- 从 extensions 里提取已经注入的上下文
- 对某个参数做统一校验和转换
- 把多步重复解析逻辑封装成业务可复用组件

### 5.1 一个典型场景：提取当前登录用户

假设我们约定：

- 客户端必须在请求头里带 `Authorization: Bearer secret-token`
- 服务端校验成功后，构造出一个 `CurrentUser`
- handler 不再自己解析 header，而是直接拿 `CurrentUser`

先定义用户类型：

```rust
#[derive(Debug, Clone)]
struct CurrentUser {
	user_id: u64,
	username: String,
}
```

然后给它实现 `FromRequestParts`：

```rust
use axum::{
	extract::FromRequestParts,
	http::{header::AUTHORIZATION, request::Parts, StatusCode},
};

impl<S> FromRequestParts<S> for CurrentUser
where
	S: Send + Sync,
{
	type Rejection = (StatusCode, String);

	async fn from_request_parts(
		parts: &mut Parts,
		_state: &S,
	) -> Result<Self, Self::Rejection> {
		let auth_header = parts
			.headers
			.get(AUTHORIZATION)
			.and_then(|value| value.to_str().ok())
			.ok_or((StatusCode::UNAUTHORIZED, "missing authorization header".to_string()))?;

		let token = auth_header
			.strip_prefix("Bearer ")
			.ok_or((StatusCode::UNAUTHORIZED, "invalid authorization scheme".to_string()))?;

		if token != "secret-token" {
			return Err((StatusCode::UNAUTHORIZED, "invalid token".to_string()));
		}

		Ok(CurrentUser {
			user_id: 1,
			username: "chen".to_string(),
		})
	}
}
```

之后 handler 就可以直接这么写：

```rust
async fn profile(user: CurrentUser) -> String {
	format!("user_id={}, username={}", user.user_id, user.username)
}
```

这比在每个 handler 里反复写下面这些逻辑明显更好：

- 拿 header
- 解析 Bearer token
- 校验 token
- 构造用户对象

### 5.2 为什么这里用 `FromRequestParts`，而不是 `FromRequest`？

因为这个提取过程只依赖请求头，不需要读 body。

这时优先使用 `FromRequestParts` 的好处是：

- 不会和 `Json<T>` 之类的 body 提取器冲突
- 语义更清晰
- 可以和其他 body 提取器一起使用

例如：

```rust
async fn update_profile(
	user: CurrentUser,
	Json(payload): Json<UpdateProfileRequest>,
) {
	// user 来自 header
	// payload 来自 body
}
```

如果 `CurrentUser` 也去消费 body，那这个组合就很容易出问题。

### 5.3 自定义 Extractor 的价值不只是“省代码”

很多人刚接触自定义 Extractor，会觉得它只是“把重复代码包一下”。

但更准确地说，它的价值在于：

> 它把业务接口依赖的输入模型显式化了。

当你看到下面这个 handler：

```rust
async fn get_order(user: CurrentUser, Path(order_id): Path<u64>) -> String {
	format!("user {} requests order {}", user.user_id, order_id)
}
```

你几乎不需要看函数体，就知道这个接口的输入前提：

- 必须有认证用户
- 必须有订单 ID

这种可读性在接口越来越多时，价值会非常明显。

---

## 六、Extractor 和 Middleware 到底怎么分工？

这是学习 axum 时最容易混淆的问题之一。

因为很多场景看起来既能用 Extractor，也能用 Middleware。

例如认证：

- 中间件也能校验 token
- 自定义 Extractor 也能校验 token

那到底应该怎么选？

一个非常实用的判断方式是：

> Middleware 更适合“作用于请求处理链”的横切逻辑。
>
> Extractor 更适合“给当前 handler 准备参数”的输入逻辑。

### 6.1 更适合放在 Middleware 的场景

- 请求日志记录
- 统一超时控制
- 链路追踪与请求 ID 注入
- CORS、限流、压缩
- 对整个路由组生效的鉴权前置拦截

这些逻辑的共同特点是：

- 通常不只是为某一个 handler 准备参数
- 经常要在请求前后都参与
- 更像“包在 handler 外面的一层处理”

### 6.2 更适合放在 Extractor 的场景

- 提取当前用户
- 提取并解析分页参数
- 提取并校验业务请求模型
- 从 request extensions 里拿上下文
- 把若干 header 组合成一个明确的业务类型

这些逻辑的共同特点是：

- 直接服务于当前 handler 的输入参数
- 更强调“拿到一个已经可用的值”
- 不需要处理响应前后的完整生命周期

### 6.3 一个常见的组合方式

在真实项目里，Middleware 和 Extractor 往往是配合使用的，而不是二选一。

比如这样一条链路：

1. Middleware 负责做统一 token 粗校验、日志、链路信息注入
2. Middleware 把解析后的用户 ID 写入 `request.extensions`
3. 自定义 Extractor 再从 extensions 里提取 `CurrentUser`
4. handler 直接拿业务语义明确的参数

这种分层通常比“所有认证逻辑都写在一个地方”更清晰。

---

## 七、一个完整一点的示例：Path + Query + State + 自定义 Extractor

下面给一个稍微完整一点的例子，把几类常见提取器放到一起，便于你建立整体感。

```rust
use axum::{
	extract::{FromRequestParts, Path, Query, State},
	http::{header::AUTHORIZATION, request::Parts, StatusCode},
	response::IntoResponse,
	routing::get,
	Json, Router,
};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
struct AppState {
	service_name: String,
}

#[derive(Debug, Clone)]
struct CurrentUser {
	user_id: u64,
}

impl<S> FromRequestParts<S> for CurrentUser
where
	S: Send + Sync,
{
	type Rejection = (StatusCode, String);

	async fn from_request_parts(
		parts: &mut Parts,
		_state: &S,
	) -> Result<Self, Self::Rejection> {
		let auth_header = parts
			.headers
			.get(AUTHORIZATION)
			.and_then(|value| value.to_str().ok())
			.ok_or((StatusCode::UNAUTHORIZED, "missing token".to_string()))?;

		if auth_header != "Bearer secret-token" {
			return Err((StatusCode::UNAUTHORIZED, "invalid token".to_string()));
		}

		Ok(CurrentUser { user_id: 1001 })
	}
}

#[derive(Deserialize)]
struct ArticleQuery {
	preview: Option<bool>,
}

#[derive(Serialize)]
struct ArticleResponse {
	article_id: u64,
	owner_id: u64,
	preview: bool,
	service: String,
}

async fn get_article(
	State(state): State<AppState>,
	user: CurrentUser,
	Path(article_id): Path<u64>,
	Query(query): Query<ArticleQuery>,
) -> impl IntoResponse {
	Json(ArticleResponse {
		article_id,
		owner_id: user.user_id,
		preview: query.preview.unwrap_or(false),
		service: state.service_name,
	})
}

#[tokio::main]
async fn main() {
	let app = Router::new()
		.route("/articles/{id}", get(get_article))
		.with_state(AppState {
			service_name: "content-service".to_string(),
		});

	let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
		.await
		.unwrap();

	axum::serve(listener, app).await.unwrap();
}
```

访问时：

```text
GET /articles/42?preview=true
Authorization: Bearer secret-token
```

handler 最终拿到的是：

- `State` 提供的应用状态
- `CurrentUser` 提供的认证用户
- `Path` 提供的文章 ID
- `Query` 提供的查询参数

这已经非常接近真实项目里的接口写法了。

---

## 八、写 Extractor 时最容易踩的坑

### 8.1 把 body 提取器写了多个

这是最常见的坑之一。

例如：

```rust
async fn wrong_handler(
	Json(a): Json<A>,
	body: String,
) {
	// 两者都想消费 body
}
```

一旦某个参数已经把 body 读走，后面的 body 提取器就没有机会再读。

记住这条就够了：

> 请求体通常只能被一个提取器消费。

### 8.2 明明只读 header，却错误实现成 `FromRequest`

如果你的逻辑只依赖：

- header
- method
- uri
- extensions
- state

那通常应该优先实现 `FromRequestParts`。

否则你会平白引入 body 冲突风险，也让语义变得不准确。

### 8.3 在 handler 里重复做参数解析

很多人虽然知道有 Extractor，但还是习惯在 handler 里自己拿 header、自己 parse、自己做基础校验。

这样写短期看很直接，长期会带来两个问题：

- 相同逻辑难以复用
- handler 语义越来越不清楚

只要某段逻辑在多个接口里重复出现，并且它本质上是在“准备输入参数”，就应该考虑抽成自定义 Extractor。

### 8.4 把所有校验都塞进 Middleware

Middleware 确实很强，但它不是所有输入问题的万能归宿。

如果某段逻辑最终的目标是：

- 给 handler 准备一个明确参数
- 让参数列表表达接口依赖

那 Extractor 通常是更自然的设计。

### 8.5 错误类型设计得过于随意

自定义 Extractor 往往需要定义 `Rejection`。

初学时直接返回 `(StatusCode, String)` 没问题，但如果项目逐渐变大，更建议统一错误模型，例如：

- `AppError`
- `ApiError`
- 自定义 `IntoResponse`

这样错误处理方式会更一致，也更利于接口规范化。

---

## 九、如何判断一个逻辑该不该抽成 Extractor？

我自己会用一个很简单的判断方法：

如果这段逻辑的目标是下面三件事之一，就优先考虑 Extractor：

1. 从请求中拿数据
2. 把原始数据转换成更明确的业务类型
3. 在进入 handler 前完成参数层面的基础校验

例如这些都很适合：

- `CurrentUser`
- `Pagination`
- `RequestId`
- `ValidatedJson<T>`
- `TenantContext`

反过来说，如果这段逻辑的目标更像：

- 包裹整条请求处理链
- 在请求前后都做动作
- 作用于一批路由而不是单个参数

那通常更适合 Middleware。

这个判断不需要绝对教条，但足够指导大多数工程实践。

---

## 十、总结

axum 的 Extractor 之所以重要，不是因为它提供了几个方便的类型，而是因为它把 Web 请求处理这件事拆得很清楚：

- 路由负责匹配请求
- Extractor 负责准备 handler 输入
- Middleware 负责处理横切逻辑
- handler 负责真正的业务逻辑

当你理解了这一层分工之后，handler 的写法就不再只是“会用几个类型”，而是开始具备清晰的设计感。

这篇文章你至少应该带走下面几个关键点：

1. Extractor 的本质是“把请求数据转换为 handler 参数”
2. axum 会区分 `FromRequestParts` 和 `FromRequest`
3. `Path`、`Query`、`Json`、`State` 是最常用的几类提取器
4. body 通常只能被消费一次，所以 body 提取器要特别注意组合关系
5. 自定义 Extractor 很适合封装认证用户、分页参数、业务上下文等通用输入逻辑
6. Middleware 和 Extractor 不是替代关系，而是分工不同

如果你刚从中间件那篇文章继续往下看，那么到这里，你应该已经能把 axum 中请求进入 handler 之前最核心的两层机制串起来了：

- Middleware 负责包裹请求处理链
- Extractor 负责准备 handler 参数

再往后，一个非常自然的进阶方向就是继续写：

- axum 状态管理与共享数据
- axum 错误处理与统一响应设计
- axum 与 tower 的关系

因为当你把这几块再补上，整个 axum Web 服务的工程化骨架就基本完整了。
