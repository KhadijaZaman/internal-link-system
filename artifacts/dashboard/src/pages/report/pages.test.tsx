// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import PageReport from "./pages";
import { useGetPagesReport } from "@workspace/api-client-react";

vi.mock("@workspace/api-client-react", () => ({
  useGetPagesReport: vi.fn(() => ({
    data: {
      rows: [],
      totals: {
        impressions: 0,
        clicks: 0,
        position: 0,
        sessions: 0,
        engagementRate: 0,
      },
      ga4Notice: null,
    },
    isLoading: false,
    error: null,
  })),
}));

function renderPage() {
  return render(
    <TooltipProvider>
      <PageReport />
    </TooltipProvider>,
  );
}

function expectVisibleRange(startDate: string, endDate: string) {
  expect(screen.getByText(`${startDate} → ${endDate}`)).toBeTruthy();
}

describe("PageReport date window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
    vi.mocked(useGetPagesReport).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("sends a selected preset window to the report query and keeps it visible", () => {
    renderPage();

    expect(useGetPagesReport).toHaveBeenLastCalledWith({
      startDate: "2026-07-22",
      endDate: "2026-08-18",
      channel: "organic",
    });
    expectVisibleRange("2026-07-22", "2026-08-18");

    fireEvent.click(screen.getByRole("button", { name: "3 months" }));

    expect(useGetPagesReport).toHaveBeenLastCalledWith({
      startDate: "2026-05-21",
      endDate: "2026-08-18",
      channel: "organic",
    });
    expectVisibleRange("2026-05-21", "2026-08-18");

    fireEvent.click(screen.getByRole("button", { name: "6 months" }));

    expect(useGetPagesReport).toHaveBeenLastCalledWith({
      startDate: "2026-02-20",
      endDate: "2026-08-18",
      channel: "organic",
    });
    expectVisibleRange("2026-02-20", "2026-08-18");
  });

  it("sends a custom window to the report query and shows the same dates in the controls", () => {
    const { container } = renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    const [startInput, endInput] = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="date"]'),
    );
    fireEvent.change(startInput, { target: { value: "2026-01-10" } });
    fireEvent.change(endInput, { target: { value: "2026-02-20" } });

    expect(useGetPagesReport).toHaveBeenLastCalledWith({
      startDate: "2026-01-10",
      endDate: "2026-02-20",
      channel: "organic",
    });
    expect(startInput.value).toBe("2026-01-10");
    expect(endInput.value).toBe("2026-02-20");
    expectVisibleRange("2026-01-10", "2026-02-20");
  });
});