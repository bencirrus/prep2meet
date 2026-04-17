/**
 * prep2meet — Vercel Serverless Function: GET /api/health
 */
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({ ok: true, service: "prep2meet" });
}
