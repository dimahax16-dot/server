# Multiloader Community Server

Standalone Node.js server that powers the shared community feed, social features, and direct messages.

## Deploy to Render (free)

1. Go to [render.com](https://render.com) and sign up
2. Click **New → Web Service**
3. Connect your GitHub repo and select the `server/` folder as the root
4. Set **Build Command**: `npm install`
5. Set **Start Command**: `node index.js`
6. Add a **Disk** (under Advanced): mount path `/data`, size 1 GB
7. Set environment variable: `DATA_FILE=/data/community.json`
8. Click **Deploy**
9. Copy your service URL (e.g. `https://multiloader-community.onrender.com`)

## Deploy to Railway (free tier)

1. Go to [railway.app](https://railway.app) and sign up
2. Click **New Project → Deploy from GitHub**
3. Select your repo, set root directory to `server/`
4. Add a **Volume** and set `DATA_FILE=/data/community.json`
5. Deploy — Railway auto-detects Node.js
6. Copy your public URL from the **Settings → Domains** tab

## After deploying

Update `SERVER_URL` in the Electron app:

- File: `src/renderer/src/config/server.ts`
- Change `SERVER_URL` to your deployed URL

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `47822` | HTTP port |
| `DATA_FILE` | `./data.json` | Path to JSON data file |
