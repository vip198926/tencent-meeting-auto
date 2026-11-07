# 腾讯会议 · 录制/转写自动导出（tencent-meeting-auto）

[English](./README.en.md) | **简体中文**

> 一键把腾讯会议已结束会议的**录制 / 转写逐字稿**导出为 Markdown → 自动上传 **IMA 知识库** → 企业微信每日简报。
> 跑在 GitHub Actions 上：**无需服务器、无需浏览器**，增量去重、登录态自轮换。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![GitHub Actions](https://github.com/vip198926/tencent-meeting-auto/actions/workflows/daily.yml/badge.svg)](https://github.com/vip198926/tencent-meeting-auto/actions)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**关键词**：腾讯会议 · 会议纪要 · 逐字稿 · 转写导出 · 录制下载 · IMA 知识库 · 企业微信通知 · GitHub Actions 自动化

**English**：Auto-export Tencent Meeting recordings & transcripts to Markdown, upload to IMA knowledge base, and push a daily digest via WeCom — fully automated on GitHub Actions (no server, no browser).

---

把**腾讯会议**里已结束会议的**录制 / 转写（逐字稿）**自动抓取下来，整理成 Markdown，上传到 **IMA 知识库**，并通过**企业微信机器人**推送每日简报。

- 纯 Node.js + 原生 `https`，**无需浏览器**即可抓取与续期登录态。
- 跑在 **GitHub Actions**（无常驻进程），状态与去重记录随仓库持久化。
- 登录态**每轮自动续期并回写 Secret**，解决"约 7 天必过期"的痛点。

> 个人自用自动化项目，按需修改使用。请遵守腾讯会议服务条款，仅处理你有权访问的会议。

---

## 目录

- [为什么做这个仓库](#为什么做这个仓库)
- [它解决什么问题 / 不解决什么](#它解决什么问题--不解决什么)
- [整条链路](#整条链路)
- [前置条件](#前置条件)
- [快速开始](#快速开始)
  - [1. 获取代码](#1-获取代码)
  - [2. 获取腾讯会议登录态](#2-获取腾讯会议登录态)
  - [3. 配置 IMA](#3-配置-ima)
  - [4. 配置企业微信 / PushPlus（可选）](#4-配置企业微信--pushplus可选)
  - [5. 写入 GitHub Secrets](#5-写入-github-secrets)
  - [6. 配置自动轮换令牌](#6-配置自动轮换令牌)
  - [7. 指向你自己的仓库 / 知识库](#7-指向你自己的仓库--知识库)
- [使用](#使用)
- [配置项一览](#配置项一览)
- [去重与选稿策略](#去重与选稿策略)
- [登录态维护与自动轮换](#登录态维护与自动轮换)
- [可选：自动收故事](#可选自动收故事)
- [目录结构](#目录结构)
- [故障排查](#故障排查)
- [安全与隐私](#安全与隐私)

---

## 为什么做这个仓库

腾讯会议的录制与转写散落在网页版「个人中心 → 历史会议」里，且有几点很别扭：

1. **录制要主持人手动开始，转写是会议开始就自动跑** —— 所以同一场会经常**同时存在"转写"和"录制"两份逐字稿，内容还不一致**（转写通常更短）。
2. 想长期沉淀，只能一场场手动点开、复制、保存，费时且容易漏。
3. 很多"自动转写"方案依赖常驻服务器，但个人服务器不稳定（进程被重启、凌晨离线漏跑）。
4. GitHub Actions 自带的定时（`schedule`）**没有 SLA**，实测延迟可达数小时，错过早晨的会议。

于是做一个**不依赖常驻进程、按需触发、自动去重、自动续期登录态**的管线：把会议记录自动落到自己的知识库，每天收到一份"哪几场会处理成功/失败"的简报。

---

## 它解决什么问题 / 不解决什么

**解决**
- 自动发现"上次处理之后结束的会议"，增量处理，不重复上传。
- 同一会议号下"转写 vs 录制"两份自动比对：内容相同留更全的一份，互补则合并，确属两场不同会议则都保留。
- 逐字稿 + AI 纪要一并落库到 IMA。
- 每轮推送简报（成功/失败/跳过/无录制），失败绝不安安静静。
- 登录态自动续期并回写 Secret，只要定期运行就不会掉登录。

**不解决 / 注意**
- **只处理"你有权访问"的会议**（你自己的账号能看到的录制/转写）。
- 会议列表接口**仅支持最近 31 天**，更早的会需要你已有分享链接单独抓。
- 依赖腾讯会议**网页版内部的非公开接口**，官方若改动接口，可能需要相应调整抓取逻辑。
- 需要自备腾讯会议账号、IMA 开放平台凭证；通知通道可选。

---

## 整条链路

```
外部定时器 / 手动 workflow_dispatch
        │
        ▼
GitHub Actions（ubuntu-latest，每次全新容器）
  ① checkout 仓库
  ② 把 Secret CTM_AUTH_STATE_RAW 写到 $RUNNER_TEMP/auth_state.json（仓库外，跑完删除）
  ③ node run.js inc | daily
        │
        ├─ refreshToken()            纯 HTTP 调 refresh-token，续期约 7 天，无需浏览器
        │
        ├─ runIncremental()          读 daily/last_progress.json.processed_until → now
        │      │                     （无进度则回看最近 24h；窗口起点 clamp 到 now-31d）
        │      ├─ query_personal_meeting_list(meeting_state=1)   拉已结束会议清单
        │      ├─ 对每场会 meeting-record-list                    查「转写 / 录制」记录
        │      ├─ 选稿：两份都抓 → 4-gram Jaccard 相似度
        │      │     ├─ ≥0.35 视为同一场 → 留内容更多者；互补(>15% 独有)则合并
        │      │     └─ <0.35 视为两场不同会议 → 各自独立上传
        │      ├─ fetchTranscript(record_id)                     取逐字稿 + AI 纪要
        │      │     （common-record-info → uni-record-id → minutes/detail）
        │      ├─ uploadMarkdown()                               COS 上传 + add_knowledge → IMA
        │      └─ 写 daily/records_<tag>.md|.json、推进 progress、record_id 去重
        │
        ├─ 企业微信 / PushPlus 推日报（成功简报 / 失败详情）
        │
        ▼
  ④ git commit daily/ 状态文件并 push（去重记录 + 进度）
  ⑤ 自动轮换：把运行时刷新后的 auth_state 加密回写 Secret CTM_AUTH_STATE_RAW
  ⑥ 删除临时登录态
```

核心设计取舍：

| 设计 | 原因 |
|---|---|
| 无常驻进程，用 Actions | 避免个人服务器重启/离线漏跑 |
| 状态进 git（`daily/`） | 天然审计日志，天然持久化，无需外部数据库 |
| 只按 `record_id` 去重 | 同一会议号下可能是**多场内容不同的会**，不能按 meeting 去重 |
| 登录态每轮回写 Secret | Secret 是静态快照，Actions 不回写就约 7 天必过期 |
| 内置 cron 默认注释 | GitHub `schedule` 延迟大，改用外部定时器精确触发 |

---

## 前置条件

- 一个 **GitHub 账号**（可建私有仓库 / 可跑 Actions）。
- 一个**腾讯会议账号**（个人版即可；注意会议列表仅最近 31 天）。
- **IMA 开放平台**的 `client_id` / `api_key`（以及你要投放的**知识库 ID / 文件夹 ID**）。
- **本地 Node.js 20+**（本地运行或生成登录态时用）。
- 可登录腾讯会议的**浏览器**（Chrome / Edge，用于获取登录态）。
- 通知通道（可选）：**企业微信机器人 Webhook** 或 **PushPlus token**。

---

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/<你的用户名>/tencent-meeting-auto.git
cd tencent-meeting-auto
npm install          # 目前仅依赖 tweetsodium（写 Secret 用）
```

> 若你是从本仓库 Fork 的：**先做第 7 步**（把 IMA 知识库/文件夹指到你自己的）。仓库名不用改——代码读的是 Actions 自带的 `GITHUB_REPOSITORY`。

### 2. 获取腾讯会议登录态

管线全部基于**网页登录态**（一份 `auth_state.json`，本质是浏览器的 storage state，关键包含 `we_meet_token`、`account_corp_id` 等 cookie）。

**方式一：登录助手脚本（推荐）**

项目附带 `login_auth.js`（需要 `playwright-core` 和本地 Edge/Chrome）：

```bash
npm install playwright-core
node login_auth.js
# 会弹出可见浏览器窗口 → 扫码登录腾讯会议 → 脚本检测到有效 token 后
# 自动验证 API 并写出 auth_state.json，控制台打印 DONE_OK
```

**方式二：手动导出（无脚本时）**

1. 用 Chrome/Edge 登录 <https://meeting.tencent.com>。
2. `F12` → **Application / 应用** → **Cookies** → `https://meeting.tencent.com`。
3. 尽量导出该域下**全部** cookie（至少要有 `we_meet_token`、`account_corp_id`；有 `expires` 的填 Unix 秒）。
4. 拼成如下 JSON 存为 `auth_state.json`：

```json
{
  "cookies": [
    { "name": "we_meet_token", "value": "<...>", "expires": 1762000000 },
    { "name": "account_corp_id", "value": "<...>" }
  ],
  "origins": []
}
```

> 手动方式容易漏 cookie 导致接口 401/登录失败，优先用方式一。

### 3. 配置 IMA

准备三样东西：

- `client_id`、`api_key`：IMA 开放平台凭证。
- **知识库 ID**（`kbId`）与**文件夹 ID**（`folderId`）：你想把逐字稿放进去的位置。

它们会通过环境变量 / Secret 注入（见下），同时**代码里还有硬编码的默认值需要你替换**（第 7 步）。

### 4. 配置企业微信 / PushPlus（可选）

- **企业微信**：群机器人 → 复制 Webhook（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`）。
- **PushPlus**：微信扫码登录 pushplus.plus，复制 token。
- 两者都不配则静默跳过，不影响主流程。

### 5. 写入 GitHub Secrets

仓库 **Settings → Secrets and variables → Actions**，添加：

| Secret | 是否必需 | 说明 |
|---|---|---|
| `CTM_AUTH_STATE_RAW` | ✅ | `auth_state.json` 的**完整文本内容** |
| `IMA_CLIENT_ID` | ✅ | IMA client_id |
| `IMA_API_KEY` | ✅ | IMA api_key |
| `WECOM_WEBHOOK` | ⬜ | 企业微信机器人完整 URL（可选） |
| `SECRETS_WRITE_PAT` | ✅（用自动轮换时） | 用于每轮回写登录态的 PAT，见第 6 步 |

**用脚本一次性写入**（省得手贴，且能保证格式）：

```bash
# 先在本地准备：
#   auth_state.json
#   ima_creds.json   = { "client_id": "...", "api_key": "..." }
#   wecom_webhook.json = { "webhook": "https://qyapi.weixin.qq.com/..." }   # 可选
GITHUB_PAT=<你的PAT> node set_secrets.js
```

> `set_secrets.js` 用 `tweetsodium`（libsodium sealedbox）加密后写 Secret，明文不会进仓库或日志。

### 6. 配置自动轮换令牌

`SECRETS_WRITE_PAT` 是**运行时**用来把刷新后的登录态写回 `CTM_AUTH_STATE_RAW` 的令牌（否则只能靠手动更新，约 7 天必过期）。

推荐建一个 **fine-grained PAT**：

- **Repository access**：仅选你的这个仓库。
- **Repository permissions**：
  - `Secrets`: **Read and write**（轮换登录态用）
  - `Actions`: **Read and write**（如果也用它来触发 workflow）
- **Expiration**：设为**长周期 / 无过期**（否则它到期 → 轮换中断 → 约 7 天后掉登录）。

把它写进 `SECRETS_WRITE_PAT`（也可用 `rotate_secret.js` 写：`GITHUB_PAT=<pat> SECRET_NAME=SECRETS_WRITE_PAT AUTH_SRC=<含pat的文件> node rotate_secret.js`）。

### 7. 指向你自己的仓库 / 知识库

**仓库名无需改**：`rotate_secret.js` / `set_secrets.js` 读 Actions 自带的 `GITHUB_REPOSITORY`（`owner/repo`），Fork 后自动指向你自己的仓库。本地跑（无该变量）时回退到作者默认值。

**IMA 要指到你自己的库**（否则会上传到作者的知识库或直接失败）。两种方式，任选：

| 方式 | 做法 |
|---|---|
| 环境变量（推荐） | 在 Actions 里设 Repository variables `IMA_KB_ID` / `IMA_FOLDER_ID`；本地跑则 `IMA_KB_ID=xxx IMA_FOLDER_ID=yyy node run.js inc` |
| 改代码常量 | 直接改 `ima_upload.js` 里的 `DEFAULT_KB_ID` / `DEFAULT_FOLDER_ID` 默认值 |

> 优先级：环境变量 > 代码默认值。两个 ID 的获取方式见 [第 3 步](#3-配置-ima)。

---

## 使用

### 手动触发（Actions 页面）

仓库 **Actions** → 选 workflow → **Run workflow**：

- **每日管线** `daily.yml`：`mode=inc`（增量，默认）或 `mode=daily` + `date=YYYY-MM-DD`（按天补历史）。
- **巡检补跑** `patrol.yml`：固定跑一轮增量，附带登录态剩余天数 / 积压预警。

### 本地运行

```bash
# 增量（处理「上次截止 → 现在」结束的会）
CTM_AUTH_STATE=./auth_state.json \
IMA_CLIENT_ID=xxx IMA_API_KEY=yyy \
node run.js inc

# 按天补跑某一天
CTM_AUTH_STATE=./auth_state.json \
node run.js daily 2026-10-21
```

不加通知：`node daily_records.js inc --no-notify`。

### 定时触发（推荐用外部定时器）

Actions 自带 `schedule` 默认是**注释掉的**（GitHub 定时不可靠，实测延迟数小时）。推荐用 **cron-job.org / 云函数 / 本机 crontab** 定时调用 `workflow_dispatch`：

```bash
# 用项目里的脚本（需具备 actions:write 的令牌）
GH_DISPATCH_TOKEN=<你的PAT> bash trigger_dispatch.sh all
#   all / patrol / daily 三选一
```

对应 API：

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/daily.yml/dispatches
```

> 若你确实想用 GitHub 内置 cron，把两个 workflow 里 `# schedule:` 的注释放开即可（`patrol: 36 19 * * *` = 北京 03:36；`daily: 36 1 * * *` = 北京 09:36），但请接受其延迟。

---

## 配置项一览

**GitHub Secrets**：见 [第 5 步](#5-写入-github-secrets)。

**运行时环境变量**（由 workflow 注入，一般无需手动设）：

| 变量 | 作用 |
|---|---|
| `CTM_AUTH_STATE` | `auth_state.json` 路径（workflow 指向 `$RUNNER_TEMP`） |
| `CTM_AUTH_STATE_RAW` | 登录态 JSON 原文（`run.js` 会写出到 `CTM_AUTH_STATE`） |
| `IMA_CLIENT_ID` / `IMA_API_KEY` | IMA 凭证 |
| `IMA_KB_ID` / `IMA_FOLDER_ID` | 上传目标知识库 / 文件夹（可选，覆盖代码默认值；Fork 者设这两个即可） |
| `GITHUB_REPOSITORY` | Actions 自动注入（`owner/repo`），`rotate_secret.js` / `set_secrets.js` 用它定位仓库 |
| `WECOM_WEBHOOK` | 企业微信机器人 URL（可选） |
| `PUSHPLUS_TOKEN` | PushPlus token（可选） |
| `SOURCE` | 调用来源标识：`patrol` / `daily`（决定简报标题与预警） |
| `GITHUB_PAT` / `GITHUB_PAT_FILE` | `rotate_secret.js` 写 Secret 用的令牌（后者从文件读，避免明文进命令行） |
| `SECRET_NAME` | 要写入的 Secret 名，默认 `CTM_AUTH_STATE_RAW` |
| `AUTH_SRC` | `rotate_secret.js` 的登录态来源文件 |

**代码内默认值**（可被环境变量覆盖，不必改代码）：`OWNER`/`REPO`（← `GITHUB_REPOSITORY`）、`DEFAULT_KB_ID`（← `IMA_KB_ID`）、`DEFAULT_FOLDER_ID`（← `IMA_FOLDER_ID`）。

---

## 去重与选稿策略

**去重**：只按 `record_id`（录制/转写记录的唯一 ID）。已处理的 `record_id` 记在 `daily/processed_records.json`，增量窗口重叠也不会重复上传。

> 为什么**不**按会议号去重：腾讯会议会把**同一会议号下的多场不同会议**都归到同一个 `meeting_id`，按会议号去重会误删真实内容（实测两场会正文重叠可低至 0.8%）。

**选稿**（同一会议号同时有「转写」和「录制」两份时）：

1. 两份都抓取成文本。
2. 计算字符 **4-gram Jaccard 相似度** `sim`：
   - `sim ≥ 0.35` → 视为**同一场会**：保留**内容更多**的一份（通常录制更全）；若短份含有长份缺失的 >15% 内容（互补），则**合并去重**后存一份。
   - `sim < 0.35` → 视为**两场不同会议**：两份**各自独立上传**，互不合并、互不丢弃。
3. 只有一类记录 → 直接上传。

---

## 登录态维护与自动轮换

腾讯会议网页登录态的 `we_meet_token` 默认约 **7 天**过期。本项目的处理方式：

- **每轮**运行前调用 `refresh-token` 接口续期约 7 天（纯 HTTP，无需浏览器）。
- 运行结束后，`rotate_secret.js` 把**刷新后的登录态**用 libsodium 加密**回写**到 Secret `CTM_AUTH_STATE_RAW`。
- 因此：**只要每 ≤7 天跑一次，就永远不会掉登录**（每次都会续期并落盘）。

**登录态彻底失效**（`refresh-token` 返回 `-51003`）：HTTP 续期救不回，必须**人工重新扫码**——用 [第 2 步](#2-获取腾讯会议登录态) 的方式重新生成 `auth_state.json`，再更新 Secret：

```bash
GITHUB_PAT=<你的PAT> node set_secrets.js     # 或只更新 CTM_AUTH_STATE_RAW
```

---

## 可选：自动收故事

这是一个**默认关闭**的可选环节。凭证未配齐时 `story_collect.js` 静默跳过，会议转写管线行为完全不变。

开启后，**两条 workflow**（`daily.yml` 每日管线 09:36 / `patrol.yml` 巡检 03:36）上传逐字稿的同时，都会把正文交接给同一次运行里的收故事步骤：规则召回候选段落 → LLM 抽取结构化故事 → **原话逐字命中校验** → 增量追加到两份飞书文档 → 打 IMA 标签记账。逐字稿不进仓库、不进日志、不进 artifact。

> 两条都必须收：巡检与每日管线共用增量进度和去重表，巡检上传的稿到 09:36 已被记为「已处理」，不会再交接一次。收故事只吃本轮新上传的稿；`mode=daily` 补历史日期因去重跳过，同样收不到故事。

### 企业微信通知（转写与收录合并为一条）

`daily.yml` 与 `patrol.yml` 都把各自日报先暂存到 `$RUNNER_TEMP/ctm_report.json`，等收故事结束后由 `send_report.js` 把收录结果并进**同一条消息**推送：转写明细 + 一行收录结果（处理份数 / 新增故事数 / 无稿 / 失败 / 缺凭证）。收故事无论成功、失败、未配凭证、无新增稿，都会在日报里出现，绝不静默；统一推送步骤 `if: always()`，且不会再单独发一条简报，避免刷屏。巡检仍保留原有「🔍 巡检简报」标题、登录态剩余天数与积压预警，只是多一行收录结果。

只有这两个 workflow 设置了 `CTM_REPORT_FILE` 才走合并模式；本地运行未设置，仍按原方式立即推送，行为不变。三个交接文件（日报 / 逐字稿 / 收录结果）都在 runner 临时目录，运行结束即删除。

### 需要新增的 Secrets

| Secret | 用途 |
|---|---|
| `LLM_API_KEY` | LLM API Key（OpenAI 兼容格式） |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书自建应用凭据 |
| `FEISHU_DOC_PEOPLE` / `FEISHU_DOC_EFFECT` | 两份飞书文档的 `document_id`（从文档 URL 里取） |
| `STORY_NOTE_ID` | IMA 索引笔记的 `note_id` |
| `STORY_KB_ID` | IMA 知识库 ID（可选，不设则用 `IMA_KB_ID` 或默认库） |

### LLM 配置（Repository Variables）

| Variable | DeepSeek | 阿里云百炼 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `LLM_MODEL` | `deepseek-flash`（也可 `deepseek-v4-pro`） | `qwen-plus` |

`LLM_API_KEY` 必须与所选厂商一致——**换厂商时这个 Secret 也要换**。两个 Variable 都不填时默认走 DeepSeek `https://api.deepseek.com` + `deepseek-flash`。任何 OpenAI 兼容的 `/chat/completions` 端点都能用；DeepSeek 端点会自动发送 `thinking: disabled`，避免默认思考模式吞掉输出预算、使 `temperature` 失效。

### 飞书授权三步（缺一不可）

1. 在飞书开放平台建自建应用，开通 `docx:document:readonly` 与 `docx:document:write_only`，发布版本。
2. 把应用的 bot 加为**两份文档**的协作者（可编辑）。只开 API 权限、不加协作者会返回 403。
3. 把 App ID / App Secret 填进上面两个 Secret。

### 质量护栏

- **原话硬校验**：LLM 返回的每条引文必须在逐字稿里逐字命中，否则整条丢弃、不写入飞书。这是对「不许编造」的机器可执行兜底。
- **不 overwrite**：只用 `children` 追加块到文档末尾，绝不重写 38 万字原文；每次追加用确定性 `client_token` 保证重试幂等。
- **失败不打标签**：任何一步失败都不打「故事已收」，下轮按 `record_id` 重抓正文自动重试。
- **台账** `daily/story_state.json` 只存内容指纹、`media_id`、`record_id`、`block_id` 与时间戳，不含人名、原话、会议主题。

### v1 的边界

人物篇与效果故事**一律追加到文档末尾**，不改目录锚点、不改章节条数、不做「并入老条目」的语义合并。理由：那需要解析 38 万字既有文档并做原地改写，无人值守下风险远高于收益。判重靠内容指纹台账。

### 隐私提醒

开启此功能等于把会议逐字稿（含真实姓名、健康状况、消费信息）发送给**第三方 LLM 服务商**，属于数据出域。与仓库是否公开无关。请确认所选厂商的 API 数据处理条款，并仅处理你有权处理的会议内容。

## 目录结构

```
.
├── .github/workflows/
│   ├── daily.yml          # 每日管线（增量 / 按天补跑）
│   └── patrol.yml         # 巡检补跑（增量 + 预警）
├── daily/                 # 运行状态（随仓库提交）
│   ├── last_progress.json # 增量进度 processed_until
│   └── processed_records.json  # 已上传 record_id（去重）
├── run.js                 # Actions 入口：读登录态 → 续期 → 管线
├── daily_records.js       # 增量/按天管线、会议拉取、选稿、去重、日报
├── ctm_fetch.js           # 抓取单条录制/转写 → 逐字稿 + AI 纪要
├── token_refresh.js       # 纯 HTTP 续期登录态
├── ima_upload.js          # 上传 Markdown 到 IMA 知识库
├── wecom_webhook.js       # 企业微信机器人推送
├── pushplus.js            # PushPlus 推送（可选备选通道）
├── login_auth.js          # 本地扫码登录 → 导出 auth_state.json
├── set_secrets.js         # 一次性：把凭证加密写入 Repo Secrets
├── rotate_secret.js       # 每轮：把刷新后的登录态加密回写 Secret
└── trigger_dispatch.sh    # 外部定时器触发 workflow_dispatch
```

> `auth_state.json`、`ima_creds.json`、`wecom_webhook.json`、`pushplus.json`、`daily/records_*`、`daily/run_log.jsonl` 均已在 `.gitignore`，**不会进仓库**。

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `10100001 请先登录` / `Error auth key not found` | 登录态失效。重新生成 `auth_state.json` 并更新 `CTM_AUTH_STATE_RAW` |
| `refresh-token` 返回 `-51003` | token 彻底失效，HTTP 续期无效 → 人工扫码重新登录 |
| `workflow_dispatch` 返回 **403** | 触发令牌缺 `Actions: write` 权限 |
| 写 Secret 报 403/401 | `SECRETS_WRITE_PAT` 缺 `Secrets: Read and write`，或已过期 |
| 会议列表为空 | 接口仅支持最近 31 天；也确认账号确实有已结束会议 |
| IMA 上传 `code=220004` | 知识库 ID 变了/无权限，更新 `DEFAULT_KB_ID` |
| IMA 上传 `code=110021/110010` | 频控，脚本会自动退避重试 |
| 状态提交 push 冲突 | 两个 workflow 并发；workflow 内已带 `pull --rebase` + 重试 |
| 轮换步骤 `::warning::` | `SECRETS_WRITE_PAT` 无效/过期；不影响本次会议处理，但需尽快修复 |

---

## 安全与隐私

- **凭证不落盘**：只存在于 GitHub Secrets 与 Runner 临时目录（`$RUNNER_TEMP`），跑完即删；`.gitignore` 屏蔽所有本地凭证文件。
- **Public 仓库也安全**：仓库 Secrets 仅协作者可见，Fork / PR **无法读取**；从 Fork 发起的 PR 默认拿不到 Secrets。
- **PAT 建议**：fine-grained、仅授权本仓库、`Secrets: write`（+ `Actions: write`），设**长周期/无过期**并定期轮换。
- **会议内容属隐私**：默认不把逐字稿提交进仓库（只提交去重 ID 与进度）；如需审计请自行评估。
- **公开的 Actions 日志**：public 仓库的 run 日志任何人可见。所有代码都只打印数量与错误码，不打印逐字稿、LLM 输出、飞书响应或人名；`story_collect.js` 的台账也只写指纹与不透明 ID。若你要加日志，务必保持这条约束。
- **workflow 触发器**：只有 `workflow_dispatch`，没有 `pull_request` / `push`。外部 PR 不会触发带 Secrets 的运行。改动触发器前先评估这一条。
- 本项目依赖腾讯会议**非公开网页接口**，请仅用于**你有权访问**的会议，遵守相关服务条款。

---

## 许可

[MIT](./LICENSE) © vip198926

可自由使用、修改、分发（含商用），保留版权声明即可。软件按"现状"提供，使用风险自负。
