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

用户已确认移除旧入口。LingRead 1.9.19 删除 YouTube 脚本、manifest 注入和后台补注入，通用脚本排除 YouTube 页面，并忽略其他客户端的登录中继。两个客户端可同时启用；升级后刷新已有 YouTube 页面清除残留脚本。更早的 LingRead 应先停用。服务端继续保留已发布旧扩展使用的接口。

## 验证

迁移原字幕回归测试；新增 API 代理、会话隔离与恢复测试；检查 manifest 所有资源、模块语法、PNG 尺寸、生产包资源与地址；在可用浏览器中检查弹窗。真实 YouTube 与登录链路如未实测，必须明确说明。
