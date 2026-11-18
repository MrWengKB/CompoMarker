# 作文批改 CompoMarker

拍照上传学生手写作文 → AI 识别文字 → 人工核对 → 按评分标准批改，标出错别字、病句和好句，给出分项得分、总评和修改建议。

纯静态网页（HTML + JS），可直接用 GitHub Pages 托管，不需要服务器。

## 使用

1. 打开网页，点右上角「设置」，选择模型服务商并填写自己的 API Key。
2. 上传作文照片（多页按顺序选择），点「识别文字」。
3. 核对识别出的原文：改正**识别错误**，但**保留学生自己写错的字**。
4. 选择年级、题目、字数要求和评分标准（中考 / 高考 / 小学 / 百分制，可自行修改维度和分值），点「开始批改」。
5. 在结果里点击原文中的标注查看说明；可复制报告、打印，历史记录保存在本机。

没有照片时，也可以直接粘贴作文文本。

## 模型服务商

| 服务商 | 识别模型（默认） | 批改模型（默认） |
| --- | --- | --- |
| 通义千问 · 国际版（Model Studio，新加坡）**默认** | qwen-vl-max | qwen-max |
| 通义千问 · 国内版（阿里云百炼） | qwen-vl-max | qwen-max |
| 智谱 GLM | glm-4v-plus | glm-4-plus |
| Claude（Anthropic） | claude-opus-5-5 | claude-opus-5-5 |
| OpenAI | gpt-4o | gpt-4o |
| 自定义 | 任意兼容 OpenAI 接口的服务或中转 | |

模型名称和接口地址都可以在「设置 → 高级设置」里修改。

## 关于 API Key 与隐私

- 网页里**没有**写死任何 Key，Key 由使用者自己填写，只保存在本机浏览器（可选择关闭页面即清除）。
- 作文照片和文字由浏览器直接发送给你选择的模型服务商，不经过其他服务器。

## 浏览器直连被拦截怎么办（可选中转）

部分服务商可能不允许网页直接跨域调用。这时可以部署 `worker/relay.js` 到 Cloudflare Workers（免费额度足够），
然后在「设置 → 高级设置 → 接口地址」里填 `https://<你的worker>.workers.dev/qwen`（或 `/zhipu`、`/openai`、`/claude`）。
记得把 `relay.js` 里的 `ALLOWED_ORIGINS` 改成你自己的网页地址。

## 本地运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

（需要通过 http 打开，直接双击 index.html 时 ES 模块无法加载。）

## 文件结构

```
index.html        页面
style.css         样式（支持深色模式、手机、打印）
js/app.js         页面流程与结果展示
js/config.js      服务商预设、设置与 Key 的本地存储
js/providers.js   模型调用（OpenAI 兼容接口 / Claude SDK）
js/prompts.js     识别与批改提示词
js/rubrics.js     评分标准预设
js/analyze.js     本地字数统计、原文标注
worker/relay.js   可选的 Cloudflare Worker 中转
```
