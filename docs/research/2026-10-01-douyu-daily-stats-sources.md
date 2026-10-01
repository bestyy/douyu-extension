# 调研：斗鱼直播间「当天区间累计」数据（弹幕数/弹幕人数/礼物金额/礼物人数）的可替代接口

- 日期：2026-10-01
- 背景：本项目「今日统计」原依赖第三方数据站 doseeing（`GET https://www.doseeing.com/api/room_stat?room=<rid>&hours=today`）。
  该站已于 2026-09-30 全线停止服务。本文件核查是否存在其他接口能提供同等（或部分）数据。
- 后续：据此结论，「今日统计」已于 2026-10-01 整体下线（见 `docs/adr/0013-retire-today-stats.md`）。本文件作为当时的核查证据保留。
- 需求四项指标（当天 0 点起累计）：
  1. 弹幕数（chat pv）
  2. 弹幕人数（chat uv，去重）
  3. 礼物金额（**仅付费礼物**，单位元）
  4. 礼物人数（付费礼物去重人数）
- 相关既有决策：`docs/adr/0007-today-stats-polls-doseeing.md`。

## 结论（TL;DR）

**没有任何匿名、免费、无需登录的等价来源可以替代 doseeing。** 现有办法只有以下几类，全部有硬性限制：

1. **斗鱼官方公开接口**（本项目已在用的 `betard` 等）：只有**房间实时快照**（开播状态、热度、贵宾数、关注数、礼物目录），**没有任何「当天区间累计」的弹幕/礼物指标**。斗鱼公开排行榜只有**周榜**（主播收礼/涨粉、粉丝亲密度），不是当日逐房聚合。
2. **斗鱼开放平台 open.douyu.com**：API 目录里只有「房间信息（快照）/房间贵宾数/关注数/房间弹幕（实时拉取·推送）/礼物配置/直播录像」等，**没有弹幕数、礼物金额、收入等统计型接口**；且除目录页外均需注册开发者账号 + 申请 + token。
3. **斗鱼创作中心（mp.douyu.com，「主播数据中心」）**：**是唯一给出「每日弹幕数」「每日预计收益」的官方来源**，但仅限**主播本人登录**且需**权限开通**，看不到别人的房间，也不适合扩展匿名轮询。
4. **第三方数据站**：doseeing（在看直播）、头榜（toubang）均已停止服务；小葫芦（xiaohulu）域名已废弃（转卖/指向阿里云域名到期页）。其余（飞瓜、蝉妈妈等）是抖音/电商工具，不覆盖斗鱼房间当日弹幕/礼物。B 站的第三方统计站（matsuri.icu、laplace.live、奶绿live、弹幕库等）只覆盖 B 站。
5. **本地自算**（旁路方案）：斗鱼弹幕 WebSocket（`danmuproxy.douyu.com:850x`）匿名可连，能收到 `chatmsg`（弹幕）与礼物消息；理论上可在扩展内自己累计当天弹幕数/礼物。但需要**为每个在线房间全天候保持连接**（本项目现有架构只为少数盯守房间开长连接），且**无法回填扩展启动前的数据**，属于另一个量级的工程，不是「换个接口」。

因此建议：**要么接受该功能随 doseeing 一起下线/停用，要么改用本地自算（重构）**；不存在「把 URL 换一换就能继续用」的匿名免费接口。

---

## 一、doseeing 现状（复核）

doseeing 首页仍返回 200，但内容已是停服公告，且所有 API 404、房间页 302 回首页。

```bash
$ curl -s -o /dev/null -w "%{http_code}\n" https://www.doseeing.com/            # 200（是停服公告页）
$ curl -s -w "\nHTTP:%{http_code}\n" "https://www.doseeing.com/api/room_stat?room=9999&hours=today"
{"error":"Not found"}
HTTP:404
$ curl -s -w "\nHTTP:%{http_code}\n" "https://www.doseeing.com/api/room_stat?room=9999&hours=1"
{"error":"Not found"}
HTTP:404
$ curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://www.doseeing.com/room/9999"
302 https://www.doseeing.com/
```

首页 `<title>停止服务公告 - 在看直播</title>`，`<meta name="description" content="因业务调整，在看直播排行榜及相关服务的直播数据服务全线停止。">`。
（注：搜索引擎缓存里仍能看到旧排行的快照，属过期缓存，站点本身已停。）

结论：**doseeing 不可用，且无对外迁移/新域名公告**。

---

## 二、斗鱼官方来源（逐一实测）

