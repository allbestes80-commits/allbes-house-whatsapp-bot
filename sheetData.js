// sheetData.js
// 从 Google Sheets 读取"产品"和"问答"资料，转换成给 AI 看的文字。
//
// 用的是 Google Sheets「发布到网络」生成的 CSV 链接，不需要申请任何 Google API 密钥，
// 也不需要改这个文件里的任何代码——以后店主直接在 Google Sheets 里改内容，
// 机器人下次回复时会自动读到最新版本（最多有 5 分钟的缓存延迟）。
//
// 需要在 .env / 部署平台的环境变量里配置：
//   PRODUCTS_SHEET_URL = 「产品」分页发布出来的 CSV 链接
//   FAQ_SHEET_URL      = 「问答」分页发布出来的 CSV 链接
//
// 【栏位名字】中文、英文都可以，代码会自动尝试匹配以下几种写法：
//   产品名称：商品名 / Product Name / Name
//   规格：    规格 / Size
//   价格：    价格 / Price
//   系列：    系列 / Series
//   分类：    分类 / Category
//   卖点描述：卖点描述 / 卖点 / Description
//   库存：    库存 / Stock
//   问题：    问题 / Question
//   答案：    答案 / Answer
// 少了哪一栏就跳过哪一栏，不会报错，但价格/描述这些栏位建议尽量填，
// 不然客人问到对应问题时 AI 也答不出来。

const Papa = require("papaparse");

const PRODUCTS_CSV_URL = process.env.PRODUCTS_SHEET_URL || "";
const FAQ_CSV_URL = process.env.FAQ_SHEET_URL || "";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟缓存，避免每条消息都重新拉取表格
let cache = { text: "", fetchedAt: 0 };
let productsCache = { rows: [], fetchedAt: 0 };

async function fetchCsv(url) {
  if (!url) return [];
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`拉取表格失败，状态码：${res.status}（链接是否已正确发布为 CSV？）`);
  }
  const csvText = await res.text();
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  return parsed.data;
}

/**
 * 从一行数据里，按多个可能的栏位名字尝试取值，取到第一个有内容的就返回。
 */
function getField(row, keys) {
  for (const key of keys) {
    const val = row[key];
    if (val && String(val).trim()) return String(val).trim();
  }
  return "";
}

function toProductRecord(r) {
  return {
    name: getField(r, ["商品名", "Product Name", "Name"]),
    size: getField(r, ["规格", "Size"]),
    price: getField(r, ["价格 / Price", "价格", "Price"]),
    series: getField(r, ["系列", "Series"]),
    category: getField(r, ["分类", "Category"]),
    desc: getField(r, ["卖点描述 / 卖点 / Description", "卖点描述", "卖点", "Description"]),
    stock: getField(r, ["库存 / Stock", "库存", "Stock"]),
  };
}

function formatProducts(rows) {
  const withName = rows.map(toProductRecord).filter((p) => p.name);

  if (!withName.length) return "";

  const lines = withName.map((p) => {
    let line = `- ${p.name}`;
    if (p.size) line += `｜规格：${p.size}`;
    if (p.price) line += `｜价格：RM${p.price}`;
    if (p.series) line += `｜系列：${p.series}`;
    if (p.category) line += `｜分类：${p.category}`;
    if (p.desc) line += `｜${p.desc}`;
    if (p.stock) line += `｜库存：${p.stock}`;
    return line;
  });

  return `【产品清单（来自 Google Sheets，实时更新）】\n${lines.join("\n")}`;
}

function formatFaq(rows) {
  const withQuestion = rows
    .map((r) => ({
      q: getField(r, ["问题", "Question"]),
      a: getField(r, ["答案", "Answer"]),
    }))
    .filter((f) => f.q);

  if (!withQuestion.length) return "";

  const lines = withQuestion.map((f) => `Q: ${f.q}\nA: ${f.a}`);
  return `【常见问答补充（来自 Google Sheets，实时更新）】\n${lines.join("\n\n")}`;
}

/**
 * 获取拼好的 Google Sheets 内容文字，带缓存。
 * 任何一步失败都不会抛出异常，最多返回旧缓存或空字符串，
 * 保证机器人不会因为表格读取失败而完全无法回复。
 */
async function getSheetContext() {
  const now = Date.now();
  if (cache.text && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.text;
  }
  try {
    const [products, faqs] = await Promise.all([
      fetchCsv(PRODUCTS_CSV_URL),
      fetchCsv(FAQ_CSV_URL),
    ]);
    const text = [formatProducts(products), formatFaq(faqs)]
      .filter(Boolean)
      .join("\n\n");
    cache = { text, fetchedAt: now };
    return text;
  } catch (err) {
    console.error("⚠️ 读取 Google Sheets 资料失败，本次先用旧缓存/仅用 storeInfo.js 的内容：", err.message);
    return cache.text || "";
  }
}

/**
 * 获取结构化的商品列表（名称/价格/库存等），带缓存。
 * 给"WhatsApp 内直接下单"功能用来匹配客户说的商品名、算金额，
 * 跟 getSheetContext() 用的是同一份表格数据，只是这里要的是结构化数据而不是拼好的文字。
 */
async function getProducts() {
  const now = Date.now();
  if (productsCache.rows.length && now - productsCache.fetchedAt < CACHE_TTL_MS) {
    return productsCache.rows;
  }
  try {
    const rows = (await fetchCsv(PRODUCTS_CSV_URL)).map(toProductRecord).filter((p) => p.name);
    productsCache = { rows, fetchedAt: now };
    return rows;
  } catch (err) {
    console.error("⚠️ 读取商品表格失败，本次先用旧缓存：", err.message);
    return productsCache.rows;
  }
}

module.exports = { getSheetContext, getProducts };
