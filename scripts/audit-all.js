#!/usr/bin/env node
/**
 * 三包自审统一入口。
 *
 * 用 gatekit 审它自己与另两个包。判据：任何一包出现红（rc=1）即整体失败；
 * rc=2（没查到）单独报「不可判」，既不算通过也不算缺陷 —— 因为
 * 「扫了 0 个文件」和「扫了发现有毛病」是两件事，混在一档就等于把前者洗白。
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'gatekit', 'bin', 'cli.js');
const TARGETS = ['gatekit', 'agent-evidence', 'agent-arbiter'];

let bad = 0;
const rows = [];

for (const t of TARGETS) {
  if (!fs.existsSync(path.join(ROOT, t))) {
    rows.push({ t: t, red: '-', yellow: '-', rc: 'MISSING' });
    bad++;
    continue;
  }
  const r = spawnSync(process.execPath, [CLI, 'audit', t, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  let j = null;
  try { j = JSON.parse((r.stdout || '').trim()); } catch (e) { /* 下面按 NO_DATA 处理 */ }
  const red = j ? (j.red || []).length : null;
  const yellow = j ? (j.yellow || []).length : null;
  const unmeasured = j ? (j.unmeasured || []).length : null;
  const rc = j ? j.rc : 'NO_DATA';
  if (rc !== 0) bad++;
  rows.push({ t: t, red: red === null ? '?' : red, yellow: yellow === null ? '?' : yellow, un: unmeasured === null ? '?' : unmeasured, rc: rc });
}

const pad = function (s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); };
console.log('');
console.log(pad('对象', 18) + pad('红', 6) + pad('黄', 6) + pad('不可判', 8) + 'rc');
console.log('-'.repeat(48));
for (const r of rows) {
  console.log(pad(r.t, 18) + pad(r.red, 6) + pad(r.yellow, 6) + pad(r.un, 8) + r.rc);
}
console.log('');
if (bad) {
  console.error('[FAIL] ' + bad + ' 个对象未通过（红或不可判）');
  process.exit(1);
}
console.log('[PASS] 全部 ' + rows.length + ' 个对象 rc=0');
