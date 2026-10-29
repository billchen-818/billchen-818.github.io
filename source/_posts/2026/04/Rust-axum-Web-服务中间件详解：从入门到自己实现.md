---
title: Rust axum Web 服务中间件详解：从入门到自己实现
date: 2026-04-17 11:03:43
tags: Rust
---

## 引言

在 Web 服务开发里，路由和处理函数当然重要，但真正决定一个服务是否“像工程项目”的，往往是中间件。

比如下面这些能力，通常都不是直接写在业务 handler 里的：

- 请求日志记录
- 统一鉴权
- 超时控制
- 跨域处理
- 请求 ID 注入
- 指标统计
- 限流与熔断

这些横切能力如果全部写进业务函数，会很快让代码变得混乱：

- handler 不再只关心业务本身
- 相同逻辑被反复复制
- 路由层和业务层耦合严重
- 后续很难扩展和排查问题

而中间件，就是解决这类问题的关键手段。

在 Rust 的 axum 框架里，中间件并不是一个“额外附加”的概念，它和整个框架底层的 `tower` 抽象是紧密结合的。也正因为如此，axum 中间件既容易上手，又有很强的扩展能力。

这篇文章我会从浅到深讲清楚几个问题：

1. 什么是中间件，为什么它重要
2. axum 中间件的执行模型到底是什么
3. 如何用 `from_fn` 写自己的中间件
4. 如何在中间件里做鉴权，并把上下文传递给 handler
5. `layer` 和 `route_layer` 到底有什么区别
6. 为什么 axum 背后其实是 `tower::Layer` 和 `tower::Service`
7. 初学者在写中间件时最容易踩哪些坑

如果你刚学会 axum，这篇文章可以作为一个比较完整的入门案例；如果你已经能写基础路由，这篇文章会帮你把“能用”提升到“理解设计”。

---

## 一、什么是中间件？

先用一句最直白的话来定义：

> 中间件就是在请求到达 handler 前后插入的一层通用处理逻辑。

一次 HTTP 请求进入服务后，通常会经历这样一条链路：

```text
客户端请求
   -> 日志中间件
   -> 鉴权中间件
   -> 限流中间件
   -> 业务 handler
   -> 响应返回
```

你可以把它理解成“洋葱模型”：

- 请求进入时，从外到内一层层穿过
- 响应返回时，再从内到外一层层返回

所以中间件天然适合处理“和具体业务无关，但又作用于很多路由”的逻辑。

例如：

- 记录请求耗时
- 校验请求头里的 token
- 给每个请求打唯一标识
- 给响应补充统一 header

这类逻辑有两个特点：

- 它们不是某一个接口独有的
- 它们应该尽量集中管理，而不是散落在各个 handler 中

---

## 二、axum 中间件的核心理解

很多人第一次学 axum 中间件，容易只记住一个写法：

```rust
.layer(middleware::from_fn(my_middleware))
```

但如果只停留在这个层面，后面很容易对执行顺序、作用范围、状态传递感到困惑。

要真正理解 axum 中间件，必须先记住一句话：

> axum 构建在 tower 之上，而 tower 的核心抽象是 `Service` 和 `Layer`。

可以先做一个粗略理解：

- `Service`：接收请求并返回响应的东西
- `Layer`：把一个 `Service` 包起来，变成一个新的 `Service`

所以本质上，中间件不是“在 handler 前插一段代码”这么简单，而是：

> 通过包装服务的方式，在请求处理链外面再套一层逻辑。

这也是为什么 axum 的 `.layer(...)` 看起来像“叠一层”。

### 2.1 axum 中间件最常见的三种入口

在日常开发里，你通常会接触到这几种方式：

1. `middleware::from_fn`
2. `middleware::from_fn_with_state`
3. `Router::layer` / `Router::route_layer`

其中最适合初学者入门的是前两种。

### 2.2 from_fn 的执行模型

一个最基本的中间件函数通常长这样：

```rust
use axum::{
	extract::Request,
	middleware::Next,
	response::Response,
};

async fn my_middleware(request: Request, next: Next) -> Response {
	println!("before handler");

	let response = next.run(request).await;

	println!("after handler");
	response
}
```

这里最关键的是 `next.run(request).await`。

你可以把它理解成：

