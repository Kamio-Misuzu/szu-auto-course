// ==UserScript==
// @name         深大研究生选课 · 自动抢课助手
// @namespace    szu-yjsxkapp-auto-grab
// @version      1.0.0
// @description  轮询研究生选课系统的全部分页，发现余量立刻点击「选课」；支持关键词过滤 / 自动确认弹窗 / 成功提醒
// @author       -
// @match        https://ehall.szu.edu.cn/yjsxkapp/*
// @match        https://ehall.szu.edu.cn/xsxkapp/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
'use strict';

if (window.self !== window.top) return;              // 只在顶层挂面板，iframe 由顶层穿透操作
if (window.__SZU_GRAB__) { window.__SZU_GRAB__.show(); return; }

/* ============================================================
 * 0. 配置
 * ========================================================== */
var DEFAULT_CFG = {
  mode: 'all',              // all = 所有有余量的课 | include = 仅关键词匹配
  include: '',
  exclude: '',
  interval: 1500,           // 每一轮之间的间隔(ms)
  pageGap: 400,             // 翻页之间的间隔(ms)
  clickGap: 500,            // 一门课失败后，隔多久点下一门(ms)
  msgWait: 3500,            // 点完最多等多久判断成败(ms)
  maxPages: 30,             // 最多翻多少页，防跑飞
  autoConfirm: true,        // 自动点确认弹窗
  clickUnknown: false,      // 余量识别不出来时也点一下
  stopOnDone: false,        // 抢到一门就停
  sound: true,
  dryRun: false             // 试运行：只报告不点击
};
var CFG_KEY = 'szg_cfg_v1';
var cfg = Object.assign({}, DEFAULT_CFG);
try { Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch (e) {}

var running = false;
var stats = { round: 0, got: 0 };
var done = new Set();       // 已成功选上的课
var skip = new Set();       // 冲突/学分超限这类怎么抢都不会成的课，本次运行内不再试
var warned = new Set();     // 余量识别失败已提示过的课
var logs = [];

/* ============================================================
 * 1. 通用工具
 * ========================================================== */
/* 定时器：浏览器会把后台标签页的 setTimeout 限流到 ~1 秒一次，
 * 那样一轮要拖到十几秒，等于废了。Worker 里的定时器不受这个限制，
 * 所以优先走 Worker，拿不到就退回 setTimeout。 */
var timer = (function () {
  var w = null, seq = 0, waiting = {};
  try {
    var src = 'onmessage=function(e){setTimeout(function(){postMessage(e.data.id)},e.data.ms)}';
    var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    w = new Worker(url);
    w.onmessage = function (e) {
      var fn = waiting[e.data];
      if (fn) { delete waiting[e.data]; fn(); }
    };
  } catch (e) { w = null; }
  return {
    ok: !!w,
    sleep: function (ms) {
      if (!w) return new Promise(function (r) { setTimeout(r, ms); });
      return new Promise(function (r) {
        var id = ++seq;
        waiting[id] = r;
        w.postMessage({ id: id, ms: ms });
      });
    }
  };
})();
function sleep(ms) { return timer.sleep(ms); }
function clock() { return new Date().toTimeString().slice(0, 8); }

function txt(el) {
  if (!el) return '';
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return String(el.value || '').trim();
  return String(el.textContent || '').replace(/\s+/g, ' ').trim();
}
function cls(el) {
  var c = el && el.className;
  return typeof c === 'string' ? c : (c && c.baseVal) || '';
}
function visible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  var s = null;
  try { s = win.getComputedStyle(el); } catch (e) { return false; }
  return !!s && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
}
function isPureNum(s) { return /^\d+$/.test(String(s == null ? '' : s).trim()); }
function cellNum(s) { return isPureNum(s) ? parseInt(String(s).trim(), 10) : null; }

/* 「300/161」这种一格两个数：大的是容量，小的是已选。
 * 这样不管系统写成 容量/已选 还是 已选/容量 都能算对，不用让用户去猜顺序。 */
function parsePair(s) {
  var m = String(s == null ? '' : s).match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) return null;
  var a = +m[1], b = +m[2];
  return { cap: Math.max(a, b), taken: Math.min(a, b) };
}
function fmt(v) { return (v === null || v === undefined) ? '?' : v; }
function qsa(root, sel) {
  try { return Array.prototype.slice.call(root.querySelectorAll(sel)); } catch (e) { return []; }
}

var ACTIVE_RE = /(^|[\s_-])(active|current|curr|cur|selected|checked|now|on)([\s_-]|$)/i;

/* 真实点击：先补 pointer/mouse 事件，再走原生 click，兼容 jQuery 与各种前端框架 */
function realClick(el) {
  if (!el) return;
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
  var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  var opt = { bubbles: true, cancelable: true, view: win };
  ['pointerdown', 'mousedown', 'mouseup', 'pointerup'].forEach(function (type) {
    try {
      var Ctor = type.indexOf('pointer') === 0 ? (win.PointerEvent || win.MouseEvent) : win.MouseEvent;
      el.dispatchEvent(new Ctor(type, opt));
    } catch (e) {}
  });
  try { if (typeof el.click === 'function') { el.click(); return; } } catch (e) {}
  try { el.dispatchEvent(new win.MouseEvent('click', opt)); } catch (e) {}
}

/* ============================================================
 * 2. 文档 / iframe 穿透
 * ========================================================== */
function allDocs() {
  var out = [];
  (function walk(win, depth) {
    var doc = null;
    try { doc = win.document; } catch (e) { return; }
    if (!doc || out.indexOf(doc) >= 0) return;
    out.push(doc);
    if (depth >= 4) return;
    qsa(doc, 'iframe,frame').forEach(function (f) {
      try { if (f.contentWindow) walk(f.contentWindow, depth + 1); } catch (e) {}
    });
  })(window.top, 0);
  return out;
}

/* ============================================================
 * 3. 「选课」按钮 / 课程行 / 表格识别
 * ========================================================== */
var BTN_TAGS = 'a,button,input,span,div,i,em,label,td';
var BAD_BTN  = /退课|退选|取消|删除|查看|详情|课表|收藏|已选课程|已满/;
var GOOD_BTN = /^(选课|选\s*课|报名|选修|抢课|加入|添加|选)$/;

