import { useEffect, useMemo, useRef, useState } from "react";

const LS_HISTORY_KEY = "chat_history_v1";
const LS_MODEL_KEY = "chat_model_v1";

// SSE decoder под /api/chat (проксирует /v1/responses)
function decodeSSEChunk(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) return null;
      const json = line.slice(6);
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
  // История: [{role:'user'|'assistant', text:string}]
  const [messages, setMessages] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_HISTORY_KEY));
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });

  const [model, setModel] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_MODEL_KEY)) || "gpt-4o-mini";
    } catch {
      return "gpt-4o-mini";
    }
  });

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const chatRef = useRef(null);
  const abortRef = useRef(null);

  // автоскролл + сохранение истории
  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight });
    localStorage.setItem(LS_HISTORY_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(LS_MODEL_KEY, JSON.stringify(model));
  }, [model]);

  const canSend = useMemo(
    () => !loading && input.trim().length > 0,
    [loading, input]
  );

  const push = (role, text) =>
    setMessages((m) => [...m, { role, text: String(text ?? "") }]);

  const patchLastAssistant = (text) =>
    setMessages((m) => {
      const arr = [...m];
      const idx = arr.map((x) => x.role).lastIndexOf("assistant");
      if (idx === -1) return [...arr, { role: "assistant", text }];
      arr[idx] = { role: "assistant", text };
      return arr;
    });

  async function send() {
    if (!input.trim() || loading) return;

    // 1) добавляем сообщение пользователя в историю UI
    const userText = input.trim();
    setInput("");
    push("user", userText);
    // placeholder для стриминга
    push("assistant", "");
    setLoading(true);

    // 2) собираем историю для бэка (messages → format для Responses API)
    // отправляем *всю* историю + последнее сообщение
    const history = [
      { role: "system", content: "You are a helpful assistant." },
      ...messages.map((m) => ({ role: m.role, content: m.text })),
      { role: "user", content: userText },
    ];

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          // наш сервер поддерживает либо messages, либо input; здесь — messages
          messages: history,
        }),
        signal: controller.signal,
      });

      // 1) Если сервер вернул JSON (ошибка), покажем её и выходим
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        try {
          const j = JSON.parse(txt);
          const msg = j?.error?.message || txt || resp.statusText;
          patchLastAssistant(""); // очистим плейсхолдер
          push("system", `Ошибка API: ${msg}`);
        } catch {
          patchLastAssistant("");
          push("system", `HTTP ${resp.status}: ${txt || resp.statusText}`);
        }
        return;
      }
      if (!resp.body) {
        patchLastAssistant("");
        push("system", `Пустой ответ от сервера.`);
        return;
      }

      if (!resp.ok || !resp.body) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${txt || resp.statusText}`);
      }

      // 3) стримим
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

            // 2) Событие ошибки внутри SSE
            if (d?.type === "error" && d?.error) {
              const msg =
                d.error?.message ||
                d.error?.code ||
                d.error?.type ||
                "Неизвестная ошибка";
              patchLastAssistant("");
              push("system", `Ошибка API: ${msg}`);
              continue;
            }

            // Responses API часто кладёт агрегированный текст в output_text
            if (d?.output_text) {
              patchLastAssistant(d.output_text);
            } else if (Array.isArray(d?.output)) {
              // запасной путь — собрать из блоков
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

  function clearHistory() {
    setMessages([]);
    localStorage.removeItem(LS_HISTORY_KEY);
  }

  return (
    <div className="container">
      <h1>Chat</h1>

      <div className="card">
        <div className="row">
          <div>
            <label>Модель</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
            />
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
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSend) {
                send();
              }
            }}
          />
        </div>

        <div className="buttons-row">
          <button className="primary" onClick={send} disabled={!canSend}>
            {loading ? "Генерация…" : "Отправить"}
          </button>
          <button className="ghost" onClick={clearHistory}>
            Очистить
          </button>
          <button className="ghost" onClick={stop} disabled={!loading}>
            Стоп
          </button>
        </div>

        <div className="muted" style={{ marginTop: 6 }}>
          История хранится локально в браузере и отправляется на сервер как
          контекст.
        </div>
      </div>
    </div>
  );
}
