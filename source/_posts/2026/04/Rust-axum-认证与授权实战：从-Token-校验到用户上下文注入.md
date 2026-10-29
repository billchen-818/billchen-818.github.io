---
title: Rust axum 认证与授权实战：从 Token 校验到用户上下文注入
date: 2026-04-20 09:08:54
tags: Rust
---

## 引言

学 axum 的时候，很多人很快都会写出这样的接口：

- `GET /ping`
- `GET /users/{id}`
- `POST /articles`

但只要服务开始接近真实业务，另一个问题马上就会出现：

> 哪些接口可以公开访问，哪些接口必须登录后才能访问？

再往下写，又会碰到第二层问题：

> 就算用户已经登录了，他是不是一定有权限执行这个操作？

这两个问题看起来接近，但本质并不是一回事：

- 认证：你是谁
- 授权：你能做什么

很多项目刚开始时会把它们混在一起处理：

- 在 handler 里手动取 `Authorization`
- 手动拆 Bearer token
- 手动查用户
- 再手动判断角色和资源归属

这种写法当然能跑，但很快就会出现几个问题：

- 相同认证逻辑在多个 handler 里重复
- handler 里塞满请求头解析细节
- 用户上下文在接口间无法复用
- 认证和授权职责边界越来越模糊

而 axum 恰好很适合把这件事拆干净，因为它本身就已经有很清晰的几层抽象：

- Middleware 负责横切处理
- Extractor 负责准备输入参数
- State 负责提供共享依赖
- handler 负责业务逻辑

这篇文章我会围绕这条主线，把 axum 里的认证与授权从简单到实战串起来，重点讲清楚下面这些问题：

1. 认证和授权到底有什么区别
2. 最基础的基于 Header 的 Token 认证怎么做
3. 为什么中间件适合做认证前置拦截
4. 如何把用户上下文挂到请求里，再交给 handler 使用
5. JWT 认证流程到底是什么
6. 为什么“中间件做认证，handler 做授权”通常是更清晰的设计

如果你已经写过 axum 的中间件、提取器、状态管理和错误处理，这一篇基本就是下一步最自然的实战主题。

---

## 一、先把概念分开：认证不等于授权

很多人第一次做接口权限控制时，会把认证和授权混成一个词：“鉴权”。

从工程角度讲，这么说问题不大，但真正写系统时，最好还是把它们区分开。

### 1.1 认证是什么？

认证回答的是：

> 当前请求背后的用户是谁？

典型例子：

- 这个 token 是不是合法的
- 这个 token 对应的是哪个用户
- 这个用户当前登录态是否有效

如果用户连身份都不能确认，那通常后面的业务逻辑就不该继续执行。

### 1.2 授权是什么？

授权回答的是：

> 已经确定身份之后，这个用户是否有权执行当前操作？

典型例子：

- 普通用户能不能访问管理后台接口
- 当前用户能不能修改这篇文章
- 这个租户下的用户能不能读取另一个租户的数据

所以：

- 认证更偏“身份确认”
- 授权更偏“权限判断”

这两个阶段分开以后，设计会清楚很多。

---

## 二、最简单的起点：基于 Header 的 Token 认证

先不要一上来就讲 JWT，先从最基本的 Bearer Token 开始。

假设我们约定：

- 客户端请求受保护接口时，必须携带 `Authorization` 头
- 格式为 `Authorization: Bearer secret-token`
- 服务端校验通过后，才允许继续访问

最原始的 handler 写法可能会像这样：

```rust
use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    response::IntoResponse,
};

async fn profile(request: Request) -> impl IntoResponse {
    let auth_header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    match auth_header {
        Some("Bearer secret-token") => "ok",
        _ => (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
    }
}
```

这段代码当然可以工作，但问题也很明显：

- 每个受保护接口都要重复写这段解析逻辑
- handler 被 HTTP 头部细节污染
- 后续一旦 token 校验逻辑变复杂，代码会迅速膨胀

所以这种写法只适合帮助理解，不适合长期维护。

---

## 三、为什么认证更适合放在 Middleware？

只要一个逻辑具备下面这些特征，它通常就很适合放在中间件里：

- 作用于一组路由，而不是某一个 handler
- 属于横切逻辑
- 在业务处理前就应该决定是否放行

认证正好非常符合这几个特征。

因为对受保护接口来说，认证通常是一道前置门槛：

- token 合法，继续往下走
- token 不合法，直接返回 401

这和日志、超时、请求 ID 注入非常像，都是“包在 handler 外面的一层处理”。

所以很自然的设计就是：

> 中间件负责认证前置拦截。

