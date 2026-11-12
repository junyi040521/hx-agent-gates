'use strict';
/**
 * demo · 三个真实场景（原型来自一个跑了 6,000 次自改的线上单体）
 *
 *   node demo/run.js
 *
 * 场景一：文件写对了，进程还是旧代码         → NOT_LOADED
 * 场景二：落了、加载了，但调用点是被注释掉的  → NOT_IN_USE
 * 场景三：账本三万多条，字段里没有产物        → NO_PRODUCT
 */

const path = require('path');
const fs = require('fs');
const { judge, report } = require('../src/judge');
const probes = require('../src/probes');

const D = __dirname;
const file = path.join(D, 'fixtures', 'chatEngine.js');
const caller = path.join(D, 'fixtures', 'main.js');
const ledger = path.join(D, 'fixtures', 'learn_heartbeat.jsonl');

const st = fs.statSync(file);

(async function () {
  console.log('\n════════ 场景一：文件写对了，进程没重启 ════════');
  console.log('  pm2 里那个进程的启动时刻比文件 mtime 早 4 小时 —— 线上跑的还是旧代码。');
  const r1 = await judge({
    claim: '缓存层已写入 chatEngine.js',
    checks: [
      probes.fileLanded({ file, since: st.mtimeMs - 1000 }),
      probes.processLoaded({ file, startedAt: st.mtimeMs - 4 * 3600e3 }),
    ],
  });
  process.stdout.write(report(r1));

  console.log('════════ 场景二：接线只存在于注释里 ════════');
  console.log('  调用点 grep 得到 1 处，实际是被 // 注释掉的那一行。');
  const r2 = await judge({
    claim: '缓存层已接入对话主链',
    checks: [
      probes.fileLanded({ file, since: st.mtimeMs - 1000 }),
      probes.processLoaded({ file, startedAt: st.mtimeMs + 60e3 }),
      probes.calledFrom({ symbol: 'cacheLayer', callers: [caller] }),
    ],
  });
  process.stdout.write(report(r2));

  console.log('════════ 场景三：三万多条账本，零条产物 ════════');
  console.log('  账本字段只有 ts / totalEntries / level —— 记的是心跳，不是产物。');
  const p3 = await probes.ledgerHasProduct({ file: ledger });
  const r3 = await judge({
    claim: '抽样吸取汇总已生效',
    checks: [
      probes.fileLanded({ file: ledger, since: st.mtimeMs - 1000 }),
      probes.processLoaded({ file: ledger, startedAt: st.mtimeMs + 60e3 }),
      p3,
    ],
  });
  process.stdout.write(report(r3));

  const ev = await p3.run();
  console.log('  账本行数 ' + ((ev.evidence && ev.evidence.lines) || 0) + ' · 含产物字段 ' + ((ev.evidence && ev.evidence.withProduct) || 0) + ' 行');
  console.log('  结论：这个数字不是 0，是**没有分母** —— 它连"该有几条"都无从定义。\n');
})();
