/**
 * main.js: 1秒/10秒モード自動判別・時間軸同期対応版
 */

// --- DOM要素 ---
const statusEl = document.getElementById('status');
const sliderCanvas = document.getElementById('sliderCanvas');
const sliderCtx = sliderCanvas.getContext('2d');
const appGrid = document.getElementById('appGrid');
const fileInput = document.getElementById('fileInput');
const uploadDropZone = document.getElementById('uploadDropZone');
const uploadCtaButton = document.getElementById('uploadCtaButton');
const mainCursorToggle = document.getElementById('mainCursorToggle');
const subCursorToggle = document.getElementById('subCursorToggle');
const mainCursorToggleWrapper = document.getElementById('mainCursorToggleWrapper');
const subCursorToggleWrapper = document.getElementById('subCursorToggleWrapper');
const infoElements = [
    {
        main: document.getElementById('info1Main'),
        sub: document.getElementById('info1Sub')
    },
    {
        main: document.getElementById('info2Main'),
        sub: document.getElementById('info2Sub')
    },
    {
        main: document.getElementById('info3Main'),
        sub: document.getElementById('info3Sub')
    }
];

const charts = [
    { id: 1, cvs: document.getElementById('canvas1'), ctx: null, sel: document.getElementById('sel1') },
    { id: 2, cvs: document.getElementById('canvas2'), ctx: null, sel: document.getElementById('sel2') },
    { id: 3, cvs: document.getElementById('canvas3'), ctx: null, sel: document.getElementById('sel3') }
];
charts.forEach(c => c.ctx = c.cvs.getContext('2d'));

// --- 状態管理 ---
let dataset = null;
let totalIds = 0; // 時間軸上の最大スロット数 (qIdの最大値 + 1)
let headers = [];
let timeMeta = null; // { mode, baseTs, stepMs, idMax }

let viewState = {
    startIndex: 0, // qIdベースの開始位置
    endIndex: 0    // qIdベースの終了位置
};

const cursorDefinitions = [
    { key: 'main', label: 'Main', color: '#d62728', dash: [] },
    { key: 'sub', label: 'Sub', color: '#1f77b4', dash: [4, 3] }
];

const horizontalCursorDefinitions = [
    { key: 'h1', label: 'H1', color: '#444444', dash: [4, 3] },
    { key: 'h2', label: 'H2', color: '#444444', dash: [4, 3] }
];

let cursorState = {
    activeKey: null,
    cursors: {
        main: { enabled: false, index: null }, // 現在のqId
        sub: { enabled: false, index: null }
    }
};
let horizontalCursorState = {};
let cursorDragState = { pending: false, active: false, chartId: null, startX: 0, startY: 0, startId: null };
let cursorBubbleState = {};
let horizontalCursorTagState = {};
let horizontalCursorValueLabelState = {};
let bubbleDragState = { active: false, chart: null, cursorKey: null, grabOffsetX: 0, grabOffsetY: 0 };
let horizontalTagDragState = { active: false, moved: false, chart: null, cursorKey: null, grabOffsetY: 0 };
let horizontalCursorValueInputState = { chart: null, cursorKey: null, input: null, isFinishing: false };
let suppressNextChartClick = false;
let rightClickState = { chartId: null, lastAt: 0, x: 0, y: 0 };
let cursorDebug = { lastIndex: null };
const chartLayouts = {};
let openChartDropdown = null;
let customDropdownDocumentListenersInitialized = false;

let isDrawing = false;
let drawRequestPending = false;
let pendingDrawOptions = null;
let sliderDragState = { active: false, mode: null, dragOffsetPx: 0, dragSpan: 0, dragCenter: null, outsideLogged: false, logDrag: false };
const gripWidth = 9
const sliderMinSpan = 1;
const sliderMinPixel = 30;
const cursorDragThresholdPx = 4;
const cursorMarkerRadius = 4;
const cursorMarkerHitRadius = 8;
const cursorBubbleDefaultOffset = { x: 12, y: -44 };
const horizontalCursorTagRectWidth = 18;
const horizontalCursorTagTriangleWidth = 6;
const horizontalCursorTagHeight = 12;
const rightDoubleClickDelayMs = 400;
const rightDoubleClickMaxDistancePx = 8;

function setStatus(message) {
    if (statusEl) statusEl.innerText = message;
}

function isCsvFile(file) {
    if (!file) return false;
    const name = String(file.name || "").toLowerCase();
    if (name.endsWith(".csv")) return true;
    const type = String(file.type || "").toLowerCase();
    return type === "text/csv" || type === "application/vnd.ms-excel";
}

function setErrorState(message) {
    resetViewState();
    clearCanvases();
    setEmptyState(true);
    if (message) setStatus(message);
}

function setEmptyState(isEmpty) {
    if (!appGrid) return;
    appGrid.classList.toggle('is-empty', isEmpty);
}

function resetViewState() {
    dataset = null;
    timeMeta = null;
    headers = [];
    totalIds = 0;
    viewState.startIndex = 0;
    viewState.endIndex = 0;
    resetCursorPositions();
    resetHorizontalCursorPositions();
    resetCursorDragState();
    clearCursorInfo();
    hideAllCursorBubbles();
    hideAllHorizontalCursorTags();
    hideAllHorizontalCursorValueLabels();
}

function clearCanvases() {
    charts.forEach(chart => {
        chart.ctx.clearRect(0, 0, chart.cvs.width, chart.cvs.height);
    });
    sliderCtx.clearRect(0, 0, sliderCanvas.width, sliderCanvas.height);
}

function startFileLoad(file) {
    if (!file) return;
    if (!isCsvFile(file)) {
        setStatus('Error: CSVファイルのみ対応しています。');
        return;
    }
    setEmptyState(false);
    resetViewState();
    clearCanvases();
    setStatus("Loading: 0%");
    if (!createWorker()) return;
    worker.postMessage({ type: 'loadFile', file });
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function getStepMs() {
    if (timeMeta && Number.isFinite(timeMeta.stepMs)) return timeMeta.stepMs;
    return 1000;
}

function getMinSpanForSlider(span, width) {
    if (!Number.isFinite(span) || span <= 0) return sliderMinSpan;
    if (!Number.isFinite(width) || width <= 0) return sliderMinSpan;
    const pixelSpan = Math.ceil((span * sliderMinPixel) / width);
    return Math.max(sliderMinSpan, pixelSpan);
}

function getSliderMetrics() {
    if (!totalIds || totalIds <= 0) return null;
    const rect = sliderCanvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const span = Math.max(1, totalIds);
    const minSpan = getMinSpanForSlider(span, width);
    const viewStart = clamp(viewState.startIndex, 0, span);
    const viewEnd = clamp(Math.max(viewState.endIndex, viewStart + minSpan), viewStart + minSpan, span);
    const xStart = (viewStart / span) * width;
    const xEnd = (viewEnd / span) * width;
    return { rect, width, height, span, minSpan, viewStart, viewEnd, xStart, xEnd };
}

function enforceSliderMinSpan() {
    if (!totalIds || totalIds <= 0) return;
    const rect = sliderCanvas.getBoundingClientRect();
    const span = Math.max(1, totalIds);
    const minSpan = getMinSpanForSlider(span, rect.width);
    let start = Number.isFinite(viewState.startIndex) ? viewState.startIndex : 0;
    let end = Number.isFinite(viewState.endIndex) ? viewState.endIndex : span;
    start = clamp(start, 0, span);
    end = clamp(end, 0, span);
    if (end - start < minSpan) {
        end = start + minSpan;
        if (end > span) {
            end = span;
            start = Math.max(0, end - minSpan);
        }
    }
    viewState.startIndex = start;
    viewState.endIndex = end;
}

function resetCursorPositions() {
    cursorDefinitions.forEach(cursor => {
        cursorState.cursors[cursor.key].index = null;
        cursorState.cursors[cursor.key].enabled = false;
    });
    cursorState.activeKey = null;
    updateAllCursorToggleDisplays();
}

function createHorizontalCursorGroup() {
    const cursors = {};
    horizontalCursorDefinitions.forEach(cursor => {
        cursors[cursor.key] = { enabled: false, value: null };
    });
    return { cursors };
}

function getHorizontalCursorGroup(chartId) {
    if (!horizontalCursorState[chartId]) {
        horizontalCursorState[chartId] = createHorizontalCursorGroup();
    }
    return horizontalCursorState[chartId];
}

function resetHorizontalCursorPositions() {
    horizontalCursorState = {};
    charts.forEach(chart => {
        getHorizontalCursorGroup(chart.cvs.id);
    });
}

function isHorizontalCursorEnabled(chartId, cursorKey) {
    const group = getHorizontalCursorGroup(chartId);
    return !!(group.cursors[cursorKey] && group.cursors[cursorKey].enabled);
}

function getEnabledHorizontalCursorDefinitions(chartId) {
    const group = getHorizontalCursorGroup(chartId);
    return horizontalCursorDefinitions.filter(cursor => group.cursors[cursor.key] && group.cursors[cursor.key].enabled);
}

function isHorizontalCursorValueInPlot(layout, value) {
    if (!layout || !Number.isFinite(value)) return false;
    const y = layout.yMapping.valueToPixel(value);
    const plotBottom = layout.plot.top + layout.plot.height;
    return Number.isFinite(y) && y >= layout.plot.top && y <= plotBottom;
}

function selectHorizontalCursorForValue(chart, value) {
    const chartId = chart.cvs.id;
    const group = getHorizontalCursorGroup(chartId);
    const emptyCursor = horizontalCursorDefinitions.find(cursor => !group.cursors[cursor.key].enabled);
    if (emptyCursor) return emptyCursor;

    const layout = chartLayouts[chartId];
    let outOfPlotCursor = null;
    let nearestOutOfPlotDistance = Infinity;
    horizontalCursorDefinitions.forEach(cursor => {
        const currentValue = group.cursors[cursor.key].value;
        if (!Number.isFinite(currentValue)) return;
        if (isHorizontalCursorValueInPlot(layout, currentValue)) return;
        const distance = Math.abs(currentValue - value);
        if (distance < nearestOutOfPlotDistance) {
            nearestOutOfPlotDistance = distance;
            outOfPlotCursor = cursor;
        }
    });
    if (outOfPlotCursor) return outOfPlotCursor;

    let nearestCursor = horizontalCursorDefinitions[0];
    let nearestDistance = Infinity;
    horizontalCursorDefinitions.forEach(cursor => {
        const currentValue = group.cursors[cursor.key].value;
        if (!Number.isFinite(currentValue)) return;
        const distance = Math.abs(currentValue - value);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestCursor = cursor;
        }
    });
    return nearestCursor;
}

function isCursorEnabled(cursorKey) {
    return !!(cursorState.cursors[cursorKey] && cursorState.cursors[cursorKey].enabled);
}

function isAnyCursorEnabled() {
    return cursorDefinitions.some(cursor => isCursorEnabled(cursor.key));
}

function getEnabledCursorDefinitions() {
    return cursorDefinitions.filter(cursor => isCursorEnabled(cursor.key));
}

function getCursorToggle(cursorKey) {
    if (cursorKey === 'main') return mainCursorToggle;
    if (cursorKey === 'sub') return subCursorToggle;
    return null;
}

function getCursorToggleWrapper(cursorKey) {
    if (cursorKey === 'main') return mainCursorToggleWrapper;
    if (cursorKey === 'sub') return subCursorToggleWrapper;
    return null;
}

function updateCursorToggleDisplay(cursorKey) {
    const enabled = isCursorEnabled(cursorKey);
    const wrapper = getCursorToggleWrapper(cursorKey);
    if (wrapper) {
        wrapper.classList.toggle('is-cursor-enabled', enabled);
        wrapper.setAttribute('aria-pressed', String(enabled));
    }

    const toggle = getCursorToggle(cursorKey);
    if (toggle) {
        toggle.checked = enabled;
    }
}

function updateAllCursorToggleDisplays() {
    cursorDefinitions.forEach(cursor => updateCursorToggleDisplay(cursor.key));
}

