# Agy HUD

Real-time telemetry HUD sidecar plugin for **Google Antigravity**, docked in the right auxiliary pane.

**Agy HUD** 是面向 Antigravity 桌面端的右侧辅助栏实时监控插件，零外部依赖，全本地只读统计。

---

## Features / 功能特性

- **Model Generation Speed (tok/s)** / **按模型生成速度**
  - Displays full model family names (merging reasoning tiers and Orchestrator wrappers into the underlying model) with live `当前活跃` badges strictly for models actively generating right now (`Last` and weighted `Avg 20`, excluding TTFT).
  - 展示完整模型名（自动合并思考层级与 Orchestrator 包装），仅在模型实时生成时高亮显示 `当前活跃` 标记，其余行展示本会话使用过的模型与纯生成速度（已扣 TTFT）。
- **Context Window & `/compact` Tracking** / **上下文与压缩感知**
  - Shows exact `cached / fresh / estimated` bar segments, thinking token share (`思考占输出 XX%`), remaining headroom, and subagent / Swarm member inspection.
  - Detects in-progress and just-completed `/compact` checkpoints immediately with post-compaction size estimation until the next turn.
- **5-Minute Reference Cache Countdown** / **缓存保鲜倒计时**
  - Live 1s elapsed/remaining indicator (`< 3m` hot, `3–5m` critical, `>= 5m` likely expired) to help decide when to run `/compact`.
- **5h Rolling Quota Pools** / **配额监控**
  - Displays real remaining/used percentages and reset countdowns for `Gemini` and `Claude & GPT` 5h windows (click to toggle `剩余 / 已用`).
- **Local Desktop Usage & API USD Value** / **桌面端用量与折算价值**
  - Incrementally scans local Antigravity Desktop `transcript.jsonl` logs across `Today / 7d / 30d`, merging cache hit rate, stacked bar chart, top models, and official API USD equivalent.
  - Editable pricing table in `sidecars/hud/pricing.json` (with scheduled rate tiers).

---

## Installation / 安装

### From GitHub / 通过 GitHub 安装

```bash
agy plugin install https://github.com/liuyejinghong/agy-hud
```

### Local Development / 本地校验与安装

```bash
agy plugin validate --strict .
agy plugin install .
```

After enabling **Agy HUD** in Antigravity Customizations, open the right auxiliary pane and click `+` (or switch tabs) to open **Agy HUD**.

---

## Privacy & Architecture / 隐私与实现边界

- **Zero external network calls**: talks only to the local Antigravity Language Server (`ANTIGRAVITY_LS_ADDRESS`) and reads local Antigravity Desktop files (`~/.gemini/antigravity`).
- **Zero npm dependencies**: pure Node.js ESM backend + vanilla HTML/CSS/JS synced to Antigravity host theme CSS variables.
- **Cross-platform sqlite fallback**: inspects `conversation_summaries.db` when `sqlite3` is available and gracefully falls back to trajectory / Swarm discovery when absent.

## License

[MIT](LICENSE)
