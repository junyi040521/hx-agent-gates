'use strict';
/**
 * selfgate 的反向证伪测试
 *
 * 这个文件测的不是「闸门能通过」，而是「闸门能被骗不了」：
 * 每道闸门注入一个对应缺陷，必须恰好在该道闸门转红；撤除后必须回到 0 红。
 *
 * 为什么要专门写这个：正向测试只能证明「好输入给绿」，而一个永远给绿的
 * 闸门与一个不判定的闸门，输出完全一样。只有注入坏样本才能区分它们。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { audit, GATES } = require('../src/selfgate');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'selfgate-'));
test.after(function () { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

/* ------------------------------------------------------------------ 夹具 */

function mk(name, files) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const rel of Object.keys(files)) {
    const fp = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, files[rel]);
  }
  return dir;
}

/** 最小可发布包：六道闸门应当全绿（G5 允许黄，因为它没有 judge.js） */
function baseFiles() {
  return {
    'package.json': JSON.stringify({
      name: 'fx', version: '1.0.0', main: 'src/index.js',
      files: ['src', 'README.md'], license: 'MIT',
    }, null, 2),
    'README.md': '# fx\n\n```bash\nnode ok.js\n```\n',
    'src/index.js': "'use strict';\nmodule.exports = { hi: 1 };\n",
    'test/a.test.js': [
      "'use strict';",
      "const assert = require('node:assert');",
      "assert.strictEqual(1, 1);",
      "assert.ok(!false);",
      '',
    ].join('\n'),
    'ok.js': 'process.exit(0);\n',
  };
}

function withFile(files, rel, content) {
  const o = Object.assign({}, files);
  o[rel] = content;
  return o;
}

function redGates(res) { return res.red.map(function (r) { return r.gate; }); }
function hasRed(res, gate) { return redGates(res).indexOf(gate) >= 0; }

/* -------------------------------------------------------------- 基线 */

test('无缺陷基数：rc=0 且零红', function () {
  const d = mk('clean', baseFiles());
  const res = audit(d, { fast: false });
  assert.strictEqual(res.rc, 0, '红：' + JSON.stringify(res.red));
  assert.strictEqual(res.red.length, 0);
  /* 用 GATES.length 而不是写死数字：写死的那一版加了 G7 之后假红了一次 */
  assert.strictEqual(res.ran.length, GATES.length, '所有闸门都该跑过');
  assert.ok(res.facts.coverage && res.facts.coverage.scanned > 0, 'G7 必须报出分母');
});

test('audit 是纯函数：不打印、不 exit', function () {
  const d = mk('pure', baseFiles());
  let captured = '';
  const oldOut = process.stdout.write;
  const oldLog = console.log;
  const oldErr = console.error;
  process.stdout.write = function (c) { captured += String(c); return true; };
  console.log = function () { captured += 'LOG'; };
  console.error = function () { captured += 'ERR'; };
  let res;
  try { res = audit(d, { fast: true }); } finally {
    process.stdout.write = oldOut; console.log = oldLog; console.error = oldErr;
  }
  assert.strictEqual(captured, '', '判定不许压在打印上：audit 期间不应有任何输出');
  assert.strictEqual(typeof res.rc, 'number', '判定必须是返回值');
});

test('扫描面为 0 ⇒ rc=2（按没查处理，不许当通过）', function () {
  const d = mk('empty', {});
  const res = audit(d);
  assert.strictEqual(res.rc, 2);
  assert.ok(/没查/.test(res.why), '必须说清是没查到东西，不是通过');
});

test('同一个包审两次，结论必须一致（无隐藏状态）', function () {
  const d = mk('twice', baseFiles());
  const a = audit(d, { fast: true });
  const b = audit(d, { fast: true });
  assert.strictEqual(a.rc, b.rc);
  assert.deepStrictEqual(redGates(a), redGates(b));
});

/* -------------------------------------------------- G1 注入：依赖两边都能漏 */

