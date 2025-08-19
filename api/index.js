import OpenAI from "openai";

const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SLITE_BASE = "https://api.slite.com";

// --- Slite helpers ---
async function sliteSearch(query, hits = 3) {
  const r = await fetch(`${SLITE_BASE}/v1/notes.search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLITE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, hitsPerPage: hits })
  });
  if (!r.ok) throw new Error(`Slite search ${r.status}`);
  return r.json();
}

async function sliteGet(noteId) {
  const r = await fetch(`${SLITE_BASE}/v1/notes.get`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLITE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ noteId })
  });
  if (!r.ok) throw new Error(`Slite get ${r.status}`);
  return r.json();
}

// Slack sends application/x-www-form-urlencoded by default
function parseSlashBody(req) {
  const raw =
    typeof req.body === "string" ? req.body :
    (req.body && typeof req.body === "object" ? new URLSearchParams(req.body).toString() : "") ||
    "";
  const params = new URLSearchParams(raw);
  const text = params.get("text") || (req.body && req.body.text) || "";
  const response_url = params.get("response_url") || (req.body && req.body.response_url);
  return { text: (text || "").trim(), response_url };
}

// Vercel serverless handler
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Use POST");

  const { text, response_url } = parseSlashBody(req);

  // Acknowledge immediately so Slack doesn't timeout
  res.status(200).send("");

  if (!response_url) {
    // fallback for manual tests
    return;
  }

  if (!text) {
    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Usage: `/ask your question`" })
    });
    return;
  }

  try {
    // 1) Search Slite
    const search = await sliteSearch(text, 3);
    const hits = search?.hits ?? [];

    // Simple generic query rule
    const generic = /(how to work a lead|lead process|work a lead)/i.test(text);
    if (hits.length === 0 || generic) {
      await fetch(response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "There isn’t a document with that information directly. Can you be more specific so I can find what you need?"
        })
      });
      return;
    }

    // 2) Fetch the top doc and trim
    const first = await sliteGet(hits[0].noteId);
    const md = first?.note?.content?.markdown || first?.note?.content?.text || "";
    const excerpt = md.slice(0, 4000);

    // 3) Ask OpenAI with strict grounding
    const system = `
You are an internal assistant.
Answer ONLY using the provided Slite excerpt.
If the answer is not present, reply exactly:
"There isn’t a document with that information directly. Can you be more specific so I can find what you need?"
Do NOT use web or outside knowledge. Be concise. Temperature=0.
`;

    const completion = await oai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Question: ${text}\n\nExcerpt from Slite:\n${excerpt}` }
      ]
    });

    const out =
      completion.choices?.[0]?.message?.content?.trim() ||
      "There isn’t a document with that information directly. Can you be more specific so I can find what you need?";

    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: out })
    });
  } catch (err) {
    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `❌ Error: ${err.message || err}` })
    });
  }
}
