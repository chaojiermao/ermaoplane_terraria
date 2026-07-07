const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');
const AdmZip = require('adm-zip');
const logger = require('../utils/logger');
const { PATHS } = require('../utils/paths');

class DownloaderService {
  constructor() {
    this._activeDownloads = new Map();
    this._isWindows = process.platform === 'win32';
  }

  async downloadFile(url, destPath, onProgress) {
    await fs.ensureDir(path.dirname(destPath));
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;
      const req = protocol.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(this.downloadFile(res.headers.location, destPath, onProgress));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const stream = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total) {
            onProgress(Math.round((downloaded / total) * 100), downloaded, total);
          }
        });
        res.pipe(stream);
        stream.on('finish', () => resolve(destPath));
        stream.on('error', reject);
      });
      req.on('error', reject);
    });
  }

  async downloadWithRetry(url, destPath, retries = 3, onProgress) {
    let maxProgress = 0;
    const monotonicProgress = (percent, downloaded, total) => {
      if (percent > maxProgress) maxProgress = percent;
      if (onProgress) onProgress(maxProgress, downloaded, total);
    };
    for (let i = 0; i < retries; i++) {
      try {
        return await this.downloadFile(url, destPath, monotonicProgress);
      } catch (e) {
        logger.warn('DownloaderService', `Download attempt ${i + 1}/${retries} failed`, e.message);
        if (i === retries - 1) throw e;
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
      }
    }
  }

  /**
   * 解压 ZIP 文件 - 支持多方式跨平台
   * 优先级: adm-zip (纯JS) > system unzip > PowerShell (Windows)
   */
  async extractZip(zipPath, destDir) {
    await fs.ensureDir(destDir);
    const errors = [];

    // 方法1: adm-zip (纯JS, 跨平台, 无需系统命令)
    try {
      await this._extractWithAdmZip(zipPath, destDir);
      logger.info('DownloaderService', `adm-zip 解压成功: ${zipPath} -> ${destDir}`);
      return destDir;
    } catch (e) {
      errors.push(`adm-zip: ${e.message}`);
      logger.warn('DownloaderService', 'adm-zip 解压失败，尝试系统 unzip', e.message);
    }

    // 方法2: 系统 unzip (Linux/Mac)
    try {
      await this._extractWithSystemUnzip(zipPath, destDir);
      logger.info('DownloaderService', `system unzip 解压成功: ${zipPath} -> ${destDir}`);
      return destDir;
    } catch (e) {
      errors.push(`system unzip: ${e.message}`);
    }

    // 方法3: PowerShell Expand-Archive (Windows)
    if (this._isWindows) {
      try {
        await this._extractWithPowerShell(zipPath, destDir);
        logger.info('DownloaderService', `PowerShell 解压成功: ${zipPath} -> ${destDir}`);
        return destDir;
      } catch (e) {
        errors.push(`PowerShell: ${e.message}`);
      }
    }

    throw new Error(`所有解压方式均失败:\n${errors.join('\n')}`);
  }

  async _extractWithAdmZip(zipPath, destDir) {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    // 分批解压，每解压一个文件就 yield 一次事件循环，避免阻塞 WebSocket
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry.isDirectory) {
        const targetPath = path.join(destDir, entry.entryName);
        await fs.ensureDir(path.dirname(targetPath));
        await fs.writeFile(targetPath, entry.getData());
      }
      // 每处理 10 个文件让出事件循环
      if (i % 10 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  _extractWithSystemUnzip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const proc = spawn('unzip', ['-o', zipPath, '-d', destDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(destDir);
        else reject(new Error(`退出码 ${code}: ${stderr.substring(0, 300)}`));
      });
      proc.on('error', (e) => reject(e));
    });
  }

  _extractWithPowerShell(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const psCmd = `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`;
      const proc = spawn('powershell', ['-NoProfile', '-Command', psCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(destDir);
        else reject(new Error(`PowerShell 退出码 ${code}: ${stderr.substring(0, 300)}`));
      });
      proc.on('error', (e) => reject(e));
    });
  }

  /**
   * 解压 tar.gz - 支持多方式
   */
  async extractTarGz(tarPath, destDir) {
    await fs.ensureDir(destDir);
    const errors = [];

    // 方法1: 系统 tar (Linux/Mac)
    try {
      await this._extractWithSystemTar(tarPath, destDir);
      return destDir;
    } catch (e) {
      errors.push(`system tar: ${e.message}`);
    }

    // 方法2: 7z (Windows, 如果安装了)
    try {
      await this._extractWith7z(tarPath, destDir);
      return destDir;
    } catch (e) {
      errors.push(`7z: ${e.message}`);
    }

    throw new Error(`tar.gz 解压失败:\n${errors.join('\n')}`);
  }

  _extractWithSystemTar(tarPath, destDir) {
    return new Promise((resolve, reject) => {
      const proc = spawn('tar', ['-xzf', tarPath, '-C', destDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(destDir);
        else reject(new Error(`tar 退出码 ${code}: ${stderr.substring(0, 300)}`));
      });
      proc.on('error', (e) => reject(e));
    });
  }

  _extractWith7z(tarPath, destDir) {
    return new Promise((resolve, reject) => {
      const proc = spawn('7z', ['x', tarPath, `-o${destDir}`, '-y'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(destDir);
        else reject(new Error(`7z 退出码 ${code}: ${stderr.substring(0, 300)}`));
      });
      proc.on('error', (e) => reject(e));
    });
  }

  async runCommand(cmd, args, cwd, onOutput) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TERM: 'xterm' },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => {
        const text = d.toString();
        stdout += text;
        if (onOutput) onOutput(text);
      });
      proc.stderr.on('data', (d) => {
        const text = d.toString();
        stderr += text;
        if (onOutput) onOutput(text);
      });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`命令失败 (code ${code}): ${stderr.substring(0, 500)}`));
      });
      proc.on('error', reject);
    });
  }

  /**
   * 检查当前环境是否可用 unzip
   */
  hasSystemUnzip() {
    try {
      execSync('unzip -v', { stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = DownloaderService;
