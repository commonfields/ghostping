# Install Script Placeholders

These files should be hosted at:
- https://ghostping.dev/install.sh (macOS/Linux)
- https://ghostping.dev/install.ps1 (Windows)

## Setup Instructions

1. Copy the actual install scripts from the main project:
   - `../scripts/install.sh` → host as `install.sh`
   - `../scripts/install.ps1` → host as `install.ps1`

2. Update the URLs in `app/page.tsx`:
   - Change `INSTALL_SH_URL` from `'https://ghostping.dev/install.sh'` to your actual URL
   - Change `INSTALL_PS1_URL` from `'https://ghostping.dev/install.ps1'` to your actual URL

## Alternative: Direct GitHub Raw URLs

If you're hosting these scripts on GitHub, you can use raw.githubusercontent.com URLs:

```typescript
const INSTALL_SH_URL = 'https://raw.githubusercontent.com/yourusername/ghostping/main/scripts/install.sh';
const INSTALL_PS1_URL = 'https://raw.githubusercontent.com/yourusername/ghostping/main/scripts/install.ps1';
```

## Current Placeholder

Until you configure the actual hosting, the landing page displays placeholder URLs. 
Users will need to download binaries manually from GitHub Releases until the install scripts are live.