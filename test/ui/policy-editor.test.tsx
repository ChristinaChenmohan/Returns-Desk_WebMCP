import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { PolicyActivation, PolicyEditor } from "../../src/components/PolicyEditor";
import type { PolicyVersion } from "../../src/api/models";
const api = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("../../src/app/providers", () => ({ useApi: () => api }));
const policy = { id: "p1", status: "active", name: "Original", version: 1, versionNumber: 1, rules: [] } as unknown as PolicyVersion;
it("does not allow editing an active policy", () => { render(<QueryClientProvider client={new QueryClient()}><PolicyEditor policy={policy} onClose={vi.fn()}/></QueryClientProvider>); expect(screen.getByRole("alert")).toHaveTextContent("immutable"); expect(screen.queryByText("Save draft")).toBeNull(); });
it("gates activation on server validation and shows conflicts", async () => {
  api.write.mockResolvedValue({ valid: false, conflicts: [{ field: "returnRequired", ruleIds: ["a", "b"] }] });
  render(<QueryClientProvider client={new QueryClient()}><PolicyActivation policy={{ ...policy, status: "draft" }} onClose={vi.fn()}/></QueryClientProvider>);
  expect(screen.getByText("Confirm activation")).toBeDisabled(); fireEvent.click(screen.getByText("Validate saved draft"));
  expect(await screen.findByText("returnRequired: a, b")).toBeVisible(); expect(screen.getByText("Confirm activation")).toBeDisabled();
});
