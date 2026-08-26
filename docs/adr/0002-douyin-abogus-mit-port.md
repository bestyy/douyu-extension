# 抖音 a_bogus 签名：移植 MIT 实现，不用 AGPL 版本

`web/enter` 接口必须携带 `a_bogus` 签名（基于 SM3 + RC4 + 自定义 base64 的请求签名，缺失时返回 HTTP 200 空 body 风控）。MV3 Service Worker 无法 `eval` 任意 JS，故需把算法作为纯 JS 模块随扩展分发。候选开源实现中：`DouyinLiveWebFetcher/a_bogus.js` 为 **AGPL-3.0**（强传染，并入扩展会要求整个扩展以 AGPL 开源）；`DouyinLiveRecorder/src/ab_sign.py` 与 `douyinLiveGo/sign/ab_sign.go` 为 **MIT**（可自由并入，仅需保留版权声明）。

决定：从 MIT 实现的算法移植为纯 JS 模块 `lib/douyin-sign.js`，文件头注明算法来源与 MIT 许可与版权归属，不使用 AGPL 版本。算法是纯算术运算（SM3 散列、RC4 流密码、自定义 base64 编码），可逐字移植为无外部依赖的 JS，在 Service Worker 内同步计算。

## Considered Options

- 移植 MIT 实现（选用）：许可干净，保留版权声明即可；算法可完整纯 JS 移植。
- 使用 AGPL 的 `a_bogus.js`：现成 JS 代码，但 AGPL 传染性使整个扩展被迫开源，且代码为混淆压缩产物、难以审计。
- 在 content script / 页面上下文注入并执行签名脚本：绕开 MV3 限制，但引入页面桥接复杂度，且执行第三方混淆 JS 有安全与维护风险。

## Consequences

- 需为 `lib/douyin-sign.js` 准备已知输入/输出向量单测（移植正确性验证），来源为 MIT 项目自带测试或实测样本。
- 算法随抖音前端更新可能失效；协议变动时需回源更新移植，MIT 来源便于合法维护。
