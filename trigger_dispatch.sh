#!/usr/bin/env bash
# 外部定时器（cron-job.org / 本机 crontab / 云函数）调用本脚本，
# 按北京时间准点触发 GitHub Actions 的 workflow_dispatch，绕开 GitHub 不可靠的内部 scheduler。
#
# 用法：
#   GH_DISPATCH_TOKEN=ghp_xxx  bash trigger_dispatch.sh [patrol|daily|all]
#   缺省 = all（两个都触发）
#
# 所需 token：具备 actions:write 权限（fine-grained PAT 选本仓库 Actions: Read and write；
#   或 classic PAT 含 repo/workflow）。注意：不要用那只待撤销的 classic PAT。
#
# 幂等说明：两次触发（如外部 + 手动）无害，管线为增量模式，重复窗口自动跳过。

set -euo pipefail

TOKEN="${GH_DISPATCH_TOKEN:?请先设置环境变量 GH_DISPATCH_TOKEN（具备 actions:write 的 token）}"

OWNER="vip198926"
REPO="tencent-meeting-auto"
REF="master"
WHAT="${1:-all}"

trigger() {
  local wf="$1"
  local url="https://api.github.com/repos/$OWNER/$REPO/actions/workflows/$wf/dispatches"
  echo "==> 触发 $wf ($url)"
  curl -sS -o /dev/null -w "HTTP %{http_code}\n" -X POST \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    -H "Content-Type: application/json" \
    -d "{\"ref\":\"$REF\",\"inputs\":{}}" \
    "$url"
}

if [ "$WHAT" = "patrol" ] || [ "$WHAT" = "all" ]; then
  trigger patrol.yml
fi
if [ "$WHAT" = "daily" ] || [ "$WHAT" = "all" ]; then
  trigger daily.yml
fi

echo "完成。"
