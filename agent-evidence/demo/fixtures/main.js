'use strict';
const { cacheLayer } = require('./chatEngine');
/* 接线就写在这下面一行 —— 但它被注释掉了 */
// cacheLayer(req.body.text);
module.exports = function handler(req) { return req; };
