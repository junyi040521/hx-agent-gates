'use strict';
/**
 * runtime 的反向证伪测试
 * 核心命题：`--check` 通过证明的是语法，不是环境。
 */

const test = require('node:test');
const assert = require('node:assert');
const { runtime, floorOf } = require('../src/runtime');
const { mk, put, rm, hasCode, hasYellow, cleanup } = require('./_util');

test.after(cleanup);

function pkg(engines, over) {
  return mk(Object.assign({
    'package.json': { name: 'fx', version: '1.0.0', engines: engines ? { node: engines } : undefined },
    'src/a.js': "'use strict';\nmodule.exports = 1;\n",
  }, over || {}), 'fx');
}

test('干净基线：声明 >=18 且无新语法 ⇒ 0 红', function () {
  const r = runtime(pkg('>=18'));
  assert.strictEqual(r.red.length, 0, JSON.stringify(r.red));
  assert.strictEqual(r.facts.engines, '>=18');
  assert.strictEqual(r.facts.checked, 1);
});

test('有代码却没有 engines ⇒ 红（说不清要什么解释器）', function () {
  const r = runtime(pkg(null));
  assert.ok(hasCode(r, 'NO_ENGINES'), JSON.stringify(r.red));
});

test('用了 ?. 而声明 >=12 ⇒ 红（本地 22 全绿，用户 12 上第一行就炸）', function () {
  const d = pkg('>=12', { 'src/a.js': "'use strict';\nconst x = { a: 1 };\nmodule.exports = x?.a;\n" });
  const r = runtime(d);
  assert.ok(hasCode(r, 'FLOOR_MISMATCH'), JSON.stringify(r.red));
  assert.ok(r.facts.syntaxFloor >= 14);
});

test('同样 ?. 声明 >=18 ⇒ 不红（下限够）', function () {
  const d = pkg('>=18', { 'src/a.js': "'use strict';\nconst x = {};\nmodule.exports = x?.a;\n" });
  assert.ok(!hasCode(runtime(d), 'FLOOR_MISMATCH'));
});

test('structuredClone 需要 17：声明 >=16 ⇒ 红', function () {
  const d = pkg('>=16', { 'src/a.js': "'use strict';\nmodule.exports = structuredClone({ a: 1 });\n" });
  const r = runtime(d);
  assert.ok(hasCode(r, 'FLOOR_MISMATCH'));
  assert.ok(r.facts.syntaxFloor >= 17);
});

test('注释与字符串里的新语法不算（否则每个库里的一句示例都会抬高下限）', function () {
  const d = pkg('>=12', {
    'src/a.js': "'use strict';\n// 示例：obj?.a 与 structuredClone(x)\nconst s = 'use Array.at(-1)';\nmodule.exports = s;\n",
  });
  const r = runtime(d);
  assert.ok(!hasCode(r, 'FLOOR_MISMATCH'), JSON.stringify(r.red));
});

test('require 未声明的包 ⇒ 红；声明未用 ⇒ 黄', function () {
  const d = pkg('>=18', { 'src/a.js': "'use strict';\nmodule.exports = require('left-pad');\n" });
  const r = runtime(d);
  assert.ok(hasCode(r, 'UNDECLARED'), JSON.stringify(r.red));

  const d2 = mk({
    'package.json': { name: 'fx', version: '1.0.0', engines: { node: '>=18' }, dependencies: { 'left-pad': '1.0.0' } },
    'src/a.js': "'use strict';\nmodule.exports = 1;\n",
  }, 'fx');
  assert.ok(hasYellow(runtime(d2), 'UNUSED_DEP'));
});

test('语法不过的文件 ⇒ 红（这个判据真跑了解释器，不是正则猜）', function () {
  const d = pkg('>=18', { 'src/bad.js': "'use strict';\nfunction f( { \n" });
  const r = runtime(d);
  assert.ok(hasCode(r, 'SYNTAX'), JSON.stringify(r.red));
  rm(d, 'src/bad.js');
  assert.ok(!hasCode(runtime(d), 'SYNTAX'), '撤除后必须归零');
});

test('扫 0 个代码文件 ⇒ noData（不是通过）', function () {
  const d = mk({ 'package.json': { name: 'fx', version: '1.0.0', engines: { node: '>=18' } } }, 'fx');
  const r = runtime(d);
  assert.strictEqual(r.noData, true);
  assert.ok(hasCode(r, 'NO_SCAN'));
});

test('扫描面可见：超过 maxCheck 会明说只查了一部分', function () {
  const files = { 'package.json': { name: 'fx', version: '1.0.0', engines: { node: '>=18' } } };
  for (let i = 0; i < 5; i++) files['src/f' + i + '.js'] = 'module.exports = 1;\n';
  const d = mk(files, 'fx');
  const r = runtime(d, { maxCheck: 2 });
  assert.strictEqual(r.facts.checked, 2);
  assert.ok(hasYellow(r, 'CHECK_SAMPLED'), '抽样必须出声');
});

test('floorOf 解析常见区间写法', function () {
  assert.strictEqual(floorOf('>=18'), 18);
  assert.strictEqual(floorOf('^16.14.0'), 16);
  assert.strictEqual(floorOf('>=14 <21'), 14);
  assert.strictEqual(floorOf('*'), null);
  assert.strictEqual(floorOf(''), null);
});
