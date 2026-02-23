import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

async function askOpenAI(userText, userId) {
  // 1. Thread aanmaken
  const thread = await openai.beta.threads.create();

  // 2. User message toevoegen
  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: userText,
  });

  // 3. Run starten met jullie Assistant / Prompt
  const run = await openai.beta.threads.runs.create(thread.id, {
    assistant_id: ASSISTANT_ID,
    metadata: { telegram_user_id: String(userId) },
  });

  // 4. Wachten tot klaar
  let status;
  do {
    await new Promise(r => setTimeout(r, 800));
    status = await openai.beta.threads.runs.retrieve(thread.id, run.id);
  } while (status.status !== "completed");

  // 5. Antwoord ophalen
  const messages = await openai.beta.threads.messages.list(thread.id);
  return messages.data[0].content[0].text.value;
}

bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const text = msg.text?.trim();
  const userId = msg.from?.id;

  if (!chatId || !text) return;

  if (text === "/start") {
    return bot.sendMessage(chatId, "Hi! Stuur je vraag 🙌");
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const answer = await askOpenAI(text, userId);
    await bot.sendMessage(chatId, answer);
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, "Er ging iets mis, probeer het nog eens.");
  }
});

console.log("Telegram bot draait met OpenAI Prompt ID 🚀");
