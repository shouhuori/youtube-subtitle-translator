# YouTube Subtitle Translator, Transcript & Summary

专注 YouTube 字幕翻译、视频转写与总结的 Chrome 扩展。它是 LingRead 的独立客户端，与 LingRead 共用用户、登录、点数、视频库、网站和管理后台。

## 功能与范围

- 在 YouTube 播放器中使用双语字幕或中文字幕，读取已有翻译并跟踪后台翻译任务。
- 把视频字幕整理为可阅读的文章，查看导读与要点总结。
- 使用 LingRead 登录页同步账号。网站已登录时会自动同步，无需另建账号。
- 保留现有字幕任务流程：插件读取字幕并保存任务，网站确认点数后开始翻译。
- 首版沿用中文目标语言；转写依赖视频可读取的字幕轨，不包含无字幕视频的语音识别。
- 仅支持 Chrome MV3；支持标准 YouTube watch 页面及嵌入播放器。移动网页支持取决于其播放器 DOM，未承诺 Shorts 支持。

## 安装与开发

需要 Node.js 20.19+（建议 22 或 24）和 Chrome 120+。

```sh
npm ci
npm test
npm run check
npm run build:dev
```

打开 `chrome://extensions`，开启开发者模式，加载已解压的扩展，选择本项目 `dist/development`（也可直接加载 `extension`）。开发配置连接 LingRead 的 `http://localhost:3100` 网站和 `http://localhost:4100` API，服务仍由 LingRead 仓库的 `./dev.sh` 启动。

连接线上 LingRead：

```sh
npm run build
```

加载 `dist/production`。可分发的 ZIP 位于 `dist/youtube-subtitle-translator-0.1.0-production.zip`。生产包连接 `https://lingread.app`，不会修改源配置或 LingRead 的下载文件。

安装后刷新现有 YouTube 标签页。点击播放器中的“字幕翻译”、视频操作区的“视频转写与总结”，或浏览器工具栏弹窗中的相应按钮。转写、总结、任务确认与视频库使用 LingRead 现有网站。

快捷键：`Alt+Shift+Y` 打开字幕面板，`Alt+Shift+B` 切换字幕模式；与旧客户端快捷键隔离。

## 浏览器验证

```sh
npm exec playwright-core install chromium --no-shell
npm run build
npm run test:browser
```

使用临时 Chrome for Testing 配置加载真实扩展，验证弹窗、登录状态、非视频页提示，以及网站登录事件到扩展的完整桥接。登录页使用受控模拟响应，不使用真实账号或消耗点数；不会连接个人 Chrome 配置。脚本生成 `docs/popup-preview.png`。

![插件弹窗](docs/popup-preview.png)

## 共享登录的含义

账号、计费与服务端数据完全相同。Chrome 会隔离两个扩展的本地存储，因此首次使用新扩展需要点击“登录”同步一次。新扩展建立自己的 relay 会话，不会复用另一扩展的登录标签页。退出此扩展只清除此扩展的本地登录，不会退出 LingRead 网站或另一个客户端。

登录桥接只在 LingRead 登录页运行。后台检查回调来源、顶层 frame、待登录 tab 和 relay ID；MV3 worker 重启后通过持久化状态和 alarm 恢复轮询。

## 拆分与兼容

代码来自 LingRead `2524101` 的 `browser-extension/content-youtube*.js`。迁移保留字幕行为及对应测试，替换品牌与 DOM/事件命名空间，新的后台仅处理视频 API、登录和导航。

现有 LingRead 网站、后端、接口、数据库与管理后台均不需要修改。此阶段先保留旧客户端入口，便于验证和迁移；测试时建议在 YouTube 停用旧 LingRead 扩展，避免两套按钮或字幕同时显示。旧客户端的登录桥接尚不区分 client 标记，并存登录仍需真实验证。后续可以单独发布移除旧入口的 LingRead 客户端版本，服务端仍保留旧版接口。

## 文件结构

- `extension/`：完整扩展运行时，不依赖兄弟仓库路径或构建时读取 LingRead。
- `extension/lib/`：账号同步、API 代理、导航与播放器脚本注入。
- `extension/icons/logo.svg`：红色播放与字幕图标源；`npm run icons` 重新生成 PNG。
- `tests/`：API、登录、字幕时序、字幕模式与字体回归测试。
- `scripts/`：资源检查、图标生成、独立打包。
- `docs/`：拆分设计、实施计划、验证记录。

图标采用红色播放与字幕元素。产品由 LingRead 提供，与 YouTube/Google 无官方关联。
