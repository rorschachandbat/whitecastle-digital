# 姬路城 White Castle Digital

基于 **boardgame.io** 逐步实现的《姬路城》网页版与局面分析工具。

本项目先建立可核验的规则模型和网页客户端，再逐步加入复盘、候选行动评估与 AI 搜索。AI 训练必须建立在规则正确、行动可复现的基础上。

## 当前状态

已提供**同机两人轮流操作的三轮练习版**，使用真实 boardgame.io Client。支持起始选牌、取放骰、灯笼、个人面板、园丁、武士、家臣谒见及晋升换牌、三层恩赏、影响力、轮末花园与终局计分。行动向导逐步收集选择，提供预览、撤销、浏览器保存及JSON存档重放。

规则核心独立于网页、框架和未来训练器。目录含55张两人实体卡及金银各8块训练板块；起始行动三种各2张。训练场按金色一级池、银色二级池分别无放回抽2块，已撤销此前正反配对推断。

当前是**本地练习配置**：城堡骰色板块与水井资源板块尚未复现完整正式抽样；跨季拒付的部分移动、轮末连锁新园丁资格使用显式练习约定。尚无联网多人、Yucata复盘或AI搜索。启动与具体限制见 [本地试玩](docs/local-play.md)，API见 [规则核心](docs/engine-core.md)。

本项目独立实现规则。此前审查的 C# 项目仅用于架构研究，没有将其代码或数据复制到本仓库；来源和审查限制见 [资料与复用边界](docs/sources.md)。

## 文档入口

- [规则基准](docs/RULES.md)：规则需求的统一依据，记录来源、规则编号和待确认项。
- [boardgame.io 接入说明](docs/boardgameio-guide.md)：框架使用方式和项目架构。
- [开发与版本管理约定](docs/development-workflow.md)：提交、变更记录和验证要求。
- [实现计划](docs/implementation-plan.md)：规则引擎、网页、复盘与 AI 的分阶段验收。
- [资料与复用边界](docs/sources.md)：参考版本、规则偏差和素材使用范围。
- [两人数据核验](docs/data-audit.md)：花园、训练场和个人面板的逐项差异与证据。
- [规则核心与配置验收](docs/engine-core.md)：本批 API、数据隔离、已支持范围和验收步骤。
- [本地两人试玩](docs/local-play.md)：启动、操作、配置导入、存档及练习限制。
- [AI 训练实验](docs/ai-training.md)：攻略先验、深度学习、自我对弈、独立评估及恢复训练。
- [持续训练与局面教练](docs/ai-coach.md)：持续自我对弈脚本、冠军晋级、新版编码、本地存档分析和网页适配路线。
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

启动本地双人练习：

```shell
npm run play
# 打开 http://127.0.0.1:4176/play.html
# 自定义端口：npm run play -- 4177
```

该命令运行本机HTTP服务及boardgame.io Client，不编译、不构建。选骰后点击棋盘上的合法放置按钮，在右侧完成选择并确认；两名玩家共用页面。页面会自动保存完整动作，导出的JSON可用于复现问题。新开局可加载配置编辑器导出的目录。

配置编辑器可不经 Vite 或编译直接启动：

```shell
npm run config
# 打开 http://127.0.0.1:4174/config-editor.html
# 自定义端口：npm run config -- 4175
```

该命令只提供绑定回环地址的静态 HTTP 服务。编辑后先“校验并应用”，再保存浏览器草稿或导出 JSON；只有将导出文件替换仓库中的 `data/whitecastle-2p.json`，才会进入版本管理。已有局面绑定原配置，不能悄悄切换新数据。

下面是**供用户自行执行**的工作台启动和构建步骤，本次交付未执行：

```shell
npm run dev
# 打开命令输出的本地地址
npm run build
npm run preview
```

生产构建仍待用户自行验证。没有配置推送后自动构建，也没有发布在线站点；本地试玩不依赖构建输出。

配置编辑器入口为 `config-editor.html`。它可编辑个人面板、55张卡牌、金银训练板块和训练区的结构化费用与效果，并校验、导出JSON。训练池成员也可预览与编辑，跨色、重复或遗漏会被拒绝。布局等完整配置可通过JSON编辑；额外两个归属不明训练面保持禁用。

## 目录

```text
docs/                 规则、研究与验收计划，维护模块 CHANGELOG
src/game/             boardgame.io本地Client与游戏入口，维护模块 CHANGELOG
src/engine/           纯规则、对局流程与动作向导，维护模块 CHANGELOG
src/data/             配置结构校验与指纹，维护模块 CHANGELOG
data/                 两人版结构化数据，不包含第三方牌面图片
src/ui/               StringTable 与样式，维护模块 CHANGELOG
src/main.js           原生 JavaScript 工作台
config-editor.html    独立配置编辑器入口
play.html             本地两人练习棋盘
tests/                不经编译的 Node 框架、目录与引擎测试
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
