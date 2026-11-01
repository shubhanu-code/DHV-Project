const configuredBase = import.meta.env.VITE_API_BASE_URL;
const API_BASE = (configuredBase || "/api").replace(/\/+$/, "");
const configuredChatBase = import.meta.env.VITE_CHAT_API_BASE_URL;
const CHAT_API_BASE = (configuredChatBase || "/chat-api").replace(/\/+$/, "");
const TIMEOUT_MS = 30000;

async function request(path, options = {}, base = API_BASE) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const { body, headers, ...rest } = options;
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      ...rest,
      body,
      signal: controller.signal,
      // Only send a Content-Type when there is a body; a header on GET forces a CORS preflight.
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    });
  } catch (error) {
    const configuredApiBase = base === CHAT_API_BASE ? configuredChatBase : configuredBase;
    const where = configuredApiBase
      ? `the API at ${base}`
      : base === CHAT_API_BASE
        ? "the chatbot backend (expected on port 8000 in development)"
        : "the backend (expected on port 5000 in development)";
    throw new Error(error?.name === "AbortError" ? `The request to ${where} timed out.` : `Cannot reach ${where}. Check that the server is running.`);
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail || data?.error || `Request failed with status ${response.status}`);
  if (data === null) throw new Error("The server returned an unreadable response.");
  return data;
}

export function checkBackend() {
  return request("/health");
}

export function getRankings() {
  return request("/rankings");
}

export function getRankingMeta() {
  return request("/rankings/meta");
}

export function askBackend(question) {
  return request("/api/chat", { method: "POST", body: JSON.stringify({ question }) }, CHAT_API_BASE);
}
