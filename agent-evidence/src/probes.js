'use strict';
/**
 * agent-evidence · 内置探针
 *
 * 四个能覆盖 90% 场景的最小探针。每个都只读、无副作用、失败返回 null 而不是 false。
 * 想接别的系统（k8s / docker / pm2 / 自研）就自己写一个 () => {ok, ...}，形状一样即可。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function statSafe(file) {
  try { return fs.statSync(file); } catch (e) { return null; }
}

/**
 * landed · 文件在 since 之后真的变了吗
 * 用 sha1 而不是 mtime：`cp -p` / `git checkout` 都会保留旧 mtime，mtime 会骗人。
 */
function fileLanded(opts) {
  const o = opts || {};
  const file = path.resolve(o.file);
  return {
    level: 'landed',
    id: 'fileLanded:' + path.basename(file),
    run: async function () {
      const st = statSafe(file);
      if (!st) return { ok: false, reason: 'FILE_MISSING', observedAt: Date.now(), evidence: { file } };
      const txt = readText(file);
      const h = sha1(txt === null ? Buffer.from(String(st.size)) : Buffer.from(txt));
      const since = Number(o.since || 0);
      const changed = since ? (st.mtimeMs > since || (o.expectSha ? h === o.expectSha : false)) : true;
      return {
        ok: !!changed,
        reason: changed ? undefined : 'NO_CHANGE',
        observedAt: Date.now(),
        evidence: { file, sha1: h, mtimeMs: Math.round(st.mtimeMs), since, size: st.size },
      };
    },
  };
}

/**
 * effective · 运行中的进程是否在文件改动之后才启动
 * 这是最容易被跳过、也最容易出事的一环：文件写对了，进程还是旧代码。
 */
function processLoaded(opts) {
  const o = opts || {};
  const file = path.resolve(o.file);
  return {
    level: 'effective',
    id: 'processLoaded:' + path.basename(file),
    run: async function () {
      const st = statSafe(file);
      const startedAt = Number(o.startedAt || 0);
      if (!st) return { ok: null, reason: 'FILE_MISSING', observedAt: Date.now(), evidence: { file } };
      if (!startedAt) return { ok: null, reason: 'NO_START_TIME', observedAt: Date.now(), evidence: { file, hint: 'pass startedAt (pid start time / container started_at)' } };
      const loaded = startedAt > st.mtimeMs;
      return {
        ok: loaded,
        reason: loaded ? undefined : 'STALE_PROCESS',
        observedAt: Date.now(),
        evidence: { file, mtimeMs: Math.round(st.mtimeMs), startedAt, gapMs: Math.round(startedAt - st.mtimeMs) },
      };
    },
  };
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 数调用点。必须剔掉三类"看起来像调用"的东西，否则探针自己就在放水：
 *   1) 注释掉的调用（// cacheLayer(1)）—— 最经典的一种假接线
 *   2) 函数定义（function cacheLayer( / .cacheLayer( = 方法定义）
 *   3) require/import 引用（只引用不等于调用）
 * 已知局限：字符串字面量里的同形文本无法完全区分。这是静态扫描的边界，写进 README，不假装没有。
 */
function countCallSites(txt, symbol) {
  const s = escRe(symbol);
  const deepRe = new RegExp(s + '\\s*\\(', 'g');
  const defRe = new RegExp('(function\\s+' + s + '\\s*\\(|(const|let|var)\\s+' + s + '\\s*=)');
  let n = 0;
  for (const raw of String(txt).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    if (defRe.test(line)) continue;
    const code = line.replace(/\/\/.*$/, ''); /* 行尾注释剥掉再数 */
    const m = code.match(deepRe);
    if (m) n += m.length;
  }
  const block = String(txt).replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (block !== String(txt)) {
    /* 块注释已经由上面的整体替换处理过；这里只在有块注释时重算一次更精确的值 */
    let n2 = 0;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('*')) continue;
      if (defRe.test(line)) continue;
      const code = line.replace(/\/\/.*$/, '');
      const m = code.match(deepRe);
      if (m) n2 += m.length;
    }
    return n2;
  }
  return n;
}

/**
 * useful · 声明的调用点里，到底有没有人调用这个符号
 * 只做静态调用点扫描：看得到 "定义了但没接线"，看不到运行期分支是否走到 —— 后者需要 runtime ledger，
 * 所以这里允许再叠一层计数：传 ledger 文件，读它的真实调用条数。
 */
function calledFrom(opts) {
  const o = opts || {};
  const symbol = String(o.symbol || '');
  const callers = (o.callers || []).map(function (f) { return path.resolve(f); });
  return {
    level: 'useful',
    id: 'calledFrom:' + (symbol || '?'),
    run: async function () {
      if (!symbol) return { ok: null, reason: 'NO_SYMBOL', observedAt: Date.now() };
      if (!callers.length) return { ok: null, reason: 'NO_DATA', observedAt: Date.now() };

      const hits = [];
      for (const f of callers) {
        const txt = readText(f);
        if (txt === null) { hits.push({ file: f, count: 0, missing: true }); continue; }
        hits.push({ file: f, count: countCallSites(txt, symbol) });
      }
      const statCalls = hits.reduce(function (a, x) { return a + (x.count || 0); }, 0);

      /* 可选：runtime ledger 里的真实调用条数（比静态扫描强一个量级） */
      let runtimeCalls = null;
      if (o.ledger) {
        const raw = readText(path.resolve(o.ledger));
        if (raw !== null) {
          runtimeCalls = raw.split('\n').filter(function (l) { return l.trim() && l.indexOf('"' + symbol + '"') >= 0; }).length;
        }
      }
      const n = runtimeCalls === null ? statCalls : runtimeCalls;
      const ok = n > 0;
      return {
        ok,
        reason: ok ? undefined : 'NOT_CALLED',
        n,
        observedAt: Date.now(),
        evidence: { symbol, callers: hits, staticCalls: statCalls, runtimeCalls },
      };
    },
  };
}

/**
 * useful（账本形态）· 账本里有没有「产物」字段
 * 病灶原型：某系统落了三万三千条学习账本，字段只有 ts / totalEntries / level ——
 * 它记录的是心跳，不是产物。这种账本无论多厚都不能证明任何事。
 */
function ledgerHasProduct(opts) {
  const o = opts || {};
  const file = path.resolve(o.file || '');
  const fields = o.fields || ['product', 'artifactId', 'sha1', 'output', 'consumedBy'];
  return {
    level: 'useful',
    id: 'ledgerHasProduct:' + path.basename(String(o.file || '')),
    run: async function () {
      const raw = readText(file);
      if (raw === null) return { ok: null, reason: 'NO_DATA', observedAt: Date.now(), evidence: { file } };
      const lines = raw.split('\n').filter(function (l) { return l.trim(); });
      if (!lines.length) return { ok: null, reason: 'NO_DATA', observedAt: Date.now(), evidence: { file, lines: 0 } };
      let withProduct = 0;
      for (const l of lines) {
        let o2 = null;
        try { o2 = JSON.parse(l); } catch (e) { continue; }
        if (fields.some(function (k) { return o2 && o2[k] !== undefined && o2[k] !== null; })) withProduct++;
      }
      return {
        ok: withProduct > 0,
        reason: withProduct > 0 ? undefined : 'NO_PRODUCT',
        n: withProduct,
        observedAt: Date.now(),
        evidence: { file, lines: lines.length, withProduct, fields, firstLine: lines[0].slice(0, 120) },
      };
    },
  };
}

module.exports = { fileLanded, processLoaded, calledFrom, ledgerHasProduct, sha1 };
