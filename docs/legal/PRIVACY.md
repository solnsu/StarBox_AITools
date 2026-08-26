# StarBox 隐私说明 / Privacy Notice

生效日期 / Effective date: 2026-08-26

## 中文

StarBox 是一款主要在用户设备本地运行的桌面应用。本说明描述当前版本处理数据的实际方式。

### 本地保存的数据

StarBox 可能在本机保存认证信息、访问令牌、刷新令牌、ID Token、DeepSeek API Key、账号元数据、额度检查结果、本地 API 设置和密钥、模型价格缓存、请求日志、创作会话、文字消息及输入或生成图片。

原始认证 JSON、DeepSeek API Key 和本地 API 密钥使用 AES-256-GCM 加密后保存，加密主密钥保存在同一用户数据目录的 `master.key` 文件中。账号元数据、额度信息、请求日志和创作记录保存在本地 SQLite 数据库中。

桌面版默认数据目录：

- macOS：`~/Library/Application Support/StarBox/`
- Windows：`%APPDATA%\StarBox\`

开发模式或通过 `npm start` 运行时，默认使用项目下的 `data/` 目录。

### 网络请求

为提供用户主动使用的功能，StarBox 可能连接：

- OpenAI 和 ChatGPT 服务，用于登录、刷新令牌、获取账号额度和模型，以及转发用户发起的模型或图片请求；
- DeepSeek 服务，用于获取余额和模型，以及转发用户主动发起的模型请求；
- GitHub Raw Content，用于获取 StarBox 的模型价格目录；
- Unsplash，用于加载界面展示图片；
- 用户主动打开的 GitHub、Telegram、Linux.do 或其他外部链接。

这些第三方可能按照各自的隐私政策处理 IP 地址、请求头、账号信息及用户提交给相应服务的内容。StarBox 无法控制第三方服务的处理行为。

### StarBox 不进行的处理

当前版本没有由 StarBox 开发者运营的遥测、广告或用户行为分析服务。StarBox 不会仅因安装而主动把本地数据库、完整认证文件或本地请求日志上传到 StarBox 开发者控制的服务器。

用户主动调用 OpenAI、ChatGPT 或 DeepSeek 功能时，完成该请求所需的凭据、请求内容和相关元数据会发送给相应第三方服务。

### 剪贴板、本地文件与删除

StarBox 仅在用户执行复制、粘贴、导入、导出或添加图片等操作时访问相应剪贴板内容或本地文件。生成图片保存在本地用户数据目录中。

用户可以在应用内删除认证账号和部分创作记录。卸载应用默认不会自动删除用户数据目录。若要完全删除本地数据，应先退出应用，再手动删除上述 StarBox 用户数据目录。删除 `master.key` 后，数据库内已有的加密凭据将无法恢复解密。

### 数据安全

StarBox 的本地 HTTP 服务固定监听 `127.0.0.1`，不会主动监听局域网地址。用户仍应保护操作系统账户、设备磁盘、用户数据目录、本地 API 密钥、ChatGPT 凭据和 DeepSeek API Key。

### 变更与联系

本说明可能随 StarBox 功能变化而更新。最新版本将在项目主页或软件发布材料中提供。

项目主页：https://github.com/solnsu/StarBox_AITools
联系邮箱：soln0708@163.com

## English

StarBox is a desktop application that primarily runs locally on the user’s device. This Notice describes how the current version handles data.

### Data stored locally

StarBox may locally store authentication information, access tokens, refresh tokens, ID tokens, DeepSeek API keys, account metadata, quota inspection results, local API settings and keys, model-pricing cache data, request logs, creation sessions, text messages, and input or generated images.

Raw authentication JSON, DeepSeek API keys, and local API keys are encrypted with AES-256-GCM. The encryption key is stored in `master.key` in the same user data directory. Account metadata, quota information, request logs, and creation records are stored in a local SQLite database.

Default desktop data locations:

- macOS: `~/Library/Application Support/StarBox/`
- Windows: `%APPDATA%\StarBox\`

Development mode and `npm start` use the project’s `data/` directory by default.

### Network requests

To provide features initiated by the user, StarBox may connect to OpenAI, ChatGPT, and DeepSeek services, GitHub Raw Content, Unsplash, and external links such as GitHub, Telegram, or Linux.do. These third parties may process IP addresses, request headers, account information, and content submitted to their services under their own privacy policies.

### Processing StarBox does not perform

The current version contains no developer-operated telemetry, advertising, or user-behavior analytics service. StarBox does not upload the local database, complete authentication files, or local request logs to a server controlled by the StarBox developer merely because the application is installed.

When the user invokes an OpenAI, ChatGPT, or DeepSeek feature, the credentials, request content, and related metadata required to complete that request are sent to the applicable third-party service.

### Clipboard, local files, and deletion

StarBox accesses clipboard content or local files only when the user performs an action such as copy, paste, import, export, or adding an image. Generated images are stored in the local user data directory.

Users can delete authentication accounts and certain creation records in the application. Uninstalling StarBox does not delete its user data directory by default. To remove all local data, exit the application and manually delete the applicable StarBox user data directory. Deleting `master.key` makes previously encrypted credentials unrecoverable.

### Data security

StarBox’s local HTTP service listens on `127.0.0.1` and does not intentionally listen on a local-network address. Users remain responsible for protecting their operating-system account, device storage, user data directory, local API key, ChatGPT credentials, and DeepSeek API keys.

### Changes and contact

This Notice may be updated as StarBox changes. The latest version will be made available through the project website or Software release materials.

Project website: https://github.com/solnsu/StarBox_AITools
Email: soln0708@163.com
