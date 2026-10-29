---
title: Rust axum Multipart 实现文件上传：流式处理、内容哈希分片与工程实践
date: 2026-04-23 08:24:47
tags: Rust
---

## 引言

前面几篇 axum 文章，我们已经把一条 Web 请求链路里最核心的部分基本串起来了：

- 中间件怎么介入请求处理
- Extractor 怎么把请求数据提取为 handler 参数
- `State<T>` 怎么承载共享依赖
- 错误如何统一转换成 HTTP 响应
- 一个请求在 axum 里到底按什么顺序执行

但只要开始做真正的 Web 服务，就很快会遇到一个很现实的话题：

> 文件上传到底应该怎么做，才能既能跑，又不把服务写得很脆弱？

很多人第一次接触上传接口，容易先写出一个“能跑的版本”：

- 前端把文件通过 `multipart/form-data` 传上来
- 后端提取 `Multipart`
- 把文件读进内存
- 直接写到某个目录

这个起点没有问题，但它通常也会很快暴露几个严重问题：

- 大文件一上传，内存占用迅速变高
- 文件名直接拿来落盘，存在安全风险
- 同一个文件被重复上传很多次，磁盘重复存储
- 文件太多都堆在一个目录里，目录性能越来越差
- 上传成功之后，文件路径和元数据组织得很混乱

这些问题说明，文件上传不是“把字节保存一下”这么简单。

在工程上，一个更合理的上传设计通常至少要回答下面几个问题：

1. `multipart/form-data` 在 HTTP 层到底是什么
2. 为什么上传接口不能默认把整个文件一次性读进内存
3. axum 里的 `Multipart` 应该怎样和状态、错误处理配合
4. 文件应该如何安全落盘
5. 为什么适合用文件内容哈希作为存储键
6. 如何基于哈希构建目录树，避免单目录下文件过多
7. 上传接口在安全性和可维护性上有哪些坑

这篇文章就围绕这些问题展开。

目标不是只给你一个 demo，而是给出一个在真实项目里也能继续演进的实现思路。

---

## 一、先回答根问题：什么是 `multipart/form-data`？

我们平时发 JSON 请求时，一个请求体通常就是一整段 JSON 文本；但文件上传场景往往不止一份数据。

例如一个上传接口，除了文件本身，可能还要同时传：

- 文件所属业务类型
- 上传者 ID
- 文件描述
- 是否公开

这时候如果还强行用普通 JSON，就会很不自然。因为二进制文件并不适合直接塞进 JSON。

所以浏览器和后端之间，文件上传最常见的协议形态就是：

> `multipart/form-data`。

它可以把一个请求体拆成多个 part，每个 part 都有自己的 header 和内容。

一个典型请求大致可以理解成：

```text
POST /upload
Content-Type: multipart/form-data; boundary=----abcd

------abcd
Content-Disposition: form-data; name="biz"

avatar
------abcd
Content-Disposition: form-data; name="file"; filename="cat.png"
Content-Type: image/png

...binary bytes...
------abcd--
```

也就是说，multipart 的本质不是“一个文件”，而是：

> 一个请求体里包含多个字段，其中某些字段是普通文本，某些字段是二进制文件。

这件事放回前面 Extractor 那篇去看，会非常自然：

- `Json<T>` 是把整个 body 当成一份 JSON 来解析
- `Multipart` 是把整个 body 解析成多个 part，再逐个读取

因此这两者都属于“消费请求体”的提取器，它们不能同时随意混用。

---

## 二、axum 里的 `Multipart` 到底处于哪一层？

如果你已经看过前一篇“请求生命周期”，这里结论会很清楚。

一次上传请求大致会经历：

```text
客户端上传请求
  -> 外层中间件
  -> Router 路由匹配
  -> 路由中间件
  -> Multipart Extractor 解析 body
  -> handler 逐个读取 field
  -> 写入文件系统 / 对象存储
  -> 返回响应
```

所以 `Multipart` 的角色本质上是一个 body extractor。

这意味着两个直接结论：

1. 它发生在路由匹配之后、handler 真正执行之前
2. 它会消费请求体，因此和其他消费 body 的 extractor 有边界冲突

