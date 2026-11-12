'use strict';
/**
 * CLI 形状测试。
 *
 * 为什么单独测命令行：CLI 是唯一「结论会被 CI 和人的手直接读走」的出口。
 * 它自己吞掉一个参数、或者把 cwd 当成目标，审计器再准也白搭 ——
 * 实测撞过一次：`audit <dir>` 的 dir 被静默丢掉，退回 cwd 审自己，
 * 输出 rc=2（NO_DATA），而 rc=2 很容易被人当成「通过了」。
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const { mk, cleanup } = require('./_util');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, cwd) {
  const r = spawnSync(process.execPath, [CLI].concat(args), {
    cwd: cwd || path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/* 一个最干净的可审对象：清单齐、签名对、有技能、有入口 */
function goodPkg() {
  return mk({
    'package.json': {
      name: 'demo-pkg',
      version: '1.2.3',
      license: 'MIT',
      main: 'src/index.js',
      engines: { node: '>=18' },
    },
    LICENSE: 'MIT License\n\nPermission is hereby granted...',
    'README.md': '# demo-pkg\n\n签名：demo-pkg v1.2.3\n',
    'src/index.js': 'module.exports = 1;\n',
    'SKILL.md': '---\nname: demo-pkg\nversion: 1.2.3\ndescription: 用这个来测试；当用户说「测试」时使用\n---\n\n# demo\n',
  }, 'demo-pkg');
}

test('位置参数被当作 root（不再静默丢弃）', () => {
  const root = goodPkg();
  const r = run(['audit', root]);
  assert.strictEqual(r.code, 0, r.out);
  /* 关键断言：审计的的确是那个目录，不是 cwd */
  assert.match(r.out, new RegExp(root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

test('--root 与位置参数同时给 ⇒ rc=2 并报错', () => {
  const root = goodPkg();
  const r = run(['audit', root, '--root', root]);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /只能用一个/);
});

test('多于一个位置参数 ⇒ rc=2 并报错', () => {
  const root = goodPkg();
  const r = run(['audit', root, root]);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /只接受一个目录/);
});

test('目录不存在 ⇒ rc=2，不许悄悄退回 cwd', () => {
  const r = run(['audit', path.join(__dirname, '__nope__', 'nowhere')]);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /目录不存在/);
});

test('不给参数 ⇒ 审 cwd，照常出 root 行', () => {
  const r = run(['audit']);
  assert.match(r.out, /root\s+/);
  assert.match(r.out, /ran\s+/);
  /* 不锁 rc：cwd 是什么状态不该由这条测试管，只要求它不崩、说清审的是哪 */
});

test('explain 列判据码并 rc=0', () => {
  const r = run(['explain']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /NO_MANIFEST/);
  assert.match(r.out, /条判据码/);
});

test('未知子命令 ⇒ rc=2 并给用法', () => {
  const r = run(['frobnicate']);
  assert.strictEqual(r.code, 2);
  assert.match(r.out, /usage:/);
});

test('--json 输出的 rc 字段与退出码一致', () => {
  const root = goodPkg();
  const r = run(['audit', root, '--json']);
  const j = JSON.parse(r.out);
  assert.strictEqual(j.rc, r.code);
  assert.ok(Array.isArray(j.red));
});

test('扫描根目录是文件夹本身时不会把自己当文件读', () => {
  /* 曾经的形态：路径里带空格/中文，path.resolve 之后 existsSync 仍然要认 */
  const root = mk({ 'package.json': { name: 'x', version: '0.0.1' } }, '包 名 带空格');
  assert.ok(fs.existsSync(root));
  const r = run(['audit', root]);
  assert.notStrictEqual(r.code, null, '不许因路径带空格直接崩');
  assert.doesNotMatch(r.out, /ENOENT/);
});

/* explain 的三种输入必须给出三种不同结果。
   曾经的形态：不管 `explain G6` 还是 `explain NO_SIG`，都打同一张全表 ——
   看着像回答了，其实参数被吞掉。这是「声明面 ≠ 实测面」的最小复现。 */
test('explain 不带参数：打出全表，且条数对得上', () => {
  const r = run(['explain']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /NO_SIG/);
  assert.match(r.out, /FUTURE_VERSION/);
  const m = r.out.match(/(\d+) 条判据码/);
  assert.ok(m, '要报总条数');
  assert.ok(Number(m[1]) >= 20, '判据码至少 20 条，实际 ' + m[1]);
});

test('explain NO_SIG：只回答这一条，不打全表', () => {
  const r = run(['explain', 'NO_SIG']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /NO_SIG/);
  assert.match(r.out, /版本签名/);
  assert.doesNotMatch(r.out, /FUTURE_VERSION/, '不许把别的判据也打出来');
  assert.doesNotMatch(r.out, /条判据码/, '不许退化成全表');
});

test('explain 小写也给认（判据码本身是大写）', () => {
  const r = run(['explain', 'no_sig']);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /NO_SIG/);
});

test('explain 问一个不存在的判据码：rc=2，且不假装回答', () => {
  const r = run(['explain', 'NOT_A_REAL_CODE']);
  assert.strictEqual(r.code, 2, 'rc 必须是 2，不能当成通过（0）');
  assert.match(r.out, /没有这个判据码/);
  assert.doesNotMatch(r.out, /FUTURE_VERSION/, '不许退回全表来糊过去');
});

test.after(cleanup);