function isSelectBtn(el) {
  var t = txt(el);
  if (!t || t.length > 6) return false;
  if (BAD_BTN.test(t)) return false;
  if (!GOOD_BTN.test(t)) return false;
  if (el.disabled) return false;
  if (/disabled|disable|gray|grey/i.test(cls(el))) return false;
  if (!visible(el)) return false;
  var kids = el.children || [];
  for (var i = 0; i < kids.length; i++) if (txt(kids[i]) === t) return false;   // 只保留最内层
  return true;
}
function findSelectBtns(root) { return qsa(root, BTN_TAGS).filter(isSelectBtn); }

/* 挑出真正承载课程列表的 document（可能在 iframe 里） */
function pickDoc() {
  var docs = allDocs();
  var best = null, bestN = -1;
  docs.forEach(function (d) { var n = findSelectBtns(d).length; if (n > bestN) { bestN = n; best = d; } });
  if (bestN <= 0) {
    bestN = -1;
    docs.forEach(function (d) { var n = qsa(d, 'table').length; if (n > bestN) { bestN = n; best = d; } });
  }
  return best || document;
}

function pickTable(doc) {
  var tables = qsa(doc, 'table').filter(visible);
  if (!tables.length) return null;
  var best = null, score = -1;
  tables.forEach(function (t) {
    var rows = qsa(t, 'tr').length;
    var head = txt(t).slice(0, 500);
    var s = rows;
    if (/课程/.test(head)) s += 20;
    if (/容量|余量|已选|人数/.test(head)) s += 20;
    s += findSelectBtns(t).length * 5;
    if (s > score) { score = s; best = t; }
  });
  return best;
}

function getHeaders(table) {
  if (!table) return [];
  var cells = qsa(table, 'thead th, thead td');
  if (!cells.length) {
    var tr = table.querySelector('tr');
    if (tr && tr.querySelectorAll('th').length) cells = Array.prototype.slice.call(tr.children);
  }
  if (!cells.length) {                       // 有些系统表头是独立的一张“固定表头表”
    var p = table.parentElement;
    for (var i = 0; i < 4 && p; i++, p = p.parentElement) {
      var th = p.querySelector('table th');
      if (th && th.closest('tr')) { cells = Array.prototype.slice.call(th.closest('tr').children); break; }
    }
  }
  return cells.map(txt);
}

function rowOf(el) {
  var tr = el.closest ? el.closest('tr') : null;
  if (tr) return tr;
  var node = el;
  for (var i = 0; i < 8 && node && node.parentElement; i++) {
    var p = node.parentElement;
    var sibs = Array.prototype.filter.call(p.children, function (c) { return c.tagName === node.tagName; });
    if (sibs.length >= 2 && txt(node).length >= 12) return node;
    node = p;
  }
  return el.parentElement || el;
}
function rowCells(row) { return Array.prototype.map.call(row.children, txt); }

var H = {
  name:    /课程名称|课程名|教学班名称|^课程$|名称/,
  code:    /课程编号|课程号|课程代码|课程代号|教学班编号|编号|代码/,
  teacher: /教师|任课|主讲|授课/,
  remain:  /余量|剩余|空余|可选人数|剩余容量|余额|可选名额/,
  taken:   /已选|已报|实选|选课人数|报名人数|已选人数/,
  cap:     /容量|上限|限选|限制人数|计划人数|最大人数|人数上限|额定|名额/
};

function parseRow(row, headers) {
  var cells = rowCells(row);
  var all = txt(row);
  // 单元格之间用空格拼，别直接用整行 textContent——相邻两格会粘成
  // 「致真楼50320/20」这种，正则一匹配就全乱了。
  var joined = cells.length ? cells.join(' ') : all;
  var info = { name: '', code: '', teacher: '', cap: null, taken: null, remain: null,
               text: joined, cells: cells, row: row };

  if (headers && headers.length) {
    headers.forEach(function (h, i) {
      var v = cells[i];
      if (v === undefined) return;
      if (!info.name && H.name.test(h)) info.name = v;
      if (!info.code && H.code.test(h)) info.code = v;
      if (!info.teacher && H.teacher.test(h)) info.teacher = v;
      var isRemain = H.remain.test(h);
      var isTaken  = !isRemain && H.taken.test(h);
      var isCap    = !isRemain && !isTaken && H.cap.test(h);
      if (!isRemain && !isTaken && !isCap) return;
      // 「容量」这一列常常写成 300/161 这种一格两个数，先按数对解析
      var pr = parsePair(v);
      if (pr) {
        if (info.cap === null) info.cap = pr.cap;
        if (info.taken === null) info.taken = pr.taken;
        return;
      }
      if (isRemain && info.remain === null) info.remain = cellNum(v);
      if (isTaken  && info.taken  === null) info.taken  = cellNum(v);
      if (isCap    && info.cap    === null) info.cap    = cellNum(v);
    });
  }
  var m;
  if (info.remain === null && (m = all.match(/(?:余量|剩余|空余|可选名额)\D{0,3}(\d+)/))) info.remain = +m[1];
  if (info.cap    === null && (m = all.match(/(?:容量|上限|限选|名额)\D{0,3}(\d+)/)))     info.cap    = +m[1];
  if (info.taken  === null && (m = all.match(/(?:已选|已报)\D{0,3}(\d+)/)))               info.taken  = +m[1];
  if (info.remain === null && info.cap !== null && info.taken !== null) info.remain = info.cap - info.taken;
  // 没表头时的兜底：从右往左找“整格就是 数字/数字”的单元格。
  // 不在整行文字上做正则，否则「上课时间地点」里的 1/2 之类会先被匹配到。
  if (info.remain === null) {
    for (var ci = cells.length - 1; ci >= 0; ci--) {
      var p2 = parsePair(cells[ci]);
      if (p2) { info.cap = p2.cap; info.taken = p2.taken; info.remain = p2.cap - p2.taken; break; }
    }
  }
  // 余量算出负数说明哪一列认错了。宁可报“未知”交给用户判断，
  // 也不能当成“没余量”静默跳过——那样有课也抢不到，而且看不出原因。
  if (info.remain !== null && info.remain < 0) { info.remain = null; info.badParse = true; }
  if (!info.name) {
    var best = '';
    cells.forEach(function (c) {
      if (/[一-龥]/.test(c) && c.length > best.length && c.length < 40) best = c;
    });
    info.name = best;
  }
  info.key = (info.code || '') + '|' + (info.name || '') + '|' + (info.teacher || '');
  info.label = (info.code ? '[' + info.code + '] ' : '') + (info.name || all.slice(0, 24));
  return info;
}

