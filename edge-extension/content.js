// ==UserScript==
// @name         深大研究生选课 · 自动抢课助手
// @namespace    szu-yjsxkapp-auto-grab
// @version      1.1.0
// @description  轮询研究生选课系统的全部分页，发现余量立刻点击“选课”；支持关键词过滤 / 自动确认弹窗 / 掉线自动重登（大模型识别验证码）/ 成功提醒
// @author       -
// @match        https://ehall.szu.edu.cn/yjsxkapp/*
// @match        https://ehall.szu.edu.cn/xsxkapp/*
// @run-at       document-idle
// 调大模型接口要跨域，@grant none 下只能用页面的 fetch，会被 CORS 挡死。
// 换成 GM_xmlhttpRequest 并在 @connect 里放行各家服务商；自定义接口请自行加一行 @connect。
// @grant        GM_xmlhttpRequest
// @connect      open.bigmodel.cn
// @connect      dashscope.aliyuncs.com
// @connect      api.siliconflow.cn
// @connect      api.openai.com
// ==/UserScript==

(function () {
'use strict';

if (window.self !== window.top) return;              // 只在顶层挂面板，iframe 由顶层穿透操作
if (window.__SZU_GRAB__) { window.__SZU_GRAB__.show(); return; }
/* 上面那行只挡得住同一个执行环境里的重复加载。加了 @grant 之后油猴脚本跑在沙箱 window 里，
 * 跟扩展、跟页面都不共享 window，两边都会觉得自己是第一个，于是挂出两个面板。
 * DOM 是三边都看得见的，所以再按面板元素查一次。 */
if (document.getElementById('szg-panel')) return;

/* ============================================================
 * 0. 配置
 * ========================================================== */
var DEFAULT_CFG = {
  mode: 'all',              // all = 所有有余量的课 | include = 仅关键词匹配
  include: '',
  exclude: '',
  interval: 1200,           // 每轮间隔下限(ms)
  intervalMax: 2500,        // 每轮间隔上限(ms)，在下限~上限之间随机取
  pageGap: 400,             // 翻页之间的间隔(ms)
  clickGap: 500,            // 一门课失败后，隔多久点下一门(ms)
  msgWait: 3500,            // 点完最多等多久判断成败(ms)
  maxPages: 30,             // 最多翻多少页，防跑飞
  autoConfirm: true,        // 自动点确认弹窗
  clickUnknown: false,      // 余量识别不出来时也点一下
  stopOnDone: false,        // 抢到一门就停
  sound: true,
  autoResume: true,         // 掉线重新登录后自动接着抢
  dryRun: false,            // 试运行：只报告不点击
  autoLogin: false,         // 掉线后自动填账号密码、让大模型认验证码并登录（填好凭据再勾）
  ocrProvider: 'silicon',   // 认验证码用哪家，见 OCR_PRESETS
  ocrUrl: '',               // 留空 = 用所选服务商的默认地址
  ocrModel: '',             // 留空 = 用所选服务商的默认模型
  ocrMaxTry: 8,             // 一次掉线里最多重试几轮登录（验证码认错就换一张重来）
  ocrVote: 2,               // 一张验证码用几种处理交叉验证（1=不验证，最多 3）
  stallSec: 25              // 列表连续转圈超过这么多秒，就按掉线处理
};
var CFG_KEY = 'szg_cfg_v1';
var cfg = Object.assign({}, DEFAULT_CFG);
try { Object.assign(cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch (e) {}

/* 登录页和选课页。掉线后要自己跳回去，写死在这儿。 */
var LOGIN_URL = 'https://ehall.szu.edu.cn/yjsxkapp/sys/xsxkapp/*default/index.do';
var COURSE_URL = 'https://ehall.szu.edu.cn/yjsxkapp/sys/xsxkapp/xsxkHome/gotoChooseCourse.do';

/* 只有确实站在学校域名上时才允许自己跳转。
 * test/ 下的仿真页也会加载这份脚本，没这道闸门的话，一测到“登录成功”
 * 就会把本地测试页导航到学校的真实地址上去。 */
function onSzu() {
  try { return /(^|\.)szu\.edu\.cn$/i.test(location.hostname); } catch (e) { return false; }
}
function goTo(url, delay) {
  if (!onSzu()) { log('（仿真页，跳过跳转：' + url + '）'); return; }
  setTimeout(function () { try { location.href = url; } catch (e) {} }, delay);
}

/* ---------- 预设的账号 / 密码 / API Key ----------
 * 把三个值填进下面的引号里，装好脚本打开页面就直接能用，不必每次在面板上敲。
 * 留空也行 —— 那就在面板的“▸ 自动登录 / 验证码识别”里填一次，
 * 存进浏览器后同样是一劳永逸，而且不会落到磁盘文件上（更推荐这种）。
 *
 * 填在这里要知道的事：这是明文，而且 `node build.js` 会把这份代码原样复制到
 * edge-extension/content.js 和 test/ 下的两个仿真页，磁盘上会有好几份。
 * 所以填了之后：别把这个文件夹分享出去，也别提交到 git。
 * 不想留了：把三个值改回空字符串，或者点面板上的“清除账号密码”。 */
var PRESET = {
  user: '',        // 学号
  pass: '',        // 密码
  key:  ''         // 识别验证码用的 API Key（默认服务商是硅基流动）
};

/* 账号、密码、API Key 单独存一个键，不跟普通配置混在一起，
 * “复制日志”这类操作也永远不碰它们。
 * 同样说明白：localStorage 是明文的，同域下别的脚本读得到。 */
var AUTH_KEY = 'szg_auth_v1';
var authSaved = null;
try { authSaved = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) {}
var auth = { user: '', pass: '', key: '' };
if (authSaved) Object.assign(auth, authSaved);
/* 在面板上动过一次之后就以面板为准（manual 标记），上面的 PRESET 只在那之前用来打底。
 * 没这个标记的话，“清除账号密码”一刷新就被 PRESET 填回来了，等于白点。 */
if (!(authSaved && authSaved.manual)) {
  ['user', 'pass', 'key'].forEach(function (k) { if (!auth[k]) auth[k] = PRESET[k]; });
}
function saveAuth() {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({
      user: auth.user, pass: auth.pass, key: auth.key, manual: 1
    }));
  } catch (e) {}
}

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
/* 助手面板也是页面上的 DOM，所有“扫描页面”的逻辑都必须把它排掉。
 * 不排会出大事：面板里“密码”和“Key”是两个 type=password 输入框，
 * 展开“自动登录”那一栏之后它们是可见的，于是
 *   sessionLost()   —— 判据是“页面上有可见密码框”，直接永远为真，一开始抢课就喊掉线；
 *   findLoginForm() —— 把面板当成登录表单，拿“包含”框当用户名框、把学号写进去，
 *                      又找不到登录按钮，于是一直报“没找到登录按钮”；
 *                      登录真的成功了也判不出来，因为面板还在，表单就“还没消失”。
 * 收起那一栏就正常，所以症状看着像“之前保存过密码就没事”——那只是没展开而已。 */
function inPanel(el) {
  try { return !!(el && el.closest && el.closest('#szg-panel')); } catch (e) { return false; }
}

function visible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  if (inPanel(el)) return false;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  var s = null;
  try { s = win.getComputedStyle(el); } catch (e) { return false; }
  return !!s && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
}
function isPureNum(s) { return /^\d+$/.test(String(s == null ? '' : s).trim()); }
function cellNum(s) { return isPureNum(s) ? parseInt(String(s).trim(), 10) : null; }

/* “300/161”这种一格两个数：大的是容量，小的是已选。
 * 这样不管系统写成 容量/已选 还是 已选/容量 都能算对，不用让用户去猜顺序。 */
function parsePair(s) {
  var m = String(s == null ? '' : s).match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!m) return null;
  var a = +m[1], b = +m[2];
  return { cap: Math.max(a, b), taken: Math.min(a, b) };
}
/* 固定节奏太规律，间隔在区间内随机取，小停顿也加 ±25% 抖动 */
function randRange(a, b) {
  if (b <= a) return a;
  return a + Math.floor(Math.random() * (b - a + 1));
}
function jitter(ms) { return Math.max(0, Math.round(ms * (0.75 + Math.random() * 0.5))); }

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
 * 3. “选课”按钮 / 课程行 / 表格识别
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
  // “致真楼50320/20”这种，正则一匹配就全乱了。
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
      // “容量”这一列常常写成 300/161 这种一格两个数，先按数对解析
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
  // 不在整行文字上做正则，否则“上课时间地点”里的 1/2 之类会先被匹配到。
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

