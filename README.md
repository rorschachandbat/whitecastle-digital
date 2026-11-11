# 姬路城 White Castle Digital

基于 **boardgame.io** 逐步实现的《姬路城》网页版与局面分析工具。

本项目先建立可核验的规则模型和网页客户端，再逐步加入复盘、候选行动评估与 AI 搜索。AI 训练必须建立在规则正确、行动可复现的基础上。

## 当前状态

已建立规则基准、框架研究文档和原生 JavaScript 规则工作台。工作台接入真实的 boardgame.io Client，可以查看开发文档、检查骨架状态并导出 JSON。

**当前不能进行完整对局。** 游戏动作、完整卡牌/面板数据、复盘导入、AI 和联机服务器尚未实现。导出的骨架状态不是对局存档。

本项目独立实现规则。此前审查的 C# 项目仅用于架构研究，没有将其代码或数据复制到本仓库；来源和审查限制见 [资料与复用边界](docs/sources.md)。

## 文档入口

- [规则基准](docs/RULES.md)：规则需求的统一依据，记录来源、规则编号和待确认项。
- [boardgame.io 接入说明](docs/boardgameio-guide.md)：框架使用方式和项目架构。
- [开发与版本管理约定](docs/development-workflow.md)：提交、变更记录和验证要求。
- [实现计划](docs/implementation-plan.md)：规则引擎、网页、复盘与 AI 的分阶段验收。
- [资料与复用边界](docs/sources.md)：参考版本、规则偏差和素材使用范围。
- [部署与依赖风险](docs/deployment.md)：GitHub Pages 与联机服务器的区别。
- [项目 CHANGELOG](CHANGELOG.md)：按批次记录功能、规则修正、验证结果和已知限制。

## 本地使用

环境：Node.js 22.12 或以上，npm；固定 `boardgame.io@0.50.2`、`vite@8.3.8`，使用 `package-lock.json`。

```shell
npm ci
npm test
npm run check
```

`test` 使用原生 `node --test`，`check` 只检查文件结构、导入及文案键；两者均不构建项目。

下面是**供用户自行执行**的启动和构建步骤，本次交付未执行：

```shell
npm run dev
# 打开命令输出的本地地址
npm run build
npm run preview
```

推荐检查：页面阶段提示、五个文档入口、框架初始化状态、JSON 下载、窄屏布局和键盘操作。浏览器与生产构建仍待验证。没有配置推送后自动构建，也没有发布在线站点。

## 目录

```text
docs/                 规则、研究与验收计划，维护模块 CHANGELOG
src/game/             规则模型入口（当前仅骨架），维护模块 CHANGELOG
src/ui/               StringTable 与样式，维护模块 CHANGELOG
src/main.js           原生 JavaScript 工作台
tests/                不经编译的 Node 框架集成测试
scripts/              可迁移的项目检查脚本及 CHANGELOG
```

## 开发约定

- 新增或修改代码注释时使用中文。
- 展示给玩家的文案集中放在 StringTable 中，通过键引用。
- 每批相关改动完成后同步更新 CHANGELOG，提交并推送到本项目 GitHub 仓库。
- 主要模块在自身目录维护 `CHANGELOG.md`，记录该模块的行为变化和验证重点。
- 未经用户在当前请求中明确要求，不运行编译或构建；改动后给出推荐验证步骤和实际已完成的检查。
- 工具脚本使用相对路径和可配置参数，不绑定某个分支或本机绝对路径。

## 版本管理

远程仓库：`rorschachandbat/whitecastle-digital`。

第三方参考项目、下载缓存、账号信息和原始对局中的个人资料不应未经筛选直接提交。参考资料的来源、使用范围和授权状态在文档中记录。
