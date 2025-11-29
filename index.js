import { Telegraf } from "telegraf";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

// ======================= HELPER TRÁNH CRASH TELEGRAM =======================
async function safeReply(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, extra);
  } catch (err) {
    console.error("Lỗi gửi tin nhắn Telegram:", err);
  }
}

// ======================= GEMINI & TELEGRAM =======================
const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);

// Model chat
const modelChat = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  generationConfig: {
    maxOutputTokens: 300,
    temperature: 0.9,
  },
});

// ======================= /start =======================
bot.start(async (ctx) => {
  await safeReply(
    ctx,
    "Chào bạn! Đây là bot Gemini.\n" +
      "Dùng lệnh:\n" +
      "- /chat + nội dung → chat AI\n\n" +
      "Đã tắt giới hạn token và xoá lệnh tạo ảnh."
  );
});

// ======================= LỆNH /chat =======================
bot.command("chat", async (ctx) => {
  const prompt = ctx.message.text.replace("/chat", "").trim();

  if (!prompt) {
    return safeReply(ctx, "Nhập nội dung sau /chat");
  }

  // Giới hạn input cho an toàn
  if (prompt.length > 1000) {
    return safeReply(ctx, "Tin nhắn quá dài! Giới hạn 1000 ký tự.");
  }

  let replyAI;
  try {
    replyAI = await modelChat.generateContent(prompt);
  } catch (err) {
    console.error("Lỗi gọi Gemini:", err);

    if (err.status === 429) {
      return safeReply(
        ctx,
        "Gemini đang bị hạn mức (429). Thử lại sau vài giây."
      );
    }

    return safeReply(ctx, "Lỗi AI, thử lại sau.");
  }

  const text = replyAI.response.text();
  await safeReply(ctx, text);
});

// ======================= KHÔNG AUTO TRẢ LỜI TIN NHẮN =======================
// bot.on("text") đã bị xoá theo yêu cầu.

// ======================= START BOT =======================
bot.launch();
console.log("🤖 Bot Gemini đang chạy (không giới hạn, không tạo ảnh, không auto chat)");
