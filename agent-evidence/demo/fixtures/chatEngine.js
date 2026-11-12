'use strict';
/* 演示用最小样本：一个"已接线"的缓存层 */
function cacheLayer(key) {
  if (!key) return null;
  return { key: String(key), hits: 0 };
}
module.exports = { cacheLayer };
