export default function handler(req, res) {
  res.status(200).json({
    hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
    hasSlite: Boolean(process.env.SLITE_API_KEY),
    vercelEnv: process.env.VERCEL_ENV || null
  });
}
