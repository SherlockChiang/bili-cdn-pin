"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../bili-cdn-pin.user.js");

const PATH = "/upgcxcode/91/22/123456791/123456791-1-30080.m4s";
const QUERY = "?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEuENvNC8aNEVEtEvE9IMvXBvE2ENvNCImNEVEIj0Y2J_aug859r1qXg8xNEVE5XREto8GuFGv2U7SuxI72X6fTr859r1qXg8gNEVE5XREto8z5JZC2X2gkX5L5F1eTX1jkXlsTXHeux_f2o859IB_&uipk=5&nbs=1&deadline=1700000000&gen=playurlv2&os=cosovbv&oi=1&trid=abc&mid=0&platform=pc&upsig=deadbeef&uparams=e,uipk,nbs,deadline,gen,os,oi,trid,mid,platform&bvc=vod&nettype=0&orderid=0,3&logo=80000000";
const COSOV = "https://upos-sz-mirrorcosov.bilivideo.com" + PATH + QUERY;
const ALIOV = "https://upos-sz-mirroraliov.bilivideo.com" + PATH + QUERY.replace("os=cosovbv", "os=aliovbv");
const AKAM = "https://upos-hz-mirrorakam.akamaized.net" + PATH + "?e=abc&os=akam&hdnts=exp=1700000000~hmac=ff00&upsig=aa";
const PCDN = "https://xy1x2x3x4xy.mcdn.bilivideo.cn:4483" + PATH + "?e=abc&os=mcdn&upsig=bb";
const MCDN_V1 = "https://xy5x6x7x8xy.mcdn.bilivideo.cn:8082/v1/resource/123456791-1-30080.m4s?agrr=1&os=mcdn";
const ALI = "upos-sz-mirrorali.bilivideo.com";

function cfg(patch) {
  return Core.normalizeConfig(Object.assign({}, patch));
}

function payload(base, backups, extra) {
  return {
    code: 0,
    data: Object.assign({
      timelength: 213000,
      dash: {
        duration: 213,
        video: [{
          id: 80, bandwidth: 2000000, codecs: "avc1.640032",
          baseUrl: base, base_url: base, backupUrl: backups.slice(), backup_url: backups.slice()
        }],
        audio: [{
          id: 30280, bandwidth: 320000, codecs: "mp4a.40.2",
          baseUrl: base.replace("30080", "30280"), base_url: base.replace("30080", "30280"),
          backupUrl: backups.map(function (u) { return u.replace("30080", "30280"); }),
          backup_url: backups.map(function (u) { return u.replace("30080", "30280"); })
        }]
      }
    }, extra || {})
  };
}

function routerWith(patch, clock) {
  const state = { config: cfg(patch) };
  const router = Core.createRouter(function () { return state.config; }, clock);
  return { router, state, set: function (p) { state.config = cfg(Object.assign({}, state.config, p)); } };
}

function hostOf(url) {
  return new URL(url).host;
}

test("fileKey 取文件名，直播流和非媒体地址返回 null", function () {
  assert.equal(Core.fileKey(COSOV), "123456791-1-30080.m4s");
  assert.equal(Core.fileKey(MCDN_V1), "123456791-1-30080.m4s");
  assert.equal(Core.fileKey("https://cn-hk-live.bilivideo.com/live-bvc/123/live_1.flv"), null);
  assert.equal(Core.fileKey("https://api.bilibili.com/x/player/wbi/playurl?bvid=x"), null);
  assert.equal(Core.cidOf("123456791-1-30080.m4s"), "123456791");
});

test("classify 识别 P2P / PCDN / MCDN，正常镜像和 Akamai 可用", function () {
  const bad = [
    PCDN,
    MCDN_V1,
    "https://1.2.3.4:8080" + PATH,
    "https://upos-sz-302ppio.bilivideo.com" + PATH,
    "https://abc.edge.mountaintoys.cn" + PATH,
    "https://upos-sz-mirror14b.bilivideo.com" + PATH,
    "https://upos-sz-mirrorcos.bilivideo.com" + PATH + "?os=mcdn",
    "https://xy1x1xy.szbdyd.com" + PATH + "?xy_usource=upos-sz-mirrorcos.bilivideo.com"
  ];
  bad.forEach(function (u) {
    assert.equal(Core.isUsable(u), false, u);
  });
  assert.equal(Core.isUsable(COSOV), true);
  assert.equal(Core.isUsable(AKAM), true);
  assert.equal(Core.canSwapTo("upos-hz-mirrorakam.akamaized.net"), false);
  assert.equal(Core.canSwapTo(ALI), true);
  assert.equal(Core.canSwapTo("my-proxy.example.com:8443"), true);
  assert.equal(Core.canSwapTo("xy1x2xy.mcdn.bilivideo.cn"), false);
});

