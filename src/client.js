'use strict';

// 统一从当前 profile 取 cookie 构造 XueqiuClient

const config = require('./config');
const { XueqiuClient } = require('./api');

function createClient({ profile } = {}) {
  const p = config.getProfile(profile);
  if (!p || !p.cookie) {
    const name = profile || config.getCurrentProfileName();
    throw new Error(
      `当前 profile "${name}" 未登录。请先执行: xueqiu login`
    );
  }
  return new XueqiuClient({ cookie: p.cookie });
}

module.exports = { createClient };