function initializeCursorToggleWrapper(cursorKey) {
    const wrapper = getCursorToggleWrapper(cursorKey);
    if (!wrapper) return;

    wrapper.setAttribute('role', 'button');
    wrapper.setAttribute('tabindex', '0');
    wrapper.setAttribute('aria-label', `${cursorKey === 'main' ? 'Main' : 'Sub'}カーソル表示`);
    updateCursorToggleDisplay(cursorKey);

    wrapper.addEventListener('click', (e) => {
        e.preventDefault();
        setCursorEnabled(cursorKey, !isCursorEnabled(cursorKey));
    });
    wrapper.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        setCursorEnabled(cursorKey, !isCursorEnabled(cursorKey));
    });
}

function getBubbleKey(chartId, cursorKey) {
    return `${chartId}:${cursorKey}`;
}

function getCursorBubbleEntry(chartId, cursorKey) {
    const key = getBubbleKey(chartId, cursorKey);
    if (!cursorBubbleState[key]) {
        cursorBubbleState[key] = {
            visible: false,
            offsetX: cursorBubbleDefaultOffset.x,
            fixedTop: null,
            el: null
        };
    }
    return cursorBubbleState[key];
}

function isChartBubbleMode(chart) {
    return getEnabledCursorDefinitions().some(cursor => {
        return getCursorBubbleEntry(chart.cvs.id, cursor.key).visible;
    });
}

function setChartBubbleMode(chart, enabled) {
    getEnabledCursorDefinitions().forEach(cursor => {
        getCursorBubbleEntry(chart.cvs.id, cursor.key).visible = enabled;
    });
}

function resetCursorDragState() {
    cursorDragState.pending = false;
    cursorDragState.active = false;
    cursorDragState.chartId = null;
    cursorDragState.startX = 0;
    cursorDragState.startY = 0;
    cursorDragState.startId = null;
    cursorState.activeKey = null;
    setCursorBubbleInteractionDisabled(false);
}

function resetBubbleDragState() {
    bubbleDragState.active = false;
    bubbleDragState.chart = null;
    bubbleDragState.cursorKey = null;
    bubbleDragState.grabOffsetX = 0;
    bubbleDragState.grabOffsetY = 0;
}

function resetHorizontalTagDragState() {
    horizontalTagDragState.active = false;
    horizontalTagDragState.moved = false;
    horizontalTagDragState.chart = null;
    horizontalTagDragState.cursorKey = null;
    horizontalTagDragState.grabOffsetY = 0;
}

function resetHorizontalCursorValueInputState(options = {}) {
    const input = horizontalCursorValueInputState.input;
    if (input && input.parentElement) {
        input.parentElement.classList.remove('is-editing');
        input.remove();
    }
    horizontalCursorValueInputState.chart = null;
    horizontalCursorValueInputState.cursorKey = null;
    horizontalCursorValueInputState.input = null;
    horizontalCursorValueInputState.isFinishing = false;
    if (options.redraw) requestDraw();
}

function setCursorBubbleInteractionDisabled(disabled) {
    Object.values(cursorBubbleState).forEach(entry => {
        if (entry.el) entry.el.classList.toggle('is-pointer-disabled', disabled);
    });
}

function initializeCursorPosition(cursorKey) {
    if (!totalIds || totalIds <= 0) return;
    const span = Math.max(1, viewState.endIndex - viewState.startIndex);
    const fallback = cursorKey === 'sub'
        ? viewState.startIndex + span / 4
        : viewState.startIndex + span / 2;
    const currentIndex = cursorState.cursors[cursorKey].index;
    const nextIndex = Number.isFinite(currentIndex) ? currentIndex : fallback;
    cursorState.cursors[cursorKey].index = clamp(nextIndex, 0, totalIds);
}

function setCursorEnabled(cursorKey, enabled, options = {}) {
    const cursor = cursorState.cursors[cursorKey];
    if (!cursor) return;

    cursor.enabled = enabled;
    resetCursorDragState();
    const toggle = getCursorToggle(cursorKey);
    if (toggle) {
        toggle.checked = enabled;
    }
    updateCursorToggleDisplay(cursorKey);

    if (enabled) {
        if (options.resetPositions) {
            cursor.index = null;
        }
        initializeCursorPosition(cursorKey);
        if (Number.isFinite(options.index)) {
            cursor.index = clamp(options.index, 0, totalIds);
        }
        charts.forEach(chart => {
            if (isChartBubbleMode(chart)) {
                getCursorBubbleEntry(chart.cvs.id, cursorKey).visible = true;
            }
        });
        updateCursorDisplay();
    } else {
        hideCursorBubblesForCursor(cursorKey);
        updateCursorDisplay();
    }
    requestDraw();
}

// --- 初期設定 ---
cursorDefinitions.forEach(cursor => initializeCursorToggleWrapper(cursor.key));

if (mainCursorToggle) {
    mainCursorToggle.addEventListener('change', () => {
        setCursorEnabled('main', mainCursorToggle.checked);
    });
}
if (subCursorToggle) {
    subCursorToggle.addEventListener('change', () => {
        setCursorEnabled('sub', subCursorToggle.checked);
    });
}

if (uploadCtaButton && fileInput) {
    uploadCtaButton.addEventListener('click', () => fileInput.click());
}

if (uploadDropZone) {
    ['dragenter', 'dragover'].forEach((eventName) => {
        uploadDropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            uploadDropZone.classList.add('is-dragover');
        });
    });
    ['dragleave', 'dragend', 'drop'].forEach((eventName) => {
        uploadDropZone.addEventListener(eventName, () => {
            uploadDropZone.classList.remove('is-dragover');
        });
    });
    uploadDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) startFileLoad(file);
    });
}

charts.forEach(chart => {
    chart.cvs.addEventListener('mousedown', (e) => handleChartMouseDown(e, chart));
    chart.cvs.addEventListener('click', (e) => handleChartClick(e, chart));
    chart.cvs.addEventListener('dblclick', (e) => handleChartDoubleClick(e, chart));
    chart.cvs.addEventListener('contextmenu', (e) => e.preventDefault());
});


sliderCanvas.addEventListener('mousedown', (e) => {
    resetCursorDragState();
    const metrics = getSliderMetrics();
    if (!metrics) {
        return;
    }
    const x = e.clientX - metrics.rect.left;
    const barW = Math.max(sliderMinPixel, metrics.xEnd - metrics.xStart);
    const visualX2 = metrics.xStart + barW;
    const gripHitWidth = Math.min(gripWidth, barW / 2);
    let mode = null;
    const leftGrip = (x >= metrics.xStart && x <= metrics.xStart + gripHitWidth);
    const rightGrip = (x >= visualX2 - gripHitWidth && x <= visualX2);
    if (leftGrip && rightGrip) {
        mode = (Math.abs(x - metrics.xStart) < Math.abs(x - visualX2)) ? 'left' : 'right';
    } else if (leftGrip) {
        mode = 'left';
    } else if (rightGrip) {
        mode = 'right';
    } else if (x > metrics.xStart && x < visualX2) {
        mode = 'pan';
    } else {
        return;
    }
    sliderDragState.active = true;
    sliderDragState.mode = mode;
    sliderDragState.dragOffsetPx = Math.max(0, x - metrics.xStart);
    sliderDragState.dragSpan = Math.max(metrics.minSpan, viewState.endIndex - viewState.startIndex);
    sliderDragState.dragCenter = (viewState.startIndex + viewState.endIndex) / 2;
    sliderDragState.outsideLogged = false;
});
sliderCanvas.addEventListener('mousemove', (e) => {
    if (sliderDragState.active) return;
    const metrics = getSliderMetrics();
    if (!metrics) {
        sliderCanvas.style.cursor = 'default';
        return;
    }
    const x = e.clientX - metrics.rect.left;
    const barW = Math.max(sliderMinPixel, metrics.xEnd - metrics.xStart);
    const visualX2 = metrics.xStart + barW;
    const gripHitWidth = Math.min(gripWidth, barW / 2);
    const leftGrip = (x >= metrics.xStart && x <= metrics.xStart + gripHitWidth);
    const rightGrip = (x >= visualX2 - gripHitWidth && x <= visualX2);

    if (leftGrip) {
        sliderCanvas.style.cursor = 'w-resize';
    } else if (rightGrip) {
        sliderCanvas.style.cursor = 'e-resize';
    } else if (x > metrics.xStart && x < visualX2) {
        sliderCanvas.style.cursor = 'grab';
    } else {
        sliderCanvas.style.cursor = 'default';
    }
});
sliderCanvas.addEventListener('mouseup', (e) => {
    sliderDragState.active = false;
    sliderDragState.mode = null;
});
sliderCanvas.addEventListener('mouseleave', (e) => {
    if (!sliderDragState.active) {
        sliderDragState.mode = null;
    }
});

function calculateResizeRange(rawX, metrics) {
    const id = (rawX / metrics.width) * metrics.span;
    const center = Number.isFinite(sliderDragState.dragCenter)
        ? sliderDragState.dragCenter
        : (viewState.startIndex + viewState.endIndex) / 2;
    const minHalf = metrics.minSpan / 2;
    const half = Math.max(Math.abs(id - center), minHalf);
    let start = center - half;
    let end = center + half;
    if (start < 0) start = 0;
    if (end > metrics.span) end = metrics.span;
    if (end - start < metrics.minSpan) {
        if (start === 0) end = Math.min(metrics.span, start + metrics.minSpan);
        else if (end === metrics.span) start = Math.max(0, end - metrics.minSpan);
    }
    return { start, end };
}

function calculatePanRange(x, metrics) {
    const viewSpan = sliderDragState.dragSpan;
    const startPx = clamp(x - sliderDragState.dragOffsetPx, 0, metrics.width);
    const idStart = Math.round((startPx / metrics.width) * metrics.span);
    const start = clamp(idStart, 0, Math.max(0, totalIds - viewSpan));
    const end = clamp(start + viewSpan, start + metrics.minSpan, totalIds);
    return { start, end };
}

window.addEventListener('mousemove', (e) => {
    if (horizontalTagDragState.active) {
        handleHorizontalTagDragMove(e);
        return;
    }
    if (bubbleDragState.active) {
        handleBubbleDragMove(e);
        return;
    }
    if (cursorDragState.pending || cursorDragState.active) {
        handleCursorDragMove(e);
        return;
    }
    if (!sliderDragState.active || !sliderDragState.mode) return;
    const metrics = getSliderMetrics();
    if (!metrics) return;
    const outside = e.clientX < metrics.rect.left
        || e.clientX > metrics.rect.right
        || e.clientY < metrics.rect.top
        || e.clientY > metrics.rect.bottom;
    if (outside && !sliderDragState.outsideLogged) {
        sliderDragState.outsideLogged = true;
    }
    const rawX = e.clientX - metrics.rect.left;
    const x = clamp(rawX, 0, metrics.width);
    let newStart = viewState.startIndex;
    let newEnd = viewState.endIndex;
    if (sliderDragState.mode === 'left' || sliderDragState.mode === 'right') {
        const range = calculateResizeRange(rawX, metrics);
        newStart = range.start;
        newEnd = range.end;
    } else if (sliderDragState.mode === 'pan') {
        const range = calculatePanRange(x, metrics);
        newStart = range.start;
        newEnd = range.end;
    }
    if (newStart !== viewState.startIndex || newEnd !== viewState.endIndex) {
        viewState.startIndex = newStart;
        viewState.endIndex = newEnd;
        requestDraw();
    }
});
window.addEventListener('mouseup', () => {
    resetHorizontalTagDragState();
    resetBubbleDragState();
    resetCursorDragState();
    if (!sliderDragState.active) return;
    sliderDragState.active = false;
    sliderDragState.mode = null;
});

// --- 時間・座標計算ロジック ---

function getTimestampFromQId(qId) {
    if (!timeMeta) return Date.now();
    return timeMeta.baseTs + (qId * timeMeta.stepMs);
}

function getQIdFromTimestamp(ts) {
    if (!timeMeta) return 0;
    return (ts - timeMeta.baseTs) / timeMeta.stepMs;
}

function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('ja-JP');
}

function formatDate(ts) {
    return new Date(ts).toLocaleDateString('ja-JP');
}

const TICK_STEP_MS = [
    1000,
    2000,
    5000,
    10000,
    15000,
    30000,
    60000,
    120000,
    300000,
    600000,
    900000,
    1800000,
    3600000,
    7200000,
    10800000,
    21600000,
    43200000,
    86400000
];
const MAJOR_TICK_TARGET_PX = 100;
const MIN_LABEL_PX = 70;

