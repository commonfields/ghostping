import type { Metadata } from 'next'
import { Syne, JetBrains_Mono, DM_Sans } from 'next/font/google'
import './globals.css'

const syne = Syne({
  subsets: ['latin'],
  variable: '--font-syne',
  weight: ['400', '600', '700', '800'],
  display: 'swap',
})

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '700'],
  display: 'swap',
})

const dm = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm',
  weight: ['400', '500', '600'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'OpenRecord — Evidence for AI representation integrity',
  description:
    'OpenRecord is an evidence system for AI representation integrity. It records what a business says is true, observes what AI systems say, and traces the difference to evidence.',
  openGraph: {
    title: 'OpenRecord — Evidence for AI representation integrity',
    description:
      'Find what AI gets wrong about your business, trace it to evidence, and verify what changes.',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${syne.variable} ${mono.variable} ${dm.variable}`}>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  )
}
