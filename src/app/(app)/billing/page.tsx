import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { CheckCircle2, XCircle, CreditCard, Zap, MessageSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CheckoutButton } from '@/components/billing/checkout-button';
import { db } from '@/db';
import { userSubscriptions } from '@/db/schema';
import { listActivePlansWithPrices } from '@/lib/billing/plans';
import { resolvePlanForUser } from '@/lib/billing/plan';
import { getUsageToday } from '@/lib/billing/usage';
import { INTERVAL_LABEL, formatPlanPrice } from '@/lib/billing/format';

function UsageBar({ label, icon: Icon, used, limit }: { label: string; icon: typeof Zap; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </span>
        <span className="tabular-nums font-medium">
          {used} / {limit}
        </span>
      </div>
      <Progress value={pct} />
    </div>
  );
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;
  const { userId } = await auth();

  const [plans, effectivePlan, usage, [subscription]] = await Promise.all([
    listActivePlansWithPrices(),
    userId ? resolvePlanForUser(userId) : null,
    userId ? getUsageToday(userId) : null,
    userId
      ? db.select().from(userSubscriptions).where(eq(userSubscriptions.userId, userId)).limit(1)
      : Promise.resolve([]),
  ]);

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">Billing & Plans</h1>
        <p className="text-sm text-muted-foreground">Manage your subscription and see what each plan unlocks.</p>
      </div>

      {checkout === 'success' && (
        <Alert>
          <CheckCircle2 className="size-4" />
          <AlertTitle>Payment received</AlertTitle>
          <AlertDescription>
            Your plan activates as soon as the payment is confirmed — this can take a few minutes.
          </AlertDescription>
        </Alert>
      )}
      {checkout === 'cancelled' && (
        <Alert>
          <XCircle className="size-4" />
          <AlertTitle>Checkout cancelled</AlertTitle>
          <AlertDescription>No charge was made. You can try again anytime.</AlertDescription>
        </Alert>
      )}

      {effectivePlan && usage && (
        <Card className="p-4 md:p-6 gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Current plan</p>
              <p className="text-lg font-semibold capitalize">{effectivePlan.name}</p>
            </div>
            <div className="flex items-center gap-2">
              {subscription && (
                <Badge variant={subscription.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                  {subscription.status}
                </Badge>
              )}
              {subscription?.currentPeriodEnd && (
                <span className="text-xs text-muted-foreground">
                  Renews {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <UsageBar label="Auto-trade runs today" icon={Zap} used={usage.autoTradeRunsUsed} limit={effectivePlan.autoTradeRunsPerDay} />
            <UsageBar label="Chat messages today" icon={MessageSquare} used={usage.chatMessagesUsed} limit={effectivePlan.chatMessagesPerDay} />
          </div>
        </Card>
      )}

      {plans.length === 0 ? (
        <Card className="p-10 text-center">
          <CreditCard className="mx-auto mb-3 size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No plans are available for purchase right now.</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const isCurrent = effectivePlan?.id === plan.id;
            const features = [
              `${plan.autoTradeRunsPerDay} auto-trade runs / day`,
              `${plan.chatMessagesPerDay} chat messages / day`,
              plan.allowsByok ? 'Bring your own API keys' : null,
              plan.allowsPersonalizedMemory ? 'Personalized memory' : null,
            ].filter(Boolean) as string[];

            return (
              <Card key={plan.id} className="p-4 md:p-6 gap-4 flex flex-col">
                <CardHeader className="p-0">
                  <CardTitle className="capitalize">{plan.name}</CardTitle>
                  <CardDescription>
                    {plan.prices.length === 0 ? 'Free' : null}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0 flex-1 space-y-4">
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    {features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
                        {f}
                      </li>
                    ))}
                  </ul>

                  {isCurrent ? (
                    <Badge variant="secondary">Current plan</Badge>
                  ) : plan.prices.length === 0 ? null : userId ? (
                    <div className="space-y-3">
                      {plan.prices.map((p) => (
                        <div key={p.billingInterval} className="space-y-2">
                          <p className="text-2xl font-bold">
                            {formatPlanPrice(p.price, p.currency)}
                            <span className="text-sm font-normal text-muted-foreground">
                              /{INTERVAL_LABEL[p.billingInterval]}
                            </span>
                          </p>
                          <CheckoutButton planId={plan.id} billingInterval={p.billingInterval} />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
