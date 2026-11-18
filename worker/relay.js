// 可选：Cloudflare Worker 中转。
// 用途：某些模型服务商不允许浏览器直接跨域访问时，用它转发请求并补上 CORS 头。
// 部署：Cloudflare 控制台 → Workers → 新建 → 粘贴本文件 → 部署。
// 使用：在网页「设置 → 高级设置 → 接口地址」里填  https://<你的worker>.workers.dev/<服务商>
//   例如通义千问：https://xxx.workers.dev/qwen
// API Key 仍由网页随请求发送，Worker 不保存任何 Key。

const UPSTREAMS = {
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  openai: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com',
};

// 只允许你自己的网页调用，改成你的 GitHub Pages 地址
const ALLOWED_ORIGINS = ['https://mrwengkb.github.io'];

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('Forbidden', { status: 403 });

    const url = new URL(request.url);
    const [, provider, ...rest] = url.pathname.split('/');
    const base = UPSTREAMS[provider];
    if (!base) return new Response('Unknown provider', { status: 404, headers: cors(origin) });

    const headers = new Headers(request.headers);
    headers.delete('Origin');
    headers.delete('Referer');
    const upstream = await fetch(`${base}/${rest.join('/')}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
    });
    const out = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors(origin))) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
