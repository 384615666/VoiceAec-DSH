# VoiceAec for DeepSeek Harness · 操作手册

| | |
| --- | --- |
| 插件版本 | 0.1.0 |
| 适用环境 | DeepSeek Harness 桌面端 0.2.1-rc.4 · macOS 14.4+ |
| 前置插件 | `@deepseek-ai/dsh-experimental-voice-input-bundle`（官方语音输入） |
| 仓库 | <https://github.com/384615666/VoiceAec-DSH> |

> 一句话用法：**开着视频，点麦克风，直接说话。** 不用暂停播放，转写里不会混进视频声。

## 目录

1. [它是什么](#1-它是什么)
2. [开始之前](#2-开始之前)
3. [安装](#3-安装)
4. [首次配置](#4-首次配置)
5. [日常使用](#5-日常使用)
6. [状态胶囊](#6-状态胶囊)
7. [故障排查](#7-故障排查)
8. [资源占用与生命周期](#8-资源占用与生命周期)
9. [隐私](#9-隐私)
10. [升级与卸载](#10-升级与卸载)
11. [FAQ](#11-faq)
- [附录 A：状态接口字段](#附录-a状态接口字段)
- [附录 B：开发者自检](#附录-b开发者自检)
- [附录 C：已知问题](#附录-c已知问题语音输入插件版本门槛)

---

## 1. 它是什么

语音输入用的是浏览器麦克风。外放时，视频/音乐声会一起被录进去，转写结果被污染。

这个插件在录音的同时，让 Harness 宿主回采系统正在播放的声音（macOS Core Audio
process tap），再在页面里用自适应滤波器把它从麦克风信号里减掉，然后才交给 SenseVoice 识别：

```
 视频/音乐 ──► 扬声器 ──► 麦克风（串音）
    │                        │
    │ Core Audio tap         │ getUserMedia（插件接管）
    ▼                        ▼
 Host: 16 kHz 参考流 ──► Client: AudioWorklet AEC ──► 语音输入 → SenseVoice → 草稿
```

**能做**

- 录音期间视频照常播放、照常有声音；
- 语音输入拿到的麦克风信号先做回声消除；
- 胶囊上能看到参考声是否正常、实时消除了多少 dB。

**不做**

- 不装虚拟声卡、不改系统音频设备；
- 不是 Hi-Fi 回声消除（面向语音识别，约 12 dB 抑制）；
- 不支持 Windows（Windows 请用 VoiceAec 桌面版 + VB-CABLE）。

---

## 2. 开始之前

逐项确认：

1. **系统**：macOS 14.4 或更高（「关于本机」可看版本）。
2. **Harness**：桌面端能正常打开会话、能看到输入框。
3. **语音输入**：Plugins 里 `Voice input`（`dsh-experimental-voice-input-bundle`）已启用，
   且 SenseVoice 模型已下载（插件详情里「Download and prepare」跑完）。
   - 输入框里能看到麦克风图标 = 就绪。
   - 如果点了麦克风只弹「先配置语音输入」，说明模型还没准备好。
4. **外放**：音箱/电视是系统默认输出设备，视频声从那里出来。

> 语音输入本身是可选的官方实验插件。没装它，本插件的胶囊会显示，但没有可接管的录音链路。

---

## 3. 安装

### 3.1 获取代码

```bash
git clone https://github.com/384615666/VoiceAec-DSH.git
```

放在一个不会被清理的目录（插件以 `link:` 方式进 profile，路径别乱动）。

### 3.2 安装到当前 profile

在 Harness 里对 Agent 说一句：

> 把 `/path/to/VoiceAec-DSH` 作为 bundle 安装到当前 profile

Agent 会调用 `plugin_manager` 的 `install_bundle`，等价于：

```jsonc
{ "action": "install_bundle", "target": "/path/to/VoiceAec-DSH" }
```

安装成功会看到 `application: applied`，profile 的 `dsh.profile.bundles` 里多出 `dsh-voiceaec`。

### 3.3 重启并自检

1. 完全退出 DeepSeek Harness，再打开；
2. 打开任意会话，输入框下方应出现 **「回声消除」胶囊**；
3. 命令行自检（端口以 Harness 实际为准，`DSH_WEB_URL` 里有）：

   ```bash
   curl -s http://127.0.0.1:<port>/api/voiceaec/status
   ```

   期望 `"supported": true`、`"running": false`（没录音时）、`"clientMounted": true`。

---

## 4. 首次配置

### 4.1 语音输入模型

如果还没下载：Plugins → Voice input → 插件详情 → **Download and prepare**。
SenseVoice 运行时约 200 MB，下载一次之后离线可用。

### 4.2 系统音频录制授权

第一次真正开始回采时，macOS 可能弹出「DeepSeek Harness 想要录制系统音频」：

- 点 **允许**：参考声正常；
- 没弹窗：通常表示此前已授权，或被系统策略放行；
- 误点拒绝：胶囊会一直显示「参考声静默」，到
  **系统设置 → 隐私与安全性 → 屏幕与系统音频录制** 里勾上 DeepSeek Harness，
  然后重启 Harness。

### 4.3 确认参考声

播放一段视频，胶囊应变为「参考声就绪」（绿点）。若显示「参考声静默」（黄点）：

- 视频/系统是不是静音了？
- 播放设备是不是系统默认输出（见 [7. 故障排查](#7-故障排查)）。

---

## 5. 日常使用

推荐流程：

1. **先放视频**（B 站、YouTube、本地播放器都行），音量正常；
2. 确认胶囊是开启状态（灰点表示已关闭，点一下打开）；
3. 点输入框里的 **麦克风** 图标，出现录音工具栏；
4. 直接说话；录音期间胶囊会显示 `-xx dB`（当前消除量）；
5. 说完点 **停止**，转写结果进入草稿；
6. 检查草稿，确认没混进视频声，按需编辑后发送。

小技巧：

- **先点麦克风再说**：AEC 需要约 1 秒收敛，开头 1 秒的抑制最弱；
- 视频音量越大、离音箱越近，消除量（dB）越高；
- 说短句时留 0.3 秒再点停止，避免尾音被切掉；
- 戴耳机时麦克风本来就没有串音，插件不会造成损伤（只是「无回声可消」）。

---

## 6. 状态胶囊

位置：输入框下方的提示行，默认在左侧「活动」「用量」之后。

| 显示 | 含义 | 建议 |
| --- | --- | --- |
| 灰点/绿点 · 已开启/已关闭 | 点击切换。关闭时走浏览器默认麦克风处理 | 需要消除回声就保持开启 |
| 绿点 · 已开启 · 点麦克风说话 | 一切就绪，等待语音输入录音 | 点输入框里的麦克风说话 |
| 黄点 · 语音输入未就绪 | 官方语音输入插件没生效（未启用或版本不匹配） | 点胶囊会跳到 Plugins 的 Voice input 页面 |
| 绿点 · 参考声就绪 | 回采进程在跑，且参考里有声音 | 正常 |
| 黄点 · 参考声静默 | 回采在跑，但没有声音 | 见 [7](#7-故障排查) |
| 绿点 · 已开启 + `-12 dB` | 正在录音，括号里是实时抑制量 | 正常 |
| 红点 · 不可用 | 非 macOS，或回采进程起不来 | 看 status 的 `error` |

胶囊的开关存在页面的 `localStorage` 键 `dsh.voiceaec.enabled`（`0` = 关闭）。

---

## 7. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 输入框下方没有「回声消除」胶囊 | 插件未安装/未启用；安装后没重启 | Plugins 里确认 `dsh-voiceaec` 已启用，重启 Harness |
| 胶囊红点「不可用」 | 不是 macOS 14.4+；回采进程启动失败 | `curl .../api/voiceaec/status` 看 `supported` 与 `error` |
| 胶囊黄点「参考声静默」 | 系统静音；视频静音；播放设备不是默认输出；未授权系统音频录制 | 解除静音；把播放设备设为默认输出；检查隐私授权；确认 `level > -70` |
| 点麦克风只弹「先配置语音输入」 | SenseVoice 模型没下载 | Plugins → Voice input → Download and prepare |
| 胶囊显示「语音输入未就绪」，麦克风图标不出现 | 语音输入插件未启用，或版本与 Harness 不匹配（0.1.7 vs 0.2.1） | 点胶囊跳到 Plugins 的 Voice input 页面启用/升级；或见 [附录 C](#附录-c已知问题语音输入插件版本门槛) |
| 胶囊只在「已开启·点麦克风说话」和「已关闭」之间切换 | 正常：没有录音时本来就只显示待机状态 | 点输入框里的麦克风开始录音后，胶囊才会显示 `-xx dB` |
| 转写里仍有视频声 | 参考延迟过大；双讲过强；参考设备不对 | 调低音量/换近一点的麦克风；确认胶囊有 dB 数字；确认参考声就绪 |
| 录音结果几乎是静音 | 音频上下文被挂起（极少见）；麦克风权限被拒 | 重新点一次麦克风；检查 macOS 与 Harness 的麦克风授权 |
| 第一次点麦克风要等几秒 | 首次回采会启动 tap；首次编译（无预编译二进制时） | 等 2–5 秒；后续启动很快 |
| 胶囊数字一直是 0 | 还没收敛；或当前没有可消除的回声 | 继续说 2–3 秒；确认视频在放且参考电平正常 |
| Harness 更新后失效 | profile 里的插件路径/版本变了 | 重新 `install_bundle`，重启 |

命令行的通用排查：

```bash
curl -s http://127.0.0.1:<port>/api/voiceaec/status   # 状态、电平、错误
pgrep -fl voiceaec-tap                                # 回采进程是否在跑
tail -f ~/.dsh/voiceaec/bin/../*.log 2>/dev/null      # 回采只写 stderr，通常无需查看
```

---

## 8. 资源占用与生命周期

- **按需启动**：只有页面请求参考流（开始录音）时才启动 `voiceaec-tap`；
- **自动退出**：最后一个监听者断开 20 秒后进程退出，不留后台常驻；
- **崩溃重启**：回采进程异常退出时，宿主自动重启（最多连续 3 次），状态里会写原因；
- **CPU**：回采进程通常 < 2% CPU；AEC 在 AudioWorklet 里跑，约为单个聊天页面的几个百分点；
- **内存**：回采进程约 20–30 MB，页面里的滤波器缓冲约 2 MB。

停止录音后胶囊回到「参考声就绪/静默」，不再显示 dB。

---

## 9. 隐私

- 参考声（系统播放混音）只在本机的 Harness 宿主进程 ↔ 页面之间流动，走
  `127.0.0.1` / `dsh-app://` 本地通道，**不上传网络**；
- 麦克风音频仍然走原有语音输入链路（本地 SenseVoice 推理）；
- 插件不录制、不落盘，录音结束后参考流立即停止；
- 想进一步收紧：点胶囊关闭，或在 Plugins 里停用插件。

---

## 10. 升级与卸载

**升级**

```bash
cd /path/to/VoiceAec-DSH
git pull
node build.mjs                       # 如果 client.js 有改动
```

`link:` 安装的插件重启 Harness 即生效；若 `package.json` 版本变了，重新
`install_bundle` 一次。

**卸载**

1. 在 Plugins 里停用 `dsh-voiceaec`（或从 profile 的 `dsh.profile.bundles` 移除）；
2. 重启 Harness；
3. 需要的话删掉克隆目录。

卸载后回采进程会在 20 秒内自行退出。

---

## 11. FAQ

**Q：能一边语音输入一边开视频会议吗？**
A：可以录音，但会议软件本身也在占用麦克风；同一设备可能被独占，建议先试。

**Q：用耳机还需要它吗？**
A：不需要，戴耳机时麦克风收不到扬声器声。插件不会带来副作用，可以一直开着。

**Q：可以只对某个会话生效吗？**
A：目前是全局开关（页面级），作用于所有语音输入。

**Q：会不会把我说的话也消掉？**
A：双讲保护会让滤波器在检测到你说话时暂停自适应；残余抑制会略微降低近端音量（约 3–4 dB），
对识别没有影响。

**Q：为什么数字是负数？**
A：那是衰减量（ERLE），`-12 dB` 表示回声被压低了 12 dB，越负越好。

**Q：支持多显示器/多输出设备吗？**
A：只回采系统默认输出设备。切换设备后需要重新开始一次录音（或重启 Harness）。

**Q：Windows 什么时候有？**
A：桌面版 VoiceAec 已经能做（VB-CABLE 方案）。Harness 插件在 Windows 上需要
WASAPI loopback 适配，属于后续工作。

---

## 附录 A：状态接口字段

`GET /api/voiceaec/status`

| 字段 | 说明 |
| --- | --- |
| `supported` | 当前系统是否支持回采（macOS） |
| `running` | 回采进程是否在跑 |
| `level` / `peak` | 参考声电平（dBFS，-120 表示静音） |
| `listeners` | 当前参考流订阅数（录音中 ≥ 1） |
| `inputRate` | 回采设备采样率（一般 48000） |
| `error` | 最近一次错误（进程崩溃、启动失败等） |
| `clientMounted` | 页面里的胶囊是否已渲染并上报过心跳 |
| `clientError` | 页面组件渲染/运行错误 |
| `bytes` | 本次进程累计产出的 PCM 字节数 |

其它接口：

- `GET /api/voiceaec/reference`：16 kHz、单声道、s16le 的参考流（仅供页面使用）。

---

## 附录 B：开发者自检

```bash
# 1) 编译原生回采（需要 Xcode Command Line Tools）
swiftc -O native/voiceaec-tap.swift -o native/voiceaec-tap

# 2) 单独验证回采（播放音乐时）
./native/voiceaec-tap > /tmp/ref.pcm 2>/tmp/ref.err
#    stderr 第一行应出现 {"event":"ready","sampleRate":16000,...}

# 3) 重新生成浏览器产物
node build.mjs

# 4) 离线 AEC 回归（不依赖插件）
say -v "Flo (中文（中国大陆）)" -o far.aiff  "接下来播放的视频声音，会从扬声器里传出来。"
say -v "Flo (中文（中国大陆）)" -o near.aiff "大肥鱼你好，帮我看一下今天的工作安排。"
afconvert -f WAVE -d LEI16@16000 far.aiff far.wav
afconvert -f WAVE -d LEI16@16000 near.aiff near.wav
node docs/aec-regression.mjs far.wav near.wav
# 期望：far-end ERLE ≈ 12.5 dB / near-end corr ≈ 0.78
```

---

## 附录 C：已知问题（语音输入插件版本门槛）

**现象**：语音输入的麦克风图标不出现；`list_plugins` 里 `include:speech-to-text`、
`include:ui-voice-input` 等条目 `enabled:false`。

**原因**：官方语音输入插件当前从 npm 装到的是 `0.1.7-alpha.1`，它把
`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-client-ui-*` 等 peer 依赖锁在
`^0.1.7-alpha.1`；而 Harness 运行时是 `0.2.1-rc.4`，peer 不满足，启动校验会拒绝挂载
（README 中「Unmet DSH version requirements … block installation and activation」）。

**可选处理**（按推荐顺序）：

1. **等官方发布匹配版本 / 在 Plugins 里升级**：把语音输入插件升到
   `0.2.1-rc.4`（与本机 Harness 同版本）即可通过校验；
2. **版本豁免**（有风险，需要明确同意）：给 0.1.7 的四个包分别授予
   `plugin_manager set_version_exemption`（`target` = 包名@0.1.7-alpha.1，
   `runtimeVersion` = 0.2.1-rc.4，`acceptRisk: true`）。可以绕过校验，但 0.1.7 的客户端
   插件与 0.2.1 运行时**不保证兼容**，可能出现麦克风按钮点了没反应、Remote 协议不匹配等问题；
3. **先不用语音输入**：本插件的胶囊与回采仍可独立验证（附录 B），等版本对齐后再联调。

> 该问题属于官方实验插件的版本匹配问题，与本插件（AEC）无关。本插件已装好并在运行，
> 一旦语音输入端可用，AEC 会自动接管，无需改任何配置。
