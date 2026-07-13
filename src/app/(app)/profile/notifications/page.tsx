import { redirect } from 'next/navigation';

// Notification settings have been consolidated into the exchanges page.
export default function NotificationsPage() {
  redirect('/profile/exchanges');
}
