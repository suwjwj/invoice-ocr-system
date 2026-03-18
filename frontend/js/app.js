/**
 * 票据智能识别系统 — Material Design 3 前端
 *
 * 三层可解释性:
 *   1. Canvas bbox 叠加 → 视觉证据定位层
 *   2. 候选值评分表格 → 字段级决策链层
 *   3. 审计日志时间线 → 文档级审计追溯层
 *
 * 交互增强:
 *   - MD3 Ripple 波纹效果
 *   - 数字滚动计数动画
 *   - 骨架屏 Loading
 *   - Bbox 渐现动画
 *   - 双击全屏图片面板
 *   - 键盘快捷键导航
 */

// ========== 配置 ==========
const FIELD_COLORS = {
    company: { fill: "rgba(168, 199, 250, 0.20)", stroke: "#A8C7FA", label: "公司" },
    date:    { fill: "rgba(125, 212, 145, 0.20)", stroke: "#7DD491", label: "日期" },
    address: { fill: "rgba(232, 192, 106, 0.20)", stroke: "#E8C06A", label: "地址" },
    total:   { fill: "rgba(255, 180, 171, 0.20)", stroke: "#FFB4AB", label: "金额" },
};

const FIELD_ORDER = ["company", "date", "address", "total"];
const FIELD_NAME_MAP = { company: "公司名称", date: "日期", address: "地址", total: "总金额" };
const STATUS_MAP = { processed: "已处理", approved: "已通过", rejected: "已拒绝", pending: "待处理" };

const ICONS = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
};

// ========== 状态 ==========
let currentView = "dashboard";
let currentPage = 1;
let totalPages = 1;
let currentInvoiceId = null;
let currentInvoiceData = null;
let currentFields = [];
let currentOcrBlocks = [];
let activeFieldKey = null;
let currentFilter = "";
let editingInvoiceId = null;
let editingFieldKey = null;

// 请求取消控制器（防止快速切换竞态）
let detailAbortController = null;

// 图片平移缩放状态
let imgZoom = 1;
let imgPanX = 0;
let imgPanY = 0;
let imgDragging = false;
let imgDragStartX = 0;
let imgDragStartY = 0;
let imgPanStartX = 0;
let imgPanStartY = 0;

// ========== 初始化 ==========
document.addEventListener("DOMContentLoaded", () => {
    loadStats();
    setupUploadDropzone();
    setupImagePanZoom();
    setupRipple();
    setupKeyboardShortcuts();
});

// ==========================================================
//  MD3 Ripple 效果
// ==========================================================
function setupRipple() {
    document.addEventListener("pointerdown", e => {
        const host = e.target.closest(".ripple-host");
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const size = Math.max(rect.width, rect.height) * 2;
        const ripple = document.createElement("span");
        ripple.className = "ripple";
        ripple.style.width = ripple.style.height = size + "px";
        ripple.style.left = (x - size / 2) + "px";
        ripple.style.top = (y - size / 2) + "px";
        host.appendChild(ripple);
        ripple.addEventListener("animationend", () => ripple.remove());
    });
}

// ==========================================================
//  数字滚动计数动画
// ==========================================================
function animateCounter(element, target) {
    const start = parseInt(element.textContent) || 0;
    if (start === target) { element.textContent = target; return; }
    const duration = 600;
    const startTime = performance.now();

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // MD3 emphasized easing approximation
        const eased = progress < 0.5
            ? 4 * progress * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        const current = Math.round(start + (target - start) * eased);
        element.textContent = current;
        if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
}

// ==========================================================
//  骨架屏生成
// ==========================================================
function createSkeletonList(count) {
    let html = "";
    for (let i = 0; i < count; i++) {
        html += '<div class="skeleton skeleton-card"></div>';
    }
    return html;
}

function createSkeletonText(count) {
    let html = "";
    const widths = ["", "medium", "short", "", "medium"];
    for (let i = 0; i < count; i++) {
        html += `<div class="skeleton skeleton-text ${widths[i % widths.length]}"></div>`;
    }
    return html;
}

// ==========================================================
//  键盘快捷键
// ==========================================================
function setupKeyboardShortcuts() {
    document.addEventListener("keydown", e => {
        // Escape 关闭全屏或弹窗
        if (e.key === "Escape") {
            if (document.getElementById("imagePanel").classList.contains("fullscreen")) {
                toggleFullscreen();
                return;
            }
            if (document.getElementById("editModal").classList.contains("active")) {
                closeEditModal();
                return;
            }
        }
        // Enter 保存弹窗
        if (e.key === "Enter" && document.getElementById("editModal").classList.contains("active")) {
            saveFieldEdit();
            return;
        }
        // 不在输入框内时的快捷键
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
        // 1-4 选择字段
        if (e.key >= "1" && e.key <= "4" && currentFields.length > 0) {
            const idx = parseInt(e.key) - 1;
            if (idx < FIELD_ORDER.length) {
                const fk = FIELD_ORDER[idx];
                const field = currentFields.find(f => f.field_key === fk);
                if (field) selectField(fk, field);
            }
        }
        // J/K 上下导航列表
        if ((e.key === "j" || e.key === "k") && currentView === "browse") {
            const items = document.querySelectorAll(".invoice-item");
            if (!items.length) return;
            let currentIdx = -1;
            items.forEach((el, i) => { if (el.classList.contains("active")) currentIdx = i; });
            const nextIdx = e.key === "j"
                ? Math.min(currentIdx + 1, items.length - 1)
                : Math.max(currentIdx - 1, 0);
            items[nextIdx]?.click();
        }
        // F 全屏
        if (e.key === "f" && currentView === "browse" && currentInvoiceId) {
            toggleFullscreen();
        }
    });
}

