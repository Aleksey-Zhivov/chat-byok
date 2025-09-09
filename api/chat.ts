export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(req.headers.get("Origin")) });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const origin = req.headers.get("Origin") || "*";
  const { model = "gpt-4o-mini", messages, input, system } = await req.json().catch(() => ({}));

  // Поддерживаем формат Responses API
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
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY!}`,
    },
    body: JSON.stringify(body),
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      ...corsHeaders(origin),
    },
  });
}

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
