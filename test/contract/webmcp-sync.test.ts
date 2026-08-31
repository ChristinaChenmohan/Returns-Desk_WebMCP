import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { syncEffects } from "../../src/webmcp/sync-effects";
import type { Workspace } from "../../src/api/models";
const facts = (version: number) => ({ caseId: "c1", version }) as Workspace;
it("refetches until the server reaches the effect version and never regresses cached versions", async () => {
  const query = new QueryClient(); const fetch = vi.fn().mockResolvedValueOnce(facts(1)).mockResolvedValueOnce(facts(3));
  expect(await syncEffects([{ entityType: "return_case", entityId: "c1", entityVersion: 3 }], query, fetch)).toBe("synchronized");
  expect(fetch).toHaveBeenCalledTimes(2); expect(query.getQueryData(["case", "c1"])).toEqual(facts(3));
  query.setQueryData(["case", "c1"], facts(5)); await syncEffects([{ entityType: "return_case", entityId: "c1", entityVersion: 3 }], query, async () => facts(3));
  expect(query.getQueryData(["case", "c1"])).toEqual(facts(5));
});
it("reports refresh_required after bounded stale reads or fetch failure", async () => {
  const fetch = vi.fn().mockResolvedValue(facts(1)), query = new QueryClient();
  expect(await syncEffects([{ entityType: "return_case", entityId: "c1", entityVersion: 2 }], query, fetch)).toBe("refresh_required"); expect(fetch).toHaveBeenCalledTimes(3);
  expect(await syncEffects([{ entityType: "return_case", entityId: "c1", entityVersion: 2 }], query, async () => { throw new Error(); })).toBe("refresh_required");
});
