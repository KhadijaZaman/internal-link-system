import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { appStateTable, db } from "@workspace/db";
import {
  claimOptimizationRoadmapBinding,
  withOptimizationRoadmapRefreshLock,
} from "./optimizationRoadmapSheet";

const SITE_A = 910_001;
const SITE_B = 910_002;
const keys = [
  `optimization_roadmap_sheet:${SITE_A}:id`,
  `optimization_roadmap_sheet:${SITE_B}:id`,
];

async function clean(): Promise<void> {
  await db.delete(appStateTable).where(inArray(appStateTable.key, keys));
}

beforeEach(clean);
afterAll(clean);

describe("optimization roadmap workbook binding", () => {
  it("allows only one site to claim a workbook under concurrent binds", async () => {
    const spreadsheetId = `concurrent-bind-${Date.now()}-${process.pid}`;
    const results = await Promise.allSettled([
      claimOptimizationRoadmapBinding(SITE_A, spreadsheetId),
      claimOptimizationRoadmapBinding(SITE_B, spreadsheetId),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(String(rejected?.reason)).toContain("already bound to another site");

    const bindings = await db
      .select({ key: appStateTable.key, value: appStateTable.value })
      .from(appStateTable)
      .where(inArray(appStateTable.key, keys));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.value).toBe(spreadsheetId);
  });

  it("does not silently rebind a site to a different workbook", async () => {
    await claimOptimizationRoadmapBinding(SITE_A, "roadmap-sheet-a");
    await expect(
      claimOptimizationRoadmapBinding(SITE_A, "roadmap-sheet-b"),
    ).rejects.toThrow("already bound to a different");
  });

  it("serializes the full refresh section across database clients", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstHasLock = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withOptimizationRoadmapRefreshLock(SITE_A, async () => {
      order.push("first:start");
      firstEntered();
      await release;
      order.push("first:end");
    });
    await firstHasLock;

    const second = withOptimizationRoadmapRefreshLock(SITE_A, async () => {
      order.push("second:start");
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });
});