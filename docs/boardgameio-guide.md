# boardgame.io 使用指南：姬路城网页版

本文档记录本项目对 boardgame.io 的选型、版本和实现约定。它只描述框架如何承载《姬路城》规则；具体规则以 `docs/RULES.md` 为准。文中的代码片段都是接口提案或验证用伪代码，不代表完整规则已经实现。

## 1. 研究范围与版本

本指南依据以下资料整理：

- boardgame.io 官方仓库：<https://github.com/boardgameio/boardgame.io>
- 本地检查的 boardgame.io 提交：`47adef2b46e375999931209ba7b41e9654c506e1`
- 本地源码 `package.json`：版本 `0.50.2`
- npm `latest` 查询结果：`0.50.2`
- 官方源码文档：`docs/documentation/api/Game.md`、`phases.md`、`stages.md`、`multiplayer.md`、`secret-state.md`、`tutorial.md`
- 已安装的官方 npm 包类型与实现：`dist/types/src/types.d.ts`、`dist/types/src/client/client.d.ts`、`dist/types/src/ai/`、`src/client/client.ts`

检查日期：2026-11-11。Git 主干仍标记 `0.50.2`，不代表其内容与已发布 npm 包一致。例如主干 `package.json` 具有 `exports` 映射，而已发布 `0.50.2` 使用 `client/package.json` 等子目录入口。实际接入以固定 npm 包的类型和实现为准，不能仅凭主干文档套用将来的行为。

项目必须固定使用：

```json
{
  "dependencies": {
    "boardgame.io": "0.50.2"
  }
}
```

当前 boardgame.io 主干使用 pnpm，但本项目可以使用 npm 或 pnpm；选择后应只保留一个锁文件。实现阶段不要直接引用 boardgame.io 仓库的 `src/`，只通过公开包入口导入。

### 1.1 导入兼容边界

- 网页通过 Vite 等打包器使用 `import { Client } from 'boardgame.io/client'`。
- 已发布包的 `client` 是子目录代理，不是带现代 `exports` 的原生 Node ESM 子路径；Node 直接执行 `.js` 的测试不应假定上述导入必然可解析。
- 当前 Node 测试使用 `createRequire(import.meta.url)` 后 `require('boardgame.io/client')`，读取官方预先发布的 CommonJS 入口，不需要编译项目。
- 不为规避解析问题依赖 `node_modules/boardgame.io/dist/...` 的私有文件路径；不使用远端主干源码代替锁定包。
- 本指南的 `ts` / `tsx` 示例只说明目标类型和可选方案，当前项目使用 JavaScript，不要求引入 TypeScript 或 React。

## 2. 核心概念

### `G`：游戏状态

`G` 保存《姬路城》的完整规则状态，例如桥上的骰子、城堡卡牌、玩家资源、棋子、影响力、轮次和待处理动作。

```ts
interface WhiteCastleState {
  round: number
  bridges: BridgeState[]
  castle: CastleState
  gardens: GardenState[]
  well: WellState
  outside: OutsideState
  trainingYards: TrainingYardState[]
  players: Record<PlayerID, PlayerState>
  pending: PendingAction | null
  decks: DeckState
}
```

`G` 应保存规则所需的数值和卡牌 ID，不直接保存 React 组件或 DOM 节点。卡牌效果应使用结构化数据表示，避免在 move 中解析展示文本。

这里的接口描述架构参考。当前 `src/game/game.js` 保留 `WhiteCastle` 工作台骨架，并新增 `createLocalGame` 承载真实两人练习对局。`localClient.js` 在Node使用已发布的公共Client入口，`npm run play` 通过本机HTTP服务驱动原生模块网页，不转译或构建；实际范围及限制见 [local-play.md](local-play.md)。

### `ctx`：框架状态

`ctx` 负责当前玩家、玩家数量、回合顺序、阶段和 active players。不要把 `ctx.currentPlayer` 复制到 `G`，除非它是用于复盘的明确业务数据。

常用字段：

