// Notify the Hermes write_in core that an AMS write completed so it can leave
// a portal_write_log / queue audit row. Best-effort: AMS success must not roll
// back if Hermes is down.

export async function notifyHermesAmsWrite(client, payload) {
  if (!client || typeof client.recordAmsWrite !== "function") {
    return { ok: false, skipped: true, reason: "no_hermes_client" };
  }
  try {
    const result = await client.recordAmsWrite(payload);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, skipped: false, reason: error?.message ?? String(error) };
  }
}
