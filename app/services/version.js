const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');
const { PATHS, getCurrentRuntimeDir } = require('../utils/paths');

// 跨平台创建目录软链接（Linux 用 dir，Windows 用 junction）
async function createSymlink(target, linkPath) {
  const isWin = process.platform === 'win32';
  await fs.remove(linkPath).catch(() => {});
  try {
    await fs.symlink(target, linkPath, isWin ? 'junction' : 'dir');
    // 验证软链接是否有效
    const stat = await fs.stat(linkPath).catch(() => null);
    if (!stat) throw new Error('symlink created but stat failed');
    logger.info('VersionService', `Symlink created: ${linkPath} -> ${target}`);
    return true;
  } catch (e) {
    logger.warn('VersionService', `Symlink failed (${e.message}), trying copy fallback`);
    // fallback: 写入一个标记文件 + 复制内容
    await fs.remove(linkPath).catch(() => {});
    await fs.ensureDir(linkPath);
    await fs.writeJson(path.join(linkPath, '.symlink_target.json'), { target, createdAt: new Date().toISOString() });
    const items = await fs.readdir(target);
    for (const item of items) {
      await fs.copy(path.join(target, item), path.join(linkPath, item)).catch(() => {});
    }
    logger.info('VersionService', `Copy fallback done: ${target} -> ${linkPath}`);
    return true;
  }
}

// ============================================================
// Terraria 官方服务端下载
// 多源策略：
// 1. 优先解析官方下载页面获取最新版本
// 2. 其次尝试 Wiki 页面
// 3. 最后使用已知版本回退
// ============================================================
const VANILLA_DOWNLOAD_BASE = 'https://terraria.org/api/download/pc-dedicated-server';
const VANILLA_KNOWN_VERSIONS = [
  { name: 'terraria-server-1456', version: '1.4.5.6' },
  { name: 'terraria-server-1449', version: '1.4.4.9' },
  { name: 'terraria-server-1448', version: '1.4.4.8' },
  { name: 'terraria-server-1447', version: '1.4.4.7' },
];

// 镜像源加速地址
const MIRROR_URLS = {
  vanilla: 'http://bk.kuchuangyun.com/tailachunjing/chunjing.zip',
  tmodloader: 'http://bk.kuchuangyun.com/tmod/tmod.zip',
};

/**
 * 从文件名解析版本号
 * terraria-server-1456.zip -> 1.4.5.6
 * terraria-server-1449.zip -> 1.4.4.9
 */
function parseTerrariaServerVersion(fileName) {
  if (!fileName) return null;
  const match = fileName.match(/terraria-server-(\d+)\.zip/i);
  if (!match) return null;
  const raw = match[1]; // 1456
  // 版本号格式：1.x.y.z
  // 1456 -> 1.4.5.6, 1449 -> 1.4.4.9
  return raw.split('').join('.');
}

// ============================================================
// tModLoader 下载
// GitHub Releases 提供跨平台的 tModLoader.zip
// ============================================================
const TML_GITHUB_API = 'https://api.github.com/repos/tModLoader/tModLoader/releases/latest';
const TML_GITHUB_DL = 'https://github.com/tModLoader/tModLoader/releases/download';

// 已知稳定版本（备用，API 失败时使用）
const TML_FALLBACK = {
  version: 'v2026.05.3.0',
  downloadUrl: 'https://github.com/tModLoader/tModLoader/releases/download/v2026.05.3.0/tModLoader.zip',
};

class VersionService {
  constructor(stateService, consoleService, downloader, backupService, gameService) {
    this.stateService = stateService;
    this.console = consoleService;
    this.downloader = downloader;
    this.backup = backupService;
    this.gameService = gameService;
  }