// ========== 导航 ==========
function navigateTo(viewName) {
    currentView = viewName;
    document.querySelectorAll(".nav-rail__item").forEach(el => {
        el.classList.toggle("active", el.dataset.view === viewName);
    });
    document.querySelectorAll(".view").forEach(el => el.classList.remove("active"));
    const target = document.getElementById("view" + capitalize(viewName));
    if (target) target.classList.add("active");

    if (viewName === "dashboard") loadStats();
    else if (viewName === "browse") loadInvoiceList(1);
    else if (viewName === "analytics") loadAnalytics();
    else if (viewName === "export") loadExportCounts();
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ========== Snackbar ==========
function showSnackbar(message, type = "info", duration = 3000) {
    const container = document.getElementById("snackbarContainer");
    const snackbar = document.createElement("div");
    snackbar.className = `snackbar ${type}`;
    snackbar.innerHTML = `<span>${escapeHtml(message)}</span><button class="snackbar__action" onclick="this.parentElement.remove()">关闭</button>`;
    container.appendChild(snackbar);
    setTimeout(() => { snackbar.classList.add("hiding"); setTimeout(() => snackbar.remove(), 200); }, duration);
}

// ==========================================================
//  概览 DASHBOARD
// ==========================================================
let cachedStats = null;

async function loadStats() {
    try {
        const resp = await fetch("/api/stats");
        const data = await resp.json();
        cachedStats = data;

        // 顶栏芯片（直接设置）
        document.getElementById("chipTotal").textContent = data.total;
        document.getElementById("chipApproved").textContent = data.approved;
        document.getElementById("chipRejected").textContent = data.rejected;
        document.getElementById("chipAnomaly").textContent = data.anomaly;

        // 卡片（带数字动画）
        animateCounter(document.getElementById("statTotal"), data.total);
        animateCounter(document.getElementById("statApproved"), data.approved);
        animateCounter(document.getElementById("statRejected"), data.rejected);
        animateCounter(document.getElementById("statAnomaly"), data.anomaly);

        // 状态柱状图
        renderStatusBarChart(data);

        // 最近活动
        renderRecentActivity(data.recent_activity || []);
    } catch (e) {
        console.error("加载统计数据失败:", e);
        showSnackbar("统计数据加载失败，请检查后端服务", "error", 5000);
    }
}

function renderStatusBarChart(data) {
    const chart = document.getElementById("statusBarChart");
    if (!chart) return;
    const total = data.total || 1;
    const bars = [
        { label: "待处理", cls: "pending", count: data.pending },
        { label: "已处理", cls: "processed", count: data.processed },
        { label: "已通过", cls: "approved", count: data.approved },
        { label: "已拒绝", cls: "rejected", count: data.rejected },
    ];
    let html = "";
    bars.forEach(b => {
        const pct = ((b.count / total) * 100).toFixed(1);
        html += `<div class="status-bar-row">
            <span class="status-bar-row__label">${b.label}</span>
            <div class="status-bar-row__track">
                <div class="status-bar-row__fill ${b.cls}" style="width:0%">${pct > 5 ? b.count : ""}</div>
            </div>
            <span class="status-bar-row__count">${b.count}</span>
        </div>`;
    });
    chart.innerHTML = html;

    // 延迟触发宽度动画
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            chart.querySelectorAll(".status-bar-row__fill").forEach((el, i) => {
                const pct = ((bars[i].count / total) * 100).toFixed(1);
                el.style.width = pct + "%";
            });
        });
    });
}

function renderRecentActivity(activities) {
    const container = document.getElementById("recentActivity");
    if (!activities.length) {
        container.innerHTML = '<div class="empty-state">暂无操作记录</div>';
        return;
    }
    let html = "";
    activities.forEach(a => {
        const t = getActivityType(a.action);
        const icon = t === "upload" ? ICONS.upload : t === "approve" ? ICONS.check : t === "reject" ? ICONS.x : ICONS.edit;
        html += `<div class="activity-item">
            <div class="activity-item__icon ${t}">${icon}</div>
            <div class="activity-item__text">${escapeHtml(a.description || a.action)}${a.sample_id ? ` <span style="opacity:0.5">- ${escapeHtml(a.sample_id)}</span>` : ""}</div>
            <div class="activity-item__time">${a.created_at || ""}</div>
        </div>`;
    });
    container.innerHTML = html;
}

function getActivityType(action) {
    if (action.includes("upload")) return "upload";
    if (action.includes("approve")) return "approve";
    if (action.includes("reject")) return "reject";
    return "edit";
}

// ==========================================================
//  上传 UPLOAD
// ==========================================================
function setupUploadDropzone() {
    const dropzone = document.getElementById("uploadDropzone");
    const fileInput = document.getElementById("fileInput");
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("drag-over"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
    dropzone.addEventListener("drop", e => { e.preventDefault(); dropzone.classList.remove("drag-over"); handleFiles(e.dataTransfer.files); });
    fileInput.addEventListener("change", () => { handleFiles(fileInput.files); fileInput.value = ""; });
}

function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith("image/"));
    if (!files.length) { showSnackbar("请选择图片文件", "error"); return; }
    const queue = document.getElementById("uploadQueue");
    files.forEach((file, idx) => {
        const item = document.createElement("div");
        item.className = "upload-queue__item";
        item.id = `uq_${Date.now()}_${idx}`;
        item.innerHTML = `
            <div class="upload-queue__row">
                <span class="upload-queue__filename">${escapeHtml(file.name)}</span>
                <span class="upload-queue__status waiting">等待中</span>
            </div>
            <div class="upload-queue__progress"><div class="upload-queue__progress-bar"></div></div>
            <div class="upload-queue__summary"></div>`;
        queue.prepend(item);
    });
    processUploadQueue(files, 0);
}

async function processUploadQueue(files, index) {
    if (index >= files.length) return;
    const file = files[index];
    const items = document.querySelectorAll(".upload-queue__item");
    const item = items[files.length - 1 - index];
    if (!item) return;

    const statusEl = item.querySelector(".upload-queue__status");
    const progressBar = item.querySelector(".upload-queue__progress-bar");
    const summaryEl = item.querySelector(".upload-queue__summary");

    statusEl.className = "upload-queue__status processing";
    statusEl.textContent = "上传中...";
    progressBar.classList.remove("indeterminate");
    progressBar.style.width = "0%";

    try {
        const result = await uploadWithProgress(file, (phase, pct) => {
            progressBar.style.width = pct + "%";
            if (phase === "upload") {
                statusEl.textContent = pct < 100 ? `上传中 ${pct}%` : "识别中...";
                if (pct >= 100) progressBar.classList.add("indeterminate");
            }
        });

        statusEl.className = "upload-queue__status done";
        statusEl.textContent = "完成";
        progressBar.classList.remove("indeterminate");
        progressBar.style.width = "100%";

        let s = "";
        const fields = result.fields || {};
        for (const [key, val] of Object.entries(fields)) {
            s += `<span><strong>${FIELD_NAME_MAP[key] || key}:</strong> ${escapeHtml(val.value || "-")}</span>`;
        }
        if (result.processing_time_ms) s += `<span style="color:var(--md-outline)">${result.processing_time_ms.toFixed(0)}ms</span>`;
        s += `<a class="upload-queue__link" onclick="viewUploadedInvoice('${result.invoice_id}')">查看详情 &rarr;</a>`;
        summaryEl.innerHTML = s;
        showSnackbar(`${file.name} 处理完成`, "success");
    } catch (e) {
        statusEl.className = "upload-queue__status error";
        statusEl.textContent = "失败";
        progressBar.classList.remove("indeterminate");
        progressBar.style.width = "0";
        summaryEl.innerHTML = `<span style="color:var(--md-red)">${escapeHtml(e.message)}</span>`;
        showSnackbar(`处理失败: ${e.message}`, "error", 5000);
    }
    processUploadQueue(files, index + 1);
}

function uploadWithProgress(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append("file", file);

        xhr.upload.addEventListener("progress", e => {
            if (e.lengthComputable) {
                onProgress("upload", Math.round(e.loaded / e.total * 100));
            }
        });

        xhr.addEventListener("load", () => {
            try {
                const result = JSON.parse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(result);
                } else {
                    reject(new Error(result.detail || `HTTP ${xhr.status}`));
                }
            } catch {
                reject(new Error(`HTTP ${xhr.status}`));
            }
        });

        xhr.addEventListener("error", () => reject(new Error("网络错误")));
        xhr.addEventListener("abort", () => reject(new Error("已取消")));

        xhr.open("POST", "/api/upload");
        xhr.send(formData);
    });
}

