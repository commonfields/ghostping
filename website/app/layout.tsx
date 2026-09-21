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
  title: 'Ghostping — Check if AI recommends your project',
  description:
    'Ghostping is a local-first CLI workbench for indie builders, solo founders, and open-source maintainers who want to audit whether AI models mention, cite, or recommend their projects.',
  openGraph: {
    title: 'Ghostping — Check if AI recommends your project',
    description:
      'Audit AI mentions, citations, and recommendations. Local-first. No SaaS lock-in.',
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
