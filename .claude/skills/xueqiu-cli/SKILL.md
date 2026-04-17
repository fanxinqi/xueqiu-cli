---
name: xueqiu-cli
description: 使用 xueqiu-cli（雪球组合调仓 CLI）查询/修改用户的雪球模拟组合。当用户提到雪球、xueqiu、调仓、rebalance、买入/卖出某只股票到组合、或直接敲 `xueqiu`/`xq` 命令时触发。
---

# xueqiu-cli 使用指南（给 AI 工具）

这份文档给任何能执行 shell 的 AI agent 用（Claude Code / Cursor / Aider / Cline / LangChain subprocess…）。
**核心原则**：只读命令随便跑；**写操作必须先 `--dry-run` 预览，让用户肉眼确认后再去掉 dry-run**。不要自己加 `-y` 跳过确认。

---

## 0. 前置检查（每次会话开头跑一次）

```bash
xueqiu whoami
```

- 成功 → 输出当前账号，继续。
- 失败（未登录 / Cookie 失效）→ **停下来让用户自己跑 `xueqiu login`**。不要代劳，登录要读 Keychain / 弹浏览器，属于用户侧操作。

如果用户配了默认组合（`xueqiu config set-cube ZHxxxxxx`），后续命令可以省略 cube 参数；没配就必须显式传。

---

## 1. 只读命令（安全，可随意调用）

```bash
xueqiu holdings ZH123456          # 人类可读表格
xueqiu holdings ZH123456 --json   # AI 解析首选：结构化 JSON
xueqiu ls ZH123456 --json         # holdings 的别名
xueqiu whoami --list              # 所有已登录 profile
xueqiu config show                # 当前配置（Cookie 自动脱敏）
```

解析 `--json` 输出比解析表格稳定得多，**所有要喂回给 LLM 的查询都加 `--json`**。

---

## 2. 写操作（危险，必须走 dry-run → 用户确认 → 执行 三步）

涉及写操作的子命令：`buy` / `sell` / `rebalance` / `apply`。

### 2.1 标准流程

```bash
# 步骤 1：dry-run 预览变更
xueqiu rebalance ZH123456 -s SH600519:30 -s SZ000858:20 --dry-run

# 步骤 2：把输出原样展示给用户，明确问：「确认执行？」
#        —— 绝不要自己决定跳过这一步

# 步骤 3：用户明确同意后再去掉 --dry-run
xueqiu rebalance ZH123456 -s SH600519:30 -s SZ000858:20 -m "春季调仓"
```

**`-y` 标志**：跳过 CLI 自带的二次确认。**只在用户明确说「跳过确认 / 直接执行 / yes」时才用**。AI 默认不主动加。

### 2.2 命令速查

```bash
# 整体调仓（replace，未列出的清仓）
xueqiu rebalance ZH123456 -s SH600519:30 -s SZ000858:20 -m "备注"

# 补丁调仓（patch，只动列出的）
xueqiu rebalance ZH123456 --patch -s HK00700:10

# 单笔加仓：相对 +5%
xueqiu buy SH600519 -c ZH123456 -w 5

# 单笔加仓：目标权重 8%
xueqiu buy HK00700 -c ZH123456 --to 8

# 单笔减仓 3%
xueqiu sell SZ000858 -c ZH123456 -w 3

# 清仓
xueqiu sell AAPL -c ZH123456 --all -m "止盈"

# 从 YAML/JSON 批量
xueqiu apply examples/rebalance.yaml -n   # 预览（-n 等价 --dry-run）
xueqiu apply examples/rebalance.yaml      # 执行（交互确认）
```

---

## 3. 股票代码归一化

用户输入五花八门，CLI 会自动归一。AI 帮用户时**不用改写**，传原文即可：

| 用户输入 | 归一后 |
|---|---|
| `600519` / `sh600519` / `600519.SH` | `SH600519` |
| `000858` / `000858.SZ` | `SZ000858` |
| `00700` / `700` / `00700.HK` | `HK00700` |
| `AAPL` / `NVDA` | `AAPL` / `NVDA`（美股保持原样） |

---

## 4. 批量调仓文件格式

**单组合** `rebalance.yaml`：
```yaml
cube_symbol: ZH123456
mode: replace      # 或 patch
comment: "季度再平衡"
targets:
  - { symbol: SH600519, weight: 30 }
  - { symbol: SZ000858, weight: 20 }
```

**多组合** `batch.yaml`：
```yaml
rebalances:
  - cube_symbol: ZH111111
    mode: replace
    targets:
      - { symbol: SH601398, weight: 25 }
  - cube_symbol: ZH222222
    mode: patch
    targets:
      - { symbol: HK00700, weight: 25 }
```

AI 生成此类文件后，**一律先 `xueqiu apply <file> -n` 预览再问用户**。

---

## 5. 多账号（profile）

```bash
xueqiu login --profile alt              # 登录另一个账号（用户操作）
xueqiu config use alt                   # 切换当前 profile
xueqiu --profile alt holdings ZH123456  # 临时指定
```

如果用户同时操作两个账号，**每次写操作前 echo 当前 profile** 给用户确认，避免打错账号。

---

## 6. 典型任务 → 命令组合

| 用户说 | 你该做 |
|---|---|
| "看我 ZH123456 的持仓" | `xueqiu holdings ZH123456 --json` |
| "茅台加仓 5 个点" | `xueqiu buy SH600519 -c <cube> -w 5 --dry-run` → 等确认 |
| "把组合调成 30% 茅台 20% 五粮液" | `xueqiu rebalance <cube> -s SH600519:30 -s SZ000858:20 --dry-run` → 等确认 |
| "清仓 AAPL" | `xueqiu sell AAPL -c <cube> --all --dry-run` → 等确认 |
| "按这个 YAML 调仓" | 先 `xueqiu apply <file> -n` → 等确认 → 再不带 `-n` |

---

## 7. 错误处理

- `XUEQIU_DEBUG=1 xueqiu <cmd>` 打印堆栈（排查用）。
- 报错里带 `error_code/error_description` 的是雪球 API 原返回，直接给用户看。
- Cookie 失效 → 提示用户跑 `xueqiu login` 覆盖，不要自己重试。
- 组合代码必须是 `ZH` + 数字，如 `ZH123456`；非此格式先跟用户核对。

---

## 8. 红线（不要做）

1. 不要在用户没同意前执行任何写操作（即便你"觉得"意图明显）。
2. 不要默认加 `-y`。
3. 不要把 `~/.xueqiu-cli/config.json`、Cookie、`xq_a_token` 明文回显或写入日志/提交。
4. 不要代替用户执行 `xueqiu login`（牵涉系统 Keychain）。
5. 不要凭记忆或训练数据猜测雪球 API 字段，一切以 `--json` 实际输出为准。
