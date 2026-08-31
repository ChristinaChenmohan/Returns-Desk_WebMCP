import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ApiClient } from "../api/client";
import { makeQueryClient } from "./query-client";
import { useReturnsDeskTools } from "../webmcp/useReturnsDeskTools";
const ApiContext = createContext<ApiClient | null>(null);
export function useApi() { const api = useContext(ApiContext); if (!api) throw new Error("Missing application provider"); return api; }
export function Providers({ children }: { children: ReactNode }) {
  const [api] = useState(() => new ApiClient()); const [query] = useState(makeQueryClient);
  const [ready, setReady] = useState(false); const [error, setError] = useState("");
  useReturnsDeskTools(ready, query, api);
  useEffect(() => { void api.bootstrap().then(() => setReady(true)).catch(() => setError("Could not start your demo session. Please reload.")); }, [api]);
  if (!ready) return <main className="startup" role="status"><h1>Returns Desk</h1><p>{error || "Preparing your private demo workspace…"}</p>{error && <button onClick={() => location.reload()}>Reload</button>}</main>;
  return <ApiContext.Provider value={api}><QueryClientProvider client={query}>{children}</QueryClientProvider></ApiContext.Provider>;
}
