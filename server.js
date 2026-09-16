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
const { getSheetContext, getProducts } = require("./sheetData");
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

// 【新增】WhatsApp 内直接下单：写入的表格跟网站共用同一张「订单记录」表，
// 这个 Apps Script 网址跟网站 index.html 里 ORDER_LOG_URL 是同一个，不是密钥（网站前端代码本来就公开可见）。
const ORDER_LOG_URL =
  process.env.ORDER_LOG_URL ||
  "https://script.google.com/macros/s/AKfycbxDN366zqU5CevVUpFRvrFNQtw-cxAhADcxnX1HOGInwq7Ca3PJ6ie1JxOLkfzmLPaX/exec";

// 【新增】"客户跟进"表的 Apps Script 网址，跟订单表是分开的一份独立脚本/分页，
// 用来记录每个客户最后互动时间、是否同意接收推广消息，给下面的自动追单用。
const FOLLOWUP_LOG_URL =
  process.env.FOLLOWUP_LOG_URL ||
  "https://script.google.com/macros/s/AKfycbxpW5nz3nH8TM1fUH5FXKE2U554aTw6WwuN8RSQjPlPgfyY99Y2GkMjFCpyql8CylBFyA/exec";

// 追单用的已审核 WhatsApp 模板（送审通过后才能用，审核中不影响机器人其他功能）
const FOLLOWUP_TEMPLATE_CONTENT_SID = {
  zh: "HX31c732d09ef4384084b259f68296d8c5",
  en: "HX7b4b1c0f8311c9aac246f7fd4368e357",
  ms: "HX8dd203f33e8add317d7b96a836dd47cc",
};
const FOLLOWUP_GENERIC_PRODUCT = { zh: "我们的产品", en: "our products", ms: "produk kami" };
const FOLLOWUP_SILENCE_MS = 24 * 60 * 60 * 1000; // 客户超过 24 小时没再互动才追
const FOLLOWUP_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小时扫一次该追谁

// 满额赠品门槛（RM），跟 storeInfo.js 里跟客户说的规则要保持一致
const GIFT_TIERS = [
  { minTotal: 150, zh: "沐浴露一瓶（赠品，随机口味）", en: "1 free shower gel (random scent)", ms: "1 gel mandi percuma (rasa rawak)" },
  { minTotal: 80, zh: "护手霜一支（赠品，随机口味）", en: "1 free hand cream (random scent)", ms: "1 krim tangan percuma (rasa rawak)" },
];

const PAYMENT_INSTRUCTIONS = {
  zh: {
    bank: "请转账至：\nAllbes Trading\n银行：Public Bank\n账号：3816700111\n转账完成后，请把付款截图发到这里确认，谢谢！",
    tng: "请使用 Touch 'n Go eWallet 扫描收款码完成付款：\n📱 [二维码占位，正式上线需替换为真实收款码]\n付款完成后，请把付款截图发到这里确认，谢谢！",
  },
  en: {
    bank: "Please transfer to:\nAllbes Trading\nBank: Public Bank\nAccount: 3816700111\nAfter transferring, please send a screenshot here for confirmation. Thank you!",
    tng: "Scan the QR code with your Touch 'n Go eWallet to pay:\n📱 [QR placeholder — replace with your real code at launch]\nAfter paying, please send a screenshot here for confirmation. Thank you!",
  },
  ms: {
    bank: "Sila pindahkan ke:\nAllbes Trading\nBank: Public Bank\nAkaun: 3816700111\nSelepas pindahan, sila hantar tangkapan skrin di sini untuk pengesahan. Terima kasih!",
    tng: "Imbas kod QR dengan Touch 'n Go eWallet untuk membayar:\n📱 [Kod QR sementara — gantikan dengan kod sebenar semasa pelancaran]\nSelepas membayar, sila hantar tangkapan skrin di sini untuk pengesahan. Terima kasih!",
  },
};

// 【新增】给 Claude 用的下单工具：客户明确确认要买什么的时候，AI 调用这个工具，
// 之后的收货信息收集就交给下面的确定性对话流程处理，不再靠 AI 自由发挥。
const ORDER_TOOL = {
  name: "start_order",
  description:
    "当客户已经明确表示要购买某个/某些商品时调用（不要在客户只是询价、还没确认要买时调用）。" +
    "把你理解到的商品名称和数量传进来，不需要完全跟表格里的名字一模一样，系统会自动匹配。",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "客户想买的商品名称" },
            qty: { type: "integer", description: "数量，客户没说清楚就填 1" },
          },
          required: ["name", "qty"],
        },
      },
    },
    required: ["items"],
  },
};

