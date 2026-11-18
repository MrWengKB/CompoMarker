// 模型服务商预设与本地设置存储。
// API Key 只保存在用户自己的浏览器里（localStorage 或 sessionStorage），不会上传到仓库。

export const PROVIDERS = {
  'qwen-intl': {
    name: '通义千问 · 国际版（Model Studio 新加坡）',
    kind: 'openai',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    visionModel: 'qwen-vl-max',
    textModel: 'qwen-max',
    keyHint: '在 modelstudio.console.alibabacloud.com 创建 API Key（sk- 开头），无需国内手机号',
  },
  qwen: {
    name: '通义千问 · 国内版（阿里云百炼）',
    kind: 'openai',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    visionModel: 'qwen-vl-max',
    textModel: 'qwen-max',
    keyHint: '在阿里云百炼控制台创建 API Key（sk- 开头）',
  },
  zhipu: {
    name: '智谱 GLM',
    kind: 'openai',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    visionModel: 'glm-4v-plus',
    textModel: 'glm-4-plus',
    keyHint: '在智谱开放平台创建 API Key',
  },
  claude: {
    name: 'Claude（Anthropic）',
    kind: 'anthropic',
    baseURL: '',
    visionModel: 'claude-opus-5-5',
    textModel: 'claude-opus-5-5',
    keyHint: '在 console.anthropic.com 创建 API Key（sk-ant- 开头）',
  },
  openai: {
    name: 'OpenAI',
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    visionModel: 'gpt-4o',
    textModel: 'gpt-4o',
    keyHint: '在 platform.openai.com 创建 API Key',
  },
  worker: {
    name: '我的 Cloudflare 中转（Key 存在 Worker 里）',
    kind: 'openai',
    baseURL: '',
    visionModel: 'qwen-vl-max',
    textModel: 'qwen-max',
    keyHint: '这里填 Worker 里设置的访问口令（ACCESS_CODE），不是模型的真实 Key。接口地址填 https://你的worker.workers.dev/qwen-intl',
  },
  custom: {
    name: '自定义（OpenAI 兼容接口 / 自建中转）',
    kind: 'openai',
    baseURL: '',
    visionModel: '',
    textModel: '',
    keyHint: '填写你的中转地址或其他兼容 OpenAI 格式的服务',
  },
};

export const DEFAULT_PROVIDER = 'qwen-intl';

const SETTINGS_KEY = 'compomarker.settings.v1';
const KEY_PREFIX = 'compomarker.key.';

function safeGet(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}
function safeSet(storage, key, value) {
  try { storage.setItem(key, value); } catch { /* 隐私模式等情况下忽略 */ }
}
function safeRemove(storage, key) {
  try { storage.removeItem(key); } catch { /* ignore */ }
}

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(safeGet(localStorage, SETTINGS_KEY) || '{}'); } catch { saved = {}; }
  const provider = PROVIDERS[saved.provider] ? saved.provider : DEFAULT_PROVIDER;
  const overrides = (saved.overrides && saved.overrides[provider]) || {};
  const preset = PROVIDERS[provider];
  return {
    provider,
    rememberKey: saved.rememberKey !== false,
    baseURL: overrides.baseURL ?? preset.baseURL,
    visionModel: overrides.visionModel || preset.visionModel,
    textModel: overrides.textModel || preset.textModel,
    apiKey: loadKey(provider),
    overrides: saved.overrides || {},
  };
}

export function settingsFor(provider, all) {
  const preset = PROVIDERS[provider];
  const o = (all.overrides && all.overrides[provider]) || {};
  return {
    baseURL: o.baseURL ?? preset.baseURL,
    visionModel: o.visionModel || preset.visionModel,
    textModel: o.textModel || preset.textModel,
    apiKey: loadKey(provider),
  };
}

export function saveSettings({ provider, rememberKey, baseURL, visionModel, textModel, apiKey, overrides }) {
  const all = { ...(overrides || {}) };
  all[provider] = { baseURL, visionModel, textModel };
  safeSet(localStorage, SETTINGS_KEY, JSON.stringify({ provider, rememberKey, overrides: all }));
  saveKey(provider, apiKey, rememberKey);
  return loadSettings();
}

function loadKey(provider) {
  return safeGet(localStorage, KEY_PREFIX + provider) || safeGet(sessionStorage, KEY_PREFIX + provider) || '';
}

function saveKey(provider, key, remember) {
  safeRemove(localStorage, KEY_PREFIX + provider);
  safeRemove(sessionStorage, KEY_PREFIX + provider);
  if (!key) return;
  safeSet(remember ? localStorage : sessionStorage, KEY_PREFIX + provider, key);
}

export function clearAllKeys() {
  for (const p of Object.keys(PROVIDERS)) {
    safeRemove(localStorage, KEY_PREFIX + p);
    safeRemove(sessionStorage, KEY_PREFIX + p);
  }
}
