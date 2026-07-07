/**
 * 泰拉瑞亚服务器管理面板 - 安装后脚本
 * 在 npm install 完成后自动创建所需目录
 */
const fs = require('fs-extra');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const dirs = [
  'data',
  'downloads',
  'logs',
  'runtime/vanilla/versions',
  'runtime/tmodloader/versions',
  'servers/vanilla/Worlds',
  'servers/vanilla/Logs',
  'servers/tmodloader/Worlds',
  'servers/tmodloader/Mods',
  'servers/tmodloader/Logs',
  'backups/vanilla',
  'backups/tmodloader',
  'public/assets',
];

async function postinstall() {
  let count = 0;
  for (const d of dirs) {
    const fullPath = path.join(ROOT, d);
    if (!await fs.pathExists(fullPath)) {
      await fs.ensureDir(fullPath);
      console.log(`  [OK] 目录已创建: ${d}`);
      count++;
    }
  }
  if (count === 0) {
    console.log('  [OK] 所有目录已就绪');
  }
}

postinstall().catch(err => {
  console.error('目录创建失败:', err.message);
});
