// 统一的模型调用：chat({ settings, model, system, text, images }) -> 文本
// images: [{ mediaType: 'image/jpeg', data: '<base64，不带 data: 前缀>' }]
import { PROVIDERS } from './config.js';

const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.4.0/+esm';

export class ApiError extends Error {}

export async function chat({ settings, model, system, text, images = [], maxTokens = 8000 }) {
  const preset = PROVIDERS[settings.provider];
  if (!settings.apiKey) throw new ApiError('还没有填写 API Key，请先点右上角「设置」。');
  if (!model) throw new ApiError('还没有填写模型名称，请先点右上角「设置」。');
  if (preset.kind === 'anthropic') {
    return chatAnthropic({ settings, model, system, text, images, maxTokens });
  }
  return chatOpenAI({ settings, model, system, text, images, maxTokens });
}

async function chatOpenAI({ settings, model, system, text, images }) {
  const base = (settings.baseURL || '').replace(/\/+$/, '');
  if (!base) throw new ApiError('请在「设置」里填写接口地址（Base URL）。');
  const content = images.length
    ? [
        ...images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
        { type: 'text', text },
      ]
    : text;
  const body = {
    model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  };
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(
      '无法连接到模型接口（网络错误，或该服务不允许浏览器直接访问 / 跨域被拦截）。' +
        '可以换一个服务商，或按 README 部署 Cloudflare Worker 中转后，在「设置」里把接口地址改成中转地址。'
    );
  }
  const raw = await res.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw.slice(0, 300);
    if (/model.*not.*exist|model_not_found|does not exist/i.test(msg)) {
      throw new ApiError(`模型「${model}」不存在或已下线（${msg}）。请在「设置 → 高级设置」里点「恢复该服务商的默认模型和地址」，或换成控制台里能用的模型名。`);
    }
    throw new ApiError(`接口返回错误（HTTP ${res.status}）：${msg}`);
  }
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map((p) => p.text || '').join('');
  throw new ApiError('接口返回内容为空或格式无法识别。');
}

let anthropicModule = null;
async function loadAnthropic() {
  if (!anthropicModule) {
    try {
      anthropicModule = await import(ANTHROPIC_SDK_URL);
    } catch {
      throw new ApiError('加载 Claude SDK 失败，请检查网络能否访问 cdn.jsdelivr.net。');
    }
  }
  return anthropicModule.default;
}

async function chatAnthropic({ settings, model, system, text, images, maxTokens }) {
  const Anthropic = await loadAnthropic();
  const client = new Anthropic({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL || undefined,
    dangerouslyAllowBrowser: true, // Key 由用户自己填写并只存于本机浏览器
  });
  const content = [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
    { type: 'text', text },
  ];
  let msg;
  try {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: Math.max(maxTokens, 16000),
      system,
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content }],
    });
    msg = await stream.finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ApiError('Claude API Key 无效，请在「设置」里检查。');
    if (e instanceof Anthropic.RateLimitError) throw new ApiError('请求太频繁或额度不足，请稍后再试。');
    if (e instanceof Anthropic.APIConnectionError) throw new ApiError('无法连接到 Claude 接口，请检查网络或配置中转地址。');
    if (e instanceof Anthropic.APIError) throw new ApiError(`Claude 接口返回错误（HTTP ${e.status ?? '?'}）：${e.message}`);
    throw e;
  }
  if (msg.stop_reason === 'refusal') throw new ApiError('模型拒绝处理这次请求，请检查图片或文本内容后重试。');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// 从模型输出里尽量稳妥地取出 JSON 对象
export function extractJSON(s) {
  let t = String(s).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last <= first) throw new ApiError('模型没有返回 JSON 格式的批改结果。');
  const body = t.slice(first, last + 1);
  try {
    return JSON.parse(body);
  } catch {
    // 常见问题：结尾多余逗号
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { /* fallthrough */ }
    throw new ApiError('批改结果的 JSON 解析失败，可以点「重新批改」再试一次。');
  }
}
