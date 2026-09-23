// send-promo.js
// 群发促销消息给"已同意推广"的客户名单（从 FOLLOWUP_LOG_URL 这张"客户跟进"表格里筛）。
//
// 用法：
//   node send-promo.js "这次促销的具体内容"            先预览，不会真的发送
//   node send-promo.js "这次促销的具体内容" --send      预览通过后，加 --send 才真正群发
//
// 例子：
//   node send-promo.js "全场护手霜买一送一，即日起至月底"
//
// 每位客户会按他表格里记录的语言（zh/en/ms）收到对应版本的促销模板消息，
// 语言不明的默认发英文版。促销模板还在等 WhatsApp 审核通过，
// 审核没过之前 --send 会失败并报错，属于正常情况，等审核过了再重试即可。

require("dotenv").config();
const twilio = require("twilio");

const FOLLOWUP_LOG_URL =
  process.env.FOLLOWUP_LOG_URL ||
  "https://script.google.com/macros/s/AKfycbxpW5nz3nH8TM1fUH5FXKE2U554aTw6WwuN8RSQjPlPgfyY99Y2GkMjFCpyql8CylBFyA/exec";

const MARKETING_TEMPLATE_CONTENT_SID = {
  zh: "HX368e0677552b5b03bbdb5a35c37fd3a2",
  en: "HXcabe90ae61315ff97deeff8d81c351d7",
  ms: "HX7c2388a23011e5f2f7d7ab3542aa6bf8",
};

const promoText = process.argv[2];
const shouldSend = process.argv.includes("--send");

if (!promoText) {
  console.error('用法：node send-promo.js "促销内容" [--send]');
  process.exit(1);
}

async function main() {
  const res = await fetch(FOLLOWUP_LOG_URL);
  const rows = await res.json();
  const targets = rows.filter((r) => r["已同意推广"] === "是" && r["手机号"]);

  if (!targets.length) {
    console.log("目前没有任何客户「已同意推广」，没有可发送的对象。");
    return;
  }

  console.log(`共 ${targets.length} 位客户已同意接收推广：`);
  targets.forEach((r) => {
    const lang = MARKETING_TEMPLATE_CONTENT_SID[r["语言"]] ? r["语言"] : "en（默认）";
    console.log(`  ${r["手机号"]}  ${r["姓名"] || "(未留姓名)"}  语言:${lang}`);
  });
  console.log(`\n促销内容：${promoText}`);

  if (!shouldSend) {
    console.log("\n【预览模式】还没有真的发送。确认名单和内容没问题后，加上 --send 参数再跑一次即可真正群发。");
    return;
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_WHATSAPP_FROM) {
    console.error("⚠️ 还没配置 TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM 环境变量，无法发送。");
    process.exit(1);
  }
  const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  console.log("\n开始群发...");
  let ok = 0;
  let fail = 0;
  for (const row of targets) {
    const lang = MARKETING_TEMPLATE_CONTENT_SID[row["语言"]] ? row["语言"] : "en";
    const to = row["手机号"].startsWith("whatsapp:") ? row["手机号"] : `whatsapp:${row["手机号"]}`;
    try {
      await twilioClient.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM,
        to,
        contentSid: MARKETING_TEMPLATE_CONTENT_SID[lang],
        contentVariables: JSON.stringify({
          "1": row["姓名"] || (lang === "zh" ? "您好" : "there"),
          "2": promoText,
        }),
      });
      console.log(`✅ 已发送给 ${to}`);
      ok++;
    } catch (err) {
      console.error(`❌ 发送失败（${to}）：${err.message}`);
      fail++;
    }
  }
  console.log(`\n完成：成功 ${ok} 条，失败 ${fail} 条。`);
}

main().catch((err) => {
  console.error("脚本执行出错：", err.message);
  process.exit(1);
});
