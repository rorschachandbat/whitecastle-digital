export const StringTable = Object.freeze({
  title: '姬路城 · 盘面读取',
  description: '在BGA对局页启动，公开盘面每秒检查一次，稳定后发送到本机侧栏。',
  address: '本机工具地址',
  token: '配对码（从本机工具复制）',
  start: '开始读取当前对局',
  stop: '停止读取',
  open: '打开本机侧栏',
  waiting: '尚未连接。',
  connected: '已启动，等待盘面稳定。可以关闭此弹窗。',
  stopped: '已停止读取。',
  updated: '游戏桌 {table} · 最近发送 {time}',
  error: '连接未完成：{code}。检查本机工具是否运行、配对码和BGA页面是否正确。',
});
export const text = (key, values = {}) => StringTable[key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