// 【新增】WhatsApp 内下单的对话状态，按客户手机号（Twilio 的 From 字段）存内存里。
// 重启服务会清空所有进行中的下单流程——量不大，先用内存做，先跑起来比较重要。
const orderSessions = {};

// 【新增】每个客户最近几轮对话记录（按手机号存内存里），让 AI 记得上一句聊了什么——
// 比如客户先发一张产品截图，隔一句才问"这是新款吗"，AI 也能接得上。
// 只留最近几轮，避免无限增长；重启服务会清空，不影响正常使用。
const conversationHistory = {};
const MAX_HISTORY_TURNS = 6; // 保留最近 6 条（客户+AI 加起来），约 3 轮对话

function pushHistory(fromNumber, role, text) {
  if (!conversationHistory[fromNumber]) conversationHistory[fromNumber] = [];
  const history = conversationHistory[fromNumber];
  history.push({ role, content: text });
  while (history.length > MAX_HISTORY_TURNS) history.shift();
}

/**
 * 下载客户在 WhatsApp 发来的图片，转成 Claude 能看懂的 base64 格式。
 * Twilio 的媒体链接需要账号认证才能下载，失败时返回 null，调用方会降级为纯文字处理。
 */
async function fetchImageAsBase64(url) {
  try {
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch (err) {
    console.error("⚠️ 下载客户发来的图片失败：", err.message);
    return null;
  }
}

const AFFIRMATIVE_WORDS = ["是", "要", "可以", "好", "确认", "对", "行", "ok", "okay", "yes", "sure", "confirm", "ya", "boleh", "baik", "sahkan"];
const NEGATIVE_WORDS = ["不要", "不用", "算了", "取消", "先不", "no", "cancel", "nevermind", "tidak", "batal"];

function textIncludesAny(text, words) {
  const t = String(text || "").trim().toLowerCase();
  return words.some((w) => t.includes(w));
}

function normalizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]/g, "");
}

/**
 * 拿客户说的商品名（可能不精确）去匹配表格里的真实商品。
 * 先试完全包含匹配，匹配不到就按词重叠打分，取分数最高的几个作为候选。
 * 返回 { match, candidates }：match 有值说明匹配到了；没有的话 candidates 是最多 3 个建议供客户挑选。
 */
