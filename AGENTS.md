# 项目约定

这是 LingRead 的 YouTube 专用 Chrome 客户端。名称固定为 YouTube Subtitle Translator, Transcript & Summary。

- 账号、登录、API、点数、视频库和管理后台均复用 LingRead；不要创建第二套用户或服务端。
- 源码在 extension/，源码默认为本地开发，npm run build 生成线上包。
- 只迁移 YouTube 客户端能力，不加入通用网页解析、PDF 或悬浮球。
- 不破坏 LingRead 已发布 API。服务端变动必须回到 LingRead 仓库并检查旧客户端兼容性。
- 页面 DOM 与字幕事件使用 yst 命名空间；网站登录事件保持既有协议。
- 不添加 emoji，文案平实，图标使用红色主题。
- 修改后运行 npm test、npm run check、npm run build。
- 完成后使用 Conventional Commits 提交。main/master 只 commit，不自动 push。
- 非 main/master 完成后，在存在远程仓库时 push 并创建 PR；不能静默新建远程仓库。
