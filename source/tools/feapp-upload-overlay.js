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
      ".os-acg-row:hover .os-idx-num{opacity:0}";

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
        if (stage) stage.textContent = job.status === "done" ? "上传完成" : job.status === "failed" ? "上传失败：" + (job.error || "") : job.status === "cancelled" ? "已取消" : "上传中…";
        if (files) files.innerHTML = (job.files || []).map(function (f) {
          return '<div style="display:flex;gap:8px;font-size:11px;color:#b9bac1;"><span style="color:' + (f.done ? "#7fa08b" : "#8a8a93") + ';">' + (f.done ? "✓" : "…") + '</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(f.name) + '</span><span style="flex-shrink:0;">' + fmtSize(f.size) + '</span></div>';
        }).join("");
        if (job.status === "done") {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          showCode(h, job);
        } else if (job.status === "failed" || job.status === "cancelled") {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
      }).catch(function () {});
    }
    function showCode(h, job) {
      var code = job.code || "";
      fillContent(h, shell(
        '<div style="text-align:center;padding:6px 0 18px;">' +
          '<div style="font-size:13px;color:#9a9aa2;margin-bottom:14px;">《' + esc(pendingJobName || prettyName(job.songKey)) + '》上传成功</div>' +
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

    function copyShare(code, btn) {
      function done() { showToast("复制分享码成功", "success"); }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(done, function () { fallbackCopy(code); done(); });
        } else { fallbackCopy(code); done(); }
      } catch (e) { fallbackCopy(code); done(); }
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
        requestAnimationFrame(function () { el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
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

    // ---------- 我的上传记录（渲染到上传空态区） ----------
    function renderMyUploads() {
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
        if (!records.length) return;
        // 用游戏官方表头（不隐藏、不注入自己的表头）
        var existingNode = emptyState.querySelector("[data-os-myupload]") || (emptyState.parentElement && emptyState.parentElement.querySelector("[data-os-myupload]"));
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
            subtitle: "HOYO-MIX · " + fmtDur(r.duration) + " · " + fmtSize(r.totalBytes),
            btnLabel: "复制",
            btnIcon: "copy",
            renderCopy: true,
            btnAttr: 'data-os-copy-code="' + esc(r.code) + '"',
          });
        }).join("");
        if (!existingNode) host.insertBefore(node, host.firstChild);
        // 悬停「复制」圆钮 -> 复制分享码
        var copies = node.querySelectorAll("[data-os-action]");
        for (var k = 0; k < copies.length; k++) copies[k].onclick = function (ev) {
          ev.stopPropagation();
          copyShare(this.getAttribute("data-os-copy-code"), this);
        };
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
      if (input) input.addEventListener("keydown", function (e) { if (e.key === "Enter") run(); });
      if (getBtn) getBtn.onclick = run;
      if (clearBtn) clearBtn.onclick = function () { if (input) input.value = ""; setGetStatus(h, "输入对方分享码后点「获取」", "#9a9aa2"); if (input) input.focus(); };
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
              if (job.status === "done") { if (bar) bar.style.width = "100%"; setGetStatus(h, "获取成功，已还原到曲库：\u300a" + prettyName(job.result ? job.result.songKey : code) + "\u300b", "#7fa08b"); break; }
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
      renderMyUploads();
      hideLegacyMidiPanel();
      injectGetButton();
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
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // 注入 ACG 滚动条样式
    var style = document.createElement("style");
    style.textContent = ACG_SCROLL_CSS;
    (document.head || document.documentElement).appendChild(style);

    // 文档级捕获：先于 Vue 的元素级处理器拦截（仅拦曲库上传入口）
    document.addEventListener("click", function (e) {
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