  async getVanillaVersion() {
    const versionPath = path.join(PATHS.RUNTIME_VANILLA, 'version.json');
    try {
      if (await fs.pathExists(versionPath)) {
        const info = await fs.readJson(versionPath);
        info.type = 'vanilla';
        info.typeLabel = '纯净服';
        info.installed = true;
        return info;
      }
    } catch (e) { /* ignore */ }
    return { version: this.stateService.get('vanillaVersion') || null, type: 'vanilla', typeLabel: '纯净服', installed: false };
  }

  async getTmodVersion() {
    const versionPath = path.join(PATHS.RUNTIME_TMODLOADER, 'version.json');
    try {
      if (await fs.pathExists(versionPath)) {
        const info = await fs.readJson(versionPath);
        info.type = 'tmodloader';
        info.typeLabel = 'TModLoader';
        info.installed = true;
        return info;
      }
    } catch (e) { /* ignore */ }
    return { version: this.stateService.get('tmodloaderVersion') || null, type: 'tmodloader', typeLabel: 'TModLoader', installed: false };
  }

  // -------- 纯净服版本检测（多源策略） --------
  async checkVanillaRemote() {
    // 策略1: 尝试从官方 API 获取 dedicated server 列表
    try {
      const apiResult = await this._fetchJson(VANILLA_DOWNLOAD_BASE);
      if (Array.isArray(apiResult)) {
        // API 可能返回文件列表
        const zipFile = apiResult.find(f => /terraria-server-\d+\.zip/i.test(f.name || f));
        if (zipFile) {
          const name = zipFile.name || zipFile;
          const version = parseTerrariaServerVersion(name);
          if (version) {
            return { version, linuxUrl: `${VANILLA_DOWNLOAD_BASE}/${name}`, source: 'official_api' };
          }
        }
      }
    } catch (e) {
      logger.debug('VersionService', 'API JSON failed, trying page parse', e.message);
    }

    // 策略2: 尝试解析官方下载页面 HTML
    try {
      const html = await this._fetchText('https://terraria.org/');
      // 匹配 dedicated server 下载链接
      const match = html.match(/["']([^"']*terraria-server-(\d+)\.zip)["']/i);
      if (match) {
        const url = match[1].startsWith('http') ? match[1] : `https://terraria.org${match[1]}`;
        const version = match[2].split('').join('.');
        return { version, linuxUrl: url, source: 'official_page' };
      }
      // 也尝试匹配 api/download 路径
      const match2 = html.match(/api\/download\/pc-dedicated-server\/(terraria-server-\d+)\.zip/i);
      if (match2) {
        const version = parseTerrariaServerVersion(match2[1] + '.zip');
        return { version, linuxUrl: `${VANILLA_DOWNLOAD_BASE}/${match2[1]}.zip`, source: 'official_page' };
      }
    } catch (e) {
      logger.warn('VersionService', 'Failed to parse official page', e.message);
    }

    // 策略3: 尝试 Wiki 页面
    try {
      const wikiHtml = await this._fetchText('https://terraria.wiki.gg/wiki/Server');
      const match = wikiHtml.match(/terraria-server-(\d+)\.zip/i);
      if (match) {
        const version = match[1].split('').join('.');
        return { version, linuxUrl: `${VANILLA_DOWNLOAD_BASE}/terraria-server-${match[1]}.zip`, source: 'wiki' };
      }
    } catch (e) {
      logger.warn('VersionService', 'Wiki parse failed', e.message);
    }

    // 策略4: 回退到已知最新版本
    const latest = VANILLA_KNOWN_VERSIONS[0];
    logger.info('VersionService', `Using known fallback version: ${latest.version}`);
    return {
      version: latest.version,
      linuxUrl: `${VANILLA_DOWNLOAD_BASE}/${latest.name}.zip`,
      source: 'known_fallback',
    };
  }