- 调用之前，是“请求进入下一层之前”
- 调用之后，是“下一层执行完成，响应返回之后”

所以中间件往往具备两个切入点：

- 请求前处理
- 响应后处理

这正是它适合做日志、埋点、统一 header 注入的原因。

---

## 三、先写一个最简单的日志中间件

学习任何框架，中间件最适合作为第一个例子的通常都是日志。

因为它既能体现“前置 + 后置”这两个阶段，也不会掺杂太多业务逻辑。

### 3.1 代码示例

```rust
use axum::{
	extract::Request,
	middleware::Next,
	response::Response,
};
use std::time::Instant;

async fn access_log(request: Request, next: Next) -> Response {
	let method = request.method().clone();
	let path = request.uri().path().to_string();
	let start = Instant::now();

	let response = next.run(request).await;

	let status = response.status();
	let cost = start.elapsed();

	println!("[{}] {} -> {} ({:?})", method, path, status, cost);
	response
}
```

这个中间件做了三件事：

1. 在请求进入时记录 method 和 path
2. 调用下一层服务
3. 在响应返回时计算耗时并打印状态码

### 3.2 挂载到 Router

```rust
use axum::{middleware, routing::get, Router};

async fn ping() -> &'static str {
	"pong"
}

let app = Router::new()
	.route("/ping", get(ping))
	.layer(middleware::from_fn(access_log));
```

现在访问 `/ping`，你就会在控制台看到类似输出：

```text
[GET] /ping -> 200 OK (624.541µs)
```

这是一个很小的例子，但它已经具备了中间件最核心的思维模式：

- 不修改业务 handler
- 统一作用于请求链
- 前后两段逻辑自然分离

---

## 四、真正有实战价值的例子：鉴权中间件

日志只能帮助理解执行模型，而鉴权才是真正最常见的业务中间件之一。

在很多服务里，我们都会遇到这类需求：

- 访问公开接口时不需要登录
- 访问受保护接口时必须带 token
- token 校验通过后，把用户信息传给 handler

这非常适合通过中间件来实现。

### 4.1 设计目标

我们希望达到这样的效果：

- `GET /ping` 公开访问
- `GET /profile` 需要鉴权
- 客户端需要带上 `Authorization: Bearer secret-token`
- 校验成功后，把当前用户写入 request extensions
- handler 直接读取用户上下文，不再关心 token 校验细节

### 4.2 完整可运行示例

先看 `Cargo.toml`：

```toml
[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

再看主程序：

```rust
use axum::{
	extract::{Request, State},
	http::{header::AUTHORIZATION, StatusCode},
	middleware::{self, Next},
	response::{IntoResponse, Response},
	routing::get,
	Extension, Json, Router,
};
use serde::Serialize;
use serde_json::json;
use std::time::Instant;

#[derive(Clone)]
struct AppState {
	api_token: String,
}

#[derive(Clone, Debug)]
struct CurrentUser {
	user_id: u64,
	role: &'static str,
}

#[derive(Serialize)]
struct ApiResponse<T> {
	code: u32,
	message: String,
	data: T,
}

async fn access_log(request: Request, next: Next) -> Response {
	let method = request.method().clone();
	let path = request.uri().path().to_string();
	let start = Instant::now();

	let response = next.run(request).await;

	println!(
		"[{}] {} -> {} ({:?})",
		method,
		path,
		response.status(),
		start.elapsed()
	);

	response
}

async fn require_auth(
	State(state): State<AppState>,
	mut request: Request,
	next: Next,
) -> Result<Response, StatusCode> {
	let token = request
		.headers()
		.get(AUTHORIZATION)
		.and_then(|value| value.to_str().ok())
		.and_then(|value| value.strip_prefix("Bearer "));

	if token != Some(state.api_token.as_str()) {
		return Err(StatusCode::UNAUTHORIZED);
	}

	request.extensions_mut().insert(CurrentUser {
		user_id: 1001,
		role: "admin",
	});

	Ok(next.run(request).await)
}

async fn ping() -> &'static str {
	"pong"
}

async fn profile(Extension(user): Extension<CurrentUser>) -> impl IntoResponse {
	Json(ApiResponse {
		code: 0,
		message: "ok".to_string(),
		data: json!({
			"user_id": user.user_id,
			"role": user.role,
		}),
	})
}