test("swapHost 去掉 PCDN 的端口，保留路径和签名", function () {
  const out = Core.swapHost(PCDN, ALI);
  assert.equal(out, "https://" + ALI + PATH + "?e=abc&os=mcdn&upsig=bb");
});

test("严格固定：主地址和备用地址全部指向所选线路", function () {
  const { router } = routerWith({ pin: ALI });
  const p = payload(COSOV, [AKAM, PCDN]);
  assert.equal(router.rewritePayload(p), 2);
  const v = p.data.dash.video[0];
  assert.equal(hostOf(v.baseUrl), ALI);
  assert.equal(v.baseUrl, v.base_url);
  assert.deepEqual(v.backupUrl, [v.baseUrl]);
  assert.deepEqual(v.backup_url, [v.baseUrl]);
  // 借的是 cosov 的签名路径（排名最高），不是 Akamai 或 PCDN 的。
  assert.equal(v.baseUrl, "https://" + ALI + PATH + QUERY);
  assert.equal(hostOf(p.data.dash.audio[0].baseUrl), ALI);
});

test("固定到 Akamai：用下发的 Akamai 地址；没下发就标记不可用并保留原线路", function () {
  const akamHost = "upos-hz-mirrorakam.akamaized.net";
  const a = routerWith({ pin: akamHost });
  const p1 = payload(COSOV, [AKAM]);
  a.router.rewritePayload(p1);
  assert.equal(p1.data.dash.video[0].baseUrl, AKAM);

  const b = routerWith({ pin: akamHost });
  const p2 = payload(COSOV, [ALIOV]);
  b.router.rewritePayload(p2);
  assert.equal(p2.data.dash.video[0].baseUrl, COSOV);
  assert.deepEqual(p2.data.dash.video[0].backupUrl, [ALIOV]);
  assert.equal(b.router.status().unavailable, true);
});

test("非严格：主地址是所选线路，备用保留 B 站下发的正常线路", function () {
  const { router } = routerWith({ pin: ALI, strict: false });
  const p = payload(PCDN, [COSOV, AKAM]);
  router.rewritePayload(p);
  const v = p.data.dash.video[0];
  assert.equal(hostOf(v.baseUrl), ALI);
  assert.deepEqual(v.backupUrl, [COSOV, AKAM]);
});

test("B站默认：PCDN 主地址让位给下发的正常备用地址", function () {
  const { router } = routerWith({});
  const p = payload(PCDN, [COSOV, AKAM]);
  router.rewritePayload(p);
  const v = p.data.dash.video[0];
  assert.equal(v.baseUrl, COSOV);
  assert.deepEqual(v.backupUrl, [AKAM]);
  assert.equal(router.status().avoided, 1);
});

test("B站默认：只有 PCDN 时换到保底线路；只有 /v1/resource MCDN 时走代理", function () {
  const a = routerWith({});
  const p1 = payload(PCDN, []);
  a.router.rewritePayload(p1);
  assert.equal(hostOf(p1.data.dash.video[0].baseUrl), Core.DEFAULTS.rescueHost);

  const b = routerWith({});
  const p2 = payload(MCDN_V1, []);
  b.router.rewritePayload(p2);
  assert.equal(p2.data.dash.video[0].baseUrl,
    "https://proxy-tf-all-ws.bilivideo.com/?url=" + encodeURIComponent(MCDN_V1));

  const c = routerWith({ mcdnProxy: false });
  const p3 = payload(MCDN_V1, []);
  c.router.rewritePayload(p3);
  assert.equal(p3.data.dash.video[0].baseUrl, MCDN_V1);
});

test("改写是幂等的，再次解析时不把我们生成的地址当成下发", function () {
  const { router } = routerWith({ pin: ALI });
  const p = payload(COSOV, [AKAM]);
  router.rewritePayload(p);
  const once = JSON.stringify(p);
  assert.equal(router.rewritePayload(JSON.parse(once)), 0);
  assert.equal(router.rewritePayload(p), 0);
  assert.equal(JSON.stringify(p), once);
  assert.deepEqual(router.currentIssued().sort(), ["upos-hz-mirrorakam.akamaized.net", "upos-sz-mirrorcosov.bilivideo.com"]);
});

