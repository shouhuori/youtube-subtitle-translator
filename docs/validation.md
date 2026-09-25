# 验证记录

2026-09-25，macOS arm64，Node.js 24.14.0。

## 已通过

- `npm test -- --reporter=dot`：9 个测试文件、62 项测试全部通过。
- `npm run check`：14 个 manifest/弹窗资源、运行时 JavaScript 语法、模块引用和四种 PNG 尺寸检查通过。
- `npm run build` / `npm run build:dev`：独立 ZIP 和解压目录生成；构建测试实际读取 ZIP，确认完整运行时文件、生产/开发环境地址，以及源配置没有被改写。
- `npm run test:browser`：Chrome for Testing 153.0.8010.12 的独立临时配置实际加载生产扩展；service worker 启动；弹窗未登录/已登录/退出状态、非 YouTube 页面提示、document_start 登录桥接及 pending relay 清理通过，页面无 JavaScript 异常。
- 登录桥接浏览器测试在 LingRead URL 上使用受控模拟 HTML 响应和虚构用户，不调用真实登录、不消耗点数。
- 在 LingRead/website 运行 `node --test tests/youtube-transcript-flow.test.mjs`：5 项测试通过。新客户端继续使用这些原有转写与导读/要点页面。
- 独立只读代码审查发现快捷键迁移时 Alt guard 冲突，已以失败测试复现后修复，改用 KeyboardEvent.code 兼容 macOS Option 字符。
- 已检查红色图标与真实扩展弹窗截图（popup-preview.png）。

## 实际 YouTube 页面验证的限制

在全新自动化 Chrome 配置访问公开视频 watch 页面，DOM 中已出现本插件播放器按钮（yst-yt-button）。首次可见性检查超时；复查显示播放器仍处于 unstarted-mode / ytp-hide-controls，未进入可交互播放状态。只确认脚本注入，不将此次检查视为真实视频完整流程通过。

因此真实账号登录、真实视频的完整字幕读取/播放、字幕付费任务和转写生成尚需在正常浏览器验收。未发送付费生成请求。

## 迁移边界

- LingRead 原仓库保持干净，未修改原扩展、网站、服务端或数据库。
- 本阶段保留旧扩展的 YouTube 入口。测试新客户端时暂时停用旧扩展，避免重复按钮和字幕。
- 旧扩展登录桥接不区分 client 标记，同时启用两端的登录行为仍需后续验证；新扩展自己只接收匹配其 tab/relay 的回调，也不复用旧扩展登录页。
- 本项目只做客户端；共用现有账号、计费、视频数据和管理后台。
