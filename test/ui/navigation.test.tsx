import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { AppShell } from "../../src/components/AppShell";
vi.mock("../../src/app/providers", () => ({ useApi: () => ({ seedVersion: 1 }) }));
it("provides the four named navigation destinations and a keyboard skip link", () => {
  render(<MemoryRouter><AppShell/></MemoryRouter>);
  for (const name of ["Dashboard", "Orders", "Approval Queue", "Policies", "Skip to content"]) expect(screen.getByRole("link", { name })).toBeVisible();
  expect(screen.getByText(/No real payments/)).toBeVisible();
});