### 2.1 公开接口：只有快照，没有当日聚合

| 接口 | 鉴权 | 能给的指标 | 与四项需求对比 | 实测 |
|---|---|---|---|---|
| `GET https://www.douyu.com/betard/{rid}` | 匿名 | 房间快照：开播状态、房间名、热度、封面、开播时间等 | **无**弹幕数/礼物金额等累计 | HTTP 200（本项目 `lib/douyu-api.js` 已在用） |
| `GET https://open.douyucdn.cn/api/RoomApi/room/{rid}` | 匿名 | 房间快照 `online`/`hn`、`fans_num`、**礼物目录**（`gift[]`，含单价 `pc`） | 只有礼物“目录”不是“收入”；无弹幕统计 | HTTP 200（下见响应片段） |
| `GET https://www.douyu.com/wgapi/live/liveweb/roomSecondaryInfo/user?rid=` | 匿名 | 房间 UI 开关配置 | 无关 | HTTP 200 |
| `GET https://www.douyu.com/wgapi/live/liveweb/roomapi/biz/getSwitch?rid=` | 匿名 | 房间弹幕/等级等开关 | 无关 | HTTP 200 |
| `GET https://www.douyu.com/home/api` | 匿名 | 全站在线房间数（聚合一个数） | 无逐房数据 | 已失效（返回 404 页） |

`open.douyucdn.cn` RoomApi 实测片段（HTTP 200）：

```json
{"error":0,"data":{"room_id":"9999","room_status":"1","start_time":"2026-10-01 00:26:55",
 "owner_name":"yyfyyf","online":3353840,"hn":3353840,"fans_num":"0",
 "gift":[{"id":"20006","name":"赞","type":"2","pc":0.1,"gx":1,...}, ...]}}
```

可见只到「当前在线/热度 + 礼物价目表」这一层，**没有「当天 0 点起累计」的任何一个数**。

### 2.2 斗鱼公开排行榜：是周榜，且维度不对

- 页面：`https://www.douyu.com/directory/rank_list/PCgame`（HTTP 200）
- 页面内嵌 `rankList` 数据形如 `rankList.userList.weekList[]`，文案为「主播榜……每周重置」「粉丝榜分为周亲密度榜和周新增数」。
- 即：**只有周榜**（网游竞技主播一周收礼 / 一周涨粉 / 用户周亲密度），既不是「当日」，也没有「逐房弹幕数/礼物金额」，更没有「弹幕人数/礼物人数」这种去重口径。

### 2.3 房间页（Next.js）逆向：没有任何礼物/弹幕聚合接口

把直播间页 `https://www.douyu.com/9999` 的 40 个 JS chunk 全量下载后 grep `japi/wgapi/gapi/lapi` 路径，得到的接口面只有：房间二屏信息、搜索、关注、弹幕配置、视频流、点播看点、贵族/钻粉等 UI 接口；**没有** 礼物榜、弹幕统计、当日聚合类接口。

房间页确实存在「聊友榜」（CSS 类名 `ChatDayRank` / `ChatRankWeek`，见 chunk `c34.js`），但那是**按日/周排名的发言用户 Top N**（榜上用户明细），不是「本房当天总弹幕数」，且数据未暴露成可直接调用的公开聚合接口。

> 复现探针产物：`E:\code\douyu-extensions\.scratch\research-probe\`（`.scratch` 已 gitignore，仅作一次性逆向留痕）。

### 2.4 斗鱼开放平台 open.douyu.com：无统计型 API，且需申请

`GET https://open.douyu.com/api/open/book/inx`（**目录页匿名可取，HTTP 200**）列出全部 API 目录：

- API接入说明（调用示例/返回格式/错误码/频率限制）
- API接口信息：token 获取、oauth 换 accessToken、刷新 accessToken、**直播视频流**、**房间信息**（指定房间 / 批量 / **获取房间贵宾数** / **获取房间关注数**）、分类信息、分类列表房间信息、点播视频、智能分类、**房间弹幕（拉取弹幕 / 接入弹幕）**、**TCP弹幕接入**、直播录像、**获取礼物配置**、发送站内信、用户信息、热度房间推荐
- 第三方插件

**目录里没有任何「弹幕数统计 / 礼物收益 / 收入 / 当日聚合」接口。** 最接近的只有：
- 房间信息 / 贵宾数 / 关注数 → 当前快照，非累计；
- 房间弹幕（拉取/接入）、TCP弹幕接入 → **实时弹幕流**，需要你自己边收边算，且需要开发者身份；
- 获取礼物配置 → 礼物价目表（不是收入）。