function viewUploadedInvoice(invoiceId) {
    navigateTo("browse");
    setTimeout(() => { loadInvoiceList(1); loadInvoiceDetail(invoiceId); }, 100);
}

// ==========================================================
//  浏览：票据列表
// ==========================================================
async function loadInvoiceList(page) {
    currentPage = page;

    if (searchMode) {
        const q = document.getElementById("searchInput").value.trim();
        const confMin = document.getElementById("confMin").value;
        const confMax = document.getElementById("confMax").value;
        let url = `/api/invoices/search?page=${page}&page_size=20`;
        if (q) url += `&q=${encodeURIComponent(q)}`;
        if (currentFilter) url += `&status=${currentFilter}`;
        if (confMin) url += `&conf_min=${confMin}`;
        if (confMax) url += `&conf_max=${confMax}`;
        loadInvoiceListFromUrl(url, page);
        return;
    }

    let url = `/api/invoices?page=${page}&page_size=20`;
    if (currentFilter) url += `&status=${currentFilter}`;

    const list = document.getElementById("invoiceList");
    list.innerHTML = createSkeletonList(6);

    try {
        const resp = await fetch(url);
        const data = await resp.json();
        totalPages = data.total_pages;
        renderInvoiceListData(data);
    } catch (e) {
        console.error("加载列表失败:", e);
        list.innerHTML = '<div class="empty-state">加载失败</div>';
    }
}

function prevPage() { if (currentPage > 1) loadInvoiceList(currentPage - 1); }
function nextPage() { if (currentPage < totalPages) loadInvoiceList(currentPage + 1); }

function filterByStatus(el, status) {
    currentFilter = status;
    document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
    el.classList.add("active");
    loadInvoiceList(1);
}

// ==========================================================
//  浏览：票据详情
// ==========================================================
async function loadInvoiceDetail(invoiceId) {
    // 取消上一个正在进行的请求，防止竞态
    if (detailAbortController) detailAbortController.abort();
    detailAbortController = new AbortController();

    currentInvoiceId = invoiceId;
    document.querySelectorAll(".invoice-item").forEach(el => el.classList.remove("active"));

    try {
        const resp = await fetch(`/api/invoices/${invoiceId}`, {
            signal: detailAbortController.signal
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        currentInvoiceData = data;
        currentFields = data.fields || [];
        currentOcrBlocks = data.ocr_blocks || [];
        activeFieldKey = null;

        // 显示控件
        document.getElementById("legend").style.display = "flex";
        document.getElementById("imageControls").style.display = "flex";
        document.getElementById("reviewActions").style.display = "flex";

        // 状态标签
        const statusChip = document.getElementById("currentStatus");
        const st = data.invoice.status || "processed";
        statusChip.className = `status-chip ${st}`;
        statusChip.textContent = STATUS_MAP[st] || st;

        // 加载图片（重置平移缩放）
        resetImageView();
        loadImage(data.invoice.sample_id);

        // 渲染各面板
        renderInvoiceMeta(data);
        renderFieldCards(data.fields, data.ground_truth);
        renderOcrTextPreview(currentOcrBlocks);
        renderAuditLogs(data.audit_logs);

        document.getElementById("candidatesSection").innerHTML =
            '<div class="empty-state">点击字段卡片查看候选值</div>';

        // 列表高亮
        document.querySelectorAll(".invoice-item").forEach(el => {
            const n = el.querySelector(".invoice-item__name");
            if (n && n.textContent === data.invoice.sample_id + ".jpg") el.classList.add("active");
        });
    } catch (e) {
        if (e.name === "AbortError") return;  // 被新请求取消，静默忽略
        console.error("加载详情失败:", e);
        showSnackbar("加载票据详情失败: " + e.message, "error");
    }
}

// ========== 票据元数据 ==========
function renderInvoiceMeta(data) {
    const container = document.getElementById("invoiceMeta");
    const inv = data.invoice;
    const nBlocks = currentOcrBlocks.length;
    const nFields = currentFields.length;
    const nCandidates = currentFields.reduce((sum, f) => sum + (f.candidates ? f.candidates.length : 0), 0);

    container.innerHTML = `<div class="meta-grid">
        <div class="meta-item"><div class="meta-item__label">样本 ID</div><div class="meta-item__value">${escapeHtml(inv.sample_id)}</div></div>
        <div class="meta-item"><div class="meta-item__label">状态</div><div class="meta-item__value"><span class="status-chip ${inv.status}">${STATUS_MAP[inv.status] || inv.status}</span></div></div>
        <div class="meta-item"><div class="meta-item__label">OCR 文本块</div><div class="meta-item__value">${nBlocks} 个</div></div>
        <div class="meta-item"><div class="meta-item__label">候选值总数</div><div class="meta-item__value">${nCandidates} 个</div></div>
        <div class="meta-item"><div class="meta-item__label">提取字段</div><div class="meta-item__value">${nFields} / 4</div></div>
        <div class="meta-item"><div class="meta-item__label">创建时间</div><div class="meta-item__value">${inv.created_at || "-"}</div></div>
    </div>`;
}

// ========== OCR 文本预览 ==========
function renderOcrTextPreview(blocks) {
    const container = document.getElementById("ocrTextPreview");
    if (!blocks || !blocks.length) {
        container.innerHTML = '<div class="empty-state">无 OCR 文本</div>';
        return;
    }
    let html = '<div class="ocr-text-box">';
    blocks.forEach((b, i) => {
        const conf = b.confidence ? (b.confidence * 100).toFixed(0) + "%" : "";
        html += `<div class="ocr-line">
            <span class="ocr-line__num">${i + 1}</span>
            <span class="ocr-line__text">${escapeHtml(b.text)}</span>
            <span class="ocr-line__conf">${conf}</span>
        </div>`;
    });
    html += '</div>';
    container.innerHTML = html;
}

// ==========================================================
//  图片：拖拽平移 + 滚轮缩放 + 双击全屏
// ==========================================================
function setupImagePanZoom() {
    const wrapper = document.getElementById("canvasWrapper");
    if (!wrapper) return;

    // 鼠标拖拽平移
    wrapper.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        imgDragging = true;
        imgDragStartX = e.clientX;
        imgDragStartY = e.clientY;
        imgPanStartX = imgPanX;
        imgPanStartY = imgPanY;
        e.preventDefault();
    });

    window.addEventListener("mousemove", e => {
        if (!imgDragging) return;
        imgPanX = imgPanStartX + (e.clientX - imgDragStartX);
        imgPanY = imgPanStartY + (e.clientY - imgDragStartY);
        applyImageTransform();
    });

    window.addEventListener("mouseup", () => { imgDragging = false; });

    // 滚轮缩放
    wrapper.addEventListener("wheel", e => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        const oldZoom = imgZoom;
        imgZoom = Math.max(0.2, Math.min(5, imgZoom + delta));

        // 以鼠标位置为中心缩放
        const rect = wrapper.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const ratio = imgZoom / oldZoom;
        imgPanX = mx - ratio * (mx - imgPanX);
        imgPanY = my - ratio * (my - imgPanY);

        applyImageTransform();
    }, { passive: false });

    // 双击全屏
    wrapper.addEventListener("dblclick", () => {
        if (currentInvoiceId) toggleFullscreen();
    });
}