test("分段请求：任何线路的地址都落到固定线路，已在固定线路上的不动", function () {
  const { router, set } = routerWith({ pin: ALI });
  router.ingestPayload(payload(COSOV, [AKAM]));
  const routed = router.route(PCDN);
  assert.equal(hostOf(routed), ALI);
  assert.equal(router.route(routed), routed);
  assert.equal(hostOf(router.route(AKAM)), ALI);
  // 改回默认后，之前为固定线路生成的地址换回 B 站下发的地址。
  set({ pin: "" });
  assert.equal(router.route(routed), COSOV);
  assert.equal(router.route(AKAM), AKAM);
  assert.equal(router.route(PCDN), COSOV);
});

test("分段请求：没见过的文件也能直接换域名", function () {
  const { router } = routerWith({ pin: ALI });
  const other = COSOV.replace(/123456791/g, "999");
  assert.equal(hostOf(router.route(other)), ALI);
});

test("关闭后什么都不改", function () {
  const { router } = routerWith({ pin: ALI, enabled: false });
  const p = payload(PCDN, [COSOV]);
  assert.equal(router.rewritePayload(p), 0);
  assert.equal(p.data.dash.video[0].baseUrl, PCDN);
  assert.equal(router.route(COSOV), COSOV);
});

test("严格模式失败多少次都不换线；非严格模式重试放行，连续失败整页回退", function () {
  let t = 1000;
  const clock = function () { return t; };
  const strict = routerWith({ pin: ALI }, clock);
  strict.router.ingestPayload(payload(COSOV, []));
  const target = strict.router.route(COSOV);
  for (let i = 0; i < 5; i += 1) {
    strict.router.noteRequest(target, false);
  }
  assert.equal(strict.router.status().pinBroken, false);
  assert.equal(strict.router.status().pinFailures, 5);
  assert.equal(hostOf(strict.router.route(COSOV)), ALI);

  const loose = routerWith({ pin: ALI, strict: false }, clock);
  loose.router.ingestPayload(payload(COSOV, []));
  const t2 = loose.router.route(COSOV);
  loose.router.noteRequest(t2, false);
  // 刚失败的文件，播放器的重试放行到它自己选的备用地址。
  assert.equal(loose.router.route(COSOV), COSOV);
  t += 9000;
  assert.equal(hostOf(loose.router.route(COSOV)), ALI);
  loose.router.noteRequest(t2, false);
  loose.router.noteRequest(t2, false);
  assert.equal(loose.router.status().pinBroken, true);
  t += 60000;
  assert.equal(loose.router.route(t2), COSOV);
  loose.router.resetPin();
  assert.equal(hostOf(loose.router.route(COSOV)), ALI);
});

test("成功请求会清掉连续失败计数", function () {
  const { router } = routerWith({ pin: ALI, strict: false });
  router.ingestPayload(payload(COSOV, []));
  const target = router.route(COSOV);
  router.noteRequest(target, false);
  router.noteRequest(target, false);
  router.noteRequest(target, true);
  router.noteRequest(target, false);
  assert.equal(router.status().pinBroken, false);
});

test("durl（FLV/MP4）也改写", function () {
  const { router } = routerWith({ pin: ALI });
  const flv = COSOV.replace("30080.m4s", "80.flv");
  const p = { data: { quality: 80, timelength: 60000, durl: [{ order: 1, length: 60000, size: 15000000, url: flv, backup_url: [PCDN.replace("30080.m4s", "80.flv")] }] } };
  assert.equal(router.rewritePayload(p), 1);
  assert.equal(hostOf(p.data.durl[0].url), ALI);
  assert.deepEqual(p.data.durl[0].backup_url, [p.data.durl[0].url]);
});

test("PGC 的 result.video_info.dash 也能找到", function () {
  const { router } = routerWith({ pin: ALI });
  const inner = payload(COSOV, []).data;
  const p = { code: 0, result: { video_info: inner } };
  assert.equal(router.rewritePayload(p), 2);
  assert.equal(hostOf(p.result.video_info.dash.video[0].baseUrl), ALI);
});

