import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CaseActions, CaseActionDialog } from "../../src/components/CaseActions";
import { ResetDemoDialog } from "../../src/components/ResetDemoDialog";
import { ApiError } from "../../src/api/errors";
import type { Workspace } from "../../src/api/models";
const api = vi.hoisted(() => ({ write: vi.fn(), setAuth: vi.fn() }));
vi.mock("../../src/app/providers", () => ({ useApi: () => api }));
const data = { caseId: "case1", version: 2, completion: null, order: { items: [] }, latestEligibility: { status: "eligible", proposalSubmissionAllowed: true, eligibilityCheckId: "check1", allowedResolutions: [{ type: "refund", amountCents: 2500, currency: "USD", returnRequired: true }] }, proposal: { proposalId: "prop1", status: "pending", version: 3, resolutionType: "refund", amountCents: 2500, currency: "USD", requestedQuantity: 1, returnRequired: true, replacementVariantId: null, customerMessage: { subject: "Refund review", bodyText: "Your refund request is ready for review.", locale: "en-US" } } } as unknown as Workspace;
function mount(element: React.ReactNode) { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>); }
describe("explicit human commands", () => {
  it("requires confirmation, shows effects and sends the exact approval enum", async () => {
    api.write.mockResolvedValueOnce({}); const close = vi.fn();
    mount(<CaseActionDialog action="approve" data={data} changed={false} onClose={close}/>);
    const approve = screen.getByRole("button", { name: "Approve and simulate completion" });
    expect(approve).toBeDisabled(); expect(screen.getByText("$25.00")).toBeVisible(); expect(screen.getByText(/Simulated effects:/)).toHaveTextContent("return label");
    fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(approve);
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(api.write).toHaveBeenLastCalledWith("/rma-proposals/prop1/approve", { expectedVersion: 3, confirmation: "approve_and_simulate_completion" }, expect.any(String));
  });
  it("retains the replacement diff after conflict and disables unsafe resubmission", async () => {
    api.write.mockRejectedValueOnce(new ApiError("ENTITY_VERSION_CONFLICT", 409, "Changed", false, "reload_case"));
    mount(<CaseActionDialog action="replace" data={data} changed={false} onClose={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText("Message subject"), { target: { value: "Corrected subject" } });
    expect(screen.getByText(/Before: refund/)).toHaveTextContent("Refund review");
    fireEvent.click(screen.getByRole("button", { name: "Replace proposal" }));
    await screen.findByText(/ENTITY_VERSION_CONFLICT/);
    expect(screen.getByLabelText("Message subject")).toHaveValue("Corrected subject");
    expect(screen.getByRole("button", { name: "Replace proposal" })).toBeDisabled();
  });
  it("never offers proposal submission for needs_review or approval for a terminal proposal", () => {
    mount(<CaseActions data={{ ...data, proposal: { ...data.proposal!, status: "rejected" }, latestEligibility: { ...data.latestEligibility!, status: "needs_review", proposalSubmissionAllowed: false } }}/>);
    expect(screen.queryByText("Prepare proposal")).toBeNull(); expect(screen.queryByText("Review & approve")).toBeNull(); expect(screen.getByText("Review eligibility")).toBeVisible();
  });
  it("requires two steps and the exact typed reset confirmation", async () => {
    api.write.mockResolvedValueOnce({ seedVersion: 2, csrfToken: "csrf", humanChannelToken: "human" });
    mount(<ResetDemoDialog onClose={vi.fn()}/>);
    expect(screen.queryByText("Reset my demo")).toBeNull(); fireEvent.click(screen.getByText("Continue to confirmation"));
    expect(screen.getByText("Reset my demo")).toBeDisabled(); fireEvent.change(screen.getByLabelText("Type RESET to confirm"), { target: { value: "RESET" } });
    fireEvent.click(screen.getByText("Reset my demo"));
    await waitFor(() => expect(api.setAuth).toHaveBeenCalledWith(expect.objectContaining({ seedVersion: 2 })));
  });
});

