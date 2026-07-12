import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db';
import { userExchanges, tradeExecutions } from '@/db/schema';

// ---------------------------------------------------------------------------
// DELETE /api/exchanges/:id — remove a connected exchange
// ---------------------------------------------------------------------------
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const { id } = await params;

  // Confirm the exchange row exists and belongs to this user
  const [connection] = await db
    .select({
      id: userExchanges.id,
      exchangeName: userExchanges.exchangeName,
    })
    .from(userExchanges)
    .where(and(eq(userExchanges.id, id), eq(userExchanges.userId, userId)));

  if (!connection) {
    return NextResponse.json(
      { error: 'Exchange connection not found' },
      { status: 404 },
    );
  }

  // Check for open positions on this exchange
  const openPositions = await db
    .select({ id: tradeExecutions.id })
    .from(tradeExecutions)
    .where(
      and(
        eq(tradeExecutions.userId, userId),
        eq(tradeExecutions.exchangeName, connection.exchangeName),
        eq(tradeExecutions.status, 'open'),
      ),
    );

  const openCount = openPositions.length;

  // Delete the exchange connection regardless — return warning in response body
  await db
    .delete(userExchanges)
    .where(and(eq(userExchanges.id, id), eq(userExchanges.userId, userId)));

  return NextResponse.json({
    deleted: true,
    id,
    ...(openCount > 0 && {
      warning: `You had ${openCount} open position${openCount === 1 ? '' : 's'} on ${connection.exchangeName}. These will no longer be managed by the platform.`,
    }),
  });
}
