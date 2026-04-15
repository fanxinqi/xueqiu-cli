'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.xueqiu-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  current: 'default',
  profiles: {
    // default: { cookie, user_id, screen_name, updated_at }
  },
  defaults: {
    // 默认组合代码，用户可通过 `xueqiu config set-cube ZH123456` 设定
    cube_symbol: null,
  },
};

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function read() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      profiles: { ...(parsed.profiles || {}) },
      defaults: { ...DEFAULT_CONFIG.defaults, ...(parsed.defaults || {}) },
    };
  } catch (err) {
    const bak = CONFIG_FILE + '.bak-' + Date.now();
    try { fs.renameSync(CONFIG_FILE, bak); } catch (_) {}
    console.warn(`[config] 配置文件损坏，已备份到 ${bak}，使用默认配置。`);
    return { ...DEFAULT_CONFIG };
  }
}

function write(cfg) {
  ensureDir();
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  // 兜底：确保权限 600，避免 cookie 被同机用户读到
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
}

function getCurrentProfileName(cfg = read()) {
  return cfg.current || 'default';
}

function getProfile(name, cfg = read()) {
  const target = name || getCurrentProfileName(cfg);
  return cfg.profiles[target] || null;
}

function setProfile(name, profile) {
  const cfg = read();
  cfg.profiles[name] = { ...(cfg.profiles[name] || {}), ...profile, updated_at: new Date().toISOString() };
  if (!cfg.current) cfg.current = name;
  write(cfg);
  return cfg.profiles[name];
}

function removeProfile(name) {
  const cfg = read();
  if (!cfg.profiles[name]) return false;
  delete cfg.profiles[name];
  if (cfg.current === name) {
    const left = Object.keys(cfg.profiles);
    cfg.current = left[0] || 'default';
  }
  write(cfg);
  return true;
}

function useProfile(name) {
  const cfg = read();
  if (!cfg.profiles[name]) throw new Error(`profile 不存在: ${name}`);
  cfg.current = name;
  write(cfg);
}

function listProfiles() {
  const cfg = read();
  return Object.entries(cfg.profiles).map(([name, p]) => ({
    name,
    current: cfg.current === name,
    user_id: p.user_id,
    screen_name: p.screen_name,
    updated_at: p.updated_at,
  }));
}

function getDefaults() {
  return read().defaults || {};
}

function setDefault(key, value) {
  const cfg = read();
  cfg.defaults = { ...(cfg.defaults || {}), [key]: value };
  write(cfg);
}

module.exports = {
  CONFIG_DIR,
  CONFIG_FILE,
  read,
  write,
  getCurrentProfileName,
  getProfile,
  setProfile,
  removeProfile,
  useProfile,
  listProfiles,
  getDefaults,
  setDefault,
};