/* 页面文字，但**不含本脚本的面板**。
 * 面板是挂在 body 上的，日志里随便一句“正在自动重新登录”就会被下面的关键词命中，
 * 于是脚本读到自己写的字、认定掉线、再写一遍，陷进死循环出不来。 */
function pageText(d) {
  if (!d.body) return '';
  var out = '', kids = d.body.children || [];
  for (var i = 0; i < kids.length && out.length < 800; i++) {
    if (kids[i].id === 'szg-panel') continue;
    out += (kids[i].innerText || '') + '\n';
  }
  return out.slice(0, 800);
}

/* 掉线判定。
 * 靠文字关键词很不可靠——深大这个登录页上只写着“登录 / LOGIN / 验证码”，
 * “会话超时”“统一身份认证”一个都不出现，于是脚本会在登录页上一直空转，
 * 轮次涨到几十、一门都没抢到，还以为自己在正常工作。
 * 最硬的信号是：页面上出现了可见的密码框。 */
function sessionLost() {
  var docs = allDocs();
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    if (qsa(d, 'input[type=password]').filter(visible).length) return true;
    /* 这里原来还有一条“地址是 *default/index.do 就算掉线”。那条是错的：
     * 深大这个门户登录前登录后是同一个地址，登录成功后照样停在 *default/index.do，
     * 于是脚本会一直判掉线、反复重新登录，登进去了也认不出来。
     * 可见的密码框才是硬信号，地址不管用。 */
    if (/统一身份认证|请重新登录|会话超时|登录超时|登录已失效|重新登录/.test(pageText(d))) return true;
  }
  return false;
}

/* 每轮开始：把列表刷新一次并回到第 1 页 */
var entryTries = 0;
async function refreshList() {
  if (sessionLost()) { pauseForLogin(); throw new Error('session-lost'); }
  await clearBlockingDialogs(3);          // 上一轮可能留下没关的弹窗，先清干净再动
  var doc = pickDoc();

  /* 还没进选课页——刚登录完停在门户首页就是这种情况。先点“我的选课”。
   * 点完可能整页跳转（脚本重新加载，靠 resume 标记接上），也可能原地渲染出课表。 */
  if (!onCoursePage()) {
    var entry = findCourseEntry();
    if (!entry) {
      // 既不在选课页、又找不到入口。日志里说清现状，不然只会看到“没有符合条件的课”
      if (entryTries === 0) {
        entryTries = 1;
        log('这一页不像选课页，也没找到“我的选课”入口，直接跳选课页地址', 'warn');
        saveResume(true);
        goTo(COURSE_URL, randRange(300, 800));
        throw new Error('going-to-course');
      }
    } else if (entryTries < 3) {
      entryTries++;
      log('当前不在选课页，点“我的选课”进入…（第 ' + entryTries + ' 次）');
      saveResume(true);
      if (!await enterCourse(entry)) log('点了“我的选课”还没等到课表，下一轮再试', 'warn');
      doc = pickDoc();
    } else {
      // 点了几次都没进去，别再空点了，直接走地址
      log('点“我的选课”没进去，改成直接跳选课页地址', 'warn');
      entryTries = 0;
      saveResume(true);
      goTo(COURSE_URL, randRange(300, 800));
      throw new Error('going-to-course');
    }
  } else {
    entryTries = 0;
  }

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

/* 结果可能是轻提示，也可能是一个带“确定”的模态框（深大研选课的“选课失败！”就是模态框），
 * 所以这里把弹层容器也一并纳入扫描范围。 */
var MSG_SEL = '.layui-layer-msg,.layui-layer-dialog,.el-message,.el-message__content,' +
              '.ant-message-notice-content,.toast,[role=alert],[role=dialog],[class*=message],' +
              '[class*=notice],[class*=alert],[class*=toast],[class*=tips],' +
              '[class*=dialog],[class*=modal],[class*=layer],[class*=popup],[class*=msgbox]';
/* 只留结果类字眼。别把“人数”“学分”这种放进来，
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

/* 清掉挡路的弹窗。结果框（选课失败！）点“确定”关掉；其它框点“取消/关闭”。
 * 绝不在这里点确认框的“确定”——那会选到没打算选的课。
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
 *   a) 那一行的“选课”变成“退课”
 *   b) 那门课直接从可选列表里消失（挪到“已选课程”里去了）
 * 而且系统会重绘整张表，旧的 row 节点已经脱离 DOM，所以必须按课程名重新找。
 * pageBefore 用来防误判：如果页码变了，就不能凭“找不到”断定选上了。 */
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
  if (currentPage(doc) !== pageBefore) return false;   // 翻页了，“找不到”说明不了什么
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
  // “容量已满”值得一直抢；冲突、学分超限这类再试多少次也是白试，本次运行内跳过
  if (msg && HARD_FAIL.test(msg) && !/已满|容量|人数/.test(msg)) {
    skip.add(info.key);
    log('这门课不是名额问题，本次运行不再重试：' + info.label, 'warn');
  }
  if (!msg) log('没抓到系统提示，按失败处理，下一轮继续：' + info.label, 'warn');
  await sleep(jitter(cfg.clickGap));
  return 'fail';
}

function onSuccess(info) {
  done.add(info.key);
  stats.got++;
  setStat('szg-got', stats.got);
  log('★ 选课成功：' + info.label, 'ok');
  beep(); notify('选课成功', info.label); flashTitle('★★ 抢到课了 ★★');
  if (cfg.stopOnDone) { log('已开启“抢到就停止”，任务结束'); stop(); }
}

function unknownWarn(info) {
  if (warned.has(info.key)) return;
  warned.add(info.key);
  log((info.badParse ? '余量算出负数，说明容量/已选两列认反或错位了，已跳过：'
                     : '识别不到余量，已跳过：') + info.label +
      '（可勾选“余量认不出也点”，或对照“扫描诊断”的输出调整表头识别）', 'warn');
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
    await sleep(jitter(cfg.pageGap));
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
      if (String(e && e.message) === 'going-to-course') break;   // 正在跳转，等页面重新加载后接上
      errs++;
      log('异常：' + (e && e.message ? e.message : e), 'err');
      if (errs >= 5) { log('连续异常过多，已自动停止', 'err'); stop(); break; }
    }
    if (!running) break;
    await sleep(randRange(cfg.interval, cfg.intervalMax));
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
var PAGE_TITLE = document.title;
var titleTimer = null;
function flashTitle(text, persist) {
  if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
  var on = false, n = 0;
  titleTimer = setInterval(function () {
    document.title = (on = !on) ? text : PAGE_TITLE;
    if (!persist && ++n > 40) { clearInterval(titleTimer); titleTimer = null; document.title = PAGE_TITLE; }
  }, 650);
}

/* 掉线时人多半不在电脑前，响一声根本发现不了，所以要一直叫到处理为止 */
var alarmTimer = null;
function startAlarm(text) {
  stopAlarm();
  var n = 0;
  var fire = function () { beep(); if (++n >= 30) { clearInterval(alarmTimer); alarmTimer = null; } };
  fire();
  alarmTimer = setInterval(fire, 8000);
  notify('抢课已中断', text);
  flashTitle('⚠ 需要重新登录', true);
}
function stopAlarm() {
  if (alarmTimer) { clearInterval(alarmTimer); alarmTimer = null; }
  if (titleTimer) { clearInterval(titleTimer); titleTimer = null; document.title = PAGE_TITLE; }
}

