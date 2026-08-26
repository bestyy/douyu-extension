# 接入抖音平台，使用 web/enter 匿名轮询

抖音加入本扩展的监控平台（轮询开播状态 + 开播通知 + 列表跳转，暂不做观众数功能）。经实测与研究确认，选用 `GET https://live.douyin.com/webcast/room/web/enter/` 作为主查询接口：匿名可用（无需登录），`data.data[0].status` 2=直播中 / 4=已关播，字段与现有轮询模型对齐（标题/昵称/封面）。

选它而非备选方案的原因：`webcast/room/info/` 实测 404 不存在；`webcast.amemv.com/webcast/room/reflow/info/` 匿名可用但只对直播中房间返回数据（已关播返回 `10033`），无法作为通用状态源；HTML 抓取 `roomStore.roomInfo` 可行但页面端点限流明显（快速轮询实测 503），且 RSC 格式易变。

代价与约束：接口需要 `a_bogus` 签名（无签名返回 HTTP 200 空 body 风控）与 `ttwid` cookie（首次从 `live.douyin.com/` 获取后缓存）。签名算法移植自 MIT 许可开源实现（见 ADR-0002），在 MV3 Service Worker 内以纯 JS 计算，不使用 `eval`。房间标识统一为数字 `web_rid`（字母抖音号在添加时解析，见 ADR-0003）。无官方批量接口，按房间逐一请求，60 秒轮询节奏在实测限流范围内。

## Considered Options

- `webcast/room/web/enter/`（选用）：匿名可用、返回直播/关播双状态、字段完整；需 a_bogus + ttwid。
- `webcast/room/info/`：社区常见提及，实测 404，不可用。
- `webcast.amemv.com/webcast/room/reflow/info/`：免签名免 cookie，但仅直播中房间返回数据（关播返回 10033），只能作直播确认与 web_rid 解析的辅助。
- HTML 抓取 `roomStore.roomInfo`：双状态可用，但页面端点限流严重（快速轮询实测 503），RSC 格式易变，仅作兜底。

## Consequences

- `manifest.json` 需新增 `https://live.douyin.com/*` 与 `https://www.douyin.com/*` 的 host_permissions（以及字母抖音号解析所需的 `https://webcast.amemv.com/*`，见 ADR-0003）。
- 轮询间隔沿用用户设置（默认 60s），每房间每轮一个请求；协议变动频繁，需保留退避/重试与 ttwid 刷新策略并持续关注。