function matchProduct(query, products) {
  const nq = normalizeForMatch(query);
  if (!nq) return { match: null, candidates: [] };

  const exact = products.find((p) => normalizeForMatch(p.name) === nq);
  if (exact) return { match: exact, candidates: [] };

  const contains = products.filter((p) => {
    const np = normalizeForMatch(p.name);
    return np.includes(nq) || nq.includes(np);
  });
  if (contains.length === 1) return { match: contains[0], candidates: [] };
  if (contains.length > 1) {
    // 多个都沾边，按名字长度接近程度排序，取最接近的当匹配
    contains.sort((a, b) => Math.abs(a.name.length - nq.length) - Math.abs(b.name.length - nq.length));
    return { match: contains[0], candidates: [] };
  }

  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = products
    .map((p) => {
      const pWords = p.name.toLowerCase().split(/\s+/);
      const score = queryWords.filter((w) => pWords.some((pw) => pw.includes(w) || w.includes(pw))).length;
      return { p, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return { match: null, candidates: scored.slice(0, 3).map((s) => s.p) };
}

function genOrderNo() {
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  return "AH" + ymd + Math.floor(Math.random() * 90 + 10);
}

function computeGift(subtotal, lang) {
  const tier = GIFT_TIERS.find((t) => subtotal >= t.minTotal);
  return tier ? tier[lang] || tier.zh : null;
}

function normalizePhoneInput(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("0")) return "+6" + digits;
  return digits ? "+" + digits : "";
}

function summarizeItems(items) {
  return items.map((i) => `${i.name} x${i.qty}`).join(", ");
}

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
 * 客户明确确认要下单时，AI 会调用 start_order 工具，这时返回 { type: "start_order", items }
 * 而不是普通文字，由调用方接管后续的下单流程。
 */
async function getAiReply(userMessage, fromNumber, media) {
  try {
    const [sheetContext, ordersContext] = await Promise.all([
      getSheetContext(),
      getOrdersContext(fromNumber),
    ]);
    let systemPrompt = STORE_INFO;
    if (sheetContext) systemPrompt += `\n\n${sheetContext}`;
    if (ordersContext) systemPrompt += `\n\n${ordersContext}`;
    systemPrompt +=
      "\n\n【关于图片】如果客户发的消息里带了图片，你能直接看到图片内容，可以结合上面的产品清单判断客户问的是哪一款、回答关于这张图片的问题（比如新旧款、价格、是否有货），不需要再反问客户是哪一款产品。";

    const detectedLang = LANG_LABELS[detectLang(userMessage)];
    systemPrompt += `\n\n【重要，务必遵守】客户这条消息使用的语言判断为：${detectedLang}。请只用这个语言回复，不要混用其他语言，也不要用中文回复英文/马来文客户。`;

    const userContent = [];
    let historyText = userMessage;
    if (media && media.contentType && media.contentType.startsWith("image/")) {
      const imageBase64 = await fetchImageAsBase64(media.url);
      if (imageBase64) {
        userContent.push({ type: "image", source: { type: "base64", media_type: media.contentType, data: imageBase64 } });
        historyText = `[客户发了一张图片] ${userMessage}`.trim();
      }
    }
    userContent.push({ type: "text", text: userMessage || "（客户发了一张图片，没有配文字说明）" });

    const history = conversationHistory[fromNumber] || [];
    const messages = [...history.map((h) => ({ role: h.role, content: h.content })), { role: "user", content: userContent }];

    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages,
      tools: [ORDER_TOOL],
    });

    const toolBlock = response.content.find((block) => block.type === "tool_use" && block.name === "start_order");
    if (toolBlock) {
      pushHistory(fromNumber, "user", historyText);
      pushHistory(fromNumber, "assistant", "（帮客户下单中）");
      return { type: "start_order", items: toolBlock.input.items || [] };
    }

    const textBlock = response.content.find((block) => block.type === "text");
    const replyText = textBlock ? textBlock.text.trim() : null;
    if (replyText) {
      pushHistory(fromNumber, "user", historyText);
      pushHistory(fromNumber, "assistant", replyText);
    }
    return replyText ? { type: "text", text: replyText } : null;
  } catch (err) {
    console.error("❌ 调用 Claude API 失败：", err.message);
    return null;
  }
}

/**
 * 客户确认要买某些商品后（AI 调用了 start_order 工具），
 * 把 AI 理解到的商品名去匹配表格里的真实商品、算金额，然后决定下一步该问客户什么。
 */
async function beginOrderFlow(fromNumber, itemGuesses, lang) {
  const products = await getProducts();
  const matched = [];
  for (const guess of itemGuesses) {
    const { match, candidates } = matchProduct(guess.name, products);
    if (match) {
      matched.push({ name: match.name, price: Number(match.price) || 0, qty: Math.max(1, guess.qty || 1) });
    } else {
      orderSessions[fromNumber] = {
        step: "clarify_item",
        lang,
        items: matched,
        pendingGuess: guess.name,
        candidates,
      };
      if (candidates.length) {
        const list = candidates.map((c, i) => `${i + 1}. ${c.name}`).join("\n");
        return CLARIFY_ITEM_TEXT[lang].withCandidates(guess.name, list);
      }
      return CLARIFY_ITEM_TEXT[lang].noCandidates(guess.name);
    }
  }

  return proceedToConfirm(fromNumber, matched, lang);
}

function proceedToConfirm(fromNumber, items, lang) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const gift = computeGift(subtotal, lang);
  orderSessions[fromNumber] = { step: "confirm", lang, items, subtotal };

  const itemsLine = summarizeItems(items);
  return CONFIRM_ORDER_TEXT[lang](itemsLine, subtotal, gift);
}

const CLARIFY_ITEM_TEXT = {
  zh: {
    withCandidates: (name, list) => `不好意思，没有在商品清单里找到"${name}"，您是想要下面哪一个呢？\n${list}\n直接回复对应的数字或者商品名就可以了。`,
    noCandidates: (name) => `不好意思，没有在商品清单里找到"${name}"，方便告诉我准确一点的商品名称吗？`,
  },
  en: {
    withCandidates: (name, list) => `Sorry, I couldn't find "${name}" in our product list. Did you mean one of these?\n${list}\nJust reply with the number or the product name.`,
    noCandidates: (name) => `Sorry, I couldn't find "${name}" in our product list. Could you tell me the exact product name?`,
  },
  ms: {
    withCandidates: (name, list) => `Maaf, "${name}" tidak dijumpai dalam senarai produk kami. Adakah anda maksudkan salah satu ini?\n${list}\nBalas dengan nombor atau nama produk sahaja.`,
    noCandidates: (name) => `Maaf, "${name}" tidak dijumpai dalam senarai produk kami. Boleh beritahu nama produk yang tepat?`,
  },
};

