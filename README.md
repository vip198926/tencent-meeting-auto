# tencent-meeting-auto

腾讯会议自动转写管线（GitHub Actions 版）。每天把已结束会议的录制/转写抓取下来，生成逐字稿 + AI 纪要，上传到 IMA 知识库，并通过企业微信机器人推送日报。

## 架构

```
GitHub Actions（ubuntu-latest，每次运行全新容器）
├── 巡检  patrol.yml   北京时间 03:36（UTC 19:36）  增量 + 始终推送通知
└── 管线  daily.yml    北京时间 09:36（UTC 01:36）  增量（覆盖早上 9 点结束的会）
        ↓ 每轮
   1. 纯 HTTP 续期腾讯会议登录态（延长约 7 天）
   2. 拉取「上次截止 → 现在」之间结束的会议
   3. 逐场查录制/转写记录 → 抓逐字稿 + AI 纪要
   4. 上传 IMA「腾讯会议转写」文件夹
   5. 企业微信机器人推送日报
   6. 状态文件（去重/进度）提交回仓库持久化
```

增量模式：每轮处理「`daily/last_progress.json` 的 processed_until → 现在」之间结束的会议，跑完推进截止时间。已上传的 record_id 记在 `daily/processed_records.json` 去重，不会重复传。

## Secrets（仓库 Settings → Secrets → Actions）

| 名称 | 内容 |
|---|---|
| `CTM_AUTH_STATE_RAW` | 腾讯会议登录态完整 JSON（`auth_state.json` 的内容） |
| `IMA_CLIENT_ID` | IMA 开放平台 client_id |
| `IMA_API_KEY` | IMA 开放平台 api_key |
| `WECOM_WEBHOOK_URL` 或 `WECOM_WEBHOOK` | 企业微信机器人完整 Webhook URL |

> 凭证只在运行时注入 Runner 临时目录，跑完即销毁，**不进 git**。

## 手动触发

Actions 页面 → 选 workflow → `Run workflow`，可指定 `mode=inc|daily` 与 `date=YYYY-MM-DD` 补跑历史。

## 重新授权（登录态过期时）

腾讯会议登录态每次运行自动续期（约 7 天）。若长时间未运行导致过期：
1. 在本机用浏览器登录 meeting.tencent.com，导出最新的 `auth_state.json`
2. 更新 `CTM_AUTH_STATE_RAW` Secret 为新内容
3. 手动触发一次 `daily` 或 `patrol` 验证

## 与云端版的差异

- 无常驻进程：每次运行是全新容器，没有"进程被平台重启导致漏跑"的问题
- 状态进 git：`daily/` 目录的提交历史即运行审计日志
- 凭证不落盘：靠 Secrets 注入，部署不会覆盖状态