test('G1·声明了没用到 ⇒ 红（虚胖依赖）', function () {
  const d = mk('g1a', withFile(baseFiles(), 'package.json', JSON.stringify({
    name: 'fx', version: '1.0.0', main: 'src/index.js', files: ['src', 'README.md'],
    dependencies: { 'left-pad': '^1.0.0' },
  }, null, 2)));
  assert.ok(hasRed(audit(d, { fast: true }), 'G1'));
});

test('G1·用到了没声明 ⇒ 红（别人装不上）', function () {
  const d = mk('g1b', withFile(baseFiles(), 'src/index.js', "'use strict';\nconst x = require('left-pad');\nmodule.exports = { x };\n"));
  assert.ok(hasRed(audit(d, { fast: true }), 'G1'));
});

test('G1·注释里写 require 不算依赖（判据只看代码）', function () {
  const d = mk('g1c', withFile(baseFiles(), 'src/index.js',
    "'use strict';\n/* 用法：require('left-pad') */\n// 还有 require('lodash')\nmodule.exports = { hi: 1 };\n"));
  const res = audit(d, { fast: true });
  assert.ok(!hasRed(res, 'G1'), '注释被当成依赖 ⇒ 会把审计器自己判红：' + JSON.stringify(res.red));
});

/* ------------------------------------------------- G2 注入：残包与空壳 */

test('G2·files 声明了不存在的目录 ⇒ 红', function () {
  const d = mk('g2a', withFile(baseFiles(), 'package.json', JSON.stringify({
    name: 'fx', version: '1.0.0', main: 'src/index.js', files: ['src', 'dist'],
  }, null, 2)));
  assert.ok(hasRed(audit(d, { fast: true }), 'G2'));
});

test('G2·main 能 require 但导出空对象 ⇒ 红', function () {
  const d = mk('g2b', withFile(baseFiles(), 'src/index.js', "'use strict';\nmodule.exports = {};\n"));
  assert.ok(hasRed(audit(d, { fast: true }), 'G2'));
});

test('G2·main 一 require 就崩（语法过了不等于能加载）⇒ 红', function () {
  const d = mk('g2c', withFile(baseFiles(), 'src/index.js', "'use strict';\nmodule.exports = require('./not-here');\n"));
  assert.ok(hasRed(audit(d, { fast: true }), 'G2'));
});

/* --------------------------------------------- G3 注入：文档写在纸上的命令 */

test('G3·README 命令跑不通 ⇒ 红（文档必须能复现）', function () {
  const d = mk('g3a', withFile(baseFiles(), 'README.md', '# fx\n\n```bash\nnode nope.js\n```\n'));
  assert.ok(hasRed(audit(d), 'G3'));
});

test('G3·含 shell 管道的示例不实跑，但要记黄（不假装验过）', function () {
  const d = mk('g3b', withFile(baseFiles(), 'README.md', '# fx\n\n```bash\nnode ok.js | head -3\n```\n```bash\nnode ok.js\n```\n'));
  const res = audit(d);
  assert.ok(!hasRed(res, 'G3'));
  assert.ok(res.yellow.some(function (y) { return y.gate === 'G3' && /shell/.test(y.msg); }));
});

/* ------------------------------------------------------------- G4 注入 */

test('G4·测试文件里没有断言 ⇒ 红（跑过 ≠ 验过）', function () {
  const d = mk('g4a', withFile(baseFiles(), 'test/a.test.js', "require('node:test')('x', function () { });\n"));
  assert.ok(hasRed(audit(d, { fast: true }), 'G4'));
});

test('G4·只有正向断言 ⇒ 红（从未证明能抓假）', function () {
  const d = mk('g4b', withFile(baseFiles(), 'test/a.test.js',
    "const assert = require('node:assert');\nassert.strictEqual(1, 1);\nassert.ok(true);\n"));
  const res = audit(d, { fast: true });
  assert.ok(hasRed(res, 'G4'), '全正向断言必须判红');
});

