'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export async function skipOnboarding() {
  (await cookies()).set('onboarding_skipped', '1', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect('/dashboard');
}