function applyImageTransform() {
    const container = document.getElementById("canvasContainer");
    if (!container) return;
    container.style.transform = `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom})`;
    const zoomEl = document.getElementById("zoomLevel");
    if (zoomEl) zoomEl.textContent = Math.round(imgZoom * 100) + "%";
}

function zoomImage(delta) {
    imgZoom = Math.max(0.2, Math.min(5, imgZoom + delta));
    applyImageTransform();
}

function resetImageView() {
    imgZoom = 1;
    imgPanX = 0;
    imgPanY = 0;
    applyImageTransform();
}

// ==========================================================
//  全屏切换
// ==========================================================
function toggleFullscreen() {
    const panel = document.getElementById("imagePanel");
    const btn = document.getElementById("fullscreenBtn");
    const isFS = panel.classList.toggle("fullscreen");

    if (btn) {
        btn.innerHTML = isFS
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3"/></svg>';
        btn.title = isFS ? "退出全屏" : "全屏";
    }
}

// ==========================================================
//  图片 & Canvas 绘制（带渐现动画）
// ==========================================================
function loadImage(sampleId) {
    const container = document.getElementById("canvasContainer");
    container.innerHTML = `
        <img id="invoiceImg" src="/api/images/${sampleId}" onload="onImageLoad()" crossorigin="anonymous">
        <canvas id="overlayCanvas"></canvas>`;
}

