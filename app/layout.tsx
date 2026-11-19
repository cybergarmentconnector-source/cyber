import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import InputMode from '../components/input-mode';

const inter = localFont({
  src: [
    { path: './fonts/Inter-Regular.otf', weight: '400' },
    { path: './fonts/Inter-Medium.otf', weight: '500' },
    { path: './fonts/Inter-SemiBold.otf', weight: '600' },
  ],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = { title: 'Business Reports', description: 'View-only business reports from Tally', robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#ffffff' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en-IN" className={inter.variable}><body><InputMode />{children}</body></html>;
}