/* ============================================================
 * 8. 诊断 / 每页条数
 * ========================================================== */
/* 诊断里也报一下页面归属，出问题时一眼能看出卡在哪一步 */
function diagWhere() {
  var d = pickDoc();
  var t = pickTable(d);
  log('页面判定：' + (onCoursePage() ? '在选课页' : '不在选课页') +
      '（选课按钮 ' + findSelectBtns(d).length + ' 个，表格 ' + (t ? '有' : '无') +
      (t ? '，表头“' + txt(t).slice(0, 40) + '”' : '') + '）');
  log('“我的选课”入口：' + (findCourseEntry() ? '找到了' : '没找到') +
      ' · 登录框：' + (findLoginForm() ? '在（说明没登录）' : '不在'));
}

function diag() {
  diagWhere();
  log('──── 诊断开始 ────');
  var docs = allDocs();
  log('文档数(含 iframe)：' + docs.length);
  var doc = pickDoc();
  var btns = findSelectBtns(doc);
  log('“选课”按钮：' + btns.length + ' 个' +
      (btns[0] ? '（示例 <' + btns[0].tagName.toLowerCase() + '> 文本“' + txt(btns[0]) + '”）' : ''));
  var table = pickTable(doc);
  log('课程表格：' + (table ? '已找到，共 ' + qsa(table, 'tr').length + ' 行' : '未找到'));
  var headers = getHeaders(table);
  log('表头：' + (headers.length ? headers.join(' | ') : '未识别到'));
  var pager = findPager(doc);
  log('分页控件：' + (pager ? '已找到“' + txt(pager).slice(0, 60) + '”，当前第 ' + currentPage(doc) + ' 页' : '未找到'));
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
  if (bad) log('⚠ 有 ' + bad + ' 条识别不到余量，对照上面的表头检查一下识别是否正确', 'warn');
  else if (rows.length) log('✔ 余量识别正常，可以开始', 'ok');
  log('──── 诊断结束（点“复制日志”可整段复制）────');
}

function setPageSizeMax() {
  var doc = pickDoc();
  var sels = qsa(doc, 'select').filter(function (s) {
    if (!visible(s)) return false;
    var opts = Array.prototype.slice.call(s.options || []);
    return opts.length >= 2 && opts.every(function (o) { return isPureNum(o.value || txt(o)); });
  });
  if (!sels.length) { log('没找到“每页条数”下拉框，可手动把每页条数调到最大以减少翻页', 'warn'); return; }
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
 * 8.5 自动登录（预设账号密码 + 大模型识别验证码）
 * ========================================================== */
/* 各家视觉模型的接口地址和默认模型。都是 OpenAI 的 chat/completions 格式，
 * 只有智谱要求 base64 不带 "data:image/png;base64," 前缀，用 raw 标出来。 */
var OCR_PRESETS = {
  zhipu:     { name: '智谱 GLM-4V（有免费额度）',
               url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
               model: 'glm-4v-flash', raw: true },
  dashscope: { name: '阿里百炼 通义千问 VL',
               url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
               model: 'qwen-vl-max-latest', raw: false },
  /* 默认模型是 2026-09 用“手写体 + 删除线”的验证码实测挑出来的（8 张一批）：
   *   Qwen3-VL-30B-A3B  8/8，大小写全对，约 950ms   ← 选它
   *   Qwen3-VL-32B      8/8，大小写全对，约 6.6s     太慢
   *   Qwen3-VL-8B       8/8，但 5/8 的大小写是错的，约 770ms
   * 8B 会把 64F7 认成 64f7、TBXZ 认成 tbxz。验证码系统只要区分大小写，它就废了，
   * 快那 200ms 完全不值。
   * 各家换模型名换得很勤，报“模型不存在 / 已禁用”就去服务商控制台看看现在叫什么，
   * 填进面板的“模型”框，再用“测试识别”验一下。 */
  silicon:   { name: '硅基流动 SiliconFlow',
               url: 'https://api.siliconflow.cn/v1/chat/completions',
               model: 'Qwen/Qwen3-VL-30B-A3B-Instruct', raw: false },
  openai:    { name: 'OpenAI / 兼容接口',
               url: 'https://api.openai.com/v1/chat/completions',
               model: 'gpt-4o-mini', raw: false },
  custom:    { name: '自定义（OpenAI 格式）', url: '', model: '', raw: false }
};

/* 学校页面上直接 fetch 大模型接口会被 CORS 挡掉，所以按安装方式挑一条走得通的路：
 *   油猴   → GM_xmlhttpRequest（脚本头的 @connect 已放行）
 *   扩展   → 转给 background.js 去发（manifest 里声明了 host_permissions）
 *   控制台 → 只剩裸 fetch，多半会被挡，日志里会写明当前用的是哪条 */
function gmOk() { try { return typeof GM_xmlhttpRequest === 'function'; } catch (e) { return false; } }
function extOk() {
  try { return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id && !!chrome.runtime.sendMessage; }
  catch (e) { return false; }
}
function transportName() { return gmOk() ? '油猴' : (extOk() ? '扩展后台' : '页面 fetch（多半会被 CORS 挡）'); }

function httpPost(url, headers, body, timeout) {
  timeout = timeout || 20000;
  if (gmOk()) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'POST', url: url, headers: headers, data: body, timeout: timeout,
        onload: function (r) { resolve({ status: r.status, text: r.responseText }); },
        onerror: function () { reject(new Error('网络错误（检查脚本头的 @connect 有没有放行这个域名）')); },
        ontimeout: function () { reject(new Error('请求超时')); }
      });
    });
  }
  if (extOk()) {
    return new Promise(function (resolve, reject) {
      var fired = false;
      var t = setTimeout(function () { if (!fired) { fired = true; reject(new Error('请求超时')); } }, timeout + 3000);
      try {
        chrome.runtime.sendMessage({ type: 'szg-fetch', url: url, headers: headers, body: body, timeout: timeout },
          function (r) {
            if (fired) return;
            fired = true; clearTimeout(t);
            var le = chrome.runtime.lastError;
            if (le) { reject(new Error(le.message + '（去 edge://extensions/ 把本扩展刷新一下）')); return; }
            if (!r) { reject(new Error('扩展后台没回包，去 edge://extensions/ 刷新一下扩展')); return; }
            if (r.error) { reject(new Error(r.error)); return; }
            resolve({ status: r.status, text: r.text });
          });
      } catch (e) { fired = true; clearTimeout(t); reject(e); }
    });
  }
  return fetch(url, { method: 'POST', headers: headers, body: body }).then(function (r) {
    return r.text().then(function (t) { return { status: r.status, text: t }; });
  }).catch(function () {
    throw new Error('请求发不出去，多半是 CORS。控制台粘贴的用法调不了外部接口，请改用扩展或油猴安装');
  });
}

/* 把验证码图片转成 base64。
 * 关键：绝不能拿 img.src 再请求一次——这类接口是“取一次换一张”，
 * 重新请求会让页面上显示的那张当场作废，识别得再准也白搭。
 * 所以直接把已经显示出来的这张画到 canvas 上取像素（同域图片，画布不会被污染）。 */
/* 拉对比度：把灰度往两头推，压掉背景底色和干扰细线，字更实。
 * 故意不做二值化——阈值一写死，遇到浅色字的验证码整张就糊没了。 */
function boostContrast(c) {
  var g = c.getContext('2d');
  var d = g.getImageData(0, 0, c.width, c.height), p = d.data;
  for (var i = 0; i < p.length; i += 4) {
    var v = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
    v = (v - 128) * 2.2 + 128;
    p[i] = p[i + 1] = p[i + 2] = v < 0 ? 0 : (v > 255 ? 255 : v);
  }
  g.putImageData(d, 0, 0);
}

