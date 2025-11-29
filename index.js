import { Telegraf } from "telegraf";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import mongoose from "mongoose";

dotenv.config();

// ======================= KẾT NỐI MONGODB =======================
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: "gemini_bot",
    });
    console.log("✅ Đã kết nối MongoDB");
  } catch (err) {
    console.error("❌ Lỗi kết nối MongoDB:", err.message);
    process.exit(1);
  }
}
await connectDB();

// ======================= SCHEMA LƯU TOKEN =======================
const userTokenSchema = new mongoose.Schema({
  userId: { type: String, index: true },
  date: { type: String }, // dạng YYYY-MM-DD
  tokens: { type: Number, default: 0 },
});

const UserToken = mongoose.model("UserToken", userTokenSchema);

// Hàm đếm token (gần đúng: 1 từ ≈ 1 token)
function countTokens(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}

// Lấy ngày hiện tại YYYY-MM-DD
function todayStr() {
  return new Date().toISOString().split("T")[0];
}

// Lấy hoặc tạo record token cho user
async function getUserTokenDoc(userId) {
  const today = todayStr();
  let doc = await UserToken.findOne({ userId });

  if (!doc) {
    doc = new UserToken({ userId, date: today, tokens: 0 });
    await doc.save();
    return doc;
  }

  // Nếu qua ngày mới thì reset
  if (doc.date !== today) {
    doc.date = today;
    doc.tokens = 0;
    await doc.save();
  }

  return doc;
}

// Kiểm tra còn token không
async function canUseTokens(userId, limit = 300) {
  const doc = await getUserTokenDoc(userId);
  return { allowed: doc.tokens < limit, used: doc.tokens, doc };
}

// Cộng token sau mỗi lần trả lời
async function addTokens(userId, amount, limit = 300) {
  const doc = await getUserTokenDoc(userId);
  doc.tokens = Math.min(limit, doc.tokens + amount);
  await doc.save();
  return doc.tokens;
}

// ======================= HELPER TRÁNH CRASH TELEGRAM =======================
async function safeReply(ctx, text, extra = {}) {
  try {
    return await ctx.reply(text, extra);
  } catch (err) {
    console.error("Lỗi gửi tin nhắn Telegram:", err);
  }
}

async function safeReplyPhoto(ctx, buffer, extra = {}) {
  try {
    return await ctx.replyWithPhoto({ source: buffer }, extra);
  } catch (err) {
    console.error("Lỗi gửi ảnh Telegram:", err);
  }
}

// ======================= GEMINI & TELEGRAM =======================
const bot = new Telegraf(process.env.BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);

// Model chat (text) có giới hạn output token
const modelChat = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  generationConfig: {
    maxOutputTokens: 200, // giới hạn 200 token/lần trả lời
    temperature: 0.9,
  },
});

// Model tạo ảnh thật
const modelImage = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-image",
});

// ======================= /start =======================
bot.start(async (ctx) => {
  await safeReply(
    ctx,
    "Xin chào! Bot Gemini:\n" +
      "- /chat + nội dung → chat với AI\n" +
      "- /img + mô tả → tạo ảnh bằng AI\n\n" +
      "Mỗi người có 300 token/ngày."
  );
});

// ======================= LỆNH /chat =======================
bot.command("chat", async (ctx) => {
  const userId = String(ctx.from.id);

  try {
    const { allowed, used } = await canUseTokens(userId, 300);
    if (!allowed) {
      return safeReply(
        ctx,
        `⛔ Bạn đã dùng hết 300 token hôm nay.\nToken hôm nay: ${used}/300\nReset sau 0h.`
      );
    }

    const prompt = ctx.message.text.replace("/chat", "").trim();
    if (!prompt) {
      return safeReply(ctx, "Nhập nội dung sau /chat");
    }

    // Giới hạn độ dài input để đỡ tốn
    if (prompt.length > 500) {
      return safeReply(ctx, "Tin nhắn quá dài! Giới hạn 500 ký tự.");
    }

    let reply;
    try {
      reply = await modelChat.generateContent(prompt);
    } catch (err) {
      console.error("Lỗi gọi Gemini trong /chat:", err);

      if (err.status === 429) {
        return safeReply(
          ctx,
          "Gemini báo vượt hạn mức free (429 Too Many Requests).\nĐợi vài chục giây rồi thử lại, hoặc hạn chế spam lệnh."
        );
      }

      return safeReply(ctx, "Lỗi server AI, thử lại sau.");
    }

    const text = reply.response.text();
    const usedTokens = countTokens(text);
    const total = await addTokens(userId, usedTokens, 300);

    await safeReply(
      ctx,
      `${text}\n\n🔹 Token đã dùng hôm nay: ${total}/300`
    );
  } catch (err) {
    console.error("Lỗi handler /chat:", err);
    await safeReply(ctx, "Lỗi xử lý phía bot.");
  }
});

// ======================= LỆNH /img (TẠO ẢNH THẬT) =======================
bot.command("img", async (ctx) => {
  const prompt = ctx.message.text.replace("/img", "").trim();
  if (!prompt) {
    return safeReply(
      ctx,
      "Nhập mô tả ảnh sau /img\nVD: /img cô gái anime tóc trắng đứng cạnh siêu xe ban đêm, phong cách cyberpunk"
    );
  }

  await safeReply(ctx, "⏳ Đang tạo ảnh bằng Gemini, chờ chút...");

  try {
    const result = await modelImage.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: "1:1",
        },
      },
    });

    const response = await result.response;
    const candidates = response.candidates ?? [];
    const parts = candidates[0]?.content?.parts ?? [];

    const imagePart = parts.find(
      (p) => p.inlineData && p.inlineData.mimeType?.startsWith("image/")
    );

    if (!imagePart) {
      console.error("Không tìm thấy imagePart trong phản hồi Gemini:", parts);
      return safeReply(
        ctx,
        "Gemini không trả về ảnh. Thử mô tả rõ hơn, cụ thể hơn."
      );
    }

    const base64 = imagePart.inlineData.data;
    const buffer = Buffer.from(base64, "base64");

    await safeReplyPhoto(ctx, buffer, {
      caption: `Ảnh tạo bởi Gemini từ prompt:\n"${prompt}"`,
    });
  } catch (err) {
    console.error("Lỗi /img:", err);

    if (err.status === 429) {
      return safeReply(
        ctx,
        "Gemini tạo ảnh đang vượt hạn mức free (429). Thử lại sau ít phút."
      );
    }

    await safeReply(ctx, "Lỗi tạo ảnh AI, thử lại sau.");
  }
});

// ======================= CHAT TEXT THƯỜNG =======================
// Không gọi Gemini nữa để tránh spam quota.
// Chỉ nhắc user dùng /chat hoặc /img.
bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return; // lệnh đã xử lý ở trên

  await safeReply(
    ctx,
    "Dùng lệnh:\n" +
      "- /chat + nội dung → chat AI\n" +
      "- /img + mô tả → tạo ảnh AI\n\n" +
      "Mỗi người có 300 token chat/ngày."
  );
});

// ======================= START BOT =======================
bot.launch();
console.log(
  "🤖 Bot Gemini đang chạy (chat + tạo ảnh thật + limit 300 token/ngày, có xử lý 429 & timeout Telegram)"
);
