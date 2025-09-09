import { useEffect, useRef, useState } from "react";

function decodeSSEChunk(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) return null;
      const json = dataLine.slice(6);
      if (json === "[DONE]") return { done: true };
      try {
        return { data: JSON.parse(json) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export default function App() {
  const [apiKey, setApiKey] = useState(
    localStorage.getItem("openai_api_key") || ""
  );
  const [remember, setRemember] = useState(true);
  const [model, setModel] = useState("gpt-4o-mini");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
  }, [messages]);

  const push = (role, text) => setMessages((m) => [...m, { role, text }]);
  const patchLastAssistant = (text) =>
    setMessages((m) => {
      const last = [...m];
      const idx = last.map((x) => x.role).lastIndexOf("assistant");
      if (idx === -1) return [...m, { role: "assistant", text }];
      last[idx] = { role: "assistant", text };
      return last;
    });

  async function send() {
    if (!apiKey.trim()) {
      alert("Введите OpenAI API key (sk-...)");
      return;
    }
    if (!input.trim()) return;

    remember
      ? localStorage.setItem("openai_api_key", apiKey.trim())
      : localStorage.removeItem("openai_api_key");

    const userText = input.trim();
    setInput("");
    push("user", userText);
    push("assistant", "");
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: userText },
          ],
        }),
      });

      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${t || resp.statusText}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const cut = buffer.lastIndexOf("\n\n");
        if (cut !== -1) {
          const chunk = buffer.slice(0, cut + 2);
          buffer = buffer.slice(cut + 2);
          const events = decodeSSEChunk(chunk);

          for (const ev of events) {
            if (ev.done) continue;
            const d = ev.data;
            if (d?.output_text) {
              patchLastAssistant(d.output_text);
            } else if (Array.isArray(d?.output)) {
              const pieces = [];
              for (const item of d.output) {
                if (Array.isArray(item?.content)) {
                  for (const c of item.content) {
                    if (
                      c.type === "output_text" &&
                      typeof c.text === "string"
                    ) {
                      pieces.push(c.text);
                    }
                  }
                }
              }
              if (pieces.length) patchLastAssistant(pieces.join(""));
            }
          }
        }
      }
    } catch (e) {
      push("system", `Ошибка: ${e?.message || String(e)}`);
      console.error(e);
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="container">
      <h1>Chat (BYOK)</h1>

      <div className="card">
        <div className="row">
          <div style={{ flex: "2 1 360px" }}>
            <label>OpenAI API Key</label>
            <input
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <div style={{ marginTop: 6 }}>
              <label>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />{" "}
                сохранять ключ в localStorage
              </label>
            </div>
          </div>
          <div>
            <label>Модель</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} />
            <div className="muted">например: gpt-4o-mini</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div ref={chatRef} className="msgs">
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.text}
            </div>
          ))}
        </div>
        <div className="input-row">
          <textarea
            value={input}
            placeholder="Напишите сообщение и нажмите Отправить…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
            }}
          />
        </div>
        <div className="buttons-row">
          <button
            className="primary"
            onClick={send}
            disabled={loading || !apiKey.trim() || !input.trim()}
          >
            {loading ? "Генерация…" : "Отправить"}
          </button>
          <button className="ghost" onClick={() => setMessages([])}>
            Очистить
          </button>
          <button className="ghost" onClick={stop} disabled={!loading}>
            Стоп
          </button>
        </div>
      </div>
    </div>
  );
}
