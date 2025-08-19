import OpenAI from "openai"; // keep installed for later; not used in this minimal sync reply

const SLITE_BASE = "https://api.slite.com";

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

// Parse Slack's x-www-form-urlencoded
function parseSlashBody(req) {
  const raw =
    typeof req.body === "string" ? req.body :
    (req.body && typeof req.body === "object" ? new URLSearchParams(req.body).toString() : "") ||
    "";
  const params = new URLSearchParams(raw);
  const text = params.get("text") || (req.body && req.body.text) || "";
  return { text: (text || "").trim() };
}

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

    // Catch broad/vague asks up front
    const generic = /\b(how to work a lead|lead process|work a lead|buyer lead|seller lead)\b/i.test(text);
    if (generic) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: "There isn’t a document with that information directly. Can you be more specific so I can find what you need? (e.g., *LSA Message*, *Google PPC buyer*, *Open House sign-in*)"
      });
    }

    // Quick Slite lookup (fast and synchronous)
    const search = await sliteSearch(text, 3);
    const hits = search?.hits ?? [];

    if (!hits.length) {
      return res.status(200).json({
        response_type: "ephemeral",
        text: "There isn’t a document with that information directly. Can you be more specific so I can find what you need?"
      });
    }

    // Fetch the top doc's title + a short excerpt (no LLM, super fast)
    const top = await sliteGet(hits[0].noteId);
    const title = top?.note?.title || "Document";
    const md = top?.note?.content?.markdown || top?.note?.content?.text || "";
    const snippet = (md || "").replace(/\s+/g, " ").slice(0, 280);

    // If you have public Share URLs, you can append them here.
    // Otherwise we just show the title/snippet. Slack user clicks through in Slite.

    return res.status(200).json({
      response_type: "ephemeral",
      text: `*Top match:* ${title}\n${snippet ? `> ${snippet}…` : ""}\n\nIf this isn’t it, tell me the specific lead source (e.g., *LSA Message*, *Google PPC buyer*, *Zillow/Flex*).`
    });

  } catch (err) {
    return res.status(200).json({
      response_type: "ephemeral",
      text: `❌ Error: ${err.message || String(err)}`
    });
  }
}
