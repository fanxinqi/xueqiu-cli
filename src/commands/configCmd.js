'use strict';

const chalk = require('chalk');
const config = require('../config');

function show() {
  const cfg = config.read();
  // 脱敏：不打印完整 cookie
  const redacted = JSON.parse(JSON.stringify(cfg));
  for (const k of Object.keys(redacted.profiles || {})) {
    if (redacted.profiles[k].cookie) {
      const c = redacted.profiles[k].cookie;
      redacted.profiles[k].cookie = c.length > 20 ? c.slice(0, 10) + '…(' + c.length + ' chars)' : '***';
    }
  }
  console.log(JSON.stringify(redacted, null, 2));
  console.log(chalk.gray(`\n配置文件: ${config.CONFIG_FILE}`));
}

function setCube(cube) {
  if (!cube) throw new Error('请提供组合代码，如 ZH123456');
  config.setDefault('cube_symbol', String(cube).toUpperCase());
  console.log(chalk.green(`✔ 默认组合已设置为 ${cube}`));
}

function useProfile(name) {
  config.useProfile(name);
  console.log(chalk.green(`✔ 已切换到 profile "${name}"`));
}

module.exports = { show, setCube, useProfile };
