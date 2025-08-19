// api/index.js

import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const { text, response_url, user_name } = req.body;

  // STEP 1: Acknowledge immediately to Slack (avoid 3s timeout)
  res.status(200).json({
    response_type: "ephemeral",
    text: `⏳ Got it <@${user_name}>! I’m looking that up for you…`,
  });

  // STEP 2: Define the async logic that runs AFTER the ack
  try {
    // Build the prompt for OpenAI
    const prompt = `
You are a helpful assistant answering questions about our team's SOPs.
The user asked: "${text}"

Search the SOP knowledge base and return the most accurate, step-by-step answer.
If you do not find anything relevant, reply: 
"I'm sorry, I couldn’t find a specific SOP for that yet. Want me to flag it for review?"
    `;

    // Call OpenAI
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, // stored in Vercel env vars
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // fast + cheap, swap if you want
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await aiResponse.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || 
      "⚠️ Error: I wasn’t able to generate an answer.";

    // STEP 3: Send the final answer back to Slack
    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "in_channel", // or "ephemeral" if you want private replies
        text: `💡 *Answer for:* "${text}"\n\n${answer}`,
      }),
    });

  } catch (err) {
    console.error("Error in background task:", err);
    await fetch(response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        response_type: "ephemeral",
        text: "⚠️ Sorry, something went wrong while processing your request.",
      }),
    });
  }
}
