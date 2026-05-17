import { createApp, computed, onMounted, onUnmounted, ref } from 'vue';
import QRCode from 'qrcode';
import './styles.css';

const specialLapPresets = [
  { name: 'Fast Lap', image_path: '/special-laps/Fast.png', prompt: 'Pick up the pace!' },
  { name: 'Loudest Lap', image_path: '/special-laps/Loudest.png', prompt: 'Make some noise!' },
  { name: 'One-Foot Lap', image_path: '/special-laps/Onefoot.png', prompt: 'Hop with care!' },
  { name: 'Pirate Lap', image_path: '/special-laps/Pirate.png', prompt: 'Sail around the course!' },
  { name: 'Quietest Lap', image_path: '/special-laps/Quietest.png', prompt: 'Sneak through silently!' },
  { name: 'Side-Foot Lap', image_path: '/special-laps/Sidefoot.png', prompt: 'Slide those feet sideways!' },
  { name: 'Skipped Lap', image_path: '/special-laps/Skipped.png', prompt: 'Skip all the way!' },
  { name: 'Slowest Lap', image_path: '/special-laps/Slowest.png', prompt: 'Take it slow and steady!' },
  { name: 'Bucketball Lap', image_path: '/special-laps/bucketball.png', prompt: 'Bring the bucketball energy!' },
  { name: 'Partner Lap', image_path: '/special-laps/partner.png', prompt: 'Find a buddy!' },
  { name: 'Two-Footed Lap', image_path: '/special-laps/two-footed.png', prompt: 'Jump forward together!' },
];

const formatDuration = (seconds) => {
  const safeSeconds = Math.max(0, Math.ceil(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
};

const getRemainingSeconds = (specialLap, now) => {
  if (!specialLap?.ends_at) return 0;
  return Math.max(0, Math.ceil((new Date(specialLap.ends_at).getTime() - now) / 1000));
};

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    ...options,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(body.detail || response.statusText);
  }
  return response.json();
};

const makeClientEntryId = () => {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
};