const CONFIRM_ORDER_TEXT = {
  zh: (itemsLine, subtotal, gift) =>
    `好的，帮您核对一下订单：\n${itemsLine}\n小计：RM ${subtotal}` +
    (gift ? `\n🎁 满额赠品：${gift}` : "") +
    `\n\n确认要下单吗？回复"确认"我就开始帮您安排，回复"取消"就先不下单。`,
  en: (itemsLine, subtotal, gift) =>
    `Here's your order:\n${itemsLine}\nSubtotal: RM ${subtotal}` +
    (gift ? `\n🎁 Free gift: ${gift}` : "") +
    `\n\nShall I go ahead? Reply "confirm" to proceed, or "cancel" to stop here.`,
  ms: (itemsLine, subtotal, gift) =>
    `Ini pesanan anda:\n${itemsLine}\nJumlah kecil: RM ${subtotal}` +
    (gift ? `\n🎁 Hadiah percuma: ${gift}` : "") +
    `\n\nTeruskan? Balas "sahkan" untuk teruskan, atau "batal" untuk berhenti.`,
};

const ASK_FIELD_TEXT = {
  zh: { name: "麻烦告诉我收货人姓名：", phoneConfirm: (n) => `用这个号码 ${n} 联系您可以吗？可以的话回复"可以"，不行的话直接发我另一个号码。`, address: "收货地址（门牌号、街道名）是？", city: "城市是？", postcode: "邮政编码是？", state: "州属是？", payment: "付款方式选哪个？回复 1 = 银行转账，2 = Touch 'n Go", invalidPostcode: "邮编看起来不太对，麻烦重新发一下（一般是 5 位数字）：", invalidPayment: "麻烦回复 1（银行转账）或 2（Touch 'n Go）哦。", optIn: "最后一个小问题：以后想收到我们的优惠消息和新品通知吗？回复「要」或「不要」" },
  en: { name: "What name should the order be under?", phoneConfirm: (n) => `Should I use ${n} to contact you? Reply "yes" if that's fine, or send me another number.`, address: "What's the delivery address (unit/house no., street)?", city: "Which city?", postcode: "Postcode?", state: "Which state?", payment: "Choose a payment method: reply 1 = Bank Transfer, 2 = Touch 'n Go", invalidPostcode: "That postcode doesn't look right, please resend it (usually 5 digits):", invalidPayment: "Please reply 1 (Bank Transfer) or 2 (Touch 'n Go).", optIn: "One last thing: would you like to receive future promotions and new arrivals from us? Reply \"yes\" or \"no\"" },
  ms: { name: "Atas nama siapa pesanan ini?", phoneConfirm: (n) => `Boleh saya gunakan ${n} untuk hubungi anda? Balas "boleh" jika ya, atau hantar nombor lain.`, address: "Alamat penghantaran (no. rumah, nama jalan)?", city: "Bandar?", postcode: "Poskod?", state: "Negeri?", payment: "Pilih kaedah pembayaran: balas 1 = Pindahan Bank, 2 = Touch 'n Go", invalidPostcode: "Poskod nampak tidak betul, sila hantar semula (biasanya 5 digit):", invalidPayment: "Sila balas 1 (Pindahan Bank) atau 2 (Touch 'n Go).", optIn: "Satu soalan terakhir: adakah anda mahu menerima promosi dan produk baharu daripada kami pada masa hadapan? Balas \"ya\" atau \"tidak\"" },
};

const ORDER_CANCELLED_TEXT = {
  zh: "好的，先不下单了，有需要随时找我～",
  en: "No problem, order cancelled. Let me know if you change your mind!",
  ms: "Baiklah, pesanan dibatalkan. Beritahu saya jika anda berubah fikiran!",
};

const ORDER_DONE_TEXT = {
  zh: (orderNo, payMethod) => `订单已经安排好啦！订单号：${orderNo}\n\n${PAYMENT_INSTRUCTIONS.zh[payMethod]}`,
  en: (orderNo, payMethod) => `Your order is all set! Order No: ${orderNo}\n\n${PAYMENT_INSTRUCTIONS.en[payMethod]}`,
  ms: (orderNo, payMethod) => `Pesanan anda sudah sedia! No. Pesanan: ${orderNo}\n\n${PAYMENT_INSTRUCTIONS.ms[payMethod]}`,
};