/* ------------------------------------------------------------- G5 注入 */

test('G5·文档承诺了代码没有的理由码 ⇒ 红', function () {
  const files = withFile(baseFiles(), 'src/judge.js',
    "'use strict';\nconst REASONS = {\n  NO_DATA: 'NO_DATA',\n};\nmodule.exports = { REASONS };\n");
  files['README.md'] = '# fx\n\n```bash\nnode ok.js\n```\n\n`NO_DATA` 与 `FAKE_CODE_X`。\n';
  assert.ok(hasRed(audit(files && mk('g5a', files), { fast: true }), 'G5'));
});

test('G5·代码有码但 README 从不提 ⇒ 黄，不刷屏成红', function () {
  const files = withFile(baseFiles(), 'src/judge.js',
    "'use strict';\nconst REASONS = {\n  NO_DATA: 'NO_DATA',\n  NOT_CALLED: 'NOT_CALLED',\n};\nmodule.exports = { REASONS };\n");
  files['README.md'] = '# fx\n\n```bash\nnode ok.js\n```\n\n`NO_DATA`。\n';
  const res = audit(mk('g5b', files), { fast: true });
  assert.ok(!hasRed(res, 'G5'));
  const y = res.yellow.filter(function (x) { return x.gate === 'G5'; });
  assert.strictEqual(y.length, 1, '多个未提及的码聚合成一条，不按码刷屏');
  assert.ok(/NOT_CALLED/.test(y[0].msg));
});

/* ------------------------------------------------------------- G6 注入 */

test('G6·仪器在 src/ 里写盘且无豁免 ⇒ 红', function () {
  const d = mk('g6a', withFile(baseFiles(), 'src/leaky.js',
    "'use strict';\nconst fs = require('fs');\nmodule.exports = function () { fs.writeFileSync('x.txt', 'a'); };\n"));
  assert.ok(hasRed(audit(d, { fast: true }), 'G6'));
});

test('G6·标注了理由的写盘 ⇒ 只黄不红（豁免必须给理由）', function () {
  const d = mk('g6b', withFile(baseFiles(), 'src/sink.js',
    "'use strict';\nconst fs = require('fs');\n/* selfgate: write-ok 这个是日志下沉，调用方显式传路径 */\nmodule.exports = function (p) { fs.appendFileSync(p, 'a'); };\n"));
  const res = audit(d, { fast: true });
  assert.ok(!hasRed(res, 'G6'), JSON.stringify(res.red));
  assert.ok(res.yellow.some(function (y) { return y.gate === 'G6'; }), '豁免了也要留痕');
});

test('G2·bin 指向的文件不在 files 里 ⇒ 红（本机跑得通，装到别人机器上没这条命令）', function () {
  const d = mk('g2d', withFile(baseFiles(), 'package.json', JSON.stringify({
    name: 'fx', version: '1.0.0', main: 'src/index.js',
    bin: { fx: 'bin/cli.js' }, files: ['src', 'README.md'],
  }, null, 2)));
  fs.mkdirSync(path.join(d, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(d, 'bin', 'cli.js'), "'use strict';\n");
  assert.ok(hasRed(audit(d, { fast: true }), 'G2'));
});

/* ------------------------------------------------- 撤除后必须回到零红 */

test('撤除缺陷后必须回到 0 红（不是只有注入方向有效）', function () {
  const bad = mk('back', withFile(baseFiles(), 'src/index.js', "'use strict';\nmodule.exports = {};\n"));
  assert.ok(audit(bad, { fast: true }).red.length > 0);

  fs.writeFileSync(path.join(bad, 'src/index.js'), "'use strict';\nmodule.exports = { hi: 1 };\n");
  const after = audit(bad, { fast: true });
  assert.strictEqual(after.red.length, 0, '撤除缺陷后仍有红：' + JSON.stringify(after.red));
  assert.strictEqual(after.rc, 0);
});
