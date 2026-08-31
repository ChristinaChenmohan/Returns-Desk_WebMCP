import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { ApiClient } from "../api/client";
import type { Workspace } from "../api/models";
import { registerReturnsDeskTools } from "./registry";
import { syncEffects } from "./sync-effects";
export function useReturnsDeskTools(ready: boolean, query: QueryClient, human: ApiClient) {
  useEffect(() => {
    if (!ready) return;
    let cleanup = () => undefined as void;
    const register = () => {
      cleanup();
      const agent = new ApiClient("agent");
      cleanup = registerReturnsDeskTools({ agentClient: agent, sync: effects => syncEffects(effects, query, id => human.get<Workspace>(`/cases/${id}`)), diagnostics: code => console.warn(`WebMCP: ${code}`) });
    };
    register(); window.addEventListener("returns-session-reset", register);
    return () => { window.removeEventListener("returns-session-reset", register); cleanup(); };
  }, [ready, query, human]);
}
