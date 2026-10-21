#!/usr/bin/env bash
# OpenCode 额度挂件安装脚本 — 把挂件装进 Hermes 的 TUI 挂件目录
# 用法: bash install.sh   （自定义 Hermes 主目录: HERMES_HOME=/path bash install.sh）
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/opencode-balance.mjs"
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
DEST_DIR="$HERMES_HOME_DIR/tui-widgets"
DEST="$DEST_DIR/opencode-balance.mjs"

[ -f "$SRC" ] || { echo "错误: 找不到 $SRC" >&2; exit 1; }
command -v hermes >/dev/null 2>&1 || \
  echo "提示: 未找到 hermes 命令 —— 确认已安装 Hermes Agent (https://hermes-agent.nousresearch.com)"

mkdir -p "$DEST_DIR"

if [ -f "$DEST" ]; then
  BAK="$DEST.bak.$(date +%Y%m%d%H%M%S)"
  cp "$DEST" "$BAK"
  echo "已备份原挂件 → $BAK"
fi

cp "$SRC" "$DEST"
echo "已安装 → $DEST"

# 检查 key（仅在未配置时提醒，不阻塞安装）
if ! grep -qs 'OPENCODE_\(ZEN\|GO\)_API_KEY' "$HERMES_HOME_DIR/.env" && \
   [ -z "${OPENCODE_ZEN_API_KEY:-}${OPENCODE_GO_API_KEY:-}" ]; then
  cat <<'EOF'
⚠  未检测到 OPENCODE_ZEN_API_KEY / OPENCODE_GO_API_KEY
   在 ~/.hermes/.env 里加一行后 /widgets-reload:
     OPENCODE_ZEN_API_KEY=你的key   # Zen 钱包余额
     OPENCODE_GO_API_KEY=你的key   # Go 订阅额度
   (只填一个也能用)
EOF
fi

cat <<'EOF'
完成。打开 hermes --tui 执行 /widgets-reload 加载;
挂件自动停靠在状态栏上方, /ocbal 切换显示/收起。
EOF
