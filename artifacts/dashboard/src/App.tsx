import { useEffect, useRef } from "react";
import {
  Switch,
  Route,
  Router as WouterRouter,
  Redirect,
  useLocation,
} from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import {
  ClerkProvider,
  ClerkLoading,
  ClerkLoaded,
  SignIn,
  SignUp,
  Show,
  useClerk,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { SiteProvider, useSiteContext } from "@/lib/site-context";
import { WelcomePage } from "@/pages/welcome";
import Dashboard from "@/pages/dashboard";
import LinkMap from "@/pages/link-map";
import KnowledgeGraph from "@/pages/knowledge-graph";
import LinksHub from "@/pages/links";
import AuthoritySnapshot from "@/pages/authority-snapshot";
import Losers from "@/pages/losers-rollup";
import Optimize from "@/pages/optimize";
import Actions from "@/pages/actions";
import DigestPage from "@/pages/digest";
import Submissions from "@/pages/submissions";
import GscOverview from "@/pages/gsc/overview";
import GscQueries from "@/pages/gsc/queries";
import GscPages from "@/pages/gsc/pages";
import GscGeo from "@/pages/gsc/geo";
import GscIndexing from "@/pages/gsc/indexing";
import GscCwv from "@/pages/gsc/cwv";
import GscLinks from "@/pages/gsc/links";
import GscAsk from "@/pages/gsc/ask";
import GscBulkQueries from "@/pages/gsc/bulk-queries";
import WpClassifications from "@/pages/wp-classifications";
import WpExcludeList from "@/pages/wp-exclude-list";
import ContentWriter from "@/pages/content/writer";
import KnowledgeBase from "@/pages/knowledge-base";
import Ga4Pages from "@/pages/ga4/pages";
import PageReport from "@/pages/report/pages";
import KeywordReport from "@/pages/keyword-report";
import Clustering from "@/pages/clustering";
import SimilarityExplorer from "@/pages/similarity-explorer";
import BingPage from "@/pages/bing";
import InsightsPage from "@/pages/insights";
import TopicalMap from "@/pages/topical-map";
import SettingsPage from "@/pages/settings";
import AdminPage from "@/pages/admin";
import { GscRangeProvider } from "@/components/gsc/range-context";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — copy verbatim. Empty in dev (Clerk hits dev FAPI directly),
// auto-set in prod. Do NOT gate on import.meta.env.PROD / NODE_ENV.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(220 96% 48%)",
    colorForeground: "hsl(220 50% 10%)",
    colorMutedForeground: "hsl(220 15% 45%)",
    colorDanger: "hsl(0 84% 55%)",
    colorBackground: "#ffffff",
    colorInput: "#ffffff",
    colorInputForeground: "hsl(220 50% 10%)",
    colorNeutral: "hsl(220 20% 55%)",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden border border-slate-200 shadow-lg",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-slate-900 font-semibold",
    headerSubtitle: "text-slate-500",
    socialButtonsBlockButtonText: "text-slate-700 font-medium",
    formFieldLabel: "text-slate-700",
    footerActionLink: "text-blue-600 font-medium hover:text-blue-700",
    footerActionText: "text-slate-500",
    dividerText: "text-slate-400",
    identityPreviewEditButton: "text-blue-600",
    formFieldSuccessText: "text-emerald-600",
    alertText: "text-slate-700",
    logoBox: "justify-center",
    logoImage: "h-8",
    socialButtonsBlockButton: "border-slate-200 hover:bg-slate-50",
    formButtonPrimary: "bg-blue-600 hover:bg-blue-700 text-white",
    formFieldInput: "border-slate-200 text-slate-900",
    footerAction: "justify-center",
    dividerLine: "bg-slate-200",
    alert: "border-slate-200",
    otpCodeFieldInput: "border-slate-300 text-slate-900",
    formFieldRow: "gap-1.5",
    main: "gap-5",
  },
};

function AuthLoadingSplash() {
  return (
    <div
      className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background px-4"
      data-testid="auth-loading-splash"
    >
      <img
        src={`${basePath}/logo.svg`}
        alt="Wellows"
        className="h-10 w-auto"
      />
      <Spinner className="h-6 w-6 text-muted-foreground" />
    </div>
  );
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}

/** Gate rendered inside SiteProvider: spinner → welcome/empty state → app. */
function SiteGate({ children }: { children: React.ReactNode }) {
  const { activeSite, isLoading, isError } = useSiteContext();

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-screen w-full items-center justify-center px-4">
        <p className="text-sm text-muted-foreground">
          Couldn't load your sites. Refresh the page to try again.
        </p>
      </div>
    );
  }

  if (!activeSite) {
    return <WelcomePage />;
  }

  // key remounts the whole subtree on site switch so no per-page state leaks
  return (
    <div key={activeSite.id} className="contents">
      {children}
    </div>
  );
}

/**
 * Signed-out redirect that remembers the originally requested page.
 * The destination is passed to /sign-in via the `redirect_url` query param,
 * which Clerk's <SignIn> reads and navigates to after authentication
 * (through routerPush → stripBase, so we include the base path here).
 * Plain "/" visits go to /sign-in with no param, preserving today's behavior.
 */
