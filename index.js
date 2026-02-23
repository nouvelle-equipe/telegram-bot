import express from "express";
import fetch from "node-fetch";

/* =================== ENV =================== */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROMPT_ID = process.env.OPENAI_PROMPT_ID; // pmpt_...
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me";

// Optioneel: webhook automatisch zetten bij boot (handig op Render)
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // bv https://telegram-bot-s402.onrender.com

// Optioneel: menu afbeelding
const WELCOME_IMAGE_URL = process.env.WELCOME_IMAGE_URL || "";

// Admin/Metrics (optioneel)
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || ""; // jouw chat_id
const METRICS_TOKEN = process.env.METRICS_TOKEN || ""; // secret voor /metrics

if (!TELEGRAM_TOKEN || !OPENAI_API_KEY || !OPENAI_PROMPT_ID || !WEBHOOK_SECRET) {
  console.error(
    "Missing env vars. Need TELEGRAM_TOKEN, OPENAI_API_KEY, OPENAI_PROMPT_ID, WEBHOOK_SECRET"
  );
  process.exit(1);
}

/* =================== APP =================== */
const app = express();
app.use(express.json({ limit: "1mb" }));

/* =================== STATE (in-memory) ===================
   chatId -> { prevId, lang, mode }
*/
const stateByChat = new Map();
function getState(chatId) {
  const key = String(chatId);
  if (!stateByChat.has(key)) {
    stateByChat.set(key, { prevId: null, lang: "nl", mode: "general" });
  }
  return stateByChat.get(key);
}
function resetState(chatId) {
  stateByChat.set(String(chatId), { prevId: null, lang: "nl", mode: "general" });
}

/* =================== METRICS (in-memory) =================== */
const metrics = {
  startedAt: Date.now(),
  totalUpdates: 0,
  totalMessages: 0,
  uniqueUsers: new Set(),
  lastSeenByUser: new Map(),
  starts: 0,
  menus: 0,
};
function trackUpdate(chatId, hasText, textValue) {
  metrics.totalUpdates += 1;
  if (chatId) {
    const key = String(chatId);
    metrics.uniqueUsers.add(key);
    metrics.lastSeenByUser.set(key, Date.now());
  }
  if (hasText) metrics.totalMessages += 1;
  if (textValue === "/start") metrics.starts += 1;
  if (textValue === "/menu") metrics.menus += 1;
}
function countActiveUsersSince(msAgo) {
  const cutoff = Date.now() - msAgo;
  let count = 0;
  for (const ts of metrics.lastSeenByUser.values()) if (ts >= cutoff) count += 1;
  return count;
}

/* =================== TELEGRAM API HELPERS =================== */
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

