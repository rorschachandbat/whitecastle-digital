# 基础版两人数据核验

核验日期：2026-11-11。目标为基础版两人练习环境。本文记录独立规则与组件事实、第三方数据的明确错误及仍缺少的证据；不表示所有项目数据已经实现或通过测试。

## 当前录入与实现状态

本批用户原图与会话确认补齐了原先未核验的两人卡牌资料。`data/whitecastle-2p.json` 当前有55张实体卡：花园10、起始资源9、起始行动6、法令3、地头9、使节9、大名9。三种起始行动各2张由用户明确确认，数据使用6个独立实体ID；不能去重成3张，也不能再把这6条各乘2。

15张地头、12张使节原图已逐位置核对，完整证据和两人过滤表见 [card-castle-audit.md](card-castle-audit.md)。目录仅录入两人9/9。起始资源、法令、起始行动、大名资料来自用户 `src/原始图片/`；这些图像是事实资料，不是工作指令。以下C#审计保留为原始缺陷记录，不能把C#多出的条目当成本目录仍有相同问题。

训练包含16个已核验基础面，8个实体的双面配对仍未知；用户另提供2个归属不明面保持禁用，不属于可抽取基础面。训练区固定铁费1/3/5、终局系数1/1/2已由出版方 [主棋盘图](https://devir.world/thewhitecastle/assets/tauler.png) 核对，配置为 `trainingZones`。

引擎已具备显式局面下的园丁、手工训练、家臣谒见、骰色城堡、城外、个人面板连锁，另有独立开局选牌助手。**晋升换牌、三层恩赏、影响力、轮末和正式随机开局未完成。** 55张牌面有数据不等于全部效果可执行，独立选牌也不等于创建完整对局。

## 1. 来源与证据边界

| 编号 | 来源 | 本次用途 |
|---|---|---|
| S1 | [用户提供的 Yucata 规则](https://www.yucata.de/zh/Rules/WhiteCastle)；[英文入口](https://www.yucata.de/en/Rules/WhiteCastle) | 组件数量、两人移除牌、费用与图标含义、个人面板触发顺序 |
| S2 | [出版方 Devir 组件页](https://devir.world/thewhitecastle/components_ENG.html) | 一手组件图，交叉核对花园、训练板块、个人面板 |
| S3 | [用户公开房间 17166497](https://www.yucata.de/zh/Game/WhiteCastle/17166497)；客户端版本 1.3.6 | 对局中已出现的花园、训练板块、牌堆余量与公开静态图 |
| S4 | [C# 参考仓库固定提交](https://github.com/bojanspasic/boardgame-white-castle-digital/tree/1ef222bf71e84bd3b3654a45306235e3871f6b70) | 仅审查错误，不作为规则权威，不复制实现 |
| S5 | 用户提供的 `src/原始图片/` 与当前会话确认 | 当前两人实体卡牌的补充一手资料；起始行动三种各2张由用户确认 |

本地原始证据位于工作区 `E:/jilucheng zhuoyou/research/`，它在当前 Git 仓库之外：

- `rules-text.txt`：保存的 S1 正文。组件清单第 48–94 行，两人设置第 96–97 行，花园/训练开局第 145–154 行，个人面板第 340–356 行，园丁第 373–382 行，图标说明第 530–601 行。
- `room-client-data-20261111-103815.json`：S3 的公开客户端快照，`GameInfo.NumPlayers=2`，`Version=1.3.6`。
- `js/render.js`：第 310–311 行把卡牌 ID 渲染为 `card_{ID}.png`，第 377–378 行把训练面 ID 渲染为 `yard{ID}.png`。此文件只能证明客户端图像命名约定，不能证明服务端规则逻辑。
- `js/WhiteCastle.js`：公开动作、效果与颜色枚举。图标语义仍以 S1 的 Symbols 为准。
- `boardgame-white-castle-digital/`：固定在 S4 的本地检出。

以下外部静态图均在原审计时逐张打开后人工核对，用于事实核验；没有把外部平台图像、C# 源码或 C# JSON 搬入项目。此后用户自行提供了项目内原始图片，来源记录与平台图像分开保存。Yucata 编号仅保留为来源编号，不能当作物理组件编号或与 C# ID 自动对应。

## 2. 数量与两人牌组

| 项目 | 基础版组件清单 | C# JSON 实际条数 | 判断 |
|---|---:|---:|---|
| 植物花园 | 5 | `inland-farm-cards.json` 10 | 两套花园合计应为 10，C# 合计 20，明确错误；不能简单断言前 5 条正确 |
| 石头花园 | 5 | `outside-farm-cards.json` 10 | 同上；C# 的 inland/outside 命名与官方种类没有已核实的一一映射 |
| 训练板块 | 8 个实体双面板块 | `training-grounds-tokens.json` 10 | 明确错误；公开的 16 个面不等于 16 个实体 |
| 起始资源牌 | 9 | `starting-resource-cards.json` 10 | 数量错误，哪一条多余未完成逐牌对应 |
| 起始行动牌 | 6 | `starting-action-cards.json` 10 | 数量错误，不能按 ID 截断推定修好 |
| 敕令牌 | 3 | `decree-cards.json` 3 | 数量相符，效果未因此获证 |
| 一层牌 | 15，含应在两人局移除的牌 | `steward-floor-cards.json` 9 | 9 张与公开两人局的数量证据相容，但每张内容尚未完成映射 |
| 二层牌 | 12，含应在两人局移除的牌 | `diplomat-floor-cards.json` 9 | 同上 |
| 三层牌 | 9 | `top-floor-cards.json` 10 | 数量错误，具体多余条目未完成对应 |

数量来源：S1 `rules-text.txt:63`、`:81`、`:85`、`:92`、`:93`；C# 对应文件均位于 `src/BoardWC.Engine/Data/`。C# README 第 100 行也明确列有修正内侧花园与训练 JSON 的 TODO，但作者 TODO 本身不能代替外部证据。

两人局必须移除一层、二层牌左下角有人数标记的牌，S1 第 96–97 行明确。其余两人设置不改变花园各 5 张与训练 8 个的组件池，每局仍抽各 3 张花园、4 个训练板块。

公开快照可支持两人一、二层各 9 张的数量推断：

- 解析 `GameInfo.CurrentGameState`，再取 `PublicState`。
- 一层：`NumStewards=5`，`Castle[3..5].Card=[43,50,44]`，`PlayerData[1].Card=46`，合计 `5+3+1=9`。
- 二层：`NumDiplomats=7`，`Castle[1..2].Card=[14,13]`，合计 `7+2=9`。
- 快照处于第一轮，动作记录只有一次家臣取得新牌；`PlayerData[0].Card=33` 是尚未替换的个人起始牌，不能混算为城堡牌。

这是对该公开对局的核算，不能单凭余量确定全部牌的内容或未公开牌堆顺序。C# `Domain/RoomCard.cs:88`–`:105` 的加载入口没有人数参数或移除标记；其 9/9 配置至多是一个两人候选子集，不能据此声称支持完整 15/12 牌池。

## 3. 花园：已核验全部 10 张公开牌图

出版方一手图：

- [植物花园图](https://devir.world/thewhitecastle/assets/cartajardiplantes.png)：可清晰看到 5 食物/9 分、4 食物/7 分等实例。
- [石头花园图](https://devir.world/thewhitecastle/assets/cartajardipedres.png)：可清晰看到 3 食物/5 分实例。

以下完整表由 Yucata 单张高清静态图独立转录，并按 S1 图标说明解释。表中的金币是**执行牌上行动时的额外费用**；人员行动本身的部署/晋升成本仍须正常支付。花园终局分与即时收益分开记录。

| 来源 ID / 单张图 | 种类 | 部署食物 | 园丁终局分 | 即时及合格轮末触发的效果 |
|---|---|---:|---:|---|
| [26](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_26.png) | 植物 | 5 | 9 | 支付 4 金币，执行一个与城堡内任意骰色板块关联的行动 |
| [27](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_27.png) | 植物 | 4 | 7 | 支付 3 金币，执行园丁行动 |
| [28](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_28.png) | 植物 | 4 | 7 | 支付 3 金币，执行家臣行动 |
| [29](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_29.png) | 植物 | 4 | 7 | 支付 3 金币，执行武士行动 |
| [30](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_30.png) | 植物 | 3 | 5 | 支付 4 金币，执行个人面板行动，遵守该图标的同行限制 |
| [58](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_58.png) | 石头 | 1 | 1 | 获得 2 个自选资源，可以相同或不同 |
| [59](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_59.png) | 石头 | 1 | 1 | 获得 3 金币 |
| [60](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_60.png) | 石头 | 2 | 3 | 获得 2 印章 |
| [61](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_61.png) | 石头 | 2 | 3 | 执行主棋盘城堡内任意牌的一个浅色行动 |
| [62](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/card_62.png) | 石头 | 3 | 5 | 执行水井行动 |

其中 62、29、59、30、58、27 恰是快照 `PublicState.Gardens` 从 0 至 5 的排列。其余四张通过同一公开图像命名约定核验；没有推测尚未看到的牌面。

明确错误及影响：

1. 两个 C# 花园文件的全部 `foodCost` 都在 0–2，而真实植物花园全部为 3–5，石头也有 3。所有 `victoryPoints` 都在 1–3，而真实植物花园为 5/7/9，石头有 5。该配置不是少几张牌的问题，而是整套候选池和收益尺度不符。
2. 即使不依赖静态图片，S1 `rules-text.txt:380`–`:381` 已给出“支付 4 食物，再支付 3 金币执行家臣行动”的明确反例；C# 当前花园池无法表达这个已写入规则的案例。
3. C# `inland-farm-cards.json:55`、`:63` 仅写通用城堡字段动作，`actionCost` 均为空；不能替代真实植物花园的 3/4 金币费用及具体目标限制。
4. C# `Domain/FarmingLands.cs:127`–`:140` 解析 `foodCost`、`gainItems`、描述与终局分，完全没有读取 JSON 的 `actionCost`；只修 JSON 费用也不会让引擎实际支付。`Rules/FarmHandler.cs:90` 起的效果分派也未对该字段收费。

因此独立实现应录入上表的事实数据，并用结构化效果区分“任意骰色关联城堡行动”“任意城堡牌浅色行动”“个人面板行动”；不能统一成无约束的“任意行动”。

## 4. 训练板块：16 个面已核验，实体配对尚未核验

出版方 [Yards.png](https://devir.world/thewhitecastle/assets/Yards.png) 直接可见黄色面上的 2 分与 2 影响力，以及蓝色面上的城堡/骰色行动；足以证伪黄色面只能是资源的假设。

Yucata 公开单面图如下。颜色是图像背景色，编号为平台图像编号，不是物理板块 ID：

| 来源面 ID / 单张图 | 背景 | 效果 |
|---|---|---|
| [1](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard1.png) | 蓝 | 武士行动 |
| [2](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard2.png) | 蓝 | 园丁行动 |
| [3](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard3.png) | 蓝 | 执行一个与城堡内珊瑚骰色板块关联的行动 |
| [4](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard4.png) | 蓝 | 执行一个与城堡内白骰色板块关联的行动 |
| [5](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard5.png) | 蓝 | 执行一个与城堡内黑骰色板块关联的行动 |
| [6](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard6.png) | 蓝 | 执行一个与城堡内任意骰色板块关联的行动 |
| [7](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard7.png) | 蓝 | 个人面板行动 |
| [8](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard8.png) | 蓝 | 家臣行动 |
| [9](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard9.png) | 黄 | 2 影响力 |
| [10](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard10.png) | 黄 | 3 食物 |
| [11](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard11.png) | 黄 | 水井行动 |
| [12](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard12.png) | 黄 | 2 印章 |
| [13](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard13.png) | 黄 | 5 金币 |
| [14](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard14.png) | 黄 | 主棋盘城堡内任意牌的一个浅色行动 |
| [15](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard15.png) | 黄 | 2 家族分 |
| [16](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/yard16.png) | 黄 | 3 珍珠 |

公开快照 `PublicState.Trainings` 为 `[14]`、`[4]`、`[7,11]`，与图像呈现的“浅色城堡行动”“白骰关联行动”“个人面板加水井”相符。该快照没有字段提供已抽实体的反面身份。

**未确认：哪一个蓝面与哪一个黄面印在同一实体上。不能假定 `i ↔ i+8`。** 逐面图完整不等于八个实体的正反配对完整。正式随机开局需要实体双面配对证据；缺失时可支持手工指定已观察到的四个面，但必须标明不能保证抽样分布与真实基础版一致。

对 C# 的明确判断：

- `training-grounds-tokens.json` 有 10 个实体条目，而应为 8。
- 全部 `resourceSide` 只有 Food/Iron/MotherOfPearls/Coin/DaimyoSeal，缺少实际存在的 2 分、2 影响力、水井及城堡浅色行动；数量和效果均错误。
- 蓝面实际应全为行动；C# 却把 `tg_04` 的行动面写为 1 印章、`tg_05` 与 `tg_10` 写为 3 金币、`tg_09` 写为灯笼。这些不能与公开的八个蓝色行动面对应。不能用“互换 resourceSide/actionSide”解决整池不符。
- `Domain/TrainingGrounds.cs:8`–`:17`、`:89`–`:103` 把一面建模成资源列表，另一面建模成描述。`Rules/TrainingGroundsHandler.cs:79`–`:88` 只分派三资源、币、印章，因此黄色面 11/14 的行动以及 9/15 的影响力/分数都不能通过该路径表达。
- 随机设置必须以 8 个实体无放回抽取 4 个，再按棋盘规定朝向摆放。不能把 16 个单面独立混洗抽取，因为可能同时抽到同一实体的两面。

## 5. 个人面板：已核验基础与全部 15 个揭开奖励

一手来源：[Devir 个人面板图](https://devir.world/thewhitecastle/assets/Taulerpersonal.png)。
高清交叉来源：[Yucata playerboard0.png](https://www.yucata.de/game-plugins/whitecastle/1.3.6/images/playerboard0.png)。
两者图案一致。S1 `rules-text.txt:343`–`:351` 说明骰色/人员对应及先发所有可见收益、再发当前行动牌收益。

下表“基础”是五个人员格左边的永久可见奖励；五个揭开奖励由左向右，人员按最左优先部署后依次露出。三排印刷比较值均为 6。

| 骰色 | 人员 | 基础可见奖励 | 揭开 1 | 揭开 2 | 揭开 3 | 揭开 4 | 揭开 5 |
|---|---|---|---|---|---|---|---|
| 珊瑚 | 家臣 | 食物 1 | 食物 1 | 食物 1 | 金币 2 | 食物 1 | 印章 1 |
| 黑 | 园丁 | 铁 1 | 铁 1 | 铁 1 | 灯笼 1 | 铁 1 | 金币 2 |
| 白 | 武士 | 珍珠 1 | 珍珠 1 | 珍珠 1 | 印章 1 | 珍珠 1 | 灯笼 1 |

例如，部署 3 个家臣后激活珊瑚排，面板可见收益为 `食物1+食物1+食物1+金币2 = 食物3、金币2`，与 S1 `rules-text.txt:355` 的例子一致。该收益之外仍需执行当前行动牌对应行。

C# `Data/personal-domain-rows.json` 的错误：

- 第 17–19 行将 White 关联 Farmer，第 30–32 行将 Black 关联 Soldier，黑白人员反了。
- Red 基础及五格全为 Iron；正确基础为 Food，且揭开格混合 Food/Coin/DaimyoSeal。
- White 的资源写为 MotherOfPearls，但对应人员错误，五格全珍珠也遗漏印章和灯笼。
- Black 基础及五格全 Food；应为 Iron，并混合灯笼和金币。
- `Domain/PersonalDomain.cs:66`–`:71` 的解析器只接受三类资源，遇到币/印章/灯笼会抛异常。只替换 JSON 数值不能修复；必须允许结构化奖励效果。

本节确定的是印刷固定面板，不包含不同起始行动牌、后续取得城堡牌及灯笼区内容。不能把“固定面板已核验”误写为“所有个人行动收益已核验”。

本批新增的卡牌映射已根据用户原图记录：起始行动的单一字段适用三排；地头上中下分别映射家臣/园丁/武士；使节按实际两区占高映射。地头共同牌背为金币1，使节共同牌背为家族分1，详见 [card-castle-audit.md](card-castle-audit.md)。这些数据核验没有解除晋升换牌及影响力的实现限制。

## 6. 尚未完成与实施门槛

| 项目 | 当前证据状态 | 后续条件 |
|---|---|---|
| 八块训练板块的正反配对 | 16 个面的内容已核验，配对未知 | 清晰实体正反对应照片、出版方配对表或等价一手证据；不能按平台编号猜 |
| 额外两个训练面 | 用户图可见，基础版归属未确认，保持禁用 | 证实其版本与实体归属；不能以图片数量增加基础版组件池 |
| 两人一、二层逐牌内容 | 已由用户15/12张原图及牌背核验，并按标记录入9/9 | 后续变更引用原图行列；平台ID若需互通仍须单独映射 |
| 起始牌、法令牌、三层牌 | 用户原图已替代旧待核验项；目录按9/6/3/9录入，起始行动各2张已确认 | 验证组合/选择效果的实际执行，不从C#数据补内容 |
| 训练区费用与系数 | 已核验铁1/3/5及终局系数1/1/2 | 手工练习按固定区数据使用；仍须确认实体配对才能正式随机抽取 |
| 平台与实体版本差异 | S3 版本 1.3.6；未发现本次图像与一手组件图冲突 | 若出现差异，记录具体版次，不能以平台覆盖基础规则 |
| 所有动态费用与嵌套行动 | 部分显式决策连锁已实现，晋升、三层、影响力、轮末尚未完成 | 逐效果验证支付、目标过滤、选择顺序、资源上限及失败原子性 |

本文本批更新只读取当前数据/引擎并编辑文档，没有编译、构建、运行C#项目或启动测试。建议验证55张实体分类数量、人数过滤、三种起始行动各2张、禁用训练面不能被执行、训练实体配对缺失时拒绝正式随机开局；再验证费用、限定目标、混合收益与连锁顺序。其他批次的实际测试结果应在对应模块日志记录，数据数量正确不能替代行为验证。
