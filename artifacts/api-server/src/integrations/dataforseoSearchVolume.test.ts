import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSearchVolumeTask,
  DATAFORSEO_WORLDWIDE_VOLUME_CONTRACT_URL,
  fetchSearchVolumes,
} from "./dataforseo";

beforeEach(() => {
  process.env["DATAFORSEO_LOGIN"] = "test-login";
  process.env["DATAFORSEO_PASSWORD"] = "test-password";
});

function successResponse() {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      tasks: [
        {
          status_code: 20000,
          result: [{ keyword: "search visibility", search_volume: 1_000 }],
        },
      ],
    }),
  };
}

describe("fetchSearchVolumes market targeting", () => {
  it("uses US location code 2840 for United States volume", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    global.fetch = fetchMock;

    await fetchSearchVolumes(["search visibility"], "us");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const [task] = JSON.parse(String(init.body)) as Array<Record<string, unknown>>;
    expect(task.location_code).toBe(2840);
    expect(task.language_code).toBe("en");
  });

  it("uses DataForSEO's documented location-free contract for worldwide volume", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    global.fetch = fetchMock;

    await fetchSearchVolumes(["search visibility"], "global");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const [task] = JSON.parse(String(init.body)) as Array<Record<string, unknown>>;
    expect(DATAFORSEO_WORLDWIDE_VOLUME_CONTRACT_URL).toBe(
      "https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/",
    );
    expect(task).not.toHaveProperty("location_code");
    expect(task).not.toHaveProperty("location_name");
    expect(task).not.toHaveProperty("location_coordinate");
    expect(task.language_code).toBe("en");
  });

  it("keeps US and worldwide task shapes explicitly distinct", () => {
    const us = buildSearchVolumeTask(["search visibility"], "us");
    const worldwide = buildSearchVolumeTask(["search visibility"], "global");

    expect(us).toMatchObject({ location_code: 2840 });
    expect(worldwide).not.toHaveProperty("location_code");
    expect(worldwide).not.toHaveProperty("location_name");
    expect(worldwide).not.toHaveProperty("location_coordinate");
    expect(worldwide).not.toEqual(us);
  });

  it("surfaces an out-of-funds response so enrichment is marked failed", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      json: vi.fn(),
    });

    await expect(
      fetchSearchVolumes(["search visibility"], "global"),
    ).rejects.toThrow("out of funds");
  });

  it("surfaces transport failures as indeterminate paid outcomes", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("socket closed"));

    await expect(
      fetchSearchVolumes(["search visibility"], "us"),
    ).rejects.toThrow("indeterminate outcome");
  });
});