#[tokio::main]
async fn main() {
	let state = AppState {
		api_token: "secret-token".to_string(),
	};

	let protected_routes = Router::new()
		.route("/profile", get(profile))
		.route_layer(middleware::from_fn_with_state(
			state.clone(),
			require_auth,
		));

	let app = Router::new()
		.route("/ping", get(ping))
		.merge(protected_routes)
		.layer(middleware::from_fn(access_log))
		.with_state(state);

	let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
		.await
		.unwrap();

	println!("server listening on http://127.0.0.1:3000");

	axum::serve(listener, app).await.unwrap();
}
```

### 4.3 运行结果

请求公开接口：

```bash
curl http://127.0.0.1:3000/ping
```

返回：

```text
pong
```

请求受保护接口但不带 token：

```bash
curl http://127.0.0.1:3000/profile
```

返回状态码：

```text
401 Unauthorized
```

携带 token 请求：

```bash
curl -H "Authorization: Bearer secret-token" http://127.0.0.1:3000/profile
```

返回：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
	"user_id": 1001,
	"role": "admin"
  }
}
```

---

## 五、这个鉴权中间件到底做对了什么？

很多初学者第一次写鉴权，喜欢直接在 handler 里这样做：

```rust
async fn profile(headers: HeaderMap) {
	// 这里面自己解析 Authorization
	// 自己校验 token
	// 自己决定是否返回 401
}
```

这当然能跑，但设计上并不理想。

### 5.1 handler 职责被污染

handler 本来应该只关心业务：

- 获取当前用户
- 查询用户资料
- 返回结果

如果每个 handler 都重复做 token 解析，那就意味着：

- 每个接口都重复写一遍
- 一旦认证方式变化，需要全局修改
- 很难统一错误处理

### 5.2 中间件把“认证”和“业务”拆开了

在上面的实现里：

- `require_auth` 负责认证
- `profile` 只负责使用认证结果

这一点非常重要。

因为工程设计里最值钱的不是“把功能写出来”，而是“把边界切清楚”。

### 5.3 用 request extensions 传递上下文

下面这行代码是整个设计里的关键：

```rust
request.extensions_mut().insert(CurrentUser {
	user_id: 1001,
	role: "admin",
});
```

它的含义是：

> 中间件把已经解析好的用户上下文放进 request 的扩展存储区，供后续 handler 提取。

然后在 handler 中：

```rust
async fn profile(Extension(user): Extension<CurrentUser>) -> impl IntoResponse {
	// 直接使用 user
}
```

这样就形成了非常干净的职责分层：

- 中间件负责“把用户识别出来”
- handler 负责“使用已经识别出的用户”

这比在每个 handler 里重复解析 header 明显更清晰。

---

## 六、layer 和 route_layer 的区别

这是 axum 初学者最容易混淆的点之一。

### 6.1 layer：作用在整个 Router 上

```rust
let app = Router::new()
	.route("/ping", get(ping))
	.route("/profile", get(profile))
	.layer(middleware::from_fn(access_log));
```

这里的 `layer` 会作用于整个 Router。

也就是说，这个 Router 下的所有路由都会经过该中间件。

这很适合：

- 统一日志
- 超时控制
- 压缩
- CORS

### 6.2 route_layer：只作用于匹配到的路由

```rust
let protected_routes = Router::new()
	.route("/profile", get(profile))
	.route_layer(middleware::from_fn_with_state(state.clone(), require_auth));
```

这里的 `route_layer` 只会对当前路由组生效。

它特别适合做：

- 需要保护的接口组
- 只针对部分接口启用的中间件

### 6.3 为什么鉴权更适合 route_layer

假设你把鉴权写在顶层 `layer`：

```rust
let app = Router::new()
	.route("/ping", get(ping))
	.route("/profile", get(profile))
	.layer(middleware::from_fn_with_state(state.clone(), require_auth));
```

那意味着：

- `/ping` 也会被要求认证
- 甚至有时连本该返回 404 的请求，也可能先被鉴权拦住

这通常不是我们想要的行为。

所以经验上可以记一句：

> 日志、超时、压缩这类全局能力用 `layer`；鉴权、权限控制这类局部能力更适合 `route_layer`。

---

## 七、中间件的执行顺序怎么理解？

