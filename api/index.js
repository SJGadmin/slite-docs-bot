// api/index.js
// Slack slash command: /ask ...
// - Responds within 3s (Slack limit) using timeouts + fallbacks
// - Searches Slite (tries modern + legacy endpoints)
// - If vague or no hits: uses OpenAI ONLY to write a short clarifying message (no answers, no web)
// - If hit: returns top doc title + snippet (no LLM)
// - All replies are ephemeral (only visible to the command author)

import OpenAI from "openai";

// ====== ENV VARS (set in Vercel → Project → Settings → Environment Variables) ======
// OPENAI_API_KEY   -> your OpenAI key (starts with sk-)
// SLITE_API_KEY    -> your Slite API key

const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SLITE_BASE = "https://api.slite.com";

// ---------- Utilities ----------
function parseSlashBody(req) {
  // Slack posts application/x-www-form-urlencoded
  let raw = "";
  if (typeof req.body === "string") raw = req.body;
  else if (req.body && typeof req.body === "object") {
    try { raw = new URLSearchParams(req.body).toString(); } catch { raw = ""; }
  }
  const params = new URLSearchParams(raw);
  const text = params.get("text") || (req.body && req.body.text) || "";
  return { text: (text || "").trim() };
}

async function fetchWithTimeout(url, options = {}, ms = 1500) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// ---------- Slite helpers (try modern then legacy; all fail -> []) ----------
async function sliteSearch(query, hits = 3, budgetMs = 1500) {
  // Try modern: GET /v1/search-notes
  try {
    const url = new URL(`${SLITE_BASE}/v1/search-notes`);
    url.searchParams.set("query", query);
    url.searchParams.set("hitsPerPage", String(hits));
    const r = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${process.env.SLITE_API_KEY}`,
        "Content-Type": "application/json",
      },
    }, budgetMs);
    if (r.ok) {
      const json = await r.json();
      return Array.isArray(json?.hits) ? json.hits : [];
    }
    if (r.status !== 404) {
      // Non-404 error: treat as no hits
      return [];
    }
  } catch {
    // timeout or network -> try legacy
  }

  // Try legacy: POST /v1/notes.search
  try {
    const r = await fetchWithTimeout(`${SLITE_BASE}/v1/notes.search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLITE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, hitsPerPage: hits }),
    }, budgetMs);
    if (r.ok) {
      const json = await r.json();
      return Array.isArray(json?.hits) ? json.hits : [];
    }
    // legacy error -> no hits
    return [];
  } catch {
    return [];
  }
}

async function sliteGet(noteId, budgetMs = 1500) {
  // Try modern: GET /v1/notes/{noteId}
  try {
    const r = await fetchWithTimeout(`${SLITE_BASE}/v1/notes/${noteId}`, {
      headers: {
        Authorization: `Bearer ${process.env.SLITE_API_KEY}`,
        "Content-Type": "application/json",
      },
    }, budgetMs);
    if (r.ok) return await r.json();
    if (r.status !== 404) return null;
  } catch {
    // continue to legacy
  }

  // Try legacy: POST /v1/notes.get
  try {
    const r = await fetchWithTimeout(`${SLITE_BASE}/v1/notes.get`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SLITE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ noteId }),
    }, budgetMs);
    if (r.ok) return await r.json();
    return null;
  } catch {
    return null;
  }
}

// ---------- OpenAI helper for clarifying-only message ----------
const LEAD_SOURCES = [
  "Google LSA – Call",
  "Google LSA – Message",
  "Google PPC – Website",
  "Meta Lead Form",
  "RealScout",
  "Open House",
  "Sign Call",
  "Referral",
  "Zillow/Flex",
  "Other"
];

async function clarifyingMessage(userQuery, budgetMs = 1500) {
  // Race against a timeout to ensure we answer Slack in time
  const timeout = new Promise((resolve) =>
    setTimeout(
      () =>
        resolve(
          `There isn’t a document with that information directly. Can you be more specific so I can find what you need?
• Google LSA – Message
• Google LSA – Call
• Google PPC – Website
• Meta Lead Form
• RealScout
• Open House / Sign Call
• Referral or Zillow/Flex`
        ),
      budgetMs
    )
  );

  const ask = (async () => {
    try {
      if (!process.env.OPENAI_API_KEY) throw new Error("no-openai-key");
      const system = `
You are a Slack assistant for a real estate team. Your ONLY job is to ask for clarification.
Do NOT provide answers, instructions, policies, or facts. Do NOT reference external knowledge or the web.
Write one brief line plus 4–7 bullet options drawn ONLY from the provided list.
If the user's query already matches one option, propose the next most useful disambiguator (e.g., buyer vs seller, first-contact vs follow-up).
Keep it under 80 words total. Tone: friendly, direct. Slack-friendly formatting. Output plain text only.
Options list to use: ${LEAD_SOURCES.join("; ")}.
`;
      const completion = await oai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 180,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `User query: "${userQuery}"` }
        ]
      });
      const out = completion.choices?.[0]?.message?.content?.trim();
      return out || `There isn’t a document with that information directly. Can you be more specific so I can find what you need?`;
    } catch {
      return `There isn’t a document with that information directly. Can you be more specific so I can find what you need?
• Google LSA – Message
• Google LSA – Call
• Google PPC – Website
• Meta Lead Form
• RealScout
• Open House / Sign Call
• Referral or Zillow/Flex`;
    }
  })();

  return Promise.race([ask, timeout]);
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Use POST");

  try {
    const { text } = parseSlashBody(req);

    if (!text) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: "Usage: `/ask your question`"
      });
    }

    // Catch broad/vague questions up front
    const generic = /\b(how to work a lead|lead process|work a lead|buyer lead|seller lead)\b/i.test(text);

    // Fast Slite lookup with time budget
    const hits = generic ? [] : await sliteSearch(text, 3, 1200);

    if (generic || !hits.length) {
      // Ask for clarification (OpenAI with tight timeout, fallback to static)
      const msg = await clarifyingMessage(text, 1400);
      return res.status(200).json({ response_type: "ephemeral", text: msg });
    }

    // Fetch top doc quickly
    const topRaw = await sliteGet(hits[0].noteId, 1200);
    const title = topRaw?.note?.title || "Document";
    const md = topRaw?.note?.content?.markdown || topRaw?.note?.content?.text || "";
    const snippet = (md || "").replace(/\s+/g, " ").slice(0, 280);

    return res.status(200).json({
      response_type: "ephemeral",
      text: `*Top match:* ${title}\n${snippet ? `> ${snippet}…` : ""}\n\nIf this isn’t it, tell me the specific lead source (e.g., *Google LSA – Message*, *Google PPC – Website*, *Zillow/Flex*).`
    });

  } catch (err) {
    // Never fail the Slack interaction—return a friendly error
    return res.status(200).json({
      response_type: "ephemeral",
      text: `❌ Error: ${err.message || String(err)}`
    });
  }
}
