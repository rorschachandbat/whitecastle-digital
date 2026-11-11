# 两人规则核心与本批配置验收

## 当前交付与阶段边界

本批停在**阶段一的中间验收点**：将已核验卡牌、起始选牌和一批区域行动接入纯引擎。完整阶段一仍需家臣晋升换牌、顶层槽位、影响力、轮末和完整随机开局；尚未进入合法动作模型、网页棋盘、Yucata 复盘或 AI。网页 Client 仍为骨架。

规则依据是 [RULES.md](RULES.md)。数据核验说明见 [data-audit.md](data-audit.md)、[card-castle-audit.md](card-castle-audit.md)、[top-decree-audit.md](top-decree-audit.md) 和 [training-pairing.md](training-pairing.md)。现有源码、测试夹具和局面样本不能替代规则来源。

## 模块与目录

```text
data/whitecastle-2p.json ← 配置编辑器 / 人工核验
           ↓
src/data/catalog.js：结构校验、规范化序列化、SHA-256
           ↓ 显式传入 config
src/engine/cardRules.js：个人牌布局、骰色与字段引用
src/engine/startingDraft.js：独立起始选牌阶段
src/engine/engine.js：实验局面、原子行动、部分计分
           ↓ 后续适配，当前未接入
合法动作模型 → boardgame.io / 网页 / Yucata 复盘 / AI
```

- 引擎不读取文件，不访问网络、DOM 或训练框架。配置使用稳定 ID、结构化费用和效果，不使用中文说明文本判断规则。
- 当前目录含 55 张两人实体卡：植物/石头花园各 5、起始资源 9、起始行动 6、一层 9、二层 9、三层 9、敕令 3。起始行动保留三种设计各两张的独立实体 ID；一层、二层按人数标记筛选。
- 另有 3 排个人面板、16 个基础训练场单面和 3 个训练区费用/计分系数。8 个训练实体的 `faceIds` 保持空数组及 `pending`，不得推断正反配对。
- `unclassifiedAssets` 中另外 2 个训练面保持 `enabled:false`，不进入基础版 `yardFaces` 或抽样。
- `imageSources` 保存本地来源路径和哈希；编辑器展示文字与数值预览。目录录入了某个图标，不代表引擎已经实现其效果。
- 组件编辑不能修改两人基础规则常量：每轮每人 3 次、资源上限 7、印章上限 5、个人比较值 6、水井比较值 1。

## 起始选牌 API

| 接口 | 当前行为 |
|---|---|
| `createStartingDraft(config, { seed, playOrder = ['0', '1'] })` | 确定性地从两堆分别不放回抽 3 个实体，组成 3 对；仅允许已核验且明确适用两人的卡 |
| `chooseStartingPair(draft, actor, pairId, config, { choices = [] })` | 返回新草稿，按行动顺序逆序各选一对；错误抛出带稳定 `code` 的 `StartingDraftError`，原草稿不变 |

默认玩家 `1` 先选、`0` 后选。当前行动牌保存为 `currentCardId`，资源牌及可选敕令按顺序保存为 `lanternCardIds`；资产只来自 `initialGains`。选牌不会执行当前牌正面，也不会立即触发灯笼收益。每单位 `chooseResource` 必须通过 `choices` 显式给出 `food`、`iron` 或 `pearl`。

草稿的 `mode` 为 `starting-draft-only`，两次选牌后 `phase` 为 `complete`，保留一对未选牌。它不包含桥、花园、城堡或完整对局设置。

选牌完成后，可把结果送入一个**新的**局面配置：

```js
const positionConfig = structuredClone(draftConfig);
delete positionConfig.players;
delete positionConfig.initialPlayer;
positionConfig.setup = {
  ...positionConfig.setup,
  players: ['0', '1'].map((id) => draft.players[id]),
  playOrder: [...draft.playOrder],
  initialPlayer: draft.playOrder[0],
};
const state = createPosition(positionConfig, { seed: 'practice-1' });
// 后续动作和计分必须继续传 positionConfig。
```

此例要求默认的玩家 ID `0`、`1` 和已完成的草稿。`createPosition` 当前固定这两个 ID；选牌助手支持自定义顺序标识，不表示局面引擎支持任意玩家 ID。复制玩家结果也不会自动补齐花园、城堡、训练或水井设置。

配置签名有三个不同用途：

| 字段/接口 | 内容与边界 |
|---|---|
| `draft.canonicalSignature` | 选牌创建时完整配置的规范化序列化；后续选牌必须继续使用同一配置 |
| `state.configSignature` | `createPosition` 输入配置的规范化序列化；`applyAction`、`score` 不接受变更后的配置 |
| `catalogFingerprint(config)` | 编辑器使用的 SHA-256 指纹，和以上两个字段不是同一种值 |

属性顺序变化不改变规范化结果；配置内容变化会返回 `CONFIG_MISMATCH`。添加 `setup.players` 后的 `positionConfig` 与原选牌配置不同，因此分别绑定各自签名；不要把草稿签名直接写进局面状态。未来训练记录应保存配置快照、指纹、引擎版本和种子。

