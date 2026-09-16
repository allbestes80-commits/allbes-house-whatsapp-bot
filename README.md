# Allbes House WhatsApp 客服机器人（AI 智能回复版）

客户用**任何语言**（中文/英文/马来文）在 WhatsApp 发消息 → Claude AI 根据店铺资料自动理解并用同一种语言回复。

## 项目结构

```
whatsapp-bot/
├── server.js       # 主服务器，接收 Twilio 的 Webhook 请求，调用 Claude AI 生成回复
├── storeInfo.js    # 店铺知识库（产品、运费、政策、社交媒体链接等），AI 回答问题的依据
├── faqs.js         # 【旧版本】关键词匹配的备份，目前代码没有用到，想切回纯规则版可以参考
├── package.json    # 依赖配置
└── .env.example    # 环境变量示例
```

## ⚠️ 使用前必做：两件事

### 1. 替换 storeInfo.js 里的占位符

打开 `storeInfo.js`，把以下 4 个占位符换成真实链接：
- `[SHOPEE_LINK]`
- `[TIKTOK_LINK]`
- `[FACEBOOK_LINK]`
- `[INSTAGRAM_LINK]`

以后想让 AI 知道更多信息（新品、新活动、新政策），直接在这个文件里加文字段落即可，不需要写任何代码。

### 2. 获取 Claude API Key 并填入 .env

1. 去 https://console.anthropic.com 注册账号（如果还没有）
2. 左侧找 "API Keys"，点 "Create Key"，起个名字，创建后复制生成的密钥（形如 `sk-ant-...`，**只会显示一次**，务必马上复制保存）
3. 复制 `.env.example` 为 `.env`
4. 打开 `.env`，把 `ANTHROPIC_API_KEY=` 后面填上刚才复制的密钥

> 💰 **关于费用**：新账号通常有免费试用额度。用完之后按实际用量计费，这种简单客服问答场景，用的是最便宜的 Haiku 模型，每条消息成本很低（大概几分钱人民币的量级）。具体价格可在 https://www.anthropic.com/pricing 查看最新费率。建议在控制台设置一个消费上限（Usage Limits），避免意外超支。

## 本地运行步骤

```bash
npm install
npm start
```

启动后访问 http://localhost:3000，应该能看到 "✅ Allbes House WhatsApp 机器人正在运行（AI 智能回复版）"。

如果 `.env` 里没填 API Key，服务器仍会正常启动，但 AI 回复会失败并自动降级为默认欢迎语（不会导致机器人无响应），控制台会提示警告，方便排查。

## 让 Twilio 能连到这个服务器（本地测试阶段）

用 ngrok 做临时公网隧道（详细步骤同之前）：

```bash
ngrok http 3000
```

拿到类似 `https://xxxx.ngrok-free.dev` 的地址后，完整 Webhook 地址是：

```
https://xxxx.ngrok-free.dev/webhook/whatsapp
```

## 在 Twilio 里配置 Webhook

1. Twilio 控制台 → Messaging → Senders → WhatsApp senders
2. 点您的号码 → 找到 "Webhook URL for incoming messages"
3. 填入上面的完整地址，方法选 POST，保存

## 特殊功能：转人工

客户发送包含"人工"、"真人"、"human"、"agent" 等关键词的消息时，机器人会**直接返回转人工提示，不经过 AI**（更快、也不产生 API 费用）。想增加更多转人工触发词，编辑 `server.js` 里的 `TRANSFER_TO_HUMAN_KEYWORDS` 数组即可。

## 正式上线部署

同之前版本 —— 部署到 Railway / Render 这类平台，让机器人 24 小时在线，不用一直开着电脑。部署后记得：
- 在平台的环境变量设置里也要填上 `ANTHROPIC_API_KEY`（跟 `.env` 里的一样）
- 把 Twilio 的 Webhook 地址换成正式的域名地址
- 打开 `VALIDATE_TWILIO_SIGNATURE=true`，并填好 `TWILIO_AUTH_TOKEN` 和 `PUBLIC_WEBHOOK_URL`，防止别人伪造请求

## 后续可以继续优化的方向

- **对话记忆**：目前每条消息是独立处理的，AI 不记得客户上一句说了什么。可以按客户号码做一个简单的历史记录，让对话更连贯。
- **人工客服真正接入**：现在"转人工"只是发一句提示，实际还需要某种方式通知真人客服（比如同时给店主的 WhatsApp/Telegram 发一条通知）。
- **记录聊天数据**：把每次问答存到数据库，方便回顾客户常问什么、持续优化 `storeInfo.js` 的内容。
