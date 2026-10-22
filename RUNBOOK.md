# 腾讯会议转写调度：云端版 → GitHub Actions 迁移与运维手册

> 文档生成时间：2026-10-22 23:44 (GMT+8)
> 适用仓库：`vip198926/tencent-meeting-auto`（private）
> 本地工程目录：`<work-dir>`（云端版 `ctm-cloud/`、GitHub 版 `ctm-github/`）

---

## 0. 一句话结论

腾讯会议自动转写调度已从「云端常驻服务（ctm-cloud）」迁移到「GitHub Actions」。
云端版的**自动定时器已关闭**（`CLOUD_SCHEDULER_ENABLED=false`），但**网页与手动快捷指令全部保留**。
GitHub Actions 版已上线并经手动 dispatch 验证跑通（登录态续期 + IMA 上传 + 企业微信通知）。

---

## 1. 为什么要迁移

| 维度 | 云端版（ctm-cloud，旧） | GitHub Actions 版（新） |
|---|---|---|
| 运行形态 | 常驻 Node 服务（server.js 跑在 WorkBuddy 托管平台） | 事件触发（cron + 手动 dispatch），跑完即释放 |
| 稳定性 | 平台会**不定期重启进程**，导致 uptime 归零、凌晨-早上长时间不在线，定时器可能错过 | 平台级调度，到点必触发；另有 03:36 巡检兜底 |
| 费用/依赖 | 依赖 WorkBuddy 托管实例常开 | 免费额度内；仅用 GitHub 内置 `GITHUB_TOKEN` |
| 凭证管理 | 登录态落云端磁盘 | 登录态进 Repo Secrets + 运行时临时目录，绝不进仓库 |
| 状态留存 | 云端 daily/ + 登录态 | 状态落 git 仓库 `daily/`，版本可追溯 |

---

## 2. 仓库与目录结构（GitHub 版）

```
tencent-meeting-auto/
├── .github/workflows/
│   ├── daily.yml        # 每日主管线  cron '36 1 * * *'  = 北京 09:36
│   └── patrol.yml       # 巡检补跑    cron '36 19 * * *' = 北京 03:36（前一日 UTC 19:36）
├── daily/               # 状态目录（被 workflow 自动 commit/push 回写）
│   ├── last_progress.json      # { processed_until, updated } 增量游标
│   ├── processed_records.json  # record_id 去重列表（防 IMA 重复上传）
│   └── records_YYYYMMDD_*.json/.md  # 每轮跑出的会议记录
├── run.js               # 主程序：续期登录态→拉会→转写→IMA→企业微信
├── set_secrets.js       # 一次性工具：把 4 个凭证加密写入 Repo Secrets
└── package.json         # 依赖含 tweetsodium
```

> **关键分支**：`master`。所有改动均已 push（最新 commit `50f7be0`）。

---

## 3. Secrets 配置（4 个，已设置）

| Secret 名 | 来源 | 说明 |
|---|---|---|
| `CTM_AUTH_STATE_RAW` | `ctm-cloud/auth_state.json` 全文 | 腾讯会议登录态明文 JSON |
| `IMA_CLIENT_ID` | `ctm-cloud/ima_creds.json` → `client_id` | IMA 知识库上传凭证 |
| `IMA_API_KEY` | `ctm-cloud/ima_creds.json` → `api_key` | IMA 知识库上传凭证 |
| `WECOM_WEBHOOK` | `ctm-cloud/wecom_webhook.json` → `webhook` | 企业微信机器人通知地址 |

**加密方式（踩坑后定稿）**：必须用 `tweetsodium.seal()`（libsodium `crypto_box_seal` 格式）。
`tweetnacl` 1.0.3 **没有** `nacl.sealedbox`，其 `nacl.box` 格式也与 libsodium 不兼容（PUT 会 422 `improperly encrypted`）。
`set_secrets.js` 即采用 `tweetsodium`，一次写入 4 个 Secret 成功。

**重设方法**（仅当 Secret 失效时）：
```bash
cd <work-dir>ctm-github
GITHUB_PAT=<你的PAT> node set_secrets.js
# 用完该 PAT 立即到 GitHub 撤销
```

---

## 4. 定时任务（北京时间 ↔ UTC）

GitHub Actions 的 cron 为 **UTC**，已换算：

| 任务 | UTC cron | 北京时间 | 作用 |
|---|---|---|---|
| `daily.yml` | `36 1 * * *` | 09:36 | 主管线：处理今早结束的会议 |
| `patrol.yml` | `36 19 * * *` | 次日 03:36（即当天 UTC 19:36） | 巡检兜底 + 积压/登录态告警 |

两者均带 `workflow_dispatch`（手动触发）。`daily.yml` 手动触发时可传：
- `mode=inc`（默认，增量）/ `mode=daily`（按天补跑）
- `date=YYYY-MM-DD`（daily 模式指定日期）

> 09:36 主线的设计依据：用户会议多在 9 点前结束，09:36 正好处理「今早的会」，**增量模式**不再按天补跑昨天。

---

## 5. 增量模式与状态管理

- `daily/last_progress.json` 存 `processed_until`（Unix 秒），每轮处理
  「`processed_until` → now」之间**结束**的会议；跑完推进游标。
- `daily/processed_records.json` 存已上传 IMA 的 `record_id`，**去重防重复上传**。
- 状态文件由 workflow 在末尾 `git add daily/ && commit && pull --rebase && push` 回写仓库。
- **基线对齐**：迁移时 `last_progress.processed_until` 设为 `1792681565`（对齐云端 10-22 10:46 北京），
  去重种子复用云端已上传的 10 条 record_id，避免重复/跳过会议窗口。