test("szbdyd 调度地址按 xy_usource 还原成正常线路", function () {
  const { router } = routerWith({});
  const sched = "https://xy1x1xy.szbdyd.com" + PATH + "?xy_usource=upos-sz-mirrorcos.bilivideo.com&upsig=1";
  const p = payload(sched, []);
  router.rewritePayload(p);
  assert.equal(hostOf(p.data.dash.video[0].baseUrl), "upos-sz-mirrorcos.bilivideo.com");
});

test("测速样本：默认取最高码率视频，开始播放后取正在播的那条", function () {
  const { router } = routerWith({});
  const p = payload(COSOV, []);
  const hi = Object.assign({}, p.data.dash.video[0], { id: 116, bandwidth: 5000000 });
  ["baseUrl", "base_url"].forEach(function (k) { hi[k] = COSOV.replace("30080", "30116"); });
  hi.backupUrl = [];
  hi.backup_url = [];
  p.data.dash.video.push(hi);
  router.ingestPayload(p);
  assert.equal(router.sampleRep().id, 116);
  assert.equal(router.durationOf(router.sampleRep()), 213);
  router.noteVideoRequest(COSOV);
  assert.equal(router.sampleRep().id, 80);
  assert.equal(router.status().requiredBps, 2000000);
  assert.equal(Core.fileKey(router.urlFor(router.sampleRep(), "upos-sz-mirrorhwov.bilivideo.com")), "123456791-1-30080.m4s");
});

test("parseColor 接受 #hex、短 hex 和 computed style 的 rgb()", function () {
  assert.equal(Core.parseColor("#FB7299"), "#fb7299");
  assert.equal(Core.parseColor("0af"), "#00aaff");
  assert.equal(Core.parseColor("rgb(0, 117, 255)"), "#0075ff");
  assert.equal(Core.parseColor("rgb(153 194 224)"), "#99c2e0");
  assert.equal(Core.parseColor("AccentColor"), null);
});

test("schemeFrom：各角色色调符合 M3，主色保留种子色相", function () {
  ["#99c2e0", "#fb7299", "#0078d4", "#386a20", "#ffeb3b"].forEach(function (seed) {
    const hue = Core.lchOf(seed).h;
    const light = Core.schemeFrom(seed, false);
    const dark = Core.schemeFrom(seed, true);
    [[light, "--p", 40], [light, "--pc", 90], [light, "--on-pc", 10], [light, "--s3", 92], [light, "--on-s", 10],
      [dark, "--p", 80], [dark, "--pc", 30], [dark, "--s3", 17], [dark, "--on-s", 90]].forEach(function (x) {
      assert.match(x[0][x[1]], /^#[0-9a-f]{6}$/);
      assert.ok(Math.abs(Core.lchOf(x[0][x[1]]).l - x[2]) < 1, seed + " " + x[1] + " L*=" + Core.lchOf(x[0][x[1]]).l);
    });
    const ph = Core.lchOf(light["--p"]).h;
    const diff = Math.abs(((ph - hue) + 540) % 360 - 180);
    assert.ok(diff < 3, seed + " 主色色相偏了 " + diff);
    assert.equal(light["--on-p"], "#ffffff");
  });
});

test("schemeFrom：灰色种子得到灰色配色，不硬染色", function () {
  const s = Core.schemeFrom("#808080", false);
  assert.ok(Core.lchOf(s["--p"]).c < 1);
  assert.ok(Core.lchOf(s["--pc"]).c < 1);
});

test("normalizeConfig 清洗输入", function () {
  const c = Core.normalizeConfig({
    pin: " HTTPS://Upos-SZ-MirrorAli.bilivideo.com/path ",
    testMB: 7,
    sampleBvid: "nope",
    customHosts: ["a.b.com", "a.b.com", "bad host", 3],
    fab: { side: "middle", bottom: -5 },
    sampleMode: "x",
    themeMode: "neon",
    colorSource: "system",
    seedColor: "not a color"
  });
  assert.equal(c.themeMode, "system");
  assert.equal("colorSource" in c, false);
  assert.equal(c.seedColor, "#fb7299");
  assert.equal(Core.normalizeConfig({ seedColor: "#ABC" }).seedColor, "#aabbcc");
  assert.equal(c.pin, ALI);
  assert.equal(c.testMB, 8);
  assert.equal(c.sampleBvid, Core.DEFAULTS.sampleBvid);
  assert.deepEqual(c.customHosts, ["a.b.com"]);
  assert.deepEqual(c.fab, { side: "right", bottom: 8 });
  assert.equal(c.sampleMode, "auto");
  assert.equal(c.strict, true);
});