但这里有个关键点：

> 中间件不仅可以拦截失败请求，还可以把认证后的用户上下文继续传给后面的 handler。

这才是它真正有工程价值的地方。

---

## 四、先写一个最简单的认证中间件

下面先写一个最基础、可运行、便于理解的版本。

```rust
use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

async fn auth_middleware(request: Request, next: Next) -> Response {
    let auth_header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    match auth_header {
        Some("Bearer secret-token") => next.run(request).await,
        _ => (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
    }
}
```

然后把它挂到受保护路由上：

```rust
use axum::{middleware, routing::get, Router};

async fn ping() -> &'static str {
    "pong"
}

async fn profile() -> &'static str {
    "private profile"
}

let app = Router::new()
    .route("/ping", get(ping))
    .route("/profile", get(profile).route_layer(middleware::from_fn(auth_middleware)));
```

这个版本已经能满足最基本的需求：

- `GET /ping` 可公开访问
- `GET /profile` 需要带合法 token

但它还缺一个很重要的能力：

> handler 还不知道“当前用户是谁”。

也就是说，中间件虽然做了放行判断，但还没有把认证结果传递下去。

---

## 五、认证的真正价值：把用户上下文传给 handler

在真实业务里，接口往往不只是要知道“有没有登录”，还要知道：

- 当前用户 ID 是多少
- 当前用户名是什么
- 当前角色是什么
- 当前租户是什么

这些信息可以统称为：

> 用户上下文。

在 axum 里，一个很自然的做法是：

1. 中间件校验 token
2. 解析出用户信息
3. 把用户信息写入 request extensions
4. handler 再通过 Extractor 取出来

这正好把 Middleware 和 Extractor 的职责衔接起来了。

---

## 六、把认证用户写入 request extensions

先定义一个用户上下文类型：

```rust
#[derive(Debug, Clone)]
struct CurrentUser {
    user_id: u64,
    username: String,
    role: String,
}
```

然后在中间件里校验 token，并把用户写入请求扩展：

```rust
use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

#[derive(Debug, Clone)]
struct CurrentUser {
    user_id: u64,
    username: String,
    role: String,
}

async fn auth_middleware(mut request: Request, next: Next) -> Response {
    let auth_header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    let user = match auth_header {
        Some("Bearer admin-token") => CurrentUser {
            user_id: 1,
            username: "admin".to_string(),
            role: "admin".to_string(),
        },
        Some("Bearer user-token") => CurrentUser {
            user_id: 2,
            username: "alice".to_string(),
            role: "user".to_string(),
        },
        _ => return (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
    };

    request.extensions_mut().insert(user);
    next.run(request).await
}
```

这一步的意义非常大，因为它把认证结果正式变成了请求上下文的一部分。

接下来，后面的处理层就不需要再重新解析一遍 token 了。

---

## 七、用自定义 Extractor 拿到当前用户

如果 handler 每次都手动从 extensions 里取 `CurrentUser`，虽然比自己解析 token 好一些，但还是不够优雅。

更自然的方式是给 `CurrentUser` 实现自定义 Extractor。

```rust
use axum::{
    extract::FromRequestParts,
    http::{request::Parts, StatusCode},
};

#[derive(Debug, Clone)]
struct CurrentUser {
    user_id: u64,
    username: String,
    role: String,
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
        parts
            .extensions
            .get::<CurrentUser>()
            .cloned()
            .ok_or((StatusCode::UNAUTHORIZED, "missing current user".to_string()))
    }
}
```

之后 handler 就可以直接这么写：

```rust
async fn profile(user: CurrentUser) -> String {
    format!("hello {}, your id is {}", user.username, user.user_id)
}
```

这里的好处非常明显：

- handler 参数语义清晰
- handler 不需要关心用户是从 header 还是 extensions 来的
- 用户上下文成为可复用输入能力

这也是前面几篇里一直在强调的设计方向：

- Middleware 负责横切处理
- Extractor 负责输入准备

认证和用户上下文注入，正好是它们配合得最自然的一个场景。

---

## 八、一个完整一点的认证示例

下面给一个把路由、中间件、自定义 Extractor 串起来的完整示例。

