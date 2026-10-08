const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';
const SEND_TIMEOUT_MS = 30_000;

/** Sends one transactional email through Brevo's HTTP API. Throws on failure. */
export async function sendBrevoEmail({
  apiKey,
  from,
  to,
  subject,
  text,
  html,
  fetchImpl = fetch,
  timeoutMs = SEND_TIMEOUT_MS,
}) {
  const response = await fetchImpl(BREVO_SEND_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { email: from.email, name: from.name },
      to: to.map((email) => ({ email })),
      subject,
      htmlContent: html,
      textContent: text,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Brevo answers JSON; an empty body still means the status decides.
  }
  if (!response.ok) {
    const detail = [body?.code, body?.message].filter(Boolean).join(': ').slice(0, 200);
    throw new Error(`Brevo ${response.status}${detail ? ` (${detail})` : ''}`);
  }
  return { messageId: body?.messageId ?? null };
}
