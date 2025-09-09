export default async function handler(req: any, res: any) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const { model = "gpt-4o-mini", input, messages, system } = req.body || {};

    const body = input
      ? { model, input, stream: true }
      : {
          model,
          input: [
            ...(system ? [{ role: "system", content: system }] : []),
            ...(Array.isArray(messages) ? messages : []),
          ],
          stream: true,
        };

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    // Пробрасываем поток SSE
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    if (!upstream.body) {
      const txt = await upstream.text().catch(() => "");
      return res.status(upstream.status).end(txt || upstream.statusText);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();
  } catch (e: any) {
    res.status(500).end(String(e?.message || e));
  }
}
