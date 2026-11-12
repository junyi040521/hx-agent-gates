#!/usr/bin/env node
'use strict';
/**
 * arbiter CLI
 *
 *   arbiter audit          审这个包自己（六道闸门）
 *   arbiter decide --json  读 stdin 的 {request, signals} 出一份决策
 *
 * 退出码：audit → 0 全绿 / 1 有红 / 2 没查；decide → 0 DECIDED / 1 DEFERRED
 * 故意让「DEFERRED」也非零：排队不是成功，CI 里应当看得见。
 */

const path = require('path');
const { arbiter } = require('../src/arbiter');
const selfgate = require('../src/selfgate');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) out[k] = true;
      else { out[k] = v; i++; }
    } else out._.push(a);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const a = parseArgs(argv.slice(1));

  if (cmd === 'audit') {
    const root = a.root ? path.resolve(String(a.root)) : path.resolve(__dirname, '..');
    const res = selfgate.audit(root, { fast: !!a.fast, only: a.only ? String(a.only).split(',') : null });
    if (a.json) { console.log(JSON.stringify(res, null, 2)); process.exit(res.rc); }
    console.log('');
    console.log('  root     ' + root);
    console.log('  ran      ' + res.ran.length + ' 道闸门 ｜ 红 ' + res.red.length + ' ｜ 黄 ' + res.yellow.length);
    for (const r of res.red) console.log('  ✗ ' + r.gate + '  ' + r.msg);
    for (const y of res.yellow) console.log('  ~ ' + y.gate + '  ' + y.msg);
    console.log('');
    console.log('  ' + (res.rc === 0 ? 'PASS 可以发布' : res.rc === 2 ? 'NO_DATA 按没查处理（不许当通过）' : 'FAIL 不许发布'));
    console.log('');
    process.exit(res.rc);
  }

  if (cmd === 'decide') {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function (c) { raw += c; });
    process.stdin.on('end', function () {
      let input;
      try { input = JSON.parse(raw); } catch (e) { console.error('decide: 需要从 stdin 读 JSON'); process.exit(2); }
      const inst = arbiter(input.config || {});
      const d = inst.decide({ request: input.request, signals: input.signals || {} });
      console.log(JSON.stringify(d, null, 2));
      process.exit(d.status === 'DECIDED' ? 0 : 1);
    });
    return;
  }

  console.error('usage: arbiter audit|decide   (see README)');
  process.exit(2);
}

main();