/* variant：
 *   'up'    放大到 320px 宽左右（默认。验证码图常见才 100x34，原尺寸发过去模型容易认岔）
 *   'sharp' 放大 + 拉对比
 *   'raw'   原尺寸
 * 三种都是同一张图，不消耗验证码——服务端那张图要提交了才作废。 */
async function captchaDataUrl(img, variant) {
  for (var i = 0; i < 40 && (!img.complete || !img.naturalWidth); i++) await sleep(100);
  var w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) {
    var src0 = img.getAttribute('src') || '';
    if (/^data:image\//i.test(src0)) return src0;      // 尺寸读不到但本来就是内联图，直接用
    throw new Error('验证码图片没加载出来');
  }
  try {
    var scale = variant === 'raw' ? 1 : Math.max(1, Math.min(4, Math.ceil(320 / w)));
    var c = document.createElement('canvas');
    c.width = w * scale;
    c.height = h * scale;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, c.width, c.height);
    if (variant === 'sharp') boostContrast(c);
    return c.toDataURL('image/png');
  } catch (e) {
    var src = img.getAttribute('src') || '';
    if (/^data:image\//i.test(src)) return src;
    throw new Error('读不出验证码图片：' + (e && e.message ? e.message : e));
  }
}

/* 提示词是拿同一批 8 张图逐句对比调出来的，别凭感觉改：
 *   原版（只说 4 位 + 保持大小写）................. 8/8
 *   加“忽略干扰线”................................ 8/8   ← 用这个
 *   再加“严格区分大小写，不要擅自转换”............ 7/8   把 5ZET 逼成了 SZET
 * 越强调大小写，模型越往字母那边猜，数字 5 就变成 S 了。 */
var OCR_PROMPT = '这是一张登录验证码图片，内容固定是 4 个字符，只可能是英文字母或数字。' +
                 '图中可能有干扰线横穿字符，忽略它，只读字符本身。保持原有大小写。' +
                 '只输出这 4 个字符，不要任何解释、引号、标点、空格或换行。';

/* 验证码固定 4 位字母/数字——这个约束很有用：位数不对的结果根本不用提交就知道是错的。 */
var CODE_RE = /^[0-9a-zA-Z]{4}$/;

/* 模型有时会多说一句（“图片中的验证码是 A3F7。”），把最像验证码的那段抠出来。
 * 验证码基本是 4 位，所以按“离 4 位最近”来挑。 */
function pickCode(s) {
  var runs = String(s == null ? '' : s).match(/[0-9a-zA-Z]+/g) || [];
  var best = '';
  for (var i = 0; i < runs.length; i++) {
    var r = runs[i];
    if (r.length > 8) continue;
    if (!best || Math.abs(r.length - 4) < Math.abs(best.length - 4)) best = r;
  }
  return best;
}

async function ocrCaptcha(dataUrl) {
  var p = OCR_PRESETS[cfg.ocrProvider] || OCR_PRESETS.custom;
  var url = (cfg.ocrUrl || p.url || '').trim();
  var model = (cfg.ocrModel || p.model || '').trim();
  if (!auth.key) throw new Error('没填 API Key');
  if (!url) throw new Error('没填接口地址');
  if (!model) throw new Error('没填模型名');
  var b64 = p.raw ? dataUrl.replace(/^data:image\/\w+;base64,/, '') : dataUrl;
  var payload = {
    model: model, temperature: 0, max_tokens: 24,
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: b64 } },
      { type: 'text', text: OCR_PROMPT }
    ] }]
  };
  var r = await httpPost(url, {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + auth.key
  }, JSON.stringify(payload));
  var data = null;
  try { data = JSON.parse(r.text); } catch (e) {}
  if (r.status < 200 || r.status >= 300) {
    var em = (data && ((data.error && data.error.message) || data.msg || data.message)) ||
             String(r.text || '').slice(0, 160);
    throw new Error('接口返回 ' + r.status + '：' + em);
  }
  var c = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (Array.isArray(c)) c = c.map(function (x) { return (x && x.text) || ''; }).join('');
  return { code: pickCode(c), raw: String(c == null ? '' : c).slice(0, 60) };
}

var VARIANTS = ['up', 'sharp', 'raw'];
var VNAME = { up: '放大', sharp: '放大+对比', raw: '原尺寸' };

/* 出现次数最多的那个，以及它拿到几票 */
function topPick(list) {
  var best = list[0] || '', n = 0;
  list.forEach(function (p) {
    var c = 0;
    list.forEach(function (q) { if (q === p) c++; });
    if (c > n) { n = c; best = p; }
  });
  return { code: best, n: n };
}

/* 读一张验证码。两条便宜的容错，都在“提交”之前完成——图没提交就没作废，问几次都不额外消耗：
 *
 * 1) 位数校验。这个系统的验证码固定 4 位字母/数字，
 *    模型给出 3 位、5 位或者一句废话，不用提交就知道是错的，直接换下一种处理。
 *
 * 2) 交叉验证。注意不能“同一张图问几遍取多数”——temperature=0 下同一张图问三次
 *    答案一模一样（实测），纯属白等。要换输入才有意义：把同一张验证码
 *    放大 / 放大加对比 / 原尺寸各问一次，模型犯的错才可能不一样。
 *    前两种就对上了的话直接采用，不再问第三种。 */
async function readCaptcha(img) {
  var picks = [], notes = [];
  var want = Math.max(1, Math.min(VARIANTS.length, cfg.ocrVote || 1));
  for (var i = 0; i < VARIANTS.length; i++) {
    if (i >= want) {
      /* 配额用完了。只有一种情况值得再多问一次：几种结果各说各的、凑不出多数票。
       * 那时候二选一等于抛硬币，而猜错要赔上一整轮“提交→被打回→换图→重认”，
       * 多花一次调用买一张决胜票是划算的。 */
      if (picks.length < 2 || topPick(picks).n > 1) break;
      log('前 ' + i + ' 种处理结果不一致，再用“' + VNAME[VARIANTS[i]] + '”打破平局', 'warn');
    }
    var r = await ocrCaptcha(await captchaDataUrl(img, VARIANTS[i]));
    if (!CODE_RE.test(r.code)) {
      notes.push(VNAME[VARIANTS[i]] + '=' + (r.code || r.raw || '空') + '(位数不对)');
      continue;
    }
    picks.push(r.code);
    notes.push(VNAME[VARIANTS[i]] + '=' + r.code);
    if (topPick(picks).n >= 2) break;          // 已经有两票一致，不必再问
  }
  if (!picks.length) throw new Error('几种处理都没读出 4 位验证码（' + notes.join('，') + '）');
  var top = topPick(picks);
  if (picks.length > 1 && top.n === 1) {
    log('几种处理都不一致（' + notes.join('，') + '），先按“' + top.code + '”提交试试', 'warn');
  }
  return top.code;
}

/* 找登录表单。先按深大这个页面上的固定 id 找，找不到再按类型/关键词兜底，
 * 免得学校哪天改了 id 就整个失灵。 */
