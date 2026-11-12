'use strict';
/**
 * 两份 selfgate 的同步检测器
 *
 * 两个包都宣称零依赖，所以 selfgate.js 各带一份，而不是抽成第三个包。
 * 代价是「同一份代码存在两处」——按纪律，无索引关系的重复必须有检测器兜底，
 * 否则两处必然漂移，而且漂移时不报错（历史上同一句模板的版本号过时了十七个版本
 * 无人发现，就是这么来的）。
 *
 * 用法：node check-selfgate-sync.js     rc=0 一致 / 1 已漂移 / 2 缺文件
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const A = path.join(__dirname, 'agent-evidence', 'src', 'selfgate.js');
const B = path.join(__dirname, 'agent-arbiter', 'src', 'selfgate.js');

function sha1(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return null; }
}

const a = sha1(A);
const b = sha1(B);
if (!a || !b) {
  console.error('[x] 缺少文件：' + (!a ? A : B) + ' ⇒ 按没查处理');
  process.exit(2);
}
if (a !== b) {
  console.error('[x] 两份 selfgate 已漂移：');
  console.error('    agent-evidence  ' + a);
  console.error('    agent-arbiter   ' + b);
  console.error('    修法：把改动落到 agent-evidence/src/selfgate.js，再复制过去，不要在两边各改一次。');
  process.exit(1);
}
console.log('[ok] 两份 selfgate 一致  sha1=' + a.slice(0, 12));
process.exit(0);
