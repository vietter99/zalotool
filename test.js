// Chạy: node test.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

let api;
const ctx = {
  __ZP_TEST__: (x) => { api = x; },
  console: { info() {}, log() {} },
  document: { body: null, addEventListener() {} },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: {},
  location: { href: 'https://chat.zalo.me/' },
  XMLHttpRequest: function () {},
  WebSocket: function () {},
  fetch() {},
  crypto: globalThis.crypto, TextEncoder, btoa, Uint8Array,
};
ctx.XMLHttpRequest.prototype = { open() {}, send() {} };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/Zalo privacy.js', 'utf8'), ctx);

const { HTTP_RULES, extractJson, isRecall, hashPin } = api;
const rule = (name) => HTTP_RULES.find((r) => r.name === name).re;
const yes = (name, ...paths) => paths.forEach((p) => assert(rule(name).test(p), `${name} phải khớp ${p}`));
const no = (name, ...paths) => paths.forEach((p) => assert(!rule(name).test(p), `${name} KHÔNG được khớp ${p}`));

yes('seen', '/api/message/seenv2', '/api/group/seenv2?x=1', '/api/subtab/seen');
no('seen', '/api/message/react_seen', '/api/message/sticker/search');
yes('typing', '/api/message/typing', '/api/group/typing');
yes('delivered', '/api/message/deliveredv2', '/api/group/deliveredv2');
no('delivered', '/api/group/react_delivered');
yes('react-seen', '/api/message/react_seen', '/api/group/react_delivered');
yes('presence', '/api/social/profile/ping');
no('presence', '/api/social/profile/lastOnline');
yes('actionlog', '/api/qos/uploadpc', '/api/qos/uploadpc/actionlog');
yes('tenor', '/api/message/sticker/tenor/mapping');
yes('sticker-ai', '/api/message/sticker/personalized/list', '/api/message/sticker/suggest/keywords');
no('sticker-ai', '/api/message/sticker/search', '/api/message/sticker/sticker_detail');

assert.strictEqual(JSON.stringify(extractJson('\x00\x01{"a":1}').d), '{"a":1}');
assert.strictEqual(extractJson('{"a":1}').s, '{"a":1}');
assert.strictEqual(extractJson('khong co json'), null);
assert.strictEqual(extractJson('{hong'), null);
assert.strictEqual(extractJson(null), null);

assert.strictEqual(isRecall(null), false);
assert.strictEqual(isRecall(extractJson('{"cmd":501,"data":{}}')), true);
assert.strictEqual(isRecall(extractJson('{"data":{"action":"undo"}}')), true);
assert.strictEqual(isRecall(extractJson('{"encrypt":2,"data":"x+undo+y/recall/z"}')), false);
assert.strictEqual(isRecall(extractJson('{"cmd":1,"data":"I cannot recall that, undo"}')), false);

(async () => {
  const salt = new Uint8Array(16).fill(7), salt2 = new Uint8Array(16).fill(8);
  const h = await hashPin('1234', salt);
  assert.strictEqual(h, await hashPin('1234', salt), 'cùng PIN + salt phải ra cùng hash');
  assert.notStrictEqual(h, await hashPin('1235', salt), 'khác PIN phải khác hash');
  assert.notStrictEqual(h, await hashPin('1234', salt2), 'khác salt phải khác hash');
  console.log('OK');
})();
