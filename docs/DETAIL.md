# 额度看板（Quota Watch）

在会话输入框下方（composer dock）显示一个紧凑的额度胶囊：点击立即刷新，悬停查看完整详情。

## 显示内容

- **Codex 额度** — 来自官方接口 `https://chatgpt.com/backend-api/codex/usage`（读取 `~/.codex/auth.json` 的 OAuth 凭据，与 `codex-ops/cx` 同一数据源）
  - 5 小时滚动窗口：剩余百分比 + 重置倒计时
  - 周窗口（7 天滚动）：剩余百分比 + 重置倒计时
  - 状态点：绿 = 充足；黄 = 接近警告线（5h 85% / 周 90%）；红 = 到自动停止线（5h 97% / 周 98%）或 `limit_reached`
- **DeepSeek API 余额** — 来自官方接口 `https://api.deepseek.com/user/balance`
  - 总额、充值余额、赠送余额、`is_available`
  - **当日花费**（本机观测）：官方没有当日消费接口，本插件把「今天首次成功观测到的余额」作为基线持久化（`~/.dsh/quota-watch-state.json`），当日花费 = 基线 − 当前余额的累计。余额上涨（充值）不累计，且基线自动上移；跨天自动重置。插件当天未开机时段的花费无法观测。

## 数据与刷新

- 所有接口调用都在本机 Host 进程完成；页面只读取本机接口 `/api/quota-watch/overview`（仅回环地址与已配对设备可访问，密钥不出本机）。
- Host 默认每 60 秒拉取一次；页面每 45 秒读取一次快照，点击胶囊立即触发一次完整刷新。

## 配置（可选，写入 profile 的 cordis.patch.yml）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `pollIntervalSec` | 60 | Host 拉取间隔（15–600 秒） |
| `codexAuthPath` | 自动 | Codex `auth.json` 路径；默认依次尝试 `$CODEX_HOME/auth.json`、`~/.codex/auth.json`、当前目录 `.codex-home/auth.json` |
| `deepseekApiKeyEnv` | `DEEPSEEK_API_KEY` | 从 DSH 凭据库或环境变量读取 DeepSeek API key 的变量名 |
| `deepseekApiKey` | 空 | 直接指定 API key（不建议，优先使用 DSH 凭据库） |

示例：

```yaml
- id: quota-watch
  name: 'dsh-plugin-quota-watch'
  config:
    pollIntervalSec: 30
```

## 已知限制

- Codex access_token 过期时显示红色并提示重新登录：终端运行 `codex login` 后执行 `cx auth` 同步即可。
- 非回环的局域网访问仅在设备已配对（remote-web-ui）时放行。
- 阈值与 `codex-ops/CODEX-INTEGRATION.md` 的 cx 闸门保持一致（警告 85/90，停止 97/98）。
