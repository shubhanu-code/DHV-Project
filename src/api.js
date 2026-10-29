const configuredBase = import.meta.env.VITE_API_BASE_URL;
const API_BASE = (configuredBase || "/api").replace(/\/+$/, "");
const TIMEOUT_MS = 30000;

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const { body, headers, ...rest } = options;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...rest,
      body,
      signal: controller.signal,
      // Only send a Content-Type when there is a body; a header on GET forces a CORS preflight.
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    });
  } catch (error) {
    const where = configuredBase ? `the API at ${API_BASE}` : "the backend (expected on port 5000 in development)";
    throw new Error(error?.name === "AbortError" ? `The request to ${where} timed out.` : `Cannot reach ${where}. Check that the server is running.`);
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed with status ${response.status}`);
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

export function askBackend(query, context) {
  return request("/copilot", { method: "POST", body: JSON.stringify({ query, context }) });
}
