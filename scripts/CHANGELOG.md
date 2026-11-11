# 工具脚本 CHANGELOG

## 2026-11-11 — 非构建检查入口

- `check-project.mjs` 检查规则/开发文档、模块 CHANGELOG、页面本地导入、StringTable 引用与 Markdown 本地文件链接。
- 从脚本位置推导根目录，不硬编码分支或本机路径；可以从其他目录执行。
- 脚本需要与仓库的 `src/`、`docs/` 和 `package.json` 一起使用，不能只复制脚本单文件运行。
- 不执行构建、网络请求或文件修改。
- 推荐在仓库根运行 `npm run check`，在其他目录运行 `node <工作副本>/scripts/check-project.mjs`。
- 检查只涵盖结构和已识别的文案键、链接文件存在性，不验证外链及标题锚点，不等于完整 UI 或规则验证。