## 局面和行动 API

| 接口 | 当前行为 |
|---|---|
| `createPosition(config, { seed })` | 建立两人 `core-incomplete` 实验状态；同种子同配置可复现三色九骰，其他开局摆设需显式配置 |
| `applyAction(state, action, config)` | 返回新状态；失败抛带稳定 `code` 的 `EngineError`，原状态不变 |
| `score(state, config)` | 返回各项小计、缺失资料和 `complete`；该值只描述本次计分资料是否齐全，不代表完整引擎或完整对局已实现 |
| `replaceCurrentCardWithLantern(player, nextCard)` | 不可变换牌 helper，不是可任意调用的玩家动作，也不代表晋升换牌已实现 |
| `personalField(card, row)` | 解析个人行动字段：起始牌共用 `action`，一层按上中下，二层按明确的印刷行布局 |
| `castleFields(card, tiles, color)` / `lightFields(card)` | 返回匹配骰色或浅色的字段引用，不自行发放收益、不校验完整随机摆设 |

原子取放骰例子，使用正式起始园丁牌和本局已配置的花园：

```json
{
  "type": "placeDie",
  "actor": "0",
  "bridgeId": "black",
  "side": "right",
  "target": { "area": "personal", "row": "gardener" },
  "decisions": [{ "type": "gardener", "cardId": "garden-58" }],
  "choices": ["food", "pearl"],
  "effectOrders": []
}
```

例子假定玩家当前牌为 `start-action-gardener-1`、`garden-58` 属于 `setup.gardens`，桥上有可从右取的黑骰，且资产足够。`bridgeId` 必须对应状态中的实际桥 ID。

`placeDie` 把取骰、支付差额、左端灯笼、区域收益和连锁决策作为一个原子动作。费用不足、引用无效、缺少选择或遇到未实现效果时，原骰子、资产和人员均不改变；没有公开的“先取骰、以后再放”动作。

### 选择与执行顺序

- `action.choices`：按实际执行顺序逐单位提供任选资源。只能是 `food`、`iron`、`pearl`；缺失或多余选择都会被拒绝。
- `action.decisions`：按实际执行的深度优先次序排列子决策。后续奖励可以继续产生决策；与待执行类型不符、缺失或多余决策都会被拒绝。
- `action.effectOrders`：每次进入一个含多个效果的收益组占一个索引，包含个人可见收益、灯笼和嵌套组合。元素为该组效果索引的完整排列，例如 `[1,0]`；`null` 使用原有印刷顺序，省略后续元素同样使用原顺序。不能借排序省略组合收益；字段内多个效果仍作为一个字段整体处理。

支持的 `decisions` 形状：

| 场景 | 决策形状与行为 |
|---|---|
| 园丁 | `{type:'gardener', cardId}`；支付花园食物费并部署，默认激活该牌；可加 `activate:false` 表示只部署 |
| 训练 | `{type:'warrior', yardId, faceOrder:[faceId,...]}`；支付训练区铁费并部署，按给定次序激活所选可见面；单面可省略 `faceOrder` |
| 家臣谒见 | `{type:'courtier', audience:true}`；支付 2 金币，在城门部署家臣；`promote` 当前明确拒绝 |
| 个人面板图标 | `{type:'domain', row:'gardener'}`；执行指定排可见收益与当前牌字段，同一次动作不能借图标重复激活同一排 |
| 城堡图标 | `{type:'castleLight', roomId, fieldId}` 等；支持 `castleAny`、`castleCoral`、`castleBlack`、`castleWhite`，分别检查浅色或骰色关联 |
| 城堡同色多字段 | `{type:'castleOrder', fieldIds:[...]}`；必须完整排列所有匹配字段，随后各字段产生的决策继续按执行顺序提供 |
| 城外 | `{type:'outside', action:'gardener'}`；左侧允许园丁/家臣，右侧允许家臣/武士，随后还要提供该人员行动的决策 |
| 放弃子行动 | `{type:'gardener', skip:true}` 等；放弃对应图标的子行动，不跳过整次取放骰 |
| 放弃字段 | `{type:'field', fieldId, skip:true}`；必须紧邻当前待执行字段，整体放弃且不付该字段费用；已支付骰差、部署费及先前收益保留 |

两种放弃含义不同：先支付字段费用再遇到人员图标时使用人员 `skip`，字段费用已经支付；在 `executeField` 前使用 `field` 放弃，则不支付该字段费用。城堡同色多字段仍要先完整给出 `castleOrder`，再在相关字段前提供 `field` 放弃。

印章兑换为单独动作：

```json
{ "type": "exchangeSeal", "actor": "0", "amount": 2, "resource": "iron" }
```

`amount=1` 得 1 金币，`amount=2` 得指定资源；仅当前玩家可用，不消耗正常放骰次数。本批不支持在原子连锁中途插入独立兑换。

## 实验局面配置

目录表达组件；`setup` 表达这一次实验摆设。完整随机设置未实现，调用方必须显式提供本局使用的组件和位置。

