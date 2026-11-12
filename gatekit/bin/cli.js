#!/usr/bin/env node
'use strict';
/**
 * gatekit CLI
 *
 *   gatekit audit [<dir>] [--root <dir>] [--only identity,manifest,runtime] [--json]
 *   gatekit explain [<CODE>]           列出每条判据码的含义，或只问一条
 *
 * 退出码：0 全绿 ｜ 1 有红 ｜ 2 没查到东西（不许当通过）
 * 故意让「不是全绿」也非零 —— CI 里能直接拦。
 */

const path = require('path');
const { audit } = require('../src/index');

const CODES = {
  /* identity */
  NO_MANIFEST: '找不到清单 ⇒ 无法确定当前版本（按没查处理）',
  BAD_MANIFEST: '清单不是合法 JSON',
  BAD_VERSION: 'version 不是 x.y.z',
  NO_NAME: '缺 name',
  NAME_TOO_LONG: '名称超过平台上限（本地校验器查不到，上传才拒）',
  NAME_SHAPE: '名称含大写/空格/非法字符（npm 只允许小写字母数字 . _ -）',
  DIR_NE_NAME: '目录名 ≠ 包名：按目录找得到，按 name 找不到',
  STALE_SIG: '签名行声明的版本 ≠ 清单版本',
  FUTURE_VERSION: '出现比清单更高的同主版本号（不存在未来版本）',
  NO_SIG: '全包没有一处版本签名，没法验「发出去的是不是这一份」',
  RESIDUE: '残留物（__pycache__ / .pyc / .log / .tgz / .bak）',
  /* manifest */
  BAD_JSON: 'package.json 不是合法 JSON',
  DUP_KEY: '清单里同名键重复，后者静默覆盖前者',
  FIELD_TYPE: '字段类型不对（应为字符串）',
  BOOL_LITERAL: '布尔字段必须真布尔，"false" 会被整条丢弃',
  NO_VERSION: '缺 version',
  LICENSE_NO_TEXT: '声明了许可却包里没有全文',
  NO_SKILL: '找不到 SKILL.md',
  NO_FRONTMATTER: 'SKILL.md 没有 --- frontmatter',
  NO_DESCRIPTION: 'frontmatter 缺 description ⇒ 整条技能不进候选集',
  FIELD_IGNORED: '字段写了但宿主不解析',
  FIELD_TOO_LONG: '字段超过长度上限（超限截断往往截掉触发词）',
  BUDGET_OVER: '四段合计超预算（意图识别吃合计，不是单段）',
  NO_TRIGGER: 'description 里没有触发语，技能装着但选不中',
  /* runtime */
  NO_SCAN: '一个代码文件都没扫到 ⇒ 按没查处理',
  NO_ENGINES: '有代码却没有 engines.node：说不清要什么解释器',
  FLOOR_MISMATCH: '声明下限低于实测下限（用户跑到一半才炸）',
  SYNTAX: '--check 语法不过',
  CHECK_SAMPLED: '只对部分文件做了 --check',
  UNDECLARED: 'require 了没声明的包 ⇒ 换机器装不上',
  UNUSED_DEP: '声明了从未 require（虚胖依赖）',
  AUDITOR_THREW: '审计器自身抛异常（按红处理）',
};

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
  const cmd = argv[0] || 'audit';
  const a = parseArgs(argv.slice(1));

  if (cmd === 'explain') {
    const keys = Object.keys(CODES).sort();
    const want = a._[0];
    console.log('');
    /* 带判据码：只回答这一条。
       以前无论给什么参数都打全表 —— 「问了等于没问」，而 README 里写的是
       `explain G6`，声明与行为对不上。要么实现，要么别写。 */
    if (want !== undefined) {
      const code = String(want).toUpperCase();
      if (!CODES[code]) {
        console.error('没有这个判据码：' + want);
        console.error('列出全部：gatekit explain');
        process.exit(2);
      }
      console.log('  ' + code.padEnd(20) + CODES[code]);
      console.log('');
      process.exit(0);
    }
    for (const k of keys) console.log('  ' + k.padEnd(20) + CODES[k]);
    console.log('\n  ' + keys.length + ' 条判据码\n');
    process.exit(0);
  }

  if (cmd !== 'audit') {
    console.error('usage: gatekit audit [<dir>] [--root <dir>] [--only a,b] [--json]');
    console.error('       gatekit explain [<CODE>]');
    process.exit(2);
  }

  /* 位置参数当 root。以前静默丢弃：`audit <dir>` 不报错却审了 cwd，
     rc=2 很容易被当成「通过了」。宁可报错，不许猜。 */
  if (a.root && a._.length) {
    console.error('给多了：--root 与位置参数只能用一个（' + a._.join(' ') + '）');
    process.exit(2);
  }
  if (a._.length > 1) {
    console.error('只接受一个目录，收到 ' + a._.length + ' 个：' + a._.join(' '));
    process.exit(2);
  }
  const rootArg = a.root ? String(a.root) : (a._[0] || null);
  const root = path.resolve(rootArg || process.cwd());
  if (rootArg && !require('fs').existsSync(root)) {
    console.error('目录不存在：' + root);
    process.exit(2);
  }
  const res = audit(root, {
    only: a.only ? String(a.only).split(',') : null,
    fast: !!a.fast,
  });

  if (a.json) { console.log(JSON.stringify(res, null, 2)); process.exit(res.rc); }

  console.log('');
  console.log('  root   ' + root);
  console.log('  ran    ' + res.ran.join(' / '));
  console.log('  红 ' + res.red.length + ' ｜ 黄 ' + res.yellow.length + ' ｜ rc ' + res.rc);
  for (const r of res.red) console.log('  ✗ [' + r.gate + '] ' + r.code + '  ' + r.msg);
  for (const y of res.yellow) console.log('  ~ [' + y.gate + '] ' + y.code + '  ' + y.msg);
  for (const u of res.unmeasured) console.log('  ? [' + u.gate + '] ' + u.code + '  ' + u.msg + '  ← 未核验，不算缺陷也不算通过');
  if (res.noDataGates && res.noDataGates.length) console.log('  ! 没查到的审计器：' + res.noDataGates.join(',') + '（不许当通过）');
  console.log('');
  console.log('  ' + (res.rc === 0 ? 'PASS 可以发布' : res.rc === 2 ? 'NO_DATA 按没查处理' : 'FAIL 不许发布'));
  console.log('');
  process.exit(res.rc);
}

main();
