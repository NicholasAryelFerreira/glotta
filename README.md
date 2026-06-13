# Glossolalia

Real-time translation of live sermons, powered by Google's
`gemini-3.5-live-translate-preview` model.

- **Speaker** opens the iOS app, starts a session, and speaks. Their voice is
  streamed to a relay server.
- **Receivers** scan a QR code, which opens a web page in their phone's browser.
  They pick a language and hear the translated audio (with live captions) in
  near real time. **No app install needed for listeners.**

One session can serve many languages at once — each language opens its own
Gemini translation stream on the server, shared by everyone listening in that
language.

```
 Speaker app (iOS) ──mic PCM──▶  Relay server (Node)  ──▶ Gemini Live Translate
                                       │                      (one stream per language)
   Receiver browser  ◀──translated audio + captions──┘
   (joins by QR code)
```

## Repository layout

| Folder    | What it is                                                          |
| --------- | ------------------------------------------------------------------- |
| `server/` | Node.js relay server + the receiver web pages (`/join/:id`).        |
| `app/`    | Expo (React Native) iOS speaker app.                                |

---

## Prerequisites

1. **A Google Gemini API key** with access to the Live Translate preview model.
   Get one at <https://aistudio.google.com/apikey>.
2. **Node.js 20.19.4 or newer.** You currently have an older 20.x — Expo SDK 56
   requires at least 20.19.4. Download the latest LTS from
   <https://nodejs.org/en/download> and install it before building the app.
3. The phone running the **speaker app** and the receivers' phones must be able
   to reach the relay server. For a quick test, putting everyone on the same
   Wi-Fi as the computer running the server is enough. For real services, deploy
   the server to a host with a public URL (see *Deploying the server*).

---

## 1. Run the relay server (Windows)

All commands below run in **PowerShell**.

1. Open PowerShell and go to the server folder:
   ```powershell
   cd "C:\Users\nafer\github repo\Glossolalia\server"
   ```
2. Install dependencies (only needed the first time):
   ```powershell
   npm install
   ```
3. Create your environment file from the template:
   ```powershell
   Copy-Item .env.example .env
   ```
4. Open `.env` in a text editor and paste your Gemini key:
   ```
   GEMINI_API_KEY=your-real-key-here
   ```
5. Start the server:
   ```powershell
   npm start
   ```
   You'll see something like:
   ```
   Glossolalia server listening on port 8080
     Local:   http://localhost:8080
     Network: http://192.168.1.36:8080
   ```
   **Write down the `Network:` address** — the speaker app needs it.

> Allow Node through the Windows Firewall the first time, or phones on the
> network won't be able to connect.

### Quick test without the app

You can try the whole pipeline from a browser before building the iOS app:

1. On the computer, open `http://localhost:8080` and click **Start a session**.
2. On a phone (same Wi-Fi), open the **join URL** shown under the QR code
   (e.g. `http://192.168.1.36:8080/join/ABC123`), pick a language, tap **listen**.
3. Back on the computer's speaker page, tap **Start speaking** and talk.

> Browser microphone access only works on `localhost` or over HTTPS. The
> computer's own speaker page works because it's on `localhost`; the **iOS app**
> is the proper speaker for real use.

---

## 2. Build & run the iOS speaker app

Because you're on Windows, you can't compile iOS locally — use **EAS Build**,
which compiles in the cloud and installs onto your iPhone.

1. Open a new PowerShell window and go to the app folder:
   ```powershell
   cd "C:\Users\nafer\github repo\Glossolalia\app"
   ```
2. Install dependencies (first time only):
   ```powershell
   npm install
   ```
3. Point the app at your server. Open `app/src/config.js` and set
   `DEFAULT_SERVER_URL` to the `Network:` address from step 1 (you can also
   change it on the app's setup screen each time):
   ```js
   export const DEFAULT_SERVER_URL = 'http://192.168.1.36:8080';
   ```
4. Install the EAS command-line tool and log in (free Expo account required —
   sign up at <https://expo.dev>):
   ```powershell
   npm install -g eas-cli
   eas login
   ```
5. Link the project to your Expo account (first time only):
   ```powershell
   eas init
   ```
6. Build a device build you can install on your iPhone:
   ```powershell
   eas build --platform ios --profile preview
   ```
   - EAS will ask to handle iOS signing credentials — let it manage them.
   - You'll need an **Apple Developer account** to install on a physical iPhone.
   - When the build finishes, open the link it prints on your iPhone (or scan
     the QR code) to install the app.

### Faster iteration (optional): Expo Go / dev client

For quick UI changes you can run the Metro dev server and connect from your
phone, but note the **microphone streaming uses a native module that does not
run in the standard Expo Go app**. Use a **development build**:

```powershell
eas build --platform ios --profile development
npx expo start --dev-client
```

Then open the dev build on your iPhone and scan the QR from `expo start`.

---

## 3. Use it in a service

1. Speaker opens the app → enters a title → **Start a session**.
2. The app shows a big QR code (and a short session code).
3. Display that QR on a screen / print it / put it in the bulletin.
4. Receivers scan it with their phone camera → the join page opens → they pick
   a language → tap **listen** → put in earphones.
5. Speaker taps **Start speaking**. Translated audio flows to every listener.
6. The speaker screen shows how many people are listening per language and a
   live transcript of what the model is hearing.
7. Tap **End session** when finished.

---

## Deploying the server (beyond same-Wi-Fi)

For real congregations you'll want the server on a public URL so receivers can
join over cellular data, and so browser audio works over HTTPS:

- Deploy `server/` to any Node host (Render, Railway, Fly.io, a VPS, etc.).
- Set `GEMINI_API_KEY` and, if needed, `PUBLIC_BASE_URL` (e.g.
  `https://translate.yourchurch.org`) so QR codes point at the public address.
- Put it behind HTTPS (most hosts do this automatically). Receiver audio
  playback and the QR join flow then work from any network.
- In the app, set the server address to that public URL.

### Protecting your API key

The current server holds the Gemini key and brokers all model traffic, so the
key is never exposed to phones — good. If you later move translation directly
into client apps, switch to **ephemeral tokens** (see the Gemini Live docs) so
the key stays on your server.

---

## How it works (for developers)

- **Audio in:** the app captures microphone audio with `expo-audio`'s
  `AudioStream` at 16 kHz mono `int16` PCM, base64-encodes each buffer, and
  sends it over a WebSocket (`/ws/speaker/:id`).
- **Fan-out:** the server forwards every incoming chunk to one
  `gemini-3.5-live-translate-preview` session **per active language**
  (`server/src/translator.js`). Sessions auto-reconnect if Gemini closes them
  (sermons outlast the per-session limit).
- **Audio out:** Gemini returns 24 kHz mono `int16` PCM, which the server
  broadcasts to every listener of that language over `/ws/listener/:id?lang=xx`.
  The receiver page schedules the chunks back-to-back through the Web Audio API.
- **Transcripts:** input transcription is mirrored to the speaker; output
  transcription is shown as captions to listeners.
- **Languages:** the full supported list lives in `server/src/languages.js`.

## Limitations to know about

- Voice replication can shift after long pauses or with multiple speakers
  (a model limitation, noted in the Gemini docs).
- Language detection can struggle with heavy accents or very similar languages;
  this mainly affects the *input* transcript, not the translation quality.
- The model filters music/noise but a loud worship band may still bleed through.