function findLoginForm() {
  var docs = allDocs();
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    var pass = d.querySelector ? d.querySelector('#loginPwd') : null;
    if (!pass || !visible(pass)) pass = qsa(d, 'input[type=password]').filter(visible)[0];
    if (!pass) continue;
    var code = d.querySelector ? d.querySelector('#verifyCode') : null;
    if (!code || !visible(code)) {
      code = qsa(d, 'input').filter(function (e) {
        if (!visible(e) || e.type === 'password' || e.type === 'hidden') return false;
        return /验证码|captcha|checkcode|verifycode|yzm/i.test(
          (e.placeholder || '') + ' ' + (e.name || '') + ' ' + (e.id || '') + ' ' + cls(e));
      })[0] || null;
    }
    var user = d.querySelector ? d.querySelector('#loginName') : null;
    if (!user || !visible(user)) {
      user = qsa(d, 'input').filter(function (e) {
        if (!visible(e) || e.type === 'password' || e.type === 'hidden' || e.type === 'checkbox') return false;
        return e !== code;
      })[0] || null;
    }
    var img = d.querySelector ? d.querySelector('#vcodeImg') : null;
    if (!img || !visible(img)) {
      img = qsa(d, 'img').filter(function (e) {
        if (!visible(e)) return false;
        return /vcode|captcha|checkcode|verify|yzm|randcode|validate/i.test(
          (e.id || '') + ' ' + cls(e) + ' ' + (e.getAttribute('src') || ''));
      })[0] || null;
    }
    var btn = d.querySelector ? d.querySelector('#studentLoginBtn') : null;
    if (!btn || !visible(btn)) btn = btnIn(d, /^(登\s*录|登陆|LOGIN|Log ?in|Sign ?in)$/i);
    if (user) return { doc: d, user: user, pass: pass, code: code, img: img, btn: btn };
  }
  return null;
}

/* 是不是已经在选课页上了。
 * 这里不能只问“页面上有没有 table”——pickTable 只要有任何可见表格就返回非空，
 * 而门户首页的通知公告、课表预览之类往往就是个表格。那样脚本会误判成
 * “已经在选课页”，于是永远不去点“我的选课”，然后每轮都报“没有符合条件的课”。
 * 所以要么有真的“选课”按钮，要么表头得长得像课程表。 */
var COURSE_HEAD = /容量|余量|已选|课程号|课程名|教学班|上课教师/;
function onCoursePage() {
  var d = pickDoc();
  if (findSelectBtns(d).length) return true;
  var t = pickTable(d);
  return !!t && COURSE_HEAD.test(txt(t).slice(0, 500));
}

/* 点“我的选课”，然后等课表真出来。
 * 不能点完睡个固定时间就往下走：慢的时候课表还没渲染，脚本会以为这一轮没课；
 * 快的时候又白等。所以轮询，最多等 8 秒。
 * 如果这一点触发的是整页跳转，脚本会连同页面一起重新加载，
 * 靠 resume 标记接上，这里等不到也没关系。 */
async function enterCourse(entry) {
  realClick(entry);
  for (var i = 0; i < 20; i++) {                 // 先给 4 秒
    await sleep(200);
    if (onCoursePage()) return true;
  }
  /* 还没动静。有些站点的按钮只认原生 click（我们补的那串 pointer/mouse 事件反而被它忽略），
   * 再补一次原生 click；要是个带真地址的 <a>，直接照着地址走。 */
  try { entry.click(); } catch (e) {}
  for (var j = 0; j < 20; j++) {
    await sleep(200);
    if (onCoursePage()) return true;
  }
  var href = entry.getAttribute && entry.getAttribute('href');
  if (href && !/^javascript:/i.test(href) && href !== '#') {
    log('“我的选课”点了没反应，按它的链接地址走', 'warn');
    goTo(new URL(href, location.href).href, 200);
  }
  return false;
}

/* 登录完落在的是门户首页，不是选课页，得先点“我的选课”才进得去。 */
function findCourseEntry() {
  var docs = allDocs();
  for (var i = 0; i < docs.length; i++) {
    var d = docs[i];
    var b = d.querySelector ? d.querySelector('#courseBtn') : null;
    if (b && visible(b)) return b;
    b = btnIn(d, /^(我的选课|进入选课|开始选课|选课报名)$/);
    if (b) return b;
  }
  return null;
}

/* 直接改 .value 有些前端框架收不到（它们劫持了 value 的 setter，只认 input 事件），
 * 所以走原生 setter 再手动派发事件，效果跟人一个字一个字敲进去一致。 */
function setInputValue(el, v) {
  var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
  try { el.focus(); } catch (e) {}
  try {
    var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
  } catch (e) { try { el.value = v; } catch (e2) {} }
  ['input', 'change', 'keyup', 'blur'].forEach(function (t) {
    try { el.dispatchEvent(new win.Event(t, { bubbles: true })); } catch (e) {}
  });
}

/* 换一张验证码：这类页面基本都是点图片就刷新 */
async function refreshCaptcha(f) {
  if (!f.img) return;
  var old = f.img.getAttribute('src') || '';
  realClick(f.img);
  for (var i = 0; i < 30; i++) {
    await sleep(120);
    if ((f.img.getAttribute('src') || '') !== old && f.img.complete && f.img.naturalWidth) return;
  }
}

/* 登录页报错的写法很杂：有的是弹层（msgTexts 认得），有的就是登录框里的一行红字，
 * 那种没有任何 message/alert 类名，光扫弹层会一直等到超时还以为“没等到结果”。
 * 所以再把登录框容器里的文字也扫一遍。 */
function loginMsgs(f) {
  var out = msgTexts();
  var box = f.pass || f.user;
  /* 往上找几层拿到登录框那一块。走到 body 就打住——再往上会把面板自己的日志也扫进来。 */
  for (var i = 0; i < 5; i++) {
    var up = box && box.parentElement;
    if (!up || up.tagName === 'BODY' || up.tagName === 'HTML') break;
    box = up;
  }
  if (box) {
    String(box.innerText || '').split(/\n+/).forEach(function (t) {
      t = t.trim();
      if (t && t.length <= 60) out.push(t);
    });
  }
  return out;
}

/* 光有“密码”“验证码”这些词还不够——登录框里的标签也带这些字。
 * 得同时出现“错了”这层意思，才算是一条报错。 */
var LOGIN_ERR = /错误|不正确|有误|失败|无效|不存在|锁定|冻结|停用|禁用|次数|请重新|不匹配|不一致/;

var loginTries = 0;        // 本次掉线里已经试了几轮
var autoLoginOff = false;  // 本次运行内暂停自动登录。只影响运行时，不动配置，面板复选框保持原样
var loginBusy = false;
var loginBlocked = '';     // 非空 = 账号密码本身有问题，停手别再自动试

/* 密码错和验证码错必须分开处理：
 * 验证码错换一张重来就行；密码错要立刻停手——拿错的密码反复撞，学校那边是会锁账号的。 */
function judgeLoginMsg(msg) {
  if (/验证码|校验码|captcha/i.test(msg)) return 'retry';
  if (/密码|用户名|账号|帐号|不存在|锁定|冻结|停用|已禁用/.test(msg)) return 'stop';
  return 'retry';
}