/* ============================================================
 * 4. 分页
 * ========================================================== */
var NEXT_RE  = /^(»|››|>>|>|下一页|下页|后一页|next)$/i;
var FIRST_RE = /^(««|‹‹|<<|首页|第一页|first)$/i;

function findPager(doc) {
  var known = ['.layui-laypage', '.el-pagination', '.pagination', '.pager',
               '[class*=paginat]', '[class*=page-nav]', '[class*=pageBar]', '[class*=pagebar]'];
  for (var i = 0; i < known.length; i++) {
    var e = doc.querySelector ? doc.querySelector(known[i]) : null;
    if (e && visible(e)) return e;
  }
  var marks = qsa(doc, 'a,button,li,span,div').filter(function (el) {
    return visible(el) && NEXT_RE.test(txt(el));
  });
  if (marks.length) {
    var p = marks[0];
    for (var k = 0; k < 5 && p.parentElement; k++) {
      p = p.parentElement;
      var digits = qsa(p, '*').filter(function (el) { return isPureNum(txt(el)); });
      if (digits.length >= 1) return p;
    }
  }
  return null;
}

function currentPage(doc) {
  var pager = findPager(doc);
  if (!pager) return 1;
  var el = qsa(pager, '*').filter(function (e) {
    return visible(e) && isPureNum(txt(e)) && ACTIVE_RE.test(cls(e));
  })[0];
  if (el) return parseInt(txt(el), 10);
  var em = qsa(pager, 'span,em,b,strong').filter(function (e) {
    return visible(e) && isPureNum(txt(e)) && !(e.closest && e.closest('a'));
  })[0];
  if (em) return parseInt(txt(em), 10);
  var inp = pager.querySelector ? pager.querySelector('input') : null;
  if (inp && isPureNum(inp.value)) return parseInt(inp.value, 10);
  return 1;
}

function detectTotalPages() {
  var doc = pickDoc();
  var body = (doc.body && doc.body.innerText) || '';
  var m = body.match(/分\s*(\d+)\s*页/) || body.match(/共\s*(\d+)\s*页/) || body.match(/\/\s*(\d+)\s*页/);
  if (m) return Math.min(cfg.maxPages, Math.max(1, +m[1]));
  var total = body.match(/共\s*(\d+)\s*条/);
  var per = body.match(/每页(?:显示)?\s*(\d+)\s*条/);
  if (total && per && +per[1] > 0) {
    return Math.min(cfg.maxPages, Math.max(1, Math.ceil(+total[1] / +per[1])));
  }
  var pager = findPager(doc);
  if (pager) {
    var nums = qsa(pager, '*').map(txt).filter(isPureNum).map(Number);
    if (nums.length) return Math.min(cfg.maxPages, Math.max.apply(null, nums));
  }
  return 1;
}

function listSig(doc) {
  var t = pickTable(doc);
  var base = t ? txt(t).replace(/\s+/g, '') : '';
  return currentPage(doc) + '#' + base.length + '#' + base.slice(0, 300);
}

function loadingNow() {
  var docs = allDocs();
  for (var i = 0; i < docs.length; i++) {
    var list = qsa(docs[i], '.layui-layer-loading,.el-loading-mask,.ant-spin-spinning,[class*=loading],[class*=Loading]');
    for (var j = 0; j < list.length; j++) if (visible(list[j])) return true;
  }
  return false;
}

/* 等列表刷新完成。
 * 不能只靠“内容变了”来判断——重新查询后余量可能一模一样，那样每轮都要白等到超时。
 * 所以主判据是 DOM 重绘（MutationObserver），内容签名只作兜底。 */
async function waitUpdate(sig, timeout) {
  timeout = timeout || 6000;
  var doc = pickDoc();
  var table = pickTable(doc);
  var root = (table && table.parentElement) || doc.body || doc.documentElement;
  var mutated = false, obs = null;
  try {
    var MO = (doc.defaultView && doc.defaultView.MutationObserver) || window.MutationObserver;
    obs = new MO(function () { mutated = true; });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
  } catch (e) {}
  var t0 = Date.now(), ok = false;
  while (Date.now() - t0 < timeout) {
    await sleep(100);
    if (loadingNow()) continue;
    if (mutated || listSig(pickDoc()) !== sig) { ok = true; break; }
  }
  if (obs) { try { obs.disconnect(); } catch (e) {} }
  await sleep(250);                       // 等重绘稳定
  return ok;
}

async function gotoPage(p) {
  var doc = pickDoc();
  if (currentPage(doc) === p) return true;
  var pager = findPager(doc);
  if (!pager) return false;
  var sig = listSig(doc);
  var hits = qsa(pager, 'a,button,li,span,div').filter(function (e) {
    return visible(e) && txt(e) === String(p);
  });
  if (hits.length) {
    realClick(hits[hits.length - 1]);          // 最后一个 = 最内层可点元素
  } else {
    var next = qsa(pager, 'a,button,li,span,div').filter(function (e) {
      return visible(e) && NEXT_RE.test(txt(e));
    })[0];
    if (!next) return false;
    realClick(next);
  }
  var changed = await waitUpdate(sig, 8000);
  return changed || currentPage(pickDoc()) === p;
}

function findQueryBtn(doc) {
  return qsa(doc, 'a,button,input,span,div').filter(function (e) {
    var t = txt(e);
    if (!/^(查询|搜索|检索|刷新|重新查询)$/.test(t)) return false;
    if (!visible(e)) return false;
    var kids = e.children || [];
    for (var i = 0; i < kids.length; i++) if (txt(kids[i]) === t) return false;
    return true;
  })[0] || null;
}

function sessionLost() {
  var docs = allDocs();
  for (var i = 0; i < docs.length; i++) {
    var t = (docs[i].body && docs[i].body.innerText || '').slice(0, 600);
    if (/统一身份认证|请重新登录|会话超时|登录超时|登录已失效|用户登录/.test(t)) return true;
  }
  return false;
}

