// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { classifyBrokenAction } from "./semantic-links";

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetAuditReport: vi.fn(() => ({
      data: {
        type: "broken_links",
        runAt: "2026-09-01T12:00:00.000Z",
        itemCount: 0,
        items: [
          {
            url: "https://example.com/about",
            status: 301,
            classification: "canonical_redirect",
            redirectTo: "https://example.com/about/",
            inboundCount: 1,
            linkingPages: [
              {
                sourceUrl: "https://example.com/home",
                anchorText: "About",
                title: "Home",
              },
            ],
          },
        ],
      },
      isLoading: false,
      isError: false,
    })),
    useRunJob: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { BrokenLinksTab } from "./semantic-links";

afterEach(() => {
  vi.clearAllMocks();
});

describe("broken-link action classification", () => {
  const base = { url: "https://example.com/page", inboundCount: 1 };

  it("keeps canonical slash redirects separate from broken links", () => {
    expect(
      classifyBrokenAction({
        ...base,
        status: 301,
        redirectTo: "https://example.com/page/",
        classification: "canonical_redirect",
      }),
    ).toBe("canonical");
  });

  it("keeps other redirects actionable as repoints", () => {
    expect(
      classifyBrokenAction({
        ...base,
        status: 301,
        redirectTo: "https://example.com/new-page",
        classification: "redirect",
      }),
    ).toBe("repoint");
  });

  it.each([404, 500, null])("keeps status %s in the broken category", (status) => {
    expect(
      classifyBrokenAction({
        ...base,
        status,
        classification: "broken",
      }),
    ).toBe("dead");
  });
});

describe("canonical redirect row", () => {
  it("renders informational guidance without telling the operator to edit the link", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(BrokenLinksTab),
        ),
      ),
    );

    expect(screen.getByText(/No action is required/)).toBeTruthy();
    expect(screen.getByText("→ canonical URL")).toBeTruthy();
    expect(screen.queryByText("→ repoint to")).toBeNull();
    expect(screen.getByText(/1 page reference this URL/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show referencing pages" }));

    expect(screen.getByText(/Referenced on 1 page/)).toBeTruthy();
    expect(screen.getByText(/no action required/)).toBeTruthy();
    expect(screen.queryByText(/Edit the link on/)).toBeNull();
    expect(screen.queryByText(/point it at the final URL/)).toBeNull();
  });
});