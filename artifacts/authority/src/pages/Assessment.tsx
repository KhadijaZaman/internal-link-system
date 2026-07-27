import assessmentData from '@/data/assessment.json';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

function formatValue(val: any, fallback = 'not available from GSC/Bing/GA4') {
  if (val === null || val === undefined) return <span className="text-[8px] text-muted-foreground italic leading-tight whitespace-normal" data-testid="text-not-available">{fallback}</span>;
  return typeof val === 'number' ? val.toLocaleString() : val;
}

export default function Assessment() {
  const data = assessmentData as any;
  const entityA = data.entities.A;
  const entityB = data.entities.B;

  // Prepare chart data
  const chartData = data.trends.google.months.map((month: string, i: number) => ({
    month: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(month.split('-')[1]) - 1],
    fullMonth: month,
    a_impr: data.trends.google.A.i[i],
    a_click: data.trends.google.A.c[i],
    b_impr: data.trends.google.B.i[i],
    b_click: data.trends.google.B.c[i]
  }));

  const bingChartData = data.trends.bing.weeks.map((week: string, i: number) => ({
    week,
    a_impr: data.trends.bing.A.i[i],
    b_impr: data.trends.bing.B.i[i]
  }));

  return (
    <div className="min-h-[100dvh] xl:h-screen w-full bg-background text-foreground flex flex-col overflow-hidden font-sans selection:bg-accent selection:text-white">
      {/* HEADER */}
      <header className="flex-none px-4 lg:px-6 py-4 border-b border-border flex flex-col lg:flex-row lg:items-center justify-between gap-4 shrink-0 bg-white z-10 shadow-sm relative">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 bg-primary text-white flex items-center justify-center rounded-sm font-bold text-xs">W</div>
            <span className="font-semibold text-sm tracking-wide text-primary">Wellows</span>
            <span className="text-muted-foreground text-sm">/</span>
            <span className="text-sm text-muted-foreground">Public Data Report</span>
          </div>
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-primary">Topical Authority Assessment: AI Visibility vs Generative Engine Optimization (GEO)</h1>
        </div>
        <div className="max-w-xl text-xs lg:text-sm text-muted-foreground leading-relaxed border-l-2 border-accent pl-3 lg:text-right" data-testid="text-verdict">
          <strong className="text-foreground">Verdict:</strong> Optimize for <strong>AI Visibility</strong> as the central entity — it commands the wider demand surface (query depth <strong>10,355 vs 6,597</strong> distinct queries; page spread 273 vs 256) and is earlier on the authority curve, where added coverage compounds fastest. Keep GEO as the supporting commercial layer — it already out-clicks on Google (<strong>138 vs 84</strong>). Counterpoint: Bing flips the ranking (GEO 417 imp vs 132), on a far smaller base.
        </div>
      </header>

      {/* MAIN GRID */}
      <main className="flex-1 overflow-y-auto xl:overflow-hidden p-4 lg:p-6 bg-secondary/30">
        <div className="h-full flex flex-col xl:flex-row gap-4 xl:gap-6">
          
          {/* COLUMN 1: Claims & Trends */}
          <div className="w-full xl:flex-[28_1_0%] xl:min-w-0 flex flex-col gap-4 min-h-0">
            <Card className="shadow-xs border-border/60 bg-white shrink-0">
              <CardHeader className="py-2 px-4 bg-muted/30 border-b border-border/40">
                <CardTitle className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Defensible Claims</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="flex flex-col divide-y divide-border/40 text-[11px]">
                  <li className="p-2.5 space-y-1 hover:bg-muted/10 transition-colors" data-testid="text-claim-coverage">
                    <div className="font-semibold text-primary flex items-center justify-between">
                      <span>Centrality / Coverage</span>
                      <Badge variant="outline" className="font-mono bg-accent/5 text-accent border-accent/20">10,355 vs 6,597</Badge>
                    </div>
                    <p className="text-muted-foreground leading-snug">AI Visibility holds significantly wider semantic coverage across Google based on query depth (10,355 vs 6,597 distinct queries; 273 vs 256 pages).</p>
                  </li>
                  <li className="p-2.5 space-y-1 hover:bg-muted/10 transition-colors" data-testid="text-claim-trend">
                    <div className="font-semibold text-primary flex items-center justify-between">
                      <span>Authority Signal Pattern</span>
                      <Badge variant="outline" className="font-mono bg-accent/5 text-accent border-accent/20">Early Stage</Badge>
                    </div>
                    <p className="text-muted-foreground leading-snug">AI-visibility impressions ×1.5 Feb→Mar into a ~145–152k/month Mar–May plateau while clicks stayed flat (expected "impressions rise before clicks" signal). June–July retreated (-45% vs May).</p>
                  </li>
                  <li className="p-2.5 space-y-1 hover:bg-muted/10 transition-colors" data-testid="text-claim-engagement">
                    <div className="font-semibold text-primary flex items-center justify-between">
                      <span>Engagement & Feeding</span>
                      <Badge variant="outline" className="font-mono bg-accent/5 text-accent border-accent/20">73.6% engagement</Badge>
                    </div>
                    <p className="text-muted-foreground leading-snug">GEO cluster drew 19,715 Google organic sessions at 73.6% engagement, fed by 762 in-content links from 126 informational pages into commercial pages.</p>
                  </li>
                </ul>
              </CardContent>
            </Card>

            <Card className="shadow-xs border-border/60 bg-white flex-1 flex flex-col min-h-[300px]">
              <CardHeader className="py-2 px-4 bg-muted/30 border-b border-border/40 shrink-0">
                <CardTitle className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Trend Analysis</CardTitle>
              </CardHeader>
              <CardContent className="p-3 flex-1 flex flex-col gap-2 overflow-hidden">
                <div className="flex items-center justify-between shrink-0 flex-wrap gap-x-3 gap-y-1">
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-accent inline-block" />AI Visibility</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-foreground inline-block" />GEO</span>
                  </div>
                  <span className="text-[9px] text-muted-foreground">Jan from 01-27 · Jul through 07-26 (partial)</span>
                </div>
                <div className="flex-[5] min-h-0 flex flex-col" data-testid="chart-google-impressions">
                  <h3 className="text-[10px] uppercase font-semibold text-muted-foreground shrink-0">Google Impressions (monthly)</h3>
                  <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                        <defs>
                          <linearGradient id="colorA" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="hsl(var(--accent))" stopOpacity={0.2}/>
                            <stop offset="95%" stopColor="hsl(var(--accent))" stopOpacity={0}/>
                          </linearGradient>
                          <linearGradient id="colorB" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="hsl(var(--foreground))" stopOpacity={0.1}/>
                            <stop offset="95%" stopColor="hsl(var(--foreground))" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" tick={{fontSize: 9}} axisLine={false} tickLine={false} />
                        <YAxis tick={{fontSize: 9}} axisLine={false} tickLine={false} tickFormatter={(val) => `${val/1000}k`} />
                        <Tooltip contentStyle={{fontSize: '11px'}} />
                        <Area type="monotone" dataKey="a_impr" name="AI Visibility" stroke="hsl(var(--accent))" strokeWidth={2} fillOpacity={1} fill="url(#colorA)" />
                        <Area type="monotone" dataKey="b_impr" name="GEO" stroke="hsl(var(--foreground))" strokeWidth={2} fillOpacity={1} fill="url(#colorB)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="flex-[4] min-h-0 flex flex-col" data-testid="chart-google-clicks">
                  <h3 className="text-[10px] uppercase font-semibold text-muted-foreground shrink-0">Google Clicks (monthly)</h3>
                  <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                        <XAxis dataKey="month" tick={{fontSize: 9}} axisLine={false} tickLine={false} />
                        <YAxis tick={{fontSize: 9}} axisLine={false} tickLine={false} allowDecimals={false} />
                        <Tooltip contentStyle={{fontSize: '11px'}} />
                        <Area type="monotone" dataKey="a_click" name="AI Visibility" stroke="hsl(var(--accent))" strokeWidth={2} fill="transparent" />
                        <Area type="monotone" dataKey="b_click" name="GEO" stroke="hsl(var(--foreground))" strokeWidth={2} fill="transparent" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="h-[60px] shrink-0 flex flex-col" data-testid="chart-bing-weekly">
                  <h3 className="text-[10px] uppercase font-semibold text-muted-foreground shrink-0 truncate" title="Bing weekly impressions — reported separately from Google, never blended">Bing Impressions (weekly, separate engine)</h3>
                  <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={bingChartData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
                        <XAxis dataKey="week" hide />
                        <YAxis tick={{fontSize: 8}} axisLine={false} tickLine={false} allowDecimals={false} width={24} />
                        <Tooltip contentStyle={{fontSize: '10px'}} />
                        <Area type="step" dataKey="a_impr" name="AI Visibility" stroke="hsl(var(--accent))" fill="transparent" />
                        <Area type="step" dataKey="b_impr" name="GEO" stroke="hsl(var(--foreground))" fill="transparent" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* COLUMN 2: Data Table */}
          <div className="w-full xl:flex-[47_1_0%] xl:min-w-0 flex flex-col min-h-0">
            <Card className="shadow-xs border-border/60 bg-white h-full flex flex-col">
              <CardHeader className="py-3 px-4 bg-muted/30 border-b border-border/40 shrink-0">
                <CardTitle className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Entity Comparison Metrics</CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 overflow-hidden">
                <ScrollArea className="h-full">
                  <Table className="text-xs [&_td]:py-1.5 [&_th]:py-1.5" data-testid="table-entity-comparison">
                    <TableHeader className="bg-muted/10 sticky top-0 z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-[140px] border-r font-semibold text-foreground align-bottom pb-2">Metric</TableHead>
                        <TableHead className="text-center border-r px-0" colSpan={2}>
                          <div className="border-b pb-1 mb-1 font-semibold text-accent">Entity A: AI Visibility</div>
                          <div className="flex w-full justify-between px-2 text-[10px] text-muted-foreground">
                            <span className="w-1/2 text-left">Google</span>
                            <span className="w-1/2 text-right">Bing</span>
                          </div>
                        </TableHead>
                        <TableHead className="text-center px-0" colSpan={2}>
                          <div className="border-b pb-1 mb-1 font-semibold text-foreground">Entity B: GEO</div>
                          <div className="flex w-full justify-between px-2 text-[10px] text-muted-foreground">
                            <span className="w-1/2 text-left">Google</span>
                            <span className="w-1/2 text-right">Bing</span>
                          </div>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {/* Metric Rows */}
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Impressions</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.impressions)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.impressions)}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.impressions)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.impressions)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Clicks</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.clicks)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.clicks)}</TableCell>
                        <TableCell className="text-right font-mono font-bold">{formatValue(entityB.google.clicks)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.clicks)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">CTR</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.ctr)}{entityA.google.ctr != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.ctr)}{entityA.bing.ctr != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.ctr)}{entityB.google.ctr != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.ctr)}{entityB.bing.ctr != null && '%'}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5" title="Impression-weighted avg of topmost slot — not a rank">Weighted Position *</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.wpos)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.wpos)}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.wpos)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.wpos)}</TableCell>
                      </TableRow>
                      <TableRow className="bg-accent/5">
                        <TableCell className="font-bold border-r text-accent">Query Depth</TableCell>
                        <TableCell className="text-right font-mono font-bold text-accent">{formatValue(entityA.google.queryDepth)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.queryDepth)}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.queryDepth)}</TableCell>
                        <TableCell className="text-right font-mono font-bold text-muted-foreground">{formatValue(entityB.bing.queryDepth)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Long-tail Share</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.longTailShare)}{entityA.google.longTailShare != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.longTailShare)}{entityA.bing.longTailShare != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.longTailShare)}{entityB.google.longTailShare != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.longTailShare)}{entityB.bing.longTailShare != null && '%'}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Page Spread</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.pages?.pageSpread)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.pages?.pageSpread)}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.pages?.pageSpread)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.pages?.pageSpread)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Gini Concentration</TableCell>
                        <TableCell className="text-right font-mono">{entityA.google.pages?.gini != null ? entityA.google.pages.gini.toFixed(3) : formatValue(null)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{entityA.bing.pages?.gini != null ? entityA.bing.pages.gini.toFixed(3) : formatValue(null)}</TableCell>
                        <TableCell className="text-right font-mono">{entityB.google.pages?.gini != null ? entityB.google.pages.gini.toFixed(3) : formatValue(null)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{entityB.bing.pages?.gini != null ? entityB.bing.pages.gini.toFixed(3) : formatValue(null)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Avg URL Depth</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.pages?.avgDepth)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.pages?.avgDepth)}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.pages?.avgDepth)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.pages?.avgDepth)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Intent: Know / Do</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.intents?.know)} / {formatValue(entityA.google.intents?.do)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.intents?.know)} / {formatValue(entityA.bing.intents?.do)}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.intents?.know)} / {formatValue(entityB.google.intents?.do)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.intents?.know)} / {formatValue(entityB.bing.intents?.do)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Intent: Compare / Buy</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.google.intents?.compare)} / {formatValue(entityA.google.intents?.buy)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.bing.intents?.compare)} / {formatValue(entityA.bing.intents?.buy)}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.google.intents?.compare)} / {formatValue(entityB.google.intents?.buy)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.bing.intents?.compare)} / {formatValue(entityB.bing.intents?.buy)}</TableCell>
                      </TableRow>
                      
                      {/* GA4 SECTION */}
                      <TableRow className="border-t-2">
                        <TableCell className="font-semibold border-r bg-muted/10 text-muted-foreground" colSpan={5}>Google Analytics 4 (GA4)</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Sessions</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.ga4?.google?.sessions)}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.ga4?.bing?.sessions)}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.ga4?.google?.sessions)}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.ga4?.bing?.sessions)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Engagement Rate</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.ga4?.google?.engagementRate)}{entityA.ga4?.google?.engagementRate != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.ga4?.bing?.engagementRate)}{entityA.ga4?.bing?.engagementRate != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.ga4?.google?.engagementRate)}{entityB.ga4?.google?.engagementRate != null && '%'}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.ga4?.bing?.engagementRate)}{entityB.ga4?.bing?.engagementRate != null && '%'}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium border-r bg-muted/5">Avg Engage Time</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityA.ga4?.google?.avgEngagementTime)}{entityA.ga4?.google?.avgEngagementTime != null && 's'}</TableCell>
                        <TableCell className="text-right font-mono border-r text-muted-foreground">{formatValue(entityA.ga4?.bing?.avgEngagementTime)}{entityA.ga4?.bing?.avgEngagementTime != null && 's'}</TableCell>
                        <TableCell className="text-right font-mono">{formatValue(entityB.ga4?.google?.avgEngagementTime)}{entityB.ga4?.google?.avgEngagementTime != null && 's'}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{formatValue(entityB.ga4?.bing?.avgEngagementTime)}{entityB.ga4?.bing?.avgEngagementTime != null && 's'}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                  <ScrollBar orientation="vertical" />
                </ScrollArea>
              </CardContent>
              <div className="shrink-0 border-t border-border/40 px-3 py-1.5 text-[9px] text-muted-foreground leading-snug">
                * Weighted position = impression-weighted average of the page's topmost slot — not a rank. Google and Bing are reported side-by-side and never summed or blended.
              </div>
            </Card>
          </div>

          {/* COLUMN 3: Method */}
          <div className="w-full xl:flex-[25_1_0%] xl:min-w-0 flex flex-col gap-4 min-h-0">
            
            <Card className="shadow-xs border-border/60 bg-white flex-1 flex flex-col min-h-0">
              <CardHeader className="py-3 px-4 bg-muted/30 border-b border-border/40 shrink-0">
                <CardTitle className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Method & Assumptions</CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-y-auto">
                <Accordion type="single" collapsible className="w-full text-xs">
                  <AccordionItem value="sources" className="border-b-0 px-4">
                    <AccordionTrigger className="py-3 hover:no-underline font-medium text-left" data-testid="button-accordion-sources">Data Sources & Range</AccordionTrigger>
                    <AccordionContent className="text-[11px] text-muted-foreground pb-3 space-y-2 leading-relaxed">
                      <p><strong>Range:</strong> {data.meta.range.startDate} to {data.meta.range.endDate} (finalized through {data.meta.finalDataThrough}).</p>
                      <p><strong>Google:</strong> {data.meta.sources.google}</p>
                      <p><strong>Bing:</strong> {data.meta.sources.bing}</p>
                      <p><strong>GA4:</strong> {data.meta.sources.ga4}</p>
                      <p><strong>Property:</strong> {data.meta.property}. GA4 hosts: {data.meta.ga4MarketingHosts.join(', ')}.</p>
                      <p><strong>Link feed:</strong> {data.linkFeed.method}.</p>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="gaps" className="border-b-0 px-4 border-t">
                    <AccordionTrigger className="py-3 hover:no-underline font-medium" data-testid="button-accordion-gaps">Gap Disclosures & Filtering</AccordionTrigger>
                    <AccordionContent className="text-[11px] text-muted-foreground pb-3 space-y-2">
                      <p><strong>Google Anonymized:</strong> {data.gapDisclosure.google.anonymizedImprShare}% of impressions and {data.gapDisclosure.google.anonymizedClickShare}% of clicks carry no visible query ({data.gapDisclosure.google.queryVisibleImpressions.toLocaleString()} of {data.gapDisclosure.google.siteImpressions.toLocaleString()} impressions are query-visible) — cluster totals cannot reconcile to site totals by design.</p>
                      <p><strong>Bing Unreported:</strong> {data.gapDisclosure.bing.unreportedShare}% of Bing page-level impressions have no query-level attribution ({data.gapDisclosure.bing.queryLevelImpressions.toLocaleString()} of {data.gapDisclosure.bing.pageLevelImpressions.toLocaleString()} reported at query level).</p>
                      <p><strong>Junk Queries:</strong> Removed {data.junkStats.google.n.toLocaleString()} Google ({data.junkStats.google.impressions.toLocaleString()} imp) and {data.junkStats.bing.n} Bing ({data.junkStats.bing.impressions.toLocaleString()} imp) operator/scraper queries before matching.</p>
                      <p><strong>Geo Collisions:</strong> {data.geoFlags.collisionCount} geographic collisions excluded; {data.geoFlags.ambiguousCount} ambiguous included. "Both" Overlap counts in BOTH: {data.bothOverlap.google.n} Google / {data.bothOverlap.bing.n} Bing.</p>
                      <p><strong>URLs:</strong> {data.ruleset.urlNorm}</p>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="audit" className="border-b-0 px-4 border-t">
                    <AccordionTrigger className="py-3 hover:no-underline font-medium" data-testid="button-accordion-audit">Audit & Full Ruleset</AccordionTrigger>
                    <AccordionContent className="text-[11px] text-muted-foreground pb-3 space-y-3">
                      <div className="space-y-1">
                        <strong className="text-foreground">Intent Rubric:</strong>
                        <p>{data.ruleset.intent.precedence}</p>
                        <p>Compare: <span className="font-mono text-[9px] break-all">{data.ruleset.intent.compare}</span></p>
                        <p>Buy: <span className="font-mono text-[9px] break-all">{data.ruleset.intent.buy}</span></p>
                        <p>Do: <span className="font-mono text-[9px] break-all">{data.ruleset.intent.do}</span></p>
                      </div>
                      <div className="space-y-1">
                        <strong className="text-foreground">Entity A Rules:</strong>
                        <ul className="list-disc pl-4 space-y-0.5">
                          {data.ruleset.A.map((rule: any) => (
                            <li key={rule.id}><span className="font-mono text-[9px]">{rule.id}</span>: {rule.note}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="space-y-1">
                        <strong className="text-foreground">Entity B Rules:</strong>
                        <ul className="list-disc pl-4 space-y-0.5">
                          {data.ruleset.B.map((rule: any) => (
                            <li key={rule.id}><span className="font-mono text-[9px]">{rule.id}</span>: {rule.note}</li>
                          ))}
                        </ul>
                      </div>
                      <div className="space-y-1">
                        <strong className="text-foreground">Geo Handling:</strong>
                        <p>Flow: {data.ruleset.geo.flow}</p>
                      </div>
                      <div className="space-y-1">
                        <strong className="text-foreground">Junk Filters:</strong>
                        <ul className="list-disc pl-4 space-y-0.5">
                          {data.ruleset.junk.map((j: string, i: number) => <li key={i} className="font-mono text-[9px] break-all">{j}</li>)}
                        </ul>
                      </div>
                      <div className="space-y-1">
                        <strong className="text-foreground">Top unmatched queries (in neither cluster):</strong>
                        <ul className="list-disc pl-4 space-y-0.5" data-testid="list-top-unmatched">
                          {data.unmatched.google.top.slice(0, 6).map((u: any) => (
                            <li key={u.q}>{u.q} <span className="font-mono text-[9px]">({u.i.toLocaleString()} imp)</span></li>
                          ))}
                        </ul>
                        <p className="text-[10px]">Bing top: {data.unmatched.bing.top.slice(0, 3).map((u: any) => u.q).join('; ')}.</p>
                      </div>
                      <div className="mt-3 flex flex-col gap-2 pt-2 border-t border-border/40">
                        <a href={`${import.meta.env.BASE_URL}data/unmatched_full.json`} download className="text-accent hover:underline flex items-center gap-1 font-medium" data-testid="link-download-unmatched">↓ Download Unmatched Queries ({data.unmatched.google.count.toLocaleString()} Google / {data.unmatched.bing.count.toLocaleString()} Bing)</a>
                        <a href={`${import.meta.env.BASE_URL}data/geo_flags_full.json`} download className="text-accent hover:underline flex items-center gap-1 font-medium" data-testid="link-download-geoflags">↓ Download Geo Flags</a>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </CardContent>
            </Card>

          </div>
        </div>
      </main>
    </div>
  );
}
