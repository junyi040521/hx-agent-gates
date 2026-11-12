#!/usr/bin/env node
'use strict';
/**
 * evidence CLI
 *
 *   evidence check --file src/x.js --since 2026-11-12T04:00:00Z \
 *                  --pid 1234 --symbol cacheLayer --caller src/main.js \
 *                  --ledger data/calls.jsonl
 *
 *   evidence ledger --file data/learn.jsonl      # 账本里到底有没有产物
 *
 * 退出码：0 = WORKING；1 = 其它结论；2 = 用法错误
 * 故意让「不是 WORKING」也返回非零 —— CI 里能直接拦。
 */

const fs = require('fs');
const path = require('path');
const { judge, report } = require('../src/judge');
const probes = require('../src/probes');
const selfgate = require('../src/selfgate');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { out[k] = true; }
      else { out[k] = v; i++; }
    } else out._.push(a);
  }
  return out;
}

/** 进程真实启动时刻（Linux）：boot 时刻 + /proc/<pid>/stat 的 starttime 抖动数 */
function procStartMs(pid) {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const btime = Number((stat.match(/^btime (\d+)$/m) || [])[1]) * 1000;
    const p = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    const fields = p.slice(p.lastIndexOf(')') + 2).split(' ');
    const starttime = Number(fields[19]); /* 第22字段，去掉 pid+comm 后索引 19 */
    const hz = 100; /* 常规 USER_HZ；精度对本用途足够 */
    return btime + (starttime / hz) * 1000;
  } catch (e) { return 0; }
}

function toMs(v) {
  if (v === undefined || v === true) return 0;
  const n = Number(v);
  if (!Number.isNaN(n) && String(v).trim() !== '') return n >= 1e12 ? n : n * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1));

  if (cmd === 'ledger') {
    if (!a.file) { console.error('usage: evidence ledger --file <jsonl>'); process.exit(2); }
    const p = probes.ledgerHasProduct({ file: a.file, fields: a.fields ? String(a.fields).split(',') : undefined });
    const r = await p.run();
    console.log('');
    console.log('  ledger   ' + a.file);
    console.log('  lines    ' + ((r.evidence && r.evidence.lines) || 0));
    console.log('  product  ' + ((r.evidence && r.evidence.withProduct) || 0));
    console.log('  verdict  ' + (r.ok === true ? 'HAS_PRODUCT' : r.ok === false ? (r.reason || 'NO_PRODUCT') : 'NO_DATA'));
    console.log('');
    process.exit(r.ok === true ? 0 : 1);
  }

  if (cmd === 'audit') {
    /* 自证闸门：审这个包自己。判定来自 selfgate.audit() 的返回值，不来自下面的打印。 */
    const root = a.root ? path.resolve(String(a.root)) : path.resolve(__dirname, '..');
    const res = selfgate.audit(root, { fast: !!a.fast, only: a.only ? String(a.only).split(',') : null });
    if (a.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log('');
      console.log('  root     ' + root);
      console.log('  ran      ' + res.ran.length + ' 道闸门 ｜ 红 ' + res.red.length + ' ｜ 黄 ' + res.yellow.length);
      for (const r of res.red) console.log('  ✗ ' + r.gate + '  ' + r.msg);
      for (const y of res.yellow) console.log('  ~ ' + y.gate + '  ' + y.msg);
      console.log('');
      console.log('  ' + (res.rc === 0 ? 'PASS 可以发布' : res.rc === 2 ? 'NO_DATA 按没查处理（不许当通过）' : 'FAIL 不许发布'));
      console.log('');
    }
    process.exit(res.rc);
  }

  if (cmd !== 'check') {
    console.error('usage: evidence check|ledger|audit [options]   (see README)');
    process.exit(2);
  }

  const checks = [];
  if (a.file) checks.push(probes.fileLanded({ file: a.file, since: toMs(a.since), expectSha: a.sha }));
  if (a.file && (a.pid || a['pid-start'])) {
    const startedAt = a['pid-start'] ? toMs(a['pid-start']) : procStartMs(a.pid);
    checks.push(probes.processLoaded({ file: a.file, startedAt }));
  }
  if (a.symbol) {
    checks.push(probes.calledFrom({
      symbol: a.symbol,
      callers: a.caller ? [].concat(a.caller) : [],
      ledger: a.ledger,
    }));
  }

  if (!checks.length) { console.error('nothing to check: pass --file / --pid / --symbol'); process.exit(2); }

  const r = await judge({ claim: a.claim || (a.file || a.symbol || ''), checks });
  if (a.json) console.log(JSON.stringify(r, null, 2));
  else process.stdout.write(report(r));
  process.exit(r.verdict === 'WORKING' ? 0 : 1);
}

main().catch(function (e) { console.error('evidence: ' + (e && e.message || e)); process.exit(2); });