```ts
ctx.currentPlayer
ctx.numPlayers
ctx.playOrder
ctx.playOrderPos
ctx.phase
ctx.activePlayers
ctx.turn
ctx.gameover
```

### Moves

boardgame.io 0.50.x 的 move 使用对象参数：

```ts
const TakeDie = ({ G, ctx, playerID, random, events }, bridgeColor, position) => {
  // 校验 playerID、当前阶段、骰子位置和待处理动作
  // 修改 G，最后通过 events 进入下一阶段或结束回合
}
```

完整签名是：

```ts
({ G, ctx, playerID, events, random, ...plugins }, ...args)
```

不要使用 0.49 及以前的 `(G, ctx, ...args)` 形式。

同样不要将新的对象式参数错误套用到所有 API：已发布 `0.50.2` 的 `setup` 是 `({ ctx, random, ...plugins }, setupData)`；`playerView` 是 `({ G, ctx, playerID })`；但 `ai.enumerate` 仍然是三个位置参数 `(G, ctx, playerID)`。`playerID` 是 move 参数，不应假设每个生命周期 hook 都有它。

非法动作返回：

```ts
import { INVALID_MOVE } from 'boardgame.io/core'

return INVALID_MOVE
```

非法动作必须保持状态不变，并由界面根据动作是否可用决定是否显示按钮。玩家看到的错误文本放入 StringTable，不要硬编码在 move 中。

## 3. 姬路城的 boardgame.io 映射

### 3.1 游戏初始化

`setup` 创建完整的初始局面：

- 三座桥和随机骰子；
- 城堡楼层、行动卡、骰子颜色标记；
- 花园卡；
- 训练场板块；
- 水井和城外区域；
- 玩家个人领域、资源、金币、印章和成员；
- 起始资源卡和行动卡对；
- 用于后续补牌的牌堆。

随机操作必须使用 boardgame.io 注入的 `random`，不要在规则 move 中调用 `Math.random()`。这样服务器和客户端可以复现同一个状态，AI 也可以使用固定种子。

### 3.2 起始选牌

使用一个 `setup` 或 `draft` phase：

```ts
phases: {
  setup: {
    start: true,
    moves: { chooseStartingPair },
    endIf: ({ G }) => G.setup.complete,
    next: 'round',
  },
  round: { /* 主游戏 */ },
}
```

玩家只能在自己的回合选择尚未被拿走的起始牌对。选择资源卡后，如果有多个 Any Resource 选择，应进入玩家专属 stage，而不是在一个 move 中猜测用户下一步选择。

### 3.3 每次放骰行动

一次玩家行动拆成以下 stages：

```text
TakeDie
  → PlaceDie
  → ResolvePlacement
  → ResolveOptionalEffects
  → EndTurn
```

建议动作命名：

```text
TakeBridgeDie(bridgeColor, position)
PlaceDie(target)
ChooseWellResource(resource)
ChooseOutsideAction(action)
ChooseCastleAction(action)
ChooseCastleRoom(room)
ChooseTrainingYard(yard)
ChooseGarden(garden)
ChooseInfluencePayment(willPay)
SkipPendingAction()
```

每个 stage 只暴露当前允许的 move。用 `events.setStage`、`events.endStage` 和 `events.endTurn` 控制阶段跳转。不要同时把所有后续动作暴露给当前玩家。

### 3.4 轮次和回合结束

boardgame.io 的 `turn.endIf` 可以检测桥上骰子数量和当前玩家的待处理状态：

```ts
turn: {
  endIf: ({ G }) => {
    if (G.pending !== null) return false
    if (G.activeDie !== null) return false
    return G.turnComplete
  },
  onEnd: ({ G }) => {
    // 轮内回合结束；如果只剩 3 个骰子，进入轮末结算
    return G
  },
}
```

更适合本游戏的做法是把“放骰完成”和“轮末结算”分开：