如果你叠了多个中间件，顺序就变得很重要。

很多人第一次看到下面这种写法时，会直觉地以为执行顺序是从上到下：

```rust
use axum::{routing::get, Router};

async fn handler() {}

let app = Router::new()
		.route("/", get(handler))
		.layer(layer_one)
		.layer(layer_two)
		.layer(layer_three);
```

但真正的理解方式应该是：

```text
layer_three(
		layer_two(
				layer_one(
						handler
				)
		)
)
```

也就是说，后调用的 `.layer(...)` 会包在最外层。

### 7.1 请求进入时的执行顺序

对于上面这段代码，请求进来时的顺序是：

1. `layer_three` 前置逻辑
2. `layer_two` 前置逻辑
3. `layer_one` 前置逻辑
4. `handler`

### 7.2 响应返回时的执行顺序

当 handler 开始返回响应时，顺序正好反过来：

1. `layer_one` 后置逻辑
2. `layer_two` 后置逻辑
3. `layer_three` 后置逻辑

如果把它画成一条链，会更直观：

```text
请求进入:
客户端
	-> layer_three
	-> layer_two
	-> layer_one
	-> handler

响应返回:
handler
	-> layer_one
	-> layer_two
	-> layer_three
	-> 客户端
```

所以可以总结成一句非常重要的话：

> 在 axum 里，多个 `.layer(...)` 叠加时，最靠后的那一层最先处理请求，也最晚处理响应。

例如：

```rust
let app = Router::new()
	.route("/profile", get(profile))
	.layer(middleware::from_fn(access_log))
	.layer(middleware::from_fn(trace_request));
```

你可以把它理解为：

```text
trace_request(
	access_log(
		handler
	)
)
```

请求进入顺序：

1. `trace_request` 前置逻辑
2. `access_log` 前置逻辑
3. handler
4. `access_log` 后置逻辑
5. `trace_request` 后置逻辑

这就是典型的“洋葱模型”。

如果把这条规则套回你刚才那段代码：

- `layer_three` 最外层
- `layer_two` 在中间
- `layer_one` 最内层
- `handler` 在最中心

所以如果你同时有：

- 请求 ID 注入
- 日志记录
- 鉴权

通常要想清楚顺序问题：

- 是先打 request id 再记录日志
- 还是先鉴权再记业务日志

顺序不同，日志内容和排查体验就会不同。

---

## 八、什么时候用 from_fn，什么时候自己实现 Layer？

对初学者来说，`from_fn` 已经能解决 80% 的问题。

比如：

- 打日志
- 检查 header
- 记录耗时
- 注入 request 上下文
- 做简单权限校验

这些场景优先用 `from_fn` 就够了。

但如果你想写一个：

- 可复用性很高
- 可以像第三方组件一样挂载
- 和 tower 生态深度兼容

的通用中间件，那么通常应该实现 `tower::Layer` 和 `tower::Service`。

### 8.1 一个简化版骨架

下面是一个“请求 ID 中间件”的简化骨架，用来帮助你理解底层结构：

```rust
use axum::{
	body::Body,
	http::Request,
	response::Response,
};
use std::{
	future::Future,
	pin::Pin,
	task::{Context, Poll},
};
use tower::{Layer, Service};
use uuid::Uuid;

#[derive(Clone)]
struct RequestId(String);

#[derive(Clone)]
struct RequestIdLayer;

impl<S> Layer<S> for RequestIdLayer {
	type Service = RequestIdService<S>;

	fn layer(&self, inner: S) -> Self::Service {
		RequestIdService { inner }
	}
}

#[derive(Clone)]
struct RequestIdService<S> {
	inner: S,
}

impl<S> Service<Request<Body>> for RequestIdService<S>
where
	S: Service<Request<Body>, Response = Response> + Clone + Send + 'static,
	S::Future: Send + 'static,
{
	type Response = S::Response;
	type Error = S::Error;
	type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, mut request: Request<Body>) -> Self::Future {
		let request_id = Uuid::new_v4().to_string();
		request.extensions_mut().insert(RequestId(request_id));

		let mut inner = self.inner.clone();
		Box::pin(async move { inner.call(request).await })
	}
}
```

这个例子不要求你现在就完全掌握，但你至少要看懂两件事：

