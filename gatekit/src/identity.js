'use strict';
/**
 * gatekit · identity —— 发布身份自洽
 *
 * 一句话：**内容没问题，不代表发出去的是它自己声称的那一份。**
 *
 * 判据来源：junyi 专家包 publish_audit.py 的 identity_audit（同一套判据在
 * 一个「内容全对」的包里查出 10 处红：5 处陈旧签名版本 + 5 个字节码残留），
 * 这里按 npm / 技能包的通用形态重写，不引用那份代码。
 *
 * 为什么需要它：版本号被写在四十几处（清单、README、每份文档尾签名、变更记录），
 * 没有任何东西在它们不一致时变红。读到文件中部的人会认定那是当前版本。
 */

const fs = require('fs');
const path = require('path');

const SEMVER = /^\d+\.\d+\.\d+$/;

/** 打包器排除了 ≠ 包是干净的：换个人手 zip 就带出去了。判据只能落在源目录上。 */
const RESIDUE = /(^__pycache__$|\.pyc$|^\.DS_Store$|\.log$|\.tgz$|\.tar\.gz$|\.zip$|\.bak$|\.orig$|^\.nyc_output$|^coverage$|\.tsbuildinfo$)/;

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } }

function walk(dir, out) {
  out = out || [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    if (n === 'node_modules' || n === '.git') continue;
    const fp = path.join(dir, n);
    if (isDir(fp)) walk(fp, out); else out.push(fp);
  }
  return out;
}

/* 签名/未来版本只扫文档。测试文件里的 v1.2.3 是**夹具数据**，不是声明——
   第一版扫全仓文本，于是在自己包的 20 条测试里判出 20 条「陈旧签名」。
   判据看见的必须是声明，不是关于声明的样例。 */
const DOCS = /\.(md|txt)$/i;
const NOT_DOC = /(^|\/)(test|tests|__tests__|fixtures?|node_modules|\.git)\//;

/**
 * 包级文档 = 根目录下的文档 + docs/ 下的文档。
 * 为什么排除子目录：一个「技能集合包」里每个 skills/<x>/SKILL.md 有**自己的 version**
 * （browser-use 2.0.0，包 3.20.29），拿包版本去判它必然 100% 误报。
 * 子单元的版本由 manifest 的 skill 判据管（目录名 = name、必填、预算），不归本处。
 */
function isPkgDoc(rel) {
  return rel.indexOf('/') < 0 || rel.indexOf('docs/') === 0;
}

