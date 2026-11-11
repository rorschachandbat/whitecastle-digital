export const StringTable = Object.freeze({
  'app.title': '姬路城 · 规则工作台',
  'app.brand': 'WHITE CASTLE / DIGITAL LAB',
  'app.tagline': '先把规则做准，再寻找更好的每一步。',
  'app.intro': '以可核验规则为基础，逐步建立网页版、局面复盘与 AI 分析工具。',
  'status.label': '项目阶段',
  'status.value': '规则基准与框架接入',
  'status.notice': '当前是开发工作台，尚不能进行完整对局。未核验的卡牌和面板数值不会用于模拟。',
  'framework.title': '引擎连接',
  'framework.loading': '正在初始化 boardgame.io…',
  'framework.ready': 'boardgame.io 已初始化',
  'framework.failed': '框架初始化失败，请查看开发者控制台。',
  'framework.version': '固定依赖：boardgame.io 0.50.2',
  'framework.state': '当前状态 JSON',
  'framework.export': '导出框架状态',
  'framework.exportNotice': '这是框架骨架状态，不是对局存档。',
  'rules.title': '规则是唯一依据',
  'rules.body': '规则按编号维护；源码、测试或参考项目与规则冲突时，以来源核验后的规则文档为准。',
  'rules.link': '阅读规则基准',
  'guide.link': '框架接入指南',
  'plan.link': '实现计划',
  'workflow.link': '开发与版本管理约定',
  'changelog.link': '查看项目变更记录',
  'roadmap.title': '实现路线',
  'roadmap.rules': '01 / 核验规则与卡牌数据',
  'roadmap.engine': '02 / 独立规则引擎与动作模型',
  'roadmap.web': '03 / 棋盘、连锁操作与复盘',
  'roadmap.ai': '04 / 搜索、策略对比与训练',
  'roadmap.note': '当前完成的是规则文档与框架骨架，后续功能按模块逐批实现、验证和提交。',
  'footer.text': '项目独立实现；规则、素材及第三方代码的来源分别记录。',
});

export function text(key) {
  if (!(key in StringTable)) {
    throw new Error(`StringTable 缺少键：${key}`);
  }
  return StringTable[key];
}
