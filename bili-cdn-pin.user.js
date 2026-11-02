// ==UserScript==
// @name         Bilibili CDN Pin
// @name:zh-CN   B站 CDN 测速与固定线路（海外加速）
// @namespace    bili-cdn-pin
// @version      1.0.0
// @description  For overseas viewers: speed-test Bilibili CDNs in a PiliPlus-style panel, pick one, and keep using it.
// @description:zh-CN 海外看 B 站：在 PiliPlus 式面板里给各 CDN 测速，手动选定一条后一直固定使用，不自动换线。
// @author       SherlockChiang
// @license      MIT
// @homepageURL  https://github.com/SherlockChiang/bili-cdn-pin
// @supportURL   https://github.com/SherlockChiang/bili-cdn-pin/issues
// @downloadURL  https://raw.githubusercontent.com/SherlockChiang/bili-cdn-pin/main/bili-cdn-pin.user.js
// @updateURL    https://raw.githubusercontent.com/SherlockChiang/bili-cdn-pin/main/bili-cdn-pin.user.js
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// 思路来源：PiliPlus 的「CDN 设置 + 测速」对话框；拦截方式与 P2P/PCDN 识别参考
// realzza/bilibili-accelerator（MIT）。与后者的区别：这里不自动测速、不自动换线。
// 线路由用户测速后手动选定，之后本页所有视频/音频分段都发往这条线路，直到用户再换。