/* 返回 'ok' 成功 / 'retry' 再来一次 / 'stop' 别再试了 / 'idle' 当前没有登录框 */
async function autoLogin() {
  if (loginBusy || loginBlocked || autoLoginOff || !cfg.autoLogin) return 'idle';
  if (!auth.user || !auth.pass) {
    loginBlocked = '面板里还没填学号或密码';
    log('自动登录用不了：' + loginBlocked, 'err');
    return 'stop';
  }
  var f = findLoginForm();
  if (!f) return 'idle';
  loginBusy = true;
  try {
    setStateText('自动登录中', 'szg-wait');
    setInputValue(f.user, auth.user);
    await sleep(randRange(120, 350));
    setInputValue(f.pass, auth.pass);
    await sleep(randRange(120, 350));

    if (f.code && f.img) {
      var t0 = Date.now();
      var code = await readCaptcha(f.img);
      log('验证码识别为“' + code + '”（' + (Date.now() - t0) + 'ms）');
      setInputValue(f.code, code);
      await sleep(randRange(120, 350));
    } else if (f.code && !f.img) {
      log('页面要验证码但没找到验证码图片，只能你自己填', 'warn');
      focusCaptcha();
      return 'stop';
    }

    if (!f.btn) { log('没找到登录按钮，请自己点一下“登录”', 'err'); return 'stop'; }
    var before = new Set(loginMsgs(f));
    saveResume(true);              // 登录会整页刷新，先把“本来在抢课”落盘，回来才接得上
    realClick(f.btn);

    // 等结果：要么登录框没了（成了），要么弹一句提示
    /* 点完之后等结果。成功的信号不止“登录框没了”一种：
     * 这个门户登录后地址不变、页面结构也接近，所以再认两个硬信号——
     * 出现了“我的选课”入口，或者干脆已经站在选课页上。
     * 只认单一信号的话，页面稍微慢一点或者登录框留在 DOM 里没删，就会误判成失败，
     * 白白换掉一张已经正确的验证码。 */
    var t1 = Date.now();
    while (Date.now() - t1 < 9000) {
      await sleep(randRange(200, 350));
      if (!findLoginForm()) return 'ok';
      if (findCourseEntry() || onCoursePage()) return 'ok';
      var hit = loginMsgs(f).filter(function (t) {
        return !before.has(t) && LOGIN_ERR.test(t);
      })[0];
      if (!hit) continue;
      var msg = cleanMsg(hit);
      var verdict = judgeLoginMsg(msg);
      log('登录返回：' + msg, verdict === 'stop' ? 'err' : 'warn');
      if (verdict === 'stop') {
        loginBlocked = msg;
        log('账号或密码不对，已停掉自动登录（继续撞会被学校锁账号）。改正后重新点“开始抢课”。', 'err');
        startAlarm('账号密码有误，请手动检查');
        return 'stop';
      }
      await clearBlockingDialogs(2);
      await refreshCaptcha(f);
      return 'retry';
    }
    // 没等到任何提示。这一张验证码多半已经被服务端消掉了，换一张再来，别拿废码重投。
    log('点了登录但没等到结果，换张验证码再试', 'warn');
    await refreshCaptcha(f);
    return 'retry';
  } catch (e) {
    log('自动登录出错：' + (e && e.message ? e.message : e), 'err');
    try { await refreshCaptcha(f); } catch (e2) {}   // 换一张干净的，下一轮从头来
    return 'retry';
  } finally {
    loginBusy = false;
  }
}

/* 登录成功后系统未必落回选课页（常见是回首页），自己跳回去。
 * 跳完页面重载，tryAutoResume 看到“本来在抢课”的标记就会自动接着跑。 */
function backToCourse() {
  var here = '';
  try { here = location.href || ''; } catch (e) {}
  if (/gotoChooseCourse/i.test(here)) { start(); return; }
  saveResume(true);
  /* 首页上有“我的选课”入口，就直接开抢——refreshList 每轮开头都会检查并点它进去，
   * 比在这里硬跳地址稳（有些系统直接访问选课地址会被打回首页）。 */
  if (findCourseEntry()) {
    log('登录成功，准备进入选课页', 'ok');
    entryTries = 0;
    start();
    return;
  }
  log('登录成功，正在跳回选课页…', 'ok');
  goTo(COURSE_URL, randRange(600, 1200));
}

/* 面板上的“测试识别”：不用等真掉线，就能验一下 Key、模型、通道通不通 */
async function testOcr() {
  readCfg();
  log('通道 = ' + transportName() + '，服务商 = ' +
      ((OCR_PRESETS[cfg.ocrProvider] || {}).name || cfg.ocrProvider));
  var f = findLoginForm();
  if (!f || !f.img) {
    log('当前页面上没有验证码图片。先打开登录页再点这个按钮：' + LOGIN_URL, 'warn');
    return;
  }
  /* 三种处理各报一次，你对着图看哪种准。
   * 如果“原尺寸”明显比放大的准，就把“交叉验证”调成 1 再说；
   * 如果三种都认不出来，多半是这个模型吃不下你们的验证码，换个模型。 */
  for (var i = 0; i < VARIANTS.length; i++) {
    try {
      var t0 = Date.now();
      var r = await ocrCaptcha(await captchaDataUrl(f.img, VARIANTS[i]));
      log('  ' + VNAME[VARIANTS[i]] + ' → “' + (r.code || r.raw || '空') + '”' +
          (CODE_RE.test(r.code) ? '' : '（不是 4 位）') + '（' + (Date.now() - t0) + 'ms）',
          CODE_RE.test(r.code) ? 'ok' : 'warn');
    } catch (e) {
      log('  ' + VNAME[VARIANTS[i]] + ' → 失败：' + (e && e.message ? e.message : e), 'err');
      break;                              // Key/模型不对的话，后面两种也一样会失败
    }
  }
  log('以上跟图上的验证码对一眼，一致就说明配好了。', 'ok');
}

/* “一直转圈”= 多半是会话在后台悄悄过期了：接口一直不回，前端的 loading 遮罩就摘不掉，
 * 页面又不一定弹“请重新登录”。所以自己盯着，连续转圈超过 stallSec 秒就按掉线处理。 */