```rust
use axum::{
    extract::{FromRequestParts, Request},
    http::{header::AUTHORIZATION, request::Parts, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};

#[derive(Debug, Clone)]
struct CurrentUser {
    user_id: u64,
    username: String,
    role: String,
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
        parts
            .extensions
            .get::<CurrentUser>()
            .cloned()
            .ok_or((StatusCode::UNAUTHORIZED, "missing current user".to_string()))
    }
}

async fn auth_middleware(mut request: Request, next: Next) -> Response {
    let auth_header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    let user = match auth_header {
        Some("Bearer admin-token") => CurrentUser {
            user_id: 1,
            username: "admin".to_string(),
            role: "admin".to_string(),
        },
        Some("Bearer user-token") => CurrentUser {
            user_id: 2,
            username: "alice".to_string(),
            role: "user".to_string(),
        },
        _ => return (StatusCode::UNAUTHORIZED, "unauthorized").into_response(),
    };

    request.extensions_mut().insert(user);
    next.run(request).await
}

async fn ping() -> &'static str {
    "pong"
}

async fn profile(user: CurrentUser) -> String {
    format!("profile of {}", user.username)
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/ping", get(ping))
        .route(
            "/profile",
            get(profile).route_layer(middleware::from_fn(auth_middleware)),
        );

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
        .await
        .unwrap();

    axum::serve(listener, app).await.unwrap();
}
```

这个例子已经很接近很多项目的基础认证框架了。

---

## 九、JWT 到底是什么，认证流程怎么走？

讲到这里，就可以把视角从“固定 token”扩展到更常见的 JWT 方案了。

先说结论：

> JWT 不是权限系统本身，而是一种用来携带身份声明的令牌格式。

它通常会携带一些声明信息，例如：

- 用户 ID
- 用户名
- 角色
- 过期时间
- 签发时间

一个典型的 JWT 认证流程通常是这样：

1. 用户登录成功
2. 服务端签发 JWT
3. 客户端在后续请求里携带 JWT
4. 中间件验证 JWT 签名和过期时间
5. 解析出 claims，构造当前用户上下文
6. 把用户上下文写入 request extensions
7. handler 使用 `CurrentUser` 继续业务逻辑

所以从设计上看，JWT 并不会改变前面那套结构，它只是把“如何从 token 里得到用户身份”这一环替换得更真实了。

---

## 十、一个简化版的 JWT 认证示例

下面给一个示意性例子，重点看结构，不纠结具体库细节。

```rust
use axum::{
    extract::Request,
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: u64,
    username: String,
    role: String,
    exp: usize,
}

#[derive(Debug, Clone)]
struct CurrentUser {
    user_id: u64,
    username: String,
    role: String,
}

async fn jwt_auth_middleware(mut request: Request, next: Next) -> Response {
    let auth_header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    let token = match auth_header.and_then(|value| value.strip_prefix("Bearer ")) {
        Some(token) => token,
        None => return (StatusCode::UNAUTHORIZED, "missing bearer token").into_response(),
    };

    let claims = match decode_jwt(token) {
        Ok(claims) => claims,
        Err(_) => return (StatusCode::UNAUTHORIZED, "invalid token").into_response(),
    };

    let user = CurrentUser {
        user_id: claims.sub,
        username: claims.username,
        role: claims.role,
    };

    request.extensions_mut().insert(user);
    next.run(request).await
}

fn decode_jwt(_token: &str) -> Result<Claims, ()> {
    Ok(Claims {
        sub: 1,
        username: "admin".to_string(),
        role: "admin".to_string(),
        exp: 9999999999,
    })
}
```

从结构上看，它和前面的固定 token 示例没有本质区别，区别只在于：

- 前面是把 token 和用户手工映射
- 这里是通过 JWT 解析 claims

也就是说，JWT 方案和 axum 的 Middleware + Extractor 设计是天然兼容的。

---

## 十一、为什么说“中间件做认证，handler 做授权”通常更清晰？

这可能是整篇文章里最值得记住的一句话。

原因在于，认证和授权的职责天然不同。

### 11.1 中间件适合做认证

因为认证往往是通用前置逻辑：

- 有没有 token
- token 合不合法
- 登录态是否有效
- 用户身份能不能被确认

这些逻辑通常在进入业务 handler 之前就应该统一完成。

### 11.2 handler 更适合做授权

因为授权往往依赖具体业务上下文：

- 当前用户能不能修改这篇文章
- 当前用户是不是管理员
- 当前用户是不是资源所有者
- 当前租户是否匹配

这些判断通常离不开：

- 路径参数
- 数据库查询结果
- 当前资源状态

而这些信息恰恰更适合在 handler 或 service 层里决定。

所以更清楚的分工通常是：

- 中间件负责把“用户是谁”先确认下来
- handler 或 service 负责判断“这个用户能不能干这件事”

这就是为什么很多项目里，不建议把所有权限逻辑都塞进中间件。

---

## 十二、一个授权判断的实际例子

假设有一个接口：

- `PATCH /articles/{id}`

业务规则是：

