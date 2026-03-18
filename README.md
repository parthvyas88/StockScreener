# Indian DMA Screener

This project is ready to deploy on Cloudflare Pages for free.

## Deploy With Cloudflare Pages

1. Push this folder to a GitHub repository.
2. In Cloudflare Dashboard, go to `Workers & Pages` -> `Create` -> `Pages` -> `Connect to Git`.
3. Select the repository.
4. Use these settings:
   - Framework preset: `None`
   - Build command: leave blank
   - Build output directory: `public`
5. Deploy.

Cloudflare Pages will serve:
- Static UI from `public/`
- Serverless live quote endpoint from `functions/api/quotes.js`

## Local Cloudflare Preview

If you want to preview the deployed shape locally:

```bash
npm run cf:dev
```

## CLI Deploy

After installing/authenticating Wrangler:

```bash
npm run cf:deploy -- --project-name india-dma-screener
```

## Notes

- The app fetches live prices from `nseindia.com` and `bseindia.com`.
- NSE is used first when an NSE code exists.
- BSE is used for stocks that only have a BSE code in the CSV.
