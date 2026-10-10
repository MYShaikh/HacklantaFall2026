# CallGuard

An Android app (React Native) plus a small server (Django) for screening phone calls:

- shows your **call log** and **texts**
- lets you **block** and **report** numbers
- when a call comes in, shows a **card over whatever you're doing**; for known spam it's a big **red card in the middle of the screen** with one button that **blocks the number and hangs up**
- a **Pause** button silences the ringer without hanging up on the caller

> **For personal testing only.** It is installed by hand (sideloaded), not from the Play Store. Everything stays on
> the computer that runs the server and on your own phone.

```
Hacklanta/
├── backend/             Django REST API (accounts, block list, reports, scam-call log)
├── app/                 React Native app (Android)
├── docker-compose.yml   starts the backend with one command
├── CallGuard.apk        the ready-made app (if the person who shared this gave you one)
└── README.md
```

How the pieces fit: **the phone talks to the server over your Wi-Fi.** The server keeps the database (`db.sqlite3`).
The app does not contain the database. Install the APK on as many phones as you like, but they all need to reach a
running server.

---

## What you need

| For | You need |
|---|---|
| The server (one computer) | **Docker Desktop**, or Python 3.12+ if you'd rather not use Docker |
| The phone | An **Android 10 or newer** phone, on the **same Wi-Fi** as the server computer |
| Building the app yourself (optional) | Node 20+, JDK 17, Android SDK. Skip this if you were given `CallGuard.apk` |

---

## Part 1: Start the server

### Option A: Docker (recommended)

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it, then open a terminal in this folder:

```bash
docker compose up --build
```

The first run downloads Python and installs the packages, then starts the server on port **8000**. Leave the terminal
open. Stop it with `Ctrl+C`.

Check it works: open <http://localhost:8000/admin/> in your browser. You should see a Django login page.

Other Docker commands:

```bash
docker compose up -d                       # run in the background
docker compose logs -f backend             # watch the log
docker compose down                        # stop (your data is kept)
docker compose down -v                     # stop AND delete the database
docker compose exec backend python manage.py test    # run the backend tests
```

The database lives in a Docker volume called `callguard-data`, so it survives restarts and rebuilds. To copy it out as a
backup: `docker compose cp backend:/data/db.sqlite3 ./db-backup.sqlite3`.

### Option B: Without Docker

Windows (PowerShell):

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # if scripts are blocked: Set-ExecutionPolicy -Scope Process Bypass
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 0.0.0.0:8000
```

macOS / Linux:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 0.0.0.0:8000
```

`0.0.0.0` matters: it lets your phone reach the server. (`runserver` on its own only accepts connections from the same computer.)

### Optional: an admin login to browse the data

With Docker:

```bash
docker compose exec backend python manage.py createsuperuser
```

Without Docker (with the virtual environment active, inside `backend/`):

```bash
python manage.py createsuperuser
```

Then go to <http://localhost:8000/admin/> and log in. Under **BLOCKING** you can see the **Blocked numbers**, **Reports** and
**Scam calls** tables. (This admin login is separate from the accounts people create in the app.)

### Find the server's address (you need it for the phone)

The phone can't use `localhost`. It needs the server computer's address on your Wi-Fi:

- Windows: run `ipconfig` and look for **IPv4 Address** (like `192.168.1.23`)
- macOS: `ipconfig getifaddr en0`
- Linux: `hostname -I`

Your server address is then `http://192.168.1.23:8000` (use your own numbers).

**Windows Firewall:** the first time, Windows may ask whether to allow Docker or Python on the network. Allow it for
**private** networks. If the phone can't connect later, this is the usual reason.

---

## Part 2: Install the app on the phone

### If you have `CallGuard.apk`

1. Copy `CallGuard.apk` to the phone (USB cable, Google Drive, email to yourself, anything).
2. Tap it. If Android asks, allow **installing unknown apps** for the app you opened it from (Files, Chrome, ...).
3. Open **CallGuard**. On the login screen:
   - **Server address**: type `http://<server computer's address>:8000`. It's pre-filled with the original author's address, so **you must change it**.
   - Pick a **username** and a **password (8+ characters)**, then tap **Create account**.

> Turn **off any VPN** on the phone while testing. A VPN sends traffic away from your home network, so the phone
> can't find the server.

### If you want to build the app yourself

You need Node 20+, JDK 17 (the one inside Android Studio works) and the Android SDK (install Android Studio).

```bash
cd app
npm install
cd android
echo "sdk.dir=/path/to/your/Android/Sdk" > local.properties    # Windows: sdk.dir=C\:\\Users\\you\\AppData\\Local\\Android\\Sdk
./gradlew assembleRelease                                       # Windows: .\gradlew assembleRelease
```

The finished app is `app/android/app/build/outputs/apk/release/app-release.apk`. On Windows, if `java` isn't found, set
`JAVA_HOME` to Android Studio's `jbr` folder first, for example
`$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'`.

`npm install` also applies a small fix to an old SMS library (`app/patches/`) automatically.

---

## Part 3: One-time phone setup

Android guards these features, so you have to switch them on by hand. Do them in this order. The app's **Setup** tab has
a button for each of these that opens the right screen, and shows which ones are done.

