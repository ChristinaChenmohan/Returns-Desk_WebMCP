import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { useApi } from "../app/providers";
import type { SessionAuth } from "../api/client";
import { ConfirmDialog } from "./ConfirmDialog";
import { useCommand } from "./useCommand";
export function ResetDemoDialog({ onClose }: { onClose: () => void }) {
  const api = useApi(), query = useQueryClient(), navigate = useNavigate();
  const [step, setStep] = useState(1), [confirmation, setConfirmation] = useState("");
  const command = useCommand(onClose);
  return <ConfirmDialog title="Reset this demo session" onClose={() => { if (!command.busy) onClose(); }}>
    <p>Erase this session’s cases, approvals and simulated records. Other visitors are unaffected.</p>
    {step === 1 ? <button onClick={() => setStep(2)}>Continue to confirmation</button> : <form onSubmit={async e => { e.preventDefault(); if (confirmation !== "RESET") return; const payload = { confirmation: "reset_current_demo_session" }; await command.run(payload, async key => { const auth = await api.write<SessionAuth>("/session/reset", payload, key); api.setAuth(auth); query.clear(); navigate("/"); window.dispatchEvent(new Event("returns-session-reset")); }); }}>
      <label>Type RESET to confirm<input autoFocus value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off"/></label>
      {command.error && <p role="alert" className="error">{command.error}</p>}
      <button className="primary" disabled={confirmation !== "RESET" || command.busy || command.stale}>Reset my demo</button>
    </form>}
  </ConfirmDialog>;
}