function chooseMajorStepMs(viewSpanMs, plotWidth) {
    if (!Number.isFinite(viewSpanMs) || viewSpanMs <= 0) return 60000;
    const maxTicks = Math.max(1, Math.floor(plotWidth / MAJOR_TICK_TARGET_PX));
    const desired = viewSpanMs / maxTicks;
    for (const step of TICK_STEP_MS) {
        if (step >= desired) return step;
    }
    return TICK_STEP_MS[TICK_STEP_MS.length - 1];
}

function chooseMinorStepMs(majorStepMs) {
    if (!Number.isFinite(majorStepMs) || majorStepMs <= 0) return null;
    return majorStepMs / 2;
}

function formatTickTime(ts, stepMs) {
    return new Date(ts).toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// --- メモリデータセット操作 ---

function lowerBound(array, value, length = array.length) {
    let low = 0;
    let high = length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (array[mid] < value) low = mid + 1;
        else high = mid;
    }
    return low;
}

function upperBound(array, value, length = array.length) {
    let low = 0;
    let high = length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (array[mid] <= value) low = mid + 1;
        else high = mid;
    }
    return low;
}

function getRangeSlice(startQId, endQId) {
    if (!dataset || !dataset.qIds || dataset.rowCount <= 0) {
        return { startRow: 0, endRow: 0, length: 0 };
    }
    const rangeStart = Math.min(startQId, endQId);
    const rangeEnd = Math.max(startQId, endQId);
    const startRow = lowerBound(dataset.qIds, rangeStart, dataset.rowCount);
    const endRow = upperBound(dataset.qIds, rangeEnd, dataset.rowCount);
    return { startRow, endRow, length: Math.max(0, endRow - startRow) };
}

function getNearestRow(targetQId) {
    if (!dataset || !dataset.qIds || dataset.rowCount <= 0) return null;
    const right = lowerBound(dataset.qIds, targetQId, dataset.rowCount);
    const left = right - 1;
    if (left < 0 && right >= dataset.rowCount) return null;
    if (left < 0) return right;
    if (right >= dataset.rowCount) return left;
    return Math.abs(dataset.qIds[left] - targetQId) <= Math.abs(dataset.qIds[right] - targetQId)
        ? left
        : right;
}

function getValueAt(rowIndex, field) {
    if (!dataset || !dataset.columns || !dataset.columns[field]) return NaN;
    return dataset.columns[field][rowIndex];
}

// --- 描画ロジック ---

function normalizeDrawChartsOption(chartsOption) {
    if (!chartsOption) return null;
    return Array.isArray(chartsOption) ? chartsOption : [chartsOption];
}

function mergePendingDrawOptions(prev, next) {
    const merged = { ...(prev || {}) };

    const prevCharts = normalizeDrawChartsOption(prev && prev.charts);
    const nextCharts = normalizeDrawChartsOption(next && next.charts);

    if (!prevCharts || !nextCharts) {
        merged.charts = undefined;
    } else {
        const seen = new Set();
        const union = [];
        [...prevCharts, ...nextCharts].forEach(c => {
            if (c && !seen.has(c.cvs.id)) {
                seen.add(c.cvs.id);
                union.push(c);
            }
        });
        merged.charts = union;
    }

    merged.skipSlider = !!(prev && prev.skipSlider) && !!next.skipSlider;
    return merged;
}

function requestDraw(options = {}) {
    if (isDrawing) {
        drawRequestPending = true;
        pendingDrawOptions = mergePendingDrawOptions(pendingDrawOptions, options);
        return;
    }
    isDrawing = true;
    drawRequestPending = false;
    pendingDrawOptions = null;

    const targetCharts = options.charts
        ? (Array.isArray(options.charts) ? options.charts : [options.charts])
        : charts;
    const skipSlider = !!options.skipSlider;

    requestAnimationFrame(async () => {
        if (!skipSlider) {
            enforceSliderMinSpan();
        }
        await drawCharts(targetCharts);
        if (!skipSlider) {
            drawSlider();
        }
        isDrawing = false;
        if (drawRequestPending) {
            const opts = pendingDrawOptions || {};
            pendingDrawOptions = null;
            drawRequestPending = false;
            requestDraw(opts);
        }
    });
}

async function drawCharts(targetCharts = charts) {
    if (!dataset || totalIds === 0) return;

    const rangeStart = viewState.startIndex;
    const rangeEnd = viewState.endIndex;
    const range = getRangeSlice(rangeStart, rangeEnd);

    // セグメントモデルの構築 (qIdを物理的なIDの代わりに使用)
    const segmentModel = buildSegmentModel(range, rangeStart, rangeEnd);

    const chartsToDraw = Array.isArray(targetCharts) ? targetCharts : [targetCharts];
    chartsToDraw.forEach(c => {
        const layout = prepareLayout(c, range, segmentModel);
        chartLayouts[c.cvs.id] = layout;
        renderChart(c, range, layout);
    });
}

async function drawAllCharts() {
    return drawCharts(charts);
}

function buildSegmentModel(range, startQId, endQId) {
    const segments = [];
    
    let currentQ = Math.floor(startQId);
    const limitQ = Math.ceil(endQId);

    if (!range || range.length === 0) {
        segments.push({ type: 'gap', idStart: currentQ, idEnd: limitQ, length: limitQ - currentQ });
        return { segments, totalDataSpan: 0, gapCount: 1, startId: currentQ, endId: limitQ };
    }

    let totalDataSpan = 0;
    let gapCount = 0;

    for (let row = range.startRow; row < range.endRow; row++) {
        const qId = dataset.qIds[row];
        if (qId > currentQ) {
            segments.push({ type: 'gap', idStart: currentQ, idEnd: qId - 1, length: qId - currentQ });
            gapCount++;
        }
        segments.push({ type: 'data', idStart: qId, idEnd: qId, length: 1 });
        totalDataSpan += 1;
        currentQ = qId + 1;
    }

    if (currentQ <= limitQ) {
        segments.push({ type: 'gap', idStart: currentQ, idEnd: limitQ, length: limitQ - currentQ + 1 });
        gapCount++;
    }

    return { segments, totalDataSpan, gapCount, startId: Math.floor(startQId), endId: limitQ };
}

// --- ユーティリティ・リサイズ ---

function resizeAll() {
    const dpr = window.devicePixelRatio || 1;
    [...charts, {cvs: sliderCanvas, ctx: sliderCtx}].forEach(obj => {
        const rect = obj.cvs.parentElement.getBoundingClientRect();
        obj.cvs.width = rect.width * dpr;
        obj.cvs.height = rect.height * dpr;
        obj.cvs.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    requestDraw();
    if (openChartDropdown) {
        updateChartFieldDropdownPlacement(openChartDropdown);
    }
}
window.addEventListener('resize', resizeAll);

// --- インタラクション ---

function getChartByCanvasId(chartId) {
    return charts.find(c => c.cvs.id === chartId) || null;
}

function getCursorHitFromMouse(e, chart, requirePlotArea = false) {
    const layout = chartLayouts[chart.cvs.id];
    if (!layout) {
        return null;
    }

    const rect = chart.cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const plotLeft = layout.plot ? layout.plot.left : 0;
    const plotRight = layout.plot ? (layout.plot.left + layout.plot.width) : rect.width;
    const plotTop = layout.plot ? layout.plot.top : 0;
    const plotBottom = layout.plot ? (layout.plot.top + layout.plot.height) : rect.height;
    const inPlotArea = x >= plotLeft && x <= plotRight && y >= plotTop && y <= plotBottom;
    if (requirePlotArea && !inPlotArea) {
        return null;
    }
    const clampedX = Math.min(plotRight, Math.max(plotLeft, x));
    return { id: layout.xMapping.pixelToId(clampedX).id, inPlotArea };
}

function getCursorIdFromMouse(e, chart) {
    const hit = getCursorHitFromMouse(e, chart);
    return hit ? hit.id : null;
}

function getHorizontalCursorAxisHitFromMouse(e, chart) {
    const layout = chartLayouts[chart.cvs.id];
    if (!layout) return null;

    const rect = chart.cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const plot = layout.plot;
    const inYAxisLabelArea = x >= 0 && x < plot.left && y >= plot.top && y <= plot.top + plot.height;
    if (!inYAxisLabelArea) return null;

    return { value: layout.yMapping.pixelToValue(y) };
}

function getHorizontalCursorValueRange(chart) {
    const layout = chartLayouts[chart.cvs.id];
    if (!layout || !Number.isFinite(layout.dataMin) || !Number.isFinite(layout.dataMax)) {
        return null;
    }
    return {
        min: Math.min(layout.dataMin, layout.dataMax),
        max: Math.max(layout.dataMin, layout.dataMax)
    };
}

function clampHorizontalCursorValue(chart, value) {
    if (!Number.isFinite(value)) return NaN;
    const range = getHorizontalCursorValueRange(chart);
    if (!range) return NaN;
    return clamp(value, range.min, range.max);
}

function setHorizontalCursorValue(chart, cursorKey, value) {
    if (!Number.isFinite(value)) return;
    const group = getHorizontalCursorGroup(chart.cvs.id);
    if (!group.cursors[cursorKey]) return;
    const nextValue = clampHorizontalCursorValue(chart, value);
    if (!Number.isFinite(nextValue)) return;

    group.cursors[cursorKey].enabled = true;
    group.cursors[cursorKey].value = nextValue;
    requestDraw();
}

function addOrMoveHorizontalCursor(chart, value) {
    const cursor = selectHorizontalCursorForValue(chart, value);
    if (!cursor) return;
    setHorizontalCursorValue(chart, cursor.key, value);
}

function removeHorizontalCursor(chart, cursorKey) {
    if (isHorizontalCursorValueInputActive(chart.cvs.id, cursorKey)) {
        resetHorizontalCursorValueInputState({ redraw: true });
    }
    const group = getHorizontalCursorGroup(chart.cvs.id);
    const cursor = group.cursors[cursorKey];
    if (!cursor) return;

    cursor.enabled = false;
    cursor.value = null;
    const tag = getHorizontalCursorTagEntry(chart.cvs.id, cursorKey);
    if (tag.el) tag.el.classList.remove('is-visible');
    const valueLabel = getHorizontalCursorValueLabelEntry(chart.cvs.id, cursorKey);
    if (valueLabel.el) valueLabel.el.classList.remove('is-visible');
    requestDraw();
}

function selectNearestCursor(id) {
    const candidates = getEnabledCursorDefinitions();
    if (candidates.length === 0) return null;
    let nearestKey = candidates[0].key;
    let nearestDistance = Infinity;
    candidates.forEach(cursor => {
        const cursorIndex = cursorState.cursors[cursor.key].index;
        if (!Number.isFinite(cursorIndex)) return;
        const distance = Math.abs(cursorIndex - id);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestKey = cursor.key;
        }
    });
    return nearestKey;
}

function getClickedCursorMarker(e, chart) {
    if (!isAnyCursorEnabled()) return null;
    const layout = chartLayouts[chart.cvs.id];
    if (!layout) return null;

    const rect = chart.cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let clickedCursor = null;
    let nearestDistance = Infinity;

    getEnabledCursorDefinitions().forEach(cursor => {
        const marker = getCursorMarkerPosition(cursor, layout, chart.sel.value);
        if (!marker) return;
        const dx = x - marker.x;
        const dy = y - marker.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= cursorMarkerHitRadius && distance < nearestDistance) {
            nearestDistance = distance;
            clickedCursor = cursor;
        }
    });

    return clickedCursor;
}

function handleChartClick(e, chart) {
    if (suppressNextChartClick) {
        suppressNextChartClick = false;
        return;
    }
    if (cursorDragState.active) return;
    const cursor = getClickedCursorMarker(e, chart);
    if (!cursor) return;

    const entry = getCursorBubbleEntry(chart.cvs.id, cursor.key);
    const nextVisible = !entry.visible;
    setChartBubbleMode(chart, nextVisible);
    updateCursorBubblesForChart(chart);
}

function handleChartMouseDown(e, chart) {
    if (e.button === 2) {
        handleChartRightMouseDown(e, chart);
        return;
    }
    if (!isAnyCursorEnabled() || sliderDragState.active || e.button !== 0) {
        return;
    }
    if (getClickedCursorMarker(e, chart)) {
        return;
    }
    getEnabledCursorDefinitions().forEach(cursor => initializeCursorPosition(cursor.key));
    const hit = getCursorHitFromMouse(e, chart, true);
    if (!hit || !Number.isFinite(hit.id)) {
        return;
    }
    cursorDragState.pending = true;
    cursorDragState.active = false;
    cursorDragState.chartId = chart.cvs.id;
    cursorDragState.startX = e.clientX;
    cursorDragState.startY = e.clientY;
    cursorDragState.startId = hit.id;
    setCursorBubbleInteractionDisabled(true);
}

