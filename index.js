import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";

/**
 * Render ENV VARS:
 * - TELEGRAM_BOT_TOKEN
 * - OPENAI_API_KEY
 * - OPENAI_PROMPT_ID        (pmpt_...)
 * - OPENAI_MODEL            (optioneel; bv gpt-4o-mini)
 * - PORT                    (Render zet dit automatisch)
 */

const {
  TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY,
  OPENAI_PROMPT_ID,
  OPENAI_MODEL,
  PORT,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!OPENAI_PROMPT_ID) throw new Error("Missing OPENAI_PROMPT_ID (pmpt_...)");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

/* -------------------------
   1) MINI HEALTH SERVER (Render Web Service needs a port)
-------------------------- */
const port = PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(port, () => console.log(`Health server listening on ${port}`));

/* -------------------------
   2) SESSIONS: 1 flow + 1 conversation state per user
-------------------------- */
const sessions = new Map();
/**
 * sessions.get(userId) => {
 *   mode: "WORK"|"HIRING"|"GENERAL"|null,
 *   previousResponseId: string|null
 * }
 */
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { mode: null, previousResponseId: null });
  return sessions.get(userId);
}

function modeToLabel(mode) {
  if (mode === "WORK") return "Werkzoekend";
  if (mode === "HIRING") return "Personeel inhuren";
  return "Algemeen";
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

function modeHint(mode) {
  if (mode === "WORK") {
    return (
      "Top! 👤\nStuur (als je wil):\n" +
      "1) Functie\n2) Stad/regio\n3) Beschikbaarheid\n\n" +
      "Of typ gewoon je vraag."
    );
  }
  if (mode === "HIRING") {
    return (
      "Helemaal goed! 🏢\nStuur (als je wil):\n" +
      "1) Datum/tijd\n2) Locatie\n3) Aantal + functies\n\n" +
      "Of typ gewoon je vraag."
    );
  }
  return "Oké 💬 Typ je vraag maar, ik help je meteen.";
}

async function sendWelcome(chatId, userId) {
  const s = getSession(userId);
  const modeLine = s.mode ? `Huidige flow: ${modeToLabel(s.mode)}\n\n` : "";
  return bot.sendMessage(
    chatId,
    "Welkom bij Nouvelle Équipe 👋\n\n" +
      modeLine +
      "Kies waar je hulp bij wilt, of stel direct je vraag:",
    { reply_markup: mainMenuKeyboard() }
  );
}

/* -------------------------
   3) OPENAI CALL (Prompt ID + variables + conversation via previous_response_id)
   Zorg dat je Prompt Template variabelen heeft zoals:
   - {{user_text}}
   - {{context}}
-------------------------- */
async function askWithPrompt({ userId, userText, context }) {
  const s = getSession(userId);

  const resp = await openai.responses.create({
    // model is meestal required; als je prompt template al een model afdwingt,
    // kun je OPENAI_MODEL alsnog gewoon zetten om zeker te zijn.
    model: OPENAI_MODEL || "gpt-4o-mini",
    prompt: {
      id: OPENAI_PROMPT_ID,
      variables: {
        user_text: userText,
        context: context || "Algemeen",
      },
    },
    // dit houdt de conversatie “aan elkaar” per Telegram user
    previous_response_id: s.previousResponseId || undefined,

    metadata: { telegram_user_id: String(userId) },
  });

  // bewaar state voor volgende beurt
  s.previousResponseId = resp.id;

  return (resp.output_text || "").trim() || "Ik kon even geen antwoord maken. Probeer het opnieuw 🙏";
}

/* -------------------------
   4) TELEGRAM HANDLERS
-------------------------- */
bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text = msg.text?.trim();

  if (!chatId || !userId || !text) return;

  if (text.startsWith("/start")) return sendWelcome(chatId, userId);

  if (text.startsWith("/reset")) {
    sessions.delete(userId);
    await bot.sendMessage(chatId, "Gesprek gereset ✅");
    return sendWelcome(chatId, userId);
  }

  const s = getSession(userId);
  if (!s.mode) {
    await bot.sendMessage(chatId, "Eerst even kiezen 🙂", { reply_markup: mainMenuKeyboard() });
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const answer = await askWithPrompt({
      userId,
      userText: text,
      context: modeToLabel(s.mode),
    });
    await bot.sendMessage(chatId, answer, { disable_web_page_preview: true });
  } catch (e) {
    console.error(e);
    await bot.sendMessage(chatId, "Oeps — er ging iets mis. Probeer het nog eens.");
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;
  const data = q.data;

  if (!chatId || !userId || !data) return;

  try {
    const s = getSession(userId);

    if (data === "RESET") {
      sessions.delete(userId);
      await bot.answerCallbackQuery(q.id, { text: "Gerest ✅" });
      await bot.sendMessage(chatId, "Gesprek gereset ✅");
      return sendWelcome(chatId, userId);
    }

    if (data === "MODE_WORK") s.mode = "WORK";
    if (data === "MODE_HIRING") s.mode = "HIRING";
    if (data === "MODE_GENERAL") s.mode = "GENERAL";

    // optioneel: conversation state reset bij mode switch
    // s.previousResponseId = null;

    await bot.answerCallbackQuery(q.id, { text: `Flow: ${modeToLabel(s.mode)}` });
    await bot.sendMessage(chatId, modeHint(s.mode));
  } catch (e) {
    console.error(e);
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

console.log("✅ Telegram bot draait (polling) + Render port binding + Prompt ID flow menu");
