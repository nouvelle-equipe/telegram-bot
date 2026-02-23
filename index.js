import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

const {
  TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID, // jullie prompt/assistant id
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!OPENAI_ASSISTANT_ID) throw new Error("Missing OPENAI_ASSISTANT_ID");

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// 1 thread per telegram user (simpel; reset bij redeploy)
const userThreads = new Map();

async function getOrCreateThread(userId) {
  if (userThreads.has(userId)) return userThreads.get(userId);
  const thread = await openai.beta.threads.create();
  userThreads.set(userId, thread.id);
  return thread.id;
}

async function runAssistant({ userText, userId }) {
  const threadId = await getOrCreateThread(userId);

  // user message
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: userText,
  });

  // run assistant/prompt
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: OPENAI_ASSISTANT_ID,
    metadata: { telegram_user_id: String(userId) },
  });

  // wait until finished
  while (true) {
    await new Promise((r) => setTimeout(r, 800));
    const status = await openai.beta.threads.runs.retrieve(threadId, run.id);

    if (status.status === "completed") break;

    // als je later tools gebruikt (function calling), dan kun je dit uitbreiden
    if (status.status === "requires_action") {
      throw new Error("Run requires_action (tools). Implement tool handling if needed.");
    }

    if (["failed", "cancelled", "expired"].includes(status.status)) {
      throw new Error(`Run ended with status: ${status.status}`);
    }
  }

  // latest assistant message ophalen
  const messages = await openai.beta.threads.messages.list(threadId, { limit: 10 });

  const latest = messages.data.find((m) => m.role === "assistant");
  const textPart = latest?.content?.find((c) => c.type === "text");

  return textPart?.text?.value?.trim() || "Ik kon even geen antwoord maken. Probeer het opnieuw 🙏";
}

bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = msg.text?.trim();

  if (!chatId || !userId || !text) return;

  // /start
  if (text.startsWith("/start")) {
    return bot.sendMessage(
      chatId,
      "Welkom bij Nouvelle Équipe 👋\n\n" +
        "Ik help je met:\n" +
        "• Vacatures & werk\n" +
        "• Personeel inhuren\n" +
        "• Algemene vragen\n\n" +
        "Stel je vraag en ik help je verder."
    );
  }

  // optioneel: /reset om conversation te resetten
  if (text.startsWith("/reset")) {
    userThreads.delete(userId);
    return bot.sendMessage(chatId, "Helemaal goed — je gesprek is gereset. Stel je vraag opnieuw 🙌");
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const answer = await runAssistant({ userText: text, userId });
    await bot.sendMessage(chatId, answer, { disable_web_page_preview: true });
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, "Oeps — er ging iets mis. Probeer het nog eens.");
  }
});

console.log("✅ Telegram bot draait (polling) met OpenAI Prompt/Assistant ID");
