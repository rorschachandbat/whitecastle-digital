# 部署边界与依赖风险

## 当前交付

本仓库只有开发工作台，没有发布在线站点，也没有运行游戏服务器。未执行 Vite 启动、编译、生产构建或浏览器验收。

本次没有添加普通 `push` / `pull_request` 后自动构建的 GitHub Actions。需要部署时，先由用户明确要求构建，再配置手动触发流程。

## GitHub Pages 与 boardgame.io 的区别

- **boardgame.io** 是回合制游戏框架，处理状态、动作、回合、玩家视角和多人同步。
- **GitHub Pages** 是静态站点托管，适合发布构建后的前端文件，不能运行 boardgame.io 的 Node/SocketIO 服务器。

工作台及未来的本地双人、浏览器内分析工具可以部署为静态页面。真正的多人联机需要单独部署服务器，前端再连接该服务器；当前尚未实现。

`vite.config.js` 使用相对 `base: './'`，避免绑定某个仓库名或分支。若未来增加客户端路由，还需单独处理 Pages 的深层路径与刷新。

## 依赖审计

2026-11-11 执行了 `npm audit --omit=dev --json`，报告 **10 个依赖项存在告警：2 low、3 moderate、5 high，0 critical**。命令退出码为 1，不能写成“安全检查通过”。

主要涉及 boardgame.io 传递依赖中的 `@koa/cors`、`koa-socket-2`、Socket.IO/Engine.IO、`ws`、`cookie`，以及框架附带的 Svelte/React 相关依赖。工作台目前只导入 `boardgame.io/client`，未启动上述联机服务器，也未使用 Svelte/React 界面；这不代表已经完成浏览器包影响分析或消除了风险。

处理约定：

1. 不执行 `npm audit fix --force`。审计工具建议的旧版 boardgame.io 不能当作已验证的兼容修复。
2. 在联机部署前，逐项确认可达性、升级/替换方案和 API 兼容性，补服务器安全回归与访问控制。
3. 在静态站点发布前，检查实际构建依赖、浏览器入口和告警影响；本轮未做构建，不能声称生产包已验证。
4. 重新安装或更新依赖后重跑审计，更新本记录与 CHANGELOG；保留锁文件以复现本次版本。

本次只记录风险，没有擅自更换用户选定的框架，也没有对外开放服务。

## 推荐由用户执行的验证

在仓库根目录：

```shell
npm ci
npm test
npm run check
npm run dev
npm run build
npm run preview
```

检查框架就绪提示、文档切换、状态下载、键盘操作、窄屏布局和浏览器控制台。构建成功后再考虑将 `dist/` 部署到 Pages；完整桌游和联机能力不属于当前验收范围。