function onImageLoad() {
    const img = document.getElementById("invoiceImg");
    const canvas = document.getElementById("overlayCanvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    // 渐现 bbox
    canvas.style.opacity = "0";
    drawAllBoxes();
    requestAnimationFrame(() => {
        canvas.style.transition = "opacity 400ms cubic-bezier(0.2, 0, 0, 1)";
        canvas.style.opacity = "1";
    });
}

function drawBbox(ctx, bbox, fillStyle, strokeStyle, lineWidth) {
    ctx.beginPath();
    ctx.moveTo(bbox[0][0], bbox[0][1]);
    ctx.lineTo(bbox[1][0], bbox[1][1]);
    ctx.lineTo(bbox[2][0], bbox[2][1]);
    ctx.lineTo(bbox[3][0], bbox[3][1]);
    ctx.closePath();
    if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
}

function drawLabel(ctx, bbox, text, color) {
    const x = bbox[0][0], y = bbox[0][1] - 4;
    ctx.font = "bold 14px sans-serif";
    const tw = ctx.measureText(text).width;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    const pad = 4;
    ctx.beginPath();
    const rx = x - 1, ry = y - 14, rw = tw + pad * 2 + 2, rh = 18, r = 4;
    ctx.moveTo(rx + r, ry);
    ctx.lineTo(rx + rw - r, ry);
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
    ctx.lineTo(rx + rw, ry + rh - r);
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
    ctx.lineTo(rx + r, ry + rh);
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
    ctx.lineTo(rx, ry + r);
    ctx.quadraticCurveTo(rx, ry, rx + r, ry);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.fillText(text, x + pad, y);
}

function drawAllBoxes(highlightKey = null) {
    const canvas = document.getElementById("overlayCanvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const candidateBboxes = {};
    currentFields.forEach(field => {
        const fk = field.field_key;
        candidateBboxes[fk] = [];
        (field.candidates || []).forEach(c => {
            let bbox = c.bbox;
            if (!bbox) {
                const m = currentOcrBlocks.find(b => b.text && b.text.trim() === (c.value || "").trim());
                if (m) bbox = m.bbox;
            }
            if (bbox) candidateBboxes[fk].push({ bbox, value: c.value, isSelected: c.is_selected === 1 });
        });
    });

    // Layer 0: OCR blocks
    ctx.save();
    ctx.globalAlpha = highlightKey ? 0.12 : 0.3;
    currentOcrBlocks.forEach(b => {
        if (!b.bbox) return;
        drawBbox(ctx, b.bbox, "rgba(200,200,220,0.03)", "rgba(200,200,220,0.25)", 1);
    });
    ctx.restore();

    // Layer 1: 字段选中框
    currentFields.forEach(field => {
        const fk = field.field_key, bbox = field.evidence_bbox;
        if (!bbox) return;
        const colors = FIELD_COLORS[fk] || FIELD_COLORS.company;
        const isActive = !highlightKey || highlightKey === fk;
        ctx.save();
        ctx.globalAlpha = isActive ? 1.0 : 0.1;
        drawBbox(ctx, bbox, colors.fill, colors.stroke, isActive ? 3 : 1.5);
        if (isActive) drawLabel(ctx, bbox, colors.label, colors.stroke);
        ctx.restore();
    });

    // Layer 2: 候选框（虚线）
    if (highlightKey && candidateBboxes[highlightKey]) {
        const colors = FIELD_COLORS[highlightKey];
        candidateBboxes[highlightKey].forEach(item => {
            if (item.isSelected) return;
            ctx.save();
            ctx.globalAlpha = 0.45;
            ctx.setLineDash([6, 4]);
            drawBbox(ctx, item.bbox, "rgba(232, 192, 106, 0.08)", colors.stroke, 2);
            ctx.restore();
        });
    }
}

// ==========================================================
//  字段卡片（点击展开内联候选值）
// ==========================================================
function renderFieldCards(fields, groundTruth) {
    const container = document.getElementById("fieldCards");
    container.innerHTML = "";
    const gt = groundTruth || {};

    FIELD_ORDER.forEach(fk => {
        const field = fields.find(f => f.field_key === fk);
        if (!field) return;

        const gtVal = gt[fk] || "";
        const predVal = field.final_value || "";
        const conf = field.confidence || 0;
        const isMatch = predVal && gtVal &&
            (predVal.trim().toLowerCase() === gtVal.trim().toLowerCase() ||
             predVal.replace(/\s/g, "") === gtVal.replace(/\s/g, ""));

        const confPercent = (conf * 100).toFixed(1);
        const confColor = conf >= 0.7 ? "var(--md-green)" : conf >= 0.4 ? "var(--md-amber)" : "var(--md-red)";
        const nCands = (field.candidates || []).length;

        const card = document.createElement("div");
        card.className = `field-card ${fk}`;

        // 内联候选值 HTML
        let candidatesHtml = "";
        if (nCands > 0) {
            candidatesHtml = '<div class="field-card__candidates"><table class="candidates-table"><thead><tr><th>#</th><th>候选值</th><th>OCR</th><th>格式</th><th>跨字段</th><th>综合</th></tr></thead><tbody>';
            (field.candidates || []).forEach((c, idx) => {
                candidatesHtml += `<tr class="${c.is_selected === 1 ? "selected" : ""}">
                    <td>${idx + 1}</td>
                    <td title="${escapeHtml(c.value)}">${truncate(c.value, 20)}</td>
                    <td class="score-cell">${scoreCell(c.ocr_confidence)}</td>
                    <td class="score-cell">${scoreCell(c.format_score)}</td>
                    <td class="score-cell">${scoreCell(c.cross_field_score)}</td>
                    <td class="score-cell"><strong>${scoreCell(c.final_score)}</strong></td>
                </tr>`;
            });
            candidatesHtml += "</tbody></table></div>";
        }

        card.innerHTML = `
            <div class="field-header">
                <span class="field-name">${FIELD_NAME_MAP[fk]}</span>
                <div class="field-actions">
                    <span class="field-confidence">${confPercent}% | ${nCands}候选</span>
                    <button class="field-edit-btn" onclick="event.stopPropagation(); openEditModal('${fk}', '${escapeAttr(predVal)}')" title="编辑">${ICONS.edit}</button>
                </div>
            </div>
            <div class="field-value">${escapeHtml(predVal) || "<空>"}</div>
            <div class="field-gt">
                标注: ${escapeHtml(gtVal) || "无"}
                ${gtVal ? `<span class="match-icon ${isMatch ? "match-yes" : "match-no"}">${isMatch ? "PASS" : "MISS"}</span>` : ""}
            </div>
            <div class="confidence-bar"><div class="fill" style="width:${confPercent}%;background:${confColor}"></div></div>
            ${candidatesHtml}`;
        card.onclick = () => selectField(fk, field);
        container.appendChild(card);
    });
}

function selectField(fieldKey, field) {
    activeFieldKey = fieldKey;
    document.querySelectorAll(".field-card").forEach(c => c.classList.remove("active"));
    document.querySelector(`.field-card.${fieldKey}`)?.classList.add("active");
    drawAllBoxes(fieldKey);
    renderCandidates(fieldKey, field);
}

// ==========================================================
//  候选值表格（右侧全量展示）
// ==========================================================
function renderCandidates(fieldKey, field) {
    const container = document.getElementById("candidatesSection");
    const candidates = field.candidates || [];
    if (!candidates.length) { container.innerHTML = '<div class="empty-state">无候选值</div>'; return; }

    let html = `<table class="candidates-table"><thead><tr>
        <th>#</th><th>候选值</th><th>来源</th><th>OCR</th><th>格式</th><th>跨字段</th><th>综合</th>
    </tr></thead><tbody>`;

    candidates.forEach((c, idx) => {
        html += `<tr class="${c.is_selected === 1 ? "selected" : ""}">
            <td>${idx + 1}</td>
            <td title="${escapeHtml(c.value)}">${truncate(c.value, 24)}</td>
            <td>${c.source || ""}</td>
            <td class="score-cell">${scoreCell(c.ocr_confidence)}</td>
            <td class="score-cell">${scoreCell(c.format_score)}</td>
            <td class="score-cell">${scoreCell(c.cross_field_score)}</td>
            <td class="score-cell"><strong>${scoreCell(c.final_score)}</strong></td>
        </tr>`;
    });
    html += "</tbody></table>";
    if (field.decision_reason) html += `<div class="decision-reason">决策: ${escapeHtml(field.decision_reason)}</div>`;
    container.innerHTML = html;
}

function scoreCell(score) {
    if (score == null) return "-";
    const s = parseFloat(score);
    const w = Math.round(s * 40);
    const color = s >= 0.7 ? "#7DD491" : s >= 0.4 ? "#E8C06A" : "#FFB4AB";
    return `<span class="score-bar" style="width:${w}px;background:${color}"></span>${s.toFixed(3)}`;
}

// ==========================================================
//  审计日志
// ==========================================================
function renderAuditLogs(logs) {
    const container = document.getElementById("auditTimeline");
    if (!logs || !logs.length) { container.innerHTML = '<div class="empty-state">暂无审计日志</div>'; return; }
    let html = "";
    logs.forEach(log => {
        html += `<div class="timeline-item"><div>
            <div class="tl-action">${escapeHtml(log.action)}</div>
            <div class="tl-desc">${escapeHtml(log.description || "")}</div>
            <div class="tl-time">${log.created_at || ""}</div>
        </div></div>`;
    });
    container.innerHTML = html;
}

// ==========================================================
//  审核：通过 / 拒绝
// ==========================================================
async function approveInvoice() {
    if (!currentInvoiceId) return;
    const btn = document.getElementById("btnApprove");
    btn.disabled = true;
    try {
        const resp = await fetch(`/api/invoices/${currentInvoiceId}/approve`, { method: "POST" });
        const result = await resp.json().catch(() => null);
        if (!resp.ok) throw new Error(result?.detail || `HTTP ${resp.status}`);
        showSnackbar("票据已审核通过", "success");
        await loadInvoiceDetail(currentInvoiceId);
        loadInvoiceList(currentPage);
        loadStats();
    } catch (e) {
        showSnackbar("审核失败: " + e.message, "error");
    } finally {
        btn.disabled = false;
    }
}

async function rejectInvoice() {
    if (!currentInvoiceId) return;
    const btn = document.getElementById("btnReject");
    btn.disabled = true;
    try {
        const resp = await fetch(`/api/invoices/${currentInvoiceId}/reject`, { method: "POST" });
        const result = await resp.json().catch(() => null);
        if (!resp.ok) throw new Error(result?.detail || `HTTP ${resp.status}`);
        showSnackbar("票据已标记拒绝", "success");
        await loadInvoiceDetail(currentInvoiceId);
        loadInvoiceList(currentPage);
        loadStats();
    } catch (e) {
        showSnackbar("拒绝失败: " + e.message, "error");
    } finally {
        btn.disabled = false;
    }
}

// ==========================================================
//  编辑弹窗
// ==========================================================
function openEditModal(fieldKey, currentValue) {
    editingInvoiceId = currentInvoiceId;
    editingFieldKey = fieldKey;
    document.getElementById("editModalTitle").textContent = `编辑: ${FIELD_NAME_MAP[fieldKey] || fieldKey}`;
    document.getElementById("editModalLabel").textContent = `${FIELD_NAME_MAP[fieldKey] || fieldKey} 值`;
    const input = document.getElementById("editModalInput");
    input.value = currentValue;
    document.getElementById("editModal").classList.add("active");
    setTimeout(() => input.focus(), 100);
}

function closeEditModal() {
    document.getElementById("editModal").classList.remove("active");
    editingInvoiceId = null;
    editingFieldKey = null;
}

async function saveFieldEdit() {
    if (!editingInvoiceId || !editingFieldKey) return;
    const newValue = document.getElementById("editModalInput").value;
    try {
        const resp = await fetch(
            `/api/invoices/${editingInvoiceId}/fields/${editingFieldKey}`,
            { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: newValue }) }
        );
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.detail || "保存失败"); }
        showSnackbar(`${FIELD_NAME_MAP[editingFieldKey] || editingFieldKey} 已更新`, "success");
        closeEditModal();
        await loadInvoiceDetail(editingInvoiceId);
    } catch (e) {
        showSnackbar("保存失败: " + e.message, "error");
    }
}

