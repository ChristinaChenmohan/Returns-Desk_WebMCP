import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/errors";
// A retry of the same payload keeps its key; editing creates a new logical command.
export function useCommand(onDone: () => void) {
  const query = useQueryClient(); const command = useRef({ payload: "", key: crypto.randomUUID() });
  const [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [error, setError] = useState("");
  async function run(payload: unknown, execute: (key: string) => Promise<unknown>) {
    if (busy || stale) return;
    const serialized = JSON.stringify(payload);
    if (command.current.payload && serialized !== command.current.payload) command.current.key = crypto.randomUUID();
    command.current.payload = serialized; setBusy(true); setError("");
    try { await execute(command.current.key); await query.invalidateQueries(); onDone(); }
    catch (error) {
      setError(error instanceof ApiError ? `${error.code}: ${error.recoveryAction ?? error.message}` : "Request failed. Retry with the same input to safely recover.");
      if (error instanceof ApiError && [401, 403, 409].includes(error.status)) { setStale(true); void query.invalidateQueries(); }
    } finally { setBusy(false); }
  }
  return { run, busy, stale, error };
}