1. **Allow restricted settings** (Android 13+ and apps installed from a file): *Settings → Apps → CallGuard → ⋮ (top right) → Allow restricted settings*. The ⋮ only appears after the app has been refused a permission once, so open the app first and let it ask.
2. **Call log and SMS**: *Settings → Apps → CallGuard → Permissions* → allow **SMS** and **Call logs** (Android may call it "Phone").
3. **Caller ID & spam app**: *Settings → Apps → Default apps → Caller ID & spam app → CallGuard*. **Without this, Android never tells CallGuard about incoming calls and nothing else works.**
4. **Display over other apps**: *Settings → Apps → Special app access → Display over other apps → CallGuard → Allow*. This lets the card appear over what you're doing.
5. **Answer phone calls** (allow when asked): lets the red button hang up the call.
6. **Do Not Disturb access** (only for the **Pause** button): *Settings → Apps → Special app access → Do Not Disturb access → CallGuard*.
7. **Notifications** (allow when asked), and on Android 14+ also *Full-screen notifications* for CallGuard, which is used when the phone is locked.

Menu names vary a little between phone makers (Samsung, Xiaomi, ...). If you can't find one, search for its name in Settings.

---

## Using the app

Bottom tabs:

| Tab | What it does |
|---|---|
| 📞 **Calls** | Your call log. Each number has **Check**, **Block** and **Report**. Numbers other users reported show a red **⚠ Spam** tag. |
| 💬 **Texts** | Your text messages, with the same actions. |
| 🎙️ **Voicemail** | A button that dials your voicemail, plus notes on recording calls with Google Voice. |
| 🚫 **Blocked** | Your block list: add a number, **Unblock** one, or **Unblock all**. |
| ⚙️ **Setup** | A checklist of the one-time permissions (✓ done, ✗ missing, ○ Android won't let the app check), a button for each that opens the right settings page, the **Silently reject known spam** switch, what happened on the last screened call, and **Log out**. |

**When a call comes in** (and isn't blocked):

- a card appears across the top with the number and how many users reported it: **Block**, **Open**, **Dismiss**, and **Pause (silence ringing)**
- if the number is **known spam** (labelled "Scam Likely" by your phone/carrier, in your scam-call log, or reported by 2+ users) the card becomes a **red card in the middle of the screen** with a giant button: **block the number and end the call**
- **Pause** silences the ringer and vibration for 10 minutes and does **not** hang up the caller

A number you block yourself is rejected silently from then on. Known spam is *not* rejected silently unless you turn on
**Silently reject known spam** on the Setup tab.

Every time you open the app (or pull down on a list), it looks at your last 50 calls; any the phone labelled
"Scam Likely" / "Spam" / "Fraud" are **logged and reported** (not blocked).

### Trying the red card without a real spam call

1. Call your phone from another number once and note the number shown on the **Calls** tab.
2. In the admin (<http://localhost:8000/admin/>) open **Scam calls → Add**: your user, the number as `+1` followed by 10 digits, any label, and the current time.
3. Pull down to refresh in the app, then call again: the red card should appear.
4. Clean up afterwards: delete the row in the admin and unblock the number if you blocked it.

---

## Troubleshooting

| Problem | Try this |
|---|---|
| Red banner "Can't reach the server", or login fails | Phone and computer on the **same Wi-Fi**? **VPN off**? Server running? Correct address (check `ipconfig` again, it can change)? Test in the phone's browser: `http://<address>:8000/api/lookup/` should show "Authentication credentials were not provided". If it times out, it's the firewall. |
| Texts/calls are empty, "App was denied access" | Part 3, steps 1 and 2. |
| No card appears on calls | **Setup** tab → *Last screened call* shows what CallGuard did on the last call. Check Part 3, steps 3 and 4. A call with a hidden number shows "Hidden number". Calls made over a VoIP app (for example the Google Voice app calling over data) may bypass Android's call screening entirely. |
| The red button doesn't hang up | Allow **Answer phone calls** (Part 3, step 5). Some phones refuse to end a call from an app; decline it yourself. |
| Pause does nothing | Part 3, step 6. |
| `port is already allocated` / port 8000 in use | Another copy of the server is running. Stop it, or change `"8000:8000"` in `docker-compose.yml` to `"8001:8000"` and use `:8001` in the app. |
| `docker compose` not found | Install Docker Desktop and make sure it's running. |

---

## Good to know

- **Not encrypted.** The app talks to the server over plain `http` on your home network, and the server is Django's development server with `DEBUG` on. Don't expose it to the internet.
- **Reports are shared among everyone using the same server.** A number counts as spam when **2 different accounts** reported it (each account can report a number once).
- **Voicemail:** Android doesn't let regular apps read or play carrier voicemail, so CallGuard can't. The Voicemail tab only dials your voicemail.
- **Call recording is not possible** in a regular app (Android doesn't give apps the other person's audio). Google Voice has its own recorder; the Voicemail tab explains how. Recording laws differ by place, and many require everyone's consent.
- **Unblocking** works for numbers blocked inside CallGuard. Blocks in your phone's own settings, from your carrier or in Google Voice can't be seen or changed by CallGuard.
- Your login token and the server address are saved on the phone. Uninstalling the app erases those; your data on the server stays.

## Running the tests

```bash
# backend (15 tests)
cd backend && python manage.py test        # or: docker compose exec backend python manage.py test

# app (number normalisation and scam-label detection)
cd app && npx jest
```