  // -------- tModLoader 版本检测 --------
  async checkTmodRemote() {
    try {
      const data = await this._fetchJson(TML_GITHUB_API);
      if (data && data.tag_name) {
        // 查找 tModLoader.zip 资产（跨平台通用）
        const asset = data.assets && data.assets.find(a => a.name === 'tModLoader.zip');
        return {
          version: data.tag_name,
          downloadUrl: asset ? asset.browser_download_url : `${TML_GITHUB_DL}/${data.tag_name}/tModLoader.zip`,
          htmlUrl: data.html_url,
          publishedAt: data.published_at,
          source: 'github_api',
        };
      }
    } catch (e) {
      logger.warn('VersionService', 'GitHub API failed, using fallback', e.message);
    }

    // 备用
    return { ...TML_FALLBACK, source: 'fallback' };
  }

  // -------- 纯净服更新 --------
  async updateVanilla(taskCallback, source = 'mirror') {
    const mode = 'vanilla';

    taskCallback({ task: 'version.update', percent: 0, message: '正在检查最新版本...' });

    const remote = await this.checkVanillaRemote();
    if (!remote.linuxUrl) {
      throw new Error('无法获取纯净服下载地址。\n提示: 可尝试通过 SteamCMD 安装:\n  steamcmd +login anonymous +app_update 105600 validate +quit');
    }

    const current = await this.getVanillaVersion();
    if (current.version === remote.version && current.installed) {
      taskCallback({ task: 'version.update', percent: 100, message: '已是最新版本' });
      return { updated: false, version: current.version };
    }

    taskCallback({ task: 'version.update', percent: 10, message: '正在停止服务器...' });
    if (this.gameService.isRunning()) {
      await this.gameService.stop();
    }

    taskCallback({ task: 'version.update', percent: 20, message: '正在创建备份...' });
    await this.backup.create(mode, 'before_version_update');

    // 选择下载源
    const downloadUrl = (source === 'mirror') ? MIRROR_URLS.vanilla : remote.linuxUrl;
    const sourceLabel = (source === 'mirror') ? '国内镜像' : '海外官方';
    taskCallback({ task: 'version.update', percent: 30, message: `正在从${sourceLabel}下载纯净服务端 ${remote.version}...` });

    const zipName = `vanilla-${remote.version || Date.now()}.zip`;
    const zipPath = path.join(PATHS.DOWNLOADS, zipName);

    await this.downloader.downloadWithRetry(downloadUrl, zipPath, 3, (percent) => {
      taskCallback({ task: 'version.update', percent: 30 + Math.round(percent * 0.4), message: `正在从${sourceLabel}下载... ${percent}%` });
    });

    taskCallback({ task: 'version.update', percent: 70, message: '正在解压...' });

    const versionDir = path.join(PATHS.RUNTIME_VANILLA, 'versions', remote.version || String(Date.now()));
    await this.downloader.extractZip(zipPath, versionDir);

    taskCallback({ task: 'version.update', percent: 80, message: '正在查找服务端文件...' });

    // 解压后目录结构: versionDir/版本号/Linux/TerrariaServer.bin.x86_64
    // 查找实际的二进制文件
    const files = await this._findFiles(versionDir);
    let serverDir = versionDir;

    // 如果解压后有嵌套目录，找到包含 Linux 目录的路径
    for (const f of files) {
      if (f.includes('TerrariaServer') && !f.endsWith('.exe')) {
        serverDir = path.dirname(f);
      }
    }

    // 检查是否有多层嵌套（如 1449/Linux/）
    const subDirs = await fs.readdir(versionDir);
    for (const sub of subDirs) {
      const subPath = path.join(versionDir, sub);
      if ((await fs.stat(subPath)).isDirectory()) {
        const linuxPath = path.join(subPath, 'Linux');
        if (await fs.pathExists(linuxPath)) {
          serverDir = linuxPath;
        } else {
          // 也可能直接包含 TerrariaServer 文件的子目录
          const subFiles = await fs.readdir(subPath);
          if (subFiles.some(sf => sf.startsWith('TerrariaServer'))) {
            serverDir = subPath;
          }
        }
      }
    }

    taskCallback({ task: 'version.update', percent: 85, message: '正在设置执行权限...' });

    // 设置执行权限
    const serverFiles = await fs.readdir(serverDir);
    for (const sf of serverFiles) {
      if (sf.startsWith('TerrariaServer') || sf === 'TerrariaServer' || sf.includes('TerrariaServer')) {
        const fullPath = path.join(serverDir, sf);
        try { await fs.chmod(fullPath, 0o755); } catch (e) { /* ignore on windows */ }
      }
    }

    // 写入 version.json
    const versionInfo = {
      version: remote.version,
      installedAt: new Date().toISOString(),
      source: remote.source || 'official',
      serverDir: serverDir,
    };
    await fs.writeJson(path.join(PATHS.RUNTIME_VANILLA, 'version.json'), versionInfo, { spaces: 2 });

    // 更新 current 软链接
    await createSymlink(serverDir, path.join(PATHS.RUNTIME_VANILLA, 'current'));

    this.stateService.set('vanillaVersion', remote.version);
    await fs.remove(zipPath).catch(() => {});

    taskCallback({ task: 'version.update', percent: 100, message: '纯净服更新完成！' });
    logger.info('VersionService', `Vanilla updated to ${remote.version}`);

    return { updated: true, version: remote.version, serverDir };
  }

