# Glotta

Glotta is a real-time translation platform for lectures, trainings, sermons, and other live spoken events, using speech-to-speech LLMs. A speaker starts one live session, shares a QR code, and listeners join from their phone browser to hear translated audio with captions in 70+ languages.

<p align="center">
  <img src="docs/screenshots/home-session.png" alt="Glotta session setup screen" width="260">
  <img src="docs/screenshots/speaker-dashboard.png" alt="Glotta speaker dashboard with QR code" width="260">
  <img src="docs/screenshots/listener-captions.png" alt="Glotta listener captions screen" width="260">
</p>

## What it does

- Creates a speaker-led translation session with a QR join link.
- Streams microphone or sound-board audio to a Node.js relay server over WebSockets.
- Uses Gemini Live Translate to generate translated speech and captions.
- Defaults each new session to the free Gemini key, with an explicit paid option for sensitive or confidential content.
- Supports multiple listener languages at the same time, with one shared Gemini stream per language.
- Lets listeners join from a browser without installing an app.
- Shows the speaker live listener counts, an audio input meter, and a bounded source transcript.

## How it works

```text
Speaker browser/app -> PCM audio over WebSocket -> Node relay server -> Gemini Live Translate
                                                        |
                                                        v
Listener browser <- translated audio + captions over WebSocket
```

The server keeps both Gemini API keys private, manages live sessions, fans speaker audio out to each active language stream, and broadcasts translated audio/captions back to listeners. Browser listeners use a continuous Web Audio playback queue that stays close to live and drops stale audio rather than drifting far behind.

## Free and paid Gemini options

The browser landing page shows a Free/Paid toggle below the weekly-session button. Free is selected on every fresh visit and is also the server fallback when a client does not send a selection.

| Option | When it is used | User guidance |
| --- | --- | --- |
| Free | Default for new and weekly sessions | Transmitted data is used to improve Google products. Use only with content that is not confidential. |
| Paid | Only after the speaker manually selects Paid | Use with discretion because it charges the app administrator. Appropriate for sensitive or confidential content; the data is not stored. |

The browser sends only the selected option to Glotta. Both API keys remain on the relay server, and every Gemini stream created for a session uses that session's selected key. The speaker page remembers the selection so recovery after a Render restart preserves it. Glotta streams audio and captions in memory and does not persist them to a database or file. The option is fixed for the life of an active session; reconnecting the weekly code with the other option shows an error instead of silently switching keys.

## Repository layout

| Folder | Purpose |
| --- | --- |
| `server/` | Express/WebSocket relay server and browser UI for speaker/listener pages. |
| `app/` | Expo React Native speaker app. |
| `docs/screenshots/` | README screenshots. |

## Prerequisites

- Node.js 20.19.4 or newer.
- Two Gemini API keys with access to Gemini Live Translate: one free-tier key and one paid-tier key.
- A public HTTPS deployment for real services, or a shared local network for testing.

## Run the relay server locally

Run these commands in **PowerShell**:

```powershell
cd "C:\Users\nafer\github repo\Glotta\server"
npm install
```

Create a `.env` file in `server/`:

```env
GEMINI_API_KEY_FREE=your-free-gemini-key
GEMINI_API_KEY_PAID=your-paid-gemini-key
PASSWORD=choose-a-speaker-password
LIVE_EDGE_MAX_QUEUE_SECONDS=0
```

Start the server:

```powershell
npm start
```

Then open `http://localhost:8080`, start a session, and share the QR/join link with listeners on the same network.

## Run the mobile speaker app

Run these commands in **PowerShell**:

```powershell
cd "C:\Users\nafer\github repo\Glotta\app"
npm install
```

Set the relay URL in `app/src/config.js` or type it in the app setup screen:

```js
export const DEFAULT_SERVER_URL = 'https://your-glotta-server.example.com';
```

For iOS device builds from Windows, use EAS Build:

```powershell
npm install -g eas-cli
eas login
eas build --platform ios --profile preview
```

## Deployment notes

Deploy `server/` to a Node host such as Render, Railway, Fly.io, or a VPS. Configure:

```env
GEMINI_API_KEY_FREE=your-free-gemini-key
GEMINI_API_KEY_PAID=your-paid-gemini-key
PASSWORD=choose-a-speaker-password
PUBLIC_BASE_URL=https://your-public-url.example.com
```

The relay server stores live sessions in memory, so free-tier hosts that sleep or restart can interrupt active sessions. The speaker page includes session revival logic to recreate the same QR code when possible, but a production deployment should use a host that stays awake during services.

## Reliability details

- Speaker audio is sent as small PCM chunks over WebSockets.
- Only one device can capture speaker audio for a session at a time; the lock starts with **Start speaking** and is released by **Stop speaking** or a disconnect.
- Browser speaker input can select external audio interfaces and chooses the strongest channel for sound-board feeds.
- Listener playback uses one continuous PCM queue with a small buffer, smooth underrun recovery, and stale-audio dropping.
- Listeners returning after a longer phone-app switch are asked to tap once to restart browser audio while captions remain connected.
- Live transcript and captions are capped in the browser to prevent long sermons from overloading the page.
- Gemini streams use session resumption and context compression across periodic connection replacements, with a short catch-up window for brief gaps.
- Audio queue, reconnect, first-output, and dropped-audio metrics are emitted as structured `[audio-metrics]` logs.
- `LIVE_EDGE_MAX_QUEUE_SECONDS` is an opt-in safety flag. Leave it at `0` for legacy behavior; set it to `1` for a one-second network-queue budget and a two-second listener buffer. Enabled values are capped at one second so Glotta's own buffering cannot exceed five seconds even if the setting is accidentally higher.
- A session automatically ends after 60 minutes without incoming speaker audio.

## License

MIT License. See [LICENSE](LICENSE).