1. 玩家完成最后一个待处理动作；
2. 检查桥上骰子是否只剩 3 个；
3. 进入 `roundEnd` phase 或轮末 stage，依据时间轨与占位次序计算新的全体玩家行动顺序；
4. 按新的玩家行动顺序结算第一、二轮花园，玩家可选择自身合格花园的执行顺序；
5. 保留训练场上的武士、花园中的园丁和城堡中的成员；
6. 收齐各色骰子，重掷并升序摆回桥上；
7. 用第 3 步已确定的顺序建立下一轮 `ctx.playOrder`，不因花园期间影响力变化再次重排；
8. `G.round += 1`，回到主行动 phase。

第三轮完成后先更新最终行动顺序，再进入终局计分；不执行花园收益、不重掷骰子，也不刷新训练场板块。花园结算与下一轮准备的条件必须对应 `docs/RULES.md` 的 `R-ROUND-01` 至 `R-ROUND-04`。

### 3.5 自定义行动顺序

姬路城的下一轮行动顺序由影响力决定，不能使用默认的简单轮转。使用 `turn.order` 的自定义 `playOrder`，或者在轮末把计算后的顺序写入 `G.nextPlayOrder`，下一阶段使用 `TurnOrder.CUSTOM_FROM('nextPlayOrder')`。

同影响力时要保留棋子在影响力轨上的上下顺序，不能用数组索引或“最近获得影响力”的近似替代真实占位顺序。

## 4. 网页客户端

本项目当前入口是原生 JavaScript `Client`，不是 React。最小接入方式如下：

```js
import { Client } from 'boardgame.io/client';

const client = Client({
  game: WhiteCastleGame,
  numPlayers: 2,
  debug: false,
});

client.start();
const state = client.getState();
```

`client.moves` 和 `client.events` 是根据当前游戏配置生成的调度器；它们不应被视为绕过规则的公共写接口。界面应依据当前 `G`、`ctx` 和规则引擎生成的合法动作决定可操作控件，服务端或本地 master 仍会再次校验。

可交互界面应通过 `client.subscribe(render)` 订阅后续状态变化，并在卸载时调用返回的取消订阅函数和 `client.stop()`。网络或 `Local()` 同步完成前 `getState()` 可能返回 `null`，须显示加载状态。当前工作台没有动作，初始化后仅展示一次骨架状态，不等于完整的可交互棋盘。

### 4.1 React 客户端（可选）

React 客户端结构：

```tsx
import { Client } from 'boardgame.io/react'
import { WhiteCastleGame } from './game/WhiteCastleGame'
import { WhiteCastleBoard } from './board/WhiteCastleBoard'

export const WhiteCastleClient = Client({
  game: WhiteCastleGame,
  board: WhiteCastleBoard,
  numPlayers: 2,
  debug: true,
})
```

棋盘组件通过 `BoardProps<WhiteCastleState>` 接收：

```ts
import type { BoardProps } from 'boardgame.io/react'

interface WhiteCastleBoardProps extends BoardProps<WhiteCastleState> {}
```

棋盘组件只负责显示和调用 `moves`，不在组件内直接修改 `G`。常用属性：

```text
G
ctx
moves
events
playerID
isActive
isConnected
log
matchID
```

建议把大型棋盘拆为：

```text
WhiteCastleBoard
  ├─ TurnHeader
  ├─ BridgeRow
  ├─ CastleArea
  ├─ GardenArea
  ├─ TrainingYardArea
  ├─ WellArea
  ├─ OutsideArea
  ├─ PlayerDomainPanel
  ├─ PendingActionPanel
  └─ ActionLog
```

当前所有玩家文案集中在 `src/ui/StringTable.js`。组件只读取键值，不直接写中文长句。若未来改用 React，只是视图层选择，不改变 `G`、moves 或纯规则引擎的接口；迁移文案位置时统一引用，不能并行维护两套表。

## 5. 单机、复盘和多人

### 第一阶段：Local

先使用 `Local()` 做本地双人和 AI 原型：

```ts
import { Local } from 'boardgame.io/multiplayer'

const WhiteCastleClient = Client({
  game: WhiteCastleGame,
  board: WhiteCastleBoard,
  multiplayer: Local({
    persist: true,
    storageKey: 'whitecastle-local',
  }),
})
```

Local 模式适合：

