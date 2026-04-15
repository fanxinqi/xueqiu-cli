'use strict';

const chalk = require('chalk');
const config = require('../config');

async function run(opts) {
  const name = opts.profile || config.getCurrentProfileName();
  const p = config.getProfile(name);
  if (!p) {
    console.log(chalk.yellow(`profile "${name}" 不存在，无需登出。`));
    return;
  }
  config.removeProfile(name);
  console.log(chalk.green(`✔ 已清除 profile "${name}" 的 Cookie。`));
}

module.exports = { run };