function handleChartDoubleClick(e, chart) {
    const axisHit = getHorizontalCursorAxisHitFromMouse(e, chart);
    if (axisHit && Number.isFinite(axisHit.value)) {
        e.preventDefault();
        addOrMoveHorizontalCursor(chart, axisHit.value);
        return;
    }

    if (getClickedCursorMarker(e, chart)) {
        return;
    }
    const hit = getCursorHitFromMouse(e, chart, true);
    if (!hit || !Number.isFinite(hit.id)) {
        return;
    }
    resetCursorDragState();
    if (isCursorEnabled('main')) {
        setCursorEnabled('main', false);
    } else {
        setCursorEnabled('main', true, { index: hit.id, resetPositions: true });
    }
}

function handleChartRightMouseDown(e, chart) {
    e.preventDefault();
    const hit = getCursorHitFromMouse(e, chart, true);
    if (!hit || !Number.isFinite(hit.id)) {
        return;
    }
    const now = Date.now();
    const dx = e.clientX - rightClickState.x;
    const dy = e.clientY - rightClickState.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const isDoubleRightClick = rightClickState.chartId === chart.cvs.id
        && now - rightClickState.lastAt <= rightDoubleClickDelayMs
        && distance <= rightDoubleClickMaxDistancePx;

    rightClickState.chartId = chart.cvs.id;
    rightClickState.lastAt = now;
    rightClickState.x = e.clientX;
    rightClickState.y = e.clientY;

    if (!isDoubleRightClick) {
        return;
    }

    resetCursorDragState();
    if (isCursorEnabled('sub')) {
        setCursorEnabled('sub', false);
    } else {
        setCursorEnabled('sub', true, { index: hit.id, resetPositions: true });
    }
    rightClickState.lastAt = 0;
}

function handleCursorDragMove(e) {
    if (!isAnyCursorEnabled()) {
        resetCursorDragState();
        return;
    }
    if (sliderDragState.active) {
        return;
    }
    if (!(e.buttons & 1)) {
        resetCursorDragState();
        return;
    }

    const chart = getChartByCanvasId(cursorDragState.chartId);
    if (!chart) {
        return;
    }

    const hit = getCursorHitFromMouse(e, chart);
    if (!hit || !Number.isFinite(hit.id)) {
        return;
    }

    if (!cursorDragState.active) {
        if (!cursorDragState.pending) {
            return;
        }
        const dx = e.clientX - cursorDragState.startX;
        const dy = e.clientY - cursorDragState.startY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < cursorDragThresholdPx) {
            return;
        }
        cursorState.activeKey = selectNearestCursor(cursorDragState.startId);
        cursorDragState.active = true;
    }

    if (!cursorState.activeKey) {
        return;
    }

    suppressNextChartClick = true;
    cursorState.cursors[cursorState.activeKey].index = hit.id;
    cursorDebug.lastIndex = hit.id;
    updateCursorDisplay();
    requestDraw();
}

function getCursorDisplayValue(cursor, field) {
    const index = cursorState.cursors[cursor.key].index;
    if (!isCursorEnabled(cursor.key) || !Number.isFinite(index)) {
        return "";
    }

    const ts = getTimestampFromQId(index);
    const timeStr = formatTime(ts);
    const rowIndex = getNearestRow(index);
    const value = Number.isInteger(rowIndex) ? getValueAt(rowIndex, field) : NaN;
    const val = formatCursorNumericValue(value);
    return `${timeStr} / ${val}`;
}

function getCursorValueInfo(cursor, field) {
    if (!isCursorEnabled(cursor.key)) return null;
    const index = cursorState.cursors[cursor.key].index;
    if (!Number.isFinite(index)) return null;

    const ts = getTimestampFromQId(index);
    const rowIndex = getNearestRow(index);
    const value = Number.isInteger(rowIndex) ? getValueAt(rowIndex, field) : NaN;
    if (!Number.isFinite(ts) || !Number.isFinite(value)) return null;

    return {
        time: formatTime(ts),
        value
    };
}

function updateCursorDisplay(targetChart = null) {
    const visibleCursors = getEnabledCursorDefinitions();
    if (visibleCursors.length === 0) {
        if (targetChart) {
            const i = charts.indexOf(targetChart);
            if (i >= 0 && infoElements[i]) {
                cursorDefinitions.forEach(cursor => {
                    const el = infoElements[i][cursor.key];
                    if (el) el.innerHTML = "";
                });
            }
        } else {
            clearCursorInfo();
        }
        return;
    }

    const chartsToUpdate = targetChart ? [targetChart] : charts;
    chartsToUpdate.forEach(chart => {
        const i = charts.indexOf(chart);
        if (i < 0) return;
        cursorDefinitions.forEach(cursor => {
            const el = infoElements[i] && infoElements[i][cursor.key];
            if (!el) return;
            if (!isCursorEnabled(cursor.key)) {
                el.innerHTML = "";
                return;
            }
            const valueText = getCursorDisplayValue(cursor, chart.sel.value);
            el.innerHTML = valueText
                ? `<span class="cursor-info-marker cursor-info-marker-${cursor.key}"></span><span>${valueText}</span>`
                : "";
        });
    });
}

function clearCursorInfo() {
    infoElements.forEach(group => {
        Object.values(group).forEach(el => {
            if (el) el.innerHTML = "";
        });
    });
}

function hideAllCursorBubbles() {
    Object.values(cursorBubbleState).forEach(entry => {
        entry.visible = false;
        if (entry.el) entry.el.classList.remove('is-visible');
    });
    charts.forEach(chart => syncChartInfoVisibility(chart));
}

function hideCursorBubblesForCursor(cursorKey) {
    charts.forEach(chart => {
        const entry = getCursorBubbleEntry(chart.cvs.id, cursorKey);
        entry.visible = false;
        if (entry.el) entry.el.classList.remove('is-visible');
        syncChartInfoVisibility(chart);
    });
}

function getHorizontalCursorTagKey(chartId, cursorKey) {
    return `${chartId}:${cursorKey}`;
}

function getHorizontalCursorTagEntry(chartId, cursorKey) {
    const key = getHorizontalCursorTagKey(chartId, cursorKey);
    if (!horizontalCursorTagState[key]) {
        horizontalCursorTagState[key] = { el: null };
    }
    return horizontalCursorTagState[key];
}

function hideAllHorizontalCursorTags() {
    Object.values(horizontalCursorTagState).forEach(entry => {
        if (entry.el) entry.el.classList.remove('is-visible');
    });
}

function getHorizontalCursorValueLabelKey(chartId, cursorKey) {
    return `${chartId}:${cursorKey}`;
}

function getHorizontalCursorValueLabelEntry(chartId, cursorKey) {
    const key = getHorizontalCursorValueLabelKey(chartId, cursorKey);
    if (!horizontalCursorValueLabelState[key]) {
        horizontalCursorValueLabelState[key] = { el: null };
    }
    return horizontalCursorValueLabelState[key];
}

function hideAllHorizontalCursorValueLabels() {
    resetHorizontalCursorValueInputState();
    Object.values(horizontalCursorValueLabelState).forEach(entry => {
        if (entry.el) entry.el.classList.remove('is-visible');
    });
}

function formatCursorNumericValue(value) {
    return Number.isFinite(value) ? String(value) : "N/A";
}

function formatHorizontalCursorValue(value) {
    if (!Number.isFinite(value)) return "N/A";
    const rounded = Math.round((value + Number.EPSILON) * 1000) / 1000;
    return Object.is(rounded, -0) ? "0" : rounded.toLocaleString('ja-JP', {
        useGrouping: false,
        maximumFractionDigits: 3
    });
}

function parseHorizontalCursorValueInput(value) {
    const normalized = String(value || "").trim().replace(/,/g, "");
    if (normalized === "") return NaN;
    return Number(normalized);
}

function isHorizontalCursorValueInputActive(chartId, cursorKey) {
    const activeChart = horizontalCursorValueInputState.chart;
    return !!horizontalCursorValueInputState.input
        && activeChart
        && activeChart.cvs.id === chartId
        && horizontalCursorValueInputState.cursorKey === cursorKey;
}

function finishHorizontalCursorValueInput(commit) {
    const active = horizontalCursorValueInputState;
    if (!active.input || active.isFinishing) return;

    active.isFinishing = true;
    const chart = active.chart;
    const cursorKey = active.cursorKey;
    const input = active.input;
    const nextValue = parseHorizontalCursorValueInput(input.value);
    const parent = input.parentElement;

    horizontalCursorValueInputState = { chart: null, cursorKey: null, input: null, isFinishing: false };
    if (parent) parent.classList.remove('is-editing');
    input.remove();

    if (commit && chart && cursorKey && Number.isFinite(nextValue)) {
        setHorizontalCursorValue(chart, cursorKey, nextValue);
    } else {
        requestDraw();
    }
}

function ensureHorizontalCursorValueLabelElement(chart, cursor) {
    const entry = getHorizontalCursorValueLabelEntry(chart.cvs.id, cursor.key);
    if (entry.el) return entry.el;

    const body = chart.cvs.parentElement;
    const el = document.createElement('div');
    el.className = 'horizontal-cursor-value-label';
    el.dataset.chartId = chart.cvs.id;
    el.dataset.cursorKey = cursor.key;
    el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startHorizontalCursorValueInput(chart, cursor);
    });
    el.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
    body.appendChild(el);
    entry.el = el;
    return el;
}

function startHorizontalCursorValueInput(chart, cursor) {
    const group = getHorizontalCursorGroup(chart.cvs.id);
    const state = group.cursors[cursor.key];
    const range = getHorizontalCursorValueRange(chart);
    if (!state || !state.enabled || !Number.isFinite(state.value) || !range) return;

    if (horizontalCursorValueInputState.input) {
        finishHorizontalCursorValueInput(true);
    }

    const el = ensureHorizontalCursorValueLabelElement(chart, cursor);
    el.classList.add('is-editing');
    el.textContent = "";

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'horizontal-cursor-value-input';
    input.value = formatHorizontalCursorValue(state.value);
    input.inputMode = 'decimal';
    input.title = `${formatHorizontalCursorValue(range.min)} - ${formatHorizontalCursorValue(range.max)}`;
    input.style.color = cursor.color;
    input.style.caretColor = cursor.color;
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finishHorizontalCursorValueInput(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            finishHorizontalCursorValueInput(false);
        }
    });
    input.addEventListener('blur', () => finishHorizontalCursorValueInput(true));

    el.appendChild(input);
    horizontalCursorValueInputState = { chart, cursorKey: cursor.key, input, isFinishing: false };
    resetHorizontalTagDragState();
    resetCursorDragState();
    requestDraw();
    setTimeout(() => {
        if (horizontalCursorValueInputState.input !== input || !input.isConnected) return;
        input.focus();
        input.select();
    }, 0);
}

function getHorizontalCursorValueLabelWidth(chart, valueText) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '11px sans-serif';
    const width = Math.ceil(ctx.measureText(valueText).width) + 8;
    ctx.restore();
    return Math.max(48, width);
}

function updateHorizontalCursorValueLabelsForChart(chart) {
    const layout = chartLayouts[chart.cvs.id];
    const group = getHorizontalCursorGroup(chart.cvs.id);

    horizontalCursorDefinitions.forEach(cursor => {
        const el = ensureHorizontalCursorValueLabelElement(chart, cursor);
        const state = group.cursors[cursor.key];
        if (!layout || !state || !state.enabled || !Number.isFinite(state.value)) {
            if (isHorizontalCursorValueInputActive(chart.cvs.id, cursor.key)) {
                resetHorizontalCursorValueInputState();
            }
            el.classList.remove('is-visible');
            return;
        }

        const y = layout.yMapping.valueToPixel(state.value);
        const plotBottom = layout.plot.top + layout.plot.height;
        if (!Number.isFinite(y) || y < layout.plot.top || y > plotBottom) {
            if (isHorizontalCursorValueInputActive(chart.cvs.id, cursor.key)) {
                resetHorizontalCursorValueInputState();
            }
            el.classList.remove('is-visible');
            return;
        }

        const valueText = formatHorizontalCursorValue(state.value);
        const labelHeight = 14;
        const labelWidth = getHorizontalCursorValueLabelWidth(chart, valueText);
        const yLine = layout.snap(y, 0.5);
        const left = layout.plot.left + horizontalCursorTagTriangleWidth + 4;
        const top = yLine - labelHeight ;
        el.style.setProperty('--horizontal-cursor-value-color', cursor.color);
        if (!isHorizontalCursorValueInputActive(chart.cvs.id, cursor.key)) {
            el.textContent = valueText;
        }
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.width = `${labelWidth}px`;
        el.style.height = `${labelHeight}px`;
        el.setAttribute('aria-label', `横カーソル値 ${valueText}`);
        el.classList.add('is-visible');
    });
}