var spinSince = 0, watchdog = null;
function startWatchdog() {
  stopWatchdog();
  watchdog = setInterval(function () {
    if (!running) { spinSince = 0; return; }
    if (!loadingNow()) { spinSince = 0; return; }
    if (!spinSince) { spinSince = Date.now(); return; }
    if (Date.now() - spinSince < cfg.stallSec * 1000) return;
    spinSince = 0;
    pauseForLogin('stall');
  }, 1000);
}
function stopWatchdog() {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  spinSince = 0;
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
'.szg-row input.szg-half{max-width:70px}',
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
'.szg-badge.szg-wait{background:#d97706}',
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
'<div class="szg-row"><label>间隔</label><input id="szg-int" type="number" min="500" step="100">',
'<span class="szg-dim">~</span><input id="szg-intmax" type="number" min="500" step="100" class="szg-half"><span class="szg-dim">ms 随机</span></div>',
'<div class="szg-adv-head" id="szg-adv-btn">▸ 时间微调</div>',
'<div id="szg-adv" hidden>',
'<div class="szg-row szg-w"><label>翻页停顿</label><input id="szg-pgap" type="number" min="0" step="50"><span class="szg-dim">ms</span></div>',
'<div class="szg-row szg-w"><label>换课停顿</label><input id="szg-cgap" type="number" min="0" step="50"><span class="szg-dim">ms</span></div>',
'<div class="szg-row szg-w"><label>等提示</label><input id="szg-mwait" type="number" min="500" step="100"><span class="szg-dim">ms</span></div>',
'<div class="szg-tiny">“等提示”是点完选课后最多等多久来判断成没成。调小了跑得快，但可能没等到结果就当失败；网慢就调大。</div>',
'</div>',
'<div class="szg-checks">',
'<label><input type="checkbox" id="szg-confirm">自动确认弹窗</label>',
'<label><input type="checkbox" id="szg-unknown">余量认不出也点</label>',
'<label><input type="checkbox" id="szg-stopdone">抢到就停止</label>',
'<label><input type="checkbox" id="szg-sound">声音提醒</label>',
'<label><input type="checkbox" id="szg-dry">试运行(不点击)</label>',
'<label><input type="checkbox" id="szg-resume">登录后自动继续</label>',
'<label><input type="checkbox" id="szg-autologin">掉线自动登录</label>',
'</div>',
'<div class="szg-adv-head" id="szg-login-btn">▸ 自动登录 / 验证码识别</div>',
'<div id="szg-login" hidden>',
'<div class="szg-row szg-w"><label>学号</label><input id="szg-user" autocomplete="off" placeholder="登录用的学号"></div>',
'<div class="szg-row szg-w"><label>密码</label><input id="szg-pass" type="password" autocomplete="new-password" placeholder="登录密码"></div>',
'<div class="szg-row szg-w"><label>识别</label><select id="szg-ocrp"></select></div>',
'<div class="szg-row szg-w"><label>Key</label><input id="szg-ocrkey" type="password" autocomplete="new-password" placeholder="服务商给的 API Key"></div>',
'<div class="szg-row szg-w"><label>接口</label><input id="szg-ocrurl" placeholder="留空 = 用默认地址"></div>',
'<div class="szg-row szg-w"><label>模型</label><input id="szg-ocrmodel" placeholder="留空 = 用默认模型"></div>',
'<div class="szg-row szg-w"><label>最多试</label><input id="szg-ocrtry" type="number" min="1" max="20" class="szg-half">',
'<span class="szg-dim">轮登录</span></div>',
'<div class="szg-row szg-w"><label>交叉验证</label><input id="szg-ocrvote" type="number" min="1" max="3" class="szg-half">',
'<span class="szg-dim">种处理对一遍</span></div>',
'<div class="szg-row szg-w"><label>转圈超</label><input id="szg-stall" type="number" min="10" max="300" class="szg-half">',
'<span class="szg-dim">秒 = 判定掉线</span></div>',
'<div class="szg-btns"><button id="szg-testocr">测试识别</button><button id="szg-clearauth">清除账号密码</button></div>',
'<div class="szg-tiny">账号密码和 Key 明文存在本浏览器里，同域的其它脚本读得到，公用电脑用完请点“清除账号密码”。',
'密码连错会被学校锁账号，所以一旦提示密码/账号错误，脚本会立刻停手不再重试。</div>',
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
'<div id="szg-tip">首次使用请先点“扫描诊断”，确认表头和余量识别正确再开始。</div>',
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
function setStateText(t, extra) {
  var e = document.getElementById('szg-state');
  if (!e) return;
  e.textContent = t;
  e.className = 'szg-badge' + (extra ? ' ' + extra : '');
}
function setState(on) { setStateText(on ? '运行中' : '已停止', on ? 'szg-run' : ''); }

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
  cfg.interval = clampNum(g('szg-int'), 500, 60000, DEFAULT_CFG.interval);
  cfg.intervalMax = clampNum(g('szg-intmax'), 500, 60000, DEFAULT_CFG.intervalMax);
  if (cfg.intervalMax < cfg.interval) { cfg.intervalMax = cfg.interval; g('szg-intmax').value = cfg.intervalMax; }
  cfg.pageGap  = clampNum(g('szg-pgap'),  0,   10000, DEFAULT_CFG.pageGap);
  cfg.clickGap = clampNum(g('szg-cgap'),  0,   10000, DEFAULT_CFG.clickGap);
  cfg.msgWait  = clampNum(g('szg-mwait'), 500, 20000, DEFAULT_CFG.msgWait);
  cfg.autoConfirm = g('szg-confirm').checked;
  cfg.clickUnknown = g('szg-unknown').checked;
  cfg.stopOnDone = g('szg-stopdone').checked;
  cfg.sound = g('szg-sound').checked;
  cfg.dryRun = g('szg-dry').checked;
  cfg.autoResume = g('szg-resume').checked;
  cfg.autoLogin = g('szg-autologin').checked;
  cfg.ocrProvider = g('szg-ocrp').value;
  cfg.ocrUrl = g('szg-ocrurl').value.trim();
  cfg.ocrModel = g('szg-ocrmodel').value.trim();
  cfg.ocrMaxTry = clampNum(g('szg-ocrtry'), 1, 20, DEFAULT_CFG.ocrMaxTry);
  cfg.ocrVote = clampNum(g('szg-ocrvote'), 1, 3, DEFAULT_CFG.ocrVote);
  cfg.stallSec = clampNum(g('szg-stall'), 10, 300, DEFAULT_CFG.stallSec);
  saveCfg();
  // 账号密码改了就说明是新的一组，把之前“密码错，别再试”的封印解开
  var u = g('szg-user').value.trim(), p = g('szg-pass').value, k = g('szg-ocrkey').value.trim();
  if (u !== auth.user || p !== auth.pass) loginBlocked = '';
  auth.user = u; auth.pass = p; auth.key = k;
  saveAuth();
}
function fillCfg() {
  var g = function (id) { return document.getElementById(id); };
  g('szg-mode').value = cfg.mode;
  g('szg-inc').value = cfg.include;
  g('szg-exc').value = cfg.exclude;
  g('szg-int').value = cfg.interval;
  g('szg-intmax').value = cfg.intervalMax;
  g('szg-pgap').value = cfg.pageGap;
  g('szg-cgap').value = cfg.clickGap;
  g('szg-mwait').value = cfg.msgWait;
  g('szg-confirm').checked = cfg.autoConfirm;
  g('szg-unknown').checked = cfg.clickUnknown;
  g('szg-stopdone').checked = cfg.stopOnDone;
  g('szg-sound').checked = cfg.sound;
  g('szg-dry').checked = cfg.dryRun;
  g('szg-resume').checked = cfg.autoResume;
  g('szg-autologin').checked = cfg.autoLogin;
  g('szg-ocrp').value = cfg.ocrProvider;
  g('szg-ocrurl').value = cfg.ocrUrl;
  g('szg-ocrmodel').value = cfg.ocrModel;
  g('szg-ocrtry').value = cfg.ocrMaxTry;
  g('szg-ocrvote').value = cfg.ocrVote;
  g('szg-stall').value = cfg.stallSec;
  g('szg-user').value = auth.user;
  g('szg-pass').value = auth.pass;
  g('szg-ocrkey').value = auth.key;
  ocrHints();
}

/* 选了服务商之后，把该家的默认地址/模型写进输入框的 placeholder 作提示。
 * 框里留空就按这个默认值走。 */
function ocrHints() {
  var p = OCR_PRESETS[cfg.ocrProvider] || OCR_PRESETS.custom;
  var u = document.getElementById('szg-ocrurl'), m = document.getElementById('szg-ocrmodel');
  if (u) u.placeholder = p.url || '必填：接口地址';
  if (m) m.placeholder = p.model || '必填：模型名';
}

/* ---------- 掉线 → 重新登录 → 自动接着抢 ----------
 * 重新登录会让页面整个刷新，脚本从头加载，内存里的进度全没。
 * 所以把“本来在抢课”这件事和已抢到/已跳过的清单落到 localStorage，
 * 重新登录回来后自己接上，不用人再点一次开始。 */
var RESUME_KEY = 'szg_resume_v1';
var waitingLogin = false;
var loginWatch = null;

function setToArr(s) { var a = []; s.forEach(function (v) { a.push(v); }); return a; }

function saveResume(want) {
  if (!cfg.autoResume) { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} return; }
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      want: want ? 1 : 0, got: stats.got,
      done: setToArr(done), skip: setToArr(skip), ts: Date.now()
    }));
  } catch (e) {}
}
function loadResume() {
  try {
    var r = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
    if (!r || !r.want) return null;
    if (Date.now() - (r.ts || 0) > 6 * 3600 * 1000) return null;   // 隔太久的不认，免得莫名其妙自己跑起来
    return r;
  } catch (e) { return null; }
}

/* 掉线不算“停止”，是“等你登录”。状态留着，登录完自动继续。
 * reason='stall' 是“一直转圈”那种：页面并没有跳登录页，是接口在后台已经不认这个会话了，
 * 干等没用，直接跳回登录页重来。 */
function pauseForLogin(reason) {
  running = false;
  stopWatchdog();
  waitingLogin = true;
  loginTries = 0;
  setStateText('等待登录', 'szg-wait');
  saveResume(true);
  if (reason === 'stall') {
    log('列表连续转圈超过 ' + cfg.stallSec + ' 秒，按掉线处理，正在跳回登录页…', 'err');
    goTo(LOGIN_URL, randRange(500, 1000));
    return;
  }
  if (cfg.autoLogin && auth.user && auth.pass && !loginBlocked) {
    log('掉线了，正在自动重新登录…', 'warn');
  } else {
    log('⚠ 掉线了，需要你自己重新登录。登录完成后会自动接着抢。', 'err');
    startAlarm('会话已过期，请重新登录，登录后自动继续');
  }
  watchLogin();
}

/* 掉线后把光标放进验证码框，回到页面直接敲就行。
 * 只是移动焦点——验证码长什么样、密码是什么，脚本不读也不填。
 * 只做一次，免得你点到别处又被抢回去。 */