const openTapDb = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open('moveathon-official', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pending', { keyPath: 'client_entry_id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const txStore = async (mode = 'readonly') => {
  const db = await openTapDb();
  return db.transaction('pending', mode).objectStore('pending');
};

const addPendingTap = async (tap) => {
  const store = await txStore('readwrite');
  store.put(tap);
};

const deletePendingTap = async (id) => {
  const store = await txStore('readwrite');
  store.delete(id);
};

const getPendingTaps = async () =>
  new Promise(async (resolve, reject) => {
    const store = await txStore();
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const useLiveState = () => {
  const state = ref({
    school_name: 'Move-a-thon',
    special_lap_duration_seconds: 180,
    active_special_lap: null,
    journey: null,
    event: null,
    laps: 0,
    miles: 0,
  });
  const connected = ref(false);

  const load = async () => {
    state.value = await api('/api/state');
  };

  const connect = () => {
    const source = new EventSource('/api/live');
    source.onopen = () => {
      connected.value = true;
    };
    source.onerror = () => {
      connected.value = false;
    };
    source.onmessage = (message) => {
      state.value = JSON.parse(message.data);
    };
  };

  onMounted(async () => {
    await load().catch(() => {});
    connect();
  });

  return { state, connected, load };
};

const Nav = {
  template: `
    <nav class="nav">
      <a href="/official">Official</a>
      <a href="/tv">TV</a>
      <a href="/admin">Admin</a>
    </nav>
  `,
};

const Official = {
  components: { Nav },
  setup() {
    const { state, connected } = useLiveState();
    const code = ref('');
    const loggedIn = ref(false);
    const error = ref('');
    const pending = ref(0);
    const localAdds = ref(0);
    const syncing = ref(false);

    const visibleLaps = computed(() => (state.value.laps || 0) + localAdds.value);
    const visibleMiles = computed(() => visibleLaps.value * (state.value.event?.lap_distance_miles || 0));

    const refreshPending = async () => {
      pending.value = (await getPendingTaps()).length;
      localAdds.value = pending.value;
    };

    const login = async () => {
      error.value = '';
      try {
        await api('/api/official/login', { method: 'POST', body: JSON.stringify({ code: code.value }) });
        loggedIn.value = true;
        await sync();
      } catch (err) {
        error.value = err.message;
      }
    };

    const sync = async () => {
      if (syncing.value) return;
      syncing.value = true;
      try {
        const entries = await getPendingTaps();
        if (!entries.length) {
          await refreshPending();
          return;
        }
        const result = await api('/api/laps/batch', { method: 'POST', body: JSON.stringify({ entries }) });
        await Promise.all(entries.map((entry) => deletePendingTap(entry.client_entry_id)));
        state.value = result.state;
        await refreshPending();
      } catch {
        await refreshPending();
      } finally {
        syncing.value = false;
      }
    };

    const tap = async () => {
      const entry = {
        client_entry_id: makeClientEntryId(),
        client_created_at: new Date().toISOString(),
      };
      await addPendingTap(entry);
      await refreshPending();
      sync();
    };

    onMounted(async () => {
      await refreshPending();
      window.addEventListener('online', sync);
      setInterval(sync, 4000);
    });

    return { state, connected, code, loggedIn, error, pending, visibleLaps, visibleMiles, login, tap, sync };
  },
  template: `
    <main class="screen official">
      <Nav />
      <section v-if="!loggedIn" class="login-panel">
        <h1>Official Check-In</h1>
        <form @submit.prevent="login" class="login-form">
          <input v-model="code" autocomplete="off" inputmode="text" placeholder="Official code" />
          <button type="submit">Join</button>
        </form>
        <p v-if="error" class="error">{{ error }}</p>
      </section>

      <section v-else class="tap-area">
        <div class="mini-status">
          <span>{{ state.event?.name || 'No active event' }}</span>
          <span :class="{ online: connected }">{{ connected ? 'live' : 'reconnecting' }}</span>
        </div>
        <button class="tap-button" :disabled="!state.event" @pointerdown.prevent="tap">+1 Lap</button>
        <div class="official-totals">
          <strong>{{ visibleLaps.toLocaleString() }}</strong>
          <span>laps</span>
          <strong>{{ visibleMiles.toFixed(2) }}</strong>
          <span>miles</span>
        </div>
        <button class="secondary" @click="sync">Sync now</button>
        <p class="sync-note">{{ pending }} waiting to sync</p>
      </section>
    </main>
  `,
};

const TV = {
  components: { Nav },
  setup() {
    const { state, connected } = useLiveState();
    const now = ref(Date.now());
    const journey = computed(() => state.value.journey || {});
    const activeSpecialLap = computed(() => {
      const specialLap = state.value.active_special_lap;
      return getRemainingSeconds(specialLap, now.value) > 0 ? specialLap : null;
    });
    const specialPrompt = computed(() => {
      const preset = specialLapPresets.find((item) => item.image_path === activeSpecialLap.value?.image_path);
      return preset?.prompt || 'Make this lap count!';
    });
    const specialRemaining = computed(() => getRemainingSeconds(activeSpecialLap.value, now.value));
    const specialCountdown = computed(() => formatDuration(specialRemaining.value));
    const distanceToNext = computed(() => Number(journey.value.distance_to_next || 0).toFixed(1));
    const reachedStops = computed(() => (journey.value.stops || []).filter((stop) => stop.reached).length);
    const routeFocusStops = computed(() => {
      const stops = journey.value.stops || [];
      if (!stops.length) return [];
      const currentIndex = Math.max(0, stops.findLastIndex((stop) => stop.reached));
      const focusIndexes = [0, currentIndex, currentIndex + 1, currentIndex + 2, stops.length - 1];
      return [...new Set(focusIndexes)]
        .filter((index) => index >= 0 && index < stops.length)
        .map((index) => ({
          ...stops[index],
          role: index === 0
            ? 'Start'
            : index === stops.length - 1
              ? 'Finish'
              : index === currentIndex
                ? 'Reached'
                : 'Next',
        }));
    });
    let timer;

    onMounted(() => {
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    });

    onUnmounted(() => {
      clearInterval(timer);
    });

    return {
      state,
      connected,
      journey,
      activeSpecialLap,
      specialPrompt,
      specialCountdown,
      distanceToNext,
      reachedStops,
      routeFocusStops,
    };
  },
  template: `
    <main class="screen tv">
      <Nav />
      <section class="tv-stage">
        <div class="tv-head">
          <p>{{ state.school_name }} <span>{{ state.event?.name || 'No active event' }}</span></p>
          <span :class="{ online: connected }">{{ connected ? 'live' : 'reconnecting' }}</span>
        </div>
        <div class="scoreboard">
          <div>
            <strong>{{ (state.laps || 0).toLocaleString() }}</strong>
            <span>laps</span>
          </div>
          <div>
            <strong>{{ (state.miles || 0).toFixed(2) }}</strong>
            <span>miles</span>
          </div>
        </div>
        <section v-if="journey.current" class="journey-panel">
          <div class="journey-copy">
            <p>{{ journey.title }}</p>
            <h2>{{ journey.completed ? 'We made it to Washington, DC!' : 'Now passing: ' + journey.current.name }}</h2>
            <strong v-if="journey.next">Next up: {{ journey.next.name }} - {{ distanceToNext }} miles away</strong>
            <strong v-else>Destination reached</strong>
          </div>
          <div class="route-bar" aria-hidden="true">
            <span :style="{ width: (journey.progress_percent || 0) + '%' }"></span>
          </div>
          <ol class="route-stops">
            <li
              v-for="stop in routeFocusStops"
              :key="stop.name"
              :class="{ reached: stop.reached, major: stop.major, finish: stop.role === 'Finish' }"
            >
              <span></span>
              <em>{{ stop.role }}</em>
              <strong>{{ stop.name }}</strong>
              <small>{{ stop.distance }} miles from Cambridge</small>
            </li>
          </ol>
          <div class="journey-stats">
            <span>{{ Math.min(journey.miles || 0, journey.total_distance || 0).toFixed(1) }} / {{ journey.total_distance }} route miles</span>
            <span>{{ reachedStops }} towns reached</span>
          </div>
        </section>
        <section v-if="activeSpecialLap" class="special-tv">
          <img :src="activeSpecialLap.image_path" :alt="activeSpecialLap.name" />
          <div>
            <p>Special lap</p>
            <h2>{{ activeSpecialLap.name }}</h2>
            <strong>{{ specialPrompt }}</strong>
          </div>
          <time>{{ specialCountdown }}</time>
        </section>
      </section>
    </main>
  `,
};

const Admin = {
  components: { Nav },
  setup() {
    const { state, connected, load } = useLiveState();
    const pin = ref('');
    const loggedIn = ref(false);
    const error = ref('');
    const events = ref([]);
    const schoolName = ref('');
    const correction = ref(1);
    const qr = ref('');
    const form = ref({ name: 'Move-a-thon 2026', lap_distance_miles: 0.25, official_code: 'run' });
    const edit = ref(null);
    const specialDurationMinutes = ref(3);
    const now = ref(Date.now());
    const activeSpecialLap = computed(() => {
      const specialLap = state.value.active_special_lap;
      return getRemainingSeconds(specialLap, now.value) > 0 ? specialLap : null;
    });
    const specialCountdown = computed(() => formatDuration(getRemainingSeconds(activeSpecialLap.value, now.value)));

    const refresh = async () => {
      await load();
      schoolName.value = state.value.school_name;
      specialDurationMinutes.value = Math.max(1, Math.round((state.value.special_lap_duration_seconds || 180) / 60));
      events.value = await api('/api/events');
      await makeQr();
    };

    const login = async () => {
      error.value = '';
      try {
        await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ code: pin.value }) });
        loggedIn.value = true;
        await refresh();
      } catch (err) {
        error.value = err.message;
      }
    };

    const makeQr = async () => {
      qr.value = await QRCode.toDataURL(`${window.location.origin}/official`, { margin: 1, width: 220 });
    };

    const saveSettings = async () => {
      await api('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({
          school_name: schoolName.value,
          special_lap_duration_seconds: Number(specialDurationMinutes.value) * 60,
        }),
      });
      await refresh();
    };

    const createEvent = async () => {
      await api('/api/events', { method: 'POST', body: JSON.stringify(form.value) });
      form.value = { name: '', lap_distance_miles: form.value.lap_distance_miles, official_code: form.value.official_code };
      await refresh();
    };

    const startEdit = (event) => {
      edit.value = { ...event, official_code: '' };
    };

    const saveEdit = async () => {
      await api(`/api/events/${edit.value.id}`, { method: 'PATCH', body: JSON.stringify(edit.value) });
      edit.value = null;
      await refresh();
    };

    const activate = async (event) => {
      await api(`/api/events/${event.id}/activate`, { method: 'POST' });
      await refresh();
    };

    const addCorrection = async () => {
      await api('/api/admin/correction', { method: 'POST', body: JSON.stringify({ delta: Number(correction.value) }) });
      await refresh();
    };

    const startSpecialLap = async (preset) => {
      state.value = await api('/api/admin/special-lap', { method: 'POST', body: JSON.stringify(preset) });
    };

    const clearSpecialLap = async () => {
      state.value = await api('/api/admin/special-lap', { method: 'DELETE' });
    };

    const exportUrl = (event) => `/api/admin/export/${event.id}.csv`;

    let timer;
    onMounted(() => {
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    });

    onUnmounted(() => {
      clearInterval(timer);
    });

    return {
      state, connected, pin, loggedIn, error, events, schoolName, correction, qr, form, edit, specialDurationMinutes,
      specialLapPresets, activeSpecialLap, specialCountdown,
      login, refresh, saveSettings, createEvent, startEdit, saveEdit, activate, addCorrection, startSpecialLap,
      clearSpecialLap, exportUrl,
    };
  },
  template: `
    <main class="screen admin">
      <Nav />
      <section v-if="!loggedIn" class="login-panel">
        <h1>Admin</h1>
        <form @submit.prevent="login" class="login-form">
          <input v-model="pin" type="password" inputmode="text" autocomplete="off" placeholder="Admin PIN" />
          <button type="submit">Unlock</button>
        </form>
        <p v-if="error" class="error">{{ error }}</p>
      </section>

      <section v-else class="admin-grid">
        <div class="panel summary">
          <div>
            <p>Active event</p>
            <h1>{{ state.event?.name || 'None' }}</h1>
          </div>
          <div class="summary-numbers">
            <strong>{{ (state.laps || 0).toLocaleString() }}</strong><span>laps</span>
            <strong>{{ (state.miles || 0).toFixed(2) }}</strong><span>miles</span>
          </div>
          <span :class="{ online: connected }">{{ connected ? 'live' : 'reconnecting' }}</span>
        </div>

        <div class="panel">
          <h2>School</h2>
          <form @submit.prevent="saveSettings" class="inline-form">
            <input v-model="schoolName" />
            <label class="field-label">
              Special lap minutes
              <input v-model.number="specialDurationMinutes" type="number" min="1" max="60" step="1" />
            </label>
            <button>Save</button>
          </form>
        </div>

        <div class="panel wide special-admin">
          <div class="panel-head">
            <div>
              <h2>Special Lap</h2>
              <p v-if="activeSpecialLap" class="muted">Showing {{ activeSpecialLap.name }} for {{ specialCountdown }}</p>
              <p v-else class="muted">Pick one to send it to the TV for {{ specialDurationMinutes }} minutes.</p>
            </div>
            <button v-if="activeSpecialLap" class="secondary" @click="clearSpecialLap">Clear</button>
          </div>
          <div class="special-grid">
            <button
              v-for="preset in specialLapPresets"
              :key="preset.image_path"
              class="special-choice"
              @click="startSpecialLap(preset)"
            >
              <img :src="preset.image_path" :alt="preset.name" />
              <span>{{ preset.name }}</span>
            </button>
          </div>
        </div>

        <div class="panel">
          <h2>Official QR</h2>
          <img v-if="qr" class="qr" :src="qr" alt="Official page QR code" />
          <p class="muted">Officials scan this, then enter the active event's official code.</p>
        </div>

        <div class="panel">
          <h2>Correction</h2>
          <form @submit.prevent="addCorrection" class="inline-form">
            <input v-model.number="correction" type="number" />
            <button>Apply</button>
          </form>
        </div>

        <div class="panel wide">
          <h2>Create Event</h2>
          <form @submit.prevent="createEvent" class="event-form">
            <input v-model="form.name" placeholder="Event name" />
            <input v-model.number="form.lap_distance_miles" type="number" min="0.001" step="0.001" />
            <input v-model="form.official_code" placeholder="Official code" />
            <button>Create</button>
          </form>
        </div>

        <div class="panel wide">
          <h2>Events</h2>
          <table>
            <thead><tr><th>Name</th><th>Laps</th><th>Miles/lap</th><th>Status</th><th></th></tr></thead>
            <tbody>
              <tr v-for="event in events" :key="event.id">
                <td>{{ event.name }}</td>
                <td>{{ event.laps.toLocaleString() }}</td>
                <td>{{ Number(event.lap_distance_miles).toFixed(3) }}</td>
                <td>{{ event.is_active ? 'active' : 'saved' }}</td>
                <td class="actions">
                  <button class="secondary" @click="activate(event)" :disabled="event.is_active">Activate</button>
                  <button class="secondary" @click="startEdit(event)">Edit</button>
                  <a :href="exportUrl(event)">Export</a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="edit" class="modal">
          <form @submit.prevent="saveEdit" class="panel edit-panel">
            <h2>Edit Event</h2>
            <input v-model="edit.name" />
            <input v-model.number="edit.lap_distance_miles" type="number" min="0.001" step="0.001" />
            <input v-model="edit.official_code" placeholder="New official code, optional" />
            <div class="actions">
              <button>Save</button>
              <button type="button" class="secondary" @click="edit = null">Cancel</button>
            </div>
          </form>
        </div>
      </section>
    </main>
  `,
};

const App = {
  computed: {
    page() {
      if (window.location.pathname.startsWith('/admin')) return Admin;
      if (window.location.pathname.startsWith('/tv')) return TV;
      return Official;
    },
  },
  template: '<component :is="page" />',
};

createApp(App).mount('#app');
