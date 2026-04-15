'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const yaml = require('js-yaml');
const prompts = require('prompts');
const Table = require('cli-table3');
const { createClient } = require('../client');
const config = require('../config');
const { buildRebalance } = require('../rebalance');

function loadFile(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
  const ext = path.extname(abs).toLowerCase();
  const raw = fs.readFileSync(abs, 'utf8');
  if (ext === '.json') return JSON.parse(raw);
  if (ext === '.yaml' || ext === '.yml') return yaml.load(raw);
  // 默认按 YAML 解析（兼容）
  return yaml.load(raw);
}

/*
文件结构（单组合）：
{
  "cube_symbol": "ZH123456",
  "mode": "replace" | "patch",   // 可省略，默认 replace
  "comment": "春季调仓",
  "targets": [
    { "symbol": "SH600000", "weight": 30 },
    { "symbol": "SZ000858", "weight": 20 }
  ]
}

也支持批量：
{
  "rebalances": [ <同上>, <同上> ]
}
*/
async function run(file, opts) {
  const doc = loadFile(file);
  const list = Array.isArray(doc?.rebalances) ? doc.rebalances : [doc];

  const client = createClient({ profile: opts.profile });

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const cube = item.cube_symbol || opts.cube || config.getDefaults().cube_symbol;
    if (!cube) {
      console.error(chalk.red(`第 ${i + 1} 项缺 cube_symbol`));
      process.exit(1);
    }
    const mode = item.mode || 'replace';
    const targets = item.targets || item.holdings || [];
    if (!targets.length) {
      console.error(chalk.yellow(`跳过 ${cube}：targets 为空`));
      continue;
    }

    const cubeInfo = await client.cubeQuote(cube);
    const { rebalancingHistories, holdings, cash, total } = await buildRebalance({
      client,
      targets,
      currentHoldings: cubeInfo.holdings,
      mode,
    });

    console.log(chalk.bold(`\n[${i + 1}/${list.length}] ${cubeInfo.name || cube} (${cube}) mode=${mode}`));
    if (!rebalancingHistories.length) {
      console.log(chalk.yellow('  无变化，跳过。'));
      continue;
    }

    const table = new Table({
      head: ['代码', '名称', '原%', '目标%', '变化', '价格'],
      colAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
    });
    for (const h of rebalancingHistories) {
      const d = (h.weight - h.prev_weight).toFixed(2);
      table.push([
        h.stock_symbol,
        h.stock_name || '',
        h.prev_weight.toFixed(2),
        h.weight.toFixed(2),
        d > 0 ? chalk.green('+' + d) : chalk.red(d),
        h.price,
      ]);
    }
    console.log(table.toString());
    console.log(chalk.gray(`股票总权重 ${total.toFixed(2)}%`));

    if (opts.dryRun) {
      console.log(chalk.gray('  --dry-run，未提交。'));
      continue;
    }

    const comment = item.comment || opts.comment;
    const res = await client.rebalance(cube, { holdings, cash, comment });
    console.log(chalk.green(`  ✔ ${cube} 已提交${res?.id ? '，id=' + res.id : ''}`));
    if (res?._warning) {
      console.log(chalk.yellow(`  ⚠ 服务端返回警告：${res._warning}`));
    }
  }
}

module.exports = { run };
