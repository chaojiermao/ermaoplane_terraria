const os = require('os');
const si = require('systeminformation');
const logger = require('../utils/logger');

class SystemService {
  async getStatus() {
    try {
      const [cpu, mem, fsSize] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
      ]);

      // CPU
      const cpuUsage = Math.round(cpu.currentLoad * 10) / 10;
      const cpuCores = os.cpus().length;
      const cpuModel = os.cpus()[0]?.model?.trim() || 'Unknown';

      // Memory
      const memTotal = Math.round(mem.total / (1024 * 1024 * 1024) * 10) / 10;
      const memUsed = Math.round(mem.used / (1024 * 1024 * 1024) * 10) / 10;
      const memPercent = Math.round((mem.used / mem.total) * 100);

      // Disk
      const diskInfo = fsSize[0] || {};
      const diskTotal = Math.round((diskInfo.size || 0) / (1024 * 1024 * 1024) * 10) / 10;
      const diskUsed = Math.round((diskInfo.used || 0) / (1024 * 1024 * 1024) * 10) / 10;
      const diskPercent = Math.round((diskInfo.use || 0) * 10) / 10;

      // Uptime
      const uptimeSeconds = os.uptime();
      const uptime = this._formatUptime(uptimeSeconds);

      // Platform
      const platform = `${os.type()} ${os.release()} (${os.arch()})`;
      const hostname = os.hostname();

      return {
        cpu: { usage: cpuUsage, cores: cpuCores, model: cpuModel, load: os.loadavg()[0] || 0 },
        memory: { total: memTotal, used: memUsed, percent: memPercent, free: memTotal - memUsed },
        disk: { total: diskTotal, used: diskUsed, percent: diskPercent, free: Math.round((diskTotal - diskUsed) * 10) / 10 },
        uptime,
        uptimeSeconds,
        platform,
        hostname,
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      logger.warn('SystemService', 'Failed to get system info, using fallback', e.message);
      return this._fallback();
    }
  }

  _fallback() {
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const memUsed = memTotal - memFree;
    const memPercent = Math.round((memUsed / memTotal) * 100);

    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model?.trim() || 'Unknown';
    const cpuCores = cpus.length;

    return {
      cpu: { usage: null, cores: cpuCores, model: cpuModel, load: os.loadavg?.[0] || 0 },
      memory: {
        total: Math.round(memTotal / (1024 * 1024 * 1024) * 10) / 10,
        used: Math.round(memUsed / (1024 * 1024 * 1024) * 10) / 10,
        percent: memPercent,
        free: Math.round(memFree / (1024 * 1024 * 1024) * 10) / 10,
      },
      disk: { total: null, used: null, percent: null, free: null },
      uptime: this._formatUptime(os.uptime()),
      uptimeSeconds: os.uptime(),
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      hostname: os.hostname(),
      timestamp: new Date().toISOString(),
    };
  }

  _formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d > 0) parts.push(`${d}天`);
    if (h > 0) parts.push(`${h}小时`);
    parts.push(`${m}分钟`);
    return parts.join(' ');
  }
}

module.exports = SystemService;