function ensureHorizontalCursorTagElement(chart, cursor) {
    const entry = getHorizontalCursorTagEntry(chart.cvs.id, cursor.key);
    if (entry.el) return entry.el;

    const body = chart.cvs.parentElement;
    const el = document.createElement('div');
    el.className = `horizontal-cursor-tag horizontal-cursor-tag-${cursor.key}`;
    el.dataset.chartId = chart.cvs.id;
    el.dataset.cursorKey = cursor.key;
    el.style.setProperty('--horizontal-cursor-color', cursor.color);
    el.addEventListener('mousedown', (e) => handleHorizontalTagMouseDown(e, chart, cursor));
    el.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeHorizontalCursor(chart, cursor.key);
    });
    body.appendChild(el);
    entry.el = el;
    return el;
}

function handleHorizontalTagMouseDown(e, chart, cursor) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const entry = getHorizontalCursorTagEntry(chart.cvs.id, cursor.key);
    if (!entry.el) return;

    const rect = chart.cvs.parentElement.getBoundingClientRect();
    const tagTop = parseFloat(entry.el.style.top) || 0;
    const pointerY = e.clientY - rect.top;
    if (isHorizontalCursorValueInputActive(chart.cvs.id, cursor.key)) {
        resetHorizontalCursorValueInputState({ redraw: true });
    }
    horizontalTagDragState.active = true;
    horizontalTagDragState.moved = false;
    horizontalTagDragState.chart = chart;
    horizontalTagDragState.cursorKey = cursor.key;
    horizontalTagDragState.grabOffsetY = pointerY - tagTop;
    resetCursorDragState();
}

function handleHorizontalTagDragMove(e) {
    const chart = horizontalTagDragState.chart;
    const cursor = horizontalCursorDefinitions.find(item => item.key === horizontalTagDragState.cursorKey);
    if (!chart || !cursor) return;

    const layout = chartLayouts[chart.cvs.id];
    const group = getHorizontalCursorGroup(chart.cvs.id);
    const state = group.cursors[cursor.key];
    const entry = getHorizontalCursorTagEntry(chart.cvs.id, cursor.key);
    if (!layout || !state || !entry.el) return;

    const body = chart.cvs.parentElement;
    const rect = body.getBoundingClientRect();
    const tagHeight = entry.el.offsetHeight || 0;
    const pointerY = e.clientY - rect.top;
    const plotBottom = layout.plot.top + layout.plot.height;
    const desiredTop = pointerY - horizontalTagDragState.grabOffsetY;
    const valueY = clamp(desiredTop + tagHeight / 2, layout.plot.top, plotBottom);
    const nextValue = clampHorizontalCursorValue(chart, layout.yMapping.pixelToValue(valueY));
    if (!Number.isFinite(nextValue)) return;
    const clampedY = clamp(layout.yMapping.valueToPixel(nextValue), layout.plot.top, plotBottom);
    const top = clampedY - tagHeight / 2;

    horizontalTagDragState.moved = true;
    state.enabled = true;
    state.value = nextValue;
    entry.el.style.top = `${top}px`;
    requestDraw();
}

function updateHorizontalCursorTagsForChart(chart) {
    const layout = chartLayouts[chart.cvs.id];
    const group = getHorizontalCursorGroup(chart.cvs.id);

    horizontalCursorDefinitions.forEach(cursor => {
        const el = ensureHorizontalCursorTagElement(chart, cursor);
        const state = group.cursors[cursor.key];
        if (!layout || !state || !state.enabled || !Number.isFinite(state.value)) {
            el.classList.remove('is-visible');
            return;
        }

        const y = layout.yMapping.valueToPixel(state.value);
        const plotBottom = layout.plot.top + layout.plot.height;
        if (!Number.isFinite(y) || y < layout.plot.top || y > plotBottom) {
            el.classList.remove('is-visible');
            return;
        }

        const tagWidth = horizontalCursorTagRectWidth + horizontalCursorTagTriangleWidth;
        el.style.setProperty('--horizontal-cursor-color', cursor.color);
        el.style.setProperty('--horizontal-cursor-tag-label-width', `${horizontalCursorTagRectWidth}px`);
        el.style.setProperty('--horizontal-cursor-tag-triangle-width', `${horizontalCursorTagTriangleWidth}px`);
        el.textContent = "";
        el.classList.add('is-visible');

        const tagHeight = el.offsetHeight || 0;
        const left = clamp(layout.plot.left - horizontalCursorTagRectWidth, 0, Math.max(0, chart.cvs.parentElement.clientWidth - tagWidth));
        const tagCenterY = clamp(y, layout.plot.top, plotBottom);
        const top = tagCenterY - tagHeight / 2;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    });
}

function ensureCursorBubbleElement(chart, cursor) {
    const entry = getCursorBubbleEntry(chart.cvs.id, cursor.key);
    if (entry.el) return entry.el;

    const body = chart.cvs.parentElement;
    const el = document.createElement('div');
    el.className = `cursor-bubble cursor-bubble-${cursor.key}`;
    el.dataset.chartId = chart.cvs.id;
    el.dataset.cursorKey = cursor.key;
    el.innerHTML = '<div class="cursor-bubble-time"></div><div class="cursor-bubble-value"></div>';
    el.style.setProperty('--cursor-color', cursor.color);
    el.addEventListener('mousedown', (e) => handleBubbleMouseDown(e, chart, cursor));
    body.appendChild(el);
    entry.el = el;
    return el;
}

function hideCursorBubble(chart, cursor) {
    const entry = getCursorBubbleEntry(chart.cvs.id, cursor.key);
    if (entry.el) {
        entry.el.classList.remove('is-visible');
    }
}

function getBubbleMarkerPosition(chart, cursor) {
    const layout = chartLayouts[chart.cvs.id];
    if (!layout) return null;
    return getCursorMarkerPosition(cursor, layout, chart.sel.value);
}

function handleBubbleMouseDown(e, chart, cursor) {
    e.preventDefault();
    e.stopPropagation();
    const entry = getCursorBubbleEntry(chart.cvs.id, cursor.key);
    const marker = getBubbleMarkerPosition(chart, cursor);
    if (!entry.el || !marker) return;

    const rect = chart.cvs.parentElement.getBoundingClientRect();
    const bubbleLeft = parseFloat(entry.el.style.left) || 0;
    const bubbleTop = parseFloat(entry.el.style.top) || 0;
    const pointerX = e.clientX - rect.left;
    const pointerY = e.clientY - rect.top;
    bubbleDragState.active = true;
    bubbleDragState.chart = chart;
    bubbleDragState.cursorKey = cursor.key;
    bubbleDragState.grabOffsetX = pointerX - bubbleLeft;
    bubbleDragState.grabOffsetY = pointerY - bubbleTop;
    resetCursorDragState();
}

function handleBubbleDragMove(e) {
    const chart = bubbleDragState.chart;
    const cursor = cursorDefinitions.find(item => item.key === bubbleDragState.cursorKey);
    if (!chart || !cursor) return;

    const entry = getCursorBubbleEntry(chart.cvs.id, cursor.key);
    const marker = getBubbleMarkerPosition(chart, cursor);
    if (!entry.el || !marker) return;

    const body = chart.cvs.parentElement;
    const rect = body.getBoundingClientRect();
    const bubbleWidth = entry.el.offsetWidth || 0;
    const bubbleHeight = entry.el.offsetHeight || 0;
    const pointerX = e.clientX - rect.left;
    const pointerY = e.clientY - rect.top;
    const left = clamp(pointerX - bubbleDragState.grabOffsetX, 0, Math.max(0, body.clientWidth - bubbleWidth));
    const top = clamp(pointerY - bubbleDragState.grabOffsetY, 0, Math.max(0, body.clientHeight - bubbleHeight));

    entry.offsetX = left - marker.x;
    entry.fixedTop = top;
    entry.el.style.left = `${left}px`;
    entry.el.style.top = `${top}px`;
}

function isAnyCursorBubbleVisible(chart) {
    return cursorDefinitions.some(cursor => {
        const entry = getCursorBubbleEntry(chart.cvs.id, cursor.key);
        return entry.el && entry.el.classList.contains('is-visible');
    });
}

function syncChartInfoVisibility(chart) {
    const i = charts.indexOf(chart);
    if (i < 0 || !infoElements[i]) return;
    const suppress = isAnyCursorBubbleVisible(chart);
    ['main', 'sub'].forEach(key => {
        const el = infoElements[i][key];
        if (el) el.classList.toggle('is-suppressed-by-bubble', suppress);
    });
}

function updateCursorBubblesForChart(chart) {
    cursorDefinitions.forEach(cursor => {
        const entry = getCursorBubbleEntry(chart.cvs.id, cursor.key);
        const el = ensureCursorBubbleElement(chart, cursor);
        const layout = chartLayouts[chart.cvs.id];
        const marker = layout ? getCursorMarkerPosition(cursor, layout, chart.sel.value) : null;
        const valueInfo = getCursorValueInfo(cursor, chart.sel.value);
        if (!isCursorEnabled(cursor.key) || !entry.visible || !marker || !valueInfo) {
            el.classList.remove('is-visible');
            return;
        }

        const body = chart.cvs.parentElement;
        const width = body.clientWidth;
        const height = body.clientHeight;
        const timeEl = el.querySelector('.cursor-bubble-time');
        const valueEl = el.querySelector('.cursor-bubble-value');
        el.style.setProperty('--cursor-color', cursor.color);
        timeEl.textContent = valueInfo.time;
        valueEl.textContent = formatCursorNumericValue(valueInfo.value);
        el.classList.add('is-visible');

        const bubbleWidth = el.offsetWidth || 0;
        const bubbleHeight = el.offsetHeight || 0;
        const left = clamp(marker.x + entry.offsetX, 0, Math.max(0, width - bubbleWidth));
        if (!Number.isFinite(entry.fixedTop)) {
            entry.fixedTop = marker.y + cursorBubbleDefaultOffset.y;
        }
        const top = clamp(entry.fixedTop, 0, Math.max(0, height - bubbleHeight));
        entry.fixedTop = top;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    });
    syncChartInfoVisibility(chart);
}

function updateCursorBubbles() {
    charts.forEach(chart => updateCursorBubblesForChart(chart));
}

// --- Worker連携 ---

let worker = null;

function createCsvWorker() {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
        throw new Error('このブラウザではWeb Workerを利用できません。');
    }
    const source = `(${csvWorkerMain.toString()})();`;
    const blob = new Blob([source], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    try {
        const createdWorker = new Worker(workerUrl);
        URL.revokeObjectURL(workerUrl);
        return createdWorker;
    } catch (err) {
        URL.revokeObjectURL(workerUrl);
        throw err;
    }
}

function createWorker() {
    if (worker) worker.terminate();
    try {
        worker = createCsvWorker();
    } catch (err) {
        worker = null;
        setErrorState(`Error: Workerの作成に失敗しました。${err.message || ''}`.trim());
        return false;
    }
    worker.onmessage = (e) => {
        const { type, payload } = e.data;
        if (type === 'progress') {
            setStatus(`Loading: ${payload}%`);
        } else if (type === 'complete') {
            dataset = payload.dataset;
            timeMeta = payload.timeMeta;
            dataset.timeMeta = timeMeta;
            headers = payload.headers;
            totalIds = timeMeta.idMax + 1;
            
            const displayMode = timeMeta.mode === 'mode_10s' ? '10s' : '1s';
            setStatus(`mode: ${displayMode} | rows: ${payload.totalRows}`);
            viewState.startIndex = 0;
            viewState.endIndex = totalIds;
            initControls(headers);
            if (isAnyCursorEnabled()) {
                getEnabledCursorDefinitions().forEach(cursor => initializeCursorPosition(cursor.key));
                updateCursorDisplay();
            }
            resizeAll();
        } else if (type === 'error' || type === 'blocked') {
            setErrorState(`Error: ${payload}`);
        }
    };
    worker.onerror = (err) => {
        setErrorState(`Error: Workerで例外が発生しました。${err.message || ''}`.trim());
    };
    return true;
}

