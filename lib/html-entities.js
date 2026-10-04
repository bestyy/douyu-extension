// lib/html-entities.js — HTML 字符引用解码：把平台返回的 HTML 编码文本还原成纯文本
//
// 平台的标题、昵称、分类等字段在平台上按 HTML 渲染，接口原样吐出编码后的文本
// （实测斗鱼房间标题会带 `&nbsp;`）。扩展用 textContent / escapeHtml 渲染，
// 不还原就会把 `&nbsp;`、`&amp;` 当字面量显示出来。API 层收敛字段时用本 module
// 还原，存储与界面都只面对纯文本。
//
// 零依赖、纯字符串处理：Service Worker 里没有 DOMParser / document，不能借浏览器解码。
// UMD 双兼容：SW 的 importScripts 下是全局 `HtmlEntities`，node 下可 require 取到同一个对象。
// 只认带 `;` 的完整字符引用（`A & B`、`AT&T` 这类裸 `&` 保持原样），不识别的一律保留原文。

const HtmlEntities = (() => {
  // 命名字符引用表（平台文本实际会用到的那一批；未收录的保持原文，不做猜测）
  const NAMED = Object.freeze({
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    copy: '\u00a9',
    reg: '\u00ae',
    trade: '\u2122',
    hellip: '\u2026',
    mdash: '\u2014',
    ndash: '\u2013',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    middot: '\u00b7',
    bull: '\u2022',
    times: '\u00d7',
    divide: '\u00f7',
    deg: '\u00b0',
    plusmn: '\u00b1',
    laquo: '\u00ab',
    raquo: '\u00bb',
    sect: '\u00a7',
    para: '\u00b6',
    euro: '\u20ac',
    pound: '\u00a3',
    yen: '\u00a5',
    cent: '\u00a2'
  });

  // 十进制 `&#123;`、十六进制 `&#x1F;`、命名 `&amp;`；必须带结尾分号
  const PATTERN = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

  /** 解码一段平台文本。null / undefined 视为空串；非法数值码点保持原文 */
  function decode(value) {
    return String(value ?? '').replace(PATTERN, (match, body) => {
      if (body.charAt(0) !== '#') {
        const key = body.toLowerCase();
        // hasOwnProperty 兜底：避免 `&constructor;` 这类命中 Object.prototype 上的属性
        if (!Object.prototype.hasOwnProperty.call(NAMED, key)) {
          return match;
        }
        return NAMED[key];
      }

      const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      // 非法码点（0、代理区、超出 Unicode 上界）保持原文，不猜测
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return match;
      }
      return String.fromCodePoint(code);
    });
  }

  return Object.freeze({ decode });
})();

// UMD 双兼容：SW 的 importScripts 与页面 <script> 下 module 未定义自动跳过；node 下可 require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HtmlEntities };
}