document.addEventListener("click", e => { if (e.target.classList.contains("modal-overlay")) closeEditModal(); });

// ==========================================================
//  工具函数
// ==========================================================
function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    if (!text) return "";
    return text.replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

function truncate(text, maxLen) {
    if (!text) return "";
    return text.length > maxLen ? text.substring(0, maxLen) + "..." : text;
}

// ==========================================================
//  搜索与高级筛选
// ==========================================================
let searchMode = false;

function doSearch() {
    const q = document.getElementById("searchInput").value.trim();
    const confMin = document.getElementById("confMin").value;
    const confMax = document.getElementById("confMax").value;
    const clearBtn = document.getElementById("searchClear");

    if (!q && !confMin && !confMax && !currentFilter) {
        clearSearch();
        return;
    }

    searchMode = true;
    if (q) clearBtn.style.display = "block";

    let url = `/api/invoices/search?page=1&page_size=20`;
    if (q) url += `&q=${encodeURIComponent(q)}`;
    if (currentFilter) url += `&status=${currentFilter}`;
    if (confMin) url += `&conf_min=${(parseFloat(confMin) / 100).toFixed(2)}`;
    if (confMax) url += `&conf_max=${(parseFloat(confMax) / 100).toFixed(2)}`;

    loadInvoiceListFromUrl(url, 1);
}

function clearSearch() {
    document.getElementById("searchInput").value = "";
    document.getElementById("confMin").value = "";
    document.getElementById("confMax").value = "";
    document.getElementById("searchClear").style.display = "none";
    searchMode = false;
    loadInvoiceList(1);
}

async function loadInvoiceListFromUrl(url, page) {
    currentPage = page;
    const list = document.getElementById("invoiceList");
    list.innerHTML = createSkeletonList(6);

    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        totalPages = data.total_pages;
        renderInvoiceListData(data);
    } catch (e) {
        console.error("搜索失败:", e);
        list.innerHTML = `<div class="empty-state">搜索失败: ${escapeHtml(e.message)}</div>`;
    }
}

// ==========================================================
//  批量操作
// ==========================================================
let selectedInvoiceIds = new Set();
let batchMode = false;

function toggleBatchMode(on) {
    batchMode = on;
    const bar = document.getElementById("batchBar");
    bar.style.display = on ? "flex" : "none";
    if (!on) {
        selectedInvoiceIds.clear();
        document.getElementById("selectAllCheckbox").checked = false;
        document.querySelectorAll(".invoice-item__checkbox").forEach(c => c.checked = false);
    }
    updateBatchCount();
}

function updateBatchCount() {
    const el = document.getElementById("batchCount");
    if (el) el.textContent = `已选 ${selectedInvoiceIds.size} 项`;
}

function toggleSelectAll(checked) {
    document.querySelectorAll(".invoice-item__checkbox").forEach(cb => {
        cb.checked = checked;
        const id = cb.dataset.id;
        if (checked) selectedInvoiceIds.add(id);
        else selectedInvoiceIds.delete(id);
    });
    updateBatchCount();
}

function toggleInvoiceSelect(checkbox, invoiceId) {
    if (checkbox.checked) selectedInvoiceIds.add(invoiceId);
    else selectedInvoiceIds.delete(invoiceId);
    updateBatchCount();

    // 如果有选中项，自动显示批量操作栏
    if (selectedInvoiceIds.size > 0 && !batchMode) toggleBatchMode(true);
    else if (selectedInvoiceIds.size === 0 && batchMode) toggleBatchMode(false);
}

async function batchAction(action) {
    if (selectedInvoiceIds.size === 0) {
        showSnackbar("请先选择票据", "error");
        return;
    }
    const label = action === "approve" ? "通过" : "拒绝";
    try {
        const resp = await fetch("/api/invoices/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ invoice_ids: Array.from(selectedInvoiceIds), action }),
        });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.detail || `HTTP ${resp.status}`); }
        const result = await resp.json();
        showSnackbar(`批量${label}完成：${result.success}/${result.requested} 条`, "success");
        toggleBatchMode(false);
        loadInvoiceList(currentPage);
        loadStats();
    } catch (e) {
        showSnackbar(`批量${label}失败: ${e.message}`, "error");
    }
}

async function batchDelete() {
    if (selectedInvoiceIds.size === 0) {
        showSnackbar("请先选择票据", "error");
        return;
    }
    if (!confirm(`确定删除选中的 ${selectedInvoiceIds.size} 条票据？此操作不可撤销。`)) return;
    try {
        const resp = await fetch("/api/invoices/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ invoice_ids: Array.from(selectedInvoiceIds) }),
        });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.detail || `HTTP ${resp.status}`); }
        const result = await resp.json();
        showSnackbar(`已删除 ${result.deleted} 条票据`, "success");
        toggleBatchMode(false);
        currentInvoiceId = null;
        currentInvoiceData = null;
        loadInvoiceList(currentPage);
        loadStats();
    } catch (e) {
        showSnackbar(`删除失败: ${e.message}`, "error");
    }
}

function exportExcel(status) {
    let url = "/api/export";
    if (status) url += `?status=${status}`;
    window.open(url, "_blank");
    showSnackbar("正在生成 Excel 文件...", "info");
}

async function loadExportCounts() {
    try {
        const resp = await fetch("/api/stats");
        const data = await resp.json();
        const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
        el("exportCountAll", data.total + " 条");
        el("exportCountApproved", (data.approved || 0) + " 条");
        el("exportCountRejected", (data.rejected || 0) + " 条");
        el("exportCountProcessed", (data.processed || 0) + " 条");
        el("exportCountPending", (data.pending || 0) + " 条");
    } catch (e) {
        console.error("加载导出数量失败:", e);
    }
}