function csvWorkerMain() {
    self.onmessage = async function (e) {
        const { type, file } = e.data;
        if (type === 'loadFile') {
            try {
                startProcessing(file);
            } catch (err) {
                postErrorAndClose(err.message);
            }
        }
    };

    function postErrorAndClose(message) {
        postError(message);
        self.close();
    }

    function isCsvFile(file) {
        if (!file) return false;
        const name = String(file.name || "").toLowerCase();
        if (name.endsWith(".csv")) return true;
        const type = String(file.type || "").toLowerCase();
        return type === "text/csv" || type === "application/vnd.ms-excel";
    }

    /**
     * ファイルのサンプリングによるモード判定
     */
    function startProcessing(file) {
        if (!isCsvFile(file)) {
            postErrorAndClose('CSVファイルのみ対応しています。');
            return;
        }

        const reader = new FileReader();

        reader.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 30);
                self.postMessage({ type: 'progress', payload: percent });
            }
        };

        reader.readAsText(file, "Shift-JIS");

        reader.onload = function (event) {
            const text = event.target.result;
            const analysis = analyzeCsv(text);
            if (!analysis || !analysis.headers || analysis.capacity <= 0) {
                postErrorAndClose('有効なデータが見つかりません。');
                return;
            }
            const result = buildDataset(text, analysis);
            if (!result || result.rowCount <= 0) {
                postErrorAndClose('有効な時刻が見つかりません。');
                return;
            }
            finalize(result);
        };
        reader.onerror = () => {
            postErrorAndClose('ファイル読み込みに失敗しました。');
        };
    }

    function forEachKeptLine(text, callback) {
        let start = 0;
        let rawLineNumber = 0;
        let keptLineNumber = 0;
        for (let i = 0; i <= text.length; i++) {
            if (i === text.length || text.charCodeAt(i) === 10) {
                let line = text.slice(start, i);
                if (line.endsWith("\r")) line = line.slice(0, -1);
                start = i + 1;
                if (line.trim() === "") continue;
                rawLineNumber++;
                if ((rawLineNumber >= 1 && rawLineNumber <= 9) || (rawLineNumber >= 11 && rawLineNumber <= 13)) {
                    continue;
                }
                keptLineNumber++;
                callback(line, keptLineNumber, rawLineNumber);
            }
        }
    }

    function analyzeCsv(text) {
        let headers = null;
        let capacity = 0;
        const sampleLines = [];
        forEachKeptLine(text, (line, keptLineNumber) => {
            if (keptLineNumber === 1) {
                headers = line.split(',');
                return;
            }
            capacity++;
            if (sampleLines.length < 10) sampleLines.push(line);
        });
        if (!headers || capacity <= 0) return null;
        let is10sMode = false;
        for (let i = 0; i < sampleLines.length - 1; i++) {
            const tsCurrent = sampleLines[i].split(',')[0].trim();
            const tsNext = sampleLines[i + 1].split(',')[0].trim();
            if (tsCurrent === tsNext && tsCurrent !== "") {
                is10sMode = true;
                break;
            }
        }
        const fields = headers.slice(1).map(h => h.trim()).filter(h => h !== "");
        const fieldColumnIndexes = [];
        for (let i = 1; i < headers.length; i++) {
            const field = headers[i].trim();
            if (field !== "") fieldColumnIndexes.push(i);
        }
        return {
            headers,
            fields,
            fieldColumnIndexes,
            capacity,
            mode: is10sMode ? 'mode_10s' : 'mode_1s',
            stepMs: is10sMode ? 10000 : 1000
        };
    }

    function buildDataset(text, analysis) {
        const qIds = new Int32Array(analysis.capacity);
        const timestamps = new Float64Array(analysis.capacity);
        const columns = {};
        analysis.fields.forEach((field) => {
            columns[field] = new Float64Array(analysis.capacity);
            columns[field].fill(NaN);
        });

        let rowCount = 0;
        let dataLineCount = 0;
        let baseTs = null;
        let lastLogicTs = null;
        let maxQId = 0;

        forEachKeptLine(text, (line, keptLineNumber) => {
            if (keptLineNumber === 1) return;
            dataLineCount++;
            const cols = line.split(',');
            if (cols.length < analysis.headers.length) return;

            const timeStr = cols[0].trim();
            let ts = NaN;
            if (analysis.mode === 'mode_10s') {
                const currentRawMinuteTs = getMinutePrecisionTs(timeStr);
                if (isNaN(currentRawMinuteTs)) return;
                if (baseTs === null) {
                    baseTs = currentRawMinuteTs;
                    lastLogicTs = currentRawMinuteTs;
                } else {
                    const expectedTs = lastLogicTs + analysis.stepMs;
                    const expectedMinuteTs = Math.floor(expectedTs / 60000) * 60000;
                    lastLogicTs = currentRawMinuteTs > expectedMinuteTs ? currentRawMinuteTs : expectedTs;
                }
                ts = lastLogicTs;
            } else {
                ts = parseTimestampStandard(timeStr);
                if (isNaN(ts)) return;
                if (baseTs === null) baseTs = ts;
            }

            const qId = Math.round((ts - baseTs) / analysis.stepMs);
            qIds[rowCount] = qId;
            timestamps[rowCount] = ts;
            if (qId > maxQId) maxQId = qId;

            for (let i = 0; i < analysis.fields.length; i++) {
                const field = analysis.fields[i];
                const colIndex = analysis.fieldColumnIndexes[i];
                const value = Number(String(cols[colIndex] || "").trim());
                columns[field][rowCount] = Number.isFinite(value) ? value : NaN;
            }

            rowCount++;
            if (dataLineCount % 5000 === 0) reportProgress(dataLineCount, analysis.capacity);
        });

        if (baseTs === null || rowCount <= 0) return null;
        return {
            headers: analysis.headers,
            fields: analysis.fields,
            totalRows: rowCount,
            rowCount,
            dataset: {
                headers: analysis.headers,
                fields: analysis.fields,
                rowCount,
                qIds,
                timestamps,
                columns
            },
            timeMeta: {
                mode: analysis.mode,
                baseTs,
                stepMs: analysis.stepMs,
                idMax: maxQId
            }
        };
    }

    function getMinutePrecisionTs(rawStr) {
        const m = rawStr.match(/^(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
        if (!m) return NaN;
        let y = Number(m[1]);
        if (y < 100) y += (y < 50 ? 2000 : 1900);
        return new Date(y, m[2] - 1, m[3], m[4], m[5], 0, 0).getTime();
    }

    function parseTimestampStandard(rawStr) {
        // 空白の数に依存しないロバストなパース
        const m = rawStr.match(/^(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
        if (!m) return NaN;
        let y = Number(m[1]);
        if (y < 100) y += (y < 50 ? 2000 : 1900);
        return new Date(y, m[2] - 1, m[3], m[4], m[5], m[6]).getTime();
    }

    function reportProgress(current, total) {
        self.postMessage({ type: 'progress', payload: 30 + Math.round((current / total) * 70) });
    }

    function postError(message) {
        self.postMessage({ type: 'error', payload: message });
    }

    function finalize(result) {
        const transferList = [
            result.dataset.qIds.buffer,
            result.dataset.timestamps.buffer,
            ...Object.values(result.dataset.columns).map(column => column.buffer)
        ];
        self.postMessage({
            type: 'complete',
            payload: {
                totalRows: result.totalRows,
                headers: result.headers,
                timeMeta: result.timeMeta,
                dataset: result.dataset
            }
        }, transferList);
        self.close();
    }
}

if (fileInput) {
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        startFileLoad(file);
    });
}

/**
 * 補足: prepareLayout, renderChart, drawSlider, calculateNiceScale 等の
 * 描画補助関数は、以前のコードのロジックを qId ベースで適用する形で継続使用します。
 */

function applyChartFieldSelection(chart, field, options = {}) {
    if (!chart || !chart.sel || !field || chart.sel.value === field) {
        if (options.commit && chart && chart.fieldDropdown) {
            chart.fieldDropdown.committedValue = field;
        }
        updateChartFieldDropdownDisplay(chart);
        return;
    }

    chart.sel.value = field;
    if (options.commit && chart.fieldDropdown) {
        chart.fieldDropdown.committedValue = field;
    }
    updateChartFieldDropdownDisplay(chart);
    updateCursorDisplay(chart);
    requestDraw({ charts: chart, skipSlider: true });
}

function updateChartFieldDropdownDisplay(chart) {
    const dropdown = chart && chart.fieldDropdown;
    if (!dropdown) return;

    const currentValue = chart.sel.value;
    dropdown.button.textContent = currentValue || "";
    dropdown.optionButtons.forEach(button => {
        button.classList.toggle('is-selected', button.dataset.value === currentValue);
    });
}

function initializeCustomDropdownDocumentListeners() {
    if (customDropdownDocumentListenersInitialized) return;
    customDropdownDocumentListenersInitialized = true;

    document.addEventListener('mousedown', (e) => {
        if (!openChartDropdown) return;
        const dropdown = openChartDropdown.fieldDropdown;
        if (dropdown && dropdown.root.contains(e.target)) return;
        closeChartFieldDropdown(openChartDropdown, { revert: true });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !openChartDropdown) return;
        closeChartFieldDropdown(openChartDropdown, { revert: true });
    });
}

function ensureChartFieldDropdown(chart) {
    if (chart.fieldDropdown) return chart.fieldDropdown;

    initializeCustomDropdownDocumentListeners();
    const root = document.createElement('div');
    root.className = 'chart-field-dropdown';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chart-field-dropdown-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');

    const list = document.createElement('div');
    list.className = 'chart-field-dropdown-list';
    list.setAttribute('role', 'listbox');

    root.appendChild(button);
    root.appendChild(list);
    chart.sel.parentElement.insertBefore(root, chart.sel);
    chart.sel.classList.add('chart-field-native-select');

    chart.fieldDropdown = {
        root,
        button,
        list,
        optionButtons: [],
        committedValue: chart.sel.value
    };

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (openChartDropdown === chart) {
            closeChartFieldDropdown(chart, { revert: true });
        } else {
            openChartFieldDropdown(chart);
        }
    });

    return chart.fieldDropdown;
}

function updateChartFieldDropdownPlacement(chart) {
    const dropdown = chart.fieldDropdown;
    if (!dropdown) return;

    const container = document.getElementById('mainContainer');
    const buttonRect = dropdown.button.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const maxHeight = parseFloat(getComputedStyle(dropdown.list).maxHeight) || Infinity;
    const listHeight = Math.min(dropdown.list.scrollHeight, maxHeight);

    const spaceBelow = containerRect.bottom - buttonRect.bottom;
    const spaceAbove = buttonRect.top - containerRect.top;

    const openUp = listHeight > spaceBelow && spaceAbove > spaceBelow;
    dropdown.root.classList.toggle('is-open-up', openUp);
}

function openChartFieldDropdown(chart) {
    if (openChartDropdown && openChartDropdown !== chart) {
        closeChartFieldDropdown(openChartDropdown, { revert: true });
    }

    const dropdown = ensureChartFieldDropdown(chart);
    const panel = chart.sel.closest('.chart-panel');

    dropdown.committedValue = chart.sel.value;
    dropdown.root.classList.add('is-open');
    panel.classList.add('is-dropdown-open');
    dropdown.button.setAttribute('aria-expanded', 'true');

    updateChartFieldDropdownPlacement(chart);
    openChartDropdown = chart;
}

function closeChartFieldDropdown(chart, options = {}) {
    const dropdown = chart && chart.fieldDropdown;
    if (!dropdown) return;

    const panel = chart.sel.closest('.chart-panel');

    if (options.revert && dropdown.committedValue && chart.sel.value !== dropdown.committedValue) {
        applyChartFieldSelection(chart, dropdown.committedValue);
    }

    dropdown.root.classList.remove('is-open', 'is-open-up');
    panel.classList.remove('is-dropdown-open');
    dropdown.button.setAttribute('aria-expanded', 'false');
    if (openChartDropdown === chart) {
        openChartDropdown = null;
    }
}

