'use strict';

const chalk = require('chalk');
const Table = require('cli-table3');
const config = require('../config');
const { createClient } = require('../client');

async function run(opts) {
  if (opts.list) {
    const rows = config.listProfiles();
    if (!rows.length) {
      console.log(chalk.yellow('尚未登录任何 profile。请执行: xueqiu login'));
      return;
    }
    const table = new Table({
      head: [chalk.gray('current'), 'profile', 'user_id', 'screen_name', 'updated_at'],
    });
    for (const r of rows) {
      table.push([r.current ? chalk.green('*') : '', r.name, r.user_id ?? '', r.screen_name ?? '', r.updated_at ?? '']);
    }
    console.log(table.toString());
    return;
  }

  const client = createClient({ profile: opts.profile });
  const me = await client.whoami();
  const info = {
    profile: opts.profile || config.getCurrentProfileName(),
    id: me.id,
    screen_name: me.screen_name,
    province: me.province,
    city: me.city,
    followers_count: me.followers_count,
    friends_count: me.friends_count,
    status_count: me.status_count,
  };
  if (opts.json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  console.log(chalk.green(`✔ ${info.screen_name} (id=${info.id})`));
  console.log(chalk.gray(`profile: ${info.profile}`));
  if (info.followers_count != null) {
    console.log(chalk.gray(`粉丝 ${info.followers_count} / 关注 ${info.friends_count} / 发帖 ${info.status_count}`));
  }
}

module.exports = { run };