> ⚠️ **提交顺序铁律**：必须先 `git add daily/` + `git commit`，再 `git pull --rebase`，最后 `git push`。
> 若先 pull 再 add 会报 `cannot pull with rebase: You have unstaged changes`。

---

## 6. 凭证隔离（安全设计）

- 登录态**不进仓库**：workflow 把 `CTM_AUTH_STATE_RAW` 写入 `$RUNNER_TEMP/auth_state.json`，
  再 `echo "CTM_AUTH_STATE=$AUTH_PATH" >> "$GITHUB_ENV"` 注入后续 step（**不能用静态 `env` 的 `runner.temp`**，会 422）。
- 每轮现场 `refresh-token` 续 7 天登录态。
- 末尾 step 必定 `rm -f "$RUNNER_TEMP/auth_state.json"`（`if: always()`）。
- 仅 IMA / WECOM 走静态 `env`（用 `secrets.*` 上下文，合法）；登录态绝不以静态 env 明文出现。

---

## 7. 云端版变更（ctm-cloud/server.js）

已关闭自动定时器，保留网页与快捷指令：

```js
const CLOUD_SCHEDULER_ENABLED = false;  // 已迁 GitHub；改 true 可恢复
```
4 个定时器全部门控：
- `if (CLOUD_SCHEDULER_ENABLED) setInterval(...)` （原 09:36 管线 / 03:36 巡检）
- `if (CLOUD_SCHEDULER_ENABLED) setTimeout(...)` （含 lazy check 兜底）

**完整保留的 HTTP 端点**：
- `GET /` 网页控制台
- `POST /api/transcribe`、`/api/daily`、`/api/patrol`、`/api/refresh`、`/api/auth`、`/api/state`
- `server.listen` 正常监听

`/api/health` 新增 `scheduler_enabled` 字段便于验证（实测 `scheduler_enabled:false`、`inc_running:false`）。

- 发布地址（不变）：`https://<your-deployment-host>/`
- 同 appId：`<your-app-id>`

---

## 8. 验证记录（2026-10-22）

- ✅ 手动 dispatch `patrol` → 成功；日志确认：
  - 登录态写入 `$RUNNER_TEMP`（约 11384 字节）
  - 登录态续期至 **2026-10-29**
  - 企业微信通知发出（`日报已推送（wecom）`）
  - 增量窗口 0 场（无重复上传 IMA）
  - 状态 commit `087276c` 回写 master（`processed_until` 推进至 `1792681565`）
- ✅ 云端版重发成功（同 appId、URL 不变）；`/api/refresh` 续期至 2026-10-29；`/api/health` `scheduler_enabled:false`；网页 HTTP 200。
- ✅ GitHub 仓库 `master` 干净，无未提交改动。

---

## 9. 安全收尾（务必执行）

> **该 Classic PAT `<REVOKED_CLASSIC_PAT>` 仅用于设置 Secrets，现已完成使命，请立即撤销：**
>
> GitHub → **Settings → Developer settings → Personal access tokens → Tokens (classic)** → 找到该 token → **Delete / Revoke**。
>
> 撤销后**无任何影响**：GitHub Actions 后续全部走内置 `GITHUB_TOKEN`，不依赖该 PAT；云端版（已无定时器）也不依赖它。

PAT 安全属性（设置时即遵循）：仅 `repo` 权限、7 天过期；用完即撤。

---

## 10. 日常运维与回滚

**日常以 GitHub 版为主。** 注意事项：
- ⚠️ **不要在云端手动触发 `/api/daily`**：会与 GitHub 状态独立，可能产生 IMA 重复上传。云端版现仅作手动兜底 / 网页查看。
- 若登录态彻底失效：本机跑 `sync_auth.bat` 刷新云端登录态（云端手动触发能力保留）。
- 查看运行结果：GitHub → Actions 标签页看每次 run 日志；`daily/records_*.md` 为可读记录。

**回滚到云端版（如需）**：
1. 云端 `server.js` 把 `CLOUD_SCHEDULER_ENABLED` 改回 `true`；
2. 重新发布 `<work-dir>ctm-cloud`；
3. 在 GitHub 仓库 **Settings → Actions → Disable** 两个 workflow（或直接删除 `.github/workflows/` 下两个文件）。
4. 按「部署四步铁律」对齐 daily/ 状态，避免重复上传。

---

## 11. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| PUT Secret 报 422 `improperly encrypted` | 用了 tweetnacl 的 box；改用 `tweetsodium.seal()` |
| workflow dispatch 422 `Unrecognized named-value: 'runner'` | 静态 `env` 用了 `runner.temp`；改为 step 内 `$RUNNER_TEMP` + `GITHUB_ENV` |
| workflow dispatch 422 `Expected format {org}/{repo}@ref` | action 缺 `actions/` 前缀；用 `actions/checkout@v4`、`actions/setup-node@v4` |
| 本地 push 被拒（non-fast-forward） | workflow 已 commit 状态；先 `git fetch` + `git rebase origin/master` 再 push |
| 重复上传 IMA | 检查 `daily/processed_records.json` 去重列表是否完整；勿双端触发 |
| 平台进程重启导致漏跑 | GitHub 版不受影响；云端版已关定时器，无需担心 |

---

## 附：关键时间线（2026-10-22）

- 基线对齐 `last_progress` = 1792681565（北京 10:46）
- 4 个 Secret 用 tweetsodium 写入成功
- 两个 workflow 三次修正后 push（commit `3b24f0e`→`f66c7ab`→`087276c`→`50f7be0`）
- 手动 dispatch patrol 验证通过（续期/通知/状态回写均 OK）
- 云端版关闭定时器并重新发布（URL 不变）
- 清理临时产物（cloud_state*.json、cloud_health*.json 等）
- **待办**：用户到 GitHub 撤销 classic PAT `<REVOKED_CLASSIC_PAT>`
