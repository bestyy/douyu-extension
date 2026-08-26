# 抖音房间标识统一为数字 web_rid；字母抖音号添加时解析

抖音直播间 URL 路径段 `web_rid` 有两种形态：数字 web_rid（多数房间，如 `516466932480`）与字母抖音号（自定义短号，如 `J1an9u9u`）。实测确认 `web/enter` 接口**只接受数字 web_rid**（字母抖音号请求返回 `status_code 10011` 参数错误或空数据）。因此所有进入 `rooms` 存储的抖音房间统一保存**数字 web_rid** 作为 `roomId`。

添加房间时：纯数字输入直接使用；粘贴字母抖音号（URL 或裸短号）时多做一步解析——跟随 `https://live.douyin.com/{handle}` 的 302 重定向到 `webcast.amemv.com/douyin/webcast/reflow/{room_id}?sec_user_id=...`，再调 `webcast.amemv.com/webcast/room/reflow/info/` 换取数字 web_rid。解析失败则报"房间号不存在或无法访问"，不落库。

## Considered Options

- 只接受数字 web_rid，字母抖音号报错（更简单，但抖音号链接是常见分享形式，会拒绝大量有效输入）。
- 字母抖音号直接入库、轮询时再解析（轮询路径引入重定向与二次请求，且每轮多一次页面级请求会加重限流；添加时一次性解析更干净）。

## Consequences

- `manifest.json` 需新增 `https://webcast.amemv.com/*` host_permissions。
- 解析只在添加房间时发生（一次性），轮询始终只请求 `web/enter` 一个接口。
- 字母抖音号若未开播过（无 reflow 重定向）可能解析失败，用户需改用数字 web_rid。
