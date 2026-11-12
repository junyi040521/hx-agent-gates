'use strict';
/**
 * app profile 的反向证伪测试
 *
 * 这个文件的每一条都对应一次在真仓库（绘心，4,553 个可扫文件）上量出来的
 * 假红 / 假绿，不是为了覆盖率凑数：
 *
 *   ① 没有 main 字段        → 应用靠 scripts.start 启动，判红是判据错
 *   ② 实加载入口            → require 一个 server.js 会真的把生产服务起起来
 *   ③ 动态 require          → `require(' + spec + ')` 被当成包名，5 条假红
 *   ④ test/fixtures 当测试  → 夹具没有断言是应该的，8 条假红
 *   ⑤ 内嵌自测看不见        → 371 个 require.main 自测，G4 报「没有测试」
 *   ⑥ 只扫 src/             → 951/4,553 = 20.9%，报告却像全仓结论
 *   ⑦ 跑文档命令            → 应用 README 里可能是 pm2 restart
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { audit } = require('../src/selfgate');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'selfgate-app-'));

test.after(function () {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

let seq = 0;
function mk(files) {
  const root = path.join(TMP, 'p' + (++seq));
  for (const rel of Object.keys(files)) {
    const fp = path.join(root, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, files[rel]);
  }
  return root;
}

const PKG_APP = JSON.stringify({
  name: 'app-fixture', version: '1.0.0',
  scripts: { start: 'node server.js' },
  dependencies: { dotenv: '^16.0.0' },
}, null, 2);

/** 一个「像绘心」的应用：无 main、有内嵌自测、有夹具、有写盘 */
function appFiles(extra) {
  const f = {
    'package.json': PKG_APP,
    'AGENTS.md': '# app\n\n```bash\nnode ok.js\n```\n',
    'server.js': "'use strict';\nconst dotenv = require('dotenv');\nmodule.exports = { boot: true };\n",
    'ok.js': 'process.exit(0);\n',
    'scripts/probe.cjs': "require('dotenv').config();\nmodule.exports = 1;\n",
    'data/x.json': '{}',
    'test/real.test.js': [
      "'use strict';",
      "const assert = require('node:assert');",
      "assert.strictEqual(1, 1);",
      "assert.ok(!false);",
      '',
    ].join('\n'),
    'test/fixtures/broken.js': "require('a-package-that-does-not-exist');\n",
  };
  return Object.assign(f, extra || {});
}

/* ---------------------------------------------- ① 无 main 不是缺陷 */

test('lib 模式：没有 main 判红（发布包必须能被 require）', function () {
  const d = mk({ 'package.json': PKG_APP, 'src/index.js': 'module.exports = {};\n', 'README.md': '# x\n' });
  const res = audit(d, { profile: 'lib', fast: true });
  assert.ok(res.red.some(function (r) { return r.gate === 'G2' && /main/.test(r.msg); }), JSON.stringify(res.red));
});

test('app 模式：没有 main 只黄，且报出真实入口', function () {
  const d = mk(appFiles());
  const res = audit(d, { profile: 'app', fast: true });
  assert.ok(!res.red.some(function (r) { return /没有 main 字段，require 包名会失败/.test(r.msg); }), '应用不该因缺 main 判红：' + JSON.stringify(res.red));
  assert.strictEqual(res.facts.files.entry, 'server.js', '要从 scripts.start 认出入口');
  assert.ok(res.yellow.some(function (r) { return /没有 main 字段/.test(r.msg); }));
});

test('app 模式：没有入口文件才判红', function () {
  const d = mk(appFiles({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }, null, 2) }));
  fs.unlinkSync(path.join(d, 'server.js'));
  const res = audit(d, { profile: 'app', fast: true });
  assert.ok(res.red.some(function (r) { return r.gate === 'G2' && /找不到入口/.test(r.msg); }), JSON.stringify(res.red));
});

/* ------------------------------------- ② 实加载入口 = 会启动生产服务 */