async function tgSendMessage(chatId, text, extra = {}) {
  return tgApi("sendMessage", {
    chat_id: chatId,
    text: String(text || ""),
    disable_web_page_preview: true,
    ...extra,
  });
}
async function tgSendChatAction(chatId, action = "typing") {
  return tgApi("sendChatAction", { chat_id: chatId, action });
}
async function tgAnswerCallbackQuery(callbackQueryId) {
  return tgApi("answerCallbackQuery", { callback_query_id: callbackQueryId });
}
async function tgSendPhotoWithButtons(chatId, caption, inlineKeyboard) {
  if (WELCOME_IMAGE_URL) {
    const res = await tgApi("sendPhoto", {
      chat_id: chatId,
      photo: WELCOME_IMAGE_URL,
      caption,
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
    if (res) return res;
  }
  return tgSendMessage(chatId, caption, {
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

/* =================== UI (menu) =================== */
function modeLabel(mode, lang = "nl") {
  if (lang === "en") {
    if (mode === "work") return "Looking for work";
    if (mode === "hiring") return "Hiring staff";
    return "General";
  }
  if (mode === "work") return "Ik zoek werk";
  if (mode === "hiring") return "Ik zoek personeel";
  return "Algemeen";
}

function menuCaption(lang = "nl", mode = "general") {
  if (lang === "en") {
    return `Quick start: type your question.\n\nFlow: ${modeLabel(mode, lang)}\n\nMenu:`;
  }
  return `Start direct: typ je vraag.\n\nFlow: ${modeLabel(mode, lang)}\n\nMenu:`;
}

async function showMenu(chatId) {
  const st = getState(chatId);
  const inlineKeyboard = [
    [
      { text: "👤 Ik zoek werk", callback_data: "set_mode:work" },
      { text: "🏢 Ik zoek personeel", callback_data: "set_mode:hiring" },
    ],
    [{ text: "💬 Algemene vraag", callback_data: "set_mode:general" }],
    [
      { text: "🇳🇱 NL", callback_data: "set_lang:nl" },
      { text: "🇬🇧 EN", callback_data: "set_lang:en" },
    ],
    [
      { text: "↩️ Reset", callback_data: "reset" },
      { text: "🌐 Website", url: "https://www.nouvelle-equipe.nl" },
    ],
  ];

  await tgSendPhotoWithButtons(chatId, menuCaption(st.lang, st.mode), inlineKeyboard);
}

/* =================== OPENAI (Responses + Prompt) =================== */
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
};

function extractOutputText(json) {
  if (typeof json?.output_text === "string" && json.output_text.trim()) return json.output_text.trim();
  let out = "";
  const output = json?.output || [];
  for (const item of output) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && c?.text) out += c.text;
      if (c?.type === "text" && typeof c?.text === "string") out += c.text;
      if (c?.type === "text" && c?.text?.value) out += c.text.value;
    }
  }
  return out.trim();
}

function telegramFormattingInstruction() {
  return [
    "Format for Telegram: plain text only.",
    "Use short paragraphs and blank lines.",
    "No markdown, no **bold**, no special bullet symbols.",
    "If you need a list: use simple numbering like '1) ...' on separate lines."
  ].join("\n");
}

function modeInstruction(mode, lang = "nl") {
  // Deze “routing” maakt je prompt direct bruikbaar voor 3 flows
  if (mode === "work") {
    return [
      "Intent: USER IS LOOKING FOR WORK/VACANCIES.",
      lang === "en"
        ? "If info is missing, ask for: role, city/region, availability."
        : "Als info mist, vraag: functie, stad/regio, beschikbaarheid.",
      "Keep it short and practical."
    ].join("\n");
  }
  if (mode === "hiring") {
    return [
      "Intent: USER WANTS TO HIRE STAFF.",
      lang === "en"
        ? "If info is missing, ask for: date/time, location, headcount, roles."
        : "Als info mist, vraag: datum/tijd, locatie, aantal mensen, functies.",
      "Keep it short and practical."
    ].join("\n");
  }
  return [
    "Intent: GENERAL QUESTION.",
    "Answer directly, ask at most one clarifying question if needed."
  ].join("\n");
}

async function openaiRespond({ chatId, userText }) {
  const st = getState(chatId);

  const instructions = [
    st.lang === "en" ? "Respond in English." : "Antwoord in het Nederlands.",
    modeInstruction(st.mode, st.lang),
    telegramFormattingInstruction(),
  ].join("\n\n");

  const body = {
    model: OPENAI_MODEL,
    prompt: { id: OPENAI_PROMPT_ID },      // pmpt_...
    input: [{ role: "user", content: userText }],
    previous_response_id: st.prevId || undefined,
    instructions,
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI responses failed: ${res.status} ${t}`);
  }

  const json = await res.json();
  st.prevId = json.id;
  return extractOutputText(json);
}

/* =================== CALLBACKS =================== */
async function handleCallback(update) {
  const cb = update.callback_query;
  if (!cb) return;

  const chatId = cb.message?.chat?.id;
  const data = cb.data;
  if (!chatId || !data) return;

  await tgAnswerCallbackQuery(cb.id).catch(() => {});
  const st = getState(chatId);

  if (data === "reset") {
    resetState(chatId);
    await tgSendMessage(chatId, "Reset klaar. Typ verder of /menu.");
    return;
  }

  if (data.startsWith("set_lang:")) {
    st.lang = data.split(":")[1] || "nl";
    st.prevId = null; // frisse context na taalwissel
    await tgSendMessage(chatId, st.lang === "en" ? "Language set ✓" : "Taal ingesteld ✓");
    return;
  }

  if (data.startsWith("set_mode:")) {
    st.mode = data.split(":")[1] || "general";
    st.prevId = null; // frisse context na flow switch (voorkomt “vastlopen”)
    await tgSendMessage(chatId, `Flow: ${modeLabel(st.mode, st.lang)} ✓`);
    return;
  }
}

/* =================== ADMIN: /stats =================== */
async function handleStats(chatId) {
  if (!ADMIN_CHAT_ID || String(chatId) !== String(ADMIN_CHAT_ID)) {
    await tgSendMessage(chatId, "Nope 🙂");
    return;
  }
  const uptimeMin = Math.floor((Date.now() - metrics.startedAt) / 60000);
  const dau = countActiveUsersSince(24 * 60 * 60 * 1000);
  const wau = countActiveUsersSince(7 * 24 * 60 * 60 * 1000);

  await tgSendMessage(
    chatId,
    [
      "Nouvelle TG bot stats",
      `Uptime: ${uptimeMin} min`,
      `Unique users (since restart): ${metrics.uniqueUsers.size}`,
      `Active users (24h): ${dau}`,
      `Active users (7d): ${wau}`,
      `Total updates: ${metrics.totalUpdates}`,
      `Total messages: ${metrics.totalMessages}`,
      `Starts: ${metrics.starts}`,
      `Menus: ${metrics.menus}`,
    ].join("\n")
  );
}

/* =================== WEBHOOK =================== */
app.post(`/telegram/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200);

  try {
    const update = req.body;

    if (update.callback_query) {
      await handleCallback(update);
      return;
    }

    const msg = update.message || update.edited_message;
    if (!msg) return;

    const chatId = msg.chat?.id;
    const text = msg.text?.trim();
    if (!chatId) return;

    trackUpdate(chatId, Boolean(text), text);

    // Admin
    if (text === "/stats") return handleStats(chatId);

    // Commands
    if (text === "/start") {
      await tgSendMessage(chatId, "Welkom bij Nouvelle Équipe 👋\nTyp je vraag, of gebruik /menu.");
      return;
    }
    if (text === "/menu") {
      await showMenu(chatId);
      return;
    }
    if (text === "/reset") {
      resetState(chatId);
      await tgSendMessage(chatId, "Reset klaar. Typ verder of /menu.");
      return;
    }

    // Non-text
    if (!text) {
      await tgSendMessage(chatId, "Stuur het even als tekst, dan pak ik ’m meteen.");
      return;
    }

    // Normal message -> OpenAI
    tgSendChatAction(chatId, "typing").catch(() => {});
    const reply = await openaiRespond({ chatId, userText: text });
    await tgSendMessage(chatId, reply || "…");
  } catch (e) {
    console.error("Webhook error:", e);
  }
});

