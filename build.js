/* 把主脚本同步到 Edge 扩展和离线 demo，避免几份代码各改各的。
 * 用法： node build.js  */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const src = fs.readFileSync(path.join(root, 'szu-auto-course.user.js'), 'utf8');

// 1) Edge / Chrome 扩展的内容脚本
fs.mkdirSync(path.join(root, 'edge-extension'), { recursive: true });
fs.writeFileSync(path.join(root, 'edge-extension', 'content.js'), src, 'utf8');

// 2) 离线仿真页：把脚本内联进去，双击就能跑
const demoPath = path.join(root, 'test', 'demo.html');
if (fs.existsSync(demoPath)) {
  let html = fs.readFileSync(demoPath, 'utf8');
  const start = html.indexOf('<!--SCRIPT-->');
  if (start >= 0) {
    html = html.slice(0, start) + '<!--SCRIPT-->\n<script>\n' + src + '\n</scr' + 'ipt>\n</body>\n</html>\n';
    fs.writeFileSync(demoPath, html, 'utf8');
  } else {
    console.warn('demo.html 里没有 <!--SCRIPT--> 标记，跳过');
  }
}

console.log('已同步：edge-extension/content.js' + (fs.existsSync(demoPath) ? '、test/demo.html' : ''));