/**
 * 客户已经在下单流程中间时（orderSessions 里有这个客户的记录），
 * 处理客户这一步的回复，推进到下一步，或者最后完成下单。
 */
async function handleOrderStep(fromNumber, message) {
  const session = orderSessions[fromNumber];
  const lang = session.lang;

  if (textIncludesAny(message, NEGATIVE_WORDS)) {
    delete orderSessions[fromNumber];
    return ORDER_CANCELLED_TEXT[lang];
  }

  switch (session.step) {
    case "clarify_item": {
      const products = await getProducts();
      const asNumber = parseInt(message.trim(), 10);
      const picked = !isNaN(asNumber) && session.candidates && session.candidates[asNumber - 1]
        ? session.candidates[asNumber - 1]
        : matchProduct(message, products).match;
      if (!picked) {
        return CLARIFY_ITEM_TEXT[lang].noCandidates(session.pendingGuess);
      }
      const items = [...session.items, { name: picked.name, price: Number(picked.price) || 0, qty: 1 }];
      return proceedToConfirm(fromNumber, items, lang);
    }

    case "confirm": {
      if (!textIncludesAny(message, AFFIRMATIVE_WORDS)) {
        return CONFIRM_ORDER_TEXT[lang](summarizeItems(session.items), session.subtotal, computeGift(session.subtotal, lang));
      }
      session.step = "name";
      return ASK_FIELD_TEXT[lang].name;
    }

    case "name": {
      session.name = message.trim();
      session.step = "phone_confirm";
      const displayPhone = fromNumber.replace("whatsapp:", "");
      return ASK_FIELD_TEXT[lang].phoneConfirm(displayPhone);
    }

    case "phone_confirm": {
      if (textIncludesAny(message, AFFIRMATIVE_WORDS)) {
        session.phone = fromNumber.replace("whatsapp:", "");
      } else {
        session.phone = normalizePhoneInput(message);
      }
      session.step = "address";
      return ASK_FIELD_TEXT[lang].address;
    }

    case "address": {
      session.address = message.trim();
      session.step = "city";
      return ASK_FIELD_TEXT[lang].city;
    }

    case "city": {
      session.city = message.trim();
      session.step = "postcode";
      return ASK_FIELD_TEXT[lang].postcode;
    }

    case "postcode": {
      const digits = message.trim().replace(/\D/g, "");
      if (digits.length < 4 || digits.length > 6) {
        return ASK_FIELD_TEXT[lang].invalidPostcode;
      }
      session.postcode = digits;
      session.step = "state";
      return ASK_FIELD_TEXT[lang].state;
    }

    case "state": {
      session.state = message.trim();
      session.step = "payment";
      return ASK_FIELD_TEXT[lang].payment;
    }

    case "payment": {
      const t = message.trim().toLowerCase();
      let payMethod = null;
      if (t.includes("1") || t.includes("bank") || t.includes("银行") || t.includes("pindahan")) payMethod = "bank";
      else if (t.includes("2") || t.includes("tng") || t.includes("touch")) payMethod = "tng";
      if (!payMethod) return ASK_FIELD_TEXT[lang].invalidPayment;
      session.payMethod = payMethod;
      session.step = "optin";
      return ASK_FIELD_TEXT[lang].optIn;
    }

    case "optin": {
      session.optIn = textIncludesAny(message, AFFIRMATIVE_WORDS);
      return finalizeOrder(fromNumber, session.payMethod);
    }

    default:
      delete orderSessions[fromNumber];
      return null;
  }
}

/**
 * 收货信息都收集齐了，生成订单号、写进 Google Sheets「订单记录」表
 * （跟网站下单用的是同一个 Apps Script 接口，所以两边订单会出现在同一张表里），
 * 然后把付款方式发给客户。
 */
async function finalizeOrder(fromNumber, payMethod) {
  const session = orderSessions[fromNumber];
  const lang = session.lang;
  const gift = computeGift(session.subtotal, lang);
  const itemsText = summarizeItems(session.items) + (gift ? `, ${gift}` : "");
  const orderNo = genOrderNo();
  const address = `${session.address}, ${session.postcode} ${session.city}, ${session.state}`;
  const payMethodLabel = payMethod === "bank" ? "银行转账" : "Touch 'n Go";

  try {
    await fetch(ORDER_LOG_URL, {
      method: "POST",
      body: JSON.stringify({
        orderNo,
        name: session.name,
        phone: session.phone,
        address,
        items: itemsText,
        total: "RM " + session.subtotal,
        payMethod: payMethodLabel,
      }),
    });
  } catch (err) {
    console.error("⚠️ WhatsApp 下单写入 Google Sheets 失败：", err.message);
  }

  delete orderSessions[fromNumber];
  touchFollowUp(session.phone, session.name, "已下单", lang, session.optIn);
  return ORDER_DONE_TEXT[lang](orderNo, payMethod);
}

