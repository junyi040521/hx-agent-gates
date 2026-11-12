'use strict';
/**
 * gatekit 测试的共同底座
 *
 * 纪律：每个用例都是「注入一个坏样本 ⇒ 必须恰好在该判据转红 ⇒ 撤除后必须归零」。
 * 只测「好输入给绿」是没用的——一个永远给绿的审计器与一个不审计的，输出完全一样。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gatekit-'));

let seq = 0;
/**
 * @param {object} files 相对路径 → 内容（对象会被 JSON.stringify）
 * @param {string} [dirName] 目录名（有些判据要看目录名 = 包名）
 */
function mk(files, dirName) {
  /* 最后一级目录名 = dirName：有些判据要看「目录名 = 包名」，不能靠 seq 后缀区分 */
  const root = path.join(TMP, 's' + (++seq), dirName || 'pkg');
  for (const rel of Object.keys(files)) {
    const fp = path.join(root, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const v = files[rel];
    fs.writeFileSync(fp, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  return root;
}

/** 在既有夹具上追加/覆盖文件，返回同一个 root（用于「注入后撤销」） */
function put(root, files) {
  for (const rel of Object.keys(files)) {
    const fp = path.join(root, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const v = files[rel];
    fs.writeFileSync(fp, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  return root;
}

function rm(root, rel) {
  try { fs.rmSync(path.join(root, rel), { recursive: true, force: true }); } catch (e) {}
  return root;
}

function codes(list) { return (list || []).map(function (x) { return x.code; }); }
function hasCode(res, code) { return codes(res.red).indexOf(code) >= 0; }
function hasYellow(res, code) { return codes(res.yellow).indexOf(code) >= 0; }

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

module.exports = { mk, put, rm, codes, hasCode, hasYellow, cleanup, TMP };
