# Ghostping Landing Page

A clean, developer-focused landing page for Ghostping — the local-first CLI workbench for auditing AI model visibility.

## Quick Start

```bash
# Navigate to the website directory
cd website

# Install dependencies
npm install

# Run development server
npm run dev

# Open http://localhost:3000
```

## Build for Production

```bash
npm run build
```

This generates a static export in the `dist/` folder, ready for deployment.

## Deployment on Vercel

### Option 1: Vercel CLI

```bash
# Install Vercel CLI if you haven't already
npm i -g vercel

# Deploy
vercel --prod
```

### Option 2: GitHub Integration

1. Push this repository to GitHub
2. Connect the repository to Vercel
3. Set the root directory to `website` in Vercel settings
4. Deploy

### Option 3: Manual Upload

1. Run `npm run build`
2. Upload the `dist/` folder to Vercel via the dashboard

## Configuration

The landing page points at this repository by default. If you fork the
project, update these values at the top of `app/page.tsx`:

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_REPO` | GitHub repository URL | `'https://github.com/commonfields/ghostping'` |
| `RELEASES_URL` | GitHub releases page | `'https://github.com/commonfields/ghostping/releases'` |
| `DOCS_URL` | Documentation URL | `'https://github.com/commonfields/ghostping#readme'` |
| `INSTALL_SH` | macOS/Linux install script | raw `scripts/install.sh` URL above |
| `INSTALL_PS1` | Windows install script | raw `scripts/install.ps1` URL above |

## Project Structure

```
website/
├── app/
│   ├── layout.tsx      # Root layout with metadata
│   ├── page.tsx        # Main landing page
│   └── globals.css     # Global styles + Tailwind
├── public/
│   └── INSTALL_SCRIPTS.md  # Install script setup guide
├── package.json
├── next.config.js
├── tailwind.config.js
└── README.md
```

## Features

- ⚡ Next.js 14 with App Router
- 🎨 Tailwind CSS for styling
- 📱 Fully responsive design
- 🎯 Copy-to-clipboard functionality
- 🌙 Dark mode optimized
- 🚀 Static export for easy deployment

## Sections

1. **Hero** — Main headline, subheadline, and CTAs
2. **Terminal Demo** — Interactive command showcase
3. **Features** — 6 key features with icons
4. **Privacy** — Data ownership messaging
5. **Install** — Multi-platform install commands
6. **Footer** — Navigation links

## Tech Stack

- [Next.js](https://nextjs.org/) — React framework
- [Tailwind CSS](https://tailwindcss.com/) — Utility-first CSS
- [Lucide React](https://lucide.dev/) — Icon library
- [Vercel](https://vercel.com/) — Deployment platform

## License

MIT — same as the Ghostping project.