/**
 * 记录/更新客户在「客户跟进」表里的状态（最后互动时间、聊到哪一步、是否同意推广），
 * 给以后的自动追单用。失败不影响机器人正常回复，静默失败即可。
 */
async function touchFollowUp(phone, name, stage, lang, optIn) {
  if (!FOLLOWUP_LOG_URL || !phone) return;
  try {
    const payload = { phone, stage, lang };
    if (name) payload.name = name;
    if (typeof optIn === "boolean") payload.optIn = optIn;
    await fetch(FOLLOWUP_LOG_URL, { method: "POST", body: JSON.stringify(payload) });
  } catch (err) {
    console.error("⚠️ 记录客户跟进状态失败：", err.message);
  }
}

/**
 * 每小时跑一次：找出「已同意接收推广、超过 24 小时没再互动、还没下单、还没追过」的客户，
 * 发送已审核的追单模板消息。模板还在审核中时 FOLLOWUP_TEMPLATE_CONTENT_SID 对应语言会是空，
 * 这种情况直接跳过，不会报错。
 */
async function checkAndSendFollowUps() {
  if (!FOLLOWUP_LOG_URL) return;
  try {
    const res = await fetch(FOLLOWUP_LOG_URL);
    const rows = await res.json();
    const now = Date.now();

    for (const row of rows) {
      if (row["已同意推广"] !== "是") continue;
      if (row["已追单"] === "是") continue;
      if (row["阶段"] === "已下单") continue;

      const lastTime = new Date(row["最后互动时间"]).getTime();
      if (isNaN(lastTime) || now - lastTime < FOLLOWUP_SILENCE_MS) continue;

      const phone = row["手机号"];
      const lang = FOLLOWUP_TEMPLATE_CONTENT_SID[row["语言"]] ? row["语言"] : "en";
      const contentSid = FOLLOWUP_TEMPLATE_CONTENT_SID[lang];
      if (!contentSid) continue; // 该语言的模板还没审核通过

      const toNumber = phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM,
          to: toNumber,
          contentSid,
          contentVariables: JSON.stringify({
            "1": row["姓名"] || (lang === "zh" ? "您好" : "there"),
            "2": FOLLOWUP_GENERIC_PRODUCT[lang],
          }),
        });
        await fetch(FOLLOWUP_LOG_URL, { method: "POST", body: JSON.stringify({ phone, action: "markFollowedUp" }) });
        console.log(`✅ 已发送追单消息给 ${toNumber}`);
      } catch (err) {
        console.error(`❌ 发送追单消息失败（${phone}）：`, err.message);
      }
    }
  } catch (err) {
    console.error("⚠️ 检查追单名单失败：", err.message);
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
  const numMedia = parseInt(req.body.NumMedia || "0", 10);
  const media = numMedia > 0 ? { url: req.body.MediaUrl0, contentType: req.body.MediaContentType0 } : null;

  console.log(`📩 收到来自 ${fromNumber} 的消息：${incomingMessage}${media ? `（带${numMedia}个附件，类型：${media.contentType}）` : ""}`);

  touchFollowUp(fromNumber.replace("whatsapp:", ""), null, "咨询中", detectLang(incomingMessage));

  let replyText;

  if (wantsHuman(incomingMessage)) {
    const lang = detectLang(incomingMessage);
    delete orderSessions[fromNumber]; // 转人工时把进行中的下单流程清掉，交给真人处理
    replyText = TRANSFER_TO_HUMAN_REPLY[lang];
  } else if (orderSessions[fromNumber]) {
    replyText = (await handleOrderStep(fromNumber, incomingMessage)) || DEFAULT_REPLY;
  } else {
    const aiReply = await getAiReply(incomingMessage, fromNumber, media);
    if (aiReply && aiReply.type === "start_order") {
      replyText = await beginOrderFlow(fromNumber, aiReply.items, detectLang(incomingMessage));
    } else {
      replyText = (aiReply && aiReply.text) || DEFAULT_REPLY;
    }
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
  setInterval(checkAndSendFollowUps, FOLLOWUP_CHECK_INTERVAL_MS);
});