- pass-and-play；
- 规则回归；
- AI 自博弈原型；
- 复盘和局面导入；
- 没有服务器时的 GitHub Pages 演示。

`Local()` 并不意味着自动联机：它在当前 JavaScript 运行环境内嵌入 master，供同一应用里的多个客户端连接，不会跨浏览器或电脑共享对局。双客户端应复用同一个 transport factory、同一 `matchID` 和不同 `playerID`；持久化也需另行验证生命周期和存储兼容性。

### 第二阶段：SocketIO 服务器

真正的多人联机需要 `boardgame.io/server` 和 `SocketIO`：

```ts
import { SocketIO } from 'boardgame.io/multiplayer'

const WhiteCastleClient = Client({
  game: WhiteCastleGame,
  board: WhiteCastleBoard,
  multiplayer: SocketIO({ server: import.meta.env.VITE_GAME_SERVER }),
})
```

服务器负责权威状态。客户端会做乐观更新，但服务器会覆盖不一致状态。生产环境需要配置 `origins`、持久化数据库、玩家凭据和 WebSocket 反向代理。

GitHub Pages 只能托管静态前端，不能托管 boardgame.io 的 Node/SocketIO 游戏服务器。因此部署路线分为：

- GitHub Pages：Local 单机、AI、复盘；
- Render/Fly.io/Railway/VPS：SocketIO 游戏服务器；
- 前端静态站点通过环境变量连接远程服务器。

## 6. 隐藏信息、复盘和状态导入

使用 `playerView` 隐藏对手的私有数据和牌堆顺序：

```ts
playerView: ({ G, playerID }) => {
  return filterViewForPlayer(G, playerID)
}
```

玩家不应看到：

- 未公开的牌堆顺序；
- 尚未抽出的卡牌具体效果；
- 其他玩家未公开的个人信息。

复盘模式可以使用完整局面，但复盘数据和线上玩家视图必须区分。boardgame.io 的原生 `Client` 没有把任意外部 JSON 当作合法存档的通用导入 API；`overrideGameState` 只适合受控调试或客户端展示覆盖，不能替代服务器权威校验，也不能把不完整的公开快照变成 `FullState`。项目必须先用独立 `StateAdapter` 校验版本、字段和隐藏信息，再通过受控初始化或分析层使用。

导入 Yucata 的公开 JSON 时，只导入公开状态和动作记录，不把第三方服务器作为本项目运行时依赖。缺少牌堆顺序、随机源或待处理决策时，应标记为不可完整恢复，而不是猜测补齐。

## 7. AI 接入

boardgame.io 的 AI 接口要求游戏提供 `ai.enumerate`：

```ts
ai: {
  enumerate: (G, ctx, playerID) => {
    return enumerateLegalMoves(G, ctx, playerID).map((candidate) => ({
      move: candidate.name,
      args: candidate.args,
    }))
  },
}
```

框架提供 `RandomBot`、`MCTSBot`、`Step` 和 `Simulate`。MCTS 的每个候选必须是完整可执行的 move action；因此《姬路城》的多级行动不能只枚举“选哪座桥”，而要在 stage 中继续枚举放置位置和可选连锁。

相关接口示意：

```js
import { RandomBot, MCTSBot, Step, Simulate } from 'boardgame.io/ai';

const randomBot = new RandomBot({
  enumerate: WhiteCastleGame.ai.enumerate,
  seed: 'experiment-001',
});
const searchBot = new MCTSBot({
  game: WhiteCastleGame,
  enumerate: WhiteCastleGame.ai.enumerate,
  seed: 'experiment-001',
  iterations: 1000,
  playoutDepth: 100,
});
```

`Step(client, bot)` 执行一个决策，`Simulate({ game, bots, state, depth })` 模拟到终局或深度上限。两者不等于“找到最优”。内置 MCTS 使用框架 reducer 推进 `G + ctx + plugins`，不是只接受 `G` 的独立搜索器；不能把 `client.getState().G` 或导出的骨架 JSON 单独当作可搜索完整状态。终局须用明确的 `winner`、`draw` 或项目适配的估值表达；不要假定它自动优化四人局每名玩家的最终分数。

