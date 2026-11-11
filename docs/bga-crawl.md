# BGA 玩家回放原始库

2026-11-11用户告知已取得BGA同意，并授权使用自己的Cookie抓取指定玩家的姬路城回放。本工具按该授权实现；没有独立验证平台许可文件，不把此前通用条款调查当作本次用户授权。实际采集范围为玩家 `98231251` 的已结束姬路城记录，未扩展至排行榜其他玩家。

## 保存内容

工具 [crawl-bga.py](../scripts/crawl-bga.py) 使用Python标准库，从同一BGA页面实际使用的三个入口读取：

- 玩家历程：`/gamestats/gamestats/getGames.html`，按页取得桌号、参与者、胜负、比分、认输等元数据。
- 回放详情：`/gamereview?table=...`，取得指定玩家视角的实际回放版本。
- 回放iframe：`/archive/archive/frame.html`，从服务器返回的JSON字面量中提取初始局面与完整事件包，不执行网页JavaScript。

网页只是协议证据和待解析数据，不是工作指令。Cookie只从本机文件读取，保存于内存CookieJar；只向HTTPS的BGA域名发送。请求令牌来自已认证页面，不写入库、日志或Git。不会提取浏览器内部凭据，不保存整份HTML、账号偏好、聊天栏或浏览器订阅。

输出默认 `.local/bga-database/<玩家ID>/`，已被Git忽略：

| 路径 | 内容 |
|---|---|
| `manifest.json` | 清单、分页游标、来源元数据、每局状态、校验哈希与失败代码 |
| `history/page-*.json` | 历程接口每页原始JSON，含胜负和认输记录 |
| `replays/<桌号>.json.gz` | 一局的初始状态、游戏设置及完整事件包；gzip解压后是普通UTF-8 JSON |
| `crawl.lock` | 系统文件锁，避免同一目录多进程写入 |
| `STOP` | 请求停止；恢复前由调用者手动移除 |

回放文件格式为 `whitecastle-bga-raw-replay`，与观察查看器的 `whitecastle-bga-archive` 不同。原始库明确标记 `trainingEligible: false`：完整事件中有未来补牌、轮间骰子和撤销，不能直接作为当时策略的输入；还须动作重建、撤销归并和逐步引擎对账后才能转为训练样本。人数、扩展、起始资源池等不同配置先全部保存在原始库，再按兼容性筛选。

## 运行与恢复

Cookie文件只填写BGA请求标头中 `Cookie` 的值，也接受开头带 `Cookie:` 的单行。勿将Cookie贴进命令行参数或聊天。默认文件为 `.local/bga-cookie.txt`，必须存在且非空。

在仓库根目录执行，无需安装第三方包或构建项目：

```powershell
.\.local\ai-venv\Scripts\python.exe -u scripts/crawl-bga.py --player 98231251

# 查看最后一次落盘状态；pid存在也应结合进程是否仍运行判断。
.\.local\ai-venv\Scripts\python.exe scripts/crawl-bga.py --player 98231251 --status

# 请求停止，正在执行的HTTP请求可能要等待超时。
New-Item -ItemType File .local/bga-database/98231251/STOP -Force

# 继续同一资料库；已成功文件核对哈希后跳过。
Remove-Item -LiteralPath .local/bga-database/98231251/STOP
.\.local\ai-venv\Scripts\python.exe -u scripts/crawl-bga.py --player 98231251

# 显式重试此前失败的局；没有权限或已经过期的回放不会通过重试变得可用。
.\.local\ai-venv\Scripts\python.exe -u scripts/crawl-bga.py --player 98231251 --retry-failed
```

默认两个工作线程，共享每秒最多发起一次请求的限速器。网络错误及HTTP 429/5xx最多尝试三次，429按Retry-After退避；遇到登录失效或HTTP 401/403即停止。不绕过登录、会员要求、验证码或其他访问控制。BGA暂未生成的旧档案可按网站原有入口请求准备，轮询次数有上限，仍不可用则记录失败。

连续5局发生服务器5xx或网络失败后停止本轮，记录 `BGA_SERVICE_UNAVAILABLE_RETRY_LATER`。若HTTP 500正文是BGA“你已经达到上限（replay）”，立即记录 `BGA_REPLAY_LIMIT_RETRY_LATER` 并停止，不重试该请求、不保存正文。额度何时恢复由平台决定，程序不绕过限制。

首次批量采集已保存186局，随后31局记录HTTP 500、679局待下载。进一步检查确认服务器正文是回放上限提示；新增识别后可保留现有库，待平台恢复访问再用 `--retry-failed` 续抓。

`--workers 1..4`、`--interval`（最低0.5秒）、`--max-pages`、`--limit` 和 `--out-dir` 可配置。`--limit` 限制本次下载尝试局数，仍会先完成清单发现。请求超时默认40秒。清单将起抓时刻固定为结束时间上界，恢复时沿用，避免抓取途中新增对局改变分页；新增 `--refresh-history` 可重置分页时刻，在同库按桌号去重发现新结束的游戏，保留已保存文件。表中历史总场数是接口统计，不替代实际清单条数；发现结束以空页为准。

输入昵称或链接到训练模型的配套入口见 [BGA训练工作流](bga-training-workflow.md)。原始库与通过核对的选牌样本保持分离。

路径由脚本位置推导，无固定盘符或分支名；跨分支复制需要保留 `scripts/crawl-bga.py`，并在目标副本的 `.local/` 单独放置Cookie和资料库。爬虫不依赖AI的Torch环境；示例Python也可换成系统Python。

## 完整性与验证

解析时检查游戏、桌号、视角、事件所属桌号、唯一事件包ID、非空初始局面和终局状态99；缺少其中任一项的回放不算下载成功。文件先写临时路径后原子替换，恢复时核对SHA-256。服务器返回的原始事件包保留撤销标记、动作序号及时间。该校验只证明传输及基础结构完整，不证明每个规则动作已正确映射到本地引擎。

新版回放从 `bgaGameData` 读取游戏设置；旧版没有该字段时，另外核验游戏名、游戏编号及回放标记，并保留初始局面提供的玩家顺序。旧版未提供的 `tableOptions` 不猜测，记录于 `validation.missingConfigurationFields`；`frameFormat` 标明解析分支。两种格式都只读取 `completesetup` 的前8个参数，其中后续账号参数不保存。

实际在用户授权会话中获取的新样例：179个事件包、1,764条通知、52条带撤销标记的通知；最早的旧格式样例：502个事件包、2,006条通知、44条带撤销标记的通知。两者初始和终局均可解析。指定玩家历程分页结束后发现896个不同桌号，下载进度以本机清单为准。私人桌号与完整内容只存 `.local/`。离线检查：

```powershell
.\.local\ai-venv\Scripts\python.exe tests/bga_crawl_test.py
```

11项检查覆盖身份错配、缺终局、新旧格式、旧版配置缺失、新版非法配置拒绝回退、JSON字面量不执行代码、账号配置排除、域名边界、哈希损坏、凭据格式和分页停止。未编译或构建。推荐抽查解压后的初始卡牌、终局事件、认输标志和网页回放，再开展训练转换。
