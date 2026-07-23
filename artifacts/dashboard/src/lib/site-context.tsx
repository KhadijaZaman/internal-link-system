import { createContext, useContext, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSites,
  getListSitesQueryKey,
  setSiteIdGetter,
  type Site,
} from "@workspace/api-client-react";

const STORAGE_KEY = "wellows.activeSiteId";

let activeSiteIdStore: number | null = null;

/** Current active site id for code outside React (raw fetch call sites). */
export function getActiveSiteId(): number | null {
  return activeSiteIdStore;
}

setSiteIdGetter(() => activeSiteIdStore);

function readStoredSiteId(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

interface SiteContextValue {
  sites: Site[];
  activeSite: Site | null;
  legacyClaimable: boolean;
  isLoading: boolean;
  isError: boolean;
  switchSite: (id: number) => void;
}

const SiteContext = createContext<SiteContextValue | null>(null);

export function useSiteContext(): SiteContextValue {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error("useSiteContext must be used within SiteProvider");
  return ctx;
}

export function SiteProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [storedId, setStoredId] = useState<number | null>(readStoredSiteId);

  const { data, isLoading, isError } = useListSites({
    query: { queryKey: getListSitesQueryKey(), staleTime: 60_000 },
  });

  const sites = useMemo(() => data?.sites ?? [], [data]);
  const legacyClaimable = data?.legacyClaimable ?? false;

  const activeSite = useMemo(() => {
    if (sites.length === 0) return null;
    return sites.find((s) => s.id === storedId) ?? sites[0];
  }, [sites, storedId]);

  // Keep the module-level store in sync before children mount so every
  // request issued by child queries carries the X-Site-Id header.
  activeSiteIdStore = activeSite?.id ?? null;

  const switchSite = (id: number) => {
    if (id === activeSite?.id) return;
    try {
      localStorage.setItem(STORAGE_KEY, String(id));
    } catch {
      // localStorage unavailable — in-memory switch still works
    }
    activeSiteIdStore = id;
    setStoredId(id);
    queryClient.clear();
  };

  const value: SiteContextValue = {
    sites,
    activeSite,
    legacyClaimable,
    isLoading,
    isError,
    switchSite,
  };

  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}
