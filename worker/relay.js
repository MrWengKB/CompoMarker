// Cloudflare Worker 中转，两种用法：
//
// A. 代存 Key（推荐给自己和同事用）
//    在 Worker 的「设置 → 变量和机密」里添加机密（Secret）：
//      ACCESS_CODE     访问口令，自己定一串不容易猜的字符
//      QWEN_INTL_KEY   通义千问国际版 Key（按需添加，下同）
//      QWEN_KEY        通义千问国内版 Key
//      ZHIPU_KEY / OPENAI_KEY / CLAUDE_KEY
//    网页「设置」里选「我的 Cloudflare 中转」，接口地址填  https://<你的worker>.workers.dev/qwen-intl ，
//    API Key 一栏填 ACCESS_CODE。Worker 校验口令后，用自己保存的真实 Key 去请求模型，
//    真实 Key 不会出现在网页和浏览器里。
//
// B. 纯转发
//    网页里填自己的真实 Key，Worker 只负责补上跨域头后原样转发。
//
// 可选变量（普通变量即可）：
//    ALLOWED_ORIGINS  允许调用的网页地址，多个用逗号分隔，默认 https://mrwengkb.github.io

const UPSTREAMS = {
  'qwen-intl': { base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', secret: 'QWEN_INTL_KEY' },
  qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', secret: 'QWEN_KEY' },
  zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', secret: 'ZHIPU_KEY' },
  openai: { base: 'https://api.openai.com/v1', secret: 'OPENAI_KEY' },
  claude: { base: 'https://api.anthropic.com', secret: 'CLAUDE_KEY' },
};

// 只转发模型对话接口，其他路径一律拒绝
const ALLOWED_PATHS = ['chat/completions', 'v1/messages'];

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || 'https://mrwengkb.github.io')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  return {
    'Access-Control-Allow-Origin': list.includes(origin) ? origin : list[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(status, message, cors) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      const origin = request.headers.get('Origin') || '';
      return json(500, `中转内部错误：${e?.message || e}`, corsHeaders(origin, env));
    }
  },
};

async function handle(request, env) {
  {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!allowedOrigins(env).includes(origin)) return json(403, '此中转只允许指定网页调用', cors);
    if (request.method !== 'POST') return json(405, '只支持 POST', cors);

    const url = new URL(request.url);
    const [, provider, ...rest] = url.pathname.split('/');
    const up = UPSTREAMS[provider];
    if (!up) return json(404, `未知服务商：${provider}`, cors);
    const path = rest.join('/');
    if (!ALLOWED_PATHS.some((p) => path.endsWith(p))) return json(404, '不支持的接口路径', cors);

    const headers = new Headers(request.headers);
    ['Origin', 'Referer', 'Cookie', 'Host'].forEach((h) => headers.delete(h));

    // 网页传来的「Key」：OpenAI 兼容接口在 Authorization，Claude 在 x-api-key
    const isClaude = provider === 'claude';
    const sent = isClaude
      ? headers.get('x-api-key') || ''
      : (headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');

    // 用法 A：口令正确就换成 Worker 里保存的真实 Key
    if (env.ACCESS_CODE && safeEqual(sent, env.ACCESS_CODE)) {
      const realKey = env[up.secret];
      if (!realKey) return json(500, `Worker 里还没有设置 ${up.secret}`, cors);
      if (isClaude) headers.set('x-api-key', realKey);
      else headers.set('Authorization', `Bearer ${realKey}`);
    } else if (env.ACCESS_CODE && env[up.secret] && !looksLikeRealKey(sent)) {
      // 配置了代存 Key，但口令不对，也不像真实 Key：直接拒绝，避免把错误口令发给上游
      return json(401, '访问口令不正确', cors);
    }
    // 用法 B：其余情况原样转发（网页填的是自己的真实 Key）

    let upstream;
    try {
      upstream = await fetch(`${up.base}/${path}${url.search}`, {
        method: 'POST',
        headers,
        body: request.body,
      });
    } catch (e) {
      // 出错时也带上跨域头，网页才能看到具体原因
      return json(502, `中转连接模型服务失败：${e?.message || e}`, cors);
    }
    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
}

function looksLikeRealKey(s) {
  return /^sk-/.test(s) || s.length >= 40;
}