/* =================== HEALTH + METRICS =================== */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/metrics", (req, res) => {
  const token = req.headers["x-metrics-token"] || req.query.token || "";
  if (!METRICS_TOKEN || String(token) !== String(METRICS_TOKEN)) {
    return res.status(401).json({ ok: false });
  }
  const uptimeSec = Math.floor((Date.now() - metrics.startedAt) / 1000);
  res.json({
    ok: true,
    uptimeSec,
    uniqueUsers: metrics.uniqueUsers.size,
    active24h: countActiveUsersSince(24 * 60 * 60 * 1000),
    active7d: countActiveUsersSince(7 * 24 * 60 * 60 * 1000),
    totalUpdates: metrics.totalUpdates,
    totalMessages: metrics.totalMessages,
    starts: metrics.starts,
    menus: metrics.menus,
  });
});

app.get("/", (_req, res) => res.send("Nouvelle Telegram Bot is running ✨"));

/* =================== START + auto setWebhook (optional) =================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Nouvelle Telegram Bot running on :${PORT}`);

  // Auto set webhook (optioneel maar super handig)
  if (PUBLIC_URL) {
    const hookUrl = `${PUBLIC_URL}/telegram/${WEBHOOK_SECRET}`;
    const r = await tgApi("setWebhook", {
      url: hookUrl,
      drop_pending_updates: true,
    });
    console.log("setWebhook:", r?.ok ? "OK" : r);
    console.log("Webhook URL:", hookUrl);
  } else {
    console.log("PUBLIC_URL not set — set webhook via Telegram setWebhook of zet PUBLIC_URL in Render.");
  }
});
