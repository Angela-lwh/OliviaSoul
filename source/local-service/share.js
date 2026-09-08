// olivia-share 本地引擎 —— 桌面端"上传分享"：把本机曲库的整首歌曲视频传到云分享服务，生成 8 位分享码
// 复用云服务协议：POST /api/upload/begin → PUT /api/upload/<id>/<file>（x-sha256 / x-offset 续传）→ POST /api/upload/<id>/finish
// 配置保存在 <appData>/share.json { server, secret, user, deviceCode }
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const CFG_DEFAULT = {
  server: "http://114.132.42.149:8787",
  secret: "",
  user: "",
  deviceCode: "",
};
const WIN_VIDEO_ROOT = path.join(process.env.APPDATA ?? "", "miHoYo", "Olivia-steam", "cache", "studio", "video");
const SONG_KEY_RE = /^(PlaySing_[A-Za-z0-9_.-]+|midi_\d+_\d+)$/u;
const CODE_RE = /^[A-Z2-9]{8}$/u;
const MAX_FILES = 24;

function prettyNameKey(nameKey) {
  const s = String(nameKey || "").replace(/^PlaySing_/u, "").replace(/_Ziyun_original$/u, "");
  return s.replace(/_/gu, " ").trim();
}
function fmtDuration(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n) || n <= 0) return "-:--";
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function modeLabel(performanceType) {
  const t = String(performanceType || "").toLowerCase();
  if (t.includes("sing")) return "弹唱";
  if (t.includes("solo")) return "独奏";
  if (t.includes("duet")) return "我弹你唱";
  if (t.includes("accompaniment")) return "伴奏";
  return "整曲";
}
function json(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body), "Access-Control-Allow-Origin": "*", ...headers });
  res.end(body);
  return true;
}
function ok(res, obj, headers) { return json(res, 200, { code: 0, message: "success", data: obj }, headers); }
function readJson(req, max = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => { size += c.length; if (size > max) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(file);
    s.on("data", d => h.update(d)); s.on("end", () => resolve(h.digest("hex"))); s.on("error", reject);
  });
}
function httpJson(method, u, headers = {}, obj = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(u);
    const body = obj != null ? JSON.stringify(obj) : null;
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: {
      ...headers,
      ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
    } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (res.statusCode >= 400) return reject(new Error(data.error || `HTTP ${res.statusCode}: ${text}`));
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on("error", reject);
    if (body) req.end(body); else req.end();
  });
}
// 流式 PUT（带进度计数），可断点续传
function httpPutStream(u, headers, filePath, offset, onBytes) {
  return new Promise((resolve, reject) => {
    const url = new URL(u);
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method: "PUT", headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        if (res.statusCode >= 400) return reject(new Error(data.error || `HTTP ${res.statusCode}: ${text}`));
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on("error", reject);
    const counter = new Transform({
      transform(chunk, enc, cb) { onBytes(chunk.length); cb(null, chunk); },
    });
    createReadStream(filePath, { start: offset }).pipe(counter).pipe(req);
  });
}
function httpGetStream(u, headers, timeoutMs = 60 * 1000) {
  return new Promise((resolve, reject) => {
    const url = new URL(u);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get({ host: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, headers, timeout: timeoutMs }, res => {
      if (res.statusCode >= 400) { let d = ""; res.on("data", c => d += c); res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${d}`))); return; }
      // 连接超时后：转为"数据暂停超时"，持续无数据则断开重试
      res.setTimeout(timeoutMs, () => { res.destroy(new Error("下载超时（无数据）")); });
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("下载连接超时")));
    req.on("error", reject);
  });
}
// 上传一个分片到 OSS 预签名 URL（读文件的 [start, start+length) 区间），返回 ETag
// 注意：必须用 fetch 发送——手动拼 URL 会因 URL 规范化导致 OSS 签名不匹配
function httpPutOss(u, filePath, start, length, onBytes) {
  return new Promise(async (resolve, reject) => {
    try {
      const rs = createReadStream(filePath, { start, end: start + length - 1 });
      const counter = new Transform({ transform(chunk, enc, cb) { try { onBytes(chunk.length); } catch {} cb(null, chunk); } });
      const body = Readable.toWeb(rs.pipe(counter));
      const res = await fetch(u, {
        method: "PUT", body, duplex: "half",
        headers: { "Content-Length": String(length) }, // 不能带 Content-Type：预签名按空 Content-Type 计算
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) return reject(new Error(`OSS PUT ${res.status}: ${text.slice(0, 160)}`));
      resolve(String(res.headers.get("etag") || "").replace(/^"|"$/gu, ""));
    } catch (e) { reject(e); }
  });
}

export function createShareEngine({ appData, dataDir, videoRoot: videoRootOption, readSongMeta: readSongMetaOption, writeSongMeta: writeSongMetaOption }) {
  const cfgFile = path.join(appData, "share.json");
  const recordsFile = path.join(appData, "share-records.json");
  const VIDEO_ROOT = videoRootOption ?? WIN_VIDEO_ROOT;
  const readSongMeta = readSongMetaOption ?? null;
  const writeSongMeta = writeSongMetaOption ?? null;

  async function loadRecords() {
    try { return JSON.parse(await fs.readFile(recordsFile, "utf8")); }
    catch { return []; }
  }
  async function saveRecords(list) {
    await fs.writeFile(recordsFile, JSON.stringify(list, null, 2), "utf8");
  }

  async function loadCfg() {
    let c = {};
    try { c = JSON.parse(await fs.readFile(cfgFile, "utf8")); } catch {}
    c = { ...CFG_DEFAULT, ...c };
    // 设备码必须持久化：否则每次重启服务都会换一个新身份，服务端的设备额度形同虚设
    if (!c.deviceCode) {
      c.deviceCode = randomUUID();
      await fs.writeFile(cfgFile, JSON.stringify(c, null, 2), "utf8").catch(() => {});
    }
    c.server = String(c.server ?? "").replace(/\/+$/u, "");
    return c;
  }
  async function saveCfg(c) { await fs.writeFile(cfgFile, JSON.stringify(c, null, 2), "utf8"); }
  function headers(c) {
    return { "x-app-secret": c.secret, "x-device": c.deviceCode, "x-user": encodeURIComponent(c.user) };
  }
  function authHeaders(c) {
    return { "x-device": c.deviceCode, "x-user": encodeURIComponent(c.user) };
  }

  // ---------- 曲库扫描 ----------
  async function listSongs() {
    const root = VIDEO_ROOT;
    if (!(await fs.stat(root).catch(() => null))) return { root, songs: [] };
    const dirs = (await fs.readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && /^PlaySing_[A-Za-z0-9_.-]+$/u.test(d.name)).map(d => d.name);
    let meta = {};
    try { meta = (await readSongMeta?.()) ?? {}; } catch {}
    const songs = [];
    for (const name of dirs) {
      const folder = path.join(root, name);
      const files = (await fs.readdir(folder)).filter(n => /\.(mp4|webm|mov|mkv)$/iu.test(n));
      let size = 0;
      for (const n of files) size += (await fs.stat(path.join(folder, n))).size;
      const m = meta[name] || {};
      songs.push({
        nameKey: name,
        name: m.name || prettyNameKey(name),
        duration: m.duration ?? 0,
        iconUrl: m.iconUrl || "",
        coverUrl: m.iconUrl || "",
        performanceType: m.performanceType || "PlaySing",
        mode: m.mode || modeLabel(m.performanceType),
        fileCount: files.length,
        totalBytes: size,
      });
    }
    songs.sort((a, b) => (a.name || a.nameKey).localeCompare(b.name || b.nameKey));
    return { root, songs };
  }

  // 本机是否已有这首曲子（按 songKey 目录 + 至少一个视频文件判断）
  async function localSongInfo(songKey) {
    const key = String(songKey ?? "").trim();
    if (!key) return null;
    const folder = path.join(VIDEO_ROOT, key);
    const st = await fs.stat(folder).catch(() => null);
    if (!st || !st.isDirectory()) return null;
    const names = (await fs.readdir(folder).catch(() => [])).filter(n => /\.(mp4|webm|mov|mkv)$/iu.test(n));
    if (!names.length) return null;
    let meta = {};
    try { meta = (await readSongMeta?.()) ?? {}; } catch {}
    const m = meta[key] || {};
    return { songKey: key, name: m.name || prettyNameKey(key), fileCount: names.length, folder };
  }

  // ---------- 上传任务 ----------
  const jobs = new Map();
  function jobView(j) {
    return {
      id: j.id, status: j.status, songKey: j.songKey, error: j.error || null, code: j.code || null,
      progress: j.progress, bytesDone: j.bytesDone, bytesTotal: j.bytesTotal,
      files: j.files.map(f => ({ name: f.name, size: f.size, done: f.done })),
    };
  }

  async function startUpload(cfg, songKey) {
    const root = VIDEO_ROOT;
    const folder = path.join(root, songKey);
    if (!(await fs.stat(folder).catch(() => null))) throw new Error(`曲库目录不存在: ${songKey}`);
    const videoNames = (await fs.readdir(folder)).filter(n => /\.(mp4|webm|mov|mkv)$/iu.test(n)).sort();
    if (!videoNames.length) throw new Error("目录里没有视频文件");
    if (videoNames.length > MAX_FILES) throw new Error(`视频文件过多(${videoNames.length})`);
    const files = [];
    for (const n of videoNames) files.push({ name: n, size: (await fs.stat(path.join(folder, n))).size, done: false });

    const id = randomUUID();
    const job = {
      id, status: "uploading", songKey, files, error: null, code: null,
      progress: 0, bytesDone: 0, bytesTotal: files.reduce((s, f) => s + f.size, 0),
    };
    jobs.set(id, job);
    runUpload(job, cfg, folder).catch(async e => {
      job.status = "failed";
      job.error = String(e?.message ?? e);
      try { await httpJson("POST", `${cfg.server}/api/upload/${job.uploadId}/cancel`, headers(cfg), {}); } catch {}
    });
    return jobView(job);
  }

  async function runUpload(job, cfg, folder) {
    const H = headers(cfg);
    const begin = (await httpJson("POST", `${cfg.server}/api/upload/begin`, H, {
      songKey: job.songKey, files: job.files.map(f => ({ name: f.name, size: f.size })),
    })).data;
    // OSS 模式：begin 返回 sessionId + 每个文件的分片预签名 URL，客户端直传 OSS
    job.sessionId = begin.sessionId;
    job.uploadId = begin.sessionId; // 用于 cancel
    job.status = "uploading";

    let completedBytes = 0;
    const finishFiles = [];
    for (const bf of begin.files) {
      const localPath = path.join(folder, bf.name);
      const localFile = job.files.find(f => f.name === bf.name);
      const parts = [];
      const partSize = Number(bf.partSize) || (8 * 1024 * 1024);
      for (const part of bf.parts) {
        const start = (part.partNumber - 1) * partSize;
        const length = Math.min(partSize, bf.size - start);
        if (length <= 0) continue;
        let attempt = 0;
        for (;;) {
          let partBytes = 0;
          try {
            const etag = await httpPutOss(part.url, localPath, start, length, n => {
              partBytes += n;
              job.bytesDone = completedBytes + partBytes;
              job.progress = job.bytesTotal ? Math.min(100, Math.round(job.bytesDone / job.bytesTotal * 100)) : 0;
            });
            parts.push({ partNumber: part.partNumber, etag });
            completedBytes += length;
            job.bytesDone = completedBytes;
            job.progress = job.bytesTotal ? Math.min(100, Math.round(completedBytes / job.bytesTotal * 100)) : 0;
            break;
          } catch (e) {
            attempt++;
            if (attempt >= 4) throw new Error(`分片上传失败(${bf.name} #${part.partNumber}): ${e.message}`);
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
      if (localFile) localFile.done = true;
      finishFiles.push({ name: bf.name, parts });
    }

    const fin = (await httpJson("POST", `${cfg.server}/api/upload/${begin.sessionId}/finish`, H, { files: finishFiles })).data;
    job.code = fin.code;
    job.status = "done";
    job.progress = 100;
    // 记录到本机「我的上传」（歌名 + 分享码 + 模式）
    try {
      const records = await loadRecords();
      let meta = {};
      try { meta = (await readSongMeta?.()) ?? {}; } catch {}
      const m = meta[job.songKey] || {};
      const name = m.name || prettyNameKey(job.songKey);
      records.unshift({
        id: randomUUID().slice(0, 8),
        songKey: job.songKey,
        name,
        code: job.code,
        mode: m.mode || modeLabel(m.performanceType),
        duration: Number(m.duration) || 0,
        iconUrl: m.iconUrl || "",
        files: job.files.length,
        totalBytes: job.bytesTotal,
        uploadedAt: Date.now(),
      });
      await saveRecords(records.slice(0, 200));
    } catch {}
  }

  function getJob(id) { const j = jobs.get(id); return j ? jobView(j) : null; }
  async function cancelJob(id) {
    const j = jobs.get(id);
    if (!j) return false;
    try {
      if (j.uploadId) {
        let c = await loadCfg();
        await httpJson("POST", `${cfg.server ?? c.server}/api/upload/${j.uploadId}/cancel`, headers(c), {});
      }
    } catch {}
    j.status = "cancelled";
    return true;
  }

  // ---------- 下载/还原到曲库（OSS 预签名直下 + 并发 + 断点续传 + 重试 + 进度） ----------
  async function downloadToCache(cfg, code, onProgress) {
    if (!CODE_RE.test(code)) throw new Error("分享码格式不对（8 位大写）");
    const H = authHeaders(cfg);
    const beg = (await httpJson("POST", `${cfg.server}/api/download/${code}/begin`, H, {})).data;
    const outDir = path.join(VIDEO_ROOT, beg.songKey);
    await fs.mkdir(outDir, { recursive: true });
    const total = Number(beg.totalBytes) || 0;
    let doneBytes = 0;

    const downloadOne = async (f) => {
      const target = path.join(outDir, f.name);
      const tmp = target + ".part";
      const got0 = (await fs.stat(tmp).catch(() => null))?.size ?? 0;
      doneBytes += got0;
      for (let attempt = 0; attempt < 4; attempt++) {
        const got = (await fs.stat(tmp).catch(() => null))?.size ?? 0;
        if (got === f.size) break; // 已完成
        const hdrs = {};
        if (got > 0 && got < f.size) hdrs.Range = `bytes=${got}-`;
        const before = got;
        try {
          await pipeline(await httpGetStream(f.url, hdrs, 120 * 1000), createWriteStream(tmp, { flags: got > 0 && got < f.size ? "a" : "w" }));
        } catch (e) {
          // 断连：已写入的字节计入进度，等待重试
          const now = (await fs.stat(tmp).catch(() => null))?.size ?? 0;
          if (now > before) doneBytes += (now - before);
          if (attempt === 3) throw e;
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        const now = (await fs.stat(tmp).catch(() => null))?.size ?? 0;
        if (now > before) doneBytes += (now - before);
        await fs.rename(tmp, target);
        onProgress?.(Math.min(100, Math.round(doneBytes / Math.max(1, total) * 100)), f.name);
        return;
      }
      // 若循环因"已完成"退出，也要推进进度
      const now = (await fs.stat(tmp).catch(() => null))?.size ?? 0;
      if (now >= f.size) { try { await fs.rename(tmp, target); } catch {} onProgress?.(Math.min(100, Math.round(doneBytes / Math.max(1, total) * 100)), f.name); }
    };

    // 并发下载（4 个同时），互不阻塞
    await Promise.all(beg.files.map(f => downloadOne(f)));

    // 注册到游戏曲库（让 ACG 列表能认出这首）
    let dlMeta = {};
    try {
      let known = {};
      try { known = (await readSongMeta?.()) ?? {}; } catch {}
      dlMeta = known[beg.songKey] || {};
      await writeSongMeta?.({ nameKey: beg.songKey, name: dlMeta.name || prettyNameKey(beg.songKey), duration: Number(dlMeta.duration) || 0, iconUrl: dlMeta.iconUrl || "", performanceType: dlMeta.performanceType || "PlaySing", videoUrl: "" });
    } catch {}
    return { code, songKey: beg.songKey, name: dlMeta.name || prettyNameKey(beg.songKey), totalBytes: beg.totalBytes, outDir, fileCount: beg.files.length };
  }

  // 下载任务（后台执行 + 进度轮询）
  const dlJobs = new Map();
  function startDownloadJob(cfg, code, jobId) {
    const job = { id: jobId, code, status: "downloading", progress: 0, message: "开始下载…", error: null, result: null };
    dlJobs.set(jobId, job);
    downloadToCache(cfg, code, (pct, name) => {
      job.progress = pct; job.message = `下载中 ${name || ""}`;
    }).then(r => {
      job.status = "done"; job.progress = 100; job.result = r; job.message = "下载完成";
    }).catch(e => {
      job.status = "failed"; job.error = String(e?.message ?? e); job.message = "下载失败";
    });
    return jobView(job);
  }
  function jobView(j) {
    return { id: j.id, code: j.code, status: j.status, progress: j.progress, message: j.message, error: j.error, result: j.result };
  }
  function getDlJob(id) { const j = dlJobs.get(id); return j ? jobView(j) : null; }

  async function info(cfg, code) {
    const r = (await httpJson("GET", `${cfg.server}/api/share/${code}/info`, {}, null)).data;
    return r;
  }

  // 服务端配额（今天还可上传几首；下载不限次数）
  async function quota(cfg) {
    return (await httpJson("GET", `${cfg.server}/api/quota`, headers(cfg), null)).data;
  }

  // ---------- 路由 ----------
  async function route(req, res, pathname) {
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-app-secret, x-device, x-user, x-sha256, x-offset, x-dtoken, Range" }); res.end(); return true; }

    if (pathname === "/share/config") {
      if (req.method === "GET") {
        const c = await loadCfg();
        return ok(res, { server: c.server, secret: c.secret ? "****" : "", secretSet: Boolean(c.secret), user: c.user, deviceCode: c.deviceCode, deviceShort: c.deviceCode.slice(0, 8), root: VIDEO_ROOT });
      }
      if (req.method === "POST") {
        const b = await readJson(req);
        const c = await loadCfg();
        if (b.server !== undefined) c.server = String(b.server).trim().replace(/\/+$/u, "");
        if (b.secret !== undefined) c.secret = String(b.secret).trim();
        if (b.user !== undefined) c.user = String(b.user).trim();
        await saveCfg(c);
        return ok(res, { saved: true, server: c.server, user: c.user, secretSet: Boolean(c.secret), deviceCode: c.deviceCode });
      }
    }

    if (pathname === "/share/songs") {
      if (req.method === "GET") return ok(res, await listSongs());
    }

    if (pathname === "/share/records") {
      if (req.method === "GET") return ok(res, { records: await loadRecords() });
      if (req.method === "POST") {
        const b = await readJson(req);
        const records = await loadRecords();
        const name = String(b.name ?? "").trim() || String(b.songKey ?? "").replace(/^PlaySing_/u, "").replace(/_Ziyun_original$/u, "");
        const rec = {
          id: String(b.id ?? randomUUID().slice(0, 8)),
          songKey: String(b.songKey ?? ""),
          name,
          code: String(b.code ?? "").toUpperCase(),
          mode: String(b.mode ?? "整曲"),
          files: Number(b.files ?? 6),
          totalBytes: Number(b.totalBytes ?? 0),
          uploadedAt: Number(b.uploadedAt ?? Date.now()),
        };
        const idx = records.findIndex(r => r.code === rec.code);
        if (idx >= 0) records[idx] = { ...records[idx], ...rec, id: records[idx].id };
        else records.unshift(rec);
        await saveRecords(records.slice(0, 200));
        return ok(res, { saved: true, record: rec });
      }
    }

    const recordDel = /^\/share\/records\/([0-9a-zA-Z-]+)$/u.exec(pathname);
    if (req.method === "DELETE" && recordDel) {
      const records = await loadRecords();
      const next = records.filter(r => r.id !== recordDel[1] && r.code !== recordDel[1]);
      await saveRecords(next);
      return ok(res, { deleted: next.length !== records.length });
    }

    if (pathname === "/share/upload") {
      if (req.method === "POST") {
        const b = await readJson(req);
        const cfg = await loadCfg();
        if (!cfg.secret) return json(res, 400, { code: 1, message: "请先填写应用密钥", data: null });
        if (!cfg.user) return json(res, 400, { code: 1, message: "请先填写昵称", data: null });
        if (!SONG_KEY_RE.test(String(b.songKey ?? ""))) return json(res, 400, { code: 1, message: "songKey 不合法", data: null });
        const j = await startUpload(cfg, String(b.songKey));
        return ok(res, j);
      }
    }

    const jobMatch = /^\/share\/upload\/([0-9a-f-]{36})$/u.exec(pathname);
    if (req.method === "GET" && jobMatch) {
      const j = getJob(jobMatch[1]);
      if (!j) return json(res, 404, { code: 1, message: "任务不存在", data: null });
      return ok(res, j);
    }
    const cancelMatch = /^\/share\/upload\/([0-9a-f-]{36})\/cancel$/u.exec(pathname);
    if (req.method === "POST" && cancelMatch) {
      const done = await cancelJob(cancelMatch[1]);
      return ok(res, { cancelled: done });
    }

    if (pathname === "/share/download") {
      if (req.method === "POST") {
        const b = await readJson(req);
        const cfg = await loadCfg();
        if (!cfg.server) return json(res, 400, { code: 1, message: "未配置服务器", data: null });
        const code = String(b.code ?? "").toUpperCase();
        if (!CODE_RE.test(code)) return json(res, 400, { code: 1, message: "分享码格式不对（8 位大写）", data: null });
        // 获取前先查本机曲库：已存在同名曲目就直接提示，不再重复下载
        let remote;
        try { remote = await info(cfg, code); }
        catch (e) { return json(res, 400, { code: 1, message: `分享码查询失败：${e.message}`, data: null }); }
        const existed = await localSongInfo(remote?.songKey);
        if (existed) {
          return ok(res, {
            exists: true, code, songKey: existed.songKey, name: existed.name,
            fileCount: existed.fileCount, folder: existed.folder,
            message: `本机曲库已存在《${existed.name}》，无需重复获取`,
          });
        }
        const jobId = randomUUID();
        const j = startDownloadJob(cfg, code, jobId);
        return ok(res, j);
      }
    }

    const dlJobMatch = /^\/share\/download\/([0-9a-f-]{36})$/u.exec(pathname);
    if (req.method === "GET" && dlJobMatch) {
      const j = getDlJob(dlJobMatch[1]);
      if (!j) return json(res, 404, { code: 1, message: "任务不存在", data: null });
      return ok(res, j);
    }

    if (pathname === "/share/quota") {
      if (req.method === "GET") {
        const c = await loadCfg();
        if (!c.server) return json(res, 400, { code: 1, message: "未配置服务器", data: null });
        try { return ok(res, await quota(c)); }
        catch (e) { return json(res, 502, { code: 1, message: `配额查询失败：${e.message}`, data: null }); }
      }
    }

    if (pathname === "/share/info") {
      if (req.method === "GET") {
        const c = await loadCfg();
        const code = (req.url.split("?")[1] ? new URL("http://x?" + req.url.split("?")[1]) : null)?.searchParams?.get("code") ?? "";
        const r = await info(c, String(code).toUpperCase());
        return ok(res, r);
      }
    }

    return false;
  }

  return { route, loadCfg, saveCfg, listSongs, startUpload, getJob, cancelJob, downloadToCache, info, quota, loadRecords, saveRecords };
}
