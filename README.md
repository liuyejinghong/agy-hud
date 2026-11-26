# Agy HUD

Real-time telemetry HUD sidecar plugin for **Google Antigravity**, docked in the right auxiliary pane.

**Agy HUD** 是面向 Antigravity 桌面端的右侧辅助栏实时监控插件，零外部依赖，全本地只读统计。

---

## Features / 功能特性

- **Model Generation Speed (tok/s & TTFT)** / **按模型生成速度与首字延迟**
  - Displays full model family names (merging reasoning tiers and Orchestrator wrappers into the underlying model) with live `Active` / `当前活跃` badges strictly for models actively generating right now (`Last` and weighted `Avg 20` speed excluding TTFT, with per-call & average TTFT in tooltips).
  - 展示完整模型名（自动合并思考层级与 Orchestrator 包装），仅在模型实时生成时高亮显示 `当前活跃` 标记，悬停可查看 `Last` 首字延迟与 `Avg 20` 均首字延迟。
- **Context Window, Smart `/compact` Nudge & Subagents** / **上下文、智能压缩提醒与子代理**
  - Shows `cached / fresh / estimated` bar segments, thinking token share (`Think XX%` / `思考占输出 XX%`), remaining headroom, and subagent / Swarm member inspection (with one-click `Trend →` / `看趋势 →` jump).
  - Detects in-progress and just-completed `/compact` checkpoints immediately, pauses the 5-minute reference cache timer while active, and suggests `/compact` when context `>= 75%` and the cache has gone cold (`>= 5m` idle).
- **Interactive Context Trend Curve** / **交互式上下文曲线**
  - Hover anywhere along the curve for per-step readout (`#step · Model · Context (Δ) · Output · Speed · TTFT`), highlights `/compact` checkpoints and `>= 30K` single-step spikes, and includes a dedicated `TTFT` / `首字` column in the detail table.
- **5h & Weekly Quota Pools (with Manual Refresh)** / **配额监控（5h 与周限额 + 手动刷新）**
  - Displays authoritative remaining/used percentages and reset countdowns for both 5-hour and weekly buckets across `Gemini` and `Claude & GPT` via `RetrieveUserQuotaSummary` (with `GetCascadeModelConfigData` fallback, click to toggle `Left / Used`, plus an instant `↻` refresh button).
- **Session & Desktop Usage + API USD Value** / **本会话与桌面端用量 / 折算价值**
  - Switch between **Session** (`本会话`, breaking down Main vs Subagents tokens & USD cost) and **All** (`全部`, incrementally scanning local Antigravity Desktop `transcript.jsonl` across `Today / 7d / 30d`), with unified model names, cache hit rate, and editable pricing table (`sidecars/hud/pricing.json`, showing update date in the footer).
- **Bilingual UI (`中 / EN`)** / **中英文即时切换**
  - One-click `EN` / `中` toggle in the header persisted to `localStorage`, defaulting to your system language.

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
