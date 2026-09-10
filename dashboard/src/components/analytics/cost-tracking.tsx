'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AreaChart } from '@/components/charts/area-chart';
import { CHART_GOLD } from '@/components/charts/chart-theme';
import type { CostSummary, UsageHealth } from '@/lib/cost-parser';

interface PlanUsageData {
  session: { used_pct: number; resets: string };
  week_all_models: { used_pct: number; resets: string };
  week_sonnet: { used_pct: number };
  timestamp: string;
}

interface UsageHistoryPoint {
  timestamp: string;
  session_pct: number;
  week_pct: number;
  sonnet_pct: number;
}

interface CodexUsageData {
  plan_type: string;
  timestamp: string;
  five_hour: { used_pct: number; resets: string };
  seven_day: { used_pct: number; resets: string };
}

interface CostTrackingProps {
  dailyCosts: Array<CostSummary & { date: string }>;
  currentMonthCost: CostSummary;
  usageHealth: UsageHealth;
  planUsage?: PlanUsageData | null;
  usageHistory?: UsageHistoryPoint[];
  codexUsage?: CodexUsageData | null;
}

function UsageBar({ pct, label, sublabel }: { pct: number; label: string; sublabel?: string }) {
  const color = pct < 50 ? 'bg-green-500' : pct < 80 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {sublabel && <p className="text-[10px] text-muted-foreground">{sublabel}</p>}
    </div>
  );
}

export function CostTracking({
  dailyCosts,
  currentMonthCost,
  usageHealth,
  planUsage,
  usageHistory,
  codexUsage,
}: CostTrackingProps) {
  return (
    <div className="space-y-6">
      {/* Plan Usage — primary metric, always shown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Max Plan Usage
          </CardTitle>
        </CardHeader>
        <CardContent>
          {planUsage ? (
            <div className="space-y-4">
              <UsageBar
                pct={planUsage.week_all_models.used_pct}
                label="Weekly (All Models)"
                sublabel={planUsage.week_all_models.resets ? `Resets ${planUsage.week_all_models.resets}` : undefined}
              />
              <UsageBar
                pct={planUsage.session.used_pct}
                label="Current Session"
                sublabel={planUsage.session.resets ? `Resets ${planUsage.session.resets}` : undefined}
              />
              <UsageBar
                pct={planUsage.week_sonnet.used_pct}
                label="Weekly (Sonnet Only)"
              />
              <p className="text-[10px] text-muted-foreground">
                Last updated: {new Date(planUsage.timestamp).toLocaleString()}
              </p>
            </div>
          ) : (
            <div className="py-6 text-center space-y-2">
              <p className="text-sm font-medium">Plan usage tracking not configured</p>
              <p className="text-xs text-muted-foreground">
                Run the usage scraper to see your Claude Max plan usage here.
              </p>
              <code className="text-xs bg-muted px-2 py-1 rounded block w-fit mx-auto mt-2">
                cortextos bus scrape-usage
              </code>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Codex (ChatGPT) Plan Usage */}
      {codexUsage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Codex Plan Usage{codexUsage.plan_type ? ` (${codexUsage.plan_type})` : ''}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <UsageBar
                pct={codexUsage.seven_day.used_pct}
                label="Weekly (7-day)"
                sublabel={codexUsage.seven_day.resets ? `Resets ${codexUsage.seven_day.resets}` : undefined}
              />
              <UsageBar
                pct={codexUsage.five_hour.used_pct}
                label="Current Session (5h)"
                sublabel={codexUsage.five_hour.resets ? `Resets ${codexUsage.five_hour.resets}` : undefined}
              />
              <p className="text-[10px] text-muted-foreground">
                Last updated: {new Date(codexUsage.timestamp).toLocaleString()}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Usage History Chart */}
      {usageHistory && usageHistory.length >= 2 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Usage Over Time
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Plan usage percentage over time. Weekly limit resets every Sunday.
            </p>
            <AreaChart
              data={usageHistory.map(p => {
                const d = new Date(p.timestamp);
                return {
                  date: `${d.getMonth()+1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
                  'Weekly %': p.week_pct,
                  'Session %': p.session_pct,
                };
              })}
              xKey="date"
              yKeys={['Weekly %', 'Session %']}
              colors={[CHART_GOLD, '#2563EB']}
              height={200}
              showLegend
            />
          </CardContent>
        </Card>
      ) : usageHistory && usageHistory.length === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Usage Snapshot
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-6 py-4">
              <div className="text-center">
                <p className="text-4xl font-bold tabular-nums" style={{ color: CHART_GOLD }}>{usageHistory[0].week_pct}%</p>
                <p className="text-xs text-muted-foreground mt-1">Weekly (All Models)</p>
              </div>
              <div className="text-center">
                <p className="text-4xl font-bold tabular-nums text-muted-foreground">{usageHistory[0].session_pct}%</p>
                <p className="text-xs text-muted-foreground mt-1">Current Session</p>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground text-center">Chart will appear after the next scrape</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-sm">Observed token costs</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">Month to date: {currentMonthCost.cost_status.toUpperCase()}
            {currentMonthCost.cost !== null ? ` — $${currentMonthCost.cost.toFixed(2)}` : ''}</p>
          <p className="text-xs text-muted-foreground">{currentMonthCost.tokens.toLocaleString()} validated tokens · {currentMonthCost.unknown_entries} entries with unknown cost</p>
          <p className="text-xs text-muted-foreground">
            Estimated subtotal: {currentMonthCost.estimated_usd === null ? 'UNKNOWN' : `$${currentMonthCost.estimated_usd.toFixed(2)}`} ·
            Billed subtotal: {currentMonthCost.billed_usd === null ? 'UNKNOWN' : `$${currentMonthCost.billed_usd.toFixed(2)}`}
          </p>
          <p className="text-xs text-muted-foreground">Estimates use recorded API prices. Subscription use is not a cash charge. Coverage is limited to the sources below; missing observations can leave costs unknown. No spending limit is enforced.</p>
          <p className="text-xs">Sources: {usageHealth.state.toUpperCase()} · {usageHealth.issues.length} accounting issues · {usageHealth.legacy_rows_excluded} legacy rows excluded</p>
          {usageHealth.instruments.map((i, n) => <p key={n} className="text-xs">{i.org}/{i.agent} ({i.runtime}): {i.status.toUpperCase()}{i.last_observation ? ` — ${new Date(i.last_observation).toLocaleString()}` : ''}</p>)}
          {usageHealth.issues.length > 0 && <details className="text-xs"><summary>Accounting issues</summary>
            {usageHealth.issues.map((i,n) => <p key={n}>{i.org}/{i.agent}: {i.code}{i.line ? ` (line ${i.line})` : ''}</p>)}
          </details>}
          {dailyCosts.length > 0 && <table className="w-full text-sm"><thead><tr><th className="text-left">Day</th><th className="text-left">Cost status</th><th className="text-right">USD</th></tr></thead><tbody>
            {dailyCosts.map(d => <tr key={d.date}><td>{d.date}</td><td>{d.cost_status.toUpperCase()}</td><td className="text-right">{d.cost === null ? 'UNKNOWN' : `$${d.cost.toFixed(2)}`}</td></tr>)}
          </tbody></table>}
        </CardContent>
      </Card>
    </div>
  );
}