/* 每轮开始：把列表刷新一次并回到第 1 页 */
async function refreshList() {
  if (sessionLost()) { log('检测到登录已失效，请重新登录后再开始', 'err'); stop(); throw new Error('session-lost'); }
  await clearBlockingDialogs(3);          // 上一轮可能留下没关的弹窗，先清干净再动
  var doc = pickDoc();
  var sig = listSig(doc);
  var q = findQueryBtn(doc);
  if (q) { realClick(q); await waitUpdate(sig, 8000); return 'query'; }
  if (currentPage(doc) !== 1) { await gotoPage(1); return 'page1'; }
  var pager = findPager(doc);
  if (pager) {
    var first = qsa(pager, 'a,button,li,span,div').filter(function (e) {
      return visible(e) && FIRST_RE.test(txt(e));
    })[0];
    if (first) { realClick(first); await waitUpdate(sig, 8000); return 'first'; }
  }
  return 'none';
}

/* ============================================================
 * 5. 弹窗确认 / 系统提示
 * ========================================================== */
var CONFIRM_SEL = ['.layui-layer-btn0', '.el-message-box__btns .el-button--primary',
                   '.ant-modal-confirm-btns .ant-btn-primary', '.modal.in .btn-primary',
                   '.modal.show .btn-primary', '.ui-dialog-buttonpane button',
                   '.bui-dialog-footer .bui-btn-primary'];
var CONFIRM_TXT = /^(确定|确认|是|好的|好|提交|OK|Yes)$/i;

function findConfirmBtn(doc) {
  for (var i = 0; i < CONFIRM_SEL.length; i++) {
    var e = doc.querySelector ? doc.querySelector(CONFIRM_SEL[i]) : null;
    if (e && visible(e)) return e;
  }
  var cands = qsa(doc, 'a,button,span,div,input').filter(function (el) {
    if (!visible(el)) return false;
    if (!CONFIRM_TXT.test(txt(el))) return false;
    var kids = el.children || [];
    for (var k = 0; k < kids.length; k++) if (txt(kids[k]) === txt(el)) return false;
    var p = el, hit = false;
    for (var d = 0; d < 8 && p; d++, p = p.parentElement) {
      var c = cls(p) + ' ' + (p.id || '');
      if (/layer|modal|dialog|popup|confirm|mask|window|msgbox/i.test(c)) { hit = true; break; }
    }
    return hit;
  });
  return cands[0] || null;
}

async function clickConfirm(timeout) {
  timeout = timeout || 2500;
  var t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    var docs = allDocs();
    for (var i = 0; i < docs.length; i++) {
      var b = findConfirmBtn(docs[i]);
      if (b) { realClick(b); await sleep(200); return true; }
    }
    await sleep(120);
  }
  return false;
}

/* 结果可能是轻提示，也可能是一个带「确定」的模态框（深大研选课的“选课失败！”就是模态框），
 * 所以这里把弹层容器也一并纳入扫描范围。 */
var MSG_SEL = '.layui-layer-msg,.layui-layer-dialog,.el-message,.el-message__content,' +
              '.ant-message-notice-content,.toast,[role=alert],[role=dialog],[class*=message],' +
              '[class*=notice],[class*=alert],[class*=toast],[class*=tips],' +
              '[class*=dialog],[class*=modal],[class*=layer],[class*=popup],[class*=msgbox]';
/* 只留结果类字眼。别把「人数」「学分」这种放进来，
 * 否则确认框里的课程名一旦带上就会被误判成结果。 */
var MSG_HINT = /成功|失败|已满|冲突|已经|不能|不允许|超过|无法|错误|不满足|已达|重复|请勿/;
var CANCEL_TXT = /^(取消|关闭|×|✕|Cancel|我知道了|知道了)$/i;
/* 结构性失败：再抢多少次也不会成 */
var HARD_FAIL = /冲突|已经选|已选过|重复|学分|不满足|不允许|无权|未开放|不在选课时间|已达上限|先修/;

/* 弹层文本里混着关闭符和按钮文字，清一下再往日志里写 */
function cleanMsg(t) {
  return String(t == null ? '' : t)
    .replace(/[✕✖×╳]/g, ' ')
    .replace(/\s*(确定|确认|取消|关闭|我知道了|知道了)\s*$/g, '')
    .replace(/\s+/g, ' ').trim();
}

function msgTexts() {
  var out = [];
  allDocs().forEach(function (d) {
    qsa(d, MSG_SEL).forEach(function (e) {
      if (!visible(e)) return;
      var t = txt(e);
      if (t && t.length <= 120) out.push(t);
    });
  });
  return out;
}

function btnIn(root, re) {
  return qsa(root, 'a,button,span,div,input,i').filter(function (el) {
    if (!visible(el)) return false;
    if (!re.test(txt(el))) return false;
    var kids = el.children || [];
    for (var k = 0; k < kids.length; k++) if (txt(kids[k]) === txt(el)) return false;
    return true;
  })[0] || null;
}

function visibleDialogs(doc) {
  return qsa(doc, '[class*=dialog],[class*=modal],[class*=layer],[class*=popup],[class*=msgbox],[role=dialog]')
    .filter(function (e) {
      if (!visible(e)) return false;
      var r = e.getBoundingClientRect();
      return r.width > 120 && r.height > 60;
    });
}

/* 清掉挡路的弹窗。结果框（选课失败！）点「确定」关掉；其它框点「取消/关闭」。
 * 绝不在这里点确认框的「确定」——那会选到没打算选的课。
 * 不清的话遮罩会一直盖着，后面所有点击全部作废。 */
async function clearBlockingDialogs(rounds) {
  var cleared = 0;
  for (var n = 0; n < (rounds || 3); n++) {
    var acted = false;
    var docs = allDocs();
    for (var i = 0; i < docs.length && !acted; i++) {
      var dlgs = visibleDialogs(docs[i]);
      for (var j = 0; j < dlgs.length; j++) {
        var t = txt(dlgs[j]);
        if (!t) continue;
        var btn = MSG_HINT.test(t) ? btnIn(dlgs[j], CONFIRM_TXT) : null;
        if (!btn) btn = btnIn(dlgs[j], CANCEL_TXT);
        if (btn) { realClick(btn); acted = true; cleared++; break; }
      }
    }
    if (!acted) break;
    await sleep(250);
  }
  return cleared;
}
async function waitMessage(before, timeout) {
  var t0 = Date.now();
  while (Date.now() - t0 < (timeout || 3500)) {
    var list = msgTexts();
    for (var i = 0; i < list.length; i++) {
      if (before.has(list[i])) continue;
      if (MSG_HINT.test(list[i])) return cleanMsg(list[i]);
    }
    await sleep(120);
  }
  return '';
}

