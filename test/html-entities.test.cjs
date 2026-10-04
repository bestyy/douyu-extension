// test/html-entities.test.cjs — HTML 字符引用解码（lib/html-entities.js）行为测试
//
// 运行：npm test（node --test）
// 覆盖：命名实体、十进制 / 十六进制数值实体、裸 `&` 与不完整引用保持原样、
// 非法码点不猜测、以及 Object.prototype 属性名不被误当实体。
// 零依赖 module，进程内直接 require，不需要装配 service worker 或 DOM。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { HtmlEntities } = require('../lib/html-entities.js');

test('decode：命名实体还原，大小写不敏感', () => {
  assert.equal(HtmlEntities.decode('国庆快乐&nbsp;'), '国庆快乐\u00a0');
  assert.equal(HtmlEntities.decode('a&amp;b'), 'a&b');
  assert.equal(HtmlEntities.decode('&lt;tag&gt;'), '<tag>');
  assert.equal(HtmlEntities.decode('&quot;q&quot;'), '"q"');
  assert.equal(HtmlEntities.decode('&AMP;'), '&');
});

test('decode：数值实体按十进制 / 十六进制还原', () => {
  assert.equal(HtmlEntities.decode('&#65;&#66;'), 'AB');
  assert.equal(HtmlEntities.decode('&#x4e2d;&#X6587;'), '中文');
  assert.equal(HtmlEntities.decode('&#160;'), '\u00a0');
});

test('decode：裸 & 与不完整引用保持原样（只认带分号的完整引用）', () => {
  assert.equal(HtmlEntities.decode('A & B'), 'A & B');
  assert.equal(HtmlEntities.decode('AT&T'), 'AT&T');
  assert.equal(HtmlEntities.decode('Tom &amp Jerry'), 'Tom &amp Jerry');
  assert.equal(HtmlEntities.decode('100% & up'), '100% & up');
});

test('decode：不认识的命名实体、非法码点保持原文，不做猜测', () => {
  assert.equal(HtmlEntities.decode('&unknown;'), '&unknown;');
  assert.equal(HtmlEntities.decode('&#0;'), '&#0;');
  assert.equal(HtmlEntities.decode('&#x110000;'), '&#x110000;');
  assert.equal(HtmlEntities.decode('&#xd800;'), '&#xd800;');
});

test('decode：Object.prototype 上的属性名不会被误当成实体', () => {
  assert.equal(HtmlEntities.decode('&constructor;'), '&constructor;');
  assert.equal(HtmlEntities.decode('&hasOwnProperty;'), '&hasOwnProperty;');
});

test('decode：null / undefined / 数字按空串与字符串处理', () => {
  assert.equal(HtmlEntities.decode(null), '');
  assert.equal(HtmlEntities.decode(undefined), '');
  assert.equal(HtmlEntities.decode(2026), '2026');
});

test('decode：已是纯文本时无副作用，且只解一层（&amp;nbsp; 不二次解码）', () => {
  assert.equal(HtmlEntities.decode('纯文本标题'), '纯文本标题');
  assert.equal(HtmlEntities.decode('&amp;nbsp;'), '&nbsp;');
});
