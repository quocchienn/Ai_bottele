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

// ======================= LỆNH /chat =======================
bot.command("chat", async (ctx) => {
  const userId = String(ctx.from.id);

  try {
    const { allowed, used } = await canUseTokens(userId, 300);
    if (!allowed) {
      return ctx.reply(
        `⛔ Bạn đã dùng hết 300 token hôm nay.\nToken hôm nay: ${used}/300\nReset sau 0h.`
      );
    }

    const prompt = ctx.message.text.replace("/chat", "").trim();
    if (!prompt) {
      return ctx.reply("Nhập nội dung sau /chat");
    }

    // Giới hạn độ dài input để đỡ tốn
    if (prompt.length > 500) {
      return ctx.reply("Tin nhắn quá dài! Giới hạn 500 ký tự.");
    }

    const reply = await modelChat.generateContent(prompt);
    const text = reply.response.text();

    const usedTokens = countTokens(text);
    const total = await addTokens(userId, usedTokens, 300);

    await ctx.reply(
      `${text}\n\n🔹 Token đã dùng hôm nay: ${total}/300`
    );
  } catch (err) {
    console.error(err);
    ctx.reply("Lỗi chat AI");
  }
});

// ======================= LỆNH /img (TẠO ẢNH THẬT) =======================
bot.command("img", async (ctx) => {
  try {
    const prompt = ctx.message.text.replace("/img", "").trim();
    if (!prompt) {
      return ctx.reply("Nhập mô tả ảnh sau /img\nVí dụ: /img một chàng trai ngầu đứng cạnh siêu xe ban đêm, style cyberpunk");
    }

    await ctx.reply("⏳ Đang tạo ảnh bằng Gemini, chờ chút...");

    // Gọi model tạo ảnh
    const result = await modelImage.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      // Có thể thêm config aspectRatio nếu muốn
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: "1:1", // 1:1, 16:9, 9:16...
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
      return ctx.reply("Gemini không trả về ảnh, thử mô tả rõ hơn hoặc khác đi.");
    }

    const base64 = imagePart.inlineData.data;
    const buffer = Buffer.from(base64, "base64");

    await ctx.replyWithPhoto(
      { source: buffer },
      { caption: `Ảnh tạo bởi Gemini từ prompt:\n"${prompt}"` }
    );
  } catch (err) {
    console.error("Lỗi /img:", err);
    ctx.reply("Lỗi tạo ảnh AI, thử lại sau.");
  }
});

// ======================= CHAT TỰ NHIÊN =======================
bot.on("text", async (ctx) => {
  // Bỏ qua nếu là lệnh (đã xử lý ở trên)
  if (ctx.message.text.startsWith("/")) return;

  const userId = String(ctx.from.id);

  try {
    const { allowed, used } = await canUseTokens(userId, 300);
    if (!allowed) {
      return ctx.reply(
        `⛔ Bạn đã dùng hết 300 token hôm nay.\nToken hôm nay: ${used}/300\nReset sau 0h.`
      );
    }

    const prompt = ctx.message.text;

    // Giới hạn input chat thường
    if (prompt.length > 300) {
      return ctx.reply("Tin nhắn quá dài! Giới hạn 300 ký tự.");
    }

    const reply = await modelChat.generateContent(prompt);
    const text = reply.response.text();

    const usedTokens = countTokens(text);
    const total = await addTokens(userId, usedTokens, 300);

    await ctx.reply(
      `${text}\n\n🔹 Token đã dùng hôm nay: ${total}/300`
    );
  } catch (err) {
    console.error(err);
    ctx.reply("Lỗi xử lý văn bản");
  }
});

// ======================= START BOT =======================
bot.launch();
console.log("🤖 Bot Gemini đang chạy (chat + tạo ảnh thật + limit 300 token/ngày)");
