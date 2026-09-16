// ordersData.js
// 根据客户的 WhatsApp 号码，从"订单记录" Google Sheet 里查出他最近下的订单，
// 转成给 AI 看的文字，这样客户问"我下的是什么订单/买了什么"时，AI 能准确回答。
//
// 用的同样是 Google Sheets「发布到网络」生成的 CSV 链接，不需要 Google API 密钥。
//
// 需要在 .env / 部署平台的环境变量里配置：
//   ORDERS_SHEET_URL = "订单记录"分页发布出来的 CSV 链接
//
// "订单记录"分页第一行标题需要是：时间, 订单号, 收货人, 电话, 地址, 商品明细, 金额, 付款方式, 状态, 快递公司, 快递单号

const Papa = require("papaparse");

const ORDERS_CSV_URL = process.env.ORDERS_SHEET_URL || "";

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 分钟缓存，订单数据变化比产品资料快，缓存时间设短一点
let cache = { rows: [], fetchedAt: 0 };

// 常见马来西亚快递公司的官方查询网址，方便直接告诉客户去哪里查
const COURIER_TRACKING_URLS = {
  "j&t express": "https://www.jtexpress.my/index/query/gzquery.html",
  "jt express": "https://www.jtexpress.my/index/query/gzquery.html",
  "j&t": "https://www.jtexpress.my/index/query/gzquery.html",
  "pos laju": "https://www.pos.com.my/postrack/",
  "poslaju": "https://www.pos.com.my/postrack/",
  "ninja van": "https://www.ninjavan.co/en-my/tracking",
  "ninjavan": "https://www.ninjavan.co/en-my/tracking",
  "dhl": "https://www.dhl.com/my-en/home/tracking.html",
  "city-link": "https://www.citylinkexpress.com/tools-track-and-trace/",
  "citylink": "https://www.citylinkexpress.com/tools-track-and-trace/",
  "gdex": "https://www.gdexpress.com/tracking",
};
function getCourierUrl(courierName){
  const key = String(courierName || "").trim().toLowerCase();
  return COURIER_TRACKING_URLS[key] || "";
}

/**
 * 把电话号码统一处理成"末尾 9 位数字"，用来匹配。
 * 这样不管客户填的是 "0183612083"、"60183612083" 还是 "+60183612083"，
 * 只要末尾号码一样就能配对上，不用要求格式完全一致。
 */
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.slice(-9);
}

async function fetchOrders() {
  const now = Date.now();
  if (cache.rows.length && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rows;
  }
  if (!ORDERS_CSV_URL) return [];
  try {
    const res = await fetch(ORDERS_CSV_URL);
    if (!res.ok) throw new Error(`拉取订单表格失败，状态码：${res.status}`);
    const csvText = await res.text();
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
    cache = { rows: parsed.data, fetchedAt: now };
    return parsed.data;
  } catch (err) {
    console.error("⚠️ 读取订单记录失败，本次先用旧缓存：", err.message);
    return cache.rows || [];
  }
}

/**
 * 根据客户的 WhatsApp 号码（Twilio 的 From 字段，形如 "whatsapp:+60183612083"），
 * 找出这个号码名下最近的订单，拼成一段文字加进 AI 的系统提示里。
 * 找不到订单时返回空字符串（不会报错，AI 会用默认方式回答）。
 */
async function getOrdersContext(fromNumber) {
  const targetSuffix = normalizePhone(fromNumber);
  if (!targetSuffix) return "";

  const rows = await fetchOrders();
  const matched = rows.filter((r) => normalizePhone(r["电话"]) === targetSuffix);
  if (!matched.length) return "";

  // 最多列出最近 5 笔订单（表格是按下单时间从上到下追加的，所以取最后几行）
  const recent = matched.slice(-5).reverse();
  const lines = recent.map((r) => {
    const courier = r["快递公司"] || "";
    const trackingNo = r["快递单号"] || "";
    let line = `- 订单号 ${r["订单号"] || ""}｜时间：${r["时间"] || ""}｜商品：${r["商品明细"] || ""}｜金额：${r["金额"] || ""}｜付款方式：${r["付款方式"] || ""}｜状态：${r["状态"] || ""}`;
    if (courier || trackingNo) {
      line += `｜快递公司：${courier || "未填写"}｜快递单号：${trackingNo || "未填写"}`;
      const url = getCourierUrl(courier);
      if (url) line += `｜该快递公司查询网址：${url}`;
    }
    return line;
  });

  return (
    `【这位正在对话的客户（WhatsApp: ${fromNumber}）名下的近期订单】\n${lines.join("\n")}\n\n` +
    `如果客户询问自己下的订单、买了什么、订单状态等问题，请直接根据上面这份记录回答。` +
    `如果订单已经有快递公司和快递单号，客户问物流/包裹到哪里了，请把快递单号和对应的快递公司查询网址一起告诉客户，让他自己上官网输入单号查询（不要说自己能实时查到物流状态，我们这边没有接入实时物流查询接口）。` +
    `如果客户问到的订单号不在上面列表里，如实告知没有查到对应记录，建议客户提供订单号或转人工核实，不要编造。`
  );
}

module.exports = { getOrdersContext };