function escRe(x) {
  return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 一条行是不是「版本声明」，按形状判，不按目录判。
 *
 * 真签名长这样（junyi 包 45 处，全在 skills/<x>/references/ 下）：
 *   junyi · v3.20.29 · 本文件未经授权禁止再分发（见 LICENSE）
 * 而 skills/<x>/SKILL.md 的 frontmatter version 字段是子单元自己的版本。
 * 同一目录下两种版本，语义完全不同——按目录排除会同时漏掉真签名、放过假声明。
 * 所以：排除 frontmatter 的 version 行 + 历史叙述行；认「包名 + 版本」或「签名：版本」。
 */
function isSigLine(line, name) {
  if (FM_VERSION.test(line)) return false;
  if (HIST_LINE.test(line)) return false;
  if (SIG_DECL.test(line)) return true;
  if (name) {
    /* 分隔符必须是签名形态（· | , 或空白 + v），不能是 / ——
       否则 `my-experts/junyi/3.17.0` 这种**路径**会被当成签名，
       把一整段现象描述（「该目录下并存 2.2.0 / 3.0.0 / 3.9.0 / 3.17.0 四个版本」）
       判成 5 条陈旧签名。 */
    const re = new RegExp(escRe(name) + '\\s*[·|｜,，]\\s*v?\\d+\\.\\d+\\.\\d+');
    if (re.test(line)) return true;
  }
  return false;
}

function vtuple(v) {
  return String(v).split('.').map(function (x) { return parseInt(x, 10) || 0; });
}
function vgt(a, b) {
  const x = vtuple(a), y = vtuple(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return true;
    if (x[i] < y[i]) return false;
  }
  return false;
}

/**
 * 签名行：**声明位**，不是「出现过这个词」。
 *
 * 三版判据的演化（每版都在真包上误报过）：
 *   ① 见 vX.Y.Z 就算 ⇒ 依赖版本 4.18.2 全被判成陈旧签名；
 *   ② 行内含「签名 / 当前版本」就算 ⇒ 三条误报全回来了：
 *      · 台账叙事里那句「5 处 `v3.20.17` 的旧尾签名」是**引述**，不是声明；
 *      · `skills/browser-use/SKILL.md` 的 `version: 2.0.0` 是**子单元自己的版本**，
 *        它本来就不该等于包版本；
 *      · 「v3.20.18 变更：…」是历史条目。
 *   ③ 现在：声明词 + 冒号 + 版本号**紧邻**同现，且排除子单元与历史行。
 * 判据越宽，误报越多；误报越多，闸门越早被关掉——这是同一个决定的两面。
 */
const SIG_DECL = /(签名|signature|当前版本|版本签名)\s*[:：]\s*\**[^\n]{0,12}?v?\d+\.\d+\.\d+/i;
const FM_VERSION = /^\s*version\s*:/i;
/* 历史叙述：命中这些词的行是「关于版本的话」，不是「版本声明」 */
const HIST_LINE = /(变更|上一版|历史|曾|旧尾|旧版|修前|修后|计划中|见第|例如|比如|报出|写着|记录|迁出|拆出|摘自|源自|抽出|基于 v)/;
const ANY_VER = /\bv?(\d+\.\d+\.\d+)\b/g;

const DEFAULTS = {
  manifest: null,           /* null = 自动探测；见 MANIFESTS */
  nameMax: 214,             /* npm 硬限；技能/插件包平台常见 15（实测本地全绿、上传被拒） */
  scanResidue: true,
  docGlobs: null,           /* 默认全仓文本文档 */
};

/* 三种载体的版本清单：npm 包 / CodeBuddy 插件 / 裸 plugin.json。
   同一件事（当前版本是什么）在三种包里写在三个文件里——
   不支持全部三种，就等于只给一类包做体检。 */
const MANIFESTS = ['package.json', '.codebuddy-plugin/plugin.json', 'plugin.json'];

function findManifest(root, prefer) {
  if (prefer) return fs.existsSync(path.join(root, prefer)) ? prefer : null;
  for (const m of MANIFESTS) if (fs.existsSync(path.join(root, m))) return m;
  return null;
}

/**
 * @param {string} root 包根
 * @param {object} [opts]
 * @returns {{ok:boolean, red:Array, yellow:Array, facts:object}}
 */
function identity(root, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const red = [], yellow = [], facts = {};

  const mfName = findManifest(root, o.manifest);
  const mf = mfName ? read(path.join(root, mfName)) : null;
  if (mf === null) {
    red.push({ code: 'NO_MANIFEST', msg: '找不到版本清单（' + MANIFESTS.join(' / ') + '）⇒ 无法确定当前版本（按没查处理，不许当通过）' });
    return { ok: false, red, yellow, facts, noData: true };
  }
  let meta;
  try { meta = JSON.parse(mf); } catch (e) {
    red.push({ code: 'BAD_MANIFEST', msg: mfName + ' 不是合法 JSON：' + (e && e.message || e) });
    return { ok: false, red, yellow, facts };
  }

  const cur = String(meta.version || '');
  if (!SEMVER.test(cur)) {
    red.push({ code: 'BAD_VERSION', msg: 'version 不合规：「' + cur + '」（要 x.y.z）' });
    return { ok: false, red, yellow, facts };
  }
  facts.manifest = mfName;
  facts.version = cur;
  facts.name = String(meta.name || '');

  /* 平台硬限：本地校验器查不到，平台在上传那一刻才拒。超限红，恰好等于上限黄。 */
  if (!facts.name) red.push({ code: 'NO_NAME', msg: '缺 name' });
  else {
    if (facts.name.length > o.nameMax) red.push({ code: 'NAME_TOO_LONG', msg: '名称 ' + facts.name.length + ' 字，超过上限 ' + o.nameMax });
    else if (facts.name.length === o.nameMax) yellow.push({ code: 'NAME_AT_LIMIT', msg: '名称恰好等于上限 ' + o.nameMax + '，下次改一个字就被拒' });
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(facts.name)) {
      red.push({ code: 'NAME_SHAPE', msg: '名称含大写/空格/非法字符：' + facts.name + '（npm 只允许小写字母数字 . _ -）' });
    }
  }

  /* 目录名 = 包名。宿主/工具按 name 索引，按目录找得到、按 name 找不到，是两种命运。 */
  const base = path.basename(path.resolve(root));
  if (facts.name && facts.name !== base && !facts.name.endsWith('/' + base)) {
    yellow.push({ code: 'DIR_NE_NAME', msg: '目录名 ' + base + ' ≠ 包名 ' + facts.name + '（同一份内容在两个视角里有两个名字）' });
  }

  const major = cur.split('.')[0] + '.';
  const files = (o.docGlobs ? o.docGlobs.reduce(function (a, g) {
    const p = path.join(root, g);
    return a.concat(isDir(p) ? walk(p) : (fs.existsSync(p) ? [p] : []));
  }, []) : walk(root)).filter(function (fp) {
    const rel = path.relative(root, fp).split(path.sep).join('/');
    return DOCS.test(fp) && !NOT_DOC.test(rel);
  });

  facts.docFiles = files.length;
  facts.textFiles = files.length;   /* 兼容旧字段名：读的人不该因为改名而拿到 undefined */
  if (!files.length) {
    yellow.push({ code: 'NO_DOCS', msg: '一个文档都没有（.md/.txt，且不在 test/fixtures 下）——签名与版本声明无处可查，这部分未核验' });
  }
  let sigs = 0;

  for (const fp of files) {
    const rel = path.relative(root, fp).split(path.sep).join('/');
    const txt = read(fp);
    if (txt === null) continue;
    const lines = txt.split(/\r?\n/);

    /* 同一个事实被写了四十几份，不一致时必须变红——这是本闸门存在的全部理由。 */
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isSigLine(line, facts.name)) continue;
      /* 历史行是「关于版本的话」，不是「版本声明」——台账里引述旧签名不该判红。 */
      if (HIST_LINE.test(line)) continue;
      ANY_VER.lastIndex = 0;
      let m;
      while ((m = ANY_VER.exec(line)) !== null) {
        sigs++;
        if (m[1] !== cur) red.push({ code: 'STALE_SIG', msg: rel + ':' + (i + 1) + ' 签名声明 v' + m[1] + '，清单是 v' + cur });
      }
    }

    /* 未来版本是唯一可以无条件判红的形态：比清单更高的同主版本号，一定是错的。
       更低的不算错（历史叙述里出现旧版本是证据，不是缺陷）——这条不写清会把整本台账判红。 */
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf('v' + major) < 0 && !/\d+\.\d+\.\d+/.test(line)) continue;
      ANY_VER.lastIndex = 0;
      let m;
      while ((m = ANY_VER.exec(line)) !== null) {
        const v = m[1];
        if (v === cur || !v.startsWith(major)) continue;
        if (vgt(v, cur)) red.push({ code: 'FUTURE_VERSION', msg: rel + ':' + (i + 1) + ' 出现 v' + v + ' > 当前 v' + cur + '（不存在未来版本）' });
      }
    }
  }
  facts.sigLines = sigs;
  if (!sigs) yellow.push({ code: 'NO_SIG', msg: '全包没有一处版本签名声明——没法用签名验「发出去的是不是这一份」，只能靠版本号一处' });

  if (o.scanResidue) {
    const res = [];
    (function scan(dir) {
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const n of names) {
        if (n === '.git' || n === 'node_modules') continue;
        const fp = path.join(dir, n);
        const rel = path.relative(root, fp).split(path.sep).join('/');
        if (RESIDUE.test(n)) { res.push(rel + (isDir(fp) ? '/' : '')); continue; }
        if (isDir(fp)) scan(fp);
      }
    })(root);
    facts.residue = res.length;
    for (const r of res) red.push({ code: 'RESIDUE', msg: '残留物 ' + r + '：打包器排除了，换个人手 zip 就带出去' });
  }

  return { ok: red.length === 0, red, yellow, facts };
}

module.exports = { identity, SEMVER, RESIDUE, vgt };
