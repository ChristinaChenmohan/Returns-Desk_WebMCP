import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { OrdersPage } from "../../src/pages/OrdersPage";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../src/app/providers", () => ({ useApi: () => api }));

it("uses a suggested order as the active search", async () => {
  api.get.mockResolvedValue({ orders: [], resultCount: 0, requiresSelection: false });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><OrdersPage /></MemoryRouter>
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Search ORD-1001" }));

  expect(screen.getByRole("searchbox", { name: "Search orders" })).toHaveValue("ORD-1001");
  expect(await screen.findByText(/0 matches/)).toBeVisible();
  expect(api.get).toHaveBeenCalledWith("/orders?query=ORD-1001");
});
