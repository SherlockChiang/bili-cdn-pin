# Bilibili CDN Pin · B站海外 CDN 测速与固定线路

海外看 B 站卡顿时，在一个 PiliPlus 风格的 Material 3 面板里给各条 CDN 测速，**手动选定一条后一直固定使用，不自动换线**。

## 安装

1. 装好 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开 [bili-cdn-pin.user.js](https://raw.githubusercontent.com/SherlockChiang/bili-cdn-pin/main/bili-cdn-pin.user.js)，脚本管理器会弹出安装页。

只在 `https://www.bilibili.com/*` 上运行（包括 `/en/` 英文版）。

## 使用

- 页面右下角的悬浮按钮打开面板，按钮可沿左右两边拖动；网页全屏 / 全屏时自动隐藏，鼠标移近再出现。
- **全部测速 / 测速本组 / 单条测速**：逐条下载同一段视频，显示速度、首包延迟。视频页默认用正在播放的文件测速，其它页面用样本视频（默认 av2）。
- **点哪条就固定哪条**，之后的分段请求立即走这条线路。「选最快的」也只在你点击时切换。
- **严格固定**（默认开）：主地址和备用地址都指向所选线路，播放器无法自行换线。关闭后，所选线路请求失败时允许临时回退 B 站原线路（只看失败，不看速度）。
- **B站默认线路**：不固定，只把 P2P / PCDN / MCDN 节点换成正常线路。
- 外观：深浅模式（跟随系统 / 浅色 / 深色）；主题色从预设、自定义取色器或「屏幕取色」（Chrome / Edge）里选，按 M3 TonalSpot 规则生成整套配色。

## 工作原理

- 拦截 playurl（`window.__playinfo__`、`fetch`、`XMLHttpRequest`、`JSON.parse`），记下 B 站给每个文件下发了哪些线路，再把地址改写到固定线路。
- 每个分段请求在发出前再路由一次，所以中途换线立即生效。
- UPOS 镜像接受彼此签过名的路径，换域名即可；**Akamai 地址带自己的 `hdnts` 令牌，只有 B 站下发了 Akamai 地址时才能固定到它。**
- 直播流不处理。

## 线路列表

海外：腾讯云海外 `mirrorcosov`、阿里云海外 `mirroraliov`、Akamai。
大陆：阿里云 / B / O1、腾讯云 / B / O1、华为云 / B / O1、华为云 08CT、TF 华为 / 腾讯。
B 站给当前视频下发的其它线路会出现在「其他」组，也可以添加自定义线路。

2026-11 实测已不解析而移除：`mirrorhwov`、`mirror08c`、`mirror08h`、`cn-hk-eq-bcache-01`。

## 开发

```bash
node --test test/core.test.js
```

`createCore()` 里是不依赖 DOM 的改写、路由和配色逻辑，测试直接 `require` 脚本文件。

## 致谢

- [PiliPlus](https://github.com/bggRGjQaUbCoE/PiliPlus)：CDN 设置与测速的交互、Material 3 配色思路。
- [realzza/bilibili-accelerator](https://github.com/realzza/bilibili-accelerator)（MIT）：请求拦截方式与 P2P / PCDN 识别规则。

## License

MIT
