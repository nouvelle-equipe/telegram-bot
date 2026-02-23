import express from "express";
import fetch from "node-fetch";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROMPT_ID = process.env.OPENAI_PROMPT_ID; // pmpt_...
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // https://jouw-service.onrender.com

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !OPENAI_PROMPT_ID || !WEBHOOK_SECRET) {
  console.error("Missing env vars: TELEGRAM_TOKEN, OPENAI_API_KEY, OPENAI_PROMPT_ID, WEBHOOK_SECRET");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- simpele state per chat ---
const stateByChat = new Map(); // chatId -> { prevId, mode }
function getState(chatId) {
  const key = String(chatId);
  if (!stateByChat.has(key)) stateByChat.set(key, { prevId: null, mode: "general" });
  return stateByChat.get(key);
}
function resetState(chatId) {
  stateByChat.set(String(chatId), { prevId: null, mode: "general" });
}

// --- Telegram helpers ---
async function tgApi(method, body) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error(`Telegram ${method} failed:`, res.status, t);
    return null;
  }
  return res.json().catch(() => null);
}
const tgSendMessage = (chatId, text, extra = {}) =>
  tgApi("sendMessage", { chat_id: chatId, text: String(text || ""), disable_web_page_preview: true, ...extra });
const tgSendChatAction = (chatId, action = "typing") =>
  tgApi("sendChatAction", { chat_id: chatId, action });
const tgAnswerCallbackQuery = (id) => tgApi("answerCallbackQuery", { callback_query_id: id });

// --- Menu UI ---
function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "👤 Ik zoek werk", callback_data: "set_mode:work" },
        { text: "🏢 Ik zoek personeel", callback_data: "set_mode:hiring" },
      ],
      [{ text: "💬 Algemene vraag", callback_data: "set_mode:general" }],
      [{ text: "🔄 Reset", callback_data: "reset" }],
    ],
  };
}
async function showMenu(chatId) {
  const st = getState(chatId);
  await tgSendMessage(
    chatId,
    `Kies een flow of typ je vraag.\nHuidige flow: ${st.mode}`,
    { reply_markup: menuKeyboard() }
  );
}

// --- OpenAI Responses (prompt) ---
async function openaiRespond({ chatId, userText }) {
  const st = getState(chatId);

  const instructions = [
    "Antwoord in het Nederlands.",
    `Intent: ${st.mode}.`,
    "Telegram style: plain text, korte alinea’s, lijstjes als 1) 2) 3).",
  ].join("\n");

  const body = {
    model: OPENAI_MODEL,                 // ✅ gpt-4.1-mini
    prompt: { id: OPENAI_PROMPT_ID },    // ✅ pmpt_...
    input: [{ role: "user", content: userText }],
    previous_response_id: st.prevId || undefined,
    instructions,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI failed: ${res.status} ${t}`);
  }

  const json = await res.json();
  st.prevId = json.id;

  return (json.output_text || "").trim() || "…";
}

// --- Callbacks (menu buttons) ---
async function handleCallback(update) {
  const cb = update.callback_query;
  const chatId = cb?.message?.chat?.id;
  const data = cb?.data;
  if (!chatId || !data) return;

  await tgAnswerCallbackQuery(cb.id).catch(() => {});
  const st = getState(chatId);

  if (data === "reset") {
    resetState(chatId);
    await tgSendMessage(chatId, "Reset klaar ✅ Typ je vraag of /menu.");
    return;
  }

  if (data.startsWith("set_mode:")) {
    st.mode = data.split(":")[1] || "general";
    st.prevId = null; // frisse context na switch (belangrijk!)
    await tgSendMessage(chatId, `Flow ingesteld: ${st.mode} ✅ Typ je vraag.`);
  }
}

// --- Webhook ---
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    if (update.callback_query) return handleCallback(update);

    const msg = update.message || update.edited_message;
    const chatId = msg?.chat?.id;
    const text = msg?.text?.trim();
    if (!chatId) return;

    if (text === "/start") return tgSendMessage(chatId, "Welkom 👋 Typ je vraag of gebruik /menu.");
    if (text === "/menu") return showMenu(chatId);
    if (text === "/reset") {
      resetState(chatId);
      return tgSendMessage(chatId, "Reset klaar ✅ Typ je vraag of /menu.");
    }

    if (!text) return tgSendMessage(chatId, "Stuur het even als tekst 🙂");

    tgSendChatAction(chatId, "typing").catch(() => {});
    const reply = await openaiRespond({ chatId, userText: text });
    await tgSendMessage(chatId, reply);
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

// Health
app.get("/", (_req, res) => res.send("Nouvelle TG Bot running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Listening on ${PORT}`);

  // Auto webhook set (aanrader)
  if (PUBLIC_URL) {
    const hookUrl = `${PUBLIC_URL}/telegram/${WEBHOOK_SECRET}`;
    const r = await tgApi("setWebhook", { url: hookUrl, drop_pending_updates: true });
    console.log("setWebhook:", r?.ok ? "OK" : r);
    console.log("Webhook URL:", hookUrl);
  } else {
    console.log("PUBLIC_URL missing (zet hem in Render env vars).");
  }
});