鉴权实测：文档详情接口需登录，`GET https://open.douyu.com/api/open/book/info?id=9` → `{"code":3,"msg":"请先登录后查看"}`。
实际调用需 **注册开发者账号 + 申请应用 + appid/aeskey/token**（目录中即列有 token 获取接口），匿名不可用、有频率限制。

### 2.5 斗鱼创作中心（主播数据中心）：有当日弹幕数/收益，但要主播登录

- 入口 `https://mp.douyu.com`，实测 **302 跳转 `https://passport.douyu.com/member/login?...`**（需登录）。
- 官方说明（`https://www.douyu.com/cms/detail/5980.shtml`）：创作中心「数据概览」含**每日弹幕数图**、**每日预计收益图**、弹幕总数、预计收益，可切「昨日 / 最近7日 / 14日 / 30日」；「昨日」按 15 分钟粒度。
- 官方另说明：需**主播身份且等级/权限开通**（未开通会跳回首页）。

**这是官方唯一给出的「每日弹幕数 + 收益」来源，但只覆盖主播本人的房间，且必须登录**，无法用于扩展对「任意在线斗鱼房间」的匿名轮询，且收益口径是平台「预计收益」（分成后），与本项目要的「付费礼物金额」也不完全一致。

### 2.6 斗鱼弹幕 WebSocket（旁路，可用于本地自算）

- 端点：`wss://danmuproxy.douyu.com:8501/`（8501–8505）
- 鉴权：**匿名可用**（随机 visitor 身份即可登录）；本项目 `lib/douyu-barrage.js` 已实现并用于贵宾数采样/弹幕检测。
- 可收到的消息：`chatmsg`（弹幕文本+发送者）、`oni`（贵宾数）、`gb`/`dgb`（礼物消息，匿名默认可能被屏蔽，需发 `dmfbdreq` 开启）、`ranklist`（**含日榜/周榜/总榜**，是**榜上用户的每日礼物值**而非本房礼物总额）。

**可行性**：技术上可自己累计当天弹幕数/弹幕人数（`chatmsg` 里有发送者 uid 可去重）、礼物金额/礼物人数（礼物消息 + `open.douyucdn` 礼物目录 `pc` 单价）。
**硬限制**：
- 需为**每个在线房间全天保持一条长连接**（本项目现架构只为少数盯守房间开长连接）；
- **无法回填**——扩展/浏览器启动之前的当天数据收不到，数字天然不完整；
- 礼物消息匿名能否稳定收到不确定（需开启指令实测），礼物去重口径要自己定义。

---

## 三、第三方来源（逐一核查）

| 站点/来源 | 状态 | 覆盖斗鱼房间当日四项？ | 证据 |
|---|---|---|---|
| doseeing（在看直播） | **已停服** | 曾提供，现全部 404 | `docs/adr/0007`；本次实测 404 + 停服公告页 |
| 头榜 toubang.tv | **已终止服务** | 曾覆盖斗鱼 | 知乎「头榜数据为什么终止服务了？」；`www.toubang.tv` DNS 可解析（47.102.112.225）但连接超时/失败 |
| 小葫芦 xiaohulu.com | **域名已废弃** | — | `www.xiaohulu.com` CNAME → `overdue.aliyun.com`（阿里云域名到期页）；`m.xiaohulu.com` 页面显示 "This Domain Is For Sale"。App/桌面助手仍在分发，但**公开数据站已不存在** |
| 飞瓜数据 feigua.cn | 在线（HTTP 200） | **否**（抖音/电商为主，不覆盖斗鱼房间当日弹幕/礼物） | 首页可达 |
| 蝉妈妈 chanmama.com | 在线（HTTP 200） | **否**（抖音电商） | 首页可达 |
| 知瓜数据 zhigua.cn | 不可达（DNS 000） | — | 连接失败 |
| 直播观察 zhiboguancha.com | 不可达（DNS 000） | — | 连接失败 |
| 波江数据 boijiang.com | 不可达（DNS 000） | 报道称只做「斗鱼平台活跃总量/平均热度/在线观众」，非逐房当日弹幕/礼物 | DoHuya 文章提及；域名实测不可达 |
| TikHub | 在线，**付费** | 仅抖音/TikTok（`WebcastChatMessage`/`WebcastGiftMessage`），无斗鱼 | tikhub.io |
| apispace | 在线，**付费** | 有「直播平台主播数据」类商品，未见斗鱼当日四项；需购买 | apispace.com |
| B 站第三方站（matsuri.icu / laplace.live / 奶绿live / 弹幕库） | 在线 | **否，只覆盖 B 站** | B 站专栏《基于B站...工具网站合集》 |
| 集简云 / 斗鱼集成 | 在线 | 只有「开播/新弹幕触发」等事件，无当日聚合 | jijyun.cn 斗鱼集成页 |

