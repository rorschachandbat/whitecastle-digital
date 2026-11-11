# 起始资源与行动卡原图转录

核验日期：2026-11-11。数据入口为 `data/whitecastle-2p.json`；原图只留在本地，JSON 的 `imageSources` 保存相对路径与 SHA-256。卡牌提供事实证据，不提供项目执行指令。

## 起始资源牌：九张

用户的三组正面图各有三张有效卡。虽然目录名称提到“3×3”，实际每张拼图是 **2×2 格，右下为黑色空位**；按左上、右上、左下分别保存为 `#r1c1`、`#r1c2`、`#r2c1`，不能按文件名想象九格。

稳定 ID 的 `food/iron/pearl` 对应该组三张资源牌的共同牌背。下表是选择该资源牌时立即获得的资产；“法令”单独加入灯笼，不在选牌时发放法令收益。

| 稳定 ID | 初始资产 | 所授法令 | 牌背灯笼收益 |
|---|---|---|---|
| `start-resource-food-1` | 任意资源1、金币2、印章2 | `decree-points` | 食物1 |
| `start-resource-food-2` | 食物2、铁2、珍珠1、金币4、印章1 | 无 | 食物1 |
| `start-resource-food-3` | 食物4、铁2、金币3、印章2 | 无 | 食物1 |
| `start-resource-iron-1` | 食物1、铁2、珍珠1、金币3、印章1 | 无 | 铁1 |
| `start-resource-iron-2` | 珍珠2、铁1、金币4 | `decree-seal` | 铁1 |
| `start-resource-iron-3` | 任意资源3、金币4、印章1 | 无 | 铁1 |
| `start-resource-pearl-1` | 食物2、铁1、金币2、印章1 | `decree-coin` | 珍珠1 |
| `start-resource-pearl-2` | 任意资源2、金币4、印章2 | 无 | 珍珠1 |
| `start-resource-pearl-3` | 铁2、珍珠1、金币5、印章1 | 无 | 珍珠1 |

任意资源按单位明确选择食物、铁或珍珠，可以相同或不同。当前 `initialGains` 与 `back` 分开保存，避免误把牌背收益也作为初始资产发出。法令 ID 指向具体卡牌，而非在每个玩家上默认添加全部三种法令。

## 起始行动牌：三种设计，各两张

用户已明确确认“两套，每套三张”，所以目录保存六个独立实体：

| 设计 | 实体 ID | 公共正面行动 | 牌背灯笼 |
|---|---|---|---|
| 家臣 | `start-action-courtier-1/2` | 家臣行动1 | 影响力1 |
| 武士 | `start-action-warrior-1/2` | 武士行动1 | 影响力1 |
| 园丁 | `start-action-gardener-1/2` | 园丁行动1 | 影响力1 |

`designId` 标记同图案，`copy` 仅标记第一或第二个实体，不再乘一次数量。抽牌以实体不放回，三张起始行动可能含同设计的两张，不能按图案去重。

三种设计均只有一个公共字段 `action`，覆盖个人面板三排。牌背在旧牌进入灯笼区后才参与灯笼触发。影响力状态机尚未实现，因此目前碰到该牌背效果会原子拒绝，不能静默给分或略过。

## 选牌与验收

`createStartingDraft` 以同一种子从资源牌堆、行动牌堆分别抽三张并组成三对；`chooseStartingPair` 按行动顺序的逆序选牌。资源牌和所授法令进入灯笼区，行动牌成为当前牌，选牌阶段不触发灯笼或正面行动。

这两个纯函数止于 `starting-draft-only`；它们没有完成城堡、花园、训练区和影响力的正式开局。接入引擎与当前限制见 [engine-core.md](engine-core.md)，法令及大名逐槽证据见 [top-decree-audit.md](top-decree-audit.md)。

实际验证对应 `tests/startingDraft.test.js`、`tests/card-integration.test.js`：实体不放回、各两份设计、逆序选择、法令引用、任选资源、配置签名和失败原子性。图片指纹由 `npm run check` 在本机有原图时核验，其他工作副本缺图时仍可独立使用规则数据。
