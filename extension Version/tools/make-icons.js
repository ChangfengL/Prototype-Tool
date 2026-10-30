// 一次性脚本：生成扩展图标（REDLINE 风格：朱红圆角方块 + 白色十字准星 ⌖）
// 用法：NODE_PATH=C:\Users\11017\.workbuddy\binaries\node\workspace\node_modules node make-icons.js
const { chromium } = require('playwright');
const path = require('path');

const SIZES = [16, 32, 48, 128];

const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#FF4438"/>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="none" stroke="rgba(0,0,0,.18)" stroke-width="4"/>
  <g stroke="#FFFFFF" stroke-width="10" stroke-linecap="round" fill="none">
    <circle cx="64" cy="64" r="26"/>
    <line x1="64" y1="18" x2="64" y2="38"/>
    <line x1="64" y1="90" x2="64" y2="110"/>
    <line x1="18" y1="64" x2="38" y2="64"/>
    <line x1="90" y1="64" x2="110" y2="64"/>
  </g>
  <circle cx="64" cy="64" r="8" fill="#FFFFFF"/>
</svg>`;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage();
  const outDir = path.join(__dirname, '..', 'icons');
  for (const s of SIZES) {
    await page.setViewportSize({ width: s, height: s });
    await page.setContent(
      `<style>html,body{margin:0;padding:0;overflow:hidden;}</style>${svg(s)}`
    );
    await page.screenshot({
      path: path.join(outDir, `icon${s}.png`),
      clip: { x: 0, y: 0, width: s, height: s },
    });
    console.log(`icon${s}.png done`);
  }
  await browser.close();
})();