> 注：本轮核查当日 tavily 搜索接口一度 429，个别站点状态以 `curl` 实测为准；未实测到的付费站点以官网/文档描述为准。

---

## 四、MV3 service worker 适用性对照

| 来源 | 能否直接 `fetch`（加 host_permissions） | 依赖 cookie/页面上下文 | 适合 MV3 |
|---|---|---|---|
| doseeing 旧接口 | 曾被本项目直接 fetch | 否 | **已失效** |
| 斗鱼公开快照（betard / RoomApi） | 是 | 否 | 可用，但**无当日聚合数据** |
| 斗鱼开放平台 | 是（需带 token） | 否 | 需开发者申请+token，非匿名，**无统计接口** |
| 斗鱼创作中心 mp.douyu.com | 需登录态 cookie | 是（passport 登录） | 不适合（仅主播本人房间） |
| 斗鱼弹幕 WebSocket | sw 可用 WebSocket | 否（匿名 visitor） | **技术可行但需长连接常驻 + 无法回填** |
| 第三方统计站 | — | — | **无可用的匿名免费站** |

---

## 五、备选清单（需登录 / 需付费，技术上可行）

1. **本地自算（推荐如果一定要保留该功能）**：复用/扩展 `lib/douyu-barrage.js`，对在线斗鱼房间维持长连接，累计当天 `chatmsg`（去重得弹幕人数）与礼物消息（结合礼物目录算金额、去重得礼物人数）。代价：连接数与常驻开销大、当天数据从扩展启动才开始、需重新做纯规则模块与单测。**不是换 URL，是重构。**
2. **斗鱼创作中心 mp.douyu.com**：主播本人登录后可拿「每日弹幕数 + 预计收益」。仅自己的房间，且收益口径 = 预计收益（≠ 付费礼物金额），对扩展场景基本无用。
3. **斗鱼开放平台「房间弹幕 拉取/接入」**：申请开发者 app 后拉实时弹幕流自算；需审批 + token + 频率限制，工程与合规成本高。
4. **付费第三方数据 API**（apispace 等）：需购买，且**未证实覆盖斗鱼房间当日弹幕/礼物**，不建议在其上构建。

## 六、给出项目的建议

- **不要**再寻找「doseeing 的匿名免费平替」——已确认不存在。
- 短期：让「今日统计」随 doseeing 一起停用/下线（`settings.todayStatsEnabled` 默认关或直接移除 UI 行），并按 ADR-0007 的既定口径处理「唯一来源失效 = 该行不显示，不影响其它五条链路」。
- 中期若仍要该功能：把它当**新功能**立项（本地自算），先写 ADR 记录「数据来源从第三方整房统计改为本地长连接自算」这一取舍，再补规则模块与单测；同时明确「弹幕数从扩展启动时起算、绝对值与 doseeing 口径必然不同」。
- 无论哪条路，README 的隐私章节与 host_permissions 都要按最终选择更新（若移除 doseeing，则删掉 `https://www.doseeing.com/*`）。

---

### 附：本次实测命令索引（可复现）

```bash
# doseeing 停服复核
curl -s "https://www.doseeing.com/api/room_stat?room=9999&hours=today"   # 404 {"error":"Not found"}
curl -s "https://www.doseeing.com/" | head -c 300                        # 停服公告页

# 斗鱼公开快照（无当日聚合）
curl -s "https://www.douyu.com/betard/9999"                              # 200 房间快照
curl -s "https://open.douyucdn.cn/api/RoomApi/room/9999"                 # 200 快照+礼物目录

# 斗鱼开放平台目录（匿名），确认无统计接口
curl -s "https://open.douyu.com/api/open/book/inx"                       # 200 全量 API 目录
curl -s "https://open.douyu.com/api/open/book/info?id=9"                 # {"code":3,"msg":"请先登录后查看"}

# 主播数据中心需登录
curl -s -o /dev/null -w "%{url_effective}\n" -L "https://mp.douyu.com/" # → passport 登录页

# 公开排行榜是周榜
curl -s "https://www.douyu.com/directory/rank_list/PCgame" | grep -o '每周重置'
```
