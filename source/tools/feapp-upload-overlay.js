// OliviaSoul 游戏内「上传演奏」覆盖层 v2
// 由 feapp.dat 的 index.html 以 <script defer> 引入，独立于 Vue 运行。
// 功能：
//   1) 把「曲库」里「定制演奏 / 去定制 / 今天还可定制 N 首」改写为「上传演奏 / 上传 / 今天还可上传 N 首」；
//   2) 把底部三个说明卡片（文件格式与大小 / 演奏说明 / 版权提示）换成我的上传说明；
//   3) 文档级捕获拦截「上传」按钮，阻止原 MIDI 弹窗，弹出我们自己的上传弹窗（选歌→上传→进度→8位码）；
//   4) 上传完成后自动把「歌名 + 分享码 + 模式」记到本机（服务端 /share/records）；
//   5) 在「我的上传」空态区渲染已上传列表，每项带「复制分享码」按钮。
// 纯自包含：任何异常都不影响游戏本体（尽量 try/catch + 幂等注入）。
(function () {
  "use strict";
  try {
    if (window.__OLIVIA_UPLOAD_OVERLAY2__) return;
    window.__OLIVIA_UPLOAD_OVERLAY2__ = true;

    var SERVICE = "http://127.0.0.1:27149";
    var LABELS = [
      ["定制演奏", "上传演奏"],
      ["去定制", "上传"],
      ["今天还可定制 ", "今天还可上传 "],
      ["开始定制你的演奏吧～", "开始上传你的演奏吧～"],
      ["生成演奏", "开始上传"],
      ["定制次数已用完", "今日上传已用完"],
      // 底部三个说明卡片 → 我的上传说明
      ["文件格式与大小", "上传说明"],
      ["仅支持 .mid 格式文件，大小<1MB，时长<10 分钟。仅含钢琴单一乐器，不得出现人声或其他乐器。", "上传本机一首《林离》整曲（6 个视角视频），生成 8 位分享码。"],
      ["演奏说明", "分享说明"],
      ["由音频文件直接转出的 .mid 可能演奏准确度较低；如有钢琴踏板延音，需以竖线标识体现。", "把分享码发给对方，对方在游戏里输入即可还原整首到本机曲库。"],
      ["版权提示", "温馨提示"],
      ["仅限原创或已获授权的 .mid 文件上传。", "分享内容为本地曲库整曲，仅供学习交流，上传到云端服务器后请勿外传。"],
    ];
    var pendingJobId = null;
    var pendingJobName = "";
    var pollTimer = null;
    var _host = null;

    // ---------- ACG 风格样式（滚动条 + 悬停行） ----------
    var ACG_SCROLL_CSS =
      "#os-upload-scroll::-webkit-scrollbar{width:8px;height:8px}" +
      "#os-upload-scroll::-webkit-scrollbar-track{background:rgba(0,0,0,.25);border-radius:999px}" +
      "#os-upload-scroll::-webkit-scrollbar-thumb{background:#3b3d45;border-radius:999px;border:2px solid #17181c}" +
      "#os-upload-scroll::-webkit-scrollbar-thumb:hover{background:#50535d}" +
      "#os-upload-scroll{scrollbar-width:thin;scrollbar-color:#3b3d45 rgba(0,0,0,.25)}" +
      // 悬停行：背景高亮，序号淡出，操作按钮淡入（用类控制，避免内联样式压过 :hover）
      ".os-acg-row{transition:background .15s}" +
      ".os-acg-row:hover{background:#202126}" +
      ".os-act-btn{opacity:0;pointer-events:none;transition:opacity .15s}" +
      ".os-acg-row:hover .os-act-btn{opacity:1;pointer-events:auto}" +
      ".os-idx-num{transition:opacity .15s}" +
      ".os-acg-row:hover .os-idx-num{opacity:0}" +
      // 曲库行的操作区：保证我们补的「删除」和原生按钮在悬停时可点（原生在未下载状态会整体禁用）
      ".os-row-actions{pointer-events:auto !important}" +
      ".os-row-actions-hidden{opacity:0}" +
      ".os-lib-row:hover .os-row-actions-hidden{opacity:1 !important}";

    // ---------- 文本改写（幂等） ----------
    function rewriteNode(node) {
      var text = node.nodeValue;
      if (!text) return;
      for (var i = 0; i < LABELS.length; i++) {
        if (text.indexOf(LABELS[i][0]) !== -1) text = text.split(LABELS[i][0]).join(LABELS[i][1]);
      }
      if (text !== node.nodeValue) node.nodeValue = text;
    }
    function rewriteText(node) {
      if (!node) return;
      if (node.nodeType === 3) { rewriteNode(node); return; }
      if (!node.querySelectorAll) return;
      var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
      var stack = [];
      var n;
      while ((n = walker.nextNode())) stack.push(n);
      for (var i = 0; i < stack.length; i++) rewriteNode(stack[i]);
    }

    // ---------- 「今天还可上传 N 首」按服务端真实配额刷新 ----------
    var quotaCache = null;
    function applyQuotaText() {
      if (!quotaCache) return;
      var remain = Number(quotaCache.upRemaining);
      if (!isFinite(remain)) return;
      var want = remain > 0 ? ("今天还可上传 " + remain + " 首") : "今日上传已用完";
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        var t = n.nodeValue || "";
        var next = t;
        if (t.indexOf("今天还可上传") !== -1) next = t.replace(/今天还可上传\s*\d+\s*首/u, want);
        if (remain > 0 && next.indexOf("今日上传已用完") !== -1) next = next.replace(/今日上传已用完/u, want);
        if (next !== t) n.nodeValue = next;
      }
    }
    // force=true 时强制重新拉取；否则 5 秒内复用缓存
    function refreshQuota(force) {
      var now = Date.now();
      if (!force && quotaCache && now - quotaCache.at < 5000) { applyQuotaText(); return; }
      fetch(SERVICE + "/share/quota", { method: "GET" }).then(function (r) { return r.json(); }).then(function (env) {
        if (env.code !== 0 || !env.data) return;
        quotaCache = { at: Date.now(), upLimit: env.data.upLimit, upRemaining: env.data.upRemaining, upUsed: env.data.upUsed, dlUnlimited: env.data.dlUnlimited };
        applyQuotaText();
      }).catch(function () {});
    }

    // 隐藏游戏原生的「MIDI 定制任务」面板（生成任务/后台运行/进行中），我们已用上传弹窗替代入口
    function hideLegacyMidiPanel() {
      var dialogs = document.querySelectorAll(".midi-job-list-dialog, [class*='midi-job-list']");
      for (var i = 0; i < dialogs.length; i++) { if (dialogs[i].style) dialogs[i].style.display = "none"; }
    }

    // ---------- 点击拦截 ----------
    function cardHasSentinel(el) {
      var cur = el;
      for (var i = 0; i < 7 && cur && cur !== document.body; i++) {
        var t = cur.textContent || "";
        if (t.indexOf("今天还可") !== -1 || t.indexOf("演奏吧") !== -1) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    function isUploadButton(target) {
      var el = target && target.closest ? target.closest("button, [role='button'], a") : null;
      if (!el) return false;
      var txt = (el.textContent || "").trim();
      if (txt !== "上传" && txt !== "去定制" && txt !== "上传演奏") return false;
      return cardHasSentinel(el);
    }

    // ---------- 弹窗宿主（修复黑屏：始终返回独立宿主，绝不返回 body） ----------
    function getHost() {
      if (_host && _host.parentNode) return _host;
      _host = document.createElement("div");
      _host.id = "os-upload-modal";
      _host.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;font-family:'Segoe UI','Microsoft YaHei UI',sans-serif;";
      document.body.appendChild(_host);
      return _host;
    }
    function ensureVeil(h) {
      var v = h.querySelector("#os-upload-veil");
      if (!v) {
        v = document.createElement("div");
        v.id = "os-upload-veil";
        v.style.cssText = "position:absolute;inset:0;z-index:0;background:rgba(0,0,0,.55);backdrop-filter:blur(2px);";
        h.insertBefore(v, h.firstChild);
      }
      return v;
    }
    function closeModal() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      var h = getHost();
      h.style.display = "none";
      // 只清内容，保留遮罩
      for (var i = h.childNodes.length - 1; i >= 0; i--) if (!h.childNodes[i].id || h.childNodes[i].id !== "os-upload-veil") h.removeChild(h.childNodes[i]);
    }
    function openModal() { var h = getHost(); ensureVeil(h); h.style.display = "flex"; renderSongList(h); }

    function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    function fmtSize(n) { n = Number(n || 0); return n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : (n / 1048576).toFixed(1) + " MB"; }
    function fmtDur(sec) { const n = Number(sec || 0); if (!n) return "-:--"; const m = Math.floor(n / 60); const s = Math.floor(n % 60); return m + ":" + String(s).padStart(2, "0"); }
    function fmtTime(ts) {
      const n = Number(ts || 0);
      if (!n) return "-";
      const d = new Date(n);
      const p = (v) => String(v).padStart(2, "0");
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function prettyName(songKey) { return String(songKey || "").replace(/^PlaySing_/u, "").replace(/_Ziyun_original$/u, ""); }

    function shell(inner, subtitle) {
      return '<div style="position:relative;z-index:1;width:min(600px,92vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;background:#111114;border:1px solid #30313a;border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.6);color:#f2f0ed;">' +
        '<div style="flex:none;display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #2a2b32;">' +
          '<div><div style="font-size:18px;font-weight:700;color:#e6e3de;">上传演奏</div>' +
          '<div style="font-size:12px;color:#9a9aa2;">' + (subtitle || "上传本地曲目") + '</div></div>' +
          '<button data-os-close style="background:none;border:0;color:#9a9aa2;font-size:22px;line-height:1;cursor:pointer;">×</button>' +
        '</div>' +
        '<div id="os-upload-scroll" style="flex:1 1 auto;overflow-y:auto;padding:16px 20px;max-height:420px;">' + inner + '</div>' +
      '</div>';
    }
    function fillContent(h, inner) {
      // 去掉宿主里除遮罩外的旧内容
      for (var i = h.childNodes.length - 1; i >= 0; i--) if (!h.childNodes[i].id || h.childNodes[i].id !== "os-upload-veil") h.removeChild(h.childNodes[i]);
      ensureVeil(h);
      var wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;z-index:1;";
      wrap.innerHTML = inner;
      h.appendChild(wrap);
      var close = h.querySelector("[data-os-close]");
      if (close) close.onclick = closeModal;
    }

    // ---------- 选歌列表（ACG 风格表格：序号 / 曲目 / 模式 / 大小，悬停序号->上传按钮） ----------
    function renderSongList(h) {
      fillContent(h, shell(
        '<div style="font-size:12px;color:#8a8a93;margin-bottom:10px;" data-os-count>正在读取本机曲库…</div>' +
        '<div data-os-acg style="display:flex;flex-direction:column;"></div>'
      ));
      fetch(SERVICE + "/share/songs", { method: "GET" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (env) {
          if (env.code !== 0) throw new Error(env.message);
          var songs = env.data.songs || [];
          var count = h.querySelector("[data-os-count]");
          if (count) count.textContent = "共 " + songs.length + " 首整曲 · 悬停点「上传」";
          var box = h.querySelector("[data-os-acg]");
          box.innerHTML = acgHeader() + songs.map(function (s, k) {
            return acgRow(k, {
              name: s.name || prettyName(s.nameKey),
              songKey: s.nameKey,
              duration: s.duration || 0,
              mode: s.mode || "整曲",
              iconUrl: s.iconUrl || s.coverUrl || "",
              subtitle: "HOYO-MIX · " + fmtDur(s.duration) + " · " + fmtSize(s.totalBytes),
            });
          }).join("");
          var rows = box.querySelectorAll("[data-os-action]");
          for (var j = 0; j < rows.length; j++) rows[j].onclick = function (e) {
            e.stopPropagation();
            startUpload(h, this.getAttribute("data-os-song"), this.getAttribute("data-os-name"));
          };
        })
        .catch(function (e) {
          fillContent(h, shell('<div style="text-align:center;padding:20px 0;color:#e09a9a;">读取曲库失败：' + esc(e.message) + '<br><span style="font-size:12px;color:#9a9aa2;">请确认本机服务（127.0.0.1:27149）已启动。</span></div>'));
        });
    }

    // 列表统一表头（与 acgRow 同列结构：序号 | 封面｜曲目 | 模式 | [复制占位]）；padding 对齐 ACG
    function acgHeader(withCopy) {
      return '<div style="display:flex;align-items:center;gap:12px;padding:0 16px 8px 16px;border-bottom:1px solid #2a2b32;">' +
        '<div style="width:36px;flex-shrink:0;color:#8a8a93;font-size:13px;text-align:center;">#</div>' +
        '<div style="width:48px;flex-shrink:0;"></div>' +
        '<div style="flex:1;min-width:0;color:#8a8a93;font-size:13px;">曲目</div>' +
        '<div style="width:80px;flex-shrink:0;color:#8a8a93;font-size:13px;text-align:center;">模式</div>' +
        (withCopy ? '<div style="width:88px;flex-shrink:0;"></div>' : '') +
      '</div>';
    }
    // ACG 风格行：序号列悬停变「上传/复制」（图标在上、文字在下，无背景）
    function acgRow(index, d) {
      var btnAttr = d.btnAttr ? ' ' + d.btnAttr : ' data-os-song="' + esc(d.songKey) + '" data-os-name="' + esc(d.name || d.songKey || "") + '"';
      var icon = d.btnIcon || "upload";
      var label = d.btnLabel || "上传";
      var iconSvg = icon === "copy"
        ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c9c4bc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>'
        : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c9c4bc" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13"></path><path d="M6 9l6-6 6 6"></path><path d="M4 21h16a1 1 0 0 0 1-1v-2"></path></svg>';
      var coverHtml = '<div style="width:48px;height:48px;flex-shrink:0;position:relative;border-radius:12px;overflow:hidden;background:#22232a;">' +
        (d.iconUrl ? '<img src="' + esc(d.iconUrl) + '" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.style.display=\'none\'">' : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#5a5b63;font-size:16px;">♪</div>') +
      '</div>';
      // 字体完全对齐官方 SongLiteItem 行：曲目名 = text-title-l 未定义 -> 继承 16px / line-height 1.6 / 400；
      // 副标题 = text-body-s -> 12px / 20px / 400；两行紧邻（官方 h3+p 无间距）
      var titleHtml = '<div style="flex:1;min-width:0;display:flex;flex-direction:column;">' +
        '<span style="font-size:16px;line-height:1.6;color:#e6e3de;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(d.name) + '</span>' +
        '<span style="font-size:12px;line-height:20px;color:#9a9aa2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(d.subtitle) + '</span>' +
      '</div>';

      if (d.renderCopy === true) {
        // 我的上传：序号列 50px 固定居中；剩余按 曲目:模式:复制 = 6:2.4:2（模式用比例调到居中，不用 margin/padding）；字体对齐官方 token
        return '<div class="os-acg-row" style="position:relative;display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #232429;cursor:default;min-height:64px;">' +
          '<div style="width:50px;flex-shrink:0;color:#8a8a93;font-size:14px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums;display:flex;align-items:center;justify-content:center;align-self:stretch;">' + (index + 1) + '</div>' +
          // 曲目（含封面）
          '<div class="os-title-cell" style="flex:6 6 0;min-width:0;display:flex;align-items:center;gap:10px;justify-content:flex-start;">' + coverHtml + titleHtml + '</div>' +
          // 模式（比例 2.4，弹唱居中偏右对齐表头）
          '<div class="os-mode-cell" style="flex:2.4 2.4 0;min-width:0;color:#9a9aa2;font-size:14px;line-height:18px;font-weight:600;display:flex;align-items:center;justify-content:flex-start;">' + esc(d.mode) + '</div>' +
          // 复制
          '<div style="flex:2 2 0;min-width:0;display:flex;align-items:center;justify-content:flex-start;">' +
            '<button data-os-action' + btnAttr + ' style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:transparent;border:0;border-radius:8px;color:#c9c4bc;cursor:pointer;white-space:nowrap;" title="' + esc(label) + '">' +
              iconSvg + '<span style="color:#c9c4bc;font-size:12px;letter-spacing:1px;">' + esc(label) + '</span>' +
            '</button>' +
            (d.extraActions || "") +
          '</div>' +
        '</div>';
      }

      // 上传弹窗列表：序号(悬停变上传按钮) | 封面 | 曲目(弹性) | 模式(固定)；padding 对齐 ACG 行
      return '<div class="os-acg-row" style="position:relative;display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #232429;cursor:default;min-height:64px;">' +
        '<div style="width:36px;flex-shrink:0;position:relative;align-self:stretch;display:flex;align-items:center;justify-content:center;">' +
          '<div class="os-idx-num" style="color:#8a8a93;font-size:14px;font-variant-numeric:tabular-nums;">' + (index + 1) + '</div>' +
          '<button class="os-act-btn" data-os-action' + btnAttr + ' style="position:absolute;inset:0;margin:auto;width:52px;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:transparent;border:0;cursor:pointer;" title="' + esc(label) + '">' +
            iconSvg + '<span style="color:#c9c4bc;font-size:11px;letter-spacing:1px;">' + esc(label) + '</span>' +
          '</button>' +
        '</div>' +
        coverHtml +
        titleHtml +
        '<div style="width:80px;flex-shrink:0;color:#9a9aa2;font-size:13px;text-align:center;">' + esc(d.mode) + '</div>' +
      '</div>';
    }

    // ---------- 上传 + 进度 ----------
    function startUpload(h, songKey, displayName) {
      pendingJobId = null;
      var shownName = displayName || prettyName(songKey);
      pendingJobName = shownName;
      fillContent(h, shell(
        '<div style="text-align:center;padding:4px 0 14px;color:#cfccc7;font-size:14px;margin-bottom:14px;">正在上传《' + esc(shownName) + '》</div>' +
        '<div style="display:grid;gap:10px;">' +
          '<div style="height:8px;border-radius:999px;background:#2c2d34;overflow:hidden;"><div data-os-bar style="height:100%;width:0%;border-radius:inherit;background:#9b8a74;transition:width .25s ease;"></div></div>' +
          '<div style="display:flex;justify-content:space-between;font-size:12px;color:#9a9aa2;"><span data-os-stage>准备中…</span><span data-os-pct>0%</span></div>' +
          '<div data-os-files style="display:grid;gap:4px;margin-top:4px;"></div>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:16px;"><button data-os-cancel style="padding:8px 16px;border:1px solid #4b4c53;border-radius:8px;background:transparent;color:#d49a9a;cursor:pointer;">取消</button></div>'
      ));
      var cancelBtn = h.querySelector("[data-os-cancel]");
      if (cancelBtn) cancelBtn.onclick = function () { cancelUpload(h); };

      fetch(SERVICE + "/share/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songKey: songKey }),
      }).then(function (r) {
        return r.json().then(function (b) {
          if (b.code !== 0) throw new Error(b.message || "HTTP " + r.status);
          return b;
        });
      }).then(function (env) {
        pendingJobId = env.data.id;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(function () { pollProgress(h); }, 1000);
      }).catch(function (e) {
        fillContent(h, shell('<div style="text-align:center;padding:20px 0;color:#e09a9a;">上传启动失败：' + esc(e.message) + '</div>'));
      });
    }
    function cancelUpload(h) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      var id = pendingJobId;
      if (id) fetch(SERVICE + "/share/upload/" + id + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(function () {});
      fillContent(h, shell('<div style="text-align:center;padding:20px 0;color:#9a9aa2;">已取消上传</div>'));
    }
    function pollProgress(h) {
      var id = pendingJobId;
      if (!id) return;
      fetch(SERVICE + "/share/upload/" + id, { method: "GET" }).then(function (r) { return r.json(); }).then(function (env) {
        if (env.code !== 0) throw new Error(env.message);
        var job = env.data;
        var bar = h.querySelector("[data-os-bar]");
        var stage = h.querySelector("[data-os-stage]");
        var pct = h.querySelector("[data-os-pct]");
        var files = h.querySelector("[data-os-files]");
        if (bar) bar.style.width = (job.progress || 0) + "%";
        if (pct) pct.textContent = (job.progress || 0) + "%";
        if (stage) stage.textContent = job.status === "done" ? "上传完成" : job.status === "failed" ? "上传失败：" + (job.error || "") : job.status === "cancelled" ? "已取消" : job.stage === "hashing" ? "校验文件（服务器去重检查）…" : "上传中…";
        if (files) files.innerHTML = (job.files || []).map(function (f) {
          return '<div style="display:flex;gap:8px;font-size:11px;color:#b9bac1;"><span style="color:' + (f.done ? "#7fa08b" : "#8a8a93") + ';">' + (f.done ? "✓" : "…") + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(f.name) + '</span><span style="flex-shrink:0;">' + fmtSize(f.size) + '</span></div>';
        }).join("");
        if (job.status === "done") {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          showCode(h, job);
          refreshQuota(true);   // 上传成功后刷新「今天还可上传 N 首」
        } else if (job.status === "failed" || job.status === "cancelled") {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
      }).catch(function () {});
    }
    function showCode(h, job) {
      var code = job.code || "";
      var allReused = job.files && job.files.length > 0 && job.reused >= job.files.length;
      var doneText = allReused ? "服务器已有相同内容，未占用新空间" : "上传成功";
      var reusedHint = allReused
        ? '<div style="font-size:12px;color:#7fa08b;margin-bottom:10px;">已直接复用服务器上的同一份文件（秒传）</div>'
        : "";
      fillContent(h, shell(
        '<div style="text-align:center;padding:6px 0 18px;">' +
          '<div style="font-size:13px;color:#9a9aa2;margin-bottom:6px;">《' + esc(pendingJobName || prettyName(job.songKey)) + '》' + doneText + '</div>' +
          reusedHint +
          '<div style="font-size:12px;color:#8a8a93;margin-bottom:8px;">分享码</div>' +
          '<div data-os-code style="font-size:34px;letter-spacing:7px;font-family:ui-monospace,monospace;color:#e2bc67;font-variant-numeric:tabular-nums;">' + esc(code) + '</div>' +
          '<div style="margin-top:22px;display:flex;justify-content:center;gap:10px;">' +
            '<button data-os-copy style="padding:10px 20px;border:0;border-radius:9px;background:#d8cfc4;color:#232227;font-weight:700;cursor:pointer;">复制分享码</button>' +
            '<button data-os-again style="padding:10px 20px;border:1px solid #4b4c53;border-radius:9px;background:transparent;color:#b9bac1;cursor:pointer;">再传一首</button>' +
          '</div>' +
        '</div>'
      ));
      var copy = h.querySelector("[data-os-copy]");
      if (copy) copy.onclick = function () {
        copyShare(code, copy);
      };
      var again = h.querySelector("[data-os-again]");
      if (again) again.onclick = function () { renderSongList(h); };
    }

    // 复制分享码：同步 fallback 先落地（CEF 里 clipboard 异步接口可能不回调），保证提示一定会弹
    // 同时查一次分享信息，把剩余有效期一起提示出来
    function copyShare(code, btn) {
      try { fallbackCopy(code); } catch (e) {}
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).catch(function () {});
      } catch (e) {}
      var shown = false;
      function tell(tail) { if (shown) return; shown = true; showToast("分享码已复制：" + code + (tail || ""), "success"); }
      var timer = setTimeout(function () { tell(""); }, 800);
      fetch(SERVICE + "/share/info?code=" + encodeURIComponent(code), { method: "GET" }).then(function (r) { return r.json(); }).then(function (env) {
        clearTimeout(timer);
        var d = env && env.data;
        var days = d ? Number(d.expiresInDays) : NaN;
        tell(isFinite(days) && days >= 0 ? "（剩余有效期 " + days + " 天）" : "");
      }).catch(function () { clearTimeout(timer); tell(""); });
    }
    // 游戏风格 toast（顶部居中，深色卡片，自动消失）
    var _toastHost = null;
    var _toastTimer = null;
    function showToast(msg, type) {
      try {
        if (!_toastHost || !_toastHost.parentNode) {
          _toastHost = document.createElement("div");
          _toastHost.id = "os-upload-toast";
          _toastHost.style.cssText = "position:fixed;top:26px;left:50%;transform:translateX(-50%);z-index:2147483001;display:flex;flex-direction:column;gap:10px;pointer-events:none;";
          document.body.appendChild(_toastHost);
        }
        var isSuccess = type === "success";
        var el = document.createElement("div");
        el.style.cssText = "display:flex;align-items:center;gap:10px;min-width:240px;padding:12px 18px;background:#1c1d22;border:1px solid #3a3b42;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);color:#f2f0ed;font-size:14px;pointer-events:auto;opacity:0;transform:translateY(-8px);transition:opacity .25s,transform .25s;";
        var iconColor = isSuccess ? "#7fa08b" : "#e09a9a";
        el.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="' + iconColor + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 2.5 2.5L16 9"></path></svg>' +
          '<span style="flex:1;color:#e6e3de;">' + esc(msg) + '</span>';
        _toastHost.appendChild(el);
        // 不要用 requestAnimationFrame 做淡入：游戏窗口失焦/被遮挡时 rAF 会被节流，
        // toast 会永远停在 opacity:0（DOM 存在但看不见）。强制重排后直接置为可见。
        void el.offsetWidth;
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
        setTimeout(function () {
          el.style.opacity = "0"; el.style.transform = "translateY(-8px)";
          setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
        }, 2200);
      } catch (e) {}
    }
    function fallbackCopy(text) {
      try {
        var t = document.createElement("textarea");
        t.value = text; t.style.position = "fixed"; t.style.opacity = "0";
        document.body.appendChild(t); t.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(t);
      } catch (e) {}
    }

    // ---------- ElementUI 风格结果弹窗（获取成功等） ----------
    var _dlgHost = null;
    function closeResultDialog() {
      if (_dlgHost && _dlgHost.parentNode) _dlgHost.parentNode.removeChild(_dlgHost);
      _dlgHost = null;
    }
    function showResultDialog(opts) {
      opts = opts || {};
      closeResultDialog();
      var isError = opts.type === "error";
      var icon = isError
        ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e09a9a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path></svg>'
        : opts.type === "warning"
          ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#e2bc67" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path></svg>'
          : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"></circle><path d="m8 12 3 3 5-6"></path></svg>';
      var hasCancel = typeof opts.cancelText === "string" && opts.cancelText !== "";
      var okStyle = opts.danger
        ? "padding:9px 22px;border:0;border-radius:8px;background:#c86b5e;color:#fff;font-size:14px;font-weight:600;cursor:pointer;"
        : "padding:9px 22px;border:0;border-radius:8px;background:#d8cfc4;color:#232227;font-size:14px;font-weight:600;cursor:pointer;";
      var host = document.createElement("div");
      host.id = "os-upload-dialog";
      host.style.cssText = "position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5);backdrop-filter:blur(2px);font-family:'Segoe UI','Microsoft YaHei UI',sans-serif;";
      host.innerHTML =
        '<div style="width:min(420px,90vw);background:#1c1d22;border:1px solid #30313a;border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.6);color:#e6e3de;overflow:hidden;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 22px 8px;">' +
            '<div style="font-size:16px;font-weight:600;line-height:22px;">' + esc(opts.title || "提示") + '</div>' +
            '<button data-os-dlg-close style="background:none;border:0;color:#8a8a93;font-size:20px;line-height:1;cursor:pointer;flex-shrink:0;">×</button>' +
          '</div>' +
          '<div style="display:flex;align-items:flex-start;gap:12px;padding:4px 22px 18px;font-size:14px;line-height:22px;color:#c9c4bc;">' +
            icon + '<div style="flex:1;min-width:0;white-space:pre-line;">' + esc(opts.message || "") + '</div>' +
          '</div>' +
          '<div style="display:flex;justify-content:flex-end;gap:10px;padding:12px 22px 16px;border-top:1px solid #2a2b32;">' +
            (hasCancel ? '<button data-os-dlg-cancel style="padding:9px 20px;border:1px solid #4b4c53;border-radius:8px;background:transparent;color:#c9c4bc;font-size:14px;cursor:pointer;">' + esc(opts.cancelText) + '</button>' : '') +
            '<button data-os-dlg-ok style="' + okStyle + '">' + esc(opts.okText || "确定") + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(host);
      _dlgHost = host;
      function fire(fn) { if (typeof fn === "function") { try { fn(); } catch (e) {} } }
      var okBtn = host.querySelector("[data-os-dlg-ok]");
      var closeBtn = host.querySelector("[data-os-dlg-close]");
      var cancelBtn = host.querySelector("[data-os-dlg-cancel]");
      if (okBtn) okBtn.onclick = function () { closeResultDialog(); fire(opts.onConfirm || opts.onClose); };
      if (cancelBtn) cancelBtn.onclick = function () { closeResultDialog(); fire(opts.onCancel); };
      if (closeBtn) closeBtn.onclick = hasCancel
        ? function () { closeResultDialog(); fire(opts.onCancel); }
        : function () { closeResultDialog(); fire(opts.onClose); };
    }

    // ---------- 曲库页搜索框（按曲名过滤列表） ----------
    var _songFilter = "";
    function markListRows() {
      var lists = document.querySelectorAll("#tour-song-list");
      for (var i = 0; i < lists.length; i++) {
        var titles = lists[i].querySelectorAll("h3");
        for (var j = 0; j < titles.length; j++) {
          var row = titles[j].closest(".group") || titles[j].parentElement;
          if (row && row.className && row.className.indexOf("os-lib-row") === -1) row.className += " os-lib-row";
        }
      }
    }
    function applySongFilter() {
      var q = (_songFilter || "").trim().toLowerCase();
      var rows = document.querySelectorAll(".os-lib-row");
      for (var i = 0; i < rows.length; i++) {
        var title = rows[i].querySelector("h3");
        var name = title ? (title.textContent || "") : (rows[i].textContent || "");
        rows[i].style.display = (!q || name.toLowerCase().indexOf(q) !== -1) ? "" : "none";
      }
    }
    function injectSongSearch() {
      var lists = document.querySelectorAll("#tour-song-list");
      for (var i = 0; i < lists.length; i++) {
        var list = lists[i];
        if (list.querySelector("[data-os-search]")) continue;
        var wrap = document.createElement("div");
        wrap.setAttribute("data-os-search", "");
        wrap.style.cssText = "position:sticky;top:0;z-index:5;padding-bottom:8px;background:#17181c;";
        wrap.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1c1d22;border:1px solid #30313a;border-radius:10px;">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8a8a93" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>' +
            '<input data-os-search-input placeholder="搜索曲目" style="flex:1;min-width:0;background:transparent;border:0;color:#e6e3de;font-size:13px;outline:none;">' +
            '<button data-os-search-clear style="display:none;background:none;border:0;color:#8a8a93;font-size:16px;line-height:1;cursor:pointer;">×</button>' +
          '</div>';
        list.insertBefore(wrap, list.firstChild);
        (function (input, clear) {
          input.addEventListener("input", function () {
            _songFilter = input.value || "";
            clear.style.display = _songFilter ? "block" : "none";
            applySongFilter();
          });
          clear.addEventListener("click", function () {
            input.value = ""; _songFilter = ""; clear.style.display = "none"; applySongFilter(); input.focus();
          });
        })(wrap.querySelector("[data-os-search-input]"), wrap.querySelector("[data-os-search-clear]"));
      }
    }

    // ---------- ACG 曲库行：隐藏「试听」「分享」，在「加播单」右侧补一个「删除」 ----------
    var TRASH_ICON = '<svg class="text-title-m m-1 text-info group-hover/action:text-primary-2 group-active/action:text-primary-3" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"></path><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>';
    function rowNameKey(row) {
      var img = row.querySelector('img[src*="/cover/"]');
      if (!img) return "";
      var m = /\/cover\/([^/?#"']+)/u.exec(img.getAttribute("src") || "");
      if (!m) return "";
      return decodeURIComponent(m[1]).replace(/\.[A-Za-z0-9]+$/u, "");
    }
    function decorateSongRows() {
      var buttons = document.querySelectorAll('[class*="group/action"]');
      for (var i = 0; i < buttons.length; i++) {
        var addBtn = buttons[i];
        if (addBtn.getAttribute("data-os-del") !== null) continue;
        if ((addBtn.textContent || "").trim() !== "加播单") continue;
        var row = addBtn.closest(".group");
        if (!row) continue;
        // 同一行里的「试听」「分享」隐藏
        var siblings = row.querySelectorAll('[class*="group/action"]');
        for (var j = 0; j < siblings.length; j++) {
          var text = (siblings[j].textContent || "").trim();
          if (text === "试听" || text === "分享") siblings[j].style.display = "none";
        }
        if (row.querySelector("[data-os-del]")) continue;
        var key = rowNameKey(row);
        if (!key) continue;
        var actions = addBtn.parentNode;
        if (!actions) continue;
        if (actions.className.indexOf("os-row-actions") === -1) actions.className += " os-row-actions";
        if (actions.className.indexOf("pointer-events-none") !== -1) actions.className += " os-row-actions-hidden";
        if (row.className.indexOf("os-lib-row") === -1) row.className += " os-lib-row";
        var del = document.createElement("div");
        del.setAttribute("data-os-del", key);
        del.className = "bg-[transparent] p-[1px] rounded-1 group/action cursor-pointer";
        del.title = "删除本机曲目";
        del.innerHTML = '<div class="flex items-center flex-col">' + TRASH_ICON +
          '<div class="text-label-s text-text-secondary group-hover/action:text-primary-2 group-active/action:text-primary-3">删除</div></div>';
        actions.insertBefore(del, addBtn.nextSibling);
      }
    }
    function confirmDeleteLocal(songKey, row) {
      var name = "";
      try { var title = row ? row.querySelector("h3") : null; name = title ? (title.textContent || "").trim() : ""; } catch (e) {}
      if (!name) name = prettyName(songKey);
      showResultDialog({
        title: "删除本机曲目",
        type: "warning",
        message: "确定要从本机删除《" + name + "》吗？\n文件会被移到本机回收目录（可手动恢复），游戏曲库里的条目也会一起删除。",
        okText: "删除",
        cancelText: "取消",
        danger: true,
        onConfirm: function () { doDeleteLocal(songKey, name); },
      });
    }
    function doDeleteLocal(songKey, name) {
      fetch(SERVICE + "/share/delete-local", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songKey: songKey }),
      }).then(function (r) { return r.json(); }).then(function (env) {
        if (env.code !== 0) throw new Error(env.message || "删除失败");
        var data = env.data || {};
        showResultDialog({
          title: "已删除",
          message: "《" + (data.name || name) + "》已从本机曲库移除。\n文件位置：" + (data.movedTo || ""),
          okText: "确定",
          onClose: function () { try { location.reload(); } catch (e) {} },
        });
      }).catch(function (e) {
        showResultDialog({ type: "error", title: "删除失败", message: e.message || "删除失败", okText: "确定" });
      });
    }

    // ---------- 删除「我的上传」里的分享（连带删服务器分享与 OSS 对象） ----------
    function confirmDeleteShare(recId, name) {
      showResultDialog({
        title: "删除分享",
        type: "warning",
        message: "确定要删除《" + name + "》的分享吗？\n会同时删掉本机的上传记录和服务器上的分享码；该内容如果没有其它分享引用，OSS 文件也会被释放。",
        okText: "删除",
        cancelText: "取消",
        danger: true,
        onConfirm: function () { doDeleteShare(recId, name); },
      });
    }
    function doDeleteShare(recId, name) {
      fetch(SERVICE + "/share/records/" + encodeURIComponent(recId), { method: "DELETE" })
        .then(function (r) { return r.json(); })
        .then(function (env) {
          if (env.code !== 0) throw new Error(env.message || "删除失败");
          showToast("已删除分享：《" + name + "》", "success");
          renderMyUploads();
        })
        .catch(function (e) {
          showResultDialog({ type: "error", title: "删除失败", message: e.message || "删除失败", okText: "确定" });
        });
    }

    // 还原完成后让曲库列表重新拉取：hash 路由先跳走再跳回，触发视图重新挂载
    function refreshSongList() {
      try {
        var cur = location.hash || "";
        // 不在曲库页就不用刷（进去时本来就会重新拉取）
        if (cur && cur.indexOf("#/studio") !== 0) return;
        var back = cur || "#/studio";
        location.hash = "#/history";
        setTimeout(function () { location.hash = back; }, 200);
      } catch (e) {}
    }

    // ---------- 我的上传记录（渲染到上传空态区） ----------
    // 注意：渲染会写 DOM，而 DOM 变化又触发 MutationObserver；必须防抖 + 内容不变就不写，
    // 否则会形成「重渲染 ↔ observer」死循环，按钮会在按下与抬起之间被替换，点击直接失效。
    var _myUploadTimer = null;
    var _myUploadSig = "";
    function renderMyUploads() {
      if (_myUploadTimer) clearTimeout(_myUploadTimer);
      _myUploadTimer = setTimeout(renderMyUploadsNow, 200);
    }
    function renderMyUploadsNow() {
      _myUploadTimer = null;
      // 找到「我的上传」空态区（含 暂无上传 / 开始上传你的演奏吧～）
      var marker = null;
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        var t = n.nodeValue || "";
        if (t.indexOf("暂无上传") !== -1) { marker = n.parentElement; break; }
      }
      if (!marker) return;
      // 找到「暂无上传」所在的最里层空状态块 = 祖先中「不含 tip 上传说明」的最大层
      var emptyState = marker;
      var lastNoTip = marker;
      for (var up = 0; up < 9 && emptyState && emptyState !== document.body; up++) {
        if ((emptyState.textContent || "").indexOf("上传说明") === -1) lastNoTip = emptyState;
        emptyState = emptyState.parentElement;
      }
      emptyState = lastNoTip || marker;
      if (!emptyState) return;

      fetch(SERVICE + "/share/records", { method: "GET" }).then(function (r) { return r.json(); }).then(function (env) {
        var records = (env.data && env.data.records) || [];
        var sig = JSON.stringify(records);
        var existingNode = emptyState.querySelector("[data-os-myupload]") || (emptyState.parentElement && emptyState.parentElement.querySelector("[data-os-myupload]"));
        if (sig === _myUploadSig && (records.length === 0 || existingNode)) return; // 内容没变，不动 DOM
        _myUploadSig = sig;
        if (!records.length) {
          // 记录删光了：把注入的列表移除，恢复「暂无上传」空态
          if (existingNode && existingNode.parentNode) existingNode.parentNode.removeChild(existingNode);
          emptyState.style.display = "";
          return;
        }
        // 用游戏官方表头（不隐藏、不注入自己的表头）
        // 隐藏空状态块（暂无上传 + 开始上传你的演奏吧 + 上传按钮）
        emptyState.style.display = "none";
        var host = emptyState.parentElement || emptyState;
        var node = existingNode || document.createElement("div");
        if (!existingNode) {
          node.setAttribute("data-os-myupload", "");
          node.style.cssText = "display:flex;flex-direction:column;";
        }
        node.innerHTML = records.map(function (r, k) {
          return acgRow(k, {
            name: r.name,
            songKey: r.songKey,
            duration: r.duration || 0,
            mode: r.mode || "整曲",
            iconUrl: r.iconUrl || "",
            subtitle: fmtSize(r.totalBytes) + " · " + fmtTime(r.uploadedAt),
            btnLabel: "复制",
            btnIcon: "copy",
            renderCopy: true,
            btnAttr: 'data-os-copy-code="' + esc(r.code) + '"',
            extraActions:
              '<button data-os-del-share="' + esc(r.id) + '" data-os-del-share-name="' + esc(r.name) + '"' +
              ' style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:transparent;border:0;border-radius:8px;color:#c9c4bc;cursor:pointer;white-space:nowrap;" title="删除分享">' +
                '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#c9c4bc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12"></path><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>' +
                '<span style="color:#c9c4bc;font-size:12px;letter-spacing:1px;">删除</span>' +
              '</button>',
          });
        }).join("");
        if (!existingNode) host.insertBefore(node, host.firstChild);
        // 「复制」「删除」按钮的点击由文档级捕获统一处理（避免列表重渲染把 onclick 冲掉）
      }).catch(function () {});
    }

    // ---------- 获取（下载分享码 → 还原到本机曲库） ----------
    function openGetModal() {
      var h = getHost();
      ensureVeil(h);
      h.style.display = "flex";
      renderGet(h);
    }
    function renderGet(h) {
      // 仿照游戏官方「使用分享码」输入弹窗：标题+图标、说明、带前缀图标的输入框、清空/获取按钮
      fillContent(h, shell(
        '<div style="max-width:460px;margin:0 auto;">' +
          // 标题 + 图标
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
            '<div style="width:44px;height:44px;flex-shrink:0;border-radius:10px;background:#1f2026;display:flex;align-items:center;justify-content:center;color:#e2bc67;">' +
              '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l12-3v12"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="15" r="3"></circle></svg>' +
            '</div>' +
            '<div><div style="font-size:16px;font-weight:700;color:#e6e3de;">输入曲目分享码</div>' +
            '<div style="font-size:12px;color:#9a9aa2;margin-top:2px;">可通过其他用户上传并分享的演奏获得</div></div>' +
          '</div>' +
          // 带前缀图标的输入框（居中，max 400px）
          '<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border:1px solid #3a3b42;border-radius:10px;background:#1b1c21;">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8a8a93" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M11 5 6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4z"></path></svg>' +
            '<input data-os-code-input maxlength="8" placeholder="分享码" style="flex:1;min-width:0;background:transparent;border:0;color:#e6e3de;font-size:18px;letter-spacing:3px;text-transform:uppercase;outline:none;font-family:monospace;">' +
          '</div>' +
          // 曲目信息（大小 / 文件数 / 预计耗时）
          '<div data-os-get-info style="margin-top:10px;font-size:12px;color:#9a9aa2;min-height:16px;"></div>' +
          // 按钮：清空 + 获取（带音符图标，实心）
          '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">' +
            '<button data-os-clear style="padding:9px 18px;border:1px solid #3a3b42;border-radius:9px;background:transparent;color:#9a9aa2;cursor:pointer;">清空</button>' +
            '<button data-os-get style="display:flex;align-items:center;gap:7px;padding:9px 20px;border:0;border-radius:9px;background:#d8cfc4;color:#232227;font-weight:700;cursor:pointer;">' +
              '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#232227" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l12-3v12"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="15" r="3"></circle></svg>' +
              '获取' +
            '</button>' +
          '</div>' +
          // 进度/状态
          '<div style="height:7px;border-radius:999px;background:#2c2d34;overflow:hidden;margin-top:16px;display:none;" data-os-get-bar-wrap><div data-os-get-bar style="height:100%;width:0%;border-radius:inherit;background:#9b8a74;transition:width .25s ease;"></div></div>' +
          '<div style="text-align:center;margin-top:12px;font-size:12px;color:#9a9aa2;" data-os-get-status>输入对方分享码后点「获取」</div>' +
        '</div>'
      ));
      var input = h.querySelector("[data-os-code-input]");
      var getBtn = h.querySelector("[data-os-get]");
      var clearBtn = h.querySelector("[data-os-clear]");
      if (input) input.focus();
      function run() {
        var code = (input.value || "").trim().toUpperCase();
        if (!/^[A-Z2-9]{8}$/u.test(code)) { setGetStatus(h, "分享码格式不对（8 位大写字母数字）", "#e09a9a"); return; }
        doGet(h, code);
      }
      // 输入满 8 位就预查一次：显示曲名 / 大小 / 文件数 / 预计耗时
      var infoTimer = null;
      if (input) input.addEventListener("input", function () {
        if (infoTimer) clearTimeout(infoTimer);
        var code = (input.value || "").trim().toUpperCase();
        var box = h.querySelector("[data-os-get-info]");
        if (!/^[A-Z2-9]{8}$/u.test(code)) { if (box) box.textContent = ""; return; }
        if (box) box.textContent = "正在查询曲目信息…";
        infoTimer = setTimeout(function () {
          fetch(SERVICE + "/share/info?code=" + encodeURIComponent(code), { method: "GET" }).then(function (r) { return r.json(); }).then(function (env) {
            var d = env && env.data;
            var box2 = h.querySelector("[data-os-get-info]");
            if (!box2) return;
            if (!d) { box2.textContent = "分享码不存在或已过期"; return; }
            var eta = Math.max(1, Math.round(Number(d.totalBytes || 0) / (40 * 1024 * 1024)));
            box2.textContent = "《" + (d.songName || prettyName(d.songKey)) + "》 · " + fmtSize(d.totalBytes) + " · " + d.fileCount + " 个文件 · 预计约 " + eta + " 秒" +
              (Number(d.expiresInDays) >= 0 ? " · 分享码剩余 " + Number(d.expiresInDays) + " 天" : "");
          }).catch(function () { var box2 = h.querySelector("[data-os-get-info]"); if (box2) box2.textContent = ""; });
        }, 350);
      });
      if (input) input.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
      if (getBtn) getBtn.onclick = run;
      if (clearBtn) clearBtn.onclick = function () {
        if (input) input.value = "";
        var box = h.querySelector("[data-os-get-info]");
        if (box) box.textContent = "";
        setGetStatus(h, "输入对方分享码后点「获取」", "#9a9aa2");
        if (input) input.focus();
      };
    }
    function setGetStatus(h, msg, color) {
      var s = h.querySelector("[data-os-get-status]");
      if (s) { s.textContent = msg; s.style.color = color || "#9a9aa2"; }
    }
    async function doGet(h, code) {
      var barWrap = h.querySelector("[data-os-get-bar-wrap]");
      var bar = h.querySelector("[data-os-get-bar]");
      var btn = h.querySelector("[data-os-get]");
      if (barWrap) barWrap.style.display = "block";
      if (btn) btn.disabled = true;
      setGetStatus(h, "正在校验本机曲库…");
      try {
        var r = await fetch(SERVICE + "/share/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }) });
        var b = await r.json();
        if (b.code !== 0) throw new Error(b.message);
        // 本机已有同名曲目：直接提示，不重复下载
        if (b.data && b.data.exists) {
          if (bar) bar.style.width = "0%";
          setGetStatus(h, b.data.message || ("本机曲库已存在《" + (b.data.name || "") + "》，无需重复获取"), "#e2bc67");
          return;
        }
        var jobId = b.data.id;
        // 轮询任务进度（每 1.5s）
        for (var tries = 0; tries < 2400; tries++) {
          await new Promise(function (res) { setTimeout(res, 1500); });
          try {
            var pr = await fetch(SERVICE + "/share/download/" + jobId, { method: "GET" });
            var pj = await pr.json();
            if (pj.code === 0) {
              var job = pj.data;
              if (bar) bar.style.width = (job.progress || 0) + "%";
              setGetStatus(h, (job.status === "done" ? "获取完成：已还原到曲库" : job.status === "failed" ? "获取失败：" + (job.error || "") : "正在从云端获取…（" + (job.progress || 0) + "%）"), job.status === "failed" ? "#e09a9a" : "#9a9aa2");
              if (job.status === "done") {
                if (bar) bar.style.width = "100%";
                var gotName = (job.result && job.result.name) || prettyName(job.result ? job.result.songKey : code);
                var tail = "";
                if (job.replacedName) tail += "\n（已覆盖本机同名曲目《" + job.replacedName + "》）";
                var leftDays = job.result ? Number(job.result.expiresInDays) : NaN;
                if (isFinite(leftDays) && leftDays >= 0) tail += "\n分享码剩余有效期 " + leftDays + " 天（到期无人下载会自动删除）";
                closeModal();
                showResultDialog({
                  title: "获取成功",
                  message: "《" + gotName + "》已还原到本机曲库，曲库列表已刷新。" + tail,
                  okText: "确定",
                });
                refreshSongList();
                refreshQuota(true);
                break;
              }
              if (job.status === "failed") { if (bar) bar.style.width = "0%"; setGetStatus(h, "获取失败：" + job.error, "#e09a9a"); break; }
            }
          } catch (e) {}
          if (tries % 20 === 19) setGetStatus(h, "正在从云端获取…（" + (tries / 20 | 0) + " 分钟，请稍候）");
        }
      } catch (e) {
        if (bar) bar.style.width = "0%";
        setGetStatus(h, "获取失败：" + e.message, "#e09a9a");
      } finally {
        if (barWrap) barWrap.style.display = "none";
        if (btn) btn.disabled = false;
      }
    }

    // 在「上传演奏」卡片里，往「上传」按钮旁边注入一个「获取」按钮
    function injectGetButton() {
      if (document.querySelector("[data-os-get-btn]")) return;
      var cards = document.querySelectorAll(".midi-upload-card-large, .midi-upload-card, [class*='midi-upload-card']");
      for (var c = 0; c < cards.length; c++) {
        var card = cards[c];
        if (!card.querySelector) continue;
        var upBtn = null;
        var btns = card.querySelectorAll("button");
        for (var b = 0; b < btns.length; b++) {
          var t = (btns[b].textContent || "").trim();
          if (t === "上传" || t === "去定制") { upBtn = btns[b]; break; }
        }
        if (!upBtn) continue;
        var getBtn = document.createElement("button");
        getBtn.setAttribute("data-os-get-btn", "");
        getBtn.textContent = "获取";
        getBtn.style.cssText = "margin-left:10px;height:38px;padding:0 18px;border:0;border-radius:999px;background:#d8cfc4;color:#232227;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;";
        getBtn.onclick = function (e) { e.preventDefault(); e.stopImmediatePropagation(); e.stopPropagation(); openGetModal(); };
        upBtn.parentNode.insertBefore(getBtn, upBtn.nextSibling);
        return;
      }
    }

    // ---------- 启动 ----------
    var mo = null;
    function boot() {
      rewriteText(document.body);
      refreshQuota(true);
      renderMyUploads();
      hideLegacyMidiPanel();
      injectGetButton();
      decorateSongRows();
      injectSongSearch();
      markListRows();
      applySongFilter();
    }
    function start() {
      try { boot(); } catch (e) {}
      mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === "characterData") { rewriteNode(m.target); }
          else if (m.addedNodes) { for (var j = 0; j < m.addedNodes.length; j++) { rewriteText(m.addedNodes[j]); if (m.addedNodes[j].nodeType === 1) { try { renderMyUploads(); } catch (e) {} } } }
        }
        try { hideLegacyMidiPanel(); } catch (e) {}
        try { injectGetButton(); } catch (e) {}
        try { applyQuotaText(); } catch (e) {}
        try { decorateSongRows(); } catch (e) {}
        try { injectSongSearch(); markListRows(); applySongFilter(); } catch (e) {}
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // 注入 ACG 滚动条样式
    var style = document.createElement("style");
    style.textContent = ACG_SCROLL_CSS;
    (document.head || document.documentElement).appendChild(style);

    // 文档级捕获：先于 Vue 的元素级处理器拦截（曲库上传入口 / 我的上传「复制」）
    document.addEventListener("click", function (e) {
      var delShare = e.target && e.target.closest ? e.target.closest("[data-os-del-share]") : null;
      if (delShare) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        confirmDeleteShare(delShare.getAttribute("data-os-del-share"), delShare.getAttribute("data-os-del-share-name") || "这首曲目");
        return;
      }
      var delBtn = e.target && e.target.closest ? e.target.closest("[data-os-del]") : null;
      if (delBtn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        confirmDeleteLocal(delBtn.getAttribute("data-os-del"), delBtn.closest(".group"));
        return;
      }
      var copyBtn = e.target && e.target.closest ? e.target.closest("[data-os-copy-code]") : null;
      if (copyBtn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        copyShare(copyBtn.getAttribute("data-os-copy-code"), copyBtn);
        return;
      }
      if (!isUploadButton(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      openModal();
    }, true);

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  } catch (e) {}
})();