/* ============================================================
 * 6. 抢课主逻辑
 * ========================================================== */
function splitKw(s) {
  return String(s || '').split(/[,，;；\s|]+/).map(function (x) { return x.trim(); }).filter(Boolean);
}
function matchTarget(info) {
  var s = (info.text || '').toLowerCase();
  var ex = splitKw(cfg.exclude);
  for (var i = 0; i < ex.length; i++) if (s.indexOf(ex[i].toLowerCase()) >= 0) return false;
  if (cfg.mode === 'all') return true;
  var inc = splitKw(cfg.include);
  if (!inc.length) return false;
  for (var j = 0; j < inc.length; j++) if (s.indexOf(inc[j].toLowerCase()) >= 0) return true;
  return false;
}

/* 抓不到提示文字时的兜底判定。选上之后系统有两种表现：
 *   a) 那一行的「选课」变成「退课」
 *   b) 那门课直接从可选列表里消失（挪到「已选课程」里去了）
 * 而且系统会重绘整张表，旧的 row 节点已经脱离 DOM，所以必须按课程名重新找。
 * pageBefore 用来防误判：如果页码变了，就不能凭「找不到」断定选上了。 */
function looksGrabbed(info, pageBefore) {
  if (!info.name) return false;
  var doc = pickDoc();
  var rows = qsa(doc, 'tr');
  if (!rows.length) return false;                 // 列表都没了，判断不了，当失败
  var hit = false, stillSelectable = false;
  for (var i = 0; i < rows.length; i++) {
    var t = rowCells(rows[i]).join(' ');
    if (t.indexOf(info.name) < 0) continue;
    hit = true;
    if (/退课|退选/.test(t)) return true;          // a) 明确变成退课
    if (findSelectBtns(rows[i]).length) stillSelectable = true;
  }
  if (hit) return !stillSelectable;               // 还在列表里但已经不能选了
  if (currentPage(doc) !== pageBefore) return false;   // 翻页了，「找不到」说明不了什么
  return findSelectBtns(doc).length > 0;          // b) 列表正常但这门课没了 → 选上了
}

async function tryGrab(info, btn) {
  var rm = info.remain === null ? '未知' : info.remain;
  if (cfg.dryRun) { log('【试运行】可选：' + info.label + '（余量 ' + rm + '）不会真的点击', 'ok'); return 'dry'; }
  log('发现余量 ' + rm + '，点击选课：' + info.label);
  var before = new Set(msgTexts());
  var pageBefore = currentPage(pickDoc());
  realClick(btn);
  await sleep(250);
  if (cfg.autoConfirm) await clickConfirm();
  var msg = await waitMessage(before, cfg.msgWait);
  var ok = false, failed = false;
  if (msg) {
    ok = /成功/.test(msg) && !/失败|不成功/.test(msg);
    failed = !ok;
    log('系统提示：' + msg, ok ? 'ok' : 'warn');
  }
  // 读完提示必须把结果框关掉，否则遮罩会挡住后面的一切操作
  await clearBlockingDialogs(2);
  await sleep(350);
  // 系统已经明说失败了就别再用 DOM 兜底翻案，只有没抓到提示时才猜
  if (!ok && !failed) ok = looksGrabbed(info, pageBefore);
  if (ok) { onSuccess(info); return 'ok'; }
  // 「容量已满」值得一直抢；冲突、学分超限这类再试多少次也是白试，本次运行内跳过
  if (msg && HARD_FAIL.test(msg) && !/已满|容量|人数/.test(msg)) {
    skip.add(info.key);
    log('这门课不是名额问题，本次运行不再重试：' + info.label, 'warn');
  }
  if (!msg) log('没抓到系统提示，按失败处理，下一轮继续：' + info.label, 'warn');
  await sleep(cfg.clickGap);
  return 'fail';
}

function onSuccess(info) {
  done.add(info.key);
  stats.got++;
  setStat('szg-got', stats.got);
  log('★ 选课成功：' + info.label, 'ok');
  beep(); notify('选课成功', info.label); flashTitle();
  if (cfg.stopOnDone) { log('已开启「抢到就停止」，任务结束'); stop(); }
}

function unknownWarn(info) {
  if (warned.has(info.key)) return;
  warned.add(info.key);
  log((info.badParse ? '余量算出负数，说明容量/已选两列认反或错位了，已跳过：'
                     : '识别不到余量，已跳过：') + info.label +
      '（可勾选「余量识别不到也点」，或把诊断日志发我调参）', 'warn');
}

/* 返回本页扫到的候选课程数（0 表示这一页没有可选的课，属正常情况，不单独刷日志） */
async function grabCurrentPage(pageNo) {
  var doc = pickDoc();
  var table = pickTable(doc);
  var headers = getHeaders(table);
  var btns = findSelectBtns(doc);
  if (!btns.length) return 0;
  var found = 0;
  var seen = new Set();
  for (var i = 0; i < btns.length; i++) {
    if (!running) return found;
    var b = btns[i];
    if (!b.isConnected) continue;
    var row = rowOf(b);
    if (seen.has(row)) continue;
    seen.add(row);
    var info = parseRow(row, headers);
    if (done.has(info.key) || skip.has(info.key)) continue;
    if (!matchTarget(info)) continue;
    found++;
    if (info.remain !== null && info.remain > 0) roundStat.avail++;
    if (info.remain !== null && info.remain <= 0) continue;
    if (info.remain === null && !cfg.clickUnknown) { unknownWarn(info); continue; }
    var res = await tryGrab(info, b);
    if (res === 'ok') return found;           // 选上之后列表通常会重绘，交给下一轮重新扫
    if (!running) return found;
  }
  return found;
}