  // -------- tModLoader 更新 --------
  async updateTmod(taskCallback, source = 'mirror') {
    const mode = 'tmodloader';

    taskCallback({ task: 'version.update', percent: 0, message: '正在检查 TModLoader 最新版本...' });

    const remote = await this.checkTmodRemote();
    if (!remote.downloadUrl) {
      throw new Error('无法获取 TModLoader 下载地址');
    }

    const current = await this.getTmodVersion();
    if (current.version === remote.version && current.installed) {
      taskCallback({ task: 'version.update', percent: 100, message: '已是最新版本' });
      return { updated: false, version: current.version };
    }

    taskCallback({ task: 'version.update', percent: 10, message: '正在停止服务器...' });
    if (this.gameService.isRunning()) {
      await this.gameService.stop();
    }

    taskCallback({ task: 'version.update', percent: 20, message: '正在创建备份...' });
    await this.backup.create(mode, 'before_version_update');

    // 选择下载源
    const downloadUrl = (source === 'mirror') ? MIRROR_URLS.tmodloader : remote.downloadUrl;
    const sourceLabel = (source === 'mirror') ? '国内镜像' : '海外官方';
    taskCallback({ task: 'version.update', percent: 30, message: `正在从${sourceLabel}下载 TModLoader ${remote.version}...` });

    const zipName = `tmodloader-${remote.version}.zip`;
    const zipPath = path.join(PATHS.DOWNLOADS, zipName);

    await this.downloader.downloadWithRetry(downloadUrl, zipPath, 3, (percent) => {
      taskCallback({ task: 'version.update', percent: 30 + Math.round(percent * 0.4), message: `正在从${sourceLabel}下载... ${percent}%` });
    });

    taskCallback({ task: 'version.update', percent: 70, message: '正在解压...' });

    // 解压到版本目录
    const versionDir = path.join(PATHS.RUNTIME_TMODLOADER, 'versions', remote.version);
    await this.downloader.extractZip(zipPath, versionDir);

    taskCallback({ task: 'version.update', percent: 80, message: '正在查找服务端文件...' });

    // tModLoader.zip 解压后目录结构可能有多层嵌套
    // 先扁平化顶层目录
    let entries = await fs.readdir(versionDir);

    // 如果只有一个顶层目录（zip嵌套了文件夹），把内容移上来
    if (entries.length === 1) {
      const singleEntry = path.join(versionDir, entries[0]);
      const stat = await fs.stat(singleEntry);
      if (stat.isDirectory()) {
        const nestedFiles = await fs.readdir(singleEntry);
        for (const nf of nestedFiles) {
          const src = path.join(singleEntry, nf);
          const dst = path.join(versionDir, nf);
          if (!await fs.pathExists(dst)) {
            await fs.move(src, dst).catch(() => {});
          }
        }
        await fs.remove(singleEntry).catch(() => {});
      }
    }

    // 重新读取目录内容
    entries = await fs.readdir(versionDir);

    // 如果包含 Build 目录，文件在 Build/ 里面
    if (entries.includes('Build')) {
      const buildPath = path.join(versionDir, 'Build');
      const stat = await fs.stat(buildPath);
      if (stat.isDirectory()) {
        const buildFiles = await fs.readdir(buildPath);
        for (const bf of buildFiles) {
          const src = path.join(buildPath, bf);
          const dst = path.join(versionDir, bf);
          if (!await fs.pathExists(dst)) {
            await fs.move(src, dst).catch(() => {});
          }
        }
        await fs.remove(buildPath).catch(() => {});
      }
    }

    // 用 _findFiles 递归查找 tModLoaderServer 二进制（像纯净服一样）
    const allFiles = await this._findFiles(versionDir);
    let serverDir = versionDir;
    for (const f of allFiles) {
      const name = path.basename(f);
      if (name === 'tModLoaderServer' || name === 'tModLoaderServer.bin.x86_64' || name === 'tModLoaderServer.bin') {
        serverDir = path.dirname(f);
        break;
      }
    }

    // 给所有脚本加执行权限
    const serverFiles = await fs.readdir(serverDir);
    for (const sf of serverFiles) {
      if (sf.startsWith('tModLoaderServer') || sf.endsWith('.sh')) {
        try { await fs.chmod(path.join(serverDir, sf), 0o755); } catch (e) { /* ignore */ }
      }
    }

    // 写入 version.json
    const versionInfo = {
      version: remote.version,
      installedAt: new Date().toISOString(),
      source: remote.source || 'github',
      serverDir: serverDir,
    };
    await fs.writeJson(path.join(PATHS.RUNTIME_TMODLOADER, 'version.json'), versionInfo, { spaces: 2 });

    // 更新 current 软链接 → 指向二进制所在目录（像纯净服一样）
    await createSymlink(serverDir, path.join(PATHS.RUNTIME_TMODLOADER, 'current'));

    this.stateService.set('tmodloaderVersion', remote.version);
    await fs.remove(zipPath).catch(() => {});

    taskCallback({ task: 'version.update', percent: 100, message: 'TModLoader 更新完成！' });
    logger.info('VersionService', `TModLoader updated to ${remote.version}`);

    return { updated: true, version: remote.version };
  }

