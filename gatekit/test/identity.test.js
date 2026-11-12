'use strict';
/**
 * identity 的反向证伪测试
 * 每条判据都有：干净基线 → 注入 → 恰好该码转红 → 撤除 → 归零
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { identity } = require('../src/identity');
const { mk, put, rm, hasCode, hasYellow, cleanup } = require('./_util');

test.after(cleanup);

function clean(extra, dirName) {
  return mk(Object.assign({
    'package.json': { name: 'fx', version: '1.2.3', description: 'd', license: 'MIT', engines: { node: '>=18' } },
    'LICENSE': 'MIT\n',
    'README.md': '# fx\n\n签名：gatekit v1.2.3\n',
  }, extra || {}), dirName || 'fx');
}

test('干净基线：0 红 0 黄', function () {
  const d = clean();
  const r = identity(d);
  assert.strictEqual(r.red.length, 0, JSON.stringify(r.red));
  assert.strictEqual(r.yellow.length, 0, JSON.stringify(r.yellow));
  assert.strictEqual(r.facts.version, '1.2.3');
});

test('找不到清单 ⇒ 红 + noData（按没查处理）', function () {
  const d = mk({ 'README.md': '# x\n' });
  const r = identity(d);
  assert.ok(hasCode(r, 'NO_MANIFEST'));
  assert.strictEqual(r.noData, true, '没查到东西必须是 noData，不许当通过');
});

test('version 不是 x.y.z ⇒ 红', function () {
  const d = clean({ 'package.json': { name: 'fx', version: '1.2', license: 'MIT' } });
  assert.ok(hasCode(identity(d), 'BAD_VERSION'));
});

test('签名行版本与清单不符 ⇒ 红（陈旧签名）', function () {
  const d = clean();
  put(d, { 'README.md': '# fx\n\n签名：gatekit v1.2.2\n' });
  const r = identity(d);
  assert.ok(hasCode(r, 'STALE_SIG'), JSON.stringify(r.red));
  rm(d, 'README.md');
  put(d, { 'README.md': '# fx\n' });
  /* 撤除后该码必须消失——只有注入方向有效的判据，撤除时不会归零 */
  assert.ok(!hasCode(identity(d), 'STALE_SIG'));
});

test('未来版本 ⇒ 红；历史旧版本不算错', function () {
  const d = clean({ 'CHANGELOG.md': '## v1.2.3\n\n## v1.2.2\n' });
  assert.ok(!hasCode(identity(d), 'FUTURE_VERSION'), '历史叙述里的旧版本是证据，不是缺陷');
  put(d, { 'CHANGELOG.md': '## v1.3.0 计划中\n' });
  assert.ok(hasCode(identity(d), 'FUTURE_VERSION'));
});

test('目录名 ≠ 包名 ⇒ 黄（不是红：内容没错，是两个视角的名字不同）', function () {
  const d = clean(null, 'not-the-name');
  const r = identity(d);
  assert.ok(hasYellow(r, 'DIR_NE_NAME'), JSON.stringify(r.yellow));
  assert.strictEqual(r.red.length, 0);
});

test('名称超上限 ⇒ 红；恰好等于上限 ⇒ 黄（没余量）', function () {
  const long = 'x'.repeat(215);
  const d = clean({ 'package.json': { name: long, version: '1.0.0' } }, long);
  assert.ok(hasCode(identity(d), 'NAME_TOO_LONG'));

  const edge = 'y'.repeat(214);
  const e = clean({ 'package.json': { name: edge, version: '1.0.0' } }, edge);
  assert.ok(hasYellow(identity(e), 'NAME_AT_LIMIT'));
});

test('名称含大写 ⇒ 红（npm 只允许小写）', function () {
  const d = clean({ 'package.json': { name: 'MyPkg', version: '1.0.0' } }, 'MyPkg');
  assert.ok(hasCode(identity(d), 'NAME_SHAPE'));
});

test('残留物 ⇒ 红（打包器排除 ≠ 包是干净的）', function () {
  const d = clean({ '__pycache__/a.pyc': 'x', '.DS_Store': 'x' });
  const r = identity(d);
  assert.ok(hasCode(r, 'RESIDUE'));
  assert.ok(r.facts.residue >= 2);
});

test('node_modules 与 .git 不参与残留扫描（不是包内容）', function () {
  const d = clean({ 'node_modules/x/a.log': 'x', '.git/a.log': 'x' });
  assert.strictEqual(identity(d).facts.residue, 0);
});

test('一处签名都没有 ⇒ 黄，并明说只能靠版本号一处', function () {
  const d = clean({ 'README.md': '# fx\n\n没有版本声明\n' });
  const r = identity(d);
  assert.ok(hasYellow(r, 'NO_SIG'));
});

test('依赖版本号不算签名（判据要认声明位，不能见版本号就判）', function () {
  const d = clean({ 'README.md': '# fx\n\n依赖 express@4.18.2 与 lodash 4.17.21\n\n签名：gatekit v1.2.3\n' });
  const r = identity(d);
  assert.ok(!hasCode(r, 'STALE_SIG'), '依赖版本不是包版本：' + JSON.stringify(r.red));
});

test('扫描面可见：报出查了几个文档', function () {
  const d = clean();
  assert.strictEqual(identity(d).facts.docFiles, 1, 'README.md 是唯一的文档');
});
