// Dashboard API client. All calls hit the real /v1 backend; no fake data.
let csrf = null;

export async function api(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const res = await fetch(`/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (!res.ok) {
    let code = "http_" + res.status;
    let msg = res.statusText;
    try {
      const b = await res.json();
      if (b?.error?.code) { code = b.error.code; msg = b.error.message; }
    } catch { /* ignore */ }
    const err = new Error(msg);
    err.code = code;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function login(username, password) {
  const out = await api("/auth/login", { method: "POST", body: { username, password } });
  csrf = out.csrf;
  return out;
}

export async function me() {
  const out = await api("/auth/me");
  csrf = out.csrf;
  return out;
}

export async function logout() {
  try { await api("/auth/logout", { method: "POST", body: {} }); } finally { csrf = null; }
}

export const getCsrf = () => csrf;
export const setCsrf = (c) => { csrf = c; };
