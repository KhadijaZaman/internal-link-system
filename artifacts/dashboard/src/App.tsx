import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { AuthGuard } from "@/components/auth-guard";
import Login from "@/pages/login";
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
import { GscRangeProvider } from "@/components/gsc/range-context";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  return (
    <AuthGuard>
      <Layout>
        <Component />
      </Layout>
    </AuthGuard>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/" component={() => <ProtectedRoute component={Dashboard} />} />
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