比如下面这种写法就不成立：

```rust
async fn wrong_handler(
	multipart: Multipart,
	Json(payload): Json<CreateFileRequest>,
) {
	// ...
}
```

原因不是语法，而是语义：

- `Multipart` 要读 body
- `Json<T>` 也要读 body
- body 不能被两个提取器各读一次

如果上传接口还需要业务字段，正确方式通常是：

- 把业务字段也放在 multipart 的普通文本 field 里
- 或者把“先上传文件”和“再提交业务 JSON”拆成两个接口

后者在复杂业务里往往更稳，因为文件上传和业务写库通常是两个不同的可靠性问题。

---

## 三、为什么上传接口不能默认把文件一次性读进内存？

很多 demo 会这样写：

```rust
let data = field.bytes().await?;
tokio::fs::write("./uploads/test.bin", data).await?;
```

对于小文件，这当然能跑。

但它有一个明显问题：

> 你是先把整个文件完整读进内存，再落盘。

如果上传的是：

- 10KB 的头像
- 100KB 的文档

那么问题不大。

但如果是：

- 30MB 的视频片段
- 100MB 的压缩包
- 多个并发上传请求同时进来

那么内存压力就会迅速放大。

所以更稳妥的实现方式通常是：

> 一边从 multipart field 读取字节块，一边写入目标文件，同时顺手计算哈希。

这个思路有三个明显好处：

- 不需要把整个文件一次性放进内存
- 可以在写入过程中统计大小
- 可以同步计算 SHA-256 等内容摘要，作为后续存储键

这就是文件上传里非常重要的“流式处理”思路。

---

## 四、为什么适合用“文件内容哈希”作为存储键？

很多初学者第一反应是直接用原始文件名落盘，例如：

```text
uploads/avatar.png
uploads/report.pdf
```

这样做的问题其实很多：

### 4.1 文件名不可靠

上传方给的文件名只是一个“客户端声明”，它并不可信。

它可能存在：

- 重名覆盖
- 特殊字符问题
- 路径穿越风险
- 扩展名和实际内容不一致

### 4.2 无法天然去重

如果两个用户上传的是完全相同的文件：

- 用随机文件名存储，会保存两份
- 用原始文件名存储，也无法识别内容相同

### 4.3 难以做内容寻址

如果一个文件的身份依赖“它叫什么名字”，那么名字变了，文件身份也跟着变。

但对于存储系统来说，更稳的识别方式往往是：

> 文件是什么内容，而不是文件叫什么名字。

因此很多系统会采用内容哈希，例如 SHA-256：

```text
2cf24dba5fb0a30e26e83b2ac5b9e29e...
```

它带来的直接好处是：

- 相同内容天然得到相同键
- 可以方便做去重
- 路径命名稳定，不依赖客户端文件名
- 后续做缓存、校验、对象存储映射都更自然

这就是典型的内容寻址存储思路。

---

## 五、为什么还要基于哈希构建目录树？

如果你已经决定用哈希作为文件名，下一个常见设计就是：

> 文件应该直接平铺在一个目录里，还是继续分层？

假设我们把所有文件都扔进：

```text
uploads/
```

短期内当然没问题。

但如果文件数量达到几十万甚至更多，单目录下文件过多通常会带来：

- 遍历和管理不方便
- 某些文件系统下目录操作性能下降
- 人工排查非常难看

所以更常见的做法是按哈希前缀做目录分片。

例如一个 SHA-256：

