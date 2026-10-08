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
  title: 'OpenRecord — Show clients what AI said before and after your work',
  description:
    'OpenRecord gives agencies a shareable evidence record: the approved fact, the raw AI answer, its source, a human judgment, and the next weekly check.',
  openGraph: {
    title: 'OpenRecord — Show clients what AI said before and after your work',
    description: 'A shareable, human-reviewed record of what one live AI surface said about your client, checked again each week.',
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
