'use strict';
/**
 * run_all 的行为测试：三个审计器怎么合成一个结论
 *
 * 这一层的错法很具体：把「查了两个、跳过一个」显示成「全查了」，
 * 把「什么都没查到」显示成「全绿」。
 */

const test = require('node:test');
const assert = require('node:assert');
const { audit, AUDITORS } = require('../src/index');
const { mk, hasCode, cleanup } = require('./_util');

test.after(cleanup);

function cleanPkg(over) {
  return mk(Object.assign({
    'package.json': { name: 'fx', version: '1.0.0', license: 'MIT', engines: { node: '>=18' }, description: 'd' },
    'LICENSE': 'MIT\n',
    'README.md': '# fx\n\n签名：fx v1.0.0\n',
    'src/a.js': "'use strict';\nmodule.exports = 1;\n",
  }, over || {}), 'fx');
}

test('干净包 ⇒ rc=0，三个审计器都跑过', function () {
  const r = audit(cleanPkg());
  assert.strictEqual(r.rc, 0, JSON.stringify(r.red));
  assert.deepStrictEqual(r.ran, ['identity', 'manifest', 'runtime']);
  assert.strictEqual(r.noData, false);
});

test('有红 ⇒ rc=1（即使另有审计器没查到）', function () {
  const r = audit(cleanPkg({ 'README.md': '# fx\n\n签名：fx v1.0.1\n' }));
  assert.strictEqual(r.rc, 1);
  assert.ok(hasCode(r, 'STALE_SIG'));
});

test('全部没查到 ⇒ rc=2，且列出是哪几个（不许当通过）', function () {
  const d = mk({ 'README.md': '# nothing here\n' }, 'empty');
  const r = audit(d);
  assert.strictEqual(r.rc, 2, '什么都没查到不许 rc=0');
  assert.ok(r.noDataGates.length >= 2, JSON.stringify(r.noDataGates));
  assert.ok(r.unmeasured.length >= 2, '查不了的东西要单独列，不能混进红里');
  assert.strictEqual(r.red.length, 0, '没查到 ≠ 有缺陷');
});

test('只跑一个审计器时，不能假装另外两个也查过', function () {
  const r = audit(cleanPkg(), { only: ['manifest'] });
  assert.deepStrictEqual(r.ran, ['manifest']);
  assert.strictEqual(r.facts.identity, undefined);
  assert.strictEqual(r.facts.runtime, undefined);
});

test('审计器自身抛异常 ⇒ 记红，不许静默变绿', function () {
  const orig = AUDITORS[0][2];
  /* 不能改 AUDITORS 里那一项（它是模块级常量），所以换一种注入方式：
     给 identity 一个会抛的 opts —— 传一个 getter 会抛的对象 */
  const evil = {};
  /* enumerable 必须为 true：Object.assign 只读自有可枚举属性，默认 false 时 getter 根本不会被触发 */
  Object.defineProperty(evil, 'manifest', { enumerable: true, get: function () { throw new Error('boom'); } });
  const r = audit(cleanPkg(), { identity: evil });
  assert.ok(hasCode(r, 'AUDITOR_THREW'), JSON.stringify(r.red));
  assert.strictEqual(r.rc, 1);
  assert.strictEqual(AUDITORS[0][2], orig);
});

test('红里有 gate 字段：多个审计器同时红时能分清是谁', function () {
  const r = audit(cleanPkg({
    'README.md': '# fx\n\n签名：fx v9.9.9\n',
    'src/a.js': "'use strict';\nmodule.exports = require('ghost-dep');\n",
  }));
  const gates = r.red.map(function (x) { return x.gate; });
  assert.ok(gates.indexOf('identity') >= 0, JSON.stringify(gates));
  assert.ok(gates.indexOf('runtime') >= 0, JSON.stringify(gates));
});
