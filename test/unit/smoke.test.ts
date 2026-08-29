import { describe, expect, it } from "vitest";
import worker from "../../worker/index";

describe("worker", () => {
  it("returns the API health envelope", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/api/v1/health"),
      {} as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { status: "ok" },
    });
  });
});