// ==========================================================
//  重构列表渲染（支持批量复选框）
// ==========================================================
function renderInvoiceListData(data) {
    const list = document.getElementById("invoiceList");
    list.innerHTML = "";
    document.getElementById("listHeader").textContent = `票据列表 (${data.total})`;

    // 有数据时显示批量操作栏
    if (data.items.length > 0) {
        document.getElementById("batchBar").style.display = "flex";
        batchMode = true;
    }

    if (!data.items.length) {
        list.innerHTML = '<div class="empty-state">暂无票据数据</div>';
        toggleBatchMode(false);
    } else {
        data.items.forEach((item, idx) => {
            const div = document.createElement("div");
            div.className = "invoice-item ripple-host" + (item.id === currentInvoiceId ? " active" : "");
            const st = item.status || "processed";
            const timeMs = item.processing_time_ms ? `${Math.round(item.processing_time_ms)}ms` : "";
            const isChecked = selectedInvoiceIds.has(item.id) ? "checked" : "";
            div.innerHTML = `
                <input type="checkbox" class="invoice-item__checkbox" data-id="${item.id}"
                    ${isChecked} onclick="event.stopPropagation(); toggleInvoiceSelect(this, '${item.id}')">
                <div class="invoice-item__info">
                    <div class="invoice-item__name">${escapeHtml(item.sample_id)}.jpg</div>
                    <div class="invoice-item__meta">${timeMs}${timeMs && item.created_at ? " | " : ""}${item.created_at || ""}</div>
                </div>
                <span class="status-chip ${st}">${STATUS_MAP[st] || st}</span>`;
            div.onclick = (e) => {
                if (e.target.type === "checkbox") return;
                loadInvoiceDetail(item.id);
            };
            div.style.opacity = "0";
            div.style.transform = "translateX(-8px)";
            div.style.transition = `opacity 250ms ${idx * 30}ms cubic-bezier(0.2, 0, 0, 1), transform 250ms ${idx * 30}ms cubic-bezier(0.2, 0, 0, 1)`;
            list.appendChild(div);
        });

        requestAnimationFrame(() => {
            list.querySelectorAll(".invoice-item").forEach(el => {
                el.style.opacity = "1";
                el.style.transform = "translateX(0)";
            });
        });
    }

    document.getElementById("btnPrev").disabled = data.page <= 1;
    document.getElementById("btnNext").disabled = data.page >= totalPages;
    document.getElementById("pageInfo").textContent = `${data.page} / ${totalPages || 1}`;
}

// ==========================================================
//  分析页面
// ==========================================================
const CHART_COLORS = {
    primary: "#A8C7FA",
    green: "#7DD491",
    amber: "#E8C06A",
    red: "#FFB4AB",
    purple: "#D7BDE4",
    surface: "#201F23",
    text: "#E4E1E6",
    textDim: "#918F9A",
    grid: "rgba(200,200,220,0.12)",
};

async function loadAnalytics() {
    try {
        const resp = await fetch("/api/analytics");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.overview) renderOverviewStats(data.overview);
        if (data.accuracy) renderAccuracyCards(data.accuracy);
        if (data.field_confidence) renderFieldConfTable(data.field_confidence);
        if (data.confidence_distribution) drawBarChart("chartConfDist", data.confidence_distribution.labels, data.confidence_distribution.values, CHART_COLORS.primary);
        if (data.processing_time) drawBarChart("chartTimeDist", data.processing_time.distribution.labels, data.processing_time.distribution.values, CHART_COLORS.amber);
        if (data.field_confidence) drawFieldConfChart("chartFieldConf", data.field_confidence);
        if (data.status_distribution) drawStatusChart("chartStatusDist", data.status_distribution);
        if (data.time_trend) drawLineChart("chartTimeTrend", data.time_trend);
    } catch (e) {
        console.error("加载分析数据失败:", e);
        showSnackbar("加载分析数据失败: " + e.message, "error");
    }
}

function renderOverviewStats(ov) {
    const container = document.getElementById("overviewStats");
    const items = [
        { label: "票据总数", value: ov.total_invoices, icon: "file", color: CHART_COLORS.primary },
        { label: "总体准确率", value: ov.overall_accuracy + "%", icon: "check", color: CHART_COLORS.green },
        { label: "平均置信度", value: ov.avg_confidence + "%", icon: "eye", color: CHART_COLORS.amber },
        { label: "平均处理时间", value: ov.avg_time_ms + "ms", icon: "clock", color: CHART_COLORS.purple },
        { label: "GT 样本数", value: ov.gt_samples, icon: "target", color: CHART_COLORS.red },
        { label: "总候选值数", value: ov.total_candidates, icon: "list", color: CHART_COLORS.primary },
    ];
    const icons = {
        file: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>',
        check: '<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
        list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    };
    let html = "";
    items.forEach(it => {
        html += `<div class="overview-stat-card">
            <div class="overview-stat-card__icon" style="color:${it.color}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${icons[it.icon]}</svg>
            </div>
            <div class="overview-stat-card__value">${it.value}</div>
            <div class="overview-stat-card__label">${it.label}</div>
        </div>`;
    });
    container.innerHTML = html;
}

function renderAccuracyCards(accuracy) {
    const container = document.getElementById("accuracyCards");
    const fields = ["company", "date", "address", "total"];
    const colors = [CHART_COLORS.primary, CHART_COLORS.green, CHART_COLORS.amber, CHART_COLORS.red];
    let html = "";
    fields.forEach((fk, i) => {
        const d = accuracy[fk] || { correct: 0, total: 0, rate: 0 };
        const pct = (d.rate * 100).toFixed(1);
        html += `<div class="accuracy-card">
            <div class="accuracy-card__ring">
                <svg viewBox="0 0 80 80">
                    <circle cx="40" cy="40" r="34" fill="none" stroke="${CHART_COLORS.grid}" stroke-width="6"/>
                    <circle cx="40" cy="40" r="34" fill="none" stroke="${colors[i]}" stroke-width="6"
                        stroke-dasharray="${d.rate * 213.6} ${213.6 - d.rate * 213.6}"
                        stroke-dashoffset="53.4" stroke-linecap="round"
                        style="transition:stroke-dasharray 800ms cubic-bezier(0.2,0,0,1)"/>
                </svg>
                <span class="accuracy-card__pct">${pct}%</span>
            </div>
            <div class="accuracy-card__label">${FIELD_NAME_MAP[fk]}</div>
            <div class="accuracy-card__detail">${d.correct} / ${d.total}</div>
        </div>`;
    });
    container.innerHTML = html;
}