var emptyRounds = 0;
var roundStat = { avail: 0 };
async function scanAllPages() {
  var total = detectTotalPages();
  setStat('szg-pages', total);
  var found = 0;
  roundStat.avail = 0;
  for (var p = 1; p <= total; p++) {
    if (!running) return;
    if (p > 1) {
      // 抢到一门后列表会变短，页数可能已经不够了。不重新数一遍就会去点一个
      // 根本不存在的页码，然后干等到超时。
      var nowTotal = detectTotalPages();
      if (p > nowTotal) { setStat('szg-pages', nowTotal); break; }
      var ok = await gotoPage(p);
      if (!ok) { log('翻到第 ' + p + ' 页失败，跳过本页', 'warn'); continue; }
    }
    found += await grabCurrentPage(p);
    if (!running) return;
    await sleep(cfg.pageGap);
  }
  // 第一轮报一下家底，省得干等着不知道它到底扫到了什么
  if (stats.round === 1) {
    log('首轮扫完 ' + total + ' 页：符合条件 ' + found + ' 门，其中有余量 ' + roundStat.avail + ' 门', 'ok');
  }
  // 整轮一门候选课都没有：多半是筛选条件没选、关键词写错或课都选完了，隔一阵提醒一次
  if (found === 0) {
    if (emptyRounds % 10 === 0) {
      log('本轮 ' + total + ' 页里没有符合条件的待选课程（第 ' + (stats.round) + ' 轮）', 'warn');
    }
    emptyRounds++;
  } else emptyRounds = 0;
}

async function mainLoop() {
  var errs = 0;
  while (running) {
    stats.round++;
    setStat('szg-round', stats.round);
    try {
      await refreshList();
      await scanAllPages();
      errs = 0;
    } catch (e) {
      if (String(e && e.message) === 'session-lost') break;
      errs++;
      log('异常：' + (e && e.message ? e.message : e), 'err');
      if (errs >= 5) { log('连续异常过多，已自动停止', 'err'); stop(); break; }
    }
    if (!running) break;
    await sleep(Math.max(500, cfg.interval) + Math.floor(Math.random() * 300));
  }
}

/* ============================================================
 * 7. 提醒
 * ========================================================== */
function beep() {
  if (!cfg.sound) return;
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    var ctx = new Ctx();
    [0, 0.22, 0.44].forEach(function (t) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
    });
    setTimeout(function () { try { ctx.close(); } catch (e) {} }, 1500);
  } catch (e) {}
}
function notify(title, body) {
  try {
    if (window.Notification && Notification.permission === 'granted') new Notification(title, { body: body });
  } catch (e) {}
}
var titleTimer = null;
function flashTitle() {
  if (titleTimer) return;
  var orig = document.title, on = false, n = 0;
  titleTimer = setInterval(function () {
    document.title = (on = !on) ? '★★ 抢到课了 ★★' : orig;
    if (++n > 40) { clearInterval(titleTimer); titleTimer = null; document.title = orig; }
  }, 600);
}

/* ============================================================
 * 8. 诊断 / 每页条数
 * ========================================================== */
function diag() {
  log('──── 诊断开始 ────');
  var docs = allDocs();
  log('文档数(含 iframe)：' + docs.length);
  var doc = pickDoc();
  var btns = findSelectBtns(doc);
  log('「选课」按钮：' + btns.length + ' 个' +
      (btns[0] ? '（示例 <' + btns[0].tagName.toLowerCase() + '> 文本「' + txt(btns[0]) + '」）' : ''));
  var table = pickTable(doc);
  log('课程表格：' + (table ? '已找到，共 ' + qsa(table, 'tr').length + ' 行' : '未找到'));
  var headers = getHeaders(table);
  log('表头：' + (headers.length ? headers.join(' | ') : '未识别到'));
  var pager = findPager(doc);
  log('分页控件：' + (pager ? '已找到「' + txt(pager).slice(0, 60) + '」，当前第 ' + currentPage(doc) + ' 页' : '未找到'));
  log('总页数：' + detectTotalPages());
  log('查询/刷新按钮：' + (findQueryBtn(doc) ? '已找到' : '未找到（每轮将靠翻页刷新）'));

  var rows = [], seen = new Set();
  btns.slice(0, 80).forEach(function (b) {
    var r = rowOf(b);
    if (seen.has(r)) return;
    seen.add(r);
    rows.push(parseRow(r, headers));
  });
  log('本页课程 ' + rows.length + ' 条，前 5 条解析结果：');
  rows.slice(0, 5).forEach(function (r, i) {
    log('  ' + (i + 1) + '. ' + (r.code || '-') + ' ' + (r.name || '-') +
        ' | 教师 ' + (r.teacher || '-') +
        ' | 容量 ' + fmt(r.cap) + ' 已选 ' + fmt(r.taken) + ' 余量 ' + fmt(r.remain) +
        ' | 匹配 ' + (matchTarget(r) ? '是' : '否'));
  });
  var bad = rows.filter(function (r) { return r.remain === null; }).length;
  if (bad) log('⚠ 有 ' + bad + ' 条识别不到余量，请把日志复制发我调参', 'warn');
  else if (rows.length) log('✔ 余量识别正常，可以开始', 'ok');
  log('──── 诊断结束（点「复制日志」可整段复制）────');
}