推荐分层：

1. `enumerateLegalMoves`：只生成当前阶段真正合法的动作；
2. `RandomBot`：用于规则烟雾测试；
3. 简单启发式：资源、影响力、成员和终局潜力；
4. `MCTSBot`：先做确定性局面搜索；
5. 自定义 chance-aware MCTS：显式展开骰子重掷和牌堆随机；
6. AlphaZero 风格网络：规则稳定后再加入。

boardgame.io 的内置 MCTS 是通用行动搜索器，不是专门的随机博弈搜索器。骰子和牌堆随机应由项目自己的模拟层管理；训练时要区分公开观察、完整模拟状态和最终结果。

## 8. 状态导入、保存和测试

项目应提供一个独立的 `StateAdapter`：

```text
YucataClientData → PublicWhiteCastleState → boardgame.io G
boardgame.io G → AnalysisSnapshot
```

适配器要保留原始 action code、参数和时间戳，便于对照，但不能把 Yucata 的内部动作编号直接当作本项目的公共 API。

测试至少覆盖：

- 每一种桥骰子取法和桥中间骰子移动；
- 2 人模式禁止叠骰，3/4 人模式容量；
- 城堡、个人领域、水井、城外的金币差额；
- 低端骰子的灯笼奖励时机；
- 家臣、园丁、武士的颜色和资源对应；
- 轮末花园结算和武士保留；
- 影响力检查点及印章支付；
- 终局资源、金币与印章合并计分；
- 每个 `ai.enumerate` 候选都能成功执行；
- 使用固定 seed 时局面和动作序列可复现。

## 9. 推荐项目结构

```text
src/
  game/
    WhiteCastleGame.ts
    model.ts
    setup.ts
    cards.ts
    strings.ts
    rules/
      actions.ts
      bridges.ts
      castle.ts
      domain.ts
      gardens.ts
      scoring.ts
      turns.ts
    ai/
      enumerate.ts
      heuristic.ts
  board/
    WhiteCastleBoard.tsx
    components/
  adapters/
    yucata.ts
  server.ts
  main.tsx
public/
docs/
  RULES.md
  boardgameio-guide.md
CHANGELOG.md
```

规则函数应尽量是纯函数；boardgame.io move 只负责从 `G` 读取输入、调用规则函数、写回结果和触发事件。这样同一套规则可以给网页、复盘器和 AI 使用。

## 10. 实现顺序

1. 固定 `boardgame.io@0.50.2`、JavaScript/Vite 工具链及锁文件；
2. 建立结构化 `G` 和两人模式初始化；
3. 完成桥、取骰、放骰、金币差额和个人领域基础动作；
4. 完成城堡、花园、训练场、水井和城外行动；
5. 完成起始选牌、灯笼区、影响力和轮末状态机；
6. 加入严格终局计分；
7. 做 Yucata 公共动作记录适配和复盘；
8. 接入 RandomBot 和合法动作回归；
9. 接入 MCTS；
10. 最后再接 SocketIO 多人服务器。

每一个较大的模块都要在相邻目录或文档中维护变更记录，并同步更新根目录 `CHANGELOG.md`。规则改变时必须先更新 `docs/RULES.md`，再修改代码。

上面的目录树和步骤是后续方案，不要求当前骨架立刻改成 React 或 TypeScript；真实完成情况以根 CHANGELOG 和各模块 CHANGELOG 为准。按项目约定，本次没有运行编译、构建或浏览器预览。建议先执行不触发编译的结构检查与 Node 测试；Vite 开发、构建及 Pages 部署需要用户明确授权，普通 Git 推送不得自动触发构建。

## 11. 不采用的做法

- 不把 Yucata 服务器动作接口作为本项目的后端；
- 不复制 Yucata 的客户端图片、CSS 或未授权代码；
- 不在 React 组件中直接改 `G`；
- 不用 `Math.random()` 代替 boardgame.io 的 `random`；
- 不把所有连锁步骤塞进一个不可解释的 move；
- 不在规则尚未经过对局回放验证前训练策略网络。
