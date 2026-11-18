# 作文批改 CompoMarker

拍照上传学生手写作文 → AI 识别文字 → 人工核对 → 按评分标准批改，标出错别字、病句和好句，给出分项得分、总评和修改建议。

纯静态网页（HTML + JS），可直接用 GitHub Pages 托管，不需要服务器。

## 使用

1. 打开网页，点右上角「设置」，选择模型服务商并填写自己的 API Key。
2. 上传作文照片或 PDF（多页按顺序选择；PDF 每页自动转成图片，最多 10 页），点「识别文字」。
3. 核对识别出的原文：改正**识别错误**，但**保留学生自己写错的字**。
4. 选择年级、题目、字数要求和评分标准（三四年级 15 分、五六年级 40 分，按年级自动切换；维度、分值和评分细则都可修改），点「开始批改」。
5. 在结果里点击原文中的标注查看说明；可复制报告、打印，历史记录保存在本机。

没有照片时，也可以直接粘贴作文文本。

## 模型服务商

| 服务商 | 识别模型（默认） | 批改模型（默认） |
| --- | --- | --- |
| 通义千问 · 国际版（Model Studio，新加坡）**默认** | qwen3.7-plus | qwen3.7-plus |
| 通义千问 · 国内版（阿里云百炼） | qwen3.7-plus | qwen3.7-plus |
| 智谱 GLM | glm-4v-plus | glm-4-plus |
| Claude（Anthropic） | claude-opus-5-5 | claude-opus-5-5 |
| OpenAI | gpt-4o | gpt-4o |
| 自定义 | 任意兼容 OpenAI 接口的服务或中转 | |

模型名称和接口地址都可以在「设置 → 高级设置」里修改。

## 关于 API Key 与隐私

- 网页里**没有**写死任何 Key，Key 由使用者自己填写，只保存在本机浏览器（可选择关闭页面即清除）。
- 作文照片和文字由浏览器直接发送给你选择的模型服务商，不经过其他服务器。

## 用 Cloudflare Worker 保存 Key（可选）

不想在每台电脑的浏览器里填真实 Key，或者想给同事用但不想把 Key 给他们，可以把 Key 存在 Cloudflare Worker 里，网页里只填一个访问口令。顺便也解决了部分服务商不允许浏览器直连的问题。

1. 登录 Cloudflare 控制台 → Workers & Pages → 创建 → 选「Hello World」模板，起个名字（如 `compomarker`）→ 部署。
2. 点「编辑代码」，把 `worker/relay.js` 的内容整个粘贴进去 → 部署。
3. 进入这个 Worker 的「设置 → 变量和机密」，添加两个**机密（Secret）**：
   - `ACCESS_CODE`：自己定的访问口令，越长越难猜越好
   - `QWEN_INTL_KEY`：通义千问国际版的真实 Key（用其他服务商就加对应的 `QWEN_KEY`、`ZHIPU_KEY`、`OPENAI_KEY`、`CLAUDE_KEY`）
4. 如果网页不是放在 `https://mrwengkb.github.io`，再加一个普通变量 `ALLOWED_ORIGINS` 填你的网页地址。
5. 打开作文批改网页 →「设置」→ 选「我的 Cloudflare 中转」：
   - 接口地址：`https://compomarker.<你的账号>.workers.dev/qwen-intl`
   - API Key：填第 3 步的访问口令

说明：
- 真实 Key 只存在 Cloudflare，不会出现在网页代码和浏览器里。
- Worker 只接受来自你网页的请求，并且只转发模型对话接口。但口令一旦泄露，别人就能用你的额度，所以口令不要公开，发现异常就在 Cloudflare 里换一个。
- 不设置 `ACCESS_CODE` 时，Worker 就是一个纯转发中转，网页里照常填自己的真实 Key。

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
js/vendor/pdfjs/  PDF.js（读取 PDF，Apache-2.0）
worker/relay.js   可选的 Cloudflare Worker 中转
```