var captchaFocused = false;
function focusCaptcha() {
  var docs = allDocs();
  for (var i = 0; i < docs.length; i++) {
    var ins = qsa(docs[i], 'input').filter(function (e) {
      if (!visible(e) || e.type === 'password' || e.type === 'hidden') return false;
      var s = (e.placeholder || '') + ' ' + (e.name || '') + ' ' + (e.id || '') + ' ' + cls(e);
      return /验证码|captcha|checkcode|verifycode|yzm/i.test(s);
    });
    if (ins.length) { try { ins[0].focus(); } catch (e) {} return true; }
  }
  return false;
}

/* 盯着登录状态。开了自动登录就自己填自己点，没开就把光标挪到验证码框等人来填。
 * 轮询间隔取随机值，别踩出一个每 4 秒一次的固定节拍。 */
function watchLogin() {
  if (loginWatch) return;
  captchaFocused = false;
  loginWatch = true;
  (async function loop() {
    while (waitingLogin) {
      if (!sessionLost() && !findLoginForm()) {
        waitingLogin = false;
        stopAlarm();
        log('登录已恢复', 'ok');
        backToCourse();
        break;
      }
      if (cfg.autoLogin && !loginBlocked && !autoLoginOff) {
        if (loginTries >= cfg.ocrMaxTry) {
          log('自动登录试了 ' + loginTries + ' 次都没成，改成等你手动登录', 'err');
          startAlarm('自动登录失败，请手动登录');
          autoLoginOff = true;                   // 只暂停本次，配置和复选框都不动
          captchaFocused = focusCaptcha();
        } else {
          loginTries++;
          var r = await autoLogin();
          if (r === 'ok') {
            waitingLogin = false;
            stopAlarm();
            log('自动登录成功（第 ' + loginTries + ' 次）', 'ok');
            backToCourse();
            break;
          }
          if (r === 'stop') {
            setStateText('等待登录', 'szg-wait');   // 别把徽章停在“自动登录中”，会让人以为还在试
            captchaFocused = focusCaptcha();
          }
        }
      } else if (!captchaFocused) {
        captchaFocused = focusCaptcha();
      }
      await sleep(randRange(2500, 4500));
    }
    loginWatch = false;
  })();
}

/* 页面刚加载完时调用：上次是不是抢到一半被踢下线的 */
function tryAutoResume() {
  if (!cfg.autoResume) return;
  var r = loadResume();
  if (!r) return;
  stats.got = r.got || 0;
  (r.done || []).forEach(function (k) { done.add(k); });
  (r.skip || []).forEach(function (k) { skip.add(k); });
  setStat('szg-got', stats.got);
  log('上次是在抢课中途断的（已抢到 ' + stats.got + ' 门），准备自动接上', 'ok');
  if (sessionLost()) {
    waitingLogin = true;
    loginTries = 0;
    setStateText('等待登录', 'szg-wait');
    if (cfg.autoLogin && auth.user && auth.pass) {
      log('现在在登录页，正在自动登录…', 'warn');
    } else {
      log('现在还在登录页，登录完会自动开始', 'warn');
      startAlarm('请重新登录，登录后自动继续抢课');
    }
    watchLogin();
  } else {
    setTimeout(function () { if (!running && !waitingLogin) start(); }, 2500);
  }
}

function start() {
  if (running) { log('已经在运行了'); return; }
  waitingLogin = false;
  stopAlarm();
  readCfg();
  if (cfg.mode === 'include' && !splitKw(cfg.include).length) {
    log('“仅关键词匹配”模式下必须填写包含关键词', 'err');
    return;
  }
  running = true;
  autoLoginOff = false;      // 手动点“开始抢课”＝重新给自动登录一次机会
  stats.round = 0;
  setState(true);
  log('开始运行 · 模式=' + (cfg.mode === 'all' ? '所有有余量的课' : '关键词[' + cfg.include + ']') +
      ' · 间隔=' + cfg.interval + '~' + cfg.intervalMax + 'ms 随机' + (cfg.dryRun ? ' · 试运行' : ''), 'ok');
  if (cfg.autoLogin) {
    log('掉线自动登录：开（' + ((OCR_PRESETS[cfg.ocrProvider] || {}).name || cfg.ocrProvider) +
        ' · 通道 ' + transportName() + '）');
  }
  if (!timer.ok) log('提示：本页拿不到 Worker 定时器，切到后台标签页会被浏览器限速，建议保持本页在前台', 'warn');
  try {
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
  } catch (e) {}
  saveResume(true);
  startWatchdog();
  mainLoop();
}
/* 手动停止 = 任务结束，把“登录后自动继续”的标记也清掉，
 * 免得下次打开页面自己莫名其妙跑起来 */
function stop() {
  waitingLogin = false;                  // watchLogin 的循环每轮都看这个标记，置 false 它自己就退了
  loginWatch = false;
  stopWatchdog();
  stopAlarm();
  saveResume(false);
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

  var g = function (id) { return document.getElementById(id); };
  /* 服务商下拉框的选项必须先塞进去再 fillCfg：
   * 给一个还没有 option 的 <select> 赋 value 是无效的，它会停在第一项上，
   * 紧接着的 readCfg 又把这个“第一项”当成用户的选择存回配置，存的服务商就被吞了。 */
  var sel = g('szg-ocrp');
  Object.keys(OCR_PRESETS).forEach(function (k) {
    var o = document.createElement('option');
    o.value = k;
    o.textContent = OCR_PRESETS[k].name;
    sel.appendChild(o);
  });
  fillCfg();
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
  g('szg-login-btn').onclick = function () {
    var box = g('szg-login');
    box.hidden = !box.hidden;
    this.textContent = (box.hidden ? '▸' : '▾') + ' 自动登录 / 验证码识别';
  };
  g('szg-testocr').onclick = testOcr;
  g('szg-clearauth').onclick = function () {
    auth = { user: '', pass: '', key: '' };
    saveAuth();                            // 写空值 + manual 标记，刷新后 PRESET 不会再填回来
    g('szg-user').value = '';
    g('szg-pass').value = '';
    g('szg-ocrkey').value = '';
    g('szg-autologin').checked = false;
    cfg.autoLogin = false;
    loginBlocked = '';
    saveCfg();
    log('账号密码和 API Key 已从本浏览器清除', 'ok');
  };
  ['szg-mode', 'szg-inc', 'szg-exc', 'szg-int', 'szg-intmax', 'szg-pgap', 'szg-cgap', 'szg-mwait',
   'szg-confirm', 'szg-unknown', 'szg-stopdone', 'szg-sound', 'szg-dry', 'szg-resume',
   'szg-autologin', 'szg-ocrp', 'szg-ocrurl', 'szg-ocrmodel', 'szg-ocrkey', 'szg-ocrtry',
   'szg-ocrvote', 'szg-stall', 'szg-user', 'szg-pass'].forEach(function (id) {
    var e = g(id);
    if (e) e.onchange = function () { readCfg(); ocrHints(); };
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
  if (findLoginForm()) return true;             // 登录页也得挂，不然自动登录没人干活
  return findSelectBtns(pickDoc()).length > 0;   // 地址认不出来时，看页面上有没有选课按钮
}

function mount() {
  buildPanel();
  log('助手已加载。先点“扫描诊断”核对识别结果，再点“开始抢课”。');
  window.__SZU_GRAB__ = {
    start: start,
    stop: stop,
    diag: diag,
    login: autoLogin,
    testOcr: testOcr,
    cfg: cfg,
    show: function () { if (panel) { panel.style.display = ''; panel.classList.remove('szg-collapsed'); } }
  };
  tryAutoResume();
}

/* iframe 可能还没加载完，隔一会儿重试几次 */
(function boot(tries) {
  if (window.__SZU_GRAB__) return;
  if (isCoursePage()) { mount(); return; }
  if (tries > 0) setTimeout(function () { boot(tries - 1); }, 1500);
})(20);

})();
