import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DM_Sans, Inter } from 'next/font/google';

import './globals.css';
import { ThemeBootScript } from './theme-script';

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-display',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--font-body',
});

export const metadata: Metadata = {
  title: 'Recruitment Data Platform',
  description: 'Internal talent intelligence platform over Teamtailor data',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="es" suppressHydrationWarning className={`${dmSans.variable} ${inter.variable}`}>
      <head>
        <ThemeBootScript />
      </head>
      <body className="min-h-screen bg-bg text-text-primary">{children}</body>
    </html>
  );
}
