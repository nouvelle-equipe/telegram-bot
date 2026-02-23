import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

/**
 * ENV VARS (Render)
 * - TELEGRAM_BOT_TOKEN
 * - OPENAI_API_KEY
 * - OPENAI_ASSISTANT_ID   (asst_...)
 * - PORT                  (Render zet dit automatisch)
 */

const {
  TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY,
  OPENAI_ASSISTANT_ID,
  PORT,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!OPENAI_ASSISTANT_ID) throw new Error("Missing OPENAI_ASSISTANT_ID");

/* -------------------------
   1) MINI HEALTH SERVER (voor Render Web Service)
-------------------------- */
const port = PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(port, () => {
    console.log(`Health server listening on ${port}`);
  });

/* -------------------------
   2) TELEGRAM + OPENAI
-------------------------- */
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// In-memory sessions (reset bij redeploy)
const sessions = new Map();
/**
 * sessions.get(userId) => {
 *   threadId: string,
 *   mode: "WORK" | "HIRING" | "GENERAL"
 * }
 */

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { threadId: null, mode: null });
  return sessions.get(userId);
}

async function getOrCreateThread(userId) {
  const s = getSession(userId);
  if (s.threadId) return s.threadId;
  const thread = await openai.beta.threads.create();
  s.threadId = thread.id;
  return thread.id;
}

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "👤 Ik zoek werk", callback_data: "MODE_WORK" },
        { text: "🏢 Ik zoek personeel", callback_data: "MODE_HIRING" },
      ],
      [{ text: "💬 Algemene vraag", callback_data: "MODE_GENERAL" }],
      [{ text: "🔄 Reset gesprek", callback_data: "RESET" }],
    ],
  };
}

function modeToLabel(mode) {
  if (mode === "WORK") return "Werkzoekend";
  if (mode === "HIRING") return "Personeel inhuren";
  return "Algemeen";
}

function modeHint(mode) {
  if (mode === "WORK") {
    return (
      "Top! 👤\nStuur:\n" +
      "1) Welke functie?\n2) Welke stad/regio?\n3) Wanneer beschikbaar?\n\n" +
      "Je mag ook gewoon je vraag typen."
    );
  }
  if (mode === "HIRING") {
    return (
      "Helemaal goed! 🏢\nStuur:\n" +
      "1) Datum/tijd\n2) Locatie\n3) Aantal mensen + functies\n\n" +
      "Je mag ook gewoon je vraag typen."
    );
  }
  return "Oké 💬 Typ je vraag maar, ik help je meteen.";
}

async function runAssistant({ userId, userText }) {
  const s = getSession(userId);
  const threadId = await getOrCreateThread(userId);

  // We sturen de gekozen “flow” mee als context voor jullie prompt
  const contextPrefix =
    s.mode ? `[CONTEXT: ${modeToLabel(s.mode)}]\n` : "[CONTEXT: Onbekend]\n";

  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: contextPrefix + userText,
  });

  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: OPENAI_ASSISTANT_ID,
    metadata: { telegram_user_id: String(userId) },
  });

  // Wachten tot klaar (simpel)
  while (true) {
    await new Promise((r) => setTimeout(r, 800));
    const status = await openai.beta.threads.runs.retrieve(threadId, run.id);

    if (status.status === "completed") break;

    // Als jullie later tools/function calling doen, moet je dit uitbreiden:
    if (status.status === "requires_action") {
      throw new Error("Run requires_action (tools) — tool handling not implemented.");
    }

    if (["failed", "cancelled", "expired"].includes(status.status)) {
      throw new Error(`Run ended with status: ${status.status}`);
    }
  }

  const messages = await openai.beta.threads.messages.list(threadId, { limit: 10 });
  const latest = messages.data.find((m) => m.role === "assistant");
  const textPart = latest?.content?.find((c) => c.type === "text");

  return textPart?.text?.value?.trim() || "Ik kon even geen antwoord maken. Probeer het opnieuw 🙏";
}

/* -------------------------
   3) START + FLOW
-------------------------- */
async function sendWelcome(chatId, userId) {
  const s = getSession(userId);
  const modeLine = s.mode ? `Huidige flow: ${modeToLabel(s.mode)}\n\n` : "";
  await bot.sendMessage(
    chatId,
    "Welkom bij Nouvelle Équipe 👋\n\n" +
      modeLine +
      "Kies waar je hulp bij wilt, of stel direct je vraag:",
    { reply_markup: mainMenuKeyboard() }
  );
}

// /start en tekstberichten
bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = msg.text?.trim();

  if (!chatId || !userId || !text) return;

  if (text.startsWith("/start")) {
    return sendWelcome(chatId, userId);
  }

  if (text.startsWith("/reset")) {
    sessions.delete(userId);
    await bot.sendMessage(chatId, "Gesprek gereset ✅");
    return sendWelcome(chatId, userId);
  }

  // Als iemand nog geen flow koos, stuur menu
  const s = getSession(userId);
  if (!s.mode) {
    await bot.sendMessage(
      chatId,
      "Eerst even kiezen wat je wilt doen 🙂",
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const answer = await runAssistant({ userId, userText: text });
    await bot.sendMessage(chatId, answer, { disable_web_page_preview: true });
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, "Oeps — er ging iets mis. Probeer het nog eens.");
  }
});

// Knoppen (inline keyboard)
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;
  const data = q.data;

  if (!chatId || !userId || !data) return;

  try {
    if (data === "RESET") {
      sessions.delete(userId);
      await bot.answerCallbackQuery(q.id, { text: "Gerest ✅" });
      await bot.sendMessage(chatId, "Gesprek gereset ✅");
      return sendWelcome(chatId, userId);
    }

    const s = getSession(userId);

    if (data === "MODE_WORK") s.mode = "WORK";
    if (data === "MODE_HIRING") s.mode = "HIRING";
    if (data === "MODE_GENERAL") s.mode = "GENERAL";

    // (optioneel) thread resetten bij mode switch:
    // s.threadId = null;

    await bot.answerCallbackQuery(q.id, { text: `Flow: ${modeToLabel(s.mode)}` });
    await bot.sendMessage(chatId, modeHint(s.mode));
  } catch (e) {
    console.error(e);
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

console.log("✅ Telegram bot draait (polling) + Render port binding + flow menu");