function getScrollbarWidth() {
    if (getScrollbarWidth.cached != null) return getScrollbarWidth.cached;

    const outer = document.createElement('div');
    outer.style.cssText = 'visibility:hidden;overflow:scroll;width:100px;height:100px;position:absolute;top:-9999px';
    document.body.appendChild(outer);
    const inner = document.createElement('div');
    inner.style.height = '200px';
    outer.appendChild(inner);
    getScrollbarWidth.cached = outer.offsetWidth - outer.clientWidth;
    document.body.removeChild(outer);
    return getScrollbarWidth.cached;
}

function measureChartFieldDropdownListNeedsScrollbar(list) {
    const prevDisplay = list.style.display;
    const prevVisibility = list.style.visibility;
    list.style.display = 'block';
    list.style.visibility = 'hidden';
    const maxHeight = parseFloat(getComputedStyle(list).maxHeight) || Infinity;
    const needsScrollbar = list.scrollHeight > maxHeight;
    list.style.display = prevDisplay;
    list.style.visibility = prevVisibility;
    return needsScrollbar;
}

function getChartFieldDropdownWidth(fields, needsScrollbar = false) {
    const minWidth = 120;
    if (!fields || fields.length === 0) return minWidth;

    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '13px sans-serif';
    const textWidth = fields.reduce((maxWidth, field) => {
        return Math.max(maxWidth, ctx.measureText(field).width);
    }, 0);

    const buttonChromeWidth = 4 + 18 + 2;
    const optionHorizontalPadding = 6 + 6;
    const chromeWidth = Math.max(buttonChromeWidth, optionHorizontalPadding);
    const scrollbarWidth = needsScrollbar ? getScrollbarWidth() : 0;

    return Math.ceil(textWidth + chromeWidth + scrollbarWidth);
}

function updateChartFieldDropdownWidth(chart, fields) {
    const dropdown = chart.fieldDropdown;
    if (!dropdown) return;

    const needsScrollbar = measureChartFieldDropdownListNeedsScrollbar(dropdown.list);
    dropdown.root.style.setProperty(
        '--chart-field-dropdown-width',
        `${getChartFieldDropdownWidth(fields, needsScrollbar)}px`
    );
}

function rebuildChartFieldDropdownOptions(chart, fields) {
    const dropdown = ensureChartFieldDropdown(chart);
    dropdown.list.innerHTML = "";
    dropdown.optionButtons = [];

    fields.forEach(field => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chart-field-dropdown-option';
        button.dataset.value = field;
        button.textContent = field;
        button.setAttribute('role', 'option');
        button.addEventListener('mouseenter', () => {
            applyChartFieldSelection(chart, field);
        });
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyChartFieldSelection(chart, field, { commit: true });
            closeChartFieldDropdown(chart);
        });
        dropdown.list.appendChild(button);
        dropdown.optionButtons.push(button);
    });

    updateChartFieldDropdownWidth(chart, fields);

    dropdown.root.classList.toggle('is-disabled', fields.length === 0);
    dropdown.button.disabled = fields.length === 0;
    dropdown.committedValue = chart.sel.value;
    updateChartFieldDropdownDisplay(chart);
}

function initControls(headers) {
    const fields = headers.slice(1).map(h => h.trim()).filter(h => h !== "");
    charts.forEach((chart, idx) => {
        const current = chart.sel.value;
        chart.sel.innerHTML = "";
        fields.forEach(field => {
            const opt = document.createElement('option');
            opt.value = field;
            opt.textContent = field;
            chart.sel.appendChild(opt);
        });
        const next = (current && fields.includes(current))
            ? current
            : (fields[idx] || fields[0] || "");
        chart.sel.value = next;
        chart.sel.disabled = fields.length === 0;
        rebuildChartFieldDropdownOptions(chart, fields);
        chart.sel.onchange = () => {
            applyChartFieldSelection(chart, chart.sel.value, { commit: true });
        };
    });
}

function snapToDevicePixel(value, lineWidth, dpr) {
    if (!Number.isFinite(value)) return value;
    const pixel = value * dpr;
    const deviceWidth = Math.max(1, Math.round(lineWidth * dpr));
    const offset = (deviceWidth % 2 === 1) ? 0.5 : 0;
    return (Math.round(pixel) + offset) / dpr;
}



function prepareLayout(chart, range, segmentModel) {
    const rect = chart.cvs.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    const margin = { left: 50, right: 40, top: 10, bottom: 30 };
    const basePlot = {
        left: margin.left,
        top: margin.top,
        width: Math.max(1, width - margin.left - margin.right),
        height: Math.max(1, height - margin.top - margin.bottom)
    };
    const snapAxis = (value) => snapToDevicePixel(value, 1, dpr);
    const snappedLeft = snapAxis(basePlot.left);
    const snappedBottom = snapAxis(basePlot.top + basePlot.height);
    const plot = {
        left: snappedLeft,
        top: snappedBottom - basePlot.height,
        width: basePlot.width,
        height: basePlot.height
    };

    const field = chart.sel.value;
    const values = dataset && dataset.columns ? dataset.columns[field] : null;
    let min = Infinity;
    let max = -Infinity;
    if (values) {
        for (let row = range.startRow; row < range.endRow; row++) {
            const val = values[row];
            if (Number.isFinite(val)) {
                if (val < min) min = val;
                if (val > max) max = val;
            }
        }
    }
    const dataMin = min;
    const dataMax = max;
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 1;
    }
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const yScale = calculateNiceScale(min, max, 5);

    const startId = segmentModel.startId;
    const endId = segmentModel.endId;
    const span = Math.max(1, endId - startId);
    const xMapping = {
        idToPixel: (id) => plot.left + ((id - startId) / span) * plot.width,
        pixelToId: (x) => {
            const ratio = Math.min(1, Math.max(0, (x - plot.left) / plot.width));
            return { id: Math.round(startId + ratio * span) };
        }
    };

    const ySpan = Math.max(1e-9, yScale.niceMax - yScale.niceMin);
    const yMapping = {
        valueToPixel: (val) => plot.top + plot.height - ((val - yScale.niceMin) / ySpan) * plot.height,
        pixelToValue: (y) => {
            const ratio = Math.min(1, Math.max(0, (plot.top + plot.height - y) / plot.height));
            return yScale.niceMin + ratio * ySpan;
        }
    };

    const snap = (value, lineWidth = 1) => snapToDevicePixel(value, lineWidth, dpr);
    return { width, height, plot, field, xMapping, yMapping, yScale, dataMin, dataMax, snap, dpr };
}

function renderChart(chart, range, layout) {
    const ctx = chart.ctx;
    const { width, height, field } = layout;
    const values = dataset && dataset.columns ? dataset.columns[field] : null;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.lineWidth = 1;
    ctx.font = '12px sans-serif';

    drawHorizontalCursorTagRectangles(ctx, layout, chart.cvs.id);
    drawYAxis(ctx, layout);
    drawXAxis(ctx, layout);
    drawMainAxes(ctx, layout);
    drawDataSeries(ctx, range, layout, values);
    drawHorizontalCursorTagTriangles(ctx, layout, chart.cvs.id);
    drawHorizontalCursors(ctx, layout, chart.cvs.id);
    updateHorizontalCursorValueLabelsForChart(chart);
    drawChartCursor(ctx, layout);
    drawCursorMarkers(ctx, layout, field);
    updateHorizontalCursorTagsForChart(chart);
    updateCursorBubblesForChart(chart);

    ctx.restore();
}

function drawYAxis(ctx, layout) {
    const { plot, yMapping, yScale, snap } = layout;
    ctx.strokeStyle = '#eee';
    ctx.lineWidth = 1;
    for (let v = yScale.niceMin; v <= yScale.niceMax + 1e-9; v += yScale.step) {
        const y = yMapping.valueToPixel(v);
        const yLine = snap(y, ctx.lineWidth);
        if (Math.abs(yLine - (plot.top + plot.height)) < 0.5) continue;
        ctx.beginPath();
        ctx.moveTo(plot.left, yLine);
        ctx.lineTo(plot.left + plot.width, yLine);
        ctx.stroke();
    }

    ctx.fillStyle = '#000000';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yLabelX = Math.max(0, plot.left - 6);
    for (let v = yScale.niceMin; v <= yScale.niceMax + 1e-9; v += yScale.step) {
        const y = yMapping.valueToPixel(v);
        const yLine = snap(y, ctx.lineWidth);
        ctx.fillText(formatAxisValue(v, yScale.step), yLabelX, yLine);
    }
}

