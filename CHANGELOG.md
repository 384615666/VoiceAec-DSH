# Changelog

## 1.0.0 — 2026-11-15

首个正式版本。

### 新增

- 语音输入回声消除：宿主用 Core Audio process tap 回采系统播放声音，页面内 AudioWorklet
  自适应滤波把外放回声从麦克风里减去，录音时视频照常播放；
- 输入框下方状态胶囊：显示已开启/已关闭、参考声就绪/静默、录音中的实时抑制量；
- 语音输入未启用时胶囊变黄并可直接跳转到对应 Plugins 页面；
- `GET /api/voiceaec/status` 与 `GET /api/voiceaec/reference` 两个本地接口；
- 回采进程按需启动、空闲 20 秒自动退出、异常自动重启；
- 操作手册（docs/manual.md）与离线 AEC 回归脚本（docs/aec-regression.mjs）。

### 兼容性

- DeepSeek Harness 桌面端 0.2.1-rc.4；
- macOS 14.4 及以上（Apple Silicon 与 Intel 均可）；
- 需要官方语音输入插件 `@deepseek-ai/dsh-experimental-voice-input-bundle`，版本与 Harness 一致。

### 已知限制

- 仅 macOS；Windows 请使用 VoiceAec 桌面版 + VB-CABLE；
- 参考声跟随系统默认输出设备；
- 录音会额外引入约 160 ms 处理延迟（仅影响转写时间，不影响使用）。