```text
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

可以拆成：

```text
uploads/2c/f2/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
```

也就是：

- 第一层目录取前 2 位
- 第二层目录取接下来 2 位
- 文件名使用完整哈希

这样做的效果是：

- 顶层目录不会过于拥挤
- 单个子目录中文件数更分散
- 路径仍然是可推导的，不需要额外索引才能定位文件

这是很多存储系统都很常见的设计。

如果未来量更大，还可以继续扩展为 3 级甚至更多级目录，但多数 Web 服务里，两级前缀分片已经足够实用。

---

## 六、先给一个最小可用方向：axum 上传接口需要哪些依赖？

如果你要在 axum 中使用 multipart 上传，首先要启用对应 feature。

一个典型依赖如下：

```toml
[dependencies]
axum = { version = "0.8", features = ["multipart"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
hex = "0.4"
uuid = { version = "1", features = ["v4"] }
```

这里每个依赖大致承担的职责是：

- `axum`：Web 路由和 `Multipart` extractor
- `tokio`：异步文件操作
- `sha2`：计算文件内容哈希
- `hex`：把摘要编码成十六进制字符串
- `uuid`：生成临时文件名，避免并发写同一中间文件

注意，这里我没有引入数据库依赖。

因为这一篇先聚焦上传链路本身：

- 提取 multipart
- 流式写盘
- 计算哈希
- 构建目录树
- 返回响应

如果后续要接数据库，把文件元数据持久化到表里即可。

---

## 七、一个更像工程代码的实现

下面给一个单文件示例，重点演示三件事：

1. 通过 `State<AppState>` 注入上传根目录
2. 对 multipart 中的文件字段做流式读取和写盘
3. 用 SHA-256 结果构造目录树并实现简单去重

```rust
use axum::{
	extract::{DefaultBodyLimit, Multipart, State},
	http::StatusCode,
	response::{IntoResponse, Response},
	routing::post,
	Json, Router,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, sync::Arc};
use tokio::{
	fs,
	io::AsyncWriteExt,
};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
	upload_root: Arc<PathBuf>,
}

#[derive(Serialize)]
struct UploadResponse {
	field_name: String,
	original_file_name: Option<String>,
	sha256: String,
	size: u64,
	relative_path: String,
}

#[derive(Debug)]
enum AppError {
	BadRequest(String),
	Internal(String),
}

impl IntoResponse for AppError {
	fn into_response(self) -> Response {
		match self {
			AppError::BadRequest(message) => {
				(StatusCode::BAD_REQUEST, message).into_response()
			}
			AppError::Internal(message) => {
				(StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
			}
		}
	}
}

#[tokio::main]
async fn main() {
	let upload_root = PathBuf::from("./uploads");

	fs::create_dir_all(&upload_root)
		.await
		.expect("create upload root failed");

	let state = AppState {
		upload_root: Arc::new(upload_root),
	};

	let app = Router::new()
		.route("/upload", post(upload_file))
		.with_state(state)
		.layer(DefaultBodyLimit::max(20 * 1024 * 1024));

	let listener = tokio::net::TcpListener::bind("0.0.0.0:3000")
		.await
		.expect("bind failed");

	axum::serve(listener, app).await.expect("server failed");
}

async fn upload_file(
	State(state): State<AppState>,
	mut multipart: Multipart,
) -> Result<Json<Vec<UploadResponse>>, AppError> {
	let mut uploaded = Vec::new();

	while let Some(field) = multipart
		.next_field()
		.await
		.map_err(|err| AppError::BadRequest(err.to_string()))?
	{
		let Some(field_name) = field.name().map(str::to_string) else {
			continue;
		};

		if field_name != "file" {
			continue;
		}

		let original_file_name = field.file_name().map(str::to_string);

		let saved = save_field_to_storage(&state.upload_root, field_name, original_file_name, field).await?;
		uploaded.push(saved);
	}

	if uploaded.is_empty() {
		return Err(AppError::BadRequest("missing file field".to_string()));
	}

	Ok(Json(uploaded))
}

async fn save_field_to_storage(
	upload_root: &Path,
	field_name: String,
	original_file_name: Option<String>,
	mut field: axum::extract::multipart::Field<'_>,
) -> Result<UploadResponse, AppError> {
	let temp_dir = upload_root.join("_tmp");
	fs::create_dir_all(&temp_dir)
		.await
		.map_err(internal_err)?;

	let temp_path = temp_dir.join(Uuid::new_v4().to_string());
	let mut temp_file = fs::File::create(&temp_path)
		.await
		.map_err(internal_err)?;

	let mut hasher = Sha256::new();
	let mut size = 0_u64;

	while let Some(chunk) = field
		.chunk()
		.await
		.map_err(|err| AppError::BadRequest(err.to_string()))?
	{
		size += chunk.len() as u64;
		hasher.update(&chunk);
		temp_file.write_all(&chunk).await.map_err(internal_err)?;
	}

	temp_file.flush().await.map_err(internal_err)?;

	let sha256 = hex::encode(hasher.finalize());
	let relative_path = hashed_relative_path(&sha256);
	let final_path = upload_root.join(&relative_path);

	if let Some(parent) = final_path.parent() {
		fs::create_dir_all(parent).await.map_err(internal_err)?;
	}

	if fs::try_exists(&final_path).await.map_err(internal_err)? {
		fs::remove_file(&temp_path).await.map_err(internal_err)?;
	} else {
		fs::rename(&temp_path, &final_path).await.map_err(internal_err)?;
	}

	Ok(UploadResponse {
		field_name,
		original_file_name,
		sha256,
		size,
		relative_path: relative_path.to_string_lossy().to_string(),
	})
}

fn hashed_relative_path(sha256: &str) -> PathBuf {
	let first = &sha256[0..2];
	let second = &sha256[2..4];
	PathBuf::from(first).join(second).join(sha256)
}

fn internal_err(err: impl std::fmt::Display) -> AppError {
	AppError::Internal(err.to_string())
}
```

这个版本虽然不算完整文件系统服务，但已经有了比较关键的工程特征：

- 不一次性把整个文件读入内存
- 允许多文件上传
- 基于内容哈希落盘
- 用临时文件 + 原子重命名避免中途失败留下半成品目标文件
- 同内容文件重复上传时直接复用已存在文件

这个示例默认允许零字节文件上传。如果你的业务不接受空文件，可以在 `size == 0` 时主动返回 `400 Bad Request`。

这和“读 bytes 再 write”的 demo 已经不是一个级别的稳定性。

---

## 八、这段代码到底做了什么？

如果只看代码，不一定能立刻抓到设计重点。下面把关键动作拆开说。

### 8.1 `State<AppState>` 负责注入上传根目录

这和前面的状态管理篇是一致的。

上传根目录、对象存储客户端、元数据服务这类“应用启动后长期复用的依赖”，都适合放进 `AppState`。

所以这里写成：

```rust
#[derive(Clone)]
struct AppState {
	upload_root: Arc<PathBuf>,
}
```

这里用 `Arc<PathBuf>`，本质上是为了让状态克隆成本很低。

在更真实的项目里，这个状态可能会扩展成：

```rust
#[derive(Clone)]
struct AppState {
	upload_root: Arc<PathBuf>,
	file_repo: FileRepository,
	audit_service: AuditService,
}
```

这就和前面 `axum + sqlx` 那篇的状态组织方式完全一致了。

### 8.2 `Multipart` 是逐个 field 读取的，不是直接给你一个完整文件列表

```rust
while let Some(field) = multipart.next_field().await? {
	// ...
}
```

这个写法本身就在提醒你：

> multipart 请求本质上是一个字段流，不是一个预先组装好的 Vec<File>。

这意味着你在 handler 里通常要自己判断：

- 当前 field 是普通文本字段还是文件字段
- `name` 是否等于你预期的 `file`
- 是否允许多个同名文件字段

如果接口更复杂，例如还要接收 `biz`、`scene`、`uploader_id`，也可以在这个循环里顺手解析文本字段。

### 8.3 真正的关键不在 `next_field`，而在 `field.chunk()`

```rust
while let Some(chunk) = field.chunk().await? {
	size += chunk.len() as u64;
	hasher.update(&chunk);
	temp_file.write_all(&chunk).await?;
}
```

这是整篇里最核心的一段。

它体现了上传处理最重要的工程原则：

> 边读、边算、边写。

具体来说：

- `field.chunk()`：每次取一块字节
- `size += ...`：顺手统计文件大小
- `hasher.update(...)`：同步累计内容哈希
- `write_all(...)`：立即落到临时文件

这样做的内存占用与 chunk 大小相关，而不是与整个文件大小线性绑定。

### 8.4 为什么先写临时文件，再决定最终路径？

因为最终路径依赖哈希，而哈希只有把完整文件读完后才能确定。

所以整个流程自然变成：

1. 先写到临时文件
2. 同时计算 SHA-256
3. 读完后得到最终哈希
4. 根据哈希构造最终路径
5. 将临时文件重命名到目标位置

这也是内容寻址上传里非常常见的模式。

### 8.5 为什么重复内容上传时可以直接去重？

如果最终路径由完整 SHA-256 唯一决定，那么相同内容一定映射到相同路径。

所以这里的逻辑是：

```rust
if fs::try_exists(&final_path).await? {
	fs::remove_file(&temp_path).await?;
} else {
	fs::rename(&temp_path, &final_path).await?;
}
```

也就是：

- 如果目标已经存在，说明内容已经存过了
- 临时文件直接删掉
- 响应里仍然返回同一个哈希路径

这就是最基础的一层“物理去重”。

---

## 九、如果还想保留扩展名，应该怎么做？

上面的示例里，最终文件名直接就是完整哈希，没有保留扩展名。

这样做的优点是简单、稳定、完全不信任客户端文件名。

但某些场景下你可能仍然希望保留扩展名，例如：

- 方便人工排查
- 某些静态资源服务按扩展名做处理
- 对接已有文件访问链路

这时一个比较克制的方案是：

1. 只把扩展名当成附属信息，不参与内容身份识别
2. 只从原始文件名中提取最后一个扩展名
3. 对扩展名做白名单或长度限制

例如把最终路径变成：

```text
uploads/2c/f2/2cf24dba5fb0a30e...9824.png
```

但这里要特别强调：

> 扩展名只能作为展示或兼容信息，不能作为文件内容类型的安全判断依据。

因为上传方完全可以把可执行文件改名成 `.png`。

所以更稳的做法是：

- 扩展名只做可选展示
- 实际类型判断依赖服务端内容检测或业务白名单

---

## 十、上传接口真正该防的，不是“能不能上传”，而是这些工程问题

文件上传很容易因为 demo 太顺利，而低估了真实环境里的问题。下面这些点，基本都值得在一开始就纳入设计。

### 10.1 请求体大小限制

如果没有限制，恶意或误操作请求可能直接把服务内存、磁盘或带宽打满。

所以通常至少要做两层限制：

- HTTP 层限制请求体大小
- 业务层限制单文件大小、文件数量、字段数量

示例里这行代码就是 HTTP 层限制：

```rust
.layer(DefaultBodyLimit::max(20 * 1024 * 1024))
```

如果业务上只允许头像上传，还应该在 handler 里进一步校验：

- 只能一张
- 不能超过例如 2MB
- 只能是图片类型

### 10.2 不要信任客户端文件名

原始文件名最多只能用于展示。

不要直接用它参与最终落盘路径，更不要把它直接拼成：

```rust
format!("./uploads/{}", file_name)
```

否则容易踩到：

- 路径穿越
- 特殊字符
- Windows 和 Unix 文件名兼容性差异
- 同名覆盖

### 10.3 不要只信任 `Content-Type`

multipart part 里的 `Content-Type` 一样是客户端声明，不能完全当真。

它更适合作为：

- 前端提示信息
- 一层初步过滤

但如果你的业务对文件类型敏感，例如只允许 PDF、图片、音频，那么服务端最好结合内容检测做更严格校验。

### 10.4 失败清理要考虑完整

上传过程中，任何一个步骤都可能失败：

- multipart 解析失败
- 磁盘写入失败
- 创建目录失败
- 重命名失败

所以尽量采用：

- 临时文件目录
- 明确的错误返回
- 失败时清理临时文件

上面示例已经做了“临时写入 + 最终重命名”，但在生产环境里还可以再加：

- 后台定时清理长时间残留的 `_tmp` 文件
- 更细粒度的错误码与日志

### 10.5 元数据和物理文件要分开管理

一个很常见的误区是把“上传成功”理解成“磁盘上有这个文件”。

实际上很多系统里，你还需要记录文件元数据，例如：

- 文件 ID
- SHA-256
- 原始文件名
- 文件大小
- 内容类型
- 上传人
- 业务归属
- 创建时间

这类信息应该进入数据库，而不是只存在文件路径里。

物理文件和元数据分开，是后续做：

- 权限控制
- 引用计数
- 软删除
- 审计日志
- 媒体处理任务

的基础。

---

## 十一、如果接数据库，上传模块应该怎么分层？

结合前面的 `axum + sqlx` 那篇，一个比较顺手的分层方式通常是：

```text
src/
  main.rs
  app_state.rs
  error.rs
  upload/
	mod.rs
	handler.rs
	service.rs
	storage.rs
	repository.rs
	model.rs
```

大致职责可以这样划分：

### 11.1 handler 层

负责：

- 提取 `Multipart`
- 提取认证用户
- 调用上传 service
- 返回 HTTP 响应

### 11.2 service 层

负责：

- 解析业务字段
- 协调文件存储和元数据写库
- 定义事务边界
- 处理“同内容已存在”这类业务逻辑

### 11.3 storage 层

负责：

- 流式写文件
- 计算哈希
- 生成目录树路径
- 对接本地磁盘、S3、OSS、MinIO 等实际存储介质

### 11.4 repository 层

负责：

- 持久化文件元数据
- 查询是否已有相同哈希记录
- 维护引用关系

这样拆分之后，HTTP 层、存储层、数据库层职责就会比较清楚。

也就是说，真正成熟的上传模块，往往不是一个 handler 直接干完所有事，而是：

> handler 只负责接请求，真正的“上传逻辑”应该沉到 service 和 storage 层。

---

## 十二、一个更贴近业务的返回结构应该长什么样？

上面的示例返回了：

- 原始字段名
- 原始文件名
- `sha256`
- `size`
- 相对路径

这已经足够做 demo。

但真实项目里，返回结构通常会更偏向“文件资源对象”，例如：

```json
{
  "id": "file_01JZ...",
  "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e...",
  "size": 182736,
  "content_type": "image/png",
  "original_file_name": "avatar.png",
  "url": "/static/files/2c/f2/2cf24dba5fb0a30e...",
  "created_at": "2026-04-07T10:20:30Z"
}
```

注意这里的 `url` 通常不应该直接等于物理磁盘路径。

更好的方式是：

- 存储层返回相对存储键
- 资源层根据规则映射成可访问 URL

这样未来你把本地磁盘切换到对象存储，外部接口就不会大改。

---

## 十三、常见误区总结

把这一篇收束一下，上传接口最常见的误区通常是下面这些：

### 13.1 把上传理解成“读完 bytes 再写文件”

这在小 demo 里能跑，但一旦文件稍大或并发稍高，就会暴露内存问题。

更稳妥的方向是流式读取。

### 13.2 把客户端文件名当作可信路径

文件名最多是展示信息，不应该作为真正的存储主键。

### 13.3 不做大小限制

没有大小限制的上传接口，本质上就是把资源消耗控制权交给了客户端。

### 13.4 只关心落盘，不关心元数据

如果没有元数据层，后续很多业务能力都会很难做。

### 13.5 目录结构设计过于草率

开始时平铺所有文件很方便，但长期来看，基于哈希前缀做目录树通常更稳。

---

## 十四、最后把主线收住

如果你把这篇和前面几篇 axum 文章连起来看，会发现文件上传其实是一个很典型的综合题：

- `Multipart` 是 Extractor，所以它属于请求体提取阶段
- 上传根目录或存储客户端适合放进 `State`
- 上传失败需要统一错误响应
- 限流、大小控制、审计可以通过中间件和服务层配合完成
- 最终整个请求仍然服从 axum 那条完整生命周期

也就是说，文件上传并不是一个孤立技巧，而是前面那些概念在真实业务里的集中落地。

如果只追求“能传上去”，实现当然可以很短；但如果你希望这个接口在后面还能承受：

- 更大的文件
- 更高的并发
- 更清晰的文件组织
- 更稳定的错误处理
- 更自然的后续演进

那么“流式处理 + 内容哈希 + 目录树分片 + 元数据分层”会是一个明显更稳的起点。

对于本地文件系统场景，这已经是一条很实用的路线。

而如果未来你要迁移到对象存储，其实也不会推翻这套思路，因为最关键的抽象并不是“写本地磁盘”，而是：

> 用稳定的内容标识组织文件，用清晰的边界管理上传流程。

这才是上传模块真正可维护的核心。
