<div align="center">

<img src="icon.svg" width="88" alt="VoiceAec for DeepSeek Harness">

<h1>VoiceAec for DeepSeek Harness</h1>

<p><b>和大肥鱼说话时，视频继续放着就行。</b></p>

<p>
  <img src="https://img.shields.io/badge/platform-macOS%2014.4%2B-4fa8e8?style=flat-square" alt="macOS 14.4+">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-2ec489?style=flat-square" alt="DeepSeek Harness plugin">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-e8b84b?style=flat-square" alt="MIT License"></a>
</p>

<p>DeepSeek Harness 的语音输入回声消除插件：系统声音回采 + 浏览器内自适应滤波。<br>
配套项目：<a href="https://github.com/384615666/VoiceAec">VoiceAec · Windows 桌面版</a></p>

</div>

`dsh-voiceaec` 把 [VoiceAec](https://github.com/384615666/VoiceAec) 的思路搬进 DeepSeek Harness：
语音输入录音的同一时刻，宿主用 **Core Audio process tap** 回采系统正在播放的声音，浏览器里的
**自适应回声消除器** 把这份参考信号从麦克风里减掉，再交给 SenseVoice 识别。

没有虚拟声卡，不需要暂停视频，也不上传音频。

```
 视频/音乐 ──► 扬声器 ──► 麦克风（串音）
    │                        │
    │ Core Audio tap         │ getUserMedia
    ▼                        ▼
 Host: 16 kHz 参考流 ──► Client: AudioWorklet AEC ──► 语音输入 → SenseVoice → 草稿
```

## 它解决什么

Harness 的语音输入用的是浏览器麦克风。外放时，视频声会被一起录进去，转写结果被污染；
常见做法是「先暂停视频，说完再继续」。装上这个插件后：

- 录音期间视频照常播放，转写里只留下你说的话；
- 参考声只在本机进程间流动，输出仍是原来的语音输入链路；
- 输入框下方的状态胶囊显示参考声电平与实时 ERLE，方便判断有没有在消除。

## 安装

**前提**

- macOS 14.4 及以上的 DeepSeek Harness 桌面端；
- 官方语音输入插件 `@deepseek-ai/dsh-experimental-voice-input-bundle` 已启用
  （Plugins 面板里启用，并在插件详情里下载 SenseVoice 模型）。

**步骤**

1. 克隆到本地一个不会被清理的目录：

   ```bash
   git clone https://github.com/384615666/VoiceAec-DSH.git
   ```

2. 把这个目录作为 profile bundle 安装进 Harness。在 Harness 里让 Agent 执行一句：

   > 把 `/path/to/VoiceAec-DSH` 作为 bundle 安装到当前 profile

   Agent 会调用 `plugin_manager` 的 `install_bundle`，等价于：

   ```jsonc
   { "action": "install_bundle", "target": "/path/to/VoiceAec-DSH" }
   ```

   安装会把这个包加进 profile 的 `dsh.profile.bundles`，并在
   `/api/voiceaec/*` 上挂两个回流接口。

3. **重启 Harness**。输入框下方出现 **「回声消除」** 胶囊即安装成功。

## 使用

1. 确认输入框下方的「回声消除」胶囊是开启状态（偏好存在
   `localStorage: dsh.voiceaec.enabled`）；
2. 点语音输入麦克风，正常说话，视频继续播放；
3. 录音时胶囊显示实时消除量（`-xx dB`）和参考声状态。

首次回采系统声音时，macOS 可能弹出「系统音频录制」授权（归属 DeepSeek Harness）。允许后
才会拿到参考信号；拒绝时胶囊显示「参考声静默」，语音输入仍然可用，只是按浏览器默认降噪处理。

## 操作手册

完整的安装、首次授权、日常使用、故障排查与开发者自检看 **[docs/manual.md](docs/manual.md)**。

## 状态胶囊

| 状态 | 含义 |
| --- | --- |
| 灰点/绿点 · 已开启 · 点麦克风说话 | AEC 就绪，等待语音输入开始录音 |
| 黄点 · 语音输入未就绪 | 官方语音输入插件没生效；点胶囊会跳到它的 Plugins 页面 |
| 绿点 · 参考声就绪 | 回采进程在跑，且确实有声音进入参考 |
| 黄点 · 参考声静默 | 回采在跑，但没有声音：视频静音 / 系统静音 / 输出设备不是默认设备 |
| 绿点 · 正在消除回声 + `-12 dB` | 正在录音，括号里是当前实测回声抑制量 |
| 红点 · 不可用 / 启动失败 | 非 macOS，或回采进程起不来（`/api/voiceaec/status` 里有 `error`） |
| 灰点 · 已关闭 | 点击关闭后退回浏览器默认处理 |

## 已知限制

- **仅 macOS 14.4+**：参考声走 Core Audio process tap。Windows 上建议继续用
  VoiceAec 桌面版 + VB-CABLE，把 `CABLE Output` 选成 Harness 的麦克风。
- **跟随系统默认输出设备**：回采的是默认输出设备上正在播放的混音。把视频切到非默认设备
  （例如 HDMI）时参考会静默，需要把该设备设为默认输出。
- **多 160 ms 延迟**：参考流从宿主到页面有传输延迟，AEC 用 10 个 16 ms 块把麦克风压后对齐，
  转写文本会比说话晚约 0.16 s。录音场景无感。
- **面向语音识别，不是 Hi-Fi**：当前版本是分块频域 NLMS + 残余回声抑制，实测在合成房间
  冲激响应下约 12.5 dB ERLE，近端语音相关系数 0.78；目标是让 ASR 听清你说话，不是让队友听
  高保真。后续可以把 `native/` 换成 LocalVQE 的 ONNX 推理，沿用同一条参考流接口。
- **不注入虚拟声卡**：插件只改 Harness 自己的麦克风链路，不碰系统设备。

## 配置

`cordis.patch.yml` 里的 `voiceaec` 行可以加 `config.device` 指定回采设备名（默认系统默认输出）：

```yaml
- insert:
    - id: voiceaec
      name: dsh-voiceaec
      config:
        device: 'Built-in Output'
```

## 仓库结构

```
.
├── lib/index.js              Host：路由、回采进程生命周期、电平
├── lib/aec-core.js           AEC 核心（Node 与浏览器共用的唯一实现）
├── src/client.js             浏览器源码（UI 胶囊与 getUserMedia 接管）
├── build.mjs                 把 AEC 核心内联进 client.js
├── client.js                 构建产物（Harness 直接加载）
├── native/voiceaec-tap.swift Core Audio tap → 16 kHz s16le
├── native/voiceaec-tap       x86_64 + arm64 通用二进制（可直接用）
├── docs/aec-regression.mjs   离线 AEC 回归
├── locale/                   插件卡片的中英文案
└── icon.svg                  VoiceAec 图标
```

## 开发

```bash
node build.mjs                       # 重新生成 client.js
swiftc -O native/voiceaec-tap.swift -o native/voiceaec-tap
curl -s localhost:50748/api/voiceaec/status   # 回采状态、电平、客户端挂载/报错
```

离线回归用 `say` 合成两段中文语音、卷积一条 220 ms 的房间冲激响应，把远端语音混进麦克风，
再量 ERLE 与近端相关性：

```bash
say -v "Flo (中文（中国大陆）)" -o far.aiff  "接下来播放的视频声音，会从扬声器里传出来。"
say -v "Flo (中文（中国大陆）)" -o near.aiff "大肥鱼你好，帮我看一下今天的工作安排。"
afconvert -f WAVE -d LEI16@16000 far.aiff far.wav
afconvert -f WAVE -d LEI16@16000 near.aiff near.wav
node docs/aec-regression.mjs far.wav near.wav
# far-end ERLE 12.5 dB / near-end corr 0.78
```

参考流接口是刻意做窄的：Host 只负责产出 16 kHz 参考 PCM，Client 只调用
`aec.process(micBlock)`。想把引擎换成 LocalVQE，只需替换 `lib/aec-core.js`，其余部分不用动。

## 与 VoiceAec 的关系

VoiceAec 桌面版是「Windows + WASAPI 回采 + LocalVQE 神经网络 + VB-CABLE」的完整产品；
这个插件是同一件事在 Harness 里的最小可用版本：

- 回采：WASAPI loopback → Core Audio process tap；
- 引擎：LocalVQE → 频域自适应滤波（本机零依赖，先跑通链路）；
- 出口：VB-CABLE → 直接替换语音输入拿到的 `MediaStream`，不装虚拟声卡。

## 卸载

在 Plugins 里停用 `dsh-voiceaec`，或从 profile 的 `dsh.profile.bundles` 移除。
回采进程会在没有监听者 20 秒后自行退出，不留后台常驻。

## License

[MIT](LICENSE) © 2026 384615666
