import type { ReactNode } from "react";
export function AsyncRegion<T>({ query, children }: { query: { data: T | undefined; isPending: boolean; isError: boolean; refetch: () => unknown }; children: (data: T) => ReactNode }) {
  if (query.isPending) return <p role="status" className="empty">Loading workspace…</p>;
  if (query.isError || query.data === undefined) return <div role="alert" className="empty">This section could not be loaded. <button onClick={() => query.refetch()}>Retry</button></div>;
  return <>{children(query.data)}</>;
}
