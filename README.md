# Move-a-thon

A simple lap counter for a school move-a-thon.

## Screens

- `/official` - phone tapper for race officials
- `/tv` - live display for the big screen, including special laps and journey progress
- `/admin` - event setup, active event switching, corrections, special laps, QR code, and CSV export

## Local Docker

```bash
docker compose up --build
```

Then open:

- `http://localhost:8000/admin`
- `http://localhost:8000/official`
- `http://localhost:8000/tv`

To use the official view from phones on the same Wi-Fi, open the app with your computer's local network address:

```text
http://YOUR-MAC-IP:8000/official
```

Defaults:

- Admin PIN: `1234`
- Initial official code: `run`

## Event Day Flow

1. Open `/admin` and sign in.
2. Create or activate the event.
3. Set the lap distance in miles.
4. Set the default special lap duration if needed.
5. Show the QR code to race officials.
6. Open `/tv` on the display screen.
7. Use the Special Lap panel in `/admin` to send a timed challenge to the TV.

The official phone view queues taps locally when offline or disconnected, then syncs them when the connection returns. Each tap has a unique client ID so retrying a sync does not double-count laps.
The TV view advances the East Coast journey from total event miles and automatically hides special laps when their timer ends.

## Railway

Create a Railway Postgres database, deploy this repo as a Docker image, and set:

```bash
DATABASE_URL=<railway postgres url>
ADMIN_PIN=<your admin pin>
SECRET_KEY=<long random string>
```
