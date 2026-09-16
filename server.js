// server.js
// Allbes House WhatsApp 客服机器人 —— AI 智能回复版本（+ Google Sheets 动态资料）
//
// 工作流程：
//   1. 客户在 WhatsApp 上给您的 Twilio 号码发消息（任何语言都可以）
//   2. Twilio 收到消息后，向本服务器的 /webhook/whatsapp 发一个 POST 请求
//   3. 本服务器把 storeInfo.js 的固定资料 + Google Sheets 里的产品/问答资料
//      + 客户的问题 一起发给 Claude AI
//   4. Claude 用客户提问的语言生成回复
//   5. 用 TwiML 格式把回复返回给 Twilio，Twilio 自动发回给客户
//
// 如果客户发"人工"/"human"/"agent"这类词，会直接转人工提示，不经过 AI（更快、更省钱）。
// 如果调用 AI 失败（比如没配置 API Key、网络问题），会自动降级为默认欢迎语，保证机器人不会"哑巴"。
//
// 【新增】现在店主可以直接在 Google Sheets 里更新产品和常见问答，
// 不需要再改这个项目里的任何代码——具体说明见 sheetData.js 文件开头的注释。

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const { STORE_INFO } = require("./storeInfo");
const { getSheetContext } = require("./sheetData");
const { getOrdersContext } = require("./ordersData");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// 让网站(Netlify 上的静态页面)能跨域调用这个后端的 /api/ 接口
app.use("/api/", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// 【新增】下单付款提醒模板：三个语言分别对应 Twilio Content Editor 里审核通过的 Content SID
const ORDER_REMINDER_CONTENT_SID = {
  zh: "HX3f80c7563f4f1f5643985ba3a31af232",
  en: "HX46263ccb01c783ce7195520a97cebd1a",
  ms: "HX636a86cc3cf07a0dbc30087e80ec9e1d",
};

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const AI_MODEL = "claude-haiku-4-5-20251001"; // 速度快、成本低，适合简单客服问答

const DEFAULT_REPLY =
  "您好！欢迎联系 Allbes House 客服 🙂 我们已收到您的消息，客服会尽快为您处理。";

const TRANSFER_TO_HUMAN_KEYWORDS = [
  "人工", "真人", "转人工",
  "human", "agent", "real person",
  "ejen manusia", "manusia",
];

const HUMAN_BACKUP_NUMBER = "+60138916812";
const TRANSFER_TO_HUMAN_REPLY = {
  zh: `好的，已为您转接人工客服。人工客服可能需要一些时间才能回复，如果比较着急，也可以直接联系这个号码：${HUMAN_BACKUP_NUMBER}`,
  en: `Okay, transferring you to our human support team. It may take a while for a human agent to reply — if it's urgent, you can also reach us directly at ${HUMAN_BACKUP_NUMBER}`,
  ms: `Baik, kami akan hubungkan anda dengan khidmat pelanggan kami. Mungkin mengambil sedikit masa untuk mendapat balasan — jika perlu segera, anda juga boleh hubungi terus di ${HUMAN_BACKUP_NUMBER}`,
};

// ---------- 是否要求校验请求确实来自 Twilio ----------
const VALIDATE_SIGNATURE = process.env.VALIDATE_TWILIO_SIGNATURE === "true";

function validateTwilioRequest(req, res, next) {
  if (!VALIDATE_SIGNATURE) return next();

  const twilioSignature = req.headers["x-twilio-signature"];
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const url = process.env.PUBLIC_WEBHOOK_URL;

  const isValid = twilio.validateRequest(authToken, twilioSignature, url, req.body);

  if (!isValid) {
    console.warn("⚠️ 收到一个签名校验失败的请求，已拒绝。");
    return res.status(403).send("Forbidden");
  }
  next();
}

/**
 * 判断客户是否在要求转人工。
 */
function wantsHuman(message) {
  const text = message.trim().toLowerCase();
  return TRANSFER_TO_HUMAN_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

/**
 * 简单判断客户这条消息用的是中文、英文还是马来文，返回语言代码 zh / en / ms。
 * 不追求完美，只是给 AI 一个明确的提示，减少它"猜错语言"的情况，
 * 也用来决定"转人工"这类固定回复该用哪个语言。
 */
function detectLang(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  const malayHints = /\b(saya|awak|anda|boleh|tak|nak|berapa|harga|terima kasih|sila|apa|kat mana|macam mana)\b/i;
  if (malayHints.test(text)) return "ms";
  return "en";
}
const LANG_LABELS = { zh: "中文", en: "英文 (English)", ms: "马来文 (Bahasa Melayu)" };

/**
 * 调用 Claude AI，根据「storeInfo.js 固定资料 + Google Sheets 动态资料 + 客户本人的订单记录」生成回复。
 * 失败时返回 null，由调用方决定降级方案。
 */
async function getAiReply(userMessage, fromNumber) {
  try {
    const [sheetContext, ordersContext] = await Promise.all([
      getSheetContext(),
      getOrdersContext(fromNumber),
    ]);
    let systemPrompt = STORE_INFO;
    if (sheetContext) systemPrompt += `\n\n${sheetContext}`;
    if (ordersContext) systemPrompt += `\n\n${ordersContext}`;

    const detectedLang = LANG_LABELS[detectLang(userMessage)];
    systemPrompt += `\n\n【重要，务必遵守】客户这条消息使用的语言判断为：${detectedLang}。请只用这个语言回复，不要混用其他语言，也不要用中文回复英文/马来文客户。`;

    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    return textBlock ? textBlock.text.trim() : null;
  } catch (err) {
    console.error("❌ 调用 Claude API 失败：", err.message);
    return null;
  }
}

app.get("/", (req, res) => {
  res.send("✅ Allbes House WhatsApp 机器人正在运行（AI 智能回复版 + Google Sheets）");
});

// 【新增】网站下单后调用这个接口，自动给客人发付款提醒模板消息
// 网站需要 POST 这样的内容：{ name, phone, orderNo, lang }
//   phone 需要是带国家码的号码，例如 "+60123456789"
//   lang  是 "zh" / "en" / "ms" 三选一，决定用哪个语言的模板
app.post("/api/order-notify", async (req, res) => {
  const { name, phone, orderNo, lang } = req.body || {};

  if (!phone || !orderNo) {
    return res.status(400).json({ error: "缺少必要参数：phone 或 orderNo" });
  }

  const contentSid = ORDER_REMINDER_CONTENT_SID[lang] || ORDER_REMINDER_CONTENT_SID.zh;
  const toNumber = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM; // 例如 "whatsapp:+16404009106"

  try {
    const message = await twilioClient.messages.create({
      from: fromNumber,
      to: toNumber,
      contentSid: contentSid,
      contentVariables: JSON.stringify({
        "1": name || "顾客",
        "2": orderNo,
      }),
    });
    console.log(`✅ 已发送付款提醒给 ${toNumber}，订单号：${orderNo}，消息 SID：${message.sid}`);
    res.json({ result: "success", sid: message.sid });
  } catch (err) {
    console.error("❌ 发送订单付款提醒失败：", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/webhook/whatsapp", validateTwilioRequest, async (req, res) => {
  const incomingMessage = req.body.Body || "";
  const fromNumber = req.body.From || "unknown";

  console.log(`📩 收到来自 ${fromNumber} 的消息：${incomingMessage}`);

  let replyText;

  if (wantsHuman(incomingMessage)) {
    const lang = detectLang(incomingMessage);
    replyText = TRANSFER_TO_HUMAN_REPLY[lang];
  } else {
    const aiReply = await getAiReply(incomingMessage, fromNumber);
    replyText = aiReply || DEFAULT_REPLY;
  }

  console.log(`🤖 回复：${replyText}`);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(replyText);

  res.type("text/xml").send(twiml.toString());
});

app.listen(PORT, () => {
  console.log(`🚀 服务器已启动，监听端口 ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠️ 还没有配置 ANTHROPIC_API_KEY，AI 回复会失败并降级为默认欢迎语。");
  }
  if (!process.env.PRODUCTS_SHEET_URL && !process.env.FAQ_SHEET_URL) {
    console.warn("ℹ️ 还没有配置 Google Sheets 链接（PRODUCTS_SHEET_URL / FAQ_SHEET_URL），目前只会用 storeInfo.js 里的固定资料。");
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_WHATSAPP_FROM) {
    console.warn("⚠️ 还没有配置 TWILIO_ACCOUNT_SID / TWILIO_WHATSAPP_FROM，网站下单后的付款提醒消息会发送失败。");
  }
  if (!process.env.ORDERS_SHEET_URL) {
    console.warn("ℹ️ 还没有配置 ORDERS_SHEET_URL，客户问「我下的是什么订单」时 AI 查不到具体订单记录。");
  }
});