| 配置 | 当前读取方式 |
|---|---|
| `setup.players` | 数组下标分别对应玩家 `0`、`1`；接受选牌助手的 `resources`、`currentCardId`、`lanternCardIds`，也可显式提供 `figures` |
| `setup.playOrder` / `setup.initialPlayer` | 两人行动顺序和初始行动者；顶层 `config.initialPlayer` 存在时优先 |
| `setup.bridges` | 可显式给三色各三骰；顶层 `config.bridges` 优先，缺失时仅用种子生成骰子 |
| `setup.gardens` | `[{cardId, bridgeId}]`；仅这些花园可用于园丁部署，不会自动从目录抽取六张 |
| `setup.trainingMode` | 必须显式为 `manual-visible-faces` 才开放当前训练练习 |
| `setup.trainingYards` | `[{id:'yard-cost-1', faceIds:['yard-face-15']}]` 等；训练区 ID、面数和朝向须与 `trainingZones` 对应，同一面不可重复 |
| `setup.castleRooms` | `[{id, cardId, tiles:[{color, fieldId}]}]`；保存房间牌与骰色板块引用，不自动完成正式随机摆设 |
| `setup.placements` | 例如 `'castle:room-a':{area:'castle',comparisonValue:6}`；城堡及城外位置需显式提供已核验比较值，两人容量为 1 |
| `setup.fixtureVersion` / `setup.wellRewards` | 水井仅接受 `fixtureVersion:'well-rewards-v1'` 的显式实验收益，再额外给 1 印章；不能把训练面冒充正式水井组件 |
| `policy.singleDieEndpoint` | 桥只余一骰时的端点策略；默认 `null`，资料不足时拒绝取骰，不猜是否给灯笼 |

顶层 `config.players`、`config.bridges`、`config.placements`、`config.wellRewards` 会优先于相应 `setup` 字段，整合配置时避免同时保留不同版本。

训练区当前记录：1 铁区为 1 个资源面、系数 1；3 铁区为 1 个行动面、系数 1；5 铁区为资源/行动各 1 面、系数 2。手工选择可见面仅用于指定局面练习，不等价于按 8 个实体抽取 4 个的正式开局。

## 已支持与未完成项

- 支持确定收益、灯笼、显式任选资源、园丁与训练部署、家臣谒见、个人面板图标、浅色/骰色城堡图标、水井实验收益及其连锁。字段费用先支付，不能用同一字段的后续收益垫付。
- 园丁、武士和城门家臣保存在人员数组，受可用人员数量约束；园丁不能在同一花园重复部署自己。人员不会在本次动作后自动回收。
- 支持按配置城堡放骰匹配全部同色字段、显式排序，以及城外左右位置对应人员行动；个人排骰色、比较值 6、容量 1。
- `score` 提供金币/印章、资源、花园、家臣位置、训练系数及已配置时间轨的分项。训练分数按区系数乘城内家臣数，不把即时训练收益当作终局系数；缺失资料或同分顺序时不猜赢家。
- **未实现**家臣晋升、替换城堡牌及到达流程、顶层共享槽位占用、影响力与轮末次序。三层卡数据和浅色字段助手不代表这些流程已实现；遇到未实现效果返回错误。
- 六次正常放骰后停在 `round-end`，不自动触发轮末花园、掷骰或进入下一轮。当前不能完成三轮正式对局。
- 没有 `getLegalActions`、完整随机开局、完整存档导入、玩家视角过滤或训练接口；当前状态不得作为对外玩家视角直接发布。

## 本批验收与推荐验证

本批相关 Node 测试已有通过记录，覆盖目录、牌布局、选牌和区域连锁集成；具体命令及实际结果以本批 [CHANGELOG](../CHANGELOG.md) 为准。本文不因数据齐全或测试通过宣称完整引擎已完成。未运行编译或 Vite 构建。

推荐在合并改动后由用户执行以下不编译检查：

```shell
npm run check
npm test
node --test tests/card-integration.test.js tests/startingDraft.test.js tests/cardRules.test.js
npm run config
```

推荐人工步骤：

1. 在编辑器按类别核对 55 张卡、起始行动三种各两份、资源牌敕令引用以及使节牌的三排行布局。
2. 修改花园费用、起始资产或牌背，应用后检查预览、指纹和导出 JSON；负费用、重复 ID、错误敕令类型及无效布局应被拒绝。
3. 选牌后把结果写入新配置的 `setup.players`；用新配置创建局面，确认用旧配置执行动作会拒绝。
4. 检查园丁部署/不激活、训练两面先后、城堡先得印章再付费及反向顺序失败；失败后对比原骰子、资产和人员。
5. 检查字段整体放弃与子行动放弃的费用差异，组合收益的 `effectOrders` 使用 `null` 保留前组原次序。
6. 确认训练实体仍未配对、额外两面仍禁用、未出现“开始完整对局”的入口；触发影响力或晋升应明确拒绝。

已有局部编辑器验证不能代替以上矩阵。生产构建需用户自行运行 `npm run build`、`npm run preview`，或在当前请求中明确授权后再执行。
