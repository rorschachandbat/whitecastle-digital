# 测试模块 CHANGELOG

## 2026-11-11 — 框架接入烟雾测试

- 新增 `framework.test.js`，用原生 `node:test` 加载 npm 已发布的 boardgame.io CommonJS 入口。
- 覆盖真实 Client 初始化、两人骨架、状态 JSON 序列化、空 moves、禁止客户端回合事件与 StringTable 缺失键。
- 实际执行 `npm test`：3 项通过、0 项失败，不运行 Vite、转译器或项目构建。
- 没有规则动作，因此本批测试不代表任何 `RULES.md` 桌游规则验收案例已通过。
- 推荐下一步：规则模块实现时，以规则编号添加合法动作、非法动作原子性及可重复状态转移测试。
