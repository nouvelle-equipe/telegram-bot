import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Plak hier Melissa’s “system prompt”
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `
Je bent de assistent van Nouvelle Équipe.
Antwoord in het Nederlands, kort en praktisch.
`;

async function askOpenAI(userText, userId) {
  const resp = await openai.responses.create({
    model: MODEL,
    input: [
      { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT.trim() }] },
      { role: "user", content: [{ type: "text", text: userText }] },
    ],
    metadata: { telegram_user_id: String(userId) },
  });

  return (resp.output_text || "").trim() || "Ik kon even geen antwoord maken. Probeer het opnieuw 🙏";
}

bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const text = msg.text?.trim();
  const userId = msg.from?.id;

  if (!chatId || !text) return;

  if (text.startsWith("/start")) {
    return bot.sendMessage(chatId, "Hi! Stuur je vraag, dan help ik je verder 🙌");
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const answer = await askOpenAI(text, userId);
    await bot.sendMessage(chatId, answer, { disable_web_page_preview: true });
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, "Oeps — er ging iets mis. Probeer het zo nog eens.");
  }
});

console.log("Telegram bot draait (polling)...");
