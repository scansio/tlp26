import { headers } from 'next/headers';
import { Webhook } from 'svix';
import { WebhookEvent } from '@clerk/nextjs/server';
import { db } from '@/db';
import { users } from '@/db/schema';

export async function POST(req: Request) {
  const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('CLERK_WEBHOOK_SECRET is not set');
    return new Response('Webhook secret not configured', { status: 500 });
  }

  // Read Svix headers for verification
  const headerPayload = await headers();
  const svixId = headerPayload.get('svix-id');
  const svixTimestamp = headerPayload.get('svix-timestamp');
  const svixSignature = headerPayload.get('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new Response('Missing svix headers', { status: 400 });
  }

  // Verify the webhook payload
  const body = await req.text();
  const wh = new Webhook(webhookSecret);

  let event: WebhookEvent;
  try {
    event = wh.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as WebhookEvent;
  } catch {
    return new Response('Invalid webhook signature', { status: 400 });
  }

  // Handle user.created event — provision user record
  if (event.type === 'user.created') {
    const { id: clerkUserId, email_addresses } = event.data;
    const primaryEmail = email_addresses.find(
      (e) => e.id === event.data.primary_email_address_id,
    );
    const email = primaryEmail?.email_address ?? email_addresses[0]?.email_address ?? '';

    try {
      await db
        .insert(users)
        .values({ clerkUserId, email })
        .onConflictDoNothing({ target: users.clerkUserId });
    } catch (err) {
      console.error('Failed to create user record:', err);
      return new Response('Database error', { status: 500 });
    }
  }

  return new Response('OK', { status: 200 });
}