function drawXAxis(ctx, layout) {
    const { height, plot, snap } = layout;
    const startIdInfo = layout.xMapping.pixelToId(plot.left);
    const endIdInfo = layout.xMapping.pixelToId(plot.left + plot.width);
    let startTs = getTimestampFromQId(startIdInfo.id);
    let endTs = getTimestampFromQId(endIdInfo.id);
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return;

    if (endTs < startTs) {
        const tmp = startTs;
        startTs = endTs;
        endTs = tmp;
    }
    const viewSpanMs = endTs - startTs;
    const majorStepMs = chooseMajorStepMs(viewSpanMs, plot.width);
    const minorStepMs = chooseMinorStepMs(majorStepMs);

    if (minorStepMs) {
        const minorStart = Math.ceil(startTs / minorStepMs) * minorStepMs;
        ctx.strokeStyle = '#f2f2f2';
        ctx.lineWidth = 1;
        for (let t = minorStart; t <= endTs; t += minorStepMs) {
            if (majorStepMs && ((t - Math.ceil(startTs / majorStepMs) * majorStepMs) % majorStepMs === 0)) continue;
            const id = getQIdFromTimestamp(t);
            const x = layout.xMapping.idToPixel(id);
            if (!Number.isFinite(x)) continue;
            const xLine = snap(x, ctx.lineWidth);
            ctx.beginPath();
            ctx.moveTo(xLine, plot.top);
            ctx.lineTo(xLine, plot.top + plot.height);
            ctx.stroke();
        }
    }

    const majorStart = Math.ceil(startTs / majorStepMs) * majorStepMs;
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    for (let t = majorStart; t <= endTs; t += majorStepMs) {
        const id = getQIdFromTimestamp(t);
        const x = layout.xMapping.idToPixel(id);
        if (!Number.isFinite(x)) continue;
        const xLine = snap(x, ctx.lineWidth);
        if (Math.abs(xLine - plot.left) < 0.5) continue;

        ctx.beginPath();
        ctx.moveTo(xLine, plot.top);
        ctx.lineTo(xLine, plot.top + plot.height + 4);
        ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#000000';
    ctx.font = '10px sans-serif';
    let prevDayKey = null;
    let lastLabelX = plot.left;
    for (let t = majorStart; t <= endTs; t += majorStepMs) {
        const x = layout.xMapping.idToPixel(getQIdFromTimestamp(t));
        if (!Number.isFinite(x)) continue;
        const xLabel = snap(x, ctx.lineWidth);
        if (xLabel - lastLabelX >= MIN_LABEL_PX) {
            const timeLabel = formatTickTime(t, majorStepMs);
            ctx.fillText(timeLabel, xLabel, height - 2);
            const d = new Date(t);
            const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
            const isDayChanged = (prevDayKey !== null && dayKey !== prevDayKey);
            if (isDayChanged) {
                ctx.fillText(formatDate(t), xLabel, height - 14);
            }
            prevDayKey = dayKey;
            lastLabelX = xLabel;
        }
    }

    const tsLeft = getTimestampFromQId(startIdInfo.id);
    if (Number.isFinite(tsLeft)) {
        const timeStr = formatTickTime(tsLeft, majorStepMs);
        const dateStr = formatDate(tsLeft);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const baseX = plot.left + 5;
        const baseY = height - 2;
        ctx.fillText(timeStr, baseX, baseY);
        ctx.fillText(dateStr, baseX, baseY - 12);
    }
}

function drawMainAxes(ctx, layout) {
    const { plot } = layout;
    ctx.strokeStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(plot.left, plot.top);
    ctx.lineTo(plot.left, plot.top + plot.height);
    ctx.lineTo(plot.left + plot.width, plot.top + plot.height);
    ctx.stroke();
}

function getVisibleHorizontalCursorTags(chartId, layout) {
    const visibleCursors = getEnabledHorizontalCursorDefinitions(chartId);
    if (visibleCursors.length === 0) return [];

    const group = getHorizontalCursorGroup(chartId);
    const plotBottom = layout.plot.top + layout.plot.height;
    return visibleCursors
        .map(cursor => {
            const state = group.cursors[cursor.key];
            if (!state || !Number.isFinite(state.value)) return null;
            const y = layout.yMapping.valueToPixel(state.value);
            if (!Number.isFinite(y) || y < layout.plot.top || y > plotBottom) return null;
            return { cursor, y: layout.snap(y, 1) };
        })
        .filter(item => item !== null);
}

function drawHorizontalCursorTagRectangles(ctx, layout, chartId) {
    const { plot } = layout;
    const tags = getVisibleHorizontalCursorTags(chartId, layout);
    if (tags.length === 0) return;

    ctx.save();
    ctx.fillStyle = '#e0e0e0';
    tags.forEach(({ y }) => {
        ctx.fillRect(
            plot.left - horizontalCursorTagRectWidth,
            y - horizontalCursorTagHeight / 2,
            horizontalCursorTagRectWidth,
            horizontalCursorTagHeight
        );
    });
    ctx.restore();
}

function drawHorizontalCursorTagTriangles(ctx, layout, chartId) {
    const { plot } = layout;
    const tags = getVisibleHorizontalCursorTags(chartId, layout);
    if (tags.length === 0) return;

    ctx.save();
    tags.forEach(({ cursor, y }) => {
        ctx.fillStyle = cursor.color;
        ctx.beginPath();
        ctx.moveTo(plot.left, y - horizontalCursorTagHeight / 2);
        ctx.lineTo(plot.left + horizontalCursorTagTriangleWidth, y);
        ctx.lineTo(plot.left, y + horizontalCursorTagHeight / 2);
        ctx.closePath();
        ctx.fill();
    });
    ctx.restore();
}

function drawDataSeries(ctx, range, layout, values) {
    const { plot } = layout;
    const mainColor = '#2196F3';
    const mainFillColor = 'rgba(33, 150, 243, 0.15)';
    const dense = range.length > plot.width;
    if (dense) {
        drawDenseSeries(ctx, range, layout, values, mainColor, mainFillColor);
        return;
    }
    drawNormalSeries(ctx, range, layout, values, mainColor);
}

function drawDenseSeries(ctx, range, layout, values, mainColor, fillColor) {
    const { plot, xMapping, yMapping } = layout;
    const bucketCount = Math.max(1, Math.floor(plot.width));
    const buckets = new Array(bucketCount);
    for (let row = range.startRow; row < range.endRow; row++) {
        const val = values ? values[row] : NaN;
        if (!Number.isFinite(val)) continue;
        const x = xMapping.idToPixel(dataset.qIds[row]);
        if (!Number.isFinite(x)) continue;
        const idx = Math.floor(x - plot.left);
        if (idx < 0 || idx >= bucketCount) continue;
        const b = buckets[idx];
        if (!b) {
            buckets[idx] = { min: val, max: val };
        } else {
            if (val < b.min) b.min = val;
            if (val > b.max) b.max = val;
        }
    }

    const drawEnvelope = (startIdx, endIdx) => {
        ctx.beginPath();
        for (let i = startIdx; i <= endIdx; i++) {
            const b = buckets[i];
            const x = plot.left + i + 0.5;
            const yMax = yMapping.valueToPixel(b.max);
            if (i === startIdx) ctx.moveTo(x, yMax);
            else ctx.lineTo(x, yMax);
        }
        for (let i = endIdx; i >= startIdx; i--) {
            const b = buckets[i];
            const x = plot.left + i + 0.5;
            const yMin = yMapping.valueToPixel(b.min);
            ctx.lineTo(x, yMin);
        }
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
    };

    let i = 0;
    while (i < buckets.length) {
        if (!buckets[i]) { i++; continue; }
        let startIdx = i;
        while (i + 1 < buckets.length && buckets[i + 1]) i++;
        let endIdx = i;
        drawEnvelope(startIdx, endIdx);
        i++;
    }

    ctx.beginPath();
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 1;
    let drawing = false;
    for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        if (!b) { drawing = false; continue; }
        const x = plot.left + i + 0.5;
        const mid = (b.min + b.max) / 2;
        const y = yMapping.valueToPixel(mid);
        if (!drawing) {
            ctx.moveTo(x, y);
            drawing = true;
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();
}

function drawNormalSeries(ctx, range, layout, values, mainColor) {
    const { xMapping, yMapping } = layout;
    ctx.strokeStyle = mainColor;
    ctx.lineWidth = 1;
    let pathOpen = false;
    let prevQId = null;
    for (let row = range.startRow; row < range.endRow; row++) {
        const qId = dataset.qIds[row];
        const val = values ? values[row] : NaN;
        if (!Number.isFinite(val)) {
            if (pathOpen) {
                ctx.stroke();
                pathOpen = false;
            }
            prevQId = qId;
            continue;
        }
        const x = xMapping.idToPixel(qId);
        const y = yMapping.valueToPixel(val);
        const hasGap = prevQId !== null && (qId - prevQId) > 1;
        if (!pathOpen || hasGap) {
            if (pathOpen) ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x, y);
            pathOpen = true;
        } else {
            ctx.lineTo(x, y);
        }
        prevQId = qId;
    }
    if (pathOpen) ctx.stroke();
}

function drawHorizontalCursors(ctx, layout, chartId) {
    const { plot, yMapping, snap } = layout;
    const visibleCursors = getEnabledHorizontalCursorDefinitions(chartId);
    if (visibleCursors.length === 0) return;
    const group = getHorizontalCursorGroup(chartId);
    const plotBottom = plot.top + plot.height;

    visibleCursors.forEach(cursor => {
        const state = group.cursors[cursor.key];
        if (!state || !Number.isFinite(state.value)) return;
        const y = yMapping.valueToPixel(state.value);
        if (!Number.isFinite(y) || y < plot.top || y > plotBottom) return;

        ctx.save();
        ctx.strokeStyle = cursor.color;
        ctx.lineWidth = 1;
        ctx.setLineDash(cursor.dash);
        const yLine = snap(y, ctx.lineWidth);
        ctx.beginPath();
        ctx.moveTo(plot.left, yLine);
        ctx.lineTo(plot.left + plot.width, yLine);
        ctx.stroke();

        ctx.restore();
    });
}

function drawChartCursor(ctx, layout) {
    const { plot, xMapping } = layout;
    const visibleCursors = getEnabledCursorDefinitions();
    if (visibleCursors.length === 0) return;

    visibleCursors.forEach(cursor => {
        const index = cursorState.cursors[cursor.key].index;
        if (!Number.isFinite(index)) return;
        const cx = xMapping.idToPixel(index);
        if (Number.isFinite(cx) && cx >= plot.left && cx <= plot.left + plot.width) {
            ctx.save();
            ctx.strokeStyle = cursor.color;
            ctx.setLineDash(cursor.dash);
            ctx.beginPath();
            ctx.moveTo(cx, plot.top);
            ctx.lineTo(cx, plot.top + plot.height);
            ctx.stroke();
            ctx.restore();
        }
    });
}

function getCursorMarkerPosition(cursor, layout, field) {
    const { plot, xMapping, yMapping } = layout;
    const index = cursorState.cursors[cursor.key].index;
    if (!isCursorEnabled(cursor.key) || !Number.isFinite(index)) return null;

    const x = xMapping.idToPixel(index);
    if (!Number.isFinite(x) || x < plot.left || x > plot.left + plot.width) return null;

    const rowIndex = getNearestRow(index);
    if (!Number.isInteger(rowIndex)) return null;

    const value = getValueAt(rowIndex, field);
    if (!Number.isFinite(value)) return null;

    const y = yMapping.valueToPixel(value);
    if (!Number.isFinite(y) || y < plot.top || y > plot.top + plot.height) return null;

    return { x, y };
}

function drawCursorMarkers(ctx, layout, field) {
    const visibleCursors = getEnabledCursorDefinitions();
    if (visibleCursors.length === 0) return;

    visibleCursors.forEach(cursor => {
        const marker = getCursorMarkerPosition(cursor, layout, field);
        if (!marker) return;

        ctx.save();
        ctx.fillStyle = cursor.color;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, cursorMarkerRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    });
}

function drawSlider() {
    const rect = sliderCanvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    sliderCtx.clearRect(0, 0, width, height);
    if (totalIds <= 0) return;

    sliderCtx.save();
    sliderCtx.fillStyle = '#fff';
    sliderCtx.fillRect(0, 0, width, height);

    const span = Math.max(1, totalIds);
    const viewStart = Math.max(0, viewState.startIndex);
    const viewEnd = Math.min(totalIds, viewState.endIndex);
    let x1 = (viewStart / span) * width;
    let x2 = (viewEnd / span) * width;
    if (!Number.isFinite(x1)) x1 = 0;
    if (!Number.isFinite(x2)) x2 = width;
    const barW = Math.max(sliderMinPixel, x2 - x1);

    sliderCtx.fillStyle = '#e2e2e2';
    sliderCtx.fillRect(x1, 0, barW, height);

    const gripRender = Math.max(2, Math.min(gripWidth, Math.floor(barW / 2)));
    sliderCtx.fillStyle = '#333333';
    sliderCtx.fillRect(x1, 0, gripRender, height);
    sliderCtx.fillRect(x1 + barW - gripRender, 0, gripRender, height);

    sliderCtx.beginPath();
    sliderCtx.strokeStyle = 'rgba(34, 34, 34, 0.5)';
    sliderCtx.lineWidth = 2;
    const cx = x1 + barW / 2;
    sliderCtx.moveTo(cx - 3, height * 0.3);
    sliderCtx.lineTo(cx - 3, height * 0.7);
    sliderCtx.moveTo(cx, height * 0.3);
    sliderCtx.lineTo(cx, height * 0.7);
    sliderCtx.moveTo(cx + 3, height * 0.3);
    sliderCtx.lineTo(cx + 3, height * 0.7);
    sliderCtx.stroke();

    getEnabledCursorDefinitions().forEach(cursor => {
        const index = cursorState.cursors[cursor.key].index;
        if (!Number.isFinite(index)) return;
        const cx = (index / span) * width;
        if (!Number.isFinite(cx)) return;
        sliderCtx.save();
        sliderCtx.strokeStyle = cursor.color;
        sliderCtx.setLineDash(cursor.dash);
        sliderCtx.beginPath();
        sliderCtx.moveTo(cx, 0);
        sliderCtx.lineTo(cx, height);
        sliderCtx.stroke();
        sliderCtx.restore();
    });

    sliderCtx.restore();
}

function calculateNiceScale(min, max, maxTicks) {
    const range = niceNum(max - min, false);
    const step = niceNum(range / (maxTicks - 1), true);
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    return { niceMin, niceMax, step };
}

function niceNum(range, round) {
    if (range === 0) return 1;
    const exponent = Math.floor(Math.log10(range));
    const fraction = range / Math.pow(10, exponent);
    let niceFraction;
    if (round) {
        if (fraction < 1.5) niceFraction = 1;
        else if (fraction < 3) niceFraction = 2;
        else if (fraction < 7) niceFraction = 5;
        else niceFraction = 10;
    } else {
        if (fraction <= 1) niceFraction = 1;
        else if (fraction <= 2) niceFraction = 2;
        else if (fraction <= 5) niceFraction = 5;
        else niceFraction = 10;
    }
    return niceFraction * Math.pow(10, exponent);
}

function getAxisDecimals(step) {
    if (!Number.isFinite(step) || step <= 0) return 2;
    let decimals = 0;
    let scaled = Math.abs(step);
    while (decimals < 6 && Math.abs(Math.round(scaled) - scaled) > 1e-9) {
        scaled *= 10;
        decimals++;
    }
    return decimals;
}

function formatAxisValue(val, step) {
    if (Math.abs(val) >= 10000 || (Math.abs(val) > 0 && Math.abs(val) < 0.01)) {
        return val.toExponential(2);
    }
    const decimals = getAxisDecimals(step);
    if (decimals <= 0) return Math.round(val).toString();
    return val.toFixed(decimals);
}