function RedirectToSignIn() {
  const [location] = useLocation();
  const search = window.location.search;
  const dest = `${basePath}${location}${search}`;
  const isPlainHome = location === "/" && !search;
  return (
    <Redirect
      to={
        isPlainHome
          ? "/sign-in"
          : `/sign-in?redirect_url=${encodeURIComponent(dest)}`
      }
    />
  );
}

function ProtectedRoute({
  component: Component,
}: {
  component: React.ComponentType;
}) {
  return (
    <>
      <Show when="signed-in">
        <SiteProvider>
          <SiteGate>
            <Layout>
              <Component />
            </Layout>
          </SiteGate>
        </SiteProvider>
      </Show>
      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
    </>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <ProtectedRoute component={Dashboard} />
      </Show>
      <Show when="signed-out">
        <RedirectToSignIn />
      </Show>
    </>
  );
}

// Invalidate the QueryClient cache when the signed-in user changes.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRedirect} />
      {/* REQUIRED — the /*? optional wildcard matches both the bare URL and
          Clerk's OAuth sub-paths (/sign-in/sso-callback, /sign-in/factor-one). */}
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/link-map" component={() => <ProtectedRoute component={LinkMap} />} />
      <Route path="/knowledge-graph" component={() => <ProtectedRoute component={KnowledgeGraph} />} />
      <Route path="/links" component={() => <ProtectedRoute component={LinksHub} />} />
      <Route path="/links/lookups" component={() => <ProtectedRoute component={LinksHub} />} />
      <Route path="/links/structural" component={() => <ProtectedRoute component={LinksHub} />} />
      <Route path="/suggestions" component={() => <ProtectedRoute component={LinksHub} />} />
      <Route path="/semantic-links" component={() => <ProtectedRoute component={LinksHub} />} />
      <Route path="/link-lookups" component={() => <ProtectedRoute component={LinksHub} />} />
      <Route path="/structural" component={() => <ProtectedRoute component={LinksHub} />} />
      <Route path="/authority" component={() => <ProtectedRoute component={AuthoritySnapshot} />} />
      <Route path="/losers" component={() => <ProtectedRoute component={Losers} />} />
      <Route path="/optimize" component={() => <ProtectedRoute component={Optimize} />} />
      <Route path="/alerts">
        <Redirect to="/" />
      </Route>
      <Route path="/actions" component={() => <ProtectedRoute component={Actions} />} />
      <Route path="/digest" component={() => <ProtectedRoute component={DigestPage} />} />
      <Route path="/submissions" component={() => <ProtectedRoute component={Submissions} />} />
      <Route path="/wp/classifications" component={() => <ProtectedRoute component={WpClassifications} />} />
      <Route path="/wp/exclude-list" component={() => <ProtectedRoute component={WpExcludeList} />} />
      <Route path="/content/writer" component={() => <ProtectedRoute component={ContentWriter} />} />
      <Route path="/knowledge-base" component={() => <ProtectedRoute component={KnowledgeBase} />} />
      <Route path="/ga4" component={() => <ProtectedRoute component={Ga4Pages} />} />
      <Route path="/report" component={() => <ProtectedRoute component={PageReport} />} />
      <Route path="/keyword-report" component={() => <ProtectedRoute component={KeywordReport} />} />
      <Route path="/clustering" component={() => <ProtectedRoute component={Clustering} />} />
      <Route path="/similarity" component={() => <ProtectedRoute component={SimilarityExplorer} />} />
      <Route path="/bing" component={() => <ProtectedRoute component={BingPage} />} />
      <Route path="/insights" component={() => <ProtectedRoute component={InsightsPage} />} />
      <Route path="/topical-map" component={() => <ProtectedRoute component={TopicalMap} />} />
      <Route path="/settings" component={() => <ProtectedRoute component={SettingsPage} />} />
      <Route path="/admin" component={() => <ProtectedRoute component={AdminPage} />} />
      <Route path="/gsc/:rest*">
        {() => (
          <GscRangeProvider>
            <Switch>
              <Route path="/gsc" component={() => <ProtectedRoute component={GscOverview} />} />
              <Route path="/gsc/overview" component={() => <ProtectedRoute component={GscOverview} />} />
              <Route path="/gsc/queries" component={() => <ProtectedRoute component={GscQueries} />} />
              <Route path="/gsc/pages" component={() => <ProtectedRoute component={GscPages} />} />
              <Route path="/gsc/geo" component={() => <ProtectedRoute component={GscGeo} />} />
              <Route path="/gsc/indexing" component={() => <ProtectedRoute component={GscIndexing} />} />
              <Route path="/gsc/cwv" component={() => <ProtectedRoute component={GscCwv} />} />
              <Route path="/gsc/links" component={() => <ProtectedRoute component={GscLinks} />} />
              <Route path="/gsc/bulk-queries" component={() => <ProtectedRoute component={GscBulkQueries} />} />
              <Route path="/gsc/ask" component={() => <ProtectedRoute component={GscAsk} />} />
              <Route component={NotFound} />
            </Switch>
          </GscRangeProvider>
        )}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to your Wellows dashboard",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Start operating your site's SEO",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <ClerkLoading>
            <AuthLoadingSplash />
          </ClerkLoading>
          <ClerkLoaded>
            <Router />
          </ClerkLoaded>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