(function initCore(root, factory) {
  const core = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = core;
  }

  root.BiliCdnPinCore = core;
})(typeof globalThis !== "undefined" ? globalThis : window, function createCore() {
  "use strict";

  // 可选线路，region 只用于面板分组。UPOS 镜像接受彼此签过名的路径，换域名即可；
  // Akamai 的地址带它自己的 hdnts 令牌，别的线路换成 Akamai 域名会 403，
  // 所以 Akamai 只在 B 站给这个视频下发了 Akamai 地址时可用。
  // 2026-11 实测已不解析、因此不再列出：mirrorhwov、mirror08c、mirror08h、cn-hk-eq-bcache-01
  // （需要的话可在面板里作为自定义线路加回来）。
  const CDN_LIST = Object.freeze([
    { id: "cosov", name: "腾讯云海外", host: "upos-sz-mirrorcosov.bilivideo.com", region: "overseas" },
    { id: "aliov", name: "阿里云海外", host: "upos-sz-mirroraliov.bilivideo.com", region: "overseas" },
    { id: "akamai", name: "Akamai", host: "upos-hz-mirrorakam.akamaized.net", region: "overseas" },
    { id: "ali", name: "阿里云", host: "upos-sz-mirrorali.bilivideo.com", region: "mainland" },
    { id: "alib", name: "阿里云 B", host: "upos-sz-mirroralib.bilivideo.com", region: "mainland" },
    { id: "alio1", name: "阿里云 O1", host: "upos-sz-mirroralio1.bilivideo.com", region: "mainland" },
    { id: "cos", name: "腾讯云", host: "upos-sz-mirrorcos.bilivideo.com", region: "mainland" },
    { id: "cosb", name: "腾讯云 B", host: "upos-sz-mirrorcosb.bilivideo.com", region: "mainland" },
    { id: "coso1", name: "腾讯云 O1", host: "upos-sz-mirrorcoso1.bilivideo.com", region: "mainland" },
    { id: "hw", name: "华为云", host: "upos-sz-mirrorhw.bilivideo.com", region: "mainland" },
    { id: "hwb", name: "华为云 B", host: "upos-sz-mirrorhwb.bilivideo.com", region: "mainland" },
    { id: "hwo1", name: "华为云 O1", host: "upos-sz-mirrorhwo1.bilivideo.com", region: "mainland" },
    { id: "08ct", name: "华为云 08CT", host: "upos-sz-mirror08ct.bilivideo.com", region: "mainland" },
    { id: "tf_hw", name: "华为云 TF", host: "upos-tf-all-hw.bilivideo.com", region: "mainland" },
    { id: "tf_tx", name: "腾讯云 TF", host: "upos-tf-all-tx.bilivideo.com", region: "mainland" }
  ]);

  const DEFAULTS = Object.freeze({
    enabled: true,
    pin: "",                                       // 固定线路的域名；空 = B 站默认（只避开 P2P/PCDN）
    strict: true,                                  // 备用地址也指向固定线路，播放器无处可换
    mcdnProxy: true,                               // 换不了域名的 MCDN 地址走官方代理
    proxyHost: "proxy-tf-all-ws.bilivideo.com",
    rescueHost: "upos-sz-mirrorcosov.bilivideo.com", // 不固定时，只有 PCDN 地址可用就换到这里
    p2pGuard: false,
    testMB: 8,
    sampleMode: "auto",                            // auto: 视频页用当前视频测速 | fixed: 总用样本视频
    sampleBvid: "BV1xx411c7mD",                    // av2，站里最老的视频之一，不会被删，也不是热门缓存
    customHosts: [],
    themeMode: "system",                           // system | light | dark
    seedColor: "#fb7299",                          // M3 配色的种子色：预设、取色器或屏幕取色
    fab: Object.freeze({ side: "right", bottom: 120 })
  });

  const TEST_SIZES = [4, 8, 16];
  const MEDIA_FILE_RE = /\.(m4s|mp4|flv)$/i;
  const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  const MCDN_RE = /\.mcdn\.bilivideo\.(?:cn|com|net)$/i;
  // P2P/PCDN 家族（社区整理，见 bilibili-accelerator）：szbdyd 是旧调度器，mountaintoys
  // 是 2025 年的新名字，nexusedgeio / ahdohpiechei 是 upos-*302* 跳转的落点，
  // mirror14b 名为镜像，实际是 PCDN。
  const P2P_SUFFIXES = [".szbdyd.com", ".mountaintoys.cn", ".nexusedgeio.com", ".ahdohpiechei.com"];
  const P2P_HOSTS = ["upos-sz-mirror14b.bilivideo.com"];
  // 不固定且找不到正常线路时的保底；也是「旧路径 → 新线路」时不重复失败的冷却。
  const RETRY_BYPASS_MS = 8000;
  const BROKEN_WINDOW_MS = 30000;
  const BROKEN_LIMIT = 3;

  function cleanHost(value) {
    return String(value == null ? "" : value).trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/[/?#].*$/, "");
  }

  function isValidHost(host) {
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/.test(host);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeConfig(raw) {
    const c = Object.assign({}, DEFAULTS, raw && typeof raw === "object" ? raw : {});
    const fab = c.fab && typeof c.fab === "object" ? c.fab : DEFAULTS.fab;
    const bvid = String(c.sampleBvid || "").trim();
    c.enabled = c.enabled !== false;
    c.pin = isValidHost(cleanHost(c.pin)) ? cleanHost(c.pin) : "";
    c.strict = c.strict !== false;
    c.mcdnProxy = c.mcdnProxy !== false;
    c.p2pGuard = c.p2pGuard === true;
    c.proxyHost = isValidHost(cleanHost(c.proxyHost)) ? cleanHost(c.proxyHost) : DEFAULTS.proxyHost;
    c.rescueHost = isValidHost(cleanHost(c.rescueHost)) ? cleanHost(c.rescueHost) : DEFAULTS.rescueHost;
    c.testMB = TEST_SIZES.indexOf(Number(c.testMB)) !== -1 ? Number(c.testMB) : DEFAULTS.testMB;
    c.sampleMode = c.sampleMode === "fixed" ? "fixed" : "auto";
    c.sampleBvid = /^BV[0-9A-Za-z]{10}$/.test(bvid) ? bvid : DEFAULTS.sampleBvid;
    c.customHosts = (Array.isArray(c.customHosts) ? c.customHosts : [])
      .map(cleanHost)
      .filter(function (h, i, all) { return isValidHost(h) && all.indexOf(h) === i; });
    c.themeMode = c.themeMode === "light" || c.themeMode === "dark" ? c.themeMode : "system";
    delete c.colorSource; // 1.0.0 测试版的字段，已不用
    c.seedColor = parseColor(c.seedColor) || DEFAULTS.seedColor;
    c.fab = {
      side: fab.side === "left" ? "left" : "right",
      bottom: clamp(Number(fab.bottom) || DEFAULTS.fab.bottom, 8, 4000)
    };
    return c;
  }

  // ---- 地址识别 -------------------------------------------------------------

  function hasSignal(value) {
    return typeof value === "string" && value.length < 8192 &&
      (value.indexOf("bilivideo") !== -1 ||
        value.indexOf("akamaized.net") !== -1 ||
        value.indexOf("szbdyd") !== -1 ||
        value.indexOf("mountaintoys") !== -1 ||
        value.indexOf("nexusedgeio") !== -1 ||
        value.indexOf("ahdohpiechei") !== -1 ||
        value.indexOf("/upgcxcode/") !== -1 ||
        value.indexOf("/v1/resource/") !== -1);
  }

  function parseUrl(value) {
    if (!hasSignal(value)) {
      return null;
    }
    try {
      const url = new URL(value.slice(0, 2) === "//" ? "https:" + value : value);
      return url.protocol === "https:" || url.protocol === "http:" ? url : null;
    } catch (_) {
      return null;
    }
  }

  // 文件名在所有线路上都一样（如 123456789-1-30080.m4s），只有域名和签名不同，
  // 所以用它识别「同一份数据」。直播流走另一套 CDN，不碰。
  function fileKey(value) {
    const url = typeof value === "string" ? parseUrl(value) : value;
    if (!url || url.pathname.indexOf("/live-bvc/") !== -1) {
      return null;
    }
    const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    return MEDIA_FILE_RE.test(name) ? name : null;
  }

  function cidOf(key) {
    const m = /^(\d+)/.exec(String(key || ""));
    return m ? m[1] : null;
  }

  function isP2pName(hostname) {
    if (IP_RE.test(hostname) || P2P_HOSTS.indexOf(hostname) !== -1) {
      return true;
    }
    for (let i = 0; i < P2P_SUFFIXES.length; i += 1) {
      const s = P2P_SUFFIXES[i];
      if (hostname.length > s.length && hostname.slice(-s.length) === s) {
        return true;
      }
    }
    // upos-sz-302ppio / upos-sz-302kodo 一类会 302 到家用 P2P 节点。
    return hostname.indexOf("upos-") === 0 && hostname.split(".")[0].indexOf("302") !== -1;
  }

  function classify(url) {
    const hostname = url.hostname.toLowerCase();
    const scheduler = /\.szbdyd\.com$/.test(hostname);
    const mcdn = MCDN_RE.test(hostname);
    const oddPort = url.port !== "" && url.port !== "80" && url.port !== "443";
    const osMcdn = /(?:^|[?&])os=mcdn(?:&|$)/i.test(url.search);
    const akamai = /\.akamaized\.net$/.test(hostname);
    const bili = /\.bilivideo\.(?:com|cn|net)$/.test(hostname) || akamai;
    const bad = scheduler || mcdn || oddPort || osMcdn || isP2pName(hostname);
    return { host: url.host.toLowerCase(), scheduler, mcdn, akamai, bad, usable: bili && !bad };
  }

  function isUsable(value) {
    const url = parseUrl(value);
    return !!url && classify(url).usable;
  }

  // 能否把别的线路的地址换成这个域名。自定义线路允许带端口（自建反代）。
  function canSwapTo(host) {
    const h = cleanHost(host);
    if (!isValidHost(h) || /\.akamaized\.net(?::\d+)?$/.test(h)) {
      return false;
    }
    const name = h.replace(/:\d+$/, "");
    return !(MCDN_RE.test(name) || isP2pName(name));
  }

  function swapHost(value, host) {
    const url = new URL(value);
    const h = cleanHost(host);
    url.protocol = "https:";
    url.host = h;
    if (h.indexOf(":") === -1) {
      url.port = ""; // 只设 host 时 URL 会保留原来的端口（PCDN 常见 :4483）
    }
    return url.toString();
  }

  // 换域名要借一条签过名的 /upgcxcode/ 路径：优先正常 UPOS 地址，其次 PCDN 地址，
  // Akamai 地址垫底（它的签名参数和 UPOS 不同）。同级时取列表里靠前的。
  function swapSourceOf(urls) {
    let best = null;
    let bestRank = 9;
    urls.forEach(function (value) {
      const url = typeof value === "string" ? parseUrl(value) : null;
      if (!url || url.pathname.indexOf("/upgcxcode/") === -1) {
        return;
      }
      const c = classify(url);
      const rank = c.akamai ? 2 : (c.usable ? 0 : 1);
      if (rank < bestRank) {
        best = value;
        bestRank = rank;
      }
    });
    return best;
  }

  function regionOf(host) {
    const h = cleanHost(host);
    for (let i = 0; i < CDN_LIST.length; i += 1) {
      if (CDN_LIST[i].host === h) {
        return CDN_LIST[i].region;
      }
    }
    return "other";
  }

  // ---- 取色 -----------------------------------------------------------------

  // 从一个种子色生成 Material 3 配色，角色映射与 PiliPlus（Flutter ColorScheme.fromSeed
  // 默认的 TonalSpot）一致。M3 的「色调」就是 CIELAB 的 L*，所以这里在 CIELAB LCh 里
  // 保留种子的色相、按 TonalSpot 的彩度取各个色调，超出 sRGB 就降彩度。与官方 HCT
  // 的差别只是色相角有几度偏移，换来不用引入整套 CAM16。
  const WHITE = [0.95047, 1, 1.08883];
  const TONAL_SPOT = { primary: 36, secondary: 15, neutral: 5, neutralVariant: 8 };

  function parseColor(value) {
    const s = String(value == null ? "" : value).trim().toLowerCase();
    let m = /^#?([0-9a-f]{6})$/.exec(s);
    if (m) {
      return "#" + m[1];
    }
    m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
    if (m) {
      return "#" + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
    }
    m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(s);
    if (m) {
      return "#" + [m[1], m[2], m[3]].map(function (n) {
        return ("0" + Math.round(clamp(Number(n), 0, 255)).toString(16)).slice(-2);
      }).join("");
    }
    return null;
  }

  function toLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function fromLinear(v) {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(clamp(c, 0, 1) * 255);
  }

  function labF(t) {
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  }

  function labInvF(f) {
    const f3 = f * f * f;
    return f3 > 216 / 24389 ? f3 : (116 * f - 16) / (24389 / 27);
  }

  function lchOf(hex) {
    const n = parseInt(parseColor(hex).slice(1), 16);
    const r = toLinear(n >> 16 & 255);
    const g = toLinear(n >> 8 & 255);
    const b = toLinear(n & 255);
    const fx = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE[0]);
    const fy = labF((0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / WHITE[1]);
    const fz = labF((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / WHITE[2]);
    const a = 500 * (fx - fy);
    const bb = 200 * (fy - fz);
    return { l: 116 * fy - 16, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 };
  }

  function lchToLinear(l, c, h) {
    const rad = h * Math.PI / 180;
    const fy = (l + 16) / 116;
    const x = WHITE[0] * labInvF(fy + c * Math.cos(rad) / 500);
    const y = WHITE[1] * labInvF(fy);
    const z = WHITE[2] * labInvF(fy - c * Math.sin(rad) / 200);
    return [
      3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
      -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
      0.0556434 * x - 0.2040259 * y + 1.0572252 * z
    ];
  }

  function inGamut(rgb) {
    return rgb.every(function (v) { return v >= -1e-4 && v <= 1 + 1e-4; });
  }

  // 色相 h、彩度 c 下色调为 t 的颜色；超出 sRGB 时二分降低彩度，色调和色相不变。
  function toneColor(h, c, t) {
    if (t >= 100) {
      return "#ffffff";
    }
    if (t <= 0) {
      return "#000000";
    }
    let rgb = lchToLinear(t, c, h);
    if (!inGamut(rgb)) {
      let lo = 0;
      let hi = c;
      for (let i = 0; i < 18; i += 1) {
        const mid = (lo + hi) / 2;
        if (inGamut(lchToLinear(t, mid, h))) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      rgb = lchToLinear(t, lo, h);
    }
    return "#" + rgb.map(function (v) { return ("0" + fromLinear(v).toString(16)).slice(-2); }).join("");
  }

  // 返回面板用到的 CSS 变量（M3 角色 → 色调，同 Material Color Utilities 的 TonalSpot）。
  // 接近灰色的种子保持低彩度，不硬染成彩色。
  function schemeFrom(seed, dark) {
    const s = lchOf(parseColor(seed) || DEFAULTS.seedColor);
    const muted = s.c < 6 ? s.c / 6 : 1;
    const palette = function (chroma) {
      return function (t) { return toneColor(s.h, chroma * muted, t); };
    };
    const p = palette(TONAL_SPOT.primary);
    const sec = palette(TONAL_SPOT.secondary);
    const n = palette(TONAL_SPOT.neutral);
    const nv = palette(TONAL_SPOT.neutralVariant);
    if (dark) {
      return {
        "--p": p(80), "--on-p": p(20), "--pc": p(30), "--on-pc": p(90),
        "--sc": sec(30), "--on-sc": sec(90),
        "--s1": n(10), "--s2": n(12), "--s3": n(17), "--s4": n(22),
        "--on-s": n(90), "--on-sv": nv(80), "--ol": nv(60), "--olv": nv(30),
        "--inv-s": n(90), "--inv-on-s": n(20)
      };
    }
    return {
      "--p": p(40), "--on-p": p(100), "--pc": p(90), "--on-pc": p(10),
      "--sc": sec(90), "--on-sc": sec(10),
      "--s1": n(96), "--s2": n(94), "--s3": n(92), "--s4": n(90),
      "--on-s": n(10), "--on-sv": nv(30), "--ol": nv(50), "--olv": nv(80),
      "--inv-s": n(20), "--inv-on-s": n(95)
    };
  }

  // ---- playurl 结构 ---------------------------------------------------------

  // 找出带 dash 或 durl 的对象：/x/player/wbi/playurl 的 data、PGC 的 result /
  // result.video_info、页面里的 __playinfo__ 等，层级不固定，所以按形状找。
  function findPlayurls(obj, depth, out, seen) {
    if (!obj || typeof obj !== "object" || depth > 6 || seen.has(obj)) {
      return out;
    }
    seen.add(obj);
    if (obj.dash && typeof obj.dash === "object" && !Array.isArray(obj.dash)) {
      out.push({ holder: obj, dash: obj.dash });
    }
    if (Array.isArray(obj.durl) && obj.durl[0] && typeof obj.durl[0] === "object") {
      out.push({ holder: obj, durl: obj.durl });
    }
    Object.keys(obj).forEach(function (k) {
      if (k !== "dash" && k !== "durl") {
        findPlayurls(obj[k], depth + 1, out, seen);
      }
    });
    return out;
  }

  function isStr(value) {
    return typeof value === "string";
  }

  function entriesOf(found) {
    const list = [];
    if (found.dash) {
      const dash = found.dash;
      const add = function (group, kind) {
        (Array.isArray(group) ? group : group ? [group] : []).forEach(function (e) {
          if (!e || typeof e !== "object") {
            return;
          }
          const base = isStr(e.baseUrl) ? e.baseUrl : e.base_url;
          const backups = Array.isArray(e.backupUrl) ? e.backupUrl : (Array.isArray(e.backup_url) ? e.backup_url : []);
          list.push({
            e,
            dash: true,
            own: [base].concat(backups).filter(isStr),
            meta: { kind, id: e.id, bandwidth: Number(e.bandwidth) || 0, codecs: e.codecs || "" }
          });
        });
      };
      add(dash.video, "video");
      add(dash.audio, "audio");
      if (dash.dolby) {
        add(dash.dolby.audio, "audio");
      }
      if (dash.flac) {
        add(dash.flac.audio, "audio");
      }
    } else {
      found.durl.forEach(function (d) {
        if (!d || typeof d !== "object") {
          return;
        }
        list.push({
          e: d,
          dash: false,
          own: [d.url].concat(Array.isArray(d.backup_url) ? d.backup_url : []).filter(isStr),
          meta: {
            kind: "video",
            id: found.holder.quality,
            bandwidth: d.size > 0 && d.length > 0 ? d.size * 8000 / d.length : 0
          }
        });
      });
    }
    return list;
  }

  function writeEntry(item, base, backups) {
    const e = item.e;
    if (!item.dash) {
      e.url = base;
      e.backup_url = backups.slice();
      return;
    }
    const camel = "baseUrl" in e;
    const snake = "base_url" in e;
    if (camel || !snake) {
      e.baseUrl = base;
    }
    if (snake) {
      e.base_url = base;
    }
    if ("backupUrl" in e || !("backup_url" in e)) {
      e.backupUrl = backups.slice();
    }
    if ("backup_url" in e) {
      e.backup_url = backups.slice();
    }
  }

  function durationOfFound(found) {
    const dash = found.dash && Number(found.dash.duration);
    const ms = Number(found.holder.timelength);
    return dash > 0 ? dash : (ms > 0 ? ms / 1000 : 0);
  }

  // ---- 路由 -----------------------------------------------------------------

  // 一页一个路由器：记下 B 站给每个文件下发了哪些线路，再按配置决定每个地址
  // 发到哪里。getConfig 每次都读，面板里改了设置立即生效。
  function createRouter(getConfig, clock) {
    const now = clock || function () { return Date.now(); };
    const reps = new Map();       // 文件名 -> { key, kind, id, bandwidth, hosts: {host: url}, issued: [host], raw: [url] }
    const videos = new Map();     // cid -> { cid, duration, keys: [文件名] }
    const made = new Set();       // 我们生成的地址；再次解析到时不当成 B 站下发的
    const failedAt = new Map();   // 文件名 -> 固定线路最近一次失败的时间
    const counters = { rewritten: 0, avoided: new Set(), unavailable: new Set() };
    let pinFails = [];
    let pinFailTotal = 0;
    let pinBroken = false;
    let lastKey = null;
    let lastCid = null;
    let lastIngestCid = null;

    function remember(value) {
      made.add(value);
      if (made.size > 4000) {
        made.delete(made.values().next().value);
      }
    }

    // 严格模式下固定线路永远生效。非严格模式下，某个文件刚在固定线路上失败过，
    // 它的重试放行到播放器自己选的备用地址；连续失败则本页整体回退。
    function activePin(key) {
      const cfg = getConfig();
      if (!cfg.enabled || !cfg.pin || pinBroken) {
        return "";
      }
      if (!cfg.strict && key && failedAt.has(key) && now() - failedAt.get(key) < RETRY_BYPASS_MS) {
        return "";
      }
      return cfg.pin;
    }

    function ingestEntry(own, meta) {
      const key = own.map(fileKey).filter(Boolean)[0];
      if (!key) {
        return null;
      }
      let rep = reps.get(key);
      if (!rep) {
        rep = { key, kind: meta.kind, id: meta.id, bandwidth: 0, codecs: "", hosts: {}, issued: [], raw: [] };
        reps.set(key, rep);
      }
      if (meta.bandwidth > 0) {
        rep.bandwidth = meta.bandwidth;
      }
      if (meta.codecs) {
        rep.codecs = meta.codecs;
      }
      const fresh = own.filter(function (s) { return !made.has(s) && fileKey(s) === key; });
      if (fresh.length) {
        rep.raw = fresh.slice(0, 8);
      }
      fresh.forEach(function (s) {
        const url = parseUrl(s);
        const c = classify(url);
        let usable = c.usable ? s : null;
        // 旧调度器地址在 xy_usource 里带着真正的 UPOS 域名。
        if (!usable && c.scheduler) {
          const source = cleanHost(url.searchParams.get("xy_usource"));
          if (source && canSwapTo(source)) {
            usable = swapHost(s, source);
          }
        }
        if (!usable) {
          return;
        }
        const host = new URL(usable).host.toLowerCase();
        if (!rep.hosts[host]) {
          rep.issued.push(host);
        }
        rep.hosts[host] = usable;
      });
      return rep;
    }

    function noteVideo(rep, duration) {
      const cid = cidOf(rep.key);
      if (!cid) {
        return;
      }
      let v = videos.get(cid);
      if (!v) {
        v = { cid, duration: 0, keys: [] };
        videos.set(cid, v);
        if (videos.size > 8) {
          const oldest = videos.keys().next().value;
          videos.get(oldest).keys.forEach(function (k) { reps.delete(k); });
          videos.delete(oldest);
        }
      }
      if (duration > 0) {
        v.duration = duration;
      }
      if (v.keys.indexOf(rep.key) === -1) {
        v.keys.push(rep.key);
      }
      lastIngestCid = cid;
    }

    // 一个文件在某条线路上的地址：B 站给这条线路下发过就用下发的（签名本来就对），
    // 否则借一条签名路径换域名。prefer 是手头这条地址，签名最新，同级时优先。
    function urlFor(rep, host, prefer) {
      const h = cleanHost(host);
      if (!rep || !h) {
        return null;
      }
      if (rep.hosts[h]) {
        return rep.hosts[h];
      }
      if (!canSwapTo(h)) {
        return null;
      }
      const pool = [prefer].concat(rep.issued.map(function (x) { return rep.hosts[x]; }), rep.raw);
      const source = swapSourceOf(pool);
      if (!source) {
        return null;
      }
      const out = swapHost(source, h);
      remember(out);
      return out;
    }

    function proxyUrl(value) {
      const out = "https://" + getConfig().proxyHost + "/?url=" + encodeURIComponent(value);
      remember(out);
      return out;
    }

    // 不固定、而且手头全是 PCDN：换到保底线路；连 /upgcxcode/ 路径都没有的
    // MCDN 地址（/v1/resource/）只能走官方代理。
    function rescueUrl(rep, prefer) {
      const cfg = getConfig();
      const swapped = urlFor(rep, cfg.rescueHost, prefer);
      if (swapped) {
        return swapped;
      }
      const url = prefer && parseUrl(prefer);
      return url && cfg.mcdnProxy && classify(url).mcdn ? proxyUrl(prefer) : null;
    }

    function healthyOf(rep, own) {
      const mine = own.filter(function (s) { return !made.has(s) && isUsable(s); });
      return mine.length ? mine : rep.issued.map(function (h) { return rep.hosts[h]; });
    }

    // 一条 DASH 表示（或一段 durl）改写后的主地址和备用地址；null 表示不动。
    function planEntry(rep, own) {
      const cfg = getConfig();
      own.forEach(function (s) {
        const url = parseUrl(s);
        if (url && classify(url).bad) {
          counters.avoided.add(url.host.toLowerCase());
        }
      });
      const healthy = healthyOf(rep, own);
      const pin = activePin(rep.key);
      if (pin) {
        const target = urlFor(rep, pin, own[0]);
        if (target) {
          counters.unavailable.delete(rep.key);
          if (cfg.strict) {
            return { base: target, backups: [target] };
          }
          const rest = healthy.filter(function (s) { return s !== target; });
          return { base: target, backups: rest.length ? rest : [target] };
        }
        counters.unavailable.add(rep.key);
      }
      if (healthy.length) {
        return { base: healthy[0], backups: healthy.length > 1 ? healthy.slice(1) : [healthy[0]] };
      }
      const rescue = rescueUrl(rep, own[0]);
      return rescue ? { base: rescue, backups: [rescue] } : null;
    }

    function ingestPayload(obj) {
      if (!obj || typeof obj !== "object") {
        return [];
      }
      const items = [];
      findPlayurls(obj, 0, [], new WeakSet()).forEach(function (found) {
        const duration = durationOfFound(found);
        entriesOf(found).forEach(function (item) {
          const rep = ingestEntry(item.own, item.meta);
          if (rep) {
            noteVideo(rep, duration);
            items.push({ item, rep });
          }
        });
      });
      return items;
    }

    // 先记下 B 站下发了什么，再改写；返回改动了几条表示。
    function rewritePayload(obj) {
      if (!getConfig().enabled) {
        return 0;
      }
      let changed = 0;
      ingestPayload(obj).forEach(function (x) {
        const plan = planEntry(x.rep, x.item.own);
        if (!plan) {
          return;
        }
        const next = [plan.base].concat(plan.backups);
        if (next.join("\n") !== x.item.own.join("\n")) {
          writeEntry(x.item, plan.base, plan.backups);
          changed += 1;
        }
      });
      counters.rewritten += changed;
      return changed;
    }

    // 播放器发出的每个分段请求最后都过这里：payload 没拦到的、播放器自己从备用
    // 列表里挑的、用户刚换了线路的，都在这一步落到固定线路上。
    function route(value) {
      if (!getConfig().enabled) {
        return value;
      }
      const url = parseUrl(value);
      const key = url && fileKey(url);
      if (!key) {
        return value;
      }
      const c = classify(url);
      const rep = reps.get(key) || { key, hosts: {}, issued: [], raw: [value] };
      const pin = activePin(key);
      if (pin) {
        if (c.host === pin && !c.bad) {
          return value;
        }
        const target = urlFor(rep, pin, value);
        if (target) {
          return target;
        }
        counters.unavailable.add(key);
      }
      // 没有固定线路可用：正常地址照发；P2P/PCDN，或我们之前为别的线路生成的
      // 地址（用户刚改回默认），换回 B 站下发的正常地址。
      const ours = made.has(value);
      if (!c.bad && !ours) {
        return value;
      }
      if (c.bad) {
        counters.avoided.add(c.host);
      }
      const healthy = rep.issued.map(function (h) { return rep.hosts[h]; });
      if (healthy.length) {
        return healthy[0];
      }
      return ours ? value : (rescueUrl(rep, value) || value);
    }

    function noteRequest(value, ok) {
      const cfg = getConfig();
      const url = parseUrl(value);
      if (!url || !cfg.pin || url.host.toLowerCase() !== cfg.pin) {
        return;
      }
      const t = now();
      if (ok) {
        pinFails = [];
        return;
      }
      pinFailTotal += 1;
      const key = fileKey(url);
      if (key) {
        failedAt.set(key, t);
      }
      pinFails = pinFails.filter(function (x) { return t - x < BROKEN_WINDOW_MS; }).concat(t);
      if (!cfg.strict && pinFails.length >= BROKEN_LIMIT) {
        pinBroken = true;
      }
    }

    function noteVideoRequest(value) {
      const key = fileKey(value);
      const rep = key ? reps.get(key) : null;
      if (rep && rep.kind === "video") {
        lastKey = key;
        lastCid = cidOf(key);
        return rep;
      }
      return null;
    }

    function resetPin() {
      pinFails = [];
      pinFailTotal = 0;
      pinBroken = false;
      failedAt.clear();
      counters.unavailable.clear();
    }

    // 正在播的视频；还没开始拉分段时取最近解析到的那个。
    function currentVideo() {
      const cid = lastCid && videos.has(lastCid) ? lastCid : lastIngestCid;
      return cid ? videos.get(cid) || null : null;
    }

    // 测速用的文件：正在播的那条视频表示；还没开始播就取最高码率的一条。
    function sampleRep() {
      const v = currentVideo();
      if (lastKey && reps.has(lastKey) && (!v || v.keys.indexOf(lastKey) !== -1)) {
        return reps.get(lastKey);
      }
      if (!v) {
        return null;
      }
      return v.keys.map(function (k) { return reps.get(k); })
        .filter(function (r) { return r && r.kind === "video" && swapSourceOf(r.raw.concat(r.issued.map(function (h) { return r.hosts[h]; }))); })
        .sort(function (a, b) { return b.bandwidth - a.bandwidth; })[0] || null;
    }

    function durationOf(rep) {
      const v = rep ? videos.get(cidOf(rep.key)) : null;
      return v ? v.duration : 0;
    }

    function currentIssued() {
      const v = currentVideo();
      const out = [];
      (v ? v.keys : []).forEach(function (k) {
        const rep = reps.get(k);
        (rep ? rep.issued : []).forEach(function (h) {
          if (out.indexOf(h) === -1) {
            out.push(h);
          }
        });
      });
      return out;
    }

    function status() {
      const v = currentVideo();
      const rep = lastKey ? reps.get(lastKey) : null;
      return {
        hasVideo: !!v,
        rewritten: counters.rewritten,
        avoided: counters.avoided.size,
        unavailable: !!v && v.keys.some(function (k) { return counters.unavailable.has(k); }),
        pinFailures: pinFailTotal,
        pinBroken,
        requiredBps: rep ? rep.bandwidth : 0
      };
    }

    return {
      ingestPayload,
      rewritePayload,
      route,
      urlFor,
      noteRequest,
      noteVideoRequest,
      resetPin,
      sampleRep,
      durationOf,
      currentIssued,
      issuedHosts: function (rep) { return rep ? rep.issued.slice() : []; },
      status
    };
  }

  return {
    CDN_LIST,
    DEFAULTS,
    TEST_SIZES,
    normalizeConfig,
    cleanHost,
    isValidHost,
    parseUrl,
    fileKey,
    cidOf,
    classify,
    isUsable,
    canSwapTo,
    swapHost,
    regionOf,
    parseColor,
    lchOf,
    schemeFrom,
    createRouter
  };
});

(function installRuntime(root) {
  "use strict";

  const Core = root.BiliCdnPinCore;
  if (!Core || typeof document === "undefined" || root.__BILI_CDN_PIN__) {
    return;
  }
  root.__BILI_CDN_PIN__ = true;

  const VERSION = "1.0.0";
  const CONFIG_KEY = "biliCdnPin.config.v1";
  const RESULTS_KEY = "biliCdnPin.results.v1";
  const HOST_ID = "bili-cdn-pin";
  const CONNECT_TIMEOUT_MS = 5000;
  const MIN_OK_BYTES = 64 * 1024;
  const QUALITY = {
    127: "8K", 126: "杜比视界", 125: "HDR", 120: "4K", 116: "1080P60", 112: "1080P+",
    80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P", 6: "240P"
  };

  const nativeParse = JSON.parse;
  const nativeStringify = JSON.stringify;
  const nativeFetch = typeof root.fetch === "function" ? root.fetch : null;
  const NativeXHR = root.XMLHttpRequest;

  let config = loadConfig();
  const router = Core.createRouter(function () { return config; });
  const playback = { samples: [] };
  const test = {
    running: false, stop: false, queue: [], index: 0, current: null,
    live: {}, results: {}, extra: [], meta: null, error: ""
  };
  loadResults();

  function perfNow() {
    return root.performance && root.performance.now ? root.performance.now() : Date.now();
  }

  // ---- 存储 -----------------------------------------------------------------

  function loadConfig() {
    try {
      const raw = root.localStorage.getItem(CONFIG_KEY);
      return Core.normalizeConfig(raw ? nativeParse(raw) : null);
    } catch (_) {
      return Core.normalizeConfig(null);
    }
  }

  function saveConfig(next) {
    config = Core.normalizeConfig(next);
    try {
      root.localStorage.setItem(CONFIG_KEY, nativeStringify(config));
    } catch (_) {
      // 存不了也照常生效，只是刷新后丢失。
    }
  }

  function loadResults() {
    try {
      const raw = nativeParse(root.localStorage.getItem(RESULTS_KEY) || "null");
      if (raw && typeof raw === "object") {
        test.results = raw.results && typeof raw.results === "object" ? raw.results : {};
        test.meta = raw.meta || null;
        test.extra = Array.isArray(raw.extra) ? raw.extra.filter(Core.isValidHost) : [];
      }
    } catch (_) {}
  }

  function saveResults() {
    try {
      root.localStorage.setItem(RESULTS_KEY, nativeStringify({ meta: test.meta, results: test.results, extra: test.extra }));
    } catch (_) {}
  }

  // ---- 拦截 -----------------------------------------------------------------

  function processPayload(obj) {
    try {
      const n = router.rewritePayload(obj);
      scheduleRender();
      return n;
    } catch (error) {
      console.warn("[BiliCdnPin] playurl 改写失败", error);
      return 0;
    }
  }

  function looksLikePlayurl(text) {
    return typeof text === "string" && text.length > 100 &&
      (text.indexOf("base_url") !== -1 || text.indexOf("baseUrl") !== -1 || text.indexOf("\"durl\"") !== -1) &&
      (text.indexOf("bilivideo") !== -1 || text.indexOf("akamaized") !== -1 ||
        text.indexOf("szbdyd") !== -1 || text.indexOf("mountaintoys") !== -1);
  }

  function isPlayurlApi(url) {
    return url.indexOf("playurl") !== -1 || url.indexOf("/playview") !== -1;
  }

  function urlOf(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input && typeof input.href === "string") {
      return input.href;
    }
    return input && typeof input.url === "string" ? input.url : "";
  }

  function patchJsonParse() {
    JSON.parse = function parse(text) {
      const out = nativeParse.apply(this, arguments);
      if (config.enabled && out && typeof out === "object" && looksLikePlayurl(text)) {
        processPayload(out);
      }
      return out;
    };
  }

  function rewriteResponse(response) {
    const type = (response.headers && response.headers.get("content-type")) || "";
    if (type && type.indexOf("json") === -1 && type.indexOf("text") === -1) {
      return response;
    }
    return response.clone().text().then(function (text) {
      if (!looksLikePlayurl(text)) {
        return response;
      }
      const obj = nativeParse(text);
      if (!processPayload(obj)) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(nativeStringify(obj), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }).catch(function () {
      return response;
    });
  }

  function patchFetch() {
    if (!nativeFetch) {
      return;
    }
    root.fetch = function fetch(input, init) {
      const url = urlOf(input);
      if (!config.enabled || !url) {
        return nativeFetch.apply(this, arguments);
      }
      if (Core.fileKey(url)) {
        const next = router.route(url);
        let args = arguments;
        if (next !== url) {
          // 字符串和 URL 直接换；Request 要重建才能带上它原来的选项。
          args = [typeof input === "string" || typeof input.href === "string" ? next : new Request(next, input), init];
        }
        router.noteVideoRequest(next);
        const pending = nativeFetch.apply(this, args);
        pending.then(function (r) {
          router.noteRequest(next, r.ok);
        }, function (error) {
          if (!error || error.name !== "AbortError") {
            router.noteRequest(next, false);
          }
        });
        return pending;
      }
      if (isPlayurlApi(url)) {
        return nativeFetch.apply(this, arguments).then(rewriteResponse);
      }
      return nativeFetch.apply(this, arguments);
    };
  }

  // XHR 的响应在实例上装 getter：不管播放器用 onload、onreadystatechange 还是
  // addEventListener，也不管谁先注册，读到的都是改写后的内容。
  function shimXhrResponse(xhr, textDesc, responseDesc) {
    let done = false;
    let text = null;
    function compute() {
      if (done || xhr.readyState !== 4) {
        return;
      }
      done = true;
      try {
        const type = xhr.responseType;
        if (type === "json") {
          const obj = responseDesc.get.call(xhr);
          if (obj && typeof obj === "object") {
            processPayload(obj); // 浏览器缓存这个对象，原地改写即可
          }
          return;
        }
        if (type !== "" && type !== "text") {
          return;
        }
        const raw = textDesc.get.call(xhr);
        if (looksLikePlayurl(raw)) {
          const obj = nativeParse(raw);
          if (processPayload(obj)) {
            text = nativeStringify(obj);
          }
        }
      } catch (_) {}
    }
    try {
      Object.defineProperty(xhr, "responseText", {
        configurable: true,
        get: function () {
          compute();
          return text !== null ? text : textDesc.get.call(xhr);
        }
      });
      Object.defineProperty(xhr, "response", {
        configurable: true,
        get: function () {
          compute();
          return text !== null && (xhr.responseType === "" || xhr.responseType === "text")
            ? text
            : responseDesc.get.call(xhr);
        }
      });
    } catch (_) {}
  }

  function watchMediaXhr(xhr, url) {
    const rep = router.noteVideoRequest(url);
    const startedAt = perfNow();
    const hiddenAtStart = document.hidden;
    let aborted = false;
    xhr.addEventListener("abort", function () { aborted = true; });
    xhr.addEventListener("loadend", function (event) {
      // 播放器自己取消的请求（拖动进度、切清晰度）不算线路失败。
      if (aborted) {
        return;
      }
      const loaded = event && typeof event.loaded === "number" ? event.loaded : 0;
      const ok = (xhr.status === 200 || xhr.status === 206) && loaded > 0;
      router.noteRequest(url, ok);
      if (ok && rep && !hiddenAtStart && !document.hidden) {
        recordPlayback(loaded, perfNow() - startedAt);
      }
      scheduleRender();
    });
  }

  function patchXhr() {
    if (!NativeXHR) {
      return;
    }
    const proto = NativeXHR.prototype;
    const open = proto.open;
    const send = proto.send;
    const textDesc = Object.getOwnPropertyDescriptor(proto, "responseText");
    const responseDesc = Object.getOwnPropertyDescriptor(proto, "response");

    proto.open = function patchedOpen(method, url) {
      const args = Array.prototype.slice.call(arguments);
      const s = typeof url === "string" ? url : urlOf(url);
      this.__bcp = null;
      if (config.enabled && s) {
        if (Core.fileKey(s)) {
          args[1] = router.route(s);
          this.__bcp = { kind: "media", url: args[1] };
        } else if (isPlayurlApi(s)) {
          this.__bcp = { kind: "api" };
        }
      }
      return open.apply(this, args);
    };

    proto.send = function patchedSend() {
      const meta = this.__bcp;
      if (meta && meta.kind === "media") {
        watchMediaXhr(this, meta.url);
      } else if (meta && meta.kind === "api" && textDesc && responseDesc) {
        shimXhrResponse(this, textDesc, responseDesc);
      }
      return send.apply(this, arguments);
    };
  }

  // 视频页的首个 playurl 由内联脚本 window.__playinfo__ = {...} 赋值。
  function hookGlobal(name) {
    let value;
    const existing = Object.getOwnPropertyDescriptor(root, name);
    if (existing && existing.configurable === false) {
      return;
    }
    if (existing && "value" in existing) {
      value = existing.value;
      if (value && typeof value === "object") {
        processPayload(value);
      }
    }
    try {
      Object.defineProperty(root, name, {
        configurable: true,
        enumerable: true,
        get: function () { return value; },
        set: function (next) {
          value = next;
          if (config.enabled && next && typeof next === "object") {
            processPayload(next);
          }
        }
      });
    } catch (_) {}
  }

  // 可选：不让网页版启动 P2P SDK 和 WebRTC，避免占用上行带宽。
  function installP2PGuard() {
    if (!config.p2pGuard) {
      return;
    }
    function NoopSdk() {}
    NoopSdk.prototype.on = function () {};
    NoopSdk.prototype.destroy = function () {};
    ["PCDNLoader", "BPP2PSDK", "SeederSDK"].forEach(function (name) {
      try {
        Object.defineProperty(root, name, { configurable: false, get: function () { return NoopSdk; }, set: function () {} });
      } catch (_) {}
    });
    function BlockedPeerConnection() {
      throw new DOMException("Blocked by Bilibili CDN Pin", "NotAllowedError");
    }
    ["RTCPeerConnection", "webkitRTCPeerConnection"].forEach(function (name) {
      try {
        Object.defineProperty(root, name, { configurable: false, get: function () { return BlockedPeerConnection; }, set: function () {} });
      } catch (_) {}
    });
  }

  // ---- 播放实测 ---------------------------------------------------------------

  // 只记视频分段：每个请求从发出到收完的平均速率，和播放器实际感受到的一致。
  function recordPlayback(bytes, ms) {
    if (bytes < 128 * 1024 || !(ms > 0)) {
      return;
    }
    const t = Date.now();
    playback.samples = playback.samples.filter(function (s) { return t - s.t < 60000; })
      .concat({ t, bytes, ms }).slice(-30);
  }

  function playbackMbps() {
    const list = playback.samples;
    if (list.length < 2) {
      return 0;
    }
    let bytes = 0;
    let ms = 0;
    list.forEach(function (s) { bytes += s.bytes; ms += s.ms; });
    return bytes * 8 / 1000 / ms;
  }

  // ---- 测速 -----------------------------------------------------------------

  function isPlayerPage() {
    // 英文版页面多一层 /en 前缀。
    return /^(?:\/en)?\/(?:video|bangumi\/play|list|medialist\/play|festival|cheese\/play)\//.test(root.location.pathname || "");
  }

  function qualityName(rep) {
    return QUALITY[rep && rep.id] || (rep && rep.id ? "qn" + rep.id : "视频");
  }

  function getJson(url) {
    return nativeFetch.call(root, url, { credentials: "include" }).then(function (r) { return r.json(); });
  }

  // 测速样本：视频页优先用正在播的文件，结果才代表你真正要看的东西——海外节点
  // 对热门视频有缓存会很快，对冷门视频要回源会很慢。其它页面用固定的样本视频。
  function getSample() {
    if (config.sampleMode !== "fixed" && isPlayerPage()) {
      const rep = router.sampleRep();
      if (rep) {
        return Promise.resolve({
          rep, source: router, current: true,
          label: "当前视频 · " + qualityName(rep),
          duration: router.durationOf(rep)
        });
      }
    }
    const bvid = config.sampleBvid;
    const api = "https://api.bilibili.com";
    return getJson(api + "/x/web-interface/view?bvid=" + bvid).then(function (view) {
      const info = view && view.data;
      if (!info || !info.cid) {
        throw new Error("样本视频 " + bvid + " 信息获取失败" + (view && view.message ? "：" + view.message : ""));
      }
      return getJson(api + "/x/player/playurl?bvid=" + bvid + "&cid=" + info.cid + "&qn=80&fnval=16&fnver=0&fourk=0")
        .then(function (playurl) {
          const sampleRouter = Core.createRouter(function () { return Core.DEFAULTS; });
          sampleRouter.ingestPayload(playurl);
          const rep = sampleRouter.sampleRep();
          if (!rep) {
            throw new Error("样本视频地址获取失败" + (playurl && playurl.message ? "：" + playurl.message : ""));
          }
          return {
            rep, source: sampleRouter, current: false,
            label: bvid + " · " + qualityName(rep),
            duration: sampleRouter.durationOf(rep) || info.duration || 0
          };
        });
    });
  }

  // 下载一段数据，速率按「收到响应头 → 结束」计算，首包时间单列。
  function measure(url, start, size, timeLimitMs, onProgress) {
    return new Promise(function (resolve) {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const t0 = perfNow();
      let tHead = 0;
      let bytes = 0;
      let settled = false;
      function result(reason) {
        const ms = perfNow() - tHead;
        // 到时间还没下完也是有效结果（就是慢）；提前断开且数据太少才算失败。
        if (ms > 0 && (bytes >= Math.min(MIN_OK_BYTES, size) || (reason === "time" && bytes > 0))) {
          return { ok: true, mbps: bytes * 8 / 1000 / ms, ttfb: tHead - t0, bytes, why: reason };
        }
        return { ok: false, error: reason === "net" ? "network" : "short", ttfb: tHead - t0, bytes };
      }
      function finish(r) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(hardTimer);
        clearInterval(stopPoll);
        try { if (ctl) { ctl.abort(); } } catch (_) {}
        resolve(r);
      }
      const connectTimer = setTimeout(function () {
        if (!tHead) {
          finish({ ok: false, error: "timeout" });
        }
      }, CONNECT_TIMEOUT_MS);
      const hardTimer = setTimeout(function () { finish(result("time")); }, timeLimitMs);
      const stopPoll = setInterval(function () {
        if (test.stop) {
          finish({ ok: false, error: "stopped" });
        }
      }, 100);
      nativeFetch.call(root, url, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        headers: { Range: "bytes=" + start + "-" + (start + size - 1) },
        signal: ctl ? ctl.signal : undefined
      }).then(function (response) {
        if (settled) {
          return null;
        }
        tHead = perfNow();
        if (response.status !== 206 && response.status !== 200) {
          finish({ ok: false, error: "http", status: response.status, ttfb: tHead - t0 });
          return null;
        }
        if (!response.body || typeof response.body.getReader !== "function") {
          return response.arrayBuffer().then(function (buf) {
            bytes = buf.byteLength;
            finish(result("eof"));
          });
        }
        const reader = response.body.getReader();
        function pump() {
          return reader.read().then(function (chunk) {
            if (settled) {
              try { reader.cancel(); } catch (_) {}
              return null;
            }
            if (chunk.done) {
              finish(result("eof"));
              return null;
            }
            bytes += chunk.value ? chunk.value.byteLength : 0;
            onProgress(bytes, perfNow() - tHead);
            if (bytes >= size) {
              finish(result("bytes"));
              return null;
            }
            return pump();
          });
        }
        return pump();
      }).catch(function () {
        finish(tHead ? result("net") : { ok: false, error: "network" });
      });
    });
  }

  function runTest(hosts, includeIssued) {
    if (test.running || !nativeFetch || !hosts.length) {
      return;
    }
    test.running = true;
    test.stop = false;
    test.error = "";
    test.current = null;
    test.live = {};
    test.queue = hosts.slice();
    test.index = 0;
    scheduleRender();
    renderFab();

    getSample().then(function (sample) {
      const size = config.testMB * 1024 * 1024;
      const timeLimit = (4 + config.testMB / 4) * 1000;
      const total = sample.rep.bandwidth > 0 && sample.duration > 0 ? sample.rep.bandwidth / 8 * sample.duration : 0;
      // 每轮换一个随机起点，避免测到上一轮自己刚拉热的缓存。同一轮各线路同一起点，比较才公平。
      const start = total > size * 4 ? Math.floor(Math.random() * total * 0.5 / 65536) * 65536 : 0;
      if (includeIssued) {
        sample.source.issuedHosts(sample.rep).forEach(function (h) {
          if (test.queue.indexOf(h) === -1) {
            test.queue.push(h);
          }
          if (!sample.current && !isListed(h) && test.extra.indexOf(h) === -1) {
            test.extra.push(h);
          }
        });
      }
      test.meta = {
        at: Date.now(),
        label: sample.label,
        requiredMbps: sample.current ? sample.rep.bandwidth / 1e6 : 0,
        mb: config.testMB
      };

      function next() {
        if (test.stop || test.index >= test.queue.length) {
          return null;
        }
        const host = test.queue[test.index];
        test.index += 1;
        test.current = host;
        test.live[host] = { frac: 0, mbps: 0 };
        scheduleRender();
        const url = sample.source.urlFor(sample.rep, host, null);
        const progress = function (b, ms) {
          test.live[host] = { frac: Math.min(1, b / size), mbps: ms > 250 ? b * 8 / 1000 / ms : 0 };
          scheduleRender();
        };
        const run = url
          ? measure(url, start, size, timeLimit, progress).then(function (r) {
            // 起点超出文件末尾（码率估大了）时从头再测一次。
            return r.status === 416 && start > 0 ? measure(url, 0, size, timeLimit, progress) : r;
          })
          : Promise.resolve({ ok: false, error: "unavailable" });
        return run.then(function (r) {
          delete test.live[host];
          if (r.error !== "stopped") {
            r.at = Date.now();
            test.results[host] = r;
            saveResults();
          }
          scheduleRender();
          return next();
        });
      }
      return next();
    }).catch(function (error) {
      test.error = (error && error.message) || "测速失败";
    }).then(function () {
      test.running = false;
      test.current = null;
      test.live = {};
      scheduleRender();
      renderFab();
    });
  }

  function bestHost() {
    let best = null;
    allItems().forEach(function (item) {
      const r = test.results[item.host];
      if (r && r.ok && (!best || r.mbps > test.results[best].mbps)) {
        best = item.host;
      }
    });
    return best;
  }

  // ---- 选择 -----------------------------------------------------------------

  function labelOf(host) {
    const known = Core.CDN_LIST.filter(function (c) { return c.host === host; })[0];
    if (known) {
      return known.name;
    }
    return config.customHosts.indexOf(host) !== -1 ? "自定义 · " + shortHost(host) : shortHost(host);
  }

  function shortHost(host) {
    return String(host).replace(/\.bilivideo\.com$/, "");
  }

  function pinHost(host) {
    const h = Core.cleanHost(host);
    if (config.pin === h && config.enabled) {
      return;
    }
    saveConfig(Object.assign({}, config, { pin: h, enabled: true }));
    router.resetPin();
    playback.samples = [];
    if (h) {
      toast("已固定：" + labelOf(h) + (isPlayerPage() ? "，接下来的分段立即走这条线路" : ""));
    } else {
      toast("已改回 B 站默认线路");
    }
    scheduleRender();
  }

  function setEnabled(on) {
    saveConfig(Object.assign({}, config, { enabled: on }));
    router.resetPin();
    toast(on ? "已开启" : "已关闭；当前视频刷新后完全恢复原样");
    scheduleRender();
  }

  function isListed(host) {
    return Core.CDN_LIST.some(function (c) { return c.host === host; }) || config.customHosts.indexOf(host) !== -1;
  }

  function addCustomHost(value) {
    const h = Core.cleanHost(value);
    if (!Core.isValidHost(h)) {
      toast("地址格式不对，例如 upos-sz-mirrorxxx.bilivideo.com");
      return false;
    }
    if (isListed(h)) {
      toast("这条线路已在列表里");
      return false;
    }
    saveConfig(Object.assign({}, config, { customHosts: config.customHosts.concat(h) }));
    toast("已添加，可单独测速后选用");
    scheduleRender();
    return true;
  }

  function removeHost(host) {
    saveConfig(Object.assign({}, config, {
      customHosts: config.customHosts.filter(function (h) { return h !== host; })
    }));
    test.extra = test.extra.filter(function (h) { return h !== host; });
    delete test.results[host];
    saveResults();
    if (config.pin === host) {
      pinHost("");
    }
    scheduleRender();
  }

  // ---- 界面 -----------------------------------------------------------------

  const ICONS = {
    speed: "M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z",
    play: "M8 5v14l11-7z",
    stop: "M6 6h12v12H6z",
    refresh: "M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    bolt: "M7 2v11h3v9l7-12h-4l4-8z",
    del: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
    expand: "M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z",
    warn: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
    palette: "M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
    colorize: "M20.71 5.63l-2.34-2.34a1 1 0 0 0-1.41 0l-3.12 3.12-1.93-1.91-1.41 1.41 1.42 1.42L3 16.25V21h4.75l8.92-8.92 1.42 1.42 1.41-1.41-1.92-1.92 3.12-3.12a1 1 0 0 0 .01-1.42zM6.92 19 5 17.08l8.06-8.06 1.92 1.92L6.92 19z"
  };

  const COLOR_PRESETS = [
    ["#fb7299", "B站粉"], ["#00aeec", "B站蓝"], ["#0078d4", "Windows 蓝"],
    ["#6750a4", "M3 紫"], ["#386a20", "绿"], ["#e8710a", "橙"]
  ];
  // M3 的 error 角色，外加测速结果用的好/中两档，不随种子变化。
  const STATUS_COLORS = {
    light: { "--good": "#1b7f4c", "--mid": "#8a5a00", "--bad": "#ba1a1a", "--bad-c": "#ffdad6", "--on-bad-c": "#410002" },
    dark: { "--good": "#7dd8a0", "--mid": "#f0bf5a", "--bad": "#ffb4ab", "--bad-c": "#93000a", "--on-bad-c": "#ffdad6" }
  };

  // 配色变量（--p、--s3……）不写在这里：applyTheme() 按种子色和深浅模式算好，设在宿主元素上。
  const CSS = [
    ":host{--e1:0 1px 2px rgba(0,0,0,.3),0 1px 3px 1px rgba(0,0,0,.15);--e3:0 1px 3px rgba(0,0,0,.3),0 4px 8px 3px rgba(0,0,0,.15);",
    "--font:Roboto,'Noto Sans SC','PingFang SC','Microsoft YaHei',system-ui,-apple-system,'Segoe UI',sans-serif;",
    "--mono:ui-monospace,'SF Mono','JetBrains Mono',Consolas,Menlo,monospace;font-family:var(--font);color:var(--on-s)}",
    "*{box-sizing:border-box}button,input{font:inherit;color:inherit}svg{width:24px;height:24px;display:block;flex:none}",
    // 悬浮按钮（M3 小号 FAB），可沿左右边缘拖动
    ".fab{position:fixed;width:44px;height:44px;border:0;border-radius:14px;padding:0;display:grid;place-items:center;background:var(--pc);color:var(--on-pc);box-shadow:var(--e3);cursor:pointer;touch-action:none;transition:opacity .2s,transform .2s,box-shadow .2s}",
    ".fab::before{content:'';position:absolute;inset:0;border-radius:inherit;background:currentColor;opacity:0;transition:opacity .15s}",
    ".fab:hover::before{opacity:.08}.fab:active::before{opacity:.12}.fab:focus-visible{outline:3px solid var(--p);outline-offset:2px}",
    ".fab.off{background:var(--s3);color:var(--on-sv)}",
    ".fab.hidden{opacity:0;pointer-events:none;transform:scale(.85)}",
    ".fab-dot{position:absolute;top:5px;right:5px;width:8px;height:8px;border-radius:50%;background:var(--p);box-shadow:0 0 0 2px var(--pc);display:none}",
    ".fab.pinned .fab-dot{display:block}",
    ".fab.busy svg{animation:bcp-pulse 1.2s ease-in-out infinite}",
    "@keyframes bcp-pulse{50%{opacity:.35}}",
    // 对话框
    ".scrim{position:fixed;inset:0;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.32)}",
    ".scrim.open{display:flex;animation:bcp-fade .15s ease-out}",
    ".dialog{width:min(480px,100%);max-height:min(820px,calc(100vh - 32px));display:flex;flex-direction:column;overflow:hidden;background:var(--s3);border-radius:28px;box-shadow:var(--e3);outline:none;animation:bcp-pop .22s cubic-bezier(.2,0,0,1)}",
    "@keyframes bcp-fade{from{opacity:0}}@keyframes bcp-pop{from{opacity:0;transform:translateY(8px) scale(.97)}}",
    ".hd{display:flex;align-items:center;gap:14px;padding:22px 20px 14px 24px}",
    ".hd-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--pc);color:var(--on-pc)}",
    ".hd-text{flex:1;min-width:0}.title{font-size:22px;line-height:28px;font-weight:500}",
    ".subtitle{font-size:13px;line-height:18px;color:var(--on-sv);margin-top:2px}",
    ".bd{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:2px 12px 8px}",
    ".ft{display:flex;align-items:center;justify-content:space-between;padding:10px 16px 14px 24px;border-top:1px solid var(--olv)}",
    ".ver{font-size:12px;color:var(--on-sv)}",
    // 状态卡
    ".status{margin:2px 4px 14px;padding:14px 16px;border-radius:20px;background:var(--s1)}",
    ".status.pin{background:var(--pc);color:var(--on-pc)}.status.off{background:var(--s4)}",
    ".st-label{font-size:12px;font-weight:500;opacity:.8}",
    ".st-title{font-size:17px;line-height:24px;font-weight:600;margin-top:1px}",
    ".st-host{font-family:var(--mono);font-size:12px;opacity:.75;word-break:break-all}",
    ".st-lines{display:grid;gap:3px;margin-top:10px;font-size:12.5px;line-height:18px}",
    ".st-lines:empty{display:none}",
    ".st-warn{display:flex;align-items:flex-start;gap:8px;margin-top:10px;padding:8px 10px;border-radius:12px;background:var(--bad-c);color:var(--on-bad-c);font-size:12.5px;line-height:18px}",
    ".st-warn svg{width:16px;height:16px;margin-top:1px}",
    // 按钮
    ".toolbar{display:flex;flex-wrap:wrap;gap:8px;padding:0 4px}",
    ".btn{position:relative;overflow:hidden;height:40px;border:0;border-radius:20px;padding:0 20px 0 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font-size:14px;font-weight:500;letter-spacing:.1px;cursor:pointer;white-space:nowrap}",
    ".btn svg{width:18px;height:18px}",
    ".btn::before{content:'';position:absolute;inset:0;background:currentColor;opacity:0;transition:opacity .15s}",
    ".btn:hover::before{opacity:.08}.btn:active::before{opacity:.12}.btn:focus-visible{outline:2px solid var(--p);outline-offset:2px}",
    ".btn:disabled{opacity:.38;cursor:default}.btn:disabled::before{display:none}",
    ".btn.filled{background:var(--p);color:var(--on-p)}.btn.tonal{background:var(--sc);color:var(--on-sc)}",
    ".btn.text{background:none;color:var(--p);padding:0 12px}.btn.small{height:32px;font-size:13px;padding:0 12px}",
    ".btn.outlined{background:none;border:1px solid var(--ol);color:var(--p);padding:0 16px}",
    ".test-info{min-height:20px;padding:10px 8px 2px;font-size:12px;line-height:17px;color:var(--on-sv)}",
    ".test-info.err{color:var(--bad)}",
    // 线路列表（M3 单选列表）
    ".group{display:flex;align-items:center;justify-content:space-between;padding:14px 4px 4px 12px;font-size:13px;font-weight:600;color:var(--p)}",
    ".group .count{font-weight:400;color:var(--on-sv);margin-left:6px}",
    ".row{position:relative;display:flex;align-items:center;gap:12px;min-height:60px;padding:8px 6px 8px 12px;border-radius:16px;cursor:pointer;outline:none}",
    ".row:hover{background:color-mix(in srgb,var(--on-s) 7%,transparent)}",
    ".row:focus-visible{box-shadow:inset 0 0 0 2px var(--p)}",
    ".row.sel{background:var(--sc);color:var(--on-sc)}",
    ".row.native{margin-top:2px}",
    ".radio{width:20px;height:20px;flex:none;border-radius:50%;border:2px solid var(--on-sv);display:grid;place-items:center}",
    ".row.sel .radio{border-color:var(--p)}.row.sel .radio::after{content:'';width:10px;height:10px;border-radius:50%;background:var(--p)}",
    ".main{flex:1;min-width:0}",
    ".name{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:14.5px;line-height:20px;font-weight:500}",
    ".host{margin-top:1px;font-family:var(--mono);font-size:11.5px;line-height:16px;color:var(--on-sv);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".host.plain{font-family:var(--font);white-space:normal}",
    ".row.sel .host,.row.sel .sub{color:inherit;opacity:.75}",
    ".chip{height:18px;padding:0 6px;border-radius:6px;border:1px solid var(--olv);font-size:10.5px;line-height:16px;font-weight:500;color:var(--on-sv)}",
    ".row.sel .chip{border-color:currentColor;color:inherit;opacity:.8}",
    ".chip.best{border-color:transparent;background:var(--good);color:var(--s1);opacity:1}",
    ".chip.warn{border-color:var(--bad);color:var(--bad)}",
    ".metric{width:100px;flex:none;text-align:right}",
    ".spd{font-size:16px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums}",
    ".spd small{font-size:11px;font-weight:500;opacity:.75}",
    ".spd.good{color:var(--good)}.spd.mid{color:var(--mid)}.spd.bad,.spd.fail{color:var(--bad)}.spd.fail{font-size:13px}",
    ".sub{margin-top:1px;font-size:11px;line-height:15px;color:var(--on-sv);white-space:nowrap}.sub.run{color:var(--p);opacity:1}",
    ".bar{height:4px;margin-top:5px;border-radius:2px;background:var(--s4);overflow:hidden}",
    ".row.sel .bar{background:color-mix(in srgb,currentColor 15%,transparent)}",
    ".bar i{display:block;height:100%;border-radius:2px;transition:width .25s}",
    ".bar.good i{background:var(--good)}.bar.mid i{background:var(--mid)}.bar.bad i{background:var(--bad)}.bar.run i{background:var(--p)}",
    ".icon-btn{width:32px;height:32px;flex:none;border:0;border-radius:16px;padding:0;background:none;color:var(--on-sv);display:grid;place-items:center;cursor:pointer;opacity:0;transition:opacity .15s,background .15s}",
    ".icon-btn svg{width:18px;height:18px}",
    ".row:hover .icon-btn,.row:focus-within .icon-btn,.icon-btn:focus-visible{opacity:1}",
    ".icon-btn:hover{background:color-mix(in srgb,currentColor 12%,transparent)}.icon-btn:disabled{opacity:0!important;pointer-events:none}",
    ".row.sel .icon-btn{color:inherit}",
    "@media (hover:none){.icon-btn{opacity:1}}",
    // 设置
    "details{margin:14px 0 2px;border-top:1px solid var(--olv)}",
    "summary{list-style:none;display:flex;align-items:center;justify-content:space-between;padding:14px 8px 10px 12px;font-size:14px;font-weight:600;cursor:pointer;border-radius:12px}",
    "summary::-webkit-details-marker{display:none}summary svg{transition:transform .2s;color:var(--on-sv)}details[open] summary svg{transform:rotate(180deg)}",
    "summary:focus-visible{outline:2px solid var(--p)}",
    ".set{display:flex;align-items:center;gap:16px;padding:10px 12px}",
    ".set-text{flex:1;min-width:0}.set-title{font-size:14px;line-height:20px}",
    ".set-note{margin-top:2px;font-size:12px;line-height:17px;color:var(--on-sv)}",
    ".switch{position:relative;width:52px;height:32px;flex:none}",
    ".switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}",
    ".track{position:absolute;inset:0;border-radius:16px;border:2px solid var(--ol);background:var(--s4);pointer-events:none;transition:background .2s,border-color .2s}",
    ".track::after{content:'';position:absolute;top:50%;left:6px;width:16px;height:16px;border-radius:50%;background:var(--ol);transform:translateY(-50%);transition:all .2s cubic-bezier(.2,0,0,1)}",
    ".switch input:checked+.track{background:var(--p);border-color:var(--p)}",
    ".switch input:checked+.track::after{left:22px;width:24px;height:24px;background:var(--on-p)}",
    ".switch input:focus-visible+.track{outline:2px solid var(--p);outline-offset:2px}",
    ".seg{display:inline-flex;height:32px;flex:none;border:1px solid var(--ol);border-radius:16px;overflow:hidden}",
    ".seg button{border:0;background:none;padding:0 12px;font-size:12.5px;cursor:pointer;color:var(--on-s)}",
    ".seg button+button{border-left:1px solid var(--ol)}",
    ".seg button[aria-pressed=true]{background:var(--sc);color:var(--on-sc);font-weight:600}",
    ".seg button:focus-visible{outline:2px solid var(--p);outline-offset:-2px}",
    ".inline{display:flex;align-items:center;gap:8px;padding:2px 12px 10px}",
    ".field{flex:1;min-width:0;height:36px;padding:0 10px;border:1px solid var(--ol);border-radius:8px;background:transparent;font-family:var(--mono);font-size:12.5px;outline:none}",
    ".field:focus{border-color:var(--p);box-shadow:inset 0 0 0 1px var(--p)}",
    ".actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:8px 4px 6px}",
    ".sec-label{padding:12px 12px 2px;font-size:12px;font-weight:600;color:var(--p)}",
    ".swatches{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:4px 12px 12px}",
    ".sw{position:relative;width:28px;height:28px;flex:none;border:0;border-radius:50%;padding:0;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.14);transition:transform .12s}",
    ".sw:hover{transform:scale(1.1)}.sw:focus-visible{outline:2px solid var(--p);outline-offset:3px}",
    ".sw[aria-pressed=true]{box-shadow:0 0 0 2px var(--s3),0 0 0 4px var(--on-s)}",
    ".sw-custom{display:grid;place-items:center;background:conic-gradient(#f44,#fd4,#4d6,#4cf,#46f,#d4f,#f44)}",
    ".sw-custom svg{width:16px;height:16px;color:#fff;filter:drop-shadow(0 0 1px rgba(0,0,0,.7));pointer-events:none}",
    ".sw-custom input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;opacity:0;cursor:pointer}",
    ".sw-sep{width:1px;height:20px;background:var(--olv)}",
    // 提示条
    ".snack{position:fixed;left:50%;bottom:24px;max-width:min(560px,calc(100vw - 32px));padding:13px 16px;border-radius:6px;background:var(--inv-s);color:var(--inv-on-s);font-size:14px;line-height:20px;box-shadow:var(--e3);opacity:0;pointer-events:none;transform:translate(-50%,12px);transition:opacity .2s,transform .2s}",
    ".snack.show{opacity:1;transform:translate(-50%,0)}",
    "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}"
  ].join("");

  const ui = {
    host: null, shadow: null, fab: null, scrim: null, snack: null, refs: {}, open: false, queued: false,
    reveal: false, toastTimer: null, themeKey: ""
  };

  // ---- 主题 -----------------------------------------------------------------

  function prefersDark() {
    try {
      return !!(root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (_) {
      return false;
    }
  }

  function isDark() {
    return config.themeMode === "dark" || (config.themeMode === "system" && prefersDark());
  }

  function applyTheme() {
    if (!ui.host) {
      return;
    }
    const dark = isDark();
    const seed = config.seedColor;
    const key = seed + "|" + dark;
    if (key === ui.themeKey) {
      return;
    }
    ui.themeKey = key;
    const vars = Object.assign(Core.schemeFrom(seed, dark), STATUS_COLORS[dark ? "dark" : "light"]);
    Object.keys(vars).forEach(function (name) { ui.host.style.setProperty(name, vars[name]); });
    ui.host.style.colorScheme = dark ? "dark" : "light"; // 让滚动条、取色器等原生控件跟着变
  }

  function setSeed(hex) {
    const color = Core.parseColor(hex);
    if (!color) {
      return;
    }
    saveConfig(Object.assign({}, config, { seedColor: color }));
    scheduleRender();
  }

  // EyeDropper（Chrome / Edge）能吸屏幕上任意位置，包括任务栏和开始菜单里的 Win11 强调色。
  function pickFromScreen() {
    if (typeof root.EyeDropper !== "function") {
      return;
    }
    try {
      new root.EyeDropper().open().then(function (result) {
        setSeed(result.sRGBHex);
        toast("已取色 " + Core.parseColor(result.sRGBHex));
      }, function () {});
    } catch (_) {}
  }

  function h(tag, props) {
    const el = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      const v = props[k];
      if (v == null || v === false) {
        return;
      }
      if (k === "class") {
        el.className = v;
      } else if (k === "text") {
        el.textContent = v;
      } else if (k.slice(0, 2) === "on") {
        el.addEventListener(k.slice(2), v);
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    });
    for (let i = 2; i < arguments.length; i += 1) {
      append(el, arguments[i]);
    }
    return el;
  }

  function append(el, child) {
    if (child == null || child === false) {
      return;
    }
    if (Array.isArray(child)) {
      child.forEach(function (c) { append(el, c); });
      return;
    }
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }

  function icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICONS[name]);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
    return svg;
  }

  function clear(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function fmt(mbps) {
    return mbps >= 100 ? String(Math.round(mbps)) : (mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2));
  }

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) {
      return "刚刚";
    }
    if (s < 3600) {
      return Math.floor(s / 60) + " 分钟前";
    }
    return s < 86400 ? Math.floor(s / 3600) + " 小时前" : Math.floor(s / 86400) + " 天前";
  }

  // 颜色只是参考：以当前视频码率（至少按 5 Mbps 算）为基准，3 倍以上为绿、1.3 倍以上为黄。
  function toneOf(mbps) {
    const base = Math.max(5, (test.meta && test.meta.requiredMbps) || 0);
    return mbps >= base * 3 ? "good" : (mbps >= base * 1.3 ? "mid" : "bad");
  }

  function failText(r) {
    switch (r.error) {
      case "unavailable": return "未下发";
      case "timeout": return "超时";
      case "http": return "失败 " + r.status;
      case "short": return "数据不足";
      default: return "无法连接";
    }
  }

  function toast(text) {
    if (!ui.snack) {
      return;
    }
    ui.snack.textContent = text;
    ui.snack.classList.add("show");
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(function () { ui.snack.classList.remove("show"); }, 2800);
  }

  function scheduleRender() {
    if (!ui.shadow || ui.queued) {
      return;
    }
    ui.queued = true;
    const run = function () {
      ui.queued = false;
      render();
    };
    if (typeof root.requestAnimationFrame === "function" && !document.hidden) {
      root.requestAnimationFrame(run);
    } else {
      setTimeout(run, 50);
    }
  }

  function render() {
    if (!ui.shadow) {
      return;
    }
    applyTheme();
    renderFab();
    if (!ui.open) {
      return;
    }
    renderStatus();
    renderToolbar();
    renderList();
    renderSettings();
  }

  function renderFab() {
    const fab = ui.fab;
    if (!fab) {
      return;
    }
    fab.classList.toggle("off", !config.enabled);
    fab.classList.toggle("pinned", config.enabled && !!config.pin);
    fab.classList.toggle("busy", test.running);
    const title = !config.enabled ? "CDN 线路：已关闭" : (config.pin ? "CDN 线路：固定 " + labelOf(config.pin) : "CDN 线路：B站默认");
    fab.title = title;
    fab.setAttribute("aria-label", title);
    if (ui.dragging) {
      return;
    }
    fab.style.left = config.fab.side === "left" ? "16px" : "auto";
    fab.style.right = config.fab.side === "right" ? "16px" : "auto";
    fab.style.bottom = Math.min(config.fab.bottom, Math.max(8, root.innerHeight - 60)) + "px";
  }

  function renderStatus() {
    const el = ui.refs.status;
    const s = router.status();
    clear(el);
    let tone = "native";
    let label = "当前线路";
    let title = "B站默认线路";
    let sub = "不固定，只把 P2P / PCDN 节点换成正常线路";
    if (!config.enabled) {
      tone = "off";
      label = "已关闭";
      title = "不改写任何地址";
      sub = "当前视频刷新后完全恢复原样";
    } else if (config.pin) {
      tone = "pin";
      label = "已固定";
      title = labelOf(config.pin);
      sub = config.pin;
    }
    el.className = "status " + tone;
    const lines = h("div", { class: "st-lines" });
    if (config.enabled && s.hasVideo) {
      const parts = [];
      if (s.rewritten) {
        parts.push("已改写 " + s.rewritten + " 条地址");
      }
      if (s.avoided) {
        parts.push("避开 " + s.avoided + " 个 P2P/PCDN 节点");
      }
      if (parts.length) {
        append(lines, h("div", { text: parts.join(" · ") }));
      }
      const mbps = playbackMbps();
      if (mbps > 0) {
        const need = s.requiredBps > 0 ? "，当前清晰度约需 " + fmt(s.requiredBps / 1e6) + " Mbps" : "";
        append(lines, h("div", { text: "播放分段实测 " + fmt(mbps) + " Mbps" + need }));
      }
    }
    append(el, [
      h("div", { class: "st-label", text: label }),
      h("div", { class: "st-title", text: title }),
      h("div", { class: "st-host", text: sub }),
      lines
    ]);
    const warn = function (text) {
      append(el, h("div", { class: "st-warn" }, icon("warn"), h("span", { text })));
    };
    if (config.enabled && config.pin) {
      if (s.pinBroken) {
        warn("所选线路连续请求失败，本页已临时回退 B 站原线路。刷新或重新选择后恢复固定。");
      } else if (s.pinFailures > 0) {
        warn("所选线路已有 " + s.pinFailures + " 次请求失败" + (config.strict ? "。若播放卡住，请换一条线路，或在设置里关闭「严格固定」。" : "。"));
      }
      if (s.unavailable) {
        warn("B 站没给这个视频下发「" + labelOf(config.pin) + "」的地址（Akamai 只能用下发的地址），本视频改用原线路。");
      }
    }
    if (root.__BILI_ACCELERATOR_INSTALLED__) {
      warn("检测到 Bilibili Accelerator 也在运行，两者会互相改写地址，请只保留一个。");
    }
  }

  function renderToolbar() {
    const btn = ui.refs.testBtn;
    clear(btn);
    if (test.running) {
      btn.className = "btn tonal";
      append(btn, [icon("stop"), "停止"]);
    } else {
      btn.className = "btn filled";
      append(btn, [icon("play"), "全部测速"]);
    }
    btn.disabled = !nativeFetch;
    ui.refs.bestBtn.disabled = test.running || !bestHost() || bestHost() === config.pin;
    const info = ui.refs.testInfo;
    info.className = "test-info" + (test.error ? " err" : "");
    if (test.error) {
      info.textContent = test.error;
    } else if (test.running) {
      info.textContent = test.current
        ? "正在测速 " + labelOf(test.current) + "（" + test.index + "/" + test.queue.length + "）· 样本：" + (test.meta ? test.meta.label : "")
        : "正在获取测速样本…";
    } else if (test.meta) {
      info.textContent = "上次测速 " + ago(test.meta.at) + " · 样本：" + test.meta.label + " · 每条 " + test.meta.mb + " MB";
    } else {
      info.textContent = "点「全部测速」逐条下载一段视频，按实测速度挑一条固定使用。测速时建议先暂停视频。";
    }
  }

  function groupsOf() {
    const issued = isPlayerPage() ? router.currentIssued() : [];
    const groups = [
      { id: "overseas", title: "海外", items: [] },
      { id: "mainland", title: "大陆", items: [] },
      { id: "other", title: "其他", items: [] }
    ];
    const seen = [];
    function add(group, item) {
      if (seen.indexOf(item.host) !== -1) {
        return;
      }
      seen.push(item.host);
      item.issued = issued.indexOf(item.host) !== -1;
      group.items.push(item);
    }
    Core.CDN_LIST.forEach(function (c) {
      add(groups[c.region === "overseas" ? 0 : 1], { host: c.host, name: c.name });
    });
    config.customHosts.forEach(function (x) { add(groups[2], { host: x, name: "自定义", removable: true }); });
    issued.concat(test.extra).forEach(function (x) {
      add(groups[2], { host: x, name: shortHost(x), removable: test.extra.indexOf(x) !== -1 && issued.indexOf(x) === -1 });
    });
    if (config.pin) {
      add(groups[2], { host: config.pin, name: shortHost(config.pin) });
    }
    return groups.filter(function (g) { return g.items.length; });
  }

  function allItems() {
    return groupsOf().reduce(function (all, g) { return all.concat(g.items); }, []);
  }

  function rowOf(item, best, maxMbps) {
    const sel = config.enabled && config.pin === item.host;
    const r = test.results[item.host];
    const live = test.live[item.host];
    const testing = test.current === item.host;
    const metric = h("div", { class: "metric" });
    if (testing) {
      append(metric, [
        h("div", { class: "spd" }, live && live.mbps ? fmt(live.mbps) : "…", live && live.mbps ? h("small", { text: " Mbps" }) : null),
        h("div", { class: "sub run", text: live && live.frac ? "测速中 " + Math.round(live.frac * 100) + "%" : "连接中" }),
        h("div", { class: "bar run" }, h("i", { style: "width:" + Math.round((live ? live.frac : 0) * 100) + "%" }))
      ]);
    } else if (!r) {
      append(metric, h("div", { class: "sub", text: test.running && test.queue.indexOf(item.host) >= test.index ? "排队中" : "未测速" }));
    } else if (!r.ok) {
      append(metric, [h("div", { class: "spd fail", text: failText(r) }), h("div", { class: "sub", text: ago(r.at) })]);
    } else {
      const tone = toneOf(r.mbps);
      append(metric, [
        h("div", { class: "spd " + tone }, fmt(r.mbps), h("small", { text: " Mbps" })),
        h("div", { class: "sub", text: "首包 " + Math.round(r.ttfb) + " ms" }),
        h("div", { class: "bar " + tone }, h("i", { style: "width:" + Math.max(3, Math.round(r.mbps / maxMbps * 100)) + "%" }))
      ]);
    }
    const chips = [];
    if (best === item.host) {
      chips.push(h("span", { class: "chip best", text: "最快" }));
    }
    if (item.issued) {
      chips.push(h("span", { class: "chip", text: "下发", title: "B 站给当前视频下发了这条线路" }));
    }
    if (sel && router.status().unavailable) {
      chips.push(h("span", { class: "chip warn", text: "本视频不可用" }));
    }
    return h("div", {
      class: "row" + (sel ? " sel" : "") + (testing ? " testing" : ""),
      role: "radio",
      "aria-checked": String(sel),
      tabindex: "0",
      "data-host": item.host
    },
    h("span", { class: "radio" }),
    h("div", { class: "main" }, h("div", { class: "name" }, item.name, chips), h("div", { class: "host", text: item.host, title: item.host })),
    metric,
    h("button", { class: "icon-btn", type: "button", title: "单独测速", "aria-label": "单独测速 " + item.host, "data-act": "test", "data-host": item.host, disabled: test.running }, icon("refresh")),
    item.removable ? h("button", { class: "icon-btn", type: "button", title: "移除", "aria-label": "移除 " + item.host, "data-act": "del", "data-host": item.host }, icon("del")) : null);
  }

  function renderList() {
    const list = ui.refs.list;
    const focused = ui.shadow.activeElement;
    const focusHost = focused && focused.classList && focused.classList.contains("row") ? focused.getAttribute("data-host") : null;
    const groups = groupsOf();
    const best = bestHost();
    let maxMbps = 1;
    groups.forEach(function (g) {
      g.items.forEach(function (item) {
        const r = test.results[item.host];
        if (r && r.ok && r.mbps > maxMbps) {
          maxMbps = r.mbps;
        }
      });
    });
    clear(list);
    const nativeSel = config.enabled && !config.pin;
    append(list, h("div", {
      class: "row native" + (nativeSel ? " sel" : ""), role: "radio", "aria-checked": String(nativeSel), tabindex: "0", "data-host": ""
    },
    h("span", { class: "radio" }),
    h("div", { class: "main" },
      h("div", { class: "name", text: "B站默认线路" }),
      h("div", { class: "host plain", text: "不固定。B 站给什么用什么，只把 P2P / PCDN 节点换掉" }))));
    groups.forEach(function (g) {
      append(list, h("div", { class: "group" },
        h("span", {}, g.title, h("span", { class: "count", text: String(g.items.length) })),
        h("button", { class: "btn text small", type: "button", "data-act": "group", "data-group": g.id, disabled: test.running, text: "测速本组" })));
      g.items.forEach(function (item) { append(list, rowOf(item, best, maxMbps)); });
    });
    if (focusHost !== null) {
      const again = list.querySelector(".row[data-host=\"" + focusHost.replace(/"/g, "") + "\"]");
      if (again) {
        // 不滚动：列表随分段请求频繁重绘，用户正在翻看时不能被拽回去。
        again.focus({ preventScroll: true });
      }
    }
  }

  function renderSettings() {
    const refs = ui.refs;
    refs.master.checked = config.enabled;
    Object.keys(refs.switches).forEach(function (k) { refs.switches[k].checked = !!config[k]; });
    Object.keys(refs.segs).forEach(function (k) {
      Array.prototype.forEach.call(refs.segs[k].children, function (b) {
        b.setAttribute("aria-pressed", String(b.getAttribute("data-value") === String(config[k])));
      });
    });
    if (ui.shadow.activeElement !== refs.bvid) {
      refs.bvid.value = config.sampleBvid;
    }
    // 外观：选中态标在当前种子色上；不在预设里的颜色（取色器、屏幕取色）显示在自定义色块上。
    const seed = config.seedColor;
    const preset = COLOR_PRESETS.some(function (p) { return p[0] === seed; });
    refs.swatches.forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-color") === seed));
    });
    refs.customSwatch.setAttribute("aria-pressed", String(!preset));
    refs.customSwatch.style.background = preset ? "" : seed;
    if (ui.shadow.activeElement !== refs.picker) {
      refs.picker.value = seed;
    }
    const name = COLOR_PRESETS.filter(function (p) { return p[0] === seed; }).map(function (p) { return p[1] + " "; })[0] || "";
    refs.seedNote.textContent = "正在使用 " + name + seed;
  }

  function switchEl(checked, onChange, label) {
    const input = h("input", { type: "checkbox", role: "switch", "aria-label": label });
    input.checked = checked;
    input.addEventListener("change", function () { onChange(input.checked); });
    return { el: h("label", { class: "switch" }, input, h("span", { class: "track" })), input };
  }

  function settingSwitch(key, title, note, after) {
    const sw = switchEl(!!config[key], function (on) {
      const patch = {};
      patch[key] = on;
      saveConfig(Object.assign({}, config, patch));
      router.resetPin();
      if (after) {
        after(on);
      }
      scheduleRender();
    }, title);
    ui.refs.switches[key] = sw.input;
    return h("div", { class: "set" },
      h("div", { class: "set-text" }, h("div", { class: "set-title", text: title }), h("div", { class: "set-note", text: note })),
      sw.el);
  }

  function settingSeg(key, title, note, options) {
    const seg = h("div", { class: "seg", role: "group", "aria-label": title });
    options.forEach(function (o) {
      append(seg, h("button", {
        type: "button",
        "data-value": String(o[0]),
        onclick: function () {
          const patch = {};
          patch[key] = o[0];
          saveConfig(Object.assign({}, config, patch));
          scheduleRender();
        }
      }, o[1]));
    });
    ui.refs.segs[key] = seg;
    ui.refs.notes[key] = h("div", { class: "set-note", text: note || "" });
    return h("div", { class: "set" },
      h("div", { class: "set-text" }, h("div", { class: "set-title", text: title }), ui.refs.notes[key]),
      seg);
  }

  function appearanceSection() {
    const refs = ui.refs;
    refs.swatches = COLOR_PRESETS.map(function (p) {
      return h("button", {
        class: "sw", type: "button", title: p[1] + " " + p[0], "aria-label": p[1], "data-color": p[0],
        style: "background:" + p[0], onclick: function () { setSeed(p[0]); }
      });
    });
    refs.picker = h("input", { type: "color", "aria-label": "自定义颜色" });
    refs.picker.addEventListener("input", function () { setSeed(refs.picker.value); });
    refs.customSwatch = h("label", { class: "sw sw-custom", title: "自定义颜色" }, refs.picker, icon("palette"));
    refs.seedNote = h("div", { class: "set-note" });
    return [
      h("div", { class: "sec-label", text: "外观" }),
      settingSeg("themeMode", "深浅模式", "", [["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]),
      h("div", { class: "set" }, h("div", { class: "set-text" }, h("div", { class: "set-title", text: "主题色" }), refs.seedNote)),
      h("div", { class: "swatches" },
        refs.swatches,
        h("span", { class: "sw-sep" }),
        refs.customSwatch,
        typeof root.EyeDropper === "function"
          ? h("button", { class: "btn tonal small", type: "button", onclick: pickFromScreen }, icon("colorize"), "屏幕取色")
          : null),
      h("div", { class: "sec-label", text: "线路与测速" })
    ];
  }

  function buildUi() {
    if (ui.host || !document.documentElement || root.top !== root) {
      return;
    }
    const host = h("div", { id: HOST_ID });
    host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;";
    const shadow = host.attachShadow({ mode: "open" });
    const refs = ui.refs;
    refs.switches = {};
    refs.segs = {};
    refs.notes = {};

    const fab = h("button", { class: "fab", type: "button" }, icon("speed"), h("span", { class: "fab-dot" }));
    setupFab(fab);

    const master = switchEl(config.enabled, setEnabled, "启用");
    refs.master = master.input;
    refs.status = h("div", { class: "status" });
    refs.testBtn = h("button", {
      class: "btn filled",
      type: "button",
      onclick: function () {
        if (test.running) {
          test.stop = true;
        } else {
          runTest(allItems().map(function (i) { return i.host; }), true);
        }
      }
    });
    refs.bestBtn = h("button", {
      class: "btn tonal",
      type: "button",
      title: "固定到测速最快的线路（只在你点击时切换）",
      onclick: function () {
        const best = bestHost();
        if (best) {
          pinHost(best);
        }
      }
    }, icon("bolt"), "选最快的");
    refs.testInfo = h("div", { class: "test-info" });
    refs.list = h("div", { class: "list", role: "radiogroup", "aria-label": "CDN 线路" });
    refs.list.addEventListener("click", function (event) {
      const act = event.target.closest("[data-act]");
      if (act) {
        const kind = act.getAttribute("data-act");
        if (kind === "test") {
          runTest([act.getAttribute("data-host")], false);
        } else if (kind === "del") {
          removeHost(act.getAttribute("data-host"));
        } else if (kind === "group") {
          const g = groupsOf().filter(function (x) { return x.id === act.getAttribute("data-group"); })[0];
          if (g) {
            runTest(g.items.map(function (i) { return i.host; }), false);
          }
        }
        return;
      }
      const row = event.target.closest(".row[data-host]");
      if (row) {
        pinHost(row.getAttribute("data-host"));
      }
    });
    refs.list.addEventListener("keydown", function (event) {
      const row = event.target;
      if ((event.key === "Enter" || event.key === " ") && row.classList && row.classList.contains("row")) {
        event.preventDefault();
        pinHost(row.getAttribute("data-host"));
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && row.classList && row.classList.contains("row")) {
        event.preventDefault();
        const rows = Array.prototype.slice.call(refs.list.querySelectorAll(".row"));
        const next = rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          next.focus();
        }
      }
    });

    refs.bvid = h("input", { class: "field", type: "text", spellcheck: "false", "aria-label": "样本视频 BV 号", placeholder: "BV1xxxxxxxxx" });
    refs.bvid.addEventListener("change", function () {
      const v = refs.bvid.value.trim();
      if (/^BV[0-9A-Za-z]{10}$/.test(v)) {
        saveConfig(Object.assign({}, config, { sampleBvid: v }));
        toast("样本视频已设为 " + v);
      } else {
        refs.bvid.value = config.sampleBvid;
        toast("BV 号格式不对");
      }
    });
    const customInput = h("input", { class: "field", type: "text", spellcheck: "false", "aria-label": "自定义线路域名", placeholder: "upos-sz-mirrorxxx.bilivideo.com" });
    const addCustom = function () {
      if (addCustomHost(customInput.value)) {
        customInput.value = "";
      }
    };
    customInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        addCustom();
      }
    });

    const settings = h("details", {},
      h("summary", {}, h("span", { text: "设置" }), icon("expand")),
      appearanceSection(),
      settingSwitch("strict", "严格固定",
        "备用地址也指向所选线路，播放器没法自己换线。关闭后，所选线路请求失败时允许临时回退 B 站原线路（只看失败，不看速度）。"),
      settingSwitch("mcdnProxy", "MCDN 走官方代理", "极少数只有 MCDN 地址、换不了域名的视频，经 " + Core.DEFAULTS.proxyHost + " 转发。"),
      settingSwitch("p2pGuard", "阻止 P2P 上传", "禁用网页版的 P2P SDK 和 WebRTC，不再占用你的上行带宽。刷新后生效。", function () {
        toast("刷新页面后生效");
      }),
      settingSeg("testMB", "每条线路下载量", "越大越准，耗时也越长", Core.TEST_SIZES.map(function (n) { return [n, n + " MB"]; })),
      settingSeg("sampleMode", "测速样本", "视频页用正在播的文件最能代表实际体验", [["auto", "当前视频"], ["fixed", "样本视频"]]),
      h("div", { class: "set" }, h("div", { class: "set-text" },
        h("div", { class: "set-title", text: "样本视频" }),
        h("div", { class: "set-note", text: "不在视频页、或选了「样本视频」时用它测速" }))),
      h("div", { class: "inline" }, refs.bvid),
      h("div", { class: "set" }, h("div", { class: "set-text" },
        h("div", { class: "set-title", text: "添加自定义线路" }),
        h("div", { class: "set-note", text: "任何接受 UPOS 签名路径的域名，例如其它 upos-* 镜像或自建反代" }))),
      h("div", { class: "inline" }, customInput, h("button", { class: "btn tonal small", type: "button", onclick: addCustom }, icon("add"), "添加")),
      h("div", { class: "actions" },
        h("button", {
          class: "btn outlined small",
          type: "button",
          onclick: function () {
            test.results = {};
            test.meta = null;
            test.extra = [];
            saveResults();
            scheduleRender();
          }
        }, "清除测速记录"),
        h("button", {
          class: "btn outlined small",
          type: "button",
          onclick: function () {
            if (root.confirm("恢复默认设置？固定线路和自定义线路都会清除。")) {
              saveConfig({ fab: config.fab });
              router.resetPin();
              toast("已恢复默认设置");
              scheduleRender();
            }
          }
        }, "恢复默认设置")));

    const dialog = h("div", { class: "dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "bcp-title", tabindex: "-1" },
      h("div", { class: "hd" },
        h("div", { class: "hd-icon" }, icon("speed")),
        h("div", { class: "hd-text" },
          h("div", { class: "title", id: "bcp-title", text: "CDN 线路" }),
          h("div", { class: "subtitle", text: "测速后手动选择，选定后一直使用" })),
        master.el),
      h("div", { class: "bd" },
        refs.status,
        h("div", { class: "toolbar" }, refs.testBtn, refs.bestBtn),
        refs.testInfo,
        refs.list,
        settings),
      h("div", { class: "ft" },
        h("span", { class: "ver", text: "Bilibili CDN Pin v" + VERSION }),
        h("button", { class: "btn text", type: "button", onclick: closeDialog, text: "关闭" })));
    refs.dialog = dialog;

    const scrim = h("div", { class: "scrim" }, dialog);
    scrim.addEventListener("click", function (event) {
      if (event.target === scrim) {
        closeDialog();
      }
    });
    const snack = h("div", { class: "snack", role: "status", "aria-live": "polite" });

    // 面板里打字不能触发播放器快捷键（空格暂停、F 全屏……）。
    ["keydown", "keyup", "keypress"].forEach(function (type) {
      shadow.addEventListener(type, function (event) { event.stopPropagation(); });
    });

    shadow.appendChild(h("style", { text: CSS }));
    shadow.appendChild(fab);
    shadow.appendChild(scrim);
    shadow.appendChild(snack);
    document.documentElement.appendChild(host);

    ui.host = host;
    ui.shadow = shadow;
    ui.fab = fab;
    ui.scrim = scrim;
    ui.snack = snack;
    applyTheme();
    try {
      const mq = root.matchMedia("(prefers-color-scheme: dark)");
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", scheduleRender);
      } else {
        mq.addListener(scheduleRender);
      }
    } catch (_) {}

    document.addEventListener("keydown", function (event) {
      if (ui.open && event.key === "Escape") {
        event.stopPropagation();
        closeDialog();
      }
    }, true);
    document.addEventListener("mousemove", onMouseMove, { passive: true });
    setInterval(updateFabVisibility, 800);
    setInterval(function () {
      if (ui.open && !document.hidden) {
        renderStatus();
        renderToolbar();
      }
    }, 1000);
    renderFab();
  }

  // 拖动只沿左右两条边：松手时吸附到较近的一侧。
  function setupFab(fab) {
    let drag = null;
    let suppressClick = false;
    fab.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) {
        return;
      }
      drag = { x: event.clientX, y: event.clientY, bottom: parseFloat(fab.style.bottom) || config.fab.bottom, moved: false, id: event.pointerId };
    });
    fab.addEventListener("pointermove", function (event) {
      if (!drag || event.pointerId !== drag.id) {
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) {
        return;
      }
      if (!drag.moved) {
        drag.moved = true;
        ui.dragging = true;
        try { fab.setPointerCapture(event.pointerId); } catch (_) {}
      }
      const left = event.clientX < root.innerWidth / 2;
      fab.style.left = left ? "16px" : "auto";
      fab.style.right = left ? "auto" : "16px";
      fab.style.bottom = Math.min(root.innerHeight - 60, Math.max(8, drag.bottom - dy)) + "px";
    });
    const end = function (event) {
      if (!drag || event.pointerId !== drag.id) {
        return;
      }
      if (drag.moved) {
        suppressClick = true;
        ui.dragging = false;
        saveConfig(Object.assign({}, config, {
          fab: { side: event.clientX < root.innerWidth / 2 ? "left" : "right", bottom: parseFloat(fab.style.bottom) || config.fab.bottom }
        }));
      }
      drag = null;
    };
    fab.addEventListener("pointerup", end);
    fab.addEventListener("pointercancel", end);
    fab.addEventListener("click", function () {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      if (ui.open) {
        closeDialog();
      } else {
        openDialog();
      }
    });
  }

  function isImmersive() {
    const player = document.querySelector(".bpx-player-container");
    const mode = player && player.getAttribute("data-screen");
    return mode === "web" || mode === "full" || !!document.fullscreenElement;
  }

  // 网页全屏 / 全屏时藏起来，鼠标移到按钮附近再出现。
  function updateFabVisibility() {
    if (ui.fab) {
      ui.fab.classList.toggle("hidden", isImmersive() && !ui.reveal && !ui.open);
    }
  }

  function onMouseMove(event) {
    if (!ui.fab || !isImmersive()) {
      return;
    }
    const rect = ui.fab.getBoundingClientRect();
    const near = Math.abs(event.clientX - (rect.left + rect.width / 2)) < 140 &&
      Math.abs(event.clientY - (rect.top + rect.height / 2)) < 140;
    if (near !== ui.reveal) {
      ui.reveal = near;
      updateFabVisibility();
    }
  }

  function openDialog() {
    if (!ui.shadow) {
      return;
    }
    ui.open = true;
    ui.scrim.classList.add("open");
    render();
    try { ui.refs.dialog.focus({ preventScroll: true }); } catch (_) {}
  }

  function closeDialog() {
    ui.open = false;
    if (ui.scrim) {
      ui.scrim.classList.remove("open");
    }
    updateFabVisibility();
  }

  // ---- 启动 -----------------------------------------------------------------

  root.addEventListener("storage", function (event) {
    if (event.key === CONFIG_KEY) {
      config = loadConfig();
      router.resetPin();
      scheduleRender();
    } else if (event.key === RESULTS_KEY && !test.running) {
      loadResults();
      scheduleRender();
    }
  });

  // 调试用：控制台里 BiliCdnPin.status() / BiliCdnPin.pin("upos-…") / BiliCdnPin.test()
  root.BiliCdnPin = {
    version: VERSION,
    getConfig: function () { return nativeParse(nativeStringify(config)); },
    pin: function (host) { pinHost(host || ""); return config.pin; },
    test: function (hosts) { runTest(hosts || allItems().map(function (i) { return i.host; }), !hosts); },
    stop: function () { test.stop = true; },
    results: function () { return nativeParse(nativeStringify(test.results)); },
    status: function () { return router.status(); },
    route: function (url) { return router.route(url); },
    open: openDialog
  };

  patchJsonParse();
  patchFetch();
  patchXhr();
  hookGlobal("__playinfo__");
  installP2PGuard();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildUi, { once: true });
  } else {
    buildUi();
  }
})(typeof globalThis !== "undefined" ? globalThis : window);