  // -------- 回滚 --------
  async rollback(mode) {
    this.console.write(`正在回滚 ${mode} 版本...`, 'system');

    const versionsDir = mode === 'vanilla'
      ? path.join(PATHS.RUNTIME_VANILLA, 'versions')
      : path.join(PATHS.RUNTIME_TMODLOADER, 'versions');
    await fs.ensureDir(versionsDir);

    const versions = await fs.readdir(versionsDir);
    const versionKey = mode === 'vanilla' ? 'vanillaVersion' : 'tmodloaderVersion';
    const currentVersion = this.stateService.get(versionKey);

    // 找前一个版本（不同与当前版本的最后一个）
    const previous = versions.filter(v => v !== currentVersion).pop();
    if (!previous) {
      throw new Error('没有找到可回滚的版本');
    }

    if (this.gameService.isRunning()) {
      await this.gameService.stop();
    }

    await this.backup.create(mode, 'before_rollback');

    const versionDir = path.join(versionsDir, previous);
    const currentPath = getCurrentRuntimeDir(mode);
    await createSymlink(versionDir, currentPath);

    this.stateService.set(versionKey, previous);
    this.console.write(`已回滚到版本: ${previous}`, 'info');
    return { version: previous };
  }

  // -------- 工具方法 --------
  async _fetchText(url) {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  async _fetchJson(url) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'terraria-panel/1.0',
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async _findFiles(dir) {
    const results = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this._findFiles(fullPath);
        results.push(...sub);
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }
}

module.exports = VersionService;
