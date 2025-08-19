// api/index.js
// Slack slash-command endpoint for: /ask ...
// Behavior:
// - Searches Slite for matching docs
// - If vague or no hits: uses OpenAI ONLY to write a short clarifying message (no answers)
// - If a hit exists: returns the top doc title + snippet (no LLM)
// Ephemeral replies only (visible to the user who ran the command)

// ==== Env Vars (set these in Vercel → Project → Settings → Environment Variables) ====
// OPENAI_API_KEY   -> your OpenAI key (starts with sk-)
// SLITE_API_KEY    -> your Slite API key

import OpenAI from "openai";
const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SLITE_BASE = "https://api.slite.com";

// ----- Slite helpers (current endpoints) -----

// GET /v1/search-notes?query=...&hitsPerPage=3
async function sliteSearch(query, hits = 3) {
  const url = new URL(`${SLITE_BASE}/v1/search-notes`);
  url.searchParams.set("query", query);
  url.searchParams.set("hitsPerPage", String(hits));
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.SLITE_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!r.ok) throw new Error(`Slite search ${r.status}`);
  return r.json();
}

// GET /v1/notes/{noteId}
async function sliteGet(noteId) {
  const r = await fetch(`${SLITE_BASE}/v1/notes/${noteId}`, {
    headers: {
      Authorization: `Bearer ${process.env.SLITE_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!r.ok) throw new Error(`Slite get ${r.status}`);
  return r.json();
}

// ----- OpenAI helper: write a clarifying message ONLY (no answers) -----
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

async function clarifyingMessage(userQuery) {
  try {
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
    return completion.choices?.[0]?.message?.content?.trim();
  } catch (_) {
    // Fallback if OpenAI errors or key missing
    return `There isn’t a document with that information directly. Can you be more specific so I can find what you need?
• Google LSA – Message
• Google LSA – Call
• Google PPC – Website
• Meta Lead Form
• RealScout
• Open House / Sign Call
• Referral or Zillow/Flex`;
  }
}

// ----- Parse Slack x-www-form-urlencoded body -----
function parseSlashBody(req) {
  // Slack posts form-encoded; on Vercel this may be a string or an object.
  let raw = "";
  if (typeof req.body === "string") raw = req.body;
  else if (req.body && typeof req.body === "object") {
    try { raw = new URLSearchParams(req.body).toString(); } catch { raw = ""; }
  }
  const params = new URLSearchParams(raw);
  const text = params.get("text") || (req.body && req.body.text) || "";
  return { text: (text || "").trim() };
}

// ----- Main handler -----
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

    // Gate obvious generic questions
    const generic = /\b(how to work a lead|lead process|work a lead|buyer lead|seller lead)\b/i.test(text);

    // Slite lookup (fast)
    const search = await sliteSearch(text, 3);
    const hits = search?.hits ?? [];

    // If vague or nothing found → ask for clarification (AI-written, no facts)
    if (generic || !hits.length) {
      const msg = await clarifyingMessage(text);
      return res.status(200).json({
        response_type: "ephemeral",
        text: msg
      });
    }

    // Fetch top doc and return a small snippet (no LLM to avoid hallucination)
    const top = await sliteGet(hits[0].noteId);
    const title = top?.note?.title || "Document";
    const md = top?.note?.content?.markdown || top?.note?.content?.text || "";
    const snippet = (md || "").replace(/\s+/g, " ").slice(0, 280);

    return res.status(200).json({
      response_type: "ephemeral",
      text: `*Top match:* ${title}\n${snippet ? `> ${snippet}…` : ""}\n\nIf this isn’t it, tell me the specific lead source (e.g., *Google LSA – Message*, *Google PPC – Website*, *Zillow/Flex*).`
    });

  } catch (err) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: `❌ Error: ${err.message || String(err)}`
    });
  }
}