1. `Layer` 是“包装器工厂”
2. `Service` 是真正处理请求的对象

也就是说，axum 中间件的本质并不是语法糖，而是基于 tower 抽象出来的一套通用服务链模型。

这也是 axum 和 tower-http 能很好协同的根本原因。

---

## 九、生产环境里，很多中间件其实不用自己写

虽然这篇文章的主题是“自己实现中间件”，但从工程实践角度说，有一句话非常重要：

> 能用成熟组件，就不要重复造轮子。

在真实项目里，很多常见需求都可以直接用现成中间件：

- `tower_http::trace::TraceLayer`：请求日志与 tracing 集成
- `tower_http::cors::CorsLayer`：跨域
- `tower_http::compression::CompressionLayer`：压缩
- `tower::timeout::TimeoutLayer`：超时
- `tower::limit`：并发限制、速率限制

自己写中间件的典型场景通常是：

- 认证逻辑和你的业务强相关
- 需要往 request extensions 里写入自定义上下文
- 需要统一封装某种公司内部规范

所以更合理的策略不是“所有中间件都自己写”，而是：

- 通用能力尽量复用社区组件
- 业务能力按需自己实现

---

## 十、初学者最容易踩的几个坑

### 10.1 在中间件里消费了请求体

HTTP 请求体通常只能被消费一次。

如果你在中间件里提前把 body 读走了，后面的 handler 往往就拿不到内容了。

所以对于请求体处理，要非常谨慎。除非你明确知道自己在做什么，否则不要在通用中间件里随意读取 body。

### 10.2 鉴权写在顶层 layer，结果把 404 也拦了

这是最常见的设计错误之一。

如果你只想保护部分路由，优先考虑 `route_layer`，而不是直接挂在整个 app 顶层。

### 10.3 中间件里做阻塞操作

axum 运行在异步运行时里。

如果你在中间件里直接做阻塞 IO，比如：

- 大量同步文件读取
- 阻塞式数据库操作
- 长时间 CPU 密集型任务

那么你会拖慢整个请求处理链。

### 10.4 把太多业务细节塞进中间件

中间件适合做“横切能力”，不适合承载复杂业务流程。

比如：

- 认证适合放中间件
- 查询订单详情不适合放中间件
- 检查权限标签是否存在可以放中间件
- 执行复杂订单结算流程不适合放中间件

判断标准很简单：

> 如果这段逻辑和很多 handler 都相关，它更可能适合中间件；如果它只属于某一个业务动作，那更应该放在业务层。

---

## 十一、一个适合初学者模仿的落地思路

如果你准备自己写一个小型 axum 服务，我建议中间件部分按下面顺序练习：

1. 先写一个访问日志中间件，理解 `next.run(request).await`
2. 再写一个 token 鉴权中间件，理解“提前返回错误响应”
3. 然后尝试把用户上下文写入 extensions，理解“上下文传递”
4. 最后再去理解 `Layer` 和 `Service`，知道底层抽象是什么

这个学习路径是比较稳的。

因为中间件真正难的不是语法，而是这三件事：

- 作用范围怎么控制
- 执行顺序怎么设计
- 上下文怎么安全传递

把这三件事理解清楚，axum 中间件基本就入门了。

---

## 十二、总结

axum 中间件之所以值得认真学，是因为它不是一个“框架附带技巧”，而是 Web 服务工程化的核心能力之一。

这篇文章里，你可以记住以下几个关键点：

- 中间件适合处理横切逻辑，不适合塞复杂业务
- `from_fn` 是最适合初学者的实现方式
- `next.run(request).await` 是理解中间件前后逻辑的关键
- 认证完成后，最好通过 request extensions 向 handler 传递上下文
- `layer` 更适合全局能力，`route_layer` 更适合局部保护
- axum 中间件的底层本质是 tower 的 `Layer` 和 `Service`

如果你只是想把项目先做起来，那么从 `from_fn` 开始就足够了；如果你想真正理解 axum 的设计，那就继续往 tower 的服务抽象里走。

这也是 Rust Web 开发里非常有意思的一点：

表面上你是在“写一个中间件”，实际上你是在理解一整套可组合、可扩展的服务模型。

当你把这一层想通，后面不管是接 tracing、做限流、接网关能力，都会自然很多。