- 管理员可以修改任何文章
- 普通用户只能修改自己的文章

这种场景就非常适合在 handler 或 service 层做授权判断。

```rust
use axum::{extract::Path, http::StatusCode};

#[derive(Debug, Clone)]
struct CurrentUser {
    user_id: u64,
    username: String,
    role: String,
}

struct Article {
    id: u64,
    author_id: u64,
}

async fn update_article(
    user: CurrentUser,
    Path(article_id): Path<u64>,
) -> Result<String, (StatusCode, String)> {
    let article = find_article(article_id).await;

    if user.role != "admin" && user.user_id != article.author_id {
        return Err((StatusCode::FORBIDDEN, "forbidden".to_string()));
    }

    Ok(format!("article {} updated", article.id))
}

async fn find_article(article_id: u64) -> Article {
    Article {
        id: article_id,
        author_id: 2,
    }
}
```

这里的判断为什么适合放在 handler 或 service，而不是中间件？

因为它依赖当前资源本身：

- 文章作者是谁
- 当前用户是不是资源所有者

这已经不是纯认证逻辑了，而是典型授权逻辑。

---

## 十三、真实项目里认证与授权通常怎么分层？

一个比较清晰、也比较常见的设计可以是这样：

### 13.1 Middleware 层

负责：

- 提取 `Authorization`
- 校验 token / JWT
- 解析当前用户身份
- 把用户上下文写入 request extensions

### 13.2 Extractor 层

负责：

- 从 request extensions 取出 `CurrentUser`
- 给 handler 提供语义明确的参数输入

### 13.3 Handler / Service 层

负责：

- 根据当前用户和业务资源做授权判断
- 返回业务结果或业务错误

这套分层的好处是：

- 横切认证逻辑可复用
- handler 参数干净
- 权限规则更贴近业务语义
- 后续改 token 方案时，不会牵扯所有 handler

---

## 十四、认证与授权里最常见的几个坑

### 14.1 在每个 handler 里手动解析 `Authorization`

这是最常见、也最该尽早摆脱的写法。

短期快，长期几乎必乱。

### 14.2 把所有权限判断都塞进中间件

认证适合中间件，授权未必。

如果某个判断依赖：

- 当前资源
- 数据库查询
- 业务状态

那它通常更适合留在 handler 或 service 层。

### 14.3 只判断“是否登录”，不区分角色和资源归属

很多系统刚开始只做了 401 控制，但真正的权限问题往往发生在已经登录之后。

也就是说：

- 认证解决“是不是你”
- 授权解决“是不是轮到你”

两者都要有。

### 14.4 把用户上下文放进全局 `AppState`

这是不合适的。

当前用户属于请求级上下文，不属于应用级共享状态。

它应该存在于：

- request extensions
- 自定义 Extractor

而不是全局状态。

### 14.5 JWT 校验通过就等于权限通过

这也是一个很常见的误区。

JWT 只说明：

- token 合法
- 身份可信

但并不自动说明：

- 当前用户可以修改这篇文章
- 当前用户可以操作这个租户的数据
- 当前用户可以调用管理员接口

所以 JWT 通过只是认证成功，不是授权完成。

---

## 十五、总结

axum 的认证与授权之所以适合写得比较清楚，不是因为它内置了某套“权限框架”，而是因为它本身的抽象层次已经很适合拆分职责：

- Middleware 处理横切前置逻辑
- Extractor 提供语义明确的输入参数
- Handler / Service 处理业务权限判断

如果把这篇文章压缩成最关键的几个结论，大概就是这些：

1. 认证和授权不是一回事，认证是确认身份，授权是判断权限
2. 基于 Header 的 Token 校验是最简单的认证起点
3. 中间件非常适合做认证前置拦截
4. 认证后的用户上下文应该通过 request extensions 传递
5. 自定义 Extractor 可以把 `CurrentUser` 变成清晰的 handler 参数
6. JWT 不会改变整体结构，它只是更真实的 token 载体
7. 中间件做认证，handler 或 service 做授权，通常是更稳妥的职责划分

如果你已经把前面的中间件、提取器、状态管理、错误处理都串起来，那么这一篇其实把 axum Web 服务里非常关键的一条业务主线也补上了：

- 中间件负责拦截与上下文注入
- Extractor 负责把上下文变成参数
- Handler / Service 负责基于上下文执行业务规则

再往后继续写，一个非常自然的方向就是 axum 与 tower 的关系。因为当你已经理解中间件、提取器、状态、错误、认证这些能力之后，再回头看底层的 `Layer` 和 `Service`，很多之前看起来抽象的设计就会变得非常具体。