function renderFieldConfTable(fieldConf) {
    const container = document.getElementById("fieldConfTable");
    let html = '<table class="analytics-table"><thead><tr><th>字段</th><th>样本数</th><th>平均置信度</th><th>最低</th><th>最高</th><th>分布</th></tr></thead><tbody>';
    for (const fk of ["company", "date", "address", "total"]) {
        const d = fieldConf[fk];
        if (!d) continue;
        const barW = Math.round(d.avg * 100);
        const color = d.avg >= 0.7 ? CHART_COLORS.green : d.avg >= 0.4 ? CHART_COLORS.amber : CHART_COLORS.red;
        html += `<tr>
            <td><strong>${FIELD_NAME_MAP[fk]}</strong></td>
            <td>${d.count}</td>
            <td>${(d.avg * 100).toFixed(1)}%</td>
            <td>${(d.min * 100).toFixed(1)}%</td>
            <td>${(d.max * 100).toFixed(1)}%</td>
            <td><div class="conf-bar-cell"><div class="conf-bar-fill" style="width:${barW}%;background:${color}"></div></div></td>
        </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
}

// ==========================================================
//  Canvas 图表绘制
// ==========================================================
function drawBarChart(canvasId, labels, values, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const padL = 45, padR = 15, padT = 15, padB = 45;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const maxVal = Math.max(...values, 1);
    const barW = chartW / labels.length * 0.6;
    const gap = chartW / labels.length;

    // 网格线
    ctx.strokeStyle = CHART_COLORS.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padT + chartH - (chartH * i / 4);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.fillStyle = CHART_COLORS.textDim;
        ctx.font = "11px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(Math.round(maxVal * i / 4), padL - 6, y + 4);
    }

    // 柱子
    labels.forEach((label, i) => {
        const barH = (values[i] / maxVal) * chartH;
        const x = padL + i * gap + (gap - barW) / 2;
        const y = padT + chartH - barH;

        // 渐变柱
        const grad = ctx.createLinearGradient(x, y, x, padT + chartH);
        grad.addColorStop(0, color);
        grad.addColorStop(1, color + "33");
        ctx.fillStyle = grad;
        ctx.beginPath();
        const r = Math.min(4, barW / 2);
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + barW - r, y);
        ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
        ctx.lineTo(x + barW, padT + chartH);
        ctx.lineTo(x, padT + chartH);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.fill();

        // 数值
        if (values[i] > 0) {
            ctx.fillStyle = CHART_COLORS.text;
            ctx.font = "bold 11px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(values[i], x + barW / 2, y - 5);
        }

        // X轴标签
        ctx.fillStyle = CHART_COLORS.textDim;
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.save();
        ctx.translate(x + barW / 2, padT + chartH + 10);
        if (label.length > 5) ctx.rotate(-0.4);
        ctx.fillText(label, 0, 8);
        ctx.restore();
    });
}

function drawLineChart(canvasId, data) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const padL = 55, padR = 15, padT = 15, padB = 30;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const values = data.map(d => d.time_ms);
    const maxVal = Math.max(...values, 100);
    const minVal = Math.min(...values, 0);
    const range = maxVal - minVal || 1;

    // 网格
    ctx.strokeStyle = CHART_COLORS.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padT + chartH - (chartH * i / 4);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.fillStyle = CHART_COLORS.textDim;
        ctx.font = "11px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText(Math.round(minVal + range * i / 4) + "ms", padL - 6, y + 4);
    }

    // 折线
    const step = chartW / Math.max(values.length - 1, 1);
    ctx.beginPath();
    values.forEach((v, i) => {
        const x = padL + i * step;
        const y = padT + chartH - ((v - minVal) / range) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = CHART_COLORS.primary;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 面积填充
    const lastX = padL + (values.length - 1) * step;
    ctx.lineTo(lastX, padT + chartH);
    ctx.lineTo(padL, padT + chartH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
    grad.addColorStop(0, CHART_COLORS.primary + "44");
    grad.addColorStop(1, CHART_COLORS.primary + "05");
    ctx.fillStyle = grad;
    ctx.fill();

    // 数据点
    values.forEach((v, i) => {
        const x = padL + i * step;
        const y = padT + chartH - ((v - minVal) / range) * chartH;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = CHART_COLORS.primary;
        ctx.fill();
    });
}

function drawFieldConfChart(canvasId, fieldConf) {
    const labels = [];
    const values = [];
    const colors = [CHART_COLORS.primary, CHART_COLORS.green, CHART_COLORS.amber, CHART_COLORS.red];
    const fieldKeys = ["company", "date", "address", "total"];
    fieldKeys.forEach((fk, i) => {
        const d = fieldConf[fk];
        if (!d) return;
        labels.push(FIELD_NAME_MAP[fk]);
        values.push(d.avg);
    });
    drawGroupedBarChart(canvasId, labels, [
        { label: "平均置信度", values: values, colors: colors }
    ]);
}

function drawGroupedBarChart(canvasId, labels, groups) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const padL = 45, padR = 15, padT = 15, padB = 40;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const maxVal = 1;
    const gap = chartW / labels.length;
    const barW = gap * 0.5;

    // 网格
    ctx.strokeStyle = CHART_COLORS.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padT + chartH - (chartH * i / 4);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.fillStyle = CHART_COLORS.textDim;
        ctx.font = "11px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText((maxVal * i / 4 * 100).toFixed(0) + "%", padL - 6, y + 4);
    }

    labels.forEach((label, i) => {
        const group = groups[0];
        const val = group.values[i] || 0;
        const color = group.colors[i] || CHART_COLORS.primary;
        const barH = (val / maxVal) * chartH;
        const x = padL + i * gap + (gap - barW) / 2;
        const y = padT + chartH - barH;

        const grad = ctx.createLinearGradient(x, y, x, padT + chartH);
        grad.addColorStop(0, color);
        grad.addColorStop(1, color + "33");
        ctx.fillStyle = grad;
        const r = Math.min(4, barW / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + barW - r, y);
        ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
        ctx.lineTo(x + barW, padT + chartH);
        ctx.lineTo(x, padT + chartH);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.fill();

        // 数值
        ctx.fillStyle = CHART_COLORS.text;
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText((val * 100).toFixed(1) + "%", x + barW / 2, y - 6);

        // X 轴标签
        ctx.fillStyle = CHART_COLORS.textDim;
        ctx.font = "12px sans-serif";
        ctx.fillText(label, x + barW / 2, padT + chartH + 20);
    });
}

function drawStatusChart(canvasId, statusDist) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const statusColors = {
        pending: "#918F9A",
        processed: CHART_COLORS.primary,
        approved: CHART_COLORS.green,
        rejected: CHART_COLORS.red,
    };
    const statusLabels = {
        pending: "待处理",
        processed: "已处理",
        approved: "已通过",
        rejected: "已拒绝",
    };

    const entries = Object.entries(statusDist).filter(([k, v]) => v > 0);
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
    const cx = w * 0.35, cy = h / 2, radius = Math.min(cx, cy) - 20;

    // 画饼图
    let startAngle = -Math.PI / 2;
    const slices = [];
    entries.forEach(([status, count]) => {
        const sliceAngle = (count / total) * Math.PI * 2;
        const color = statusColors[status] || CHART_COLORS.textDim;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "rgba(19,19,22,0.5)";
        ctx.lineWidth = 2;
        ctx.stroke();
        slices.push({ status, count, startAngle, sliceAngle, color });
        startAngle += sliceAngle;
    });

    // 中心空白（环形效果）
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = "#201F23";
    ctx.fill();

    // 中心数字
    ctx.fillStyle = CHART_COLORS.text;
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(total, cx, cy - 8);
    ctx.font = "11px sans-serif";
    ctx.fillStyle = CHART_COLORS.textDim;
    ctx.fillText("总计", cx, cy + 12);

    // 右侧图例
    const legendX = w * 0.65;
    let legendY = h * 0.2;
    ctx.textBaseline = "middle";
    slices.forEach(s => {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(legendX, legendY, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = CHART_COLORS.text;
        ctx.font = "13px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(statusLabels[s.status] || s.status, legendX + 16, legendY);

        ctx.fillStyle = CHART_COLORS.textDim;
        ctx.font = "12px sans-serif";
        ctx.fillText(`${s.count} (${(s.count / total * 100).toFixed(1)}%)`, legendX + 16, legendY + 18);

        legendY += 42;
    });
}
