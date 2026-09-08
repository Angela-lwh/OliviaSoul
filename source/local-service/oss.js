// oss.js —— 零依赖阿里云 OSS 客户端（V1 签名），供云分享服务使用
// 能力：分片上传（Initiate/UploadPart/Complete/Abort）、预签名 URL（PUT 分片 / GET 下载）、简单对象操作
import { createHmac } from "node:crypto";

const encKey = (key) => key.split("/").map(encodeURIComponent).join("/");

export function createOssClient({ accessKeyId, accessKeySecret, bucket, endpoint = "oss-cn-beijing.aliyuncs.com" }) {
  if (!accessKeyId || !accessKeySecret || !bucket) throw new Error("OSS 配置不完整");
  const base = `https://${bucket}.${endpoint}`;
  const sign = (stringToSign) => createHmac("sha1", accessKeySecret).update(stringToSign, "utf8").digest("base64");
  // 子资源按字典序拼成 ?a&b=c（true 表示无值子资源，如 ?uploads）
  const canonSub = (sub = {}) => {
    const keys = Object.keys(sub).filter(k => sub[k] !== undefined && sub[k] !== null && sub[k] !== "").sort();
    if (!keys.length) return "";
    return "?" + keys.map(k => (sub[k] === true) ? k : `${k}=${sub[k]}`).join("&");
  };
  const canonResource = (key, sub) => `/${bucket}/${key}${canonSub(sub)}`;

  // ---- 服务器直接调用（Header 签名） ----
  async function api(method, key, { sub = {}, contentType = "", body = null, headers = {} } = {}) {
    const date = new Date().toUTCString();
    const resource = canonResource(key, sub);
    const stringToSign = `${method}\n\n${contentType}\n${date}\n${resource}`;
    const authorization = `OSS ${accessKeyId}:${sign(stringToSign)}`;
    const url = `${base}/${encKey(key)}${canonSub(sub)}`;
    const res = await fetch(url, {
      method,
      headers: { Date: date, Authorization: authorization, ...(contentType ? { "Content-Type": contentType } : {}), ...headers },
      body: body ?? undefined,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`OSS ${method} ${key} -> ${res.status}: ${text.slice(0, 200)}`);
    return { status: res.status, text, headers: res.headers };
  }

  // ---- 预签名 URL（客户端直传/直下，不带 SK） ----
  function presign(method, key, sub = {}, expiresSec = 12 * 3600) {
    const expires = Math.floor(Date.now() / 1000) + expiresSec;
    const resource = canonResource(key, sub);
    const stringToSign = `${method}\n\n\n${expires}\n${resource}`;
    const sig = encodeURIComponent(sign(stringToSign));
    const qs = canonSub(sub);
    const sep = qs ? "&" : "?";
    return `${base}/${encKey(key)}${qs}${sep}OSSAccessKeyId=${accessKeyId}&Expires=${expires}&Signature=${sig}`;
  }

  // ---- 分片上传 ----
  async function initMultipart(key, contentType = "application/octet-stream") {
    const r = await api("POST", key, { sub: { uploads: true }, contentType });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/u.exec(r.text)?.[1];
    if (!uploadId) throw new Error("InitiateMultipartUpload 未返回 UploadId");
    return uploadId;
  }
  const presignPutPart = (key, uploadId, partNumber, expiresSec = 24 * 3600) =>
    presign("PUT", key, { partNumber: String(partNumber), uploadId }, expiresSec);
  async function completeMultipart(key, uploadId, parts) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>` +
      parts.slice().sort((a, b) => a.partNumber - b.partNumber)
        .map(p => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("") +
      `</CompleteMultipartUpload>`;
    const r = await api("POST", key, { sub: { uploadId }, contentType: "application/xml", body: xml });
    if (/<Error>/u.test(r.text)) throw new Error("CompleteMultipartUpload 失败: " + r.text.slice(0, 200));
    return r.text;
  }
  const abortMultipart = (key, uploadId) => api("DELETE", key, { sub: { uploadId } });
  async function listParts(key, uploadId) {
    const r = await api("GET", key, { sub: { uploadId } });
    const parts = [...r.text.matchAll(/<Part>\s*<PartNumber>(\d+)<\/PartNumber>\s*<ETag>([^<]+)<\/ETag>/gu)]
      .map(m => ({ partNumber: Number(m[1]), etag: m[2] }));
    return parts;
  }

  // ---- 下载 / 普通对象 ----
  const presignGet = (key, expiresSec = 6 * 3600) => presign("GET", key, {}, expiresSec);
  async function putObject(key, body, contentType = "application/octet-stream") { return api("PUT", key, { contentType, body }); }
  async function getObjectText(key) { const r = await api("GET", key); return r.text; }
  const deleteObject = (key) => api("DELETE", key);
  const headObject = (key) => api("HEAD", key).then(r => ({ size: Number(r.headers.get("content-length") || 0), etag: r.headers.get("etag") }));
  // 列出指定前缀下的对象（注意：prefix/max-keys/marker 是普通查询参数，不计入签名）
  async function listObjects(prefix) {
    const keys = []; let marker = "";
    for (let i = 0; i < 50; i++) {
      const date = new Date().toUTCString();
      const stringToSign = `GET\n\n\n${date}\n/${bucket}/`;
      const qs = new URLSearchParams({ prefix, "max-keys": "1000" });
      if (marker) qs.set("marker", marker);
      const res = await fetch(`${base}/?${qs.toString()}`, { headers: { Date: date, Authorization: `OSS ${accessKeyId}:${sign(stringToSign)}` } });
      const text = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`OSS ListObjects -> ${res.status}: ${text.slice(0, 200)}`);
      for (const m of text.matchAll(/<Key>([^<]+)<\/Key>/gu)) keys.push(m[1]);
      if (!/<IsTruncated>true<\/IsTruncated>/u.test(text)) break;
      marker = keys[keys.length - 1] || "";
    }
    return keys;
  }
  // 服务端拷贝对象（用于把临时 session 对象移动到正式 shares/<code>/ 路径）
  async function copyObject(srcKey, destKey) {
    const date = new Date().toUTCString();
    const resource = `/${bucket}/${destKey}`;
    const canonOssHeaders = `x-oss-copy-source:/${bucket}/${srcKey}\n`;
    const stringToSign = `PUT\n\n\n${date}\n${canonOssHeaders}${resource}`;
    const res = await fetch(`${base}/${encKey(destKey)}`, {
      method: "PUT",
      headers: {
        Date: date,
        Authorization: `OSS ${accessKeyId}:${sign(stringToSign)}`,
        "x-oss-copy-source": `/${bucket}/${srcKey}`,
      },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`OSS CopyObject -> ${res.status}: ${text.slice(0, 200)}`);
    return true;
  }

  return {
    bucket, endpoint, base,
    initMultipart, presignPutPart, completeMultipart, abortMultipart, listParts,
    presignGet, putObject, getObjectText, deleteObject, headObject, copyObject, listObjects,
    api,
  };
}

export const PART_SIZE = 8 * 1024 * 1024; // 8MB 分片
