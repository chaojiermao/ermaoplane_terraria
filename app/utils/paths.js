const path = require('path');
const fs = require('fs-extra');

const ROOT = path.resolve(__dirname, '../..');
const TERRARIA_HOME = ROOT;
const TERRARIA_LOCAL = path.join(TERRARIA_HOME, '.local', 'share', 'Terraria');

const PATHS = {
  ROOT,
  APP: path.join(ROOT, 'app'),
  PUBLIC: path.join(ROOT, 'public'),
  DATA: path.join(ROOT, 'data'),
  DOWNLOADS: path.join(ROOT, 'downloads'),
  LOGS: path.join(ROOT, 'logs'),
  BACKUPS: path.join(ROOT, 'backups'),
  SCRIPTS: path.join(ROOT, 'scripts'),

  // Runtime - server binaries
  RUNTIME_VANILLA: path.join(ROOT, 'runtime', 'vanilla'),
  RUNTIME_TMODLOADER: path.join(ROOT, 'runtime', 'tmodloader'),

  // Servers - panel managed config data
  SERVERS_VANILLA: path.join(ROOT, 'servers', 'vanilla'),
  SERVERS_TMODLOADER: path.join(ROOT, 'servers', 'tmodloader'),

  // Config files
  CONFIG_VANILLA: path.join(ROOT, 'servers', 'vanilla', 'serverconfig.txt'),
  CONFIG_TMODLOADER: path.join(ROOT, 'servers', 'tmodloader', 'serverconfig.txt'),

  // Worlds
  WORLDS_VANILLA: path.join(TERRARIA_LOCAL, 'Worlds'),
  WORLDS_TMODLOADER: path.join(TERRARIA_LOCAL, 'tModLoader', 'Worlds'),

  // Mods
  MODS_DIR: path.join(TERRARIA_LOCAL, 'tModLoader', 'Mods'),
  MODCONFIGS_DIR: path.join(TERRARIA_LOCAL, 'tModLoader', 'ModConfigs'),
  ENABLED_JSON: path.join(TERRARIA_LOCAL, 'tModLoader', 'Mods', 'enabled.json'),
  INSTALL_TXT: path.join(TERRARIA_LOCAL, 'tModLoader', 'Mods', 'install.txt'),

  // State & config files
  STATE_FILE: path.join(ROOT, 'data', 'state.json'),
  SETTINGS_FILE: path.join(ROOT, 'data', 'settings.json'),
  USERS_FILE: path.join(ROOT, 'data', 'users.json'),
  DB_FILE: path.join(ROOT, 'data', 'panel.db'),

  // Log files
  PANEL_LOG: path.join(ROOT, 'logs', 'panel.log'),
  CONSOLE_LOG: path.join(ROOT, 'logs', 'console.log'),
  ERROR_LOG: path.join(ROOT, 'logs', 'error.log'),
  TMOD_CONSOLE_RAW_LOG: path.join(ROOT, 'logs', 'tmodloader-console-raw.log'),
  TMOD_PROCESS_LOG: path.join(ROOT, 'logs', 'tmodloader-process.log'),
  TMOD_PLAYER_RAW_LOG: path.join(ROOT, 'logs', 'tmodloader-player-raw.log'),
  VANILLA_CONSOLE_RAW_LOG: path.join(ROOT, 'logs', 'console-raw.log'),
  VANILLA_PLAYER_RAW_LOG: path.join(ROOT, 'logs', 'player-raw.log'),

  // Backups
  BACKUPS_VANILLA: path.join(ROOT, 'backups', 'vanilla'),
  BACKUPS_TMODLOADER: path.join(ROOT, 'backups', 'tmodloader'),
  BACKUPS_MODCONFIGS: path.join(ROOT, 'backups', 'modconfigs'),
  MODCONFIG_LOG: path.join(ROOT, 'logs', 'modconfig.log'),
};

function getCurrentRuntimeDir(mode) {
  if (mode === 'tmodloader') {
    return path.join(PATHS.RUNTIME_TMODLOADER, 'current');
  }
  return path.join(PATHS.RUNTIME_VANILLA, 'current');
}

function getWorldsDir(mode) {
  return mode === 'tmodloader' ? PATHS.WORLDS_TMODLOADER : PATHS.WORLDS_VANILLA;
}

function getServerConfigPath(mode) {
  return mode === 'tmodloader' ? PATHS.CONFIG_TMODLOADER : PATHS.CONFIG_VANILLA;
}

function getBackupsDir(mode) {
  return mode === 'tmodloader' ? PATHS.BACKUPS_TMODLOADER : PATHS.BACKUPS_VANILLA;
}

function getServersDir(mode) {
  return mode === 'tmodloader' ? PATHS.SERVERS_TMODLOADER : PATHS.SERVERS_VANILLA;
}

module.exports = { PATHS, getCurrentRuntimeDir, getWorldsDir, getServerConfigPath, getBackupsDir, getServersDir };
