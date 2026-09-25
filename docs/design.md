# YouTube 客户端拆分设计

2026-09-25

## 范围

在 ~/dev/youtube-subtitle-translator 建立独立 Chrome MV3 扩展，名称为 YouTube Subtitle Translator, Transcript & Summary。共用 LingRead 网站、用户、登录、余额、视频库、后端和管理后台；不建立新服务，不迁移数据库，不修改已发布接口。

迁移 LingRead 的三个 YouTube 脚本：页面桥接、播放器工具、字幕渲染。转写和总结继续打开 LingRead 网站现有页面，保留后台字幕任务的现有交互。只处理可读取字幕的视频，不新增音频语音识别。首版沿用中文目标语言。

## 客户端边界

- extension/：可以直接加载的扩展。仅在 YouTube 和 LingRead 登录页注入，无通用文章解析、PDF、悬浮球、右键菜单。
- extension/lib/api.js：仅代理 /api/youtube/ 的 GET/POST，携带当前扩展的 LingRead token。保留本地工作台 API 路由策略，跨 API 源不传线上 token。
- extension/lib/auth.js：本客户端专属 relay ID 和 tab，复用现有登录页。网站已登录时自动同步；不同扩展不共用 chrome.storage。只接受受信任网站、顶层、匹配待登录 relay 与 tab 的回调；轮询和 alarm 恢复使用同一会话。
- extension/content-auth.js：document_start 注册登录完成事件，沿用网站既有事件协议。
- extension/popup.*：账号状态、登录、打开字幕工具、转写与总结、视频库。
- extension/icons/：红色播放与字幕图形，SVG 源及 16/32/48/128 PNG。
- scripts/：图标生成、语法与资源检查、开发及生产打包。生产包固定线上地址；源码默认本地开发。

DOM ID、自定义字幕事件和 MAIN world 桥接命名空间改为 yst，避免与旧客户端共享状态。服务器路径、参数、响应语义和网站登录事件不变。

## 兼容与迁移

先建立可运行的新客户端。旧 LingRead 入口是否本次下线由用户选择；没有指示时保留以便验证和迁移。已发布旧扩展始终可以调用原后端。两个客户端同时安装时均可能显示各自入口，测试时应关闭旧客户端在 YouTube 的注入。

## 验证

迁移原字幕回归测试；新增 API 代理、会话隔离与恢复测试；检查 manifest 所有资源、模块语法、PNG 尺寸、生产包资源与地址；在可用浏览器中检查弹窗。真实 YouTube 与登录链路如未实测，必须明确说明。