function setPageSizeMax() {
  var doc = pickDoc();
  var sels = qsa(doc, 'select').filter(function (s) {
    if (!visible(s)) return false;
    var opts = Array.prototype.slice.call(s.options || []);
    return opts.length >= 2 && opts.every(function (o) { return isPureNum(o.value || txt(o)); });
  });
  if (!sels.length) { log('没找到「每页条数」下拉框，可手动把每页条数调到最大以减少翻页', 'warn'); return; }
  var s = sels[0], max = null;
  Array.prototype.slice.call(s.options).forEach(function (o) {
    var v = parseInt(o.value || txt(o), 10);
    if (!isNaN(v) && (max === null || v > max)) max = v;
  });
  s.value = String(max);
  try { s.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
  try { s.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
  log('已把每页条数设为 ' + max + '（若无效请手动在页面上选一次）', 'ok');
}

/* ============================================================
 * 9. 面板 UI
 * ========================================================== */
var CSS = [
'#szg-panel{position:fixed;right:16px;top:16px;z-index:2147483647;width:340px;',
'font:12px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e6edf3;',
'background:#0f1720;border:1px solid #2a3746;border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.5);overflow:hidden}',
'#szg-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;',
'background:#16212c;border-bottom:1px solid #2a3746;cursor:move;font-weight:600;user-select:none}',
'#szg-head span{cursor:pointer;padding:0 6px;color:#8aa0b4}',
'#szg-body{padding:10px}',
'#szg-panel.szg-collapsed #szg-body{display:none}',
'.szg-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}',
'.szg-row>label{width:34px;flex:none;color:#8aa0b4}',
'.szg-row input,.szg-row select{flex:1;min-width:0;background:#0b1219;color:#e6edf3;',
'border:1px solid #2a3746;border-radius:5px;padding:3px 6px;font-size:12px;outline:none}',
'.szg-row input:focus,.szg-row select:focus{border-color:#3b82f6}',
'.szg-row.szg-w>label{width:58px}',
'.szg-adv-head{color:#7fa5cc;cursor:pointer;user-select:none;margin:4px 0 6px;font-size:11.5px}',
'.szg-adv-head:hover{color:#9dc0e0}',
'.szg-tiny{color:#7d90a3;font-size:10.5px;line-height:1.5;margin:-2px 0 6px}',
'.szg-checks{display:grid;grid-template-columns:1fr 1fr;gap:2px 6px;margin:8px 0}',
'.szg-checks label{display:flex;align-items:center;gap:4px;color:#b9c8d6;cursor:pointer;font-size:11.5px}',
'.szg-checks input{accent-color:#3b82f6}',
'.szg-btns{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}',
'.szg-btns button{flex:1;min-width:64px;background:#1e2a37;color:#dbe6f0;border:1px solid #33475c;',
'border-radius:5px;padding:5px 6px;cursor:pointer;font-size:12px}',
'.szg-btns button:hover{background:#27384a}',
'.szg-btns button.szg-primary{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}',
'.szg-btns button.szg-primary:hover{background:#1d4ed8}',
'.szg-badge{display:inline-block;padding:1px 7px;border-radius:9px;background:#3a4756;font-size:11px}',
'.szg-badge.szg-run{background:#16a34a}',
'.szg-dim{color:#8aa0b4;font-size:11px;margin-left:auto}',
'#szg-log{height:170px;overflow:auto;background:#0a1017;border:1px solid #22303e;border-radius:6px;',
'padding:6px;font:11px/1.55 Consolas,Menlo,monospace;white-space:pre-wrap;word-break:break-all}',
'#szg-log .szg-ok{color:#4ade80}#szg-log .szg-warn{color:#fbbf24}#szg-log .szg-err{color:#f87171}',
'#szg-tip{color:#7d90a3;font-size:11px;margin-top:6px}'
].join('');

var HTML = [
'<div id="szg-head">深大研选课 · 自动抢课<span id="szg-min">—</span></div>',
'<div id="szg-body">',
'<div class="szg-row"><span class="szg-badge" id="szg-state">已停止</span>',
'<span class="szg-dim">轮次 <b id="szg-round">0</b> · 分页 <b id="szg-pages">?</b> · 抢到 <b id="szg-got">0</b></span></div>',
'<div class="szg-row"><label>模式</label><select id="szg-mode">',
'<option value="all">所有有余量的课</option><option value="include">仅关键词匹配</option></select></div>',
'<div class="szg-row"><label>包含</label><input id="szg-inc" placeholder="课程名/课程号/老师，逗号分隔"></div>',
'<div class="szg-row"><label>排除</label><input id="szg-exc" placeholder="不想要的关键词，可留空"></div>',
'<div class="szg-row"><label>间隔</label><input id="szg-int" type="number" min="500" step="100"><span class="szg-dim">毫秒/轮</span></div>',
'<div class="szg-adv-head" id="szg-adv-btn">▸ 时间微调</div>',
'<div id="szg-adv" hidden>',
'<div class="szg-row szg-w"><label>翻页停顿</label><input id="szg-pgap" type="number" min="0" step="50"><span class="szg-dim">ms</span></div>',
'<div class="szg-row szg-w"><label>换课停顿</label><input id="szg-cgap" type="number" min="0" step="50"><span class="szg-dim">ms</span></div>',
'<div class="szg-row szg-w"><label>等提示</label><input id="szg-mwait" type="number" min="500" step="100"><span class="szg-dim">ms</span></div>',
'<div class="szg-tiny">「等提示」是点完选课后最多等多久来判断成没成。调小了跑得快，但可能没等到结果就当失败；网慢就调大。</div>',
'</div>',
'<div class="szg-checks">',
'<label><input type="checkbox" id="szg-confirm">自动确认弹窗</label>',
'<label><input type="checkbox" id="szg-unknown">余量认不出也点</label>',
'<label><input type="checkbox" id="szg-stopdone">抢到就停止</label>',
'<label><input type="checkbox" id="szg-sound">声音提醒</label>',
'<label><input type="checkbox" id="szg-dry">试运行(不点击)</label>',
'</div>',
'<div class="szg-btns">',
'<button id="szg-scan">扫描诊断</button>',
'<button id="szg-size">每页最大</button>',
'<button id="szg-copy">复制日志</button>',
'</div>',
'<div class="szg-btns">',
'<button id="szg-start" class="szg-primary">开始抢课</button>',
'<button id="szg-stop">停止</button>',
'</div>',
'<div id="szg-log"></div>',
'<div id="szg-tip">首次使用请先点「扫描诊断」，确认表头和余量识别正确再开始。</div>',
'</div>'
].join('');

var panel = null;

function log(msg, type) {
  var line = '[' + clock() + '] ' + msg;
  logs.push(line);
  if (logs.length > 600) logs.shift();
  var box = document.getElementById('szg-log');
  if (box) {
    var d = document.createElement('div');
    if (type) d.className = 'szg-' + type;
    d.textContent = line;
    box.appendChild(d);
    while (box.childNodes.length > 300) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }
  try { console.log('%c[抢课]', 'color:#3b82f6', msg); } catch (e) {}
}
function setStat(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
function setState(on) {
  var e = document.getElementById('szg-state');
  if (!e) return;
  e.textContent = on ? '运行中' : '已停止';
  e.className = 'szg-badge' + (on ? ' szg-run' : '');
}

function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
/* 读一个数字输入框：空的或乱填的回落到默认值，超范围的夹回去，并把结果写回框里 */
function clampNum(el, lo, hi, dflt) {
  var v = parseInt(el.value, 10);
  if (isNaN(v)) v = dflt;
  v = Math.min(hi, Math.max(lo, v));
  el.value = v;
  return v;
}

function readCfg() {
  var g = function (id) { return document.getElementById(id); };
  cfg.mode = g('szg-mode').value;
  cfg.include = g('szg-inc').value;
  cfg.exclude = g('szg-exc').value;
  cfg.interval = Math.max(500, parseInt(g('szg-int').value, 10) || DEFAULT_CFG.interval);
  g('szg-int').value = cfg.interval;
  cfg.pageGap  = clampNum(g('szg-pgap'),  0,   10000, DEFAULT_CFG.pageGap);
  cfg.clickGap = clampNum(g('szg-cgap'),  0,   10000, DEFAULT_CFG.clickGap);
  cfg.msgWait  = clampNum(g('szg-mwait'), 500, 20000, DEFAULT_CFG.msgWait);
  cfg.autoConfirm = g('szg-confirm').checked;
  cfg.clickUnknown = g('szg-unknown').checked;
  cfg.stopOnDone = g('szg-stopdone').checked;
  cfg.sound = g('szg-sound').checked;
  cfg.dryRun = g('szg-dry').checked;
  saveCfg();
}
function fillCfg() {
  var g = function (id) { return document.getElementById(id); };
  g('szg-mode').value = cfg.mode;
  g('szg-inc').value = cfg.include;
  g('szg-exc').value = cfg.exclude;
  g('szg-int').value = cfg.interval;
  g('szg-pgap').value = cfg.pageGap;
  g('szg-cgap').value = cfg.clickGap;
  g('szg-mwait').value = cfg.msgWait;
  g('szg-confirm').checked = cfg.autoConfirm;
  g('szg-unknown').checked = cfg.clickUnknown;
  g('szg-stopdone').checked = cfg.stopOnDone;
  g('szg-sound').checked = cfg.sound;
  g('szg-dry').checked = cfg.dryRun;
}

function start() {
  if (running) { log('已经在运行了'); return; }
  readCfg();
  if (cfg.mode === 'include' && !splitKw(cfg.include).length) {
    log('「仅关键词匹配」模式下必须填写包含关键词', 'err');
    return;
  }
  running = true;
  stats.round = 0;
  setState(true);
  log('开始运行 · 模式=' + (cfg.mode === 'all' ? '所有有余量的课' : '关键词[' + cfg.include + ']') +
      ' · 间隔=' + cfg.interval + 'ms' + (cfg.dryRun ? ' · 试运行' : ''), 'ok');
  if (!timer.ok) log('提示：本页拿不到 Worker 定时器，切到后台标签页会被浏览器限速，建议保持本页在前台', 'warn');
  try {
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
  } catch (e) {}
  mainLoop();
}
function stop() {
  if (!running) { setState(false); return; }
  running = false;
  setState(false);
  log('已停止');
}

function buildPanel() {
  var style = document.createElement('style');
  style.textContent = CSS;
  document.documentElement.appendChild(style);

  panel = document.createElement('div');
  panel.id = 'szg-panel';
  panel.innerHTML = HTML;
  (document.body || document.documentElement).appendChild(panel);

  fillCfg();
  var g = function (id) { return document.getElementById(id); };
  g('szg-start').onclick = start;
  g('szg-stop').onclick = stop;
  g('szg-scan').onclick = function () { readCfg(); diag(); };
  g('szg-size').onclick = setPageSizeMax;
  g('szg-copy').onclick = function () {
    var text = logs.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { log('日志已复制到剪贴板', 'ok'); },
                                               function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  };
  g('szg-min').onclick = function () { panel.classList.toggle('szg-collapsed'); };
  g('szg-adv-btn').onclick = function () {
    var box = g('szg-adv');
    box.hidden = !box.hidden;
    this.textContent = (box.hidden ? '▸' : '▾') + ' 时间微调';
  };
  ['szg-mode', 'szg-inc', 'szg-exc', 'szg-int', 'szg-pgap', 'szg-cgap', 'szg-mwait',
   'szg-confirm', 'szg-unknown', 'szg-stopdone', 'szg-sound', 'szg-dry'].forEach(function (id) {
    var e = g(id);
    if (e) e.onchange = readCfg;
  });

  // 拖动
  var head = g('szg-head'), drag = null;
  head.addEventListener('mousedown', function (ev) {
    if (ev.target.id === 'szg-min') return;
    var r = panel.getBoundingClientRect();
    drag = { x: ev.clientX, y: ev.clientY, l: r.left, t: r.top };
    ev.preventDefault();
  });
  window.addEventListener('mousemove', function (ev) {
    if (!drag) return;
    panel.style.left = (drag.l + ev.clientX - drag.x) + 'px';
    panel.style.top = (drag.t + ev.clientY - drag.y) + 'px';
    panel.style.right = 'auto';
  });
  window.addEventListener('mouseup', function () { drag = null; });
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); log('日志已复制到剪贴板', 'ok'); }
  catch (e) { log('复制失败，请手动选中日志区文字', 'err'); }
  document.body.removeChild(ta);
}

/* ============================================================
 * 10. 启动
 * ========================================================== */
/* 作为 Edge/Chrome 扩展安装时，内容脚本匹配整个 ehall 域（因为选课页可能被门户套在 iframe 里，
 * 顶层地址不一定带 xkapp）。所以这里再判断一次：只有确实是选课相关页面才挂面板。
 * 装成油猴脚本时 @match 已经限定了范围，这个判断会立刻通过。 */
function isCoursePage() {
  try { if (/xkapp/i.test(location.href)) return true; } catch (e) {}
  var docs = allDocs();
  for (var i = 0; i < docs.length; i++) {
    try { if (/xkapp/i.test(docs[i].location.href)) return true; } catch (e) {}
  }
  return findSelectBtns(pickDoc()).length > 0;   // 地址认不出来时，看页面上有没有选课按钮
}

function mount() {
  buildPanel();
  log('助手已加载。先点「扫描诊断」核对识别结果，再点「开始抢课」。');
  window.__SZU_GRAB__ = {
    start: start,
    stop: stop,
    diag: diag,
    cfg: cfg,
    show: function () { if (panel) { panel.style.display = ''; panel.classList.remove('szg-collapsed'); } }
  };
}

/* iframe 可能还没加载完，隔一会儿重试几次 */
(function boot(tries) {
  if (window.__SZU_GRAB__) return;
  if (isCoursePage()) { mount(); return; }
  if (tries > 0) setTimeout(function () { boot(tries - 1); }, 1500);
})(20);

})();
