#!/usr/bin/env node
/**
 * 三包测试统一入口。
 *
 * 为什么不用 `npm run test --workspaces`：
 *   ① 输出混在一起，分不清哪包挂了；
 *   ② npm 的 script 里写 glob（test/*.test.js），在 cmd.exe 下不会展开，
 *      在 sh 下会展开 —— 同一份 package.json 两种行为，属于"看环境给答案"；
 *   ③ 我们需要"某包 0 个用例"也必须算失败（扫 0 ≠ 通过）。
 *
 * 所以这里自己 spawn `node --test`（不带路径参数，让 Node 自己按默认规则发现
 * *.test.js）。实测 `node --test test/` 在 Node 22 上会把目录当模块解析直接
 * MODULE_NOT_FOUND，而无参形式三档都正常。
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ALL = ['agent-evidence', 'agent-arbiter', 'gatekit'];

const want = process.argv.slice(2).filter(function (x) { return !x.startsWith('-'); });
const pkgs = want.length ? want : ALL;

let bad = 0;
const rows = [];

for (const p of pkgs) {
  const dir = path.join(ROOT, p);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    rows.push({ pkg: p, tests: '-', pass: '-', fail: '-', rc: 'NO_PKG' });
    bad++;
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 180000 });
  const ms = Date.now() - t0;
  const out = (r.stdout || '') + (r.stderr || '');
  const num = function (k) {
    const m = out.match(new RegExp('^# ' + k + ' (\\d+)$', 'm'));
    return m ? Number(m[1]) : null;
  };
  const tests = num('tests');
  const pass = num('pass');
  const fail = num('fail');

  // 反放水：一个用例都没跑 = 没测，不许算通过
  const zero = (!tests || tests === 0);
  const rc = zero ? 'NO_DATA' : (r.status === 0 && fail === 0 ? 0 : 1);
  if (rc !== 0) bad++;
  rows.push({ pkg: p, tests: tests === null ? '?' : tests, pass: pass === null ? '?' : pass, fail: fail === null ? '?' : fail, rc: rc, ms: ms });
}

const pad = function (s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
console.log('');
console.log(pad('包', 18) + pad('用例', 8) + pad('通过', 8) + pad('失败', 8) + pad('耗时', 10) + '结果');
console.log('-'.repeat(60));
for (const r of rows) {
  console.log(pad(r.pkg, 18) + pad(r.tests, 8) + pad(r.pass, 8) + pad(r.fail, 8) + pad(r.ms ? (r.ms + 'ms') : '-', 10) +
    (r.rc === 0 ? 'PASS' : (r.rc === 'NO_DATA' ? 'NO_DATA（0 个用例不算通过）' : 'FAIL ' + r.rc)));
}
console.log('');
if (bad) {
  console.error('[FAIL] ' + bad + ' 个包没通过');
  process.exit(1);
}
console.log('[PASS] 全部 ' + rows.length + ' 个包通过');