test('lib 模式：main 被真的 require（对照组，证明 app 的"不加载"不是"根本不加载"）', function () {
  const d = mk({
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', main: 'src/index.js', files: ['src'] }, null, 2),
    'README.md': '# x\n',
    'src/index.js': "require('fs').writeFileSync(require('path').join(__dirname, '..', 'LOADED.txt'), 'x');\nmodule.exports = { a: 1 };\n",
  });
  const res = audit(d, { profile: 'lib', fast: true, only: ['G2'] });
  assert.ok(fs.existsSync(path.join(d, 'LOADED.txt')), 'lib 模式应当实加载 main');
  assert.strictEqual(res.facts.files.exports.length, 1);
});

test('app 模式：绝不实加载入口——否则审计器一跑就把服务起了', function () {
  const d = mk(appFiles({
    'server.js': "'use strict';\nrequire('fs').writeFileSync('BOOTED.txt', 'x');\nmodule.exports = { boot: true };\n",
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G2'] });
  assert.ok(!fs.existsSync(path.join(d, 'BOOTED.txt')), '审计不许因为"想核验"而启动被审对象');
  assert.ok(res.yellow.some(function (r) { return /不实加载入口/.test(r.msg); }), '放弃核验必须出声');
});

/* ---------------------------------------------- ③ 动态 require */

test('动态 require 不判红，但要计数（原来会报「require 了 + spec +」）', function () {
  const d = mk(appFiles({
    'scripts/gen.cjs': "const spec = 'x';\nmodule.exports = require(' + spec + ');\n",
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G1'] });
  assert.ok(!res.red.some(function (r) { return /\+/.test(r.msg); }), '拼接不是包名：' + JSON.stringify(res.red));
  assert.ok(res.facts.deps.dynamicRequires >= 1, '动态 require 必须计数，不许悄悄放过');
  assert.ok(res.yellow.some(function (r) { return /动态 require/.test(r.msg); }));
});

test('app 模式：脚本里的依赖被扫到，不判虚胖（原来只看 src/ ⇒ 假红）', function () {
  const d = mk(appFiles());
  const res = audit(d, { profile: 'app', fast: true, only: ['G1'] });
  assert.ok(!res.red.some(function (r) { return /声明了 dotenv/.test(r.msg); }), 'dotenv 在 scripts/ 里用着：' + JSON.stringify(res.red));
});

test('lib 模式：同样的仓库会判 dotenv 虚胖（证明上面那条不是"永不判红"）', function () {
  const d = mk(appFiles({ 'src/keep.js': 'module.exports = 1;\n', 'README.md': '# x\n' }));
  const res = audit(d, { profile: 'lib', fast: true, only: ['G1'] });
  assert.ok(res.red.some(function (r) { return /声明了 dotenv/.test(r.msg); }), JSON.stringify(res.red));
});

/* ------------------------------------------- ④ 夹具不是测试 */

test('app 模式：test/fixtures 不算测试文件（夹具没有断言是应该的）', function () {
  const d = mk(appFiles());
  const res = audit(d, { profile: 'app', fast: true, only: ['G4'] });
  assert.ok(!res.red.some(function (r) { return /fixtures\/broken\.js/.test(r.msg); }), '夹具不是测试：' + JSON.stringify(res.red));
  assert.strictEqual(res.facts.tests.files, 1, '只该认 test/real.test.js');
});

test('app 模式：测试文件没有可失败出口才判红', function () {
  const d = mk(appFiles({ 'test/deco.test.js': "console.log('looks fine');\n" }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G4'] });
  assert.ok(res.red.some(function (r) { return /deco\.test\.js 是测试文件但没有任何可失败的出口/.test(r.msg); }), JSON.stringify(res.red));
});

test('app 模式：自研比较（无 assert 关键字）不算装饰', function () {
  const d = mk(appFiles({
    'test/smoke.js': [
      "'use strict';",
      'const CASES = [1, 2];',
      'let bad = 0;',
      'for (const c of CASES) if (c !== c) bad++;',
      'if (bad) process.exit(1);',
      'console.log(JSON.stringify({ bad }));',
      '',
    ].join('\n'),
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G4'] });
  assert.ok(!res.red.some(function (r) { return /smoke\.js 是测试文件/.test(r.msg); }), 'exit(1) 就是可失败出口：' + JSON.stringify(res.red));
});

/* ------------------------------------------ ⑤ 内嵌自测看不见 */

test('app 模式：内嵌自测被计数，且明说「没人会在 CI 里跑」', function () {
  const d = mk(appFiles({
    'src/core.js': "if (require.main === module) { process.exit(0); }\nmodule.exports = {};\n",
    'src/other.js': "if (require.main === module) { process.exit(0); }\nmodule.exports = {};\n",
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G4'] });
  assert.strictEqual(res.facts.tests.embeddedSelftests, 2);
  assert.ok(res.yellow.some(function (r) { return /内嵌自测/.test(r.msg); }), JSON.stringify(res.yellow));
});

test('一个 test 文件都没有、只有内嵌自测 ⇒ 判红（它们不会被自动跑）', function () {
  const d = mk({
    'package.json': PKG_APP,
    'AGENTS.md': '# x\n',
    'server.js': 'module.exports = 1;\n',
    'src/core.js': "if (require.main === module) { process.exit(0); }\nmodule.exports = {};\n",
  });
  const res = audit(d, { profile: 'app', fast: true, only: ['G4'] });
  assert.ok(res.red.some(function (r) { return /只有 1 个内嵌自测/.test(r.msg); }), JSON.stringify(res.red));
});

/* ------------------------------------------- ⑥ 分母必须可见 */

test('G7：扫 0 个文件 ⇒ rc=2，不许当通过', function () {
  const d = mk({ 'package.json': PKG_APP, 'AGENTS.md': '# x\n' });
  const res = audit(d, { profile: 'app', fast: true });
  assert.strictEqual(res.facts.coverage.scanned, 0);
  assert.strictEqual(res.rc, 2, '没查过 ≠ 通过');
});

test('G7：显式 scan 子集覆盖率低 ⇒ 黄，并写清"不代表全仓"', function () {
  const d = mk(appFiles());
  const res = audit(d, { profile: 'app', fast: true, only: ['G7'], scan: ['server.js'] });
  assert.strictEqual(res.facts.coverage.scanned, 1);
  assert.ok(res.facts.coverage.repo > 1);
  assert.ok(res.yellow.some(function (r) { return /指定的子集/.test(r.msg); }), JSON.stringify(res.yellow));
});

test('G7：app 模式全仓扫，分母与分子一致（不漏不看）', function () {
  const d = mk(appFiles());
  const res = audit(d, { profile: 'app', fast: true, only: ['G7'] });
  assert.strictEqual(res.facts.coverage.scanned, res.facts.coverage.repo);
  assert.strictEqual(res.facts.coverage.ratio, 1);
});

/* ---------------------------------------- ⑦ 文档命令不许乱跑 */

test('app 模式：不实跑文档命令（可能是重启/部署命令）', function () {
  const d = mk(appFiles({
    'AGENTS.md': '# app\n\n```bash\nnode boom.js\n```\n',
    'boom.js': "require('fs').writeFileSync('RAN.txt', 'x');\n",
  }));
  const res = audit(d, { profile: 'app', only: ['G3'] });
  assert.ok(!fs.existsSync(path.join(d, 'RAN.txt')), 'app 模式默认不许跑文档命令');
  assert.strictEqual(res.facts.docs.ran, false);
  assert.ok(res.yellow.some(function (r) { return /不实跑 .* 条文档命令/.test(r.msg); }), JSON.stringify(res.yellow));
});

test('显式 runDocs=true 才会跑（开关存在，但必须有人按）', function () {
  const d = mk(appFiles({
    'AGENTS.md': '# app\n\n```bash\nnode boom.js\n```\n',
    'boom.js': "require('fs').writeFileSync('RAN.txt', 'x');\n",
  }));
  const res = audit(d, { profile: 'app', only: ['G3'], runDocs: true });
  assert.ok(fs.existsSync(path.join(d, 'RAN.txt')), '显式开启后应当真跑');
  assert.strictEqual(res.facts.docs.ran, true);
});

/* ---------------------------------------------- ⑧ 写盘记账不判罪 */

test('app 模式：写盘不判红，但数量必须记账', function () {
  const d = mk(appFiles({
    'src/ledger.js': "const fs = require('fs');\nfunction w(p, s) { fs.appendFileSync(p, s); }\nmodule.exports = { w };\n",
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G6'] });
  assert.ok(!res.red.some(function (r) { return r.gate === 'G6'; }), JSON.stringify(res.red));
  assert.ok(res.facts.sideEffect.writes >= 1);
  assert.ok(res.yellow.some(function (r) { return /写盘/.test(r.msg); }));
});

test('lib 模式：判定库写盘仍判红（同一个判据，两种载体）', function () {
  const d = mk({
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', main: 'src/index.js', files: ['src'] }, null, 2),
    'README.md': '# x\n',
    'src/index.js': "const fs = require('fs');\nfs.writeFileSync('x.txt', 'y');\nmodule.exports = { a: 1 };\n",
  });
  const res = audit(d, { profile: 'lib', fast: true, only: ['G6'] });
  assert.ok(res.red.some(function (r) { return r.gate === 'G6'; }), JSON.stringify(res.red));
});

/* ------------------------ ⑨ 字符串里的示例代码不是依赖（第三次同型） */

test('字符串里的示例 require 不算依赖（真仓库上一次报 3 个假包）', function () {
  const d = mk(appFiles({
    'hx/tools/probe.cjs': [
      "'use strict';",
      "const eq = (a, b) => a === b;",
      /* 这两行就是绘心 hx/tools/hx_catch81.cjs 的真实形态 */
      'const t1 = eq(\'try { const x = require("a"); } catch (e) {}\', 1);',
      'const t2 = eq(\'try { require("y"); } catch (e) {}\', 1);',
      'module.exports = { t1, t2 };',
      '',
    ].join('\n'),
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G1'] });
  assert.ok(!res.red.some(function (r) { return /require 了 [axy]（/.test(r.msg); }), '字符串里的示例不是依赖：' + JSON.stringify(res.red));
});

test('但字符串外的真 require 仍要被抓到（防止上一条把整条判据关掉）', function () {
  const d = mk(appFiles({
    'hx/tools/real.cjs': "'use strict';\nconst x = require('some-undeclared-pkg');\nmodule.exports = x;\n",
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G1'] });
  assert.ok(res.red.some(function (r) { return /some-undeclared-pkg/.test(r.msg); }), JSON.stringify(res.red));
});

test('process.exit(failN ? 1 : 0) 算可失败出口（原来只认 process.exit(1)）', function () {
  const d = mk(appFiles({
    'test/tally.test.js': [
      "'use strict';",
      'const fails = [];',
      'if (fails.length) process.exit(fails.length ? 1 : 0);',
      '',
    ].join('\n'),
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G4'] });
  assert.ok(!res.red.some(function (r) { return /tally\.test\.js 是测试文件/.test(r.msg); }), JSON.stringify(res.red));
});

test('隐藏目录（备份/影子仓）不进扫描面', function () {
  const d = mk(appFiles({
    '.bak_archive/old.js': "require('ghost-pkg');\n",
    '.hxshadow/copy.js': "require('ghost-pkg-2');\n",
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G1'] });
  assert.ok(!res.red.some(function (r) { return /ghost-pkg/.test(r.msg); }), '备份副本不是活代码：' + JSON.stringify(res.red));
});

test('字符串里的 // 不能让后面整段词法失效（先删注释再词法，就会在这里错乱）', function () {
  const d = mk(appFiles({
    'hx/tools/quote.cjs': [
      "'use strict';",
      "const u = 'see a//b in the doc';",
      'const demo = \'try { require("ghost-pkg-z") } catch (e) {}\';',
      "const v = 'tail';",
      'module.exports = { u, demo, v };',
      '',
    ].join('\n'),
  }));
  const res = audit(d, { profile: 'app', fast: true, only: ['G1'] });
  assert.ok(!res.red.some(function (r) { return /ghost-pkg-z/.test(r.msg); }), '字符串里的 // 不许破坏后续词法：' + JSON.stringify(res.red));
});

/* ---------------------------------------------- ⑧ 载体必须自己判出来 */
/*
 * 这一组补的是本文件前 25 条自己留下的洞：它们**全都显式传了 profile**，
 * 于是「不传时会怎样」从来没被测过。实测不传时默认 lib，
 * 在绘心（真应用）上一次刷出 412 条假红——每个模块写日志、写账本都算罪。
 *
 * 教训：测试如果永远自己把前提喂进去，它测的就不是「这个工具能不能用」，
 * 而是「这个工具在被正确投喂时能不能用」。后者基本恒真，也因此基本无用。
 */

test('不传 profile：没有 main 的应用自动判成 app', function () {
  const res = audit(mk(appFiles()), { fast: true, only: ['G2'] });
  assert.strictEqual(res.facts.scan.profile, 'app');
});

test('不传 profile：有 main 且不 listen 的库自动判成 lib', function () {
  const d = mk({
    'package.json': JSON.stringify({ name: 'l', version: '1.0.0', main: 'src/index.js' }, null, 2),
    'src/index.js': 'module.exports = function () { return 1; };\n',
    'README.md': '# l\n',
  });
  const res = audit(d, { fast: true, only: ['G2'] });
  assert.strictEqual(res.facts.scan.profile, 'lib');
});

test('不传 profile：main 里 listen 的服务自动判成 app', function () {
  const d = mk({
    'package.json': JSON.stringify({ name: 's', version: '1.0.0', main: 'server.js' }, null, 2),
    'server.js': "'use strict';\nrequire('http').createServer(function () {}).listen(3200);\n",
    'README.md': '# s\n',
  });
  const res = audit(d, { fast: true, only: ['G2'] });
  assert.strictEqual(res.facts.scan.profile, 'app');
});

test('注释里的 listen 不算服务入口（不许被注释骗成 app）', function () {
  const d = mk({
    'package.json': JSON.stringify({ name: 'c', version: '1.0.0', main: 'lib.js' }, null, 2),
    'lib.js': '// 用法示例：server.listen(3000) 然后访问\nmodule.exports = 1;\n',
    'README.md': '# c\n',
  });
  const res = audit(d, { fast: true, only: ['G2'] });
  assert.strictEqual(res.facts.scan.profile, 'lib');
});

test('不传 profile：main 指向不存在 ⇒ 仍按 lib 判，让 G2 把残包报出来', function () {
  const d = mk({
    'package.json': JSON.stringify({ name: 'b', version: '1.0.0', main: 'dist/nope.js' }, null, 2),
    'src/index.js': 'module.exports = 1;\n',
    'README.md': '# b\n',
  });
  const res = audit(d, { fast: true, only: ['G2'] });
  assert.strictEqual(res.facts.scan.profile, 'lib');
  assert.ok(res.red.some(function (r) { return r.gate === 'G2' && /main/.test(r.msg); }), JSON.stringify(res.red));
});

test('同一份应用：自动判 app ⇒ 写盘不判红；强制 lib ⇒ 必须判红（反向证伪）', function () {
  const files = appFiles({
    'src/ledger.js': [
      "'use strict';",
      "const fs = require('fs');",
      'function append(l) { fs.appendFileSync("data/l.jsonl", l); }',
      'module.exports = { append };',
      '',
    ].join('\n'),
  });

  const auto = audit(mk(files), { fast: true, only: ['G6'] });
  assert.strictEqual(auto.facts.scan.profile, 'app', '没判成 app，这条测试就没有意义');
  assert.strictEqual(auto.red.filter(function (r) { return r.gate === 'G6'; }).length, 0,
    '应用写账本是主业，不许判红：' + JSON.stringify(auto.red));
  assert.ok(auto.yellow.some(function (y) { return y.gate === 'G6' && /app 模式/.test(y.msg); }),
    '不判红也不许不提：写盘数量必须记账');

  const forced = audit(mk(files), { profile: 'lib', fast: true, only: ['G6'] });
  assert.ok(forced.red.some(function (r) { return r.gate === 'G6'; }),
    '反向证伪：强制 lib 时必须判红，否则证明这条测试根本没在测 profile 分叉');
});
