const fs = require('fs-extra');
const path = require('path');
const AdmZip = require('adm-zip');
const logger = require('../utils/logger');
const { PATHS, getServersDir } = require('../utils/paths');

class FileService {
  constructor() {
    this._allowedRoots = [
      PATHS.ROOT,
      PATHS.SERVERS_VANILLA,
      PATHS.SERVERS_TMODLOADER,
      PATHS.WORLDS_TMODLOADER,
      PATHS.MODS_DIR,
      PATHS.MODCONFIGS_DIR,
      PATHS.DOWNLOADS,
      PATHS.LOGS,
      PATHS.DATA,
    ];
  }

  _isPathSafe(targetPath) {
    const resolved = path.resolve(targetPath);
    return this._allowedRoots.some(root => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    });
  }

  async list(dirPath) {
    if (!dirPath) throw new Error('目录路径不能为空');
    if (dirPath === 'servers') dirPath = PATHS.SERVERS_VANILLA;

    const resolved = path.resolve(dirPath);
    if (!this._isPathSafe(resolved)) throw new Error('无权访问该目录');
    if (!await fs.pathExists(resolved)) return { path: resolved, parentPath: this._getParentPath(resolved), items: [] };

    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error('路径不是目录');

    const names = await fs.readdir(resolved);
    const items = [];

    for (const name of names) {
      try {
        const fullPath = path.join(resolved, name);
        const itemStat = await fs.stat(fullPath);
        items.push({
          name,
          path: fullPath,
          type: itemStat.isDirectory() ? 'directory' : 'file',
          size: itemStat.isDirectory() ? null : itemStat.size,
          modifiedAt: itemStat.mtime.toISOString(),
        });
      } catch (e) { /* skip */ }
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return { path: resolved, parentPath: this._getParentPath(resolved), items };
  }

  async read(filePath) {
    if (!filePath) throw new Error('文件路径不能为空');
    const resolved = path.resolve(filePath);
    if (!this._isPathSafe(resolved)) throw new Error('无权访问该文件');
    if (!await fs.pathExists(resolved)) throw new Error('文件不存在');
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) throw new Error('路径是目录，不能读取');
    if (stat.size > 10 * 1024 * 1024) throw new Error('文件过大，无法在线查看（超过 10MB）');
    return { path: resolved, name: path.basename(resolved), size: stat.size, content: await fs.readFile(resolved, 'utf8') };
  }

  async write(filePath, content) {
    if (!filePath) throw new Error('文件路径不能为空');
    const resolved = path.resolve(filePath);
    if (!this._isPathSafe(resolved)) throw new Error('无权写入该文件');
    await fs.writeFile(resolved, content, 'utf8');
    logger.info('FileService', `File written: ${resolved}`);
    return { path: resolved, success: true };
  }

  async rename(oldPath, newName) {
    if (!oldPath || !newName) throw new Error('参数不完整');
    const resolved = path.resolve(oldPath);
    if (!this._isPathSafe(resolved)) throw new Error('无权操作该文件');
    if (!await fs.pathExists(resolved)) throw new Error('文件不存在');
    const safeName = this._safeName(newName);
    const newPath = path.join(path.dirname(resolved), safeName);
    if (!this._isPathSafe(newPath)) throw new Error('目标路径不安全');
    if (await fs.pathExists(newPath)) throw new Error('目标名称已存在');
    await fs.move(resolved, newPath);
    logger.info('FileService', `Renamed: ${resolved} -> ${newPath}`);
    return { oldPath: resolved, newPath, success: true };
  }

  async remove(targetPath) {
    if (!targetPath) throw new Error('路径不能为空');
    const resolved = path.resolve(targetPath);
    if (!this._isPathSafe(resolved)) throw new Error('无权删除该文件');
    if (path.resolve(resolved) === path.resolve(PATHS.ROOT)) throw new Error('不能删除根目录');
    if (!await fs.pathExists(resolved)) throw new Error('文件不存在');
    await fs.remove(resolved);
    logger.info('FileService', `Removed: ${resolved}`);
    return { path: resolved, success: true };
  }

  async mkdir(dirPath, dirName) {
    if (!dirPath || !dirName) throw new Error('参数不完整');
    const resolved = path.resolve(dirPath);
    if (!this._isPathSafe(resolved)) throw new Error('无权在该目录下创建');
    const newDir = path.join(resolved, this._safeName(dirName));
    if (!this._isPathSafe(newDir)) throw new Error('目标路径不安全');
    if (await fs.pathExists(newDir)) throw new Error('目录已存在');
    await fs.ensureDir(newDir);
    return { path: newDir, success: true };
  }

  async getRoots(mode) {
    const serversDir = getServersDir(mode);
    return [
      { name: '面板根目录', path: PATHS.ROOT, type: 'directory' },
      { name: '服务器数据', path: serversDir, type: 'directory' },
      { name: 'tModLoader 世界', path: PATHS.WORLDS_TMODLOADER, type: 'directory' },
      { name: 'tModLoader 模组', path: PATHS.MODS_DIR, type: 'directory' },
      { name: 'tModLoader 配置', path: PATHS.MODCONFIGS_DIR, type: 'directory' },
      { name: '日志', path: PATHS.LOGS, type: 'directory' },
    ].filter((root, index, arr) => arr.findIndex(item => path.resolve(item.path) === path.resolve(root.path)) === index);
  }

  async startUpload(uploadId, fileName, destDir) {
    const resolved = path.resolve(destDir);
    if (!this._isPathSafe(resolved)) throw new Error('无权上传到该目录');
    await fs.ensureDir(resolved);
    const safeFileName = this._safeName(fileName);
    const tempDir = path.join(PATHS.DATA, 'uploads', uploadId);
    await fs.emptyDir(tempDir);
    return { uploadId, fileName: safeFileName, destDir: resolved, tempDir };
  }

  async writeUploadChunk(uploadId, index, data) {
    const tempDir = path.join(PATHS.DATA, 'uploads', uploadId);
    if (!await fs.pathExists(tempDir)) throw new Error('上传不存在或已过期');
    const chunkPath = path.join(tempDir, `${String(index).padStart(8, '0')}.part`);
    await fs.writeFile(chunkPath, Buffer.from(data || '', 'base64'));
    return { success: true };
  }

  async finishUpload(uploadState) {
    const tempDir = path.join(PATHS.DATA, 'uploads', uploadState.uploadId);
    const filePath = path.join(uploadState.destDir, uploadState.fileName);
    if (!this._isPathSafe(filePath)) throw new Error('目标路径不安全');
    const out = fs.createWriteStream(filePath);
    const chunks = (await fs.readdir(tempDir)).filter(n => n.endsWith('.part')).sort();

    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.on('finish', resolve);
      (async () => {
        try {
          for (const chunk of chunks) {
            await new Promise((res, rej) => {
              const input = fs.createReadStream(path.join(tempDir, chunk));
              input.on('error', rej);
              input.on('end', res);
              input.pipe(out, { end: false });
            });
          }
          out.end();
        } catch (e) { reject(e); }
      })();
    });

    await fs.remove(tempDir);
    const stat = await fs.stat(filePath);
    logger.info('FileService', `Upload completed: ${filePath} (${stat.size} bytes)`);
    return { path: filePath, name: uploadState.fileName, size: stat.size, success: true };
  }

  async compress(targetPath) {
    const resolved = path.resolve(targetPath);
    if (!this._isPathSafe(resolved)) throw new Error('无权压缩该路径');
    if (!await fs.pathExists(resolved)) throw new Error('路径不存在');
    const zipPath = `${resolved.replace(/[\\/]$/, '')}.zip`;
    if (!this._isPathSafe(zipPath)) throw new Error('目标路径不安全');
    const zip = new AdmZip();
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) zip.addLocalFolder(resolved, path.basename(resolved));
    else zip.addLocalFile(resolved);
    zip.writeZip(zipPath);
    return { path: zipPath, name: path.basename(zipPath), success: true };
  }

  async extract(zipPath, destDir) {
    const resolvedZip = path.resolve(zipPath);
    const resolvedDest = path.resolve(destDir || path.dirname(resolvedZip));
    if (!this._isPathSafe(resolvedZip) || !this._isPathSafe(resolvedDest)) throw new Error('无权解压该路径');
    if (!resolvedZip.toLowerCase().endsWith('.zip')) throw new Error('目前只支持解压 zip 文件');
    if (!await fs.pathExists(resolvedZip)) throw new Error('压缩包不存在');
    await fs.ensureDir(resolvedDest);
    const zip = new AdmZip(resolvedZip);
    const destRoot = path.resolve(resolvedDest).toLowerCase();
    for (const entry of zip.getEntries()) {
      const target = path.resolve(resolvedDest, entry.entryName).toLowerCase();
      if (!target.startsWith(destRoot + path.sep.toLowerCase()) && target !== destRoot) throw new Error('压缩包包含非法路径');
    }
    zip.extractAllTo(resolvedDest, true);
    return { path: resolvedDest, success: true };
  }

  _getParentPath(resolved) {
    const parent = path.dirname(resolved);
    return this._isPathSafe(parent) && parent !== resolved ? parent : null;
  }

  _safeName(name) {
    const safe = path.basename(String(name || '').replace(/[\x00-\x1F\x7F]/g, '').trim());
    if (!safe || safe === '.' || safe === '..') throw new Error('无效名称');
    return safe;
  }
}

module.exports = FileService;
