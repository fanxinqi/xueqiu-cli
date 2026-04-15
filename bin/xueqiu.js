#!/usr/bin/env node
'use strict';

// CLI 入口。所有命令注册在 src/cli.js。
require('../src/cli').run(process.argv);
