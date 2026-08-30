  // ---------------- authenticated fetch ----------------
  // Login stores a token; before this nothing ever sent it, so the server had
  // no way to know who was calling and every route answered anyone. Wrapping
  // fetch once is deliberate: there are ~80 call sites in this file and any
  // one of them forgotten would be a silent hole rather than a visible break.
  (function installAuthFetch() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const sameOrigin = url.startsWith('/') || url.startsWith(location.origin);
        const token = localStorage.getItem('logbridge_auth_token');
        if (sameOrigin && token) {
          init = { ...(init || {}) };
          const headers = new Headers((init && init.headers) || (typeof input === 'object' && input.headers) || {});
          if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + token);
          init.headers = headers;
        }
      } catch { /* never let auth plumbing break a request */ }
      return nativeFetch(input, init);
    };
  })();

    // ============================================================
    // LogBridge Office — real-time renderer.
    //
    // Every sprite here is placed from server-authoritative state
    // received over the WebSocket (`ServerMessage` from
    // packages/protocol). There is no client-side simulation:
    // if nothing moved on the server, nothing moves on screen.
    // See CONTRACT.md — "position is a pure function of state".
    // ============================================================

    const TILE = 32;
    const COLS = 64;
    const ROWS = 46;
    const MAP_WIDTH = COLS * TILE;
    const MAP_HEIGHT = ROWS * TILE;

    const STATUS_COLOR = {
      idle: 0x8a99b5,
      working: 0x00e676,
      waiting: 0x8a99b5,
      blocked: 0xffd740,
      needs_input: 0xff5252,
      reviewing: 0x00e5ff,
      completed: 0x00e5ff,
      failed: 0xff5252,
    };
    const ZONE_BADGE = {
      idle: ["IDLE", "badge-idle"],
      working: ["WORKING", "badge-working"],
      reviewing: ["REVIEWING", "badge-working"],
      collaborating: ["MEETING", "badge-collaborating"],
      blocked: ["BLOCKED", "badge-blocked"],
      needs_human: ["NEEDS HUMAN", "badge-needs_human"],
      done: ["DONE", "badge-idle"],
    };
    const CHAR_NAMES = ["nancy", "adam", "ash", "lucy"];

    const DIR_FRAMES = {
      idle: { right: [0,1,2,3,4,5], up: [6,7,8,9,10,11], left: [12,13,14,15,16,17], down: [18,19,20,21,22,23] },
      run:  { right: [24,25,26,27,28,29], up: [30,31,32,33,34,35], left: [36,37,38,39,40,41], down: [42,43,44,45,46,47] },
    };

    // ---------------- zone geometry: read from office.json, never duplicated by hand ----------------
    // See DESIGN-GUIDE.md "Carpets, not rug sprites" / CONTRACT.md §"Zone → room in the map".
    const zones = {
      cabin: [],      // sorted by index, cabinRects[0] = boss
      working: [],    // sorted by order
      blocked: null, reviewing: null, collaborating: null, idle: null, done: null,
    };
    let spawnTile = { x: 8, y: 30 };

    // Tiled's rotation flags, packed into the top bits of a gid.
    // Walls store vertical runs rotated 90deg (FLIP_D|FLIP_H) — see DESIGN-GUIDE.md.
    const FLIP_H = 0x80000000, FLIP_V = 0x40000000, FLIP_D = 0x20000000;
    const GID_MASK = 0x1fffffff;

    // ---------------- real tileset atlas: built from office.json's own tileset list ----------------
    // No hardcoded tileset names or gid ranges — whatever tilesets the map actually
    // references get loaded, in the order it references them. Add a tileset to the
    // map and this renderer picks it up with no code change.
    let tilesetRanges = [];   // [{ firstgid, lastgid, columns, baseTexture }], sorted by firstgid
    const textureCache = new Map(); // maskedGid -> PIXI.Texture (flip is applied on the sprite, not the texture)

    async function loadTilesets(map) {
      const loaded = await Promise.all(
        map.tilesets.map(async (t) => {
          const baseTexture = await PIXI.Texture.fromURL(`/assets/${t.image}`);
          return {
            firstgid: t.firstgid,
            lastgid: t.firstgid + t.tilecount - 1,
            columns: t.columns,
            tileWidth: t.tilewidth,
            tileHeight: t.tileheight,
            baseTexture: baseTexture.baseTexture,
          };
        })
      );
      tilesetRanges = loaded.sort((a, b) => a.firstgid - b.firstgid);
    }

    function textureForGid(maskedGid) {
      if (maskedGid === 0) return null;
      let cached = textureCache.get(maskedGid);
      if (cached) return cached;
      // firstgid ranges don't overlap, so a linear scan over 9 tilesets is cheap
      // and only runs once per unique gid (results are cached above).
      const ts = tilesetRanges.find((t) => maskedGid >= t.firstgid && maskedGid <= t.lastgid);
      if (!ts) { console.warn('gid out of range, no tileset owns it:', maskedGid); return null; }
      const localIndex = maskedGid - ts.firstgid;
      const col = localIndex % ts.columns;
      const row = Math.floor(localIndex / ts.columns);
      const rect = new PIXI.Rectangle(col * ts.tileWidth, row * ts.tileHeight, ts.tileWidth, ts.tileHeight);
      const tex = new PIXI.Texture(ts.baseTexture, rect);
      textureCache.set(maskedGid, tex);
      return tex;
    }

    // Draws one tile layer as real sprites — not a flattened image. Order matters:
    // layers are added in office.json's own order (floor -> deco -> walls -> props
    // -> props2 -> props3), so later layers correctly draw over earlier ones.
    function renderTileLayer(layer) {
      const container = new PIXI.Container();
      container.name = layer.name;
      for (let i = 0; i < layer.data.length; i++) {
        const raw = layer.data[i];
        if (!raw) continue;
        const flipH = !!(raw & FLIP_H);
        const flipD = !!(raw & FLIP_D);
        const tex = textureForGid(raw & GID_MASK);
        if (!tex) continue;

        const col = i % COLS, row = Math.floor(i / COLS);
        const sprite = new PIXI.Sprite(tex);
        if (flipD && flipH) {
          // 90deg clockwise: the only rotation this map actually uses (vertical walls)
          sprite.anchor.set(0.5);
          sprite.x = col * TILE + TILE / 2;
          sprite.y = row * TILE + TILE / 2;
          sprite.rotation = Math.PI / 2;
        } else {
          sprite.x = col * TILE;
          sprite.y = row * TILE;
        }
        container.addChild(sprite);
      }
      return container;
    }

    async function loadMap() {
      const res = await fetch('/assets/office.json');
      const map = await res.json();

      await loadTilesets(map);

      // real tiles, drawn in the map's own layer order, floor first
      for (const layer of map.layers) {
        if (layer.type !== 'tilelayer') continue;
        worldContainer.addChild(renderTileLayer(layer));
      }

      const wallLayer = map.layers.find((l) => l.name === 'walls');
      if (wallLayer && wallLayer.data) {
        for (let i = 0; i < wallLayer.data.length; i++) {
          if (wallLayer.data[i] & GID_MASK) wallCollisionGrid[i] = 1;
        }
      }

      const zoneLayer = map.layers.find((l) => l.name === 'zones');
      const cabinRects = [];
      const workingRects = [];
      for (const o of zoneLayer.objects) {
        const props = Object.fromEntries((o.properties ?? []).map((p) => [p.name, p.value]));
        const rect = { x: o.x / TILE, y: o.y / TILE, w: o.width / TILE, h: o.height / TILE };
        if (o.name === 'cabin') cabinRects[props.index] = rect;
        else if (o.name === 'working') workingRects[props.order] = rect;
        else zones[o.name] = rect;
      }
      zones.cabin = cabinRects;
      zones.working = workingRects;

      const markerLayer = map.layers.find((l) => l.name === 'markers');
      const spawn = markerLayer?.objects.find((o) => o.name === 'spawn');
      if (spawn) spawnTile = { x: spawn.x / TILE, y: spawn.y / TILE };
    }

    // Pack `slot` into a simple grid inside a tile-space rect. Real position comes from the
    // server (zone + slot); this only decides *where inside the room* that slot sits.
    function packSlot(rect, slot) {
      if (!rect) return { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
      const cols = Math.max(1, Math.floor(rect.w / 2));
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      return {
        x: (rect.x + col * 2 + 1) * TILE,
        y: (rect.y + row * 2 + 1) * TILE,
      };
    }

    function positionForAgent(a) {
      if (a.zone === 'needs_human' && a.zoneAnchor != null) {
        return packSlot(zones.cabin[a.zoneAnchor], 0);
      }
      if (a.zone === 'working') {
        const perRect = 3; // matches the 3-desk-per-pod layout in tools/build_office.py
        const rect = zones.working[Math.floor(a.slot / perRect)] ?? zones.working[0];
        return packSlot(rect, a.slot % perRect);
      }
      return packSlot(zones[a.zone], a.slot);
    }

    function positionForHuman(h) {
      if (h.position) return { x: h.position.x * TILE, y: h.position.y * TILE };
      if (h.cabin != null) return packSlot(zones.cabin[h.cabin], 0);
      return { x: spawnTile.x * TILE, y: spawnTile.y * TILE };
    }

    // ---------------- Idle roaming (Phase 1): deterministic, confined ----------------
    // No Math.random() — two browsers must see the same office. Position is a
    // pure function of (agentId, sharedClockBucket). The shared clock is
    // view.serverTime anchored to local elapsed, so motion is continuous
    // between server pushes without diverging. Roaming never leaves the idle
    // zone; that is the exact lie D11 forbids.
    const ROAM_INTERVAL_MS = 3500;
    const ROAM_MARGIN_PX = 24; // keeps a 32px sprite fully inside the 608x160 idle rect

    function roamHash(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return Math.abs(h);
    }

    function idlePixelRect() {
      const r = zones.idle;
      if (!r) return null;
      return { x: r.x * TILE, y: r.y * TILE, w: r.w * TILE, h: r.h * TILE };
    }

    function roamingPoint(agentId, bucket, rect, margin) {
      margin = margin ?? ROAM_MARGIN_PX;
      if (!rect || rect.w <= margin * 2 || rect.h <= margin * 2) {
        return rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
                     : { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
      }
      const usableW = rect.w - margin * 2;
      const usableH = rect.h - margin * 2;
      const hx = roamHash(agentId + ':x:' + bucket);
      const hy = roamHash(agentId + ':y:' + bucket);
      return {
        x: rect.x + margin + (hx % usableW),
        y: rect.y + margin + (hy % usableH),
      };
    }

    // ⚠️ These roaming/animation helpers are a HAND COPY of
    // packages/protocol/src/roaming.ts, which is where their tests live. There
    // is no bundler here, so the duplication is deliberate — but it means the
    // tested copy and the running copy can drift apart silently, and the tests
    // would still pass. Verified identical at the time of writing (same
    // constants, same roamingPoint/roamingTarget output for a fixed input).
    // If you change one, change both, and re-check with a fixed-input compare.
    function roamingTarget(agentId, nowMs, rect) {
      if (!rect) return roamingPoint(agentId, 0, { x: 0, y: 0, w: MAP_WIDTH, h: MAP_HEIGHT });
      if (!Number.isFinite(nowMs)) return roamingPoint(agentId, 0, rect);
      const bucket = Math.floor(nowMs / ROAM_INTERVAL_MS);
      const t = Math.max(0, Math.min(0.999999, (nowMs % ROAM_INTERVAL_MS) / ROAM_INTERVAL_MS));
      const p0 = roamingPoint(agentId, bucket, rect);
      const p1 = roamingPoint(agentId, bucket + 1, rect);
      return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    }

    function sharedNowMs() {
      if (!latestView || !latestView.serverTime) return Date.now();
      const serverMs = Date.parse(latestView.serverTime);
      if (!Number.isFinite(serverMs) || !viewReceiveAt) return Date.now();
      return serverMs + (Date.now() - viewReceiveAt);
    }

    function positionForAgentWithRoaming(a, nowMs) {
      // Summon wins over roaming but never over work (server clears summon on
      // status → working, so a working agent never has a summonedPos here).
      if (a.summonedPos && a.summonedPos.x != null && a.summonedPos.y != null) {
        // Only honour it while the agent is still idle/waiting — work always wins
        if (a.zone === 'idle' || a.status === 'idle' || a.status === 'waiting') {
          return { x: a.summonedPos.x * TILE, y: a.summonedPos.y * TILE };
        }
      }
      // Non-idle agents are placed exactly on their slot — no roaming, no drift.
      if (a.zone !== 'idle') return positionForAgent(a);
      const rect = idlePixelRect();
      if (!rect) return positionForAgent(a);
      const t = nowMs ?? sharedNowMs();
      return roamingTarget(a.id, t, rect);
    }

    // ---------------- Running animation & facing (Phase 2) ----------------
    // While distance to target exceeds a small threshold the sprite shows
    // `run` frames facing the travel direction; otherwise `idle`. Direction
    // is the larger of |dx|,|dy|, so a diagonal walk reads clearly. This only
    // describes motion the ease loop already performs — it never invents it.
    const RUN_THRESHOLD_PX = 1.5;

    function directionForAnim(dx, dy) {
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
      return dy > 0 ? 'down' : 'up';
    }

    function updateAgentFrame(entry, dt) {
      // Degrade, don't refuse: missing sheet or frames falls back rather than
      // throwing into the render loop (a thrown frame kills the whole office).
      try {
        const frames = charTextures[entry.char] || charTextures.nancy;
        if (!frames) return;
        const dx = (entry.target?.x ?? entry.sprite.x) - entry.sprite.x;
        const dy = (entry.target?.y ?? entry.sprite.y) - entry.sprite.y;
        const dist = Math.hypot(dx, dy);
        const moving = dist > RUN_THRESHOLD_PX;
        if (moving) {
          entry.direction = directionForAnim(dx, dy);
        }
        // Keep last facing when stationary — a running-on-the-spot agent is
        // a worse bug than no animation, so idle keeps its direction.
        const action = moving ? 'run' : 'idle';
        const dir = entry.direction || 'down';

        entry.animTimer = (entry.animTimer || 0) + dt;
        const step = moving ? 0.08 : 0.20;
        if (entry.animTimer >= step) {
          entry.animTimer = 0;
          entry.frameIdx = ((entry.frameIdx || 0) + 1) % 6;
        }
        const list = DIR_FRAMES[action][dir];
        if (!list) return;
        const idx = list[entry.frameIdx % list.length];
        const tex = frames[idx];
        if (tex) entry.sprite.texture = tex;
      } catch (e) {
        console.warn('agent frame update failed', e);
      }
    }

    // ---------------- Global App State ----------------
    let app;
    let worldContainer;
    let playerSprite;
    let wallCollisionGrid = new Uint8Array(COLS * ROWS);
    let currentCharacter = 'nancy';
    let charTextures = {};
    let zoomLevel = 1.0;

    let ws = null;
    let latestView = null;
    let meId = null;
    let viewReceiveAt = 0; // Date.now() when latestView arrived — anchors sharedNowMs()
    let selectedAgentId = null; // which agent's head card is open (phase 3)
    const renderedAgents = new Map(); // agentId -> { sprite, tag, badge }
    const renderedHumans = new Map(); // userId  -> { sprite, tag }

    let player = {
      x: spawnTile.x * TILE, y: spawnTile.y * TILE,
      speed: 320, direction: 'down', isMoving: false, animTimer: 0, frameIdx: 0,
    };
    let lastSentPos = null;
    let posSendTimer = 0;

    window.setPlayerSpeed = function (newSpeed, label) {
      player.speed = newSpeed;
      document.getElementById('speed-indicator').textContent = label;
      document.querySelectorAll('#spd-normal, #spd-fast, #spd-turbo').forEach((btn) => btn.classList.remove('active'));
      if (newSpeed <= 240) document.getElementById('spd-normal').classList.add('active');
      else if (newSpeed <= 360) document.getElementById('spd-fast').classList.add('active');
      else document.getElementById('spd-turbo').classList.add('active');
    };

    const keys = { w:false,a:false,s:false,d:false,up:false,down:false,left:false,right:false,shift:false };

    // ---------------- WebSocket: the only source of truth ----------------
    let lastSeenSeq = 0;
    let reconnectTimer = null;
    let hasConnectedBefore = false;

    function connect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
        return; // Prevent duplicate sockets
      }
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // A browser WebSocket cannot set headers, so the session token rides the
      // query string — the server accepts either (see tokenFromRequest).
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(localStorage.getItem('logbridge_auth_token') || '')}`);

      ws.addEventListener('open', () => {
        setConnLabel('● Connected', true);
        const room = activeRoom();
        if (hasConnectedBefore && lastSeenSeq > 0 && room) {
          // Reconnecting with sequence knowledge: send sync request
          ws.send(JSON.stringify({
            type: 'sync',
            roomId: room.id,
            lastSeenSeq: lastSeenSeq,
          }));
        }
        hasConnectedBefore = true;
      });

      ws.addEventListener('close', () => {
        announcedRoom = null; // must re-announce the room after reconnecting
        setConnLabel('● Disconnected — retrying…', false);
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 1500);
        }
      });
      ws.addEventListener('error', () => {
        try { ws.close(); } catch {}
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'view') {
          if (typeof msg.view?.seq === 'number' && msg.view.seq >= lastSeenSeq) {
            lastSeenSeq = msg.view.seq;
          }
          latestView = msg.view;
          viewReceiveAt = Date.now();
          announceRoom();
          meId = msg.view.meId;
          renderView(latestView);
          renderAlways(latestView);
          renderCurrentView();
        } else if (msg.type === 'events_replay') {
          if (Array.isArray(msg.events)) {
            for (const evt of msg.events) {
              if (typeof evt.seq === 'number' && evt.seq > lastSeenSeq) {
                lastSeenSeq = evt.seq;
              }
              handleReplayEvent(evt);
            }
          }
          if (latestView) {
            renderAlways(latestView);
            renderCurrentView();
          }
        } else if (msg.type === 'chat') {
          onChatMessage(msg.msg);
        } else if (msg.type === 'room_chat') {
          onRoomChatMessage(msg.msg);
        } else if (msg.type === 'webrtc_signal') {
          handleWebRtcSignal(msg);
        }
      });
    }

    function handleReplayEvent(evt) {
      if (!evt || !evt.type) return;
      try {
        if (evt.type === 'room_chat' && evt.data) {
          onRoomChatMessage(evt.data);
        } else if (evt.type === 'task.accept' || evt.type === 'task.result' || evt.type === 'artifact.created' || evt.type === 'lease.expired') {
          if (currentView === 'agent') {
            renderCommandCenter();
          } else if (currentView === 'tasks' && latestView) {
            const room = activeRoom() || latestView.rooms?.[0];
            if (room) renderBoard(room);
          }
        }
      } catch (err) {
        console.warn('Replay event handler ignored error:', err);
      }
    }

    function setConnLabel(text, ok) {
      document.getElementById('online-dot').classList.toggle('on', ok);
      document.getElementById('me-state').textContent = ok ? 'Online' : 'Offline';
      document.getElementById('me-state').style.color = ok ? 'var(--green)' : 'var(--text-faint)';
      if (!ok) document.getElementById('online-count').textContent = text.replace(/^●\s*/, '');
    }

    function sendPosition() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const room = activeRoom();
      if (!room) return;
      const tx = Math.floor(player.x / TILE);
      const ty = Math.floor(player.y / TILE);
      const currentZone = (typeof detectZoneName === 'function') ? detectZoneName(player.x, player.y) : 'corridor';
      if (lastSentPos && lastSentPos.x === tx && lastSentPos.y === ty && lastSentPos.zone === currentZone) return;
      lastSentPos = { x: tx, y: ty, zone: currentZone };
      ws.send(JSON.stringify({
        type: 'position',
        roomId: room.id,
        x: tx,
        y: ty,
        userId: currentUser?.id || 'you',
        name: currentUser?.name || 'You',
        zone: currentZone,
      }));
    }

    // ---------------- Authentication State & Handlers ----------------
    let currentUser = null;
    try {
      // Being signed in means holding a session the SERVER accepts. Restoring
      // the cached user object alone left the UI looking logged in while every
      // API call returned 401 — a shell of an office with no data in it and no
      // way to tell why. The token is the credential; the cached user is only
      // there so the header can render before /api/auth/me answers.
      const savedToken = localStorage.getItem("logbridge_auth_token");
      currentUser = savedToken
        ? JSON.parse(localStorage.getItem("logbridge_auth_user") || "null")
        : null;
      if (!savedToken) localStorage.removeItem("logbridge_auth_user");
    } catch {}

    let authMode = 'login';

    window.switchAuthMode = function(mode) {
      authMode = mode;
      const isLogin = mode === 'login';
      const tabLog = document.getElementById('auth-tab-login');
      const tabSign = document.getElementById('auth-tab-signup');
      if (tabLog) {
        tabLog.style.background = isLogin ? 'var(--accent)' : 'transparent';
        tabLog.style.color = isLogin ? '#fff' : 'var(--text-dim)';
      }
      if (tabSign) {
        tabSign.style.background = !isLogin ? 'var(--accent)' : 'transparent';
        tabSign.style.color = !isLogin ? '#fff' : 'var(--text-dim)';
      }
      const nameGrp = document.getElementById('auth-name-group');
      if (nameGrp) nameGrp.style.display = isLogin ? 'none' : 'flex';
      const subBtn = document.getElementById('auth-submit-btn');
      if (subBtn) subBtn.textContent = isLogin ? 'Sign In →' : 'Create Account →';
      const err = document.getElementById('auth-error');
      if (err) err.style.display = 'none';
    };

    function checkAuth() {
      const authView = document.getElementById('view-auth');
      const appView = document.querySelector('.app');
      if (!currentUser) {
        if (authView) authView.style.display = 'flex';
        if (appView) appView.style.display = 'none';
      } else {
        if (authView) authView.style.display = 'none';
        if (appView) appView.style.display = 'flex';
        updateUserHeader();
      }
    }

    function updateUserHeader() {
      if (!currentUser) return;
      const name = currentUser.name || "Ayush";
      const initial = (name[0] || "A").toUpperCase();
      const nameEl = document.getElementById('user-display-name');
      if (nameEl) nameEl.textContent = name;
      const avEl = document.getElementById('user-avatar');
      if (avEl) avEl.textContent = initial;
      const dropName = document.getElementById('dropdown-user-name');
      if (dropName) dropName.textContent = name;
      const dropEmail = document.getElementById('dropdown-user-email');
      if (dropEmail) dropEmail.textContent = currentUser.email || "";
    }

    window.handleAuthSubmit = async function(e) {
      if (e) e.preventDefault();
      const email = document.getElementById('auth-email')?.value?.trim();
      const password = document.getElementById('auth-password')?.value;
      const name = document.getElementById('auth-name')?.value?.trim();
      const err = document.getElementById('auth-error');
      const btn = document.getElementById('auth-submit-btn');

      if (btn) btn.disabled = true;
      if (err) err.style.display = 'none';

      const url = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const payload = authMode === 'signup' ? { name, email, password } : { email, password };

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Authentication failed');

        currentUser = data.user;
        localStorage.setItem('logbridge_auth_user', JSON.stringify(currentUser));
        if (data.token) localStorage.setItem('logbridge_auth_token', data.token);

        checkAuth();
        goToProjectsPage();
      } catch (errObj) {
        if (err) {
          err.textContent = errObj.message;
          err.style.display = 'block';
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    window.quickDemoLogin = async function() {
      // Must obtain a REAL session: faking currentUser in localStorage left the
      // UI looking signed in while every API call came back 401.
      try {
        const r = await fetch('/api/auth/demo', { method: 'POST' });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'demo sign-in failed');
        currentUser = d.user;
        localStorage.setItem('logbridge_auth_token', d.token);
        localStorage.setItem('logbridge_auth_user', JSON.stringify(currentUser));
        checkAuth();
        goToProjectsPage();
      } catch (e) {
        const err = document.getElementById('auth-error');
        if (err) { err.textContent = 'Demo sign-in failed: ' + (e?.message ?? e); err.style.display = 'block'; }
      }
    };

    window.handleSignOut = function() {
      currentUser = null;
      localStorage.removeItem('logbridge_auth_user');
      localStorage.removeItem('logbridge_auth_token');
      localStorage.removeItem('logbridge_active_project');
      activeProjectId = null;
      checkAuth();
    };

    window.toggleUserDropdown = function(e) {
      if (e) e.stopPropagation();
      const d = document.getElementById('user-dropdown');
      if (d) d.style.display = d.style.display === 'none' ? 'flex' : 'none';
    };

    document.addEventListener('click', () => {
      const d = document.getElementById('user-dropdown');
      if (d) d.style.display = 'none';
    });

    // Tell the server which room we're looking at. Until it knows, it can't
    // scope chat — and it deliberately sends none rather than guessing.
    let activeProjectId = localStorage.getItem("logbridge_active_project") || null;
    let announcedRoom = null;

    function activeRoom() {
      if (!latestView || !latestView.rooms.length) return null;
      if (activeProjectId) {
        const found = latestView.rooms.find((r) => r.id === activeProjectId);
        if (found) return found;
      }
      return latestView.rooms[0];
    }

    function updateProjectNavVisibility() {
      const appEl = document.querySelector('.app');
      const wsNameEl = document.getElementById('ws-name');
      const wsRepoEl = document.getElementById('ws-repo');
      const wsMarkEl = document.getElementById('ws-mark');
      const isProjectSelection = (currentView === 'projects') || !activeProjectId;

      if (isProjectSelection) {
        // Choosing a project is a full-screen moment: no sidebar behind it.
        if (appEl) appEl.classList.add('no-sidebar');
        if (wsNameEl) wsNameEl.textContent = 'Project Workspaces';
        if (wsRepoEl) wsRepoEl.textContent = '';
        if (wsMarkEl) wsMarkEl.textContent = '◇';
      } else {
        if (appEl) appEl.classList.remove('no-sidebar');
        const room = activeRoom();
        if (room) {
          if (wsNameEl) wsNameEl.textContent = room.name || 'Workspace';
          // gh_repo holds either an "owner/repo" slug (GitHub mirror) or a
          // local filesystem path (hand-made project). A full absolute path
          // is noise in a 190px chip, so a path collapses to its last two
          // segments and a slug is shown as-is.
          if (wsRepoEl) {
            const raw = room.ghRepo || '';
            wsRepoEl.textContent = /^[\w.-]+\/[\w.-]+$/.test(raw)
              ? raw
              : raw.split('/').filter(Boolean).slice(-2).join('/');
            wsRepoEl.title = raw;
          }
          if (wsMarkEl) wsMarkEl.textContent = (room.name || '?').trim()[0]?.toUpperCase() ?? '?';
        }
      }
    }

    // ---- project switcher menu ------------------------------------------
    function renderProjectMenu() {
      const list = document.getElementById('ws-menu-list');
      if (!list) return;
      list.innerHTML = '';
      const rooms = latestView?.rooms ?? [];
      if (!rooms.length) {
        list.innerHTML = '<div class="ws-menu-empty">No projects yet.</div>';
        return;
      }
      for (const r of rooms) {
        const b = document.createElement('button');
        b.className = 'ws-menu-item' + (r.id === activeProjectId ? ' is-current' : '');
        const mark = document.createElement('span');
        mark.className = 'ws-menu-mark';
        mark.textContent = (r.name || '?').trim()[0]?.toUpperCase() ?? '?';
        const tw = document.createElement('span');
        tw.className = 'ws-menu-text';
        const n = document.createElement('span');
        n.className = 'ws-menu-name';
        n.textContent = r.name || r.id;
        const s = document.createElement('span');
        s.className = 'ws-menu-sub';
        // Agent count is the useful thing to know before switching.
        s.textContent = `${(r.agents ?? []).length} agent${(r.agents ?? []).length === 1 ? '' : 's'}`;
        tw.append(n, s);
        b.append(mark, tw);
        if (r.id === activeProjectId) {
          const tick = document.createElement('span');
          tick.className = 'ws-menu-tick';
          tick.textContent = '✓';
          b.appendChild(tick);
        }
        b.onclick = () => { closeProjectMenu(); selectProject(r.id); };
        list.appendChild(b);
      }
    }

    window.toggleProjectMenu = function (e) {
      e?.stopPropagation();
      const menu = document.getElementById('ws-menu');
      if (!menu) return;
      const open = menu.classList.contains('open');
      if (open) { closeProjectMenu(); return; }
      renderProjectMenu();
      menu.classList.add('open');
      document.getElementById('ws-pick')?.classList.add('is-open');
    };
    window.closeProjectMenu = function () {
      document.getElementById('ws-menu')?.classList.remove('open');
      document.getElementById('ws-pick')?.classList.remove('is-open');
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest?.('.ws-wrap')) closeProjectMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProjectMenu(); });

    window.goToProjectsPage = function () {
      activeProjectId = null;
      localStorage.removeItem("logbridge_active_project");
      updateProjectNavVisibility();
      setView('projects');
    };

    function selectProject(projectId) {
      activeProjectId = projectId;
      localStorage.setItem("logbridge_active_project", projectId);
      updateProjectNavVisibility();
      announcedRoom = null;
      announceRoom();
      if (latestView) {
        renderAlways(latestView);
        renderView(latestView);
      }
      setView('office');
    }
    // Called from markup this file generates (the project cards use an
    // inline onclick), so it has to live on window. Module scope is not
    // global scope — this broke the "Open Office" button when the script
    // moved out of index.html into a module.
    window.selectProject = selectProject;


    function announceRoom() {
      const room = activeRoom();
      if (!room || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (announcedRoom === room.id) return;
      announcedRoom = room.id;
      chatLog.length = 0; // history for the new room is about to arrive
      ws.send(JSON.stringify({
        type: 'join',
        roomId: room.id,
        userId: currentUser?.id || 'you',
      }));
    }

    // ---------------- office legend + filters (prompt 8b) ----------------
    // Filters are CLIENT-side only: the server keeps sending the full
    // snapshot (CONTRACT.md invariant 1); this just decides what to draw.
    const officeFilters = { agents: true, humans: true, bubbles: true };

    function applyOfficeFilters() {
      for (const entry of renderedAgents.values()) {
        entry.sprite.visible = officeFilters.agents;
        if (entry.bubble) {
          // Bubbles live inside the agent sprite; when agents are hidden the
          // bubble goes with them. When only bubbles are off, hide directly.
          if (officeFilters.agents) entry.bubble.container.visible = officeFilters.bubbles;
        }
      }
      for (const entry of renderedHumans.values()) {
        entry.sprite.visible = officeFilters.humans;
      }
    }

    // Everyone on the floor, as a strip of portraits ringed by status.
    // Rebuilt from the view like everything else — the strip cannot show an
    // agent the server has not projected.
    const HUD_TINT = { working: 's-working', reviewing: 's-reviewing', collaborating: 's-reviewing',
                       needs_input: 's-needs', needs_human: 's-needs', blocked: 's-blocked',
                       idle: 's-idle', done: 's-done', completed: 's-done' };
    function renderHudAgents(room) {
      const el = document.getElementById('hud-agents');
      if (!el) return;
      el.innerHTML = '';
      for (const a of room?.agents ?? []) {
        const av = document.createElement('button');
        av.className = 'hud-av ' + (HUD_TINT[a.zone] || HUD_TINT[a.status] || 's-idle');
        const sprite = (a.character && CHAR_NAMES.includes(a.character))
          ? a.character
          : CHAR_NAMES[hashString(a.id) % CHAR_NAMES.length];
        av.style.backgroundImage = 'url(/assets/characters/' + sprite + '.png)';
        av.title = `${a.name} — ${String(a.status || '').replace(/_/g, ' ')}`;
        av.onclick = () => openCommandCenter(a.id);
        // Hovering the strip names the agent in the island's subtitle, which
        // is what "hover an agent" in the placeholder is telling you to do.
        av.onmouseenter = () => {
          const z = document.getElementById('zone-stat');
          if (z) { z.dataset.prev ??= z.textContent; z.textContent = a.name + ' · ' + String(a.status || '').replace(/_/g, ' '); }
        };
        av.onmouseleave = () => {
          const z = document.getElementById('zone-stat');
          if (z && z.dataset.prev !== undefined) { z.textContent = z.dataset.prev; delete z.dataset.prev; }
        };
        el.appendChild(av);
      }
    }

    // Walk the player into the meeting room. It is the one spatial action the
    // HUD offers, and it is inert unless two DISTINCT owners are online —
    // the office must not advertise a room nobody can be in.
    window.enterMeetingRoom = function () {
      const rect = zones?.collaborating;
      if (!rect || !player) return;
      player.x = (rect.x + rect.w / 2) * TILE;
      player.y = (rect.y + rect.h / 2) * TILE;
      sendPosition?.();
    };

    // Rebuilt on every view, because whether collaboration is possible can
    // change the moment someone else's machine connects or drops.
    function renderLegend() {
      const chips = document.getElementById('legend-chips');
      if (!chips) return;
      chips.innerHTML = '';
      // "meeting" is where agents from DIFFERENT machines work together. With
      // one person online nothing can ever enter it, so the chip would be a
      // legend entry for a state the office cannot show.
      const collabOn = latestView?.rooms?.[0]?.collaborationAvailable ?? false;
      for (const [zone, [label]] of Object.entries(ZONE_BADGE)) {
        if (zone === 'collaborating' && !collabOn) continue;
        const chip = document.createElement('span');
        chip.className = 'sk-chip';
        const dot = document.createElement('span');
        // Same carpet colours as the pills and the roster dots — one legend
        // for the whole product, not one per surface.
        dot.style.cssText = 'width:7px;height:7px;border-radius:50%;flex-shrink:0;background:' +
          ({ idle: 'var(--st-idle)', working: 'var(--st-working)', reviewing: 'var(--st-reviewing)',
             collaborating: 'var(--st-reviewing)', blocked: 'var(--st-blocked)',
             needs_human: 'var(--st-needs)', done: 'var(--st-done)' }[zone] ?? 'var(--st-muted)');
        const txt = document.createElement('span');
        txt.textContent = label.toLowerCase();
        chip.append(dot, txt);
        chips.appendChild(chip);
      }
    }

    // Listeners attach once; renderLegend() is what repeats.
    function initLegend() {
      renderLegend();
      document.getElementById('flt-agents').addEventListener('change', (e) => {
        officeFilters.agents = e.target.checked; applyOfficeFilters();
      });
      document.getElementById('flt-humans').addEventListener('change', (e) => {
        officeFilters.humans = e.target.checked; applyOfficeFilters();
      });
      document.getElementById('flt-bubbles').addEventListener('change', (e) => {
        officeFilters.bubbles = e.target.checked; applyOfficeFilters();
      });
    }

    // ---------------- Rendering: reconcile sprites against real state ----------------
    function renderView(view) {
      const room = activeRoom() || view.rooms[0];
      if (!room) return;

      const seenAgents = new Set();
      const bubbleLevels = computeBubbleLevels(room);
      for (const a of room.agents) {
        seenAgents.add(a.id);
        let entry = renderedAgents.get(a.id);
        if (!entry) entry = createAgentSprite(a);
        entry.bubbleLevel = bubbleLevels.get(a.id) ?? 0;
        updateAgentSprite(entry, a);
      }
      applyOfficeFilters();
      for (const [id, entry] of renderedAgents) {
        if (!seenAgents.has(id)) { worldContainer.removeChild(entry.sprite); renderedAgents.delete(id); }
      }
      // Phase 3: head card follows the agent; close if it left, refresh if it stayed
      if (selectedAgentId && !seenAgents.has(selectedAgentId)) {
        closeAgentPopup();
      } else if (selectedAgentId) {
        const cur = room.agents.find((x) => x.id === selectedAgentId);
        if (cur) updateAgentPopupContent(cur);
      }

      const seenHumans = new Set();
      for (const h of room.humans) {
        if (h.id === meId) continue; // that's the local player sprite
        seenHumans.add(h.id);
        let entry = renderedHumans.get(h.id);
        if (!entry) entry = createHumanSprite(h);
        updateHumanSprite(entry, h);
      }
      for (const [id, entry] of renderedHumans) {
        if (!seenHumans.has(id)) { worldContainer.removeChild(entry.sprite); renderedHumans.delete(id); }
      }

      renderBoard(room);
      renderMemory(room);
    }

    // ---------------- Memory view ----------------
    function renderMemory(room) {
      const nameEl = document.getElementById('mem-room-name');
      if (nameEl) nameEl.textContent = room.name;
      const list = document.getElementById('mem-list');
      if (!list) return;
      const memories = room.memories ?? [];
      list.innerHTML = '';

      if (memories.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'board-empty';
        empty.textContent = 'Nothing learned yet — memories form as agents finish tasks.';
        list.appendChild(empty);
        return;
      }

      for (const m of memories) {
        const item = document.createElement('div');
        item.className = 'mem-item';
        const kind = document.createElement('span');
        kind.className = `mem-kind k-${m.kind}`;
        kind.textContent = m.kind;
        const text = document.createElement('span');
        text.className = 'mem-text';
        text.textContent = m.text; // agent-authored — never innerHTML
        const meta = document.createElement('span');
        meta.className = 'mem-meta';
        meta.textContent = `${m.agentName} · ${relativeTime(m.createdAt)}`;
        item.append(kind, text, meta);
        list.appendChild(item);
      }
    }

    // ---------------- Board view ----------------
    // Same `room.tasks` snapshot the office is drawn from — CONTRACT.md
    // invariant 1 (full snapshot, no deltas) means this needs no state of
    // its own: re-render the columns from scratch on every view.
    const BOARD_COLUMNS = [
      { key: 'proposed', label: 'Proposed',    states: ['submitted'] },
      { key: 'working',  label: 'In Progress', states: ['working'] },
      { key: 'blocked',  label: 'Blocked',     states: ['input-required', 'auth-required', 'blocked'] },
      { key: 'done',     label: 'Done',        states: ['completed'] },
      { key: 'closed',   label: 'Closed',      states: ['failed', 'canceled', 'rejected'] },
    ];

    function relativeTime(iso) {
      if (!iso) return '—';
      const secs = Math.floor((Date.now() - Date.parse(iso)) / 1000);
      if (!Number.isFinite(secs)) return '—';
      if (secs < 60) return `${Math.max(0, secs)}s ago`;
      if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
      if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
      return `${Math.floor(secs / 86400)}d ago`;
    }

    function renderBoard(room) {
      const nameEl = document.getElementById('board-room-name');
      if (nameEl) nameEl.textContent = room.name;

      const cols = document.getElementById('board-cols');
      if (!cols) return;
      const tasks = room.tasks ?? [];
      cols.innerHTML = '';

      for (const col of BOARD_COLUMNS) {
        const inCol = tasks.filter((t) => col.states.includes(t.state));
        const el = document.createElement('div');
        el.className = `board-col col-${col.key}`;
        el.innerHTML = `
          <div class="board-col-title">
            <span>${col.label}</span>
            <span class="board-col-count">${inCol.length}</span>
          </div>
          <div class="board-col-body"></div>`;
        const body = el.querySelector('.board-col-body');

        if (inCol.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'board-empty';
          empty.textContent = '—';
          body.appendChild(empty);
        }
        for (const t of inCol) {
          const card = document.createElement('div');
          card.className = 'board-card';
          // textContent, not innerHTML — a task title is human/agent-authored
          // text and must never be able to inject markup into this page.
          const title = document.createElement('div');
          title.className = 'board-card-title';
          title.textContent = t.title;
          const meta = document.createElement('div');
          meta.className = 'board-card-meta';
          const agent = document.createElement('span');
          agent.className = 'board-card-agent' + (t.agentName ? '' : ' unassigned');
          agent.textContent = t.agentName ?? 'unassigned';
          const when = document.createElement('span');
          when.className = 'board-card-when';
          const cost = t.costUsd > 0 ? ` · $${t.costUsd.toFixed(2)}` : '';
          when.textContent = relativeTime(t.startedAt ?? t.createdAt) + cost;
          meta.append(agent, when);
          card.append(title, meta);
          body.appendChild(card);
        }
        cols.appendChild(el);
      }
    }

    // ---------------- app shell ----------------
    // One view at a time in the main column. The sidebar owns navigation AND
    // both rosters; status cards sit along the bottom of the office view.
    // Nothing is docked to the right.
    // 'agent' is the Command Center for ONE agent. It has no nav item —
    // you reach it by clicking an agent, and leave via 'All agents'.
    const VIEWS = ['office', 'tasks', 'chat', 'projects', 'agents', 'memory', 'settings', 'agent'];
    let currentView = activeProjectId ? 'office' : 'projects';
    checkAuth();
    if (currentUser) {
      if (!activeProjectId) {
        setTimeout(() => goToProjectsPage(), 60);
      } else {
        setTimeout(() => { updateProjectNavVisibility(); setView('office'); }, 60);
      }
    }
    function stageEl() { return document.getElementById('canvas-container'); }

    window.setView = function (name) {
      if (!VIEWS.includes(name)) return;
      // Leaving the view that owns the dialog must dismiss it — otherwise it
      // floats over whatever you navigated to.
      document.getElementById('add-agent-modal')?.classList.remove('open');
      currentView = name;
      for (const v of VIEWS) {
        document.getElementById('view-' + v)?.classList.toggle('active', v === name);
        document.getElementById('nav-' + v)?.classList.toggle('active', v === name);
      }
      for (const k of Object.keys(keys)) keys[k] = false; // don't leave a key stuck down
      updateProjectNavVisibility();
      renderCurrentView();
      if (name === 'chat') {
        unreadChat = 0;
        document.getElementById('chat-count').classList.remove('show');
        setTimeout(() => document.getElementById('chat-input')?.focus(), 60);
      }
      // The office canvas only has a size while its view is displayed.
      if (name === 'office') setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
    };

    window.toggleSidebar = function () {
      document.getElementById('side').classList.toggle('collapsed');
      setTimeout(() => window.dispatchEvent(new Event('resize')), 220);
    };

    window.toggleFullscreen = function () {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => console.log(err));
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    };

    function renderCurrentView() {
      const room = activeRoom() || latestView?.rooms?.[0];
      if (!room) return;
      if (currentView === 'tasks')   renderBoard(room);
      if (currentView === 'chat')    renderChat();
      if (currentView === 'memory')  renderMemory(room);
      if (currentView === 'agents')  renderAgentsFull(room);
      if (currentView === 'projects') renderProjects();
      if (currentView === 'settings') renderMachines(room);
      if (currentView === 'agent')   renderCommandCenter();
    }

    // Everything the sidebar and bottom strip show, refreshed on every
    // broadcast — they're always visible, so they can't wait for a tab click.
    function renderAlways(view) {
      const room = activeRoom() || view.rooms[0];
      if (!room) return;
      // One writer for the workspace chip, so the name, repo and mark can
      // never disagree with each other.
      updateProjectNavVisibility();
      renderLegend();
      renderHudAgents(room);
      renderPeople(room);
      renderAgentRoster(room);
      renderCurrentTask(room);
      renderFeed(room);
      const online = room.machines.filter((m) => m.online).length + room.humans.length + 1;
      document.getElementById('online-count').textContent = `${online} Online`;
    }

    // ---------------- rosters ----------------
    const AV_COLORS = ['#5b5ef0', '#e0679a', '#2fb5a8', '#f0902f', '#7b6ef0', '#3b82f6'];
    function avatarFor(name, isBot) {
      const el = document.createElement('div');
      el.className = 'av' + (isBot ? ' bot' : '');
      if (isBot) { el.textContent = '🤖'; return el; }
      el.style.background = AV_COLORS[hashString(name) % AV_COLORS.length];
      el.textContent = (name[0] ?? '?').toUpperCase();
      return el;
    }

    function rosterRow(o) {
      const row = document.createElement('div');
      row.className = 'roster-row';
      const main = document.createElement('div');
      main.className = 'r-main';
      const n = document.createElement('div');
      n.className = 'r-name';
      n.textContent = o.name;                    // author-controlled data
      const sub = document.createElement('div');
      sub.className = 'r-sub';
      sub.textContent = o.sub;
      main.append(n, sub);
      const dot = document.createElement('div');
      dot.className = 'r-dot ' + o.status;
      row.append(avatarFor(o.name, o.bot), main, dot);
      if (o.onClick) row.onclick = o.onClick;
      row.title = `${o.name} — ${o.sub}`;
      return row;
    }

    function renderCollabState(room) {
      const el = document.getElementById('collab-state');
      if (!el) return;
      const owners = new Set(room.machines.filter((m) => m.online).map((m) => m.ownerId));
      if (room.collaborationAvailable) {
        el.innerHTML = '<b>Active</b>Agents on different machines can delegate work to each other, ' +
          'request reviews and share context. Every payload is sealed end to end \u2014 the server routes it ' +
          'and cannot read it.';
      } else {
        el.innerHTML = '<b>Waiting for someone else</b>Delegation, code review and context sharing need ' +
          'a second person\u2019s machine online. They\u2019re built and tested \u2014 just inert while ' +
          'you\u2019re the only one here, so the office doesn\u2019t show a meeting room nobody can enter.';
      }
      el.innerHTML += `<div style="margin-top:8px;opacity:.75">Owners online: ${owners.size}</div>`;
    }

    function renderPeople(room) {
      const el = document.getElementById('people-list');
      const countEl = document.getElementById('people-count-badge');
      if (countEl) countEl.textContent = (room.humans.length + 1);
      el.innerHTML = '';
      el.appendChild(rosterRow({ name: 'You', sub: 'Online · this browser', status: 'online' }));
      for (const h of room.humans) {
        if (h.id === meId) continue;
        el.appendChild(rosterRow({ name: h.name, sub: h.presence, status: h.presence === 'online' ? 'online' : '' }));
      }
    }

    /** Just the last path segment — a roster 190px wide cannot show
     *  "/Users/you/code/payments-api" and still show the agent. */
    function folderLabel(path) {
      const parts = String(path).split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : path;
    }

    function renderAgentRoster(room) {
      const el = document.getElementById('agent-list');
      const countEl = document.getElementById('agent-count-badge');
      if (countEl) countEl.textContent = room.agents.length;
      el.innerHTML = '';
      if (!room.agents.length) {
        el.innerHTML = '<div class="r-sub" style="padding:6px 9px;">No agents connected</div>';
        return;
      }

      // Grouped by the folder each agent works in, which is what the roster
      // is actually for: "who is touching this repo right now". Agents with
      // no folder are not forced under a fake heading — they list first,
      // exactly as they did before folders existed.
      const groups = new Map();
      const loose = [];
      for (const a of room.agents) {
        if (!a.folder) { loose.push(a); continue; }
        if (!groups.has(a.folder)) groups.set(a.folder, []);
        groups.get(a.folder).push(a);
      }

      const addRow = (a) => el.appendChild(rosterRow({
        name: a.name, bot: true, status: a.status,
        // The note is a human's annotation and wins over machine chatter:
        // if someone wrote "flaky on staging", that is the thing to show.
        sub: a.note || (a.task ? a.task.title : (a.description || a.status)),
        onClick: () => openCommandCenter(a.id),
      }));

      loose.forEach(addRow);
      for (const [folder, agents] of groups) {
        const h = document.createElement('div');
        h.className = 'roster-folder';
        h.title = folder;                      // the full path on hover
        const hName = document.createElement('span');
        hName.className = 'rf-name';
        hName.textContent = folderLabel(folder);
        // How many agents are touching this repo — the roster's actual question.
        const hCount = document.createElement('span');
        hCount.className = 'rf-count';
        hCount.textContent = agents.length;
        h.append(hName, hCount);
        el.appendChild(h);
        agents.forEach(addRow);
      }
    }

    function renderAgentsFull(room) {
      const el = document.getElementById('agents-full');
      el.innerHTML = '';
      if (!room.agents.length) {
        el.innerHTML = '<div class="empty-note">No agents have joined this room yet.</div>';
        return;
      }
      for (const a of room.agents) {
        el.appendChild(rosterRow({
          name: a.name, bot: true, status: a.status,
          sub: `${a.role} · ${a.machineName} · ${a.task ? a.task.title : a.status}`,
          onClick: () => openCommandCenter(a.id),
        }));
      }
    }

    function renderMachines(room) {
      renderCollabState(room);
      const el = document.getElementById('machines-list');
      el.innerHTML = '<div class="section-label" style="margin-top:0">Connected machines</div>';
      const list = latestView?.rooms?.[0]?.machines ?? [];
      if (!list.length) { el.innerHTML += '<div class="empty-note">No machines connected.</div>'; return; }
      for (const m of list) {
        el.appendChild(rosterRow({ name: m.name, sub: m.online ? 'online' : 'offline', status: m.online ? 'online' : '' }));
      }
    }

    function escapeHtml(s) {
      if (!s) return "";
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    async function renderProjects() {
      const grid = document.getElementById('projects-grid');
      if (!grid) return;
      grid.innerHTML = '<div style="color:var(--text-faint);padding:12px;">Loading workspaces…</div>';

      let projectList = [];
      try {
        const res = await fetch('/api/projects');
        const data = await res.json();
        projectList = data.projects || [];
      } catch {
        projectList = (latestView?.rooms || []).map(r => ({
          id: r.id,
          name: r.name,
          gh_repo: r.gh_repo || r.name,
          agentCount: r.agents.length,
          taskCount: r.tasks.length,
          commanderName: r.agents.find(a => a.role === 'planner' || a.name?.toLowerCase().includes('commander'))?.name,
        }));
      }

      grid.innerHTML = '';

      const ICONS = ['🏢', '🍔', '🏎️', '⚡', '🚀', '🛠️', '🌐', '📦'];

      for (let i = 0; i < projectList.length; i++) {
        const p = projectList[i];
        const isActive = activeRoom()?.id === p.id;
        const icon = ICONS[hashString(p.id) % ICONS.length];

        const card = document.createElement('div');
        card.style.cssText = `
          padding: 5px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid ${isActive ? 'rgba(93,179,192,0.45)' : 'rgba(255,255,255,0.08)'};
          border-radius: 18px;
          box-shadow: ${isActive ? '0 12px 36px -4px rgba(93,179,192,0.25), 0 0 1px 1px rgba(93,179,192,0.4)' : 'var(--shadow)'};
          transition: all 0.25s var(--ease-spring);
        `;

        const innerCard = document.createElement('div');
        innerCard.style.cssText = `
          background: var(--surface);
          border: 1px solid rgba(255,255,255,0.05);
          border-radius: 13px;
          padding: 20px;
          box-shadow: var(--shadow-inner);
          display: flex;
          flex-direction: column;
          gap: 14px;
          height: 100%;
        `;

        innerCard.innerHTML = `
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <div style="width:44px;height:44px;border-radius:11px;background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-size:22px;border:1px solid var(--border-soft);box-shadow:inset 0 1px 0 rgba(255,255,255,0.08);">
                ${icon}
              </div>
              <div>
                <div style="font-size:16px;font-weight:700;color:var(--text);">${escapeHtml(p.name)}</div>
                <div style="font-size:12px;color:var(--text-faint);font-family:'IBM Plex Mono',monospace;margin-top:2px;">${escapeHtml(p.gh_repo || p.id)}</div>
              </div>
            </div>
            ${isActive ? '<span style="background:rgba(93,179,192,0.15);color:var(--accent);font-size:10.5px;font-weight:700;padding:4px 9px;border-radius:12px;border:1px solid rgba(93,179,192,0.4);display:inline-flex;align-items:center;gap:5px;"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent);"></span> ACTIVE</span>' : ''}
          </div>

          <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px;">
            <div style="background:var(--surface-2);border:1px solid var(--border-soft);padding:5px 11px;border-radius:8px;color:var(--text-dim);">
              👥 <b>${p.agentCount}</b> Agents
            </div>
            <div style="background:var(--surface-2);border:1px solid var(--border-soft);padding:5px 11px;border-radius:8px;color:var(--text-dim);">
              📋 <b>${p.taskCount}</b> Tasks
            </div>
            ${p.commanderName ? `
              <div style="background:rgba(212,157,73,0.12);border:1px solid rgba(212,157,73,0.25);color:var(--st-blocked);padding:5px 11px;border-radius:8px;font-weight:600;display:inline-flex;align-items:center;gap:5px;">
                👑 ${escapeHtml(p.commanderName)}
              </div>
            ` : ''}
          </div>

          <div style="display:flex;gap:8px;margin-top:auto;padding-top:10px;border-top:1px solid var(--border-soft);">
            <button class="primary" style="flex:1;padding:9px 14px;font-weight:650;" onclick="selectProject('${p.id}')">
              <span>${isActive ? 'Open Office' : 'Enter Office'}</span>
              <span class="btn-icon-disc">→</span>
            </button>
            ${p.id !== 'prj_demo' ? `
              <button class="cc-tab" style="color:var(--red);border-color:rgba(221,85,75,0.25);background:rgba(221,85,75,0.06);padding:8px 12px;border-radius:9px;" onclick="deleteProjectPrompt('${p.id}', '${escapeHtml(p.name)}')">
                Delete
              </button>
            ` : ''}
          </div>
        `;
        card.appendChild(innerCard);
        card.onmouseenter = () => { card.style.transform = 'translateY(-3px)'; card.style.borderColor = 'rgba(93,179,192,0.5)'; card.style.boxShadow = '0 16px 40px -6px rgba(0,0,0,0.7), 0 0 20px rgba(93,179,192,0.2)'; };
        card.onmouseleave = () => { card.style.transform = 'none'; card.style.borderColor = isActive ? 'rgba(93,179,192,0.45)' : 'rgba(255,255,255,0.08)'; card.style.boxShadow = isActive ? '0 12px 36px -4px rgba(93,179,192,0.25), 0 0 1px 1px rgba(93,179,192,0.4)' : 'var(--shadow)'; };
        grid.appendChild(card);
      }

      // Add "+ Create New Project" card in the grid
      const addCard = document.createElement('div');
      addCard.style.cssText = `
        padding: 5px;
        background: rgba(255, 255, 255, 0.02);
        border: 1px dashed var(--border-hover);
        border-radius: 18px;
        cursor: pointer;
        min-height: 180px;
        transition: all 0.25s var(--ease-spring);
      `;
      const addInner = document.createElement('div');
      addInner.style.cssText = `
        background: var(--surface);
        border-radius: 13px;
        padding: 24px;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        transition: background 0.2s;
      `;
      addInner.innerHTML = `
        <div style="width:48px;height:48px;border-radius:50%;background:rgba(93,179,192,0.12);border:1px solid rgba(93,179,192,0.3);display:flex;align-items:center;justify-content:center;font-size:22px;color:var(--accent);margin-bottom:12px;box-shadow:0 0 16px rgba(93,179,192,0.2);">+</div>
        <div style="font-size:15px;font-weight:700;color:var(--text);">Create New Project</div>
        <div style="font-size:12px;color:var(--text-faint);margin-top:4px;max-width:220px;">Spawn a new workspace with a dedicated Central Commander agent</div>
      `;
      addCard.appendChild(addInner);
      addCard.onmouseenter = () => { addCard.style.borderColor = 'var(--accent)'; addCard.style.transform = 'translateY(-3px)'; addCard.style.boxShadow = '0 16px 40px -6px rgba(0,0,0,0.7), 0 0 20px rgba(93,179,192,0.2)'; addInner.style.background = 'var(--surface-2)'; };
      addCard.onmouseleave = () => { addCard.style.borderColor = 'var(--border-hover)'; addCard.style.transform = 'none'; addCard.style.boxShadow = 'none'; addInner.style.background = 'var(--surface)'; };
      addCard.onclick = () => openCreateProjectModal();

      addCard.innerHTML = `
        <div style="width:48px;height:48px;border-radius:50%;background:var(--surface-2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:24px;color:var(--accent);margin-bottom:12px;">+</div>
        <div style="font-size:15px;font-weight:700;color:var(--text);">Create New Project</div>
        <div style="font-size:12px;color:var(--text-faint);margin-top:4px;max-width:220px;">Spawn a new workspace with a dedicated Central Commander agent</div>
      `;
      grid.appendChild(addCard);
    }

    window.openCreateProjectModal = function () {
      const modal = document.getElementById('create-project-modal');
      if (!modal) return;
      document.getElementById('cp-name').value = '';
      document.getElementById('cp-folder').value = '';
      document.getElementById('cp-commander').value = '';
      const err = document.getElementById('cp-err');
      if (err) { err.textContent = ''; err.style.display = 'none'; }
      modal.classList.add('open');
      setTimeout(() => document.getElementById('cp-name')?.focus(), 50);
    };

    window.closeCreateProjectModal = function () {
      document.getElementById('create-project-modal')?.classList.remove('open');
    };

    window.updateCommanderPlaceholder = function () {
      const val = document.getElementById('cp-name').value.trim();
      const slug = val.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
      const cmdInput = document.getElementById('cp-commander');
      if (cmdInput && !cmdInput.value) {
        cmdInput.placeholder = `${slug}-commander`;
      }
      const folderInput = document.getElementById('cp-folder');
      if (folderInput && !folderInput.value) {
        folderInput.placeholder = `/Users/ayush/project_test/${slug}`;
      }
    };

    window.updateCommanderModels = function () {
      const provider = document.getElementById('cp-provider')?.value || 'opencode';
      const modelSelect = document.getElementById('cp-model');
      if (!modelSelect) return;
      modelSelect.innerHTML = '';
      if (provider === 'opencode') {
        modelSelect.innerHTML = `
          <option value="Nemotron 3.5 Lightning Free" selected>Nemotron 3.5 Lightning (Free)</option>
          <option value="qwen2.5-coder:32b">Qwen 2.5 Coder 32B</option>
          <option value="deepseek-coder-v2">DeepSeek Coder V2</option>
        `;
      } else if (provider === 'claude') {
        modelSelect.innerHTML = `
          <option value="claude-3-7-sonnet-20250219" selected>Claude 3.7 Sonnet (Thinking)</option>
          <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
          <option value="claude-3-opus-20240229">Claude 3 Opus</option>
        `;
      } else if (provider === 'antigravity') {
        modelSelect.innerHTML = `
          <option value="gemini-2.5-pro" selected>Gemini 2.5 Pro (2M context)</option>
          <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
        `;
      } else if (provider === 'codex') {
        modelSelect.innerHTML = `
          <option value="gpt-4o" selected>GPT-4o</option>
          <option value="o3-mini">o3-mini</option>
        `;
      } else {
        modelSelect.innerHTML = `<option value="default" selected>Default Shell Environment</option>`;
      }
    };

    window.submitCreateProject = async function () {
      const name = document.getElementById('cp-name').value.trim();
      const folder = document.getElementById('cp-folder').value.trim();
      const commanderName = document.getElementById('cp-commander').value.trim();
      const provider = document.getElementById('cp-provider')?.value || 'opencode';
      const model = document.getElementById('cp-model')?.value || 'Nemotron 3.5 Lightning Free';
      const err = document.getElementById('cp-err');
      const submitBtn = document.getElementById('cp-submit-btn');

      if (!name) {
        if (err) { err.textContent = 'Please enter a project name.'; err.style.display = 'block'; }
        return;
      }

      if (submitBtn) { submitBtn.textContent = 'Launching…'; submitBtn.disabled = true; }
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, folder, commanderName, provider, model }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to create project');
        }
        closeCreateProjectModal();
        selectProject(data.project.id);
      } catch (e) {
        if (err) { err.textContent = e.message; err.style.display = 'block'; }
      } finally {
        if (submitBtn) { submitBtn.textContent = 'Launch Project →'; submitBtn.disabled = false; }
      }
    };

    window.deleteProjectPrompt = async function (id, name) {
      if (!confirm(`Are you sure you want to delete project "${name}" and all its agents and tasks?`)) return;
      try {
        await fetch(`/api/projects/${id}`, { method: 'DELETE' });
        if (activeProjectId === id) {
          activeProjectId = null;
          localStorage.removeItem('logbridge_active_project');
        }
        renderProjects();
      } catch (e) {
        alert('Failed to delete project: ' + e.message);
      }
    };

    // -------------------------------------------------------------
    // FOLDER / DIRECTORY PICKER ENGINE
    // -------------------------------------------------------------
    let activeFolderPickerTargetId = 'cp-folder';
    let currentFolderPickerDirectory = '';

    window.triggerFolderPicker = async function (targetInputId) {
      activeFolderPickerTargetId = targetInputId || 'cp-folder';
      const inputEl = document.getElementById(activeFolderPickerTargetId);

      // 1. Direct 1-Click Native macOS Finder / OS Folder Dialog
      try {
        const res = await fetch('/api/fs/choose-folder', { method: 'POST' });
        const data = await res.json();
        if (data.path) {
          if (inputEl) {
            inputEl.value = data.path;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return;
        }
        if (data.canceled) return;
      } catch (err) {
        console.warn('Native picker endpoint error, falling back:', err);
      }

      // 2. Browser showDirectoryPicker fallback
      if ('showDirectoryPicker' in window) {
        try {
          const dirHandle = await window.showDirectoryPicker();
          if (dirHandle && dirHandle.name) {
            if (inputEl) {
              inputEl.value = `~/project_test/${dirHandle.name}`;
              inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return;
          }
        } catch (err) {
          if (err.name === 'AbortError') return;
        }
      }

      // 3. Fallback to web modal if native dialog is unavailable
      const modal = document.getElementById('folder-picker-modal');
      if (!modal) return;
      modal.classList.add('open');

      const initialPath = inputEl?.value?.trim() || '~/project_test';
      await loadFolderPickerDirectory(initialPath);
    };

    window.closeFolderPickerModal = function () {
      document.getElementById('folder-picker-modal')?.classList.remove('open');
    };

    window.loadFolderPickerDirectory = async function (dirPath) {
      const listEl = document.getElementById('fp-dirs-list');
      const pathInput = document.getElementById('fp-current-path');
      const upBtn = document.getElementById('fp-up-btn');
      if (!listEl) return;

      listEl.innerHTML = '<div style="color:var(--text-faint);padding:14px;text-align:center;font-size:12px;">Loading directories…</div>';

      try {
        const res = await fetch(`/api/fs/directories?path=${encodeURIComponent(dirPath || '~')}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to read directory');
        }

        currentFolderPickerDirectory = data.current || dirPath;
        if (pathInput) pathInput.value = currentFolderPickerDirectory;

        if (upBtn) {
          upBtn.disabled = !data.parent;
          upBtn.dataset.parent = data.parent || '';
        }

        const dirs = data.directories || [];
        if (dirs.length === 0) {
          listEl.innerHTML = `
            <div style="color:var(--text-faint);padding:24px;text-align:center;font-size:12px;">
              No subdirectories found in this folder.<br>
              <span style="font-size:11px;color:var(--text-dim);margin-top:6px;display:inline-block;">You can click "Select This Folder" to use this location.</span>
            </div>
          `;
          return;
        }

        listEl.innerHTML = '';
        for (const dir of dirs) {
          const item = document.createElement('div');
          item.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 12px;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.15s ease;
            background: var(--surface);
            border: 1px solid var(--border-soft);
          `;
          item.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;overflow:hidden;">
              <span style="font-size:16px;">📁</span>
              <span style="font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(dir.name)}</span>
            </div>
            <span style="font-size:11px;color:var(--text-faint);font-family:'IBM Plex Mono',monospace;">Enter →</span>
          `;
          item.onmouseenter = () => {
            item.style.background = 'var(--surface-2)';
            item.style.borderColor = 'var(--accent)';
          };
          item.onmouseleave = () => {
            item.style.background = 'var(--surface)';
            item.style.borderColor = 'var(--border-soft)';
          };
          item.onclick = () => {
            loadFolderPickerDirectory(dir.path);
          };
          listEl.appendChild(item);
        }
      } catch (err) {
        listEl.innerHTML = `
          <div style="color:var(--red);padding:14px;font-size:12px;text-align:center;">
            ⚠️ ${escapeHtml(err.message)}<br>
            <button class="btn-ghost" style="margin-top:8px;padding:4px 10px;font-size:11.5px;" onclick="loadFolderPickerDirectory('~')">Go to Home (~)</button>
          </div>
        `;
      }
    };

    window.navigateFolderPickerUp = function () {
      const upBtn = document.getElementById('fp-up-btn');
      const parent = upBtn?.dataset?.parent;
      if (parent) {
        loadFolderPickerDirectory(parent);
      }
    };

    window.createFolderInPicker = async function () {
      const name = prompt("Enter new folder name:");
      if (!name || !name.trim()) return;
      const cleanName = name.trim().replace(/[^a-zA-Z0-9_\-\.]/g, "_");
      const targetPath = `${currentFolderPickerDirectory}/${cleanName}`;

      try {
        const res = await fetch("/api/fs/mkdir", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: targetPath }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to create folder");
        await loadFolderPickerDirectory(data.path || targetPath);
      } catch (e) {
        alert("Failed creating folder: " + e.message);
      }
    };

    window.applySelectedFolder = function () {
      const pathInput = document.getElementById('fp-current-path');
      const chosenPath = pathInput?.value?.trim() || currentFolderPickerDirectory;
      if (chosenPath && activeFolderPickerTargetId) {
        const targetInput = document.getElementById(activeFolderPickerTargetId);
        if (targetInput) {
          targetInput.value = chosenPath;
          targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      closeFolderPickerModal();
    };

    window.nativeFolderPicker = async function () {
      if ('showDirectoryPicker' in window) {
        try {
          const dirHandle = await window.showDirectoryPicker();
          if (dirHandle && dirHandle.name) {
            const suggested = `${currentFolderPickerDirectory}/${dirHandle.name}`;
            const targetInput = document.getElementById(activeFolderPickerTargetId);
            if (targetInput) {
              targetInput.value = suggested;
              targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            closeFolderPickerModal();
            return;
          }
        } catch (err) {
          if (err.name !== 'AbortError') console.warn('Native picker error:', err);
        }
      }
      document.getElementById('fp-native-input')?.click();
    };

    window.handleNativeFolderSelected = function (e) {
      const files = e.target.files;
      if (files && files.length > 0) {
        const relativePath = files[0].webkitRelativePath || '';
        const rootFolder = relativePath.split('/')[0];
        if (rootFolder) {
          const suggested = `${currentFolderPickerDirectory}/${rootFolder}`;
          const targetInput = document.getElementById(activeFolderPickerTargetId);
          if (targetInput) {
            targetInput.value = suggested;
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          closeFolderPickerModal();
        }
      }
    };

    // ---------------- Agent Task Dispatch & Controls ----------------
    window.openDispatchTaskModal = function(agentId, agentName) {
      const a = agentId ? (activeRoom()?.agents?.find(x => x.id === agentId)) : (ccAgent() || activeRoom()?.agents?.find(x => x.id === selectedAgentId));
      const targetId = a?.id || agentId;
      const targetName = a?.name || agentName || 'Selected Agent';
      
      document.getElementById('dt-agent-id').value = targetId || '';
      document.getElementById('dt-agent-name').textContent = targetName;
      document.getElementById('dt-title').value = '';
      document.getElementById('dt-spec').value = '';
      document.getElementById('dt-err').style.display = 'none';
      document.getElementById('dispatch-task-modal').classList.add('open');
      setTimeout(() => document.getElementById('dt-title')?.focus(), 50);
    };

    window.closeDispatchTaskModal = function() {
      document.getElementById('dispatch-task-modal').classList.remove('open');
    };

    window.submitDispatchTask = async function() {
      const agentId = document.getElementById('dt-agent-id').value;
      const title = document.getElementById('dt-title').value.trim();
      const spec = document.getElementById('dt-spec').value.trim();
      const timeout = Number(document.getElementById('dt-timeout').value) || 120;
      const budget = Number(document.getElementById('dt-budget').value) || 1.0;
      const errEl = document.getElementById('dt-err');
      const submitBtn = document.getElementById('dt-submit-btn');

      if (!title) {
        errEl.textContent = 'Please provide a task title or objective.';
        errEl.style.display = 'block';
        return;
      }
      errEl.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.textContent = 'Launching…';

      try {
        const room = activeRoom();
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: room.id,
            agentId: agentId || null,
            title,
            spec,
            budgetSeconds: timeout,
            budgetUsd: budget,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Failed to dispatch task');
        }

        // Directly type and submit the task into the agent's interactive terminal!
        const taskPrompt = title + (spec ? `\n\n${spec}` : '');
        const targetAgent = activeRoom()?.agents?.find(x => x.id === agentId) || ccAgent();
        if (targetAgent) {
          const ptyName = 'pty-' + (targetAgent.name || 'agent').toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + (targetAgent.id || '000').slice(-8);
          const entry = getOrCreateTerminalEntry(ptyName, targetAgent);
          if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify({ type: 'submitPrompt', ptyId: ptyName, text: taskPrompt }));
          }
        }

        closeDispatchTaskModal();
        closeAgentPopup();
        if (viewMode === 'agent') renderCommandCenter();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 Launch Task';
      }
    };

    window.controlActiveTask = async function(action) {
      const a = ccAgent() || activeRoom()?.agents?.find(x => x.id === selectedAgentId);
      const taskId = a?.task?.id;
      if (!taskId) {
        alert('No active task to ' + action);
        return;
      }
      if (action === 'halt') {
        if (!confirm(`Are you sure you want to halt and abort task "${a.task.title}"?`)) return;
      }
      try {
        const res = await fetch(`/api/tasks/${taskId}/${action}`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          alert(`Failed to ${action} task: ` + (data.error || res.statusText));
        } else {
          if (viewMode === 'agent') renderCommandCenter();
        }
      } catch (e) {
        alert(`Error communicating with server: ` + e.message);
      }
    };

    window.promptQuickSteer = function() {
      const a = ccAgent() || activeRoom()?.agents?.find(x => x.id === selectedAgentId);
      if (!a) return;
      const text = prompt(`🧭 Inject steering context for ${a.name}:\n(Guide what to focus on or avoid)`);
      if (!text || !text.trim()) return;
      fetch(`/api/agents/${a.id}/steer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      }).then(r => r.json()).then(data => {
        if (data.ok) alert(`Steered: "${text.trim()}"`);
        else alert('Steer failed: ' + data.error);
      }).catch(e => alert('Failed: ' + e));
    };

    window.openCommanderBreakdownModal = function() {
      document.getElementById('cbd-title').value = '';
      document.getElementById('cbd-spec').value = '';
      document.getElementById('cbd-err').style.display = 'none';
      document.getElementById('commander-breakdown-modal').classList.add('open');
      setTimeout(() => document.getElementById('cbd-title')?.focus(), 50);
    };

    window.closeCommanderBreakdownModal = function() {
      document.getElementById('commander-breakdown-modal').classList.remove('open');
    };

    window.submitCommanderBreakdown = async function() {
      const title = document.getElementById('cbd-title').value.trim();
      const spec = document.getElementById('cbd-spec').value.trim();
      const errEl = document.getElementById('cbd-err');
      const btn = document.getElementById('cbd-submit-btn');

      if (!title) {
        errEl.textContent = 'Please specify an epic goal title.';
        errEl.style.display = 'block';
        return;
      }
      errEl.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Decomposing…';

      try {
        const room = activeRoom();
        const commander = ccAgent() || room?.agents?.find(x => isOrchestrator(x)) || room?.agents?.[0];
        const res = await fetch('/api/commander/breakdown', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: room.id,
            title,
            spec,
            commanderId: commander?.id,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Failed to breakdown epic');
        }
        closeCommanderBreakdownModal();
        setView('tasks');
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = '👑 Decompose & Delegate →';
      }
    };

    // ---------------- Command Center (one agent) ----------------
    //
    // A full view rather than a docked panel: the office keeps its right side
    // empty, and this is a place you go, not something crowding the floor.

    let ccAgentId = null;
    let ccTab = 'terminal';
    // Fetched once. The catalog is static reference data served over HTTP
    // (apps/server/src/commands.ts) precisely so it does NOT ride the view
    // broadcast, which re-sends on every position message.
    let ccCatalogs = null;
    let ccCatalogsPending = null;

    function ccLoadCatalogs() {
      if (ccCatalogs) return Promise.resolve(ccCatalogs);
      if (!ccCatalogsPending) {
        ccCatalogsPending = fetch('/api/commands')
          .then((r) => r.json())
          .then((d) => { ccCatalogs = d.catalogs ?? []; return ccCatalogs; })
          .catch(() => { ccCatalogsPending = null; return null; });
      }
      return ccCatalogsPending;
    }

    /** Re-read from the latest view on every render, so status and task stay
     *  live rather than frozen at the moment the view was opened. */
    function ccAgent() {
      for (const r of latestView?.rooms ?? [])
        for (const a of r.agents ?? []) if (a.id === ccAgentId) return a;
      return null;
    }

    window.openMeetingPrompt = async function () {
      const a = ccAgent();
      if (!a) return;
      const roomAgents = (latestView?.rooms?.[0]?.agents || []).filter((other) => other.id !== a.id);
      if (roomAgents.length === 0) {
        alert("No other agents available to meet with.");
        return;
      }
      const names = roomAgents.map((o, idx) => `${idx + 1}. ${o.name} (${o.role || 'Specialist'})`).join("\n");
      const choice = prompt(`Summon ${a.name} into the Meeting Room with an agent:\n\n${names}\n\nEnter agent number (1-${roomAgents.length}):`);
      if (!choice) return;
      const idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || !roomAgents[idx]) {
        alert("Invalid selection.");
        return;
      }
      const target = roomAgents[idx];
      try {
        await fetch('/api/hive/meeting', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agentA: a.id,
            agentB: target.id,
            action: 'start',
            durationSeconds: 60,
            reason: `Conference between ${a.name} and ${target.name}`,
          }),
        });
      } catch (err) {
        alert("Failed to initiate meeting: " + err);
      }
    };

    window.openCommandCenter = function (agentId, tab) {
      ccAgentId = agentId;
      if (tab) ccTab = tab;
      else ccTab = 'terminal';
      setView('agent');
      ccLoadCatalogs().then(() => { if (currentView === 'agent') renderCommandCenter(); });
    };

    function isOrchestrator(a) { return a && a.role === 'planner'; }

    // Five tabs, all of them genuinely ABOUT THIS AGENT.
    //
    // The previous build had twenty-one, and about half rendered identical
    // content for every agent in the room — Goals, Approvals, System Ops,
    // Sequence Flow and Workflows didn't even read the agent, they failed
    // with "No active project room selected". Those are project-scoped and
    // belong in the project nav; System Ops is server-scoped and belongs in
    // Settings. Steer became an action (it is one textarea and a submit) and
    // Commands became a drawer (it is a static catalogue, not live state).
    const CC_TAB_ICONS = {
      terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
      traces:   '<path d="M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 1 5-5l2-2-2-2-2 2z"/>',
      monitor:  '<rect x="3" y="4" width="12" height="9" rx="1"/><path d="M8 17h8a2 2 0 0 0 2-2V9M15 20h6"/>',
      git:      '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="17" cy="9" r="2.5"/><path d="M6 8.5v7M17 11.5c0 3-3 4-6 4.5"/>',
      memory:   '<path d="M9.5 3A3.5 3.5 0 0 0 6 6.5v.6A3 3 0 0 0 6 13v3a3 3 0 0 0 6 0V6.5A3.5 3.5 0 0 0 9.5 3z"/><path d="M14.5 3A3.5 3.5 0 0 1 18 6.5v.6a3 3 0 0 1 0 5.9v3a3 3 0 0 1-6 0"/>',
    };
    function getCCTabs(a) {
      return [
        { id: 'terminal', label: 'Terminal' },
        { id: 'traces',   label: 'Traces'   },
        { id: 'monitor',  label: 'Monitor'  },
        { id: 'git',      label: 'Git'      },
        { id: 'memory',   label: 'Memory'   },
      ];
    }
    const CC_TABS = getCCTabs(null);

    // ---- Commands drawer ----------------------------------------------
    function renderCommandsDrawerBody() {
      const a = ccAgent();
      const body = document.getElementById('cc-drawer-body');
      if (!a || !body) return;
      body.innerHTML = '';

      if (ccCatalogs === null) {
        body.innerHTML = '<div class="empty-note">Loading commands…</div>';
        ccLoadCatalogs().then(renderCommandsDrawerBody);
        return;
      }
      // Keyed by the agent's own provider: showing Claude's commands under an
      // agent running something else would be confidently wrong.
      const cat = ccCatalogs.find((c) => c.providerId === a.provider);
      if (!cat) {
        const note = document.createElement('div');
        note.className = 'empty-note';
        note.textContent = a.provider
          ? 'No command reference has been written for ' + a.provider + ' yet.'
          : "This agent runs the machine's default harness, which has no command reference.";
        body.appendChild(note);
        return;
      }

      for (const g of cat.groups ?? []) {
        for (const c of g.commands ?? []) {
          const row = document.createElement('div');
          row.className = 'cc-cmd-row';
          const kind = document.createElement('span');
          kind.className = 'cc-cmd-kind';
          kind.textContent = (g.title || c.kind || 'cmd').toUpperCase().slice(0, 9);
          const main = document.createElement('div');
          main.className = 'cc-cmd-main';
          const code = document.createElement('div');
          code.className = 'cc-cmd-code';
          code.textContent = c.name || '';
          const desc = document.createElement('div');
          desc.className = 'cc-cmd-desc';
          desc.textContent = c.description || '';
          main.append(code, desc);
          row.append(kind, main);
          body.appendChild(row);
        }
      }
    }

    function openCommandsDrawer() {
      if (!ccAgent()) return;
      renderCommandsDrawerBody();
      document.getElementById('cc-drawer').classList.add('open');
      document.getElementById('cc-drawer-scrim').classList.add('open');
    }
    function closeCommandsDrawer() {
      document.getElementById('cc-drawer').classList.remove('open');
      document.getElementById('cc-drawer-scrim').classList.remove('open');
    }
    window.openCommandsDrawer = openCommandsDrawer;
    window.closeCommandsDrawer = closeCommandsDrawer;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCommandsDrawer();
    });

    // ---- Steer: an action, not a tab ----------------------------------
    // Steering injects context through the existing task channel, so it works
    // whether or not a task is running: live if there is one, on the next task
    // if there isn't. The server tells us which happened.
    async function openSteerDialog() {
      const a = ccAgent();
      if (!a) return;
      const text = prompt(
        `Steer ${a.name} — inject guidance, a constraint, or a correction.\n` +
        `Applies to the running task if there is one, otherwise to its next task.`
      );
      if (!text || !text.trim()) return;
      const errEl = document.getElementById('cc-manage-err');
      try {
        const res = await fetch(`/api/agents/${a.id}/steer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: text.trim() }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) throw new Error(j.error || `steer failed (${res.status})`);
        if (errEl) {
          errEl.style.display = 'inline';
          errEl.style.color = 'var(--st-working)';
          errEl.textContent = j.mode === 'live'
            ? 'Steered the running task.'
            : 'Saved — applies to the next task.';
          setTimeout(() => { errEl.style.display = 'none'; errEl.style.color = ''; }, 4000);
        }
      } catch (err) {
        if (errEl) { errEl.style.display = 'inline'; errEl.style.color = ''; errEl.textContent = err.message; }
      }
    }
    window.openSteerDialog = openSteerDialog;

    function renderCommandCenter() {
      const a = ccAgent();
      const body = document.getElementById('cc-body');
      if (!a) {
        document.getElementById('cc-name').textContent = 'Agent not found';
        document.getElementById('cc-status').textContent = '—';
        document.getElementById('cc-desc').textContent = '';
        document.getElementById('cc-tabs').innerHTML = '';
        body.innerHTML = '<div class="empty-note">That agent is no longer in this room.</div>';
        const ccBtn2 = document.getElementById('cc-summon-btn');
        if (ccBtn2) ccBtn2.style.display = 'none';
        return;
      }

      document.getElementById('cc-name').textContent = a.name;
      const statusEl = document.getElementById('cc-status');
      // The pill's tint is the office room this status maps to, so the header
      // and the floor agree without anyone having to learn a second legend.
      const STATUS_TINT = {
        working: 's-working', reviewing: 's-reviewing', collaborating: 's-reviewing',
        needs_input: 's-needs', blocked: 's-blocked', idle: 's-idle', done: 's-done',
      };
      if (a.zone === 'collaborating') {
        statusEl.textContent = 'In meeting';
        statusEl.className = 'cc-status-pill s-reviewing';
        const partner = a.waitingOn ? 'with ' + a.waitingOn : '';
        document.getElementById('cc-desc').textContent = `Collaborating ${partner} in the meeting room`;
      } else {
        statusEl.textContent = String(a.status || 'idle').replace(/_/g, ' ');
        statusEl.className = 'cc-status-pill ' + (STATUS_TINT[a.status] || 's-idle');
        document.getElementById('cc-desc').textContent = a.description || (a.role + ' · ' + a.machineName);
      }

      // Which surface this is. The old build made you infer it from which tabs
      // appeared, which nobody reads as a signal.
      const roleBadge = document.getElementById('cc-role-badge');
      if (roleBadge) {
        const orch = isOrchestrator(a);
        roleBadge.textContent = orch ? 'ORCHESTRATOR' : 'EMPLOYEE AGENT';
        roleBadge.className = 'cc-role-badge' + (orch ? ' is-orchestrator' : '');
      }

      const portrait = document.getElementById('cc-portrait');
      const sprite = (a.character && CHAR_NAMES.includes(a.character))
        ? a.character
        : CHAR_NAMES[hashString(a.id) % CHAR_NAMES.length];
      portrait.style.backgroundImage = 'url(/assets/characters/' + sprite + '.png)';

      // Phase 4: summon button in Command Center header — same real event as the popup
      const ccBtn = document.getElementById('cc-summon-btn');
      const ccErr = document.getElementById('cc-summon-err');
      if (ccBtn) {
        const isSummoned = !!(a.summonedPos && a.summonedPos.x != null);
        ccBtn.style.display = 'inline-block';
        if (isSummoned) {
          ccBtn.textContent = 'Dismiss';
          ccBtn.classList.add('dismiss');
          ccBtn.onclick = () => doDismissSummon(a.id);
        } else {
          ccBtn.textContent = 'Call here';
          ccBtn.classList.remove('dismiss');
          ccBtn.onclick = () => doSummon(a.id);
        }
        if (ccErr) { ccErr.textContent = ''; ccErr.style.display = 'none'; }
      }

      const availTabs = getCCTabs(a);
      if (!availTabs.some((t) => t.id === ccTab)) ccTab = availTabs[0]?.id ?? 'terminal';

      // Delegate Epic is the orchestrator's own verb — breaking an epic into
      // tasks is what makes it the orchestrator.
      const breakdownBtn = document.getElementById('cc-breakdown-btn');
      if (breakdownBtn) breakdownBtn.style.display = isOrchestrator(a) ? 'inline-flex' : 'none';

      // Task controls only exist while there is a task to control.
      const taskPauseBtn = document.getElementById('cc-task-pause-btn');
      const taskResumeBtn = document.getElementById('cc-task-resume-btn');
      const taskHaltBtn = document.getElementById('cc-task-halt-btn');
      const activeTask = a.task;
      if (activeTask && activeTask.title) {
        if (taskHaltBtn) taskHaltBtn.style.display = 'inline-flex';
        const held = a.status === 'waiting' || a.status === 'paused';
        if (taskPauseBtn) taskPauseBtn.style.display = held ? 'none' : 'inline-flex';
        if (taskResumeBtn) taskResumeBtn.style.display = held ? 'inline-flex' : 'none';
      } else {
        if (taskPauseBtn) taskPauseBtn.style.display = 'none';
        if (taskResumeBtn) taskResumeBtn.style.display = 'none';
        if (taskHaltBtn) taskHaltBtn.style.display = 'none';
      }

      // Pause/Resume the AGENT (distinct from pausing its current task).
      const pauseBtn = document.getElementById('cc-pause-btn');
      if (pauseBtn) {
        const lbl = pauseBtn.querySelector('svg')?.nextSibling;
        const txt = a.paused ? 'Resume' : 'Pause';
        if (lbl) lbl.textContent = ' ' + txt; else pauseBtn.textContent = txt;
      }

      const tabs = document.getElementById('cc-tabs');
      tabs.innerHTML = '';
      for (const t of availTabs) {
        const b = document.createElement('button');
        b.className = 'cc-tab' + (t.id === ccTab ? ' active' : '');
        b.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' +
          (CC_TAB_ICONS[t.id] || '') + '</svg>';
        b.appendChild(document.createTextNode(t.label));
        b.onclick = () => { ccTab = t.id; renderCommandCenter(); };
        tabs.appendChild(b);
      }

      body.innerHTML = '';
      if (ccTab === 'terminal') ccRenderTerminal(body, a);
      else if (ccTab === 'memory') ccRenderMemory(body, a);
      else if (ccTab === 'traces') ccRenderTraces(body, a);
      else if (ccTab === 'monitor') ccRenderMonitor(body, a);
      else if (ccTab === 'git') ccRenderGit(body, a);
      else ccRenderTerminal(body, a);
    }

    function ccRenderCommands(body, a) {
      if (ccCatalogs === null) {
        body.innerHTML = '<div class="empty-note">Loading commands\u2026</div>';
        ccLoadCatalogs().then(() => { if (currentView === 'agent') renderCommandCenter(); });
        return;
      }
      // Keyed by the agent's own provider: showing Claude's commands under an
      // agent running something else would be confidently wrong.
      const cat = ccCatalogs.find((c) => c.providerId === a.provider);
      if (!cat) {
        const note = document.createElement('div');
        note.className = 'empty-note';
        note.textContent = a.provider
          ? 'No command reference has been written for ' + a.provider + ' yet.'
          : "This agent runs the machine's default harness, which has no command reference.";
        body.appendChild(note);
        return;
      }

      const note = document.createElement('div');
      note.className = 'cmd-note';
      note.textContent = cat.note;
      body.appendChild(note);

      for (const g of cat.groups) {
        const h = document.createElement('div');
        h.className = 'cmd-group-title';
        h.textContent = g.title;
        body.appendChild(h);

        for (const c of g.commands) {
          const row = document.createElement('div');
          row.className = 'cmd-row';

          const badge = document.createElement('span');
          badge.className = 'cmd-badge ' + c.kind;
          badge.textContent = c.kind;

          const main = document.createElement('div');
          main.className = 'cmd-main';
          const name = document.createElement('div');
          name.className = 'cmd-name';
          name.textContent = c.name;      // server-authored, still never innerHTML
          const desc = document.createElement('div');
          desc.className = 'cmd-desc';
          desc.textContent = c.description;
          main.append(name, desc);
          if (c.example) {
            const eg = document.createElement('div');
            eg.className = 'cmd-eg';
            eg.textContent = 'e.g. ' + c.example;
            main.appendChild(eg);
          }

          const copy = document.createElement('button');
          copy.className = 'cmd-copy';
          copy.textContent = 'copy';
          copy.onclick = () => {
            // The example is the runnable form where one exists.
            const text = c.example || c.name;
            const done = () => {
              copy.textContent = 'copied';
              setTimeout(() => { copy.textContent = 'copy'; }, 1200);
            };
            // navigator.clipboard needs a secure context and a permission the
            // page may not have (plain http on a LAN address, for one — which
            // is exactly how this office gets used). Falling back to a
            // selection means the button always does something useful rather
            // than reporting "blocked" and leaving you stuck.
            const fallback = () => {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
              document.body.appendChild(ta);
              ta.select();
              let ok = false;
              try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
              ta.remove();
              if (ok) done();
              else { copy.textContent = 'select & ⌘C'; setTimeout(() => { copy.textContent = 'copy'; }, 2000); }
            };
            if (navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(text).then(done, fallback);
            } else {
              fallback();
            }
          };

          row.append(badge, main, copy);
          body.appendChild(row);
        }
      }
    }

    function ccRenderActivity(body, a) {
      // The room feed narrowed to this agent — same server-projected wording
      // as the main feed, so the browser still invents no story of its own.
      const room = activeRoom();
      const mine = (room?.activity ?? []).filter((it) => it.actor === a.name);
      if (!mine.length) {
        body.innerHTML = '<div class="empty-note">Nothing recorded for this agent yet.</div>';
        return;
      }
      for (const it of mine) {
        const row = document.createElement('div');
        row.className = 'cmd-row';
        const main = document.createElement('div');
        main.className = 'cmd-main';
        const t = document.createElement('div');
        t.className = 'cmd-desc';
        t.textContent = it.summary;
        main.appendChild(t);
        row.appendChild(main);
        body.appendChild(row);
      }
    }

    function ccRenderPulls(body, a) {
      body.innerHTML = '';
      const room = activeRoom();
      const pulls = room?.pulls ?? [];
      // gh_repo is overloaded in this codebase — the GitHub mirror writes
      // "owner/repo" slugs there, but a project created by hand can have a
      // local filesystem path in the same column (see routes/agents.ts's use
      // of it as a workspace folder). Only build a github.com link when it
      // actually looks like a slug, so a local path never becomes a bogus URL.
      const repoSlug = room?.ghRepo && /^[\w.-]+\/[\w.-]+$/.test(room.ghRepo) ? room.ghRepo : null;

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
      const title = document.createElement('span');
      title.style.cssText = 'font-weight:700;font-size:13px;';
      title.textContent = 'Pull Requests';
      const sub = document.createElement('span');
      sub.style.cssText = 'font-size:11px;color:var(--text-faint);';
      sub.textContent = repoSlug ? repoSlug : 'no linked repo';
      header.append(title, sub);
      body.appendChild(header);

      if (!pulls.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-note';
        empty.textContent = repoSlug
          ? 'No pull requests yet.'
          : 'This room has no GitHub repo linked — the mirror only tracks projects created from a repo.';
        body.appendChild(empty);
        return;
      }

      const stateBadge = { open: 'badge-working', draft: 'badge-idle', merged: 'badge-working', closed: 'badge-blocked' };
      const ciBadge = { success: 'badge-working', pending: 'badge-needs', failure: 'badge-blocked' };

      const sorted = [...pulls].sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || ''));
      for (const pr of sorted) {
        const row = document.createElement('div');
        row.className = 'cmd-row';

        const main = document.createElement('div');
        main.className = 'cmd-main';

        const t = document.createElement('div');
        t.className = 'cmd-desc';
        t.style.cssText = 'font-weight:600;';
        t.textContent = `#${pr.number} ${pr.title}`;
        main.appendChild(t);

        const metaLine = document.createElement('div');
        metaLine.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;';

        const st = document.createElement('span');
        st.className = 'inspector-badge ' + (stateBadge[pr.state] || 'badge-idle');
        st.textContent = pr.state;
        metaLine.appendChild(st);

        if (pr.ci) {
          const ci = document.createElement('span');
          ci.className = 'inspector-badge ' + (ciBadge[pr.ci] || 'badge-idle');
          ci.textContent = 'CI: ' + pr.ci;
          metaLine.appendChild(ci);
        }

        const meta = document.createElement('span');
        meta.style.cssText = 'font-size:11px;color:var(--text-faint);';
        meta.textContent = (pr.author ? 'by ' + pr.author + ' · ' : '') + relativeTime(pr.updatedAt);
        metaLine.appendChild(meta);

        main.appendChild(metaLine);
        row.appendChild(main);

        if (repoSlug) {
          const link = document.createElement('a');
          link.href = `https://github.com/${repoSlug}/pull/${pr.number}`;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'code-btn';
          link.style.cssText = 'align-self:center;text-decoration:none;';
          link.textContent = 'Open ↗';
          row.appendChild(link);
        }

        body.appendChild(row);
      }
    }

    function ccRenderTasks(body, a) {
      body.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'kanban-wrapper';

      const topbar = document.createElement('div');
      topbar.className = 'kanban-topbar';

      const titleWrap = document.createElement('div');
      titleWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const title = document.createElement('span');
      title.style.cssText = 'font-weight:700;font-size:13px;';
      title.textContent = 'Hive Kanban Board';
      const note = document.createElement('span');
      note.style.cssText = 'font-size:11px;color:var(--text-faint);';
      note.textContent = 'Synced with tasks.json';
      titleWrap.append(title, note);

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;';

      const filterBtn = document.createElement('button');
      filterBtn.className = 'code-btn';
      filterBtn.textContent = window._ccTaskFilterAgent ? `Showing: ${a.name}` : 'Showing: All Agents';
      filterBtn.title = 'Toggle between showing all tasks or only this agent';
      filterBtn.onclick = () => {
        window._ccTaskFilterAgent = !window._ccTaskFilterAgent;
        ccRenderTasks(body, a);
      };

      const newBtn = document.createElement('button');
      newBtn.className = 'code-btn';
      newBtn.style.cssText = 'background:var(--accent);color:#fff;border-color:var(--accent);font-weight:700;';
      newBtn.textContent = '+ New Task';
      newBtn.onclick = async () => {
        const taskTitle = prompt('Enter task title:');
        if (!taskTitle || !taskTitle.trim()) return;
        const taskDesc = prompt('Enter task description (optional):') || '';
        const projId = a.projectId || a.project_id || activeRoom()?.id || '';
        try {
          await fetch('/api/hive/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              title: taskTitle.trim(),
              description: taskDesc.trim(),
              status: 'todo',
              assigned_to: a.id,
              projectId: projId,
              priority: 'medium',
            })
          });
          ccRenderTasks(body, a);
        } catch (e) {
          alert('Failed creating task: ' + e);
        }
      };

      actions.append(filterBtn, newBtn);
      topbar.append(titleWrap, actions);
      wrapper.appendChild(topbar);

      const board = document.createElement('div');
      board.className = 'kanban-board';
      wrapper.appendChild(board);
      body.appendChild(wrapper);

      const colDefs = [
        { key: 'todo', label: '📋 To Do' },
        { key: 'in_progress', label: '⚡ In Progress' },
        { key: 'in_review', label: '🔍 In Review' },
        { key: 'done', label: '✅ Done' },
      ];

      const renderBoard = (taskList) => {
        board.innerHTML = '';
        const filtered = window._ccTaskFilterAgent
          ? taskList.filter((t) => t.assigned_to === a.id || t.assigned_to === a.name)
          : taskList;

        colDefs.forEach((col, colIdx) => {
          const colEl = document.createElement('div');
          colEl.className = 'kanban-col';

          const colTasks = filtered.filter((t) => (t.status || 'todo') === col.key);

          const head = document.createElement('div');
          head.className = 'kanban-col-head';
          head.innerHTML = `<span>${col.label}</span><span class="kanban-col-count">${colTasks.length}</span>`;
          colEl.appendChild(head);

          const list = document.createElement('div');
          list.className = 'kanban-list';

          if (!colTasks.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:var(--text-faint);font-size:11px;text-align:center;padding:24px 0;font-style:italic;';
            empty.textContent = 'No tasks';
            list.appendChild(empty);
          } else {
            colTasks.forEach((task) => {
              const card = document.createElement('div');
              card.className = 'kanban-card';

              const cardTitle = document.createElement('div');
              cardTitle.className = 'kanban-card-title';
              cardTitle.textContent = task.title;

              const cardDesc = document.createElement('div');
              cardDesc.className = 'kanban-card-desc';
              cardDesc.textContent = task.description || 'No description provided.';

              const meta = document.createElement('div');
              meta.className = 'kanban-card-meta';

              const pri = document.createElement('span');
              pri.className = 'kanban-priority priority-' + (task.priority || 'medium');
              pri.textContent = task.priority || 'medium';

              const navRow = document.createElement('div');
              navRow.style.cssText = 'display:flex;gap:4px;';

              if (colIdx > 0) {
                const prevBtn = document.createElement('button');
                prevBtn.className = 'kanban-nav-btn';
                prevBtn.innerHTML = '◀';
                prevBtn.title = 'Move to ' + colDefs[colIdx - 1].label;
                prevBtn.onclick = async () => {
                  await fetch('/api/hive/tasks', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ ...task, status: colDefs[colIdx - 1].key })
                  });
                  loadTasks();
                };
                navRow.appendChild(prevBtn);
              }

              if (colIdx < colDefs.length - 1) {
                const nextBtn = document.createElement('button');
                nextBtn.className = 'kanban-nav-btn';
                nextBtn.innerHTML = '▶';
                nextBtn.title = 'Move to ' + colDefs[colIdx + 1].label;
                nextBtn.onclick = async () => {
                  await fetch('/api/hive/tasks', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ ...task, status: colDefs[colIdx + 1].key })
                  });
                  loadTasks();
                };
                navRow.appendChild(nextBtn);
              }

              meta.append(pri, navRow);
              card.append(cardTitle, cardDesc, meta);
              list.appendChild(card);
            });
          }

          colEl.appendChild(list);
          board.appendChild(colEl);
        });
      };

      const loadTasks = async () => {
        try {
          const projId = a.projectId || a.project_id || activeRoom()?.id || '';
          const res = await fetch(`/api/hive/tasks?agentId=${encodeURIComponent(a.id || '')}&projectId=${encodeURIComponent(projId)}`);
          if (res.ok) {
            const data = await res.json();
            renderBoard(data.tasks || []);
          }
        } catch {
          // Fallback to room tasks if server endpoint unavailable
          const room = activeRoom();
          const fallback = (room?.tasks ?? []).map((t) => ({
            id: t.id,
            title: t.title,
            description: t.state,
            status: t.state === 'done' ? 'done' : (t.state === 'working' ? 'in_progress' : 'todo'),
            assigned_to: t.agentId,
            priority: 'medium',
          }));
          renderBoard(fallback);
        }
      };

      loadTasks();
    }

    let _activeAttemptsReq = 0;
    function ccRenderAttempts(body, a) {
      body.innerHTML = '';
      const reqId = ++_activeAttemptsReq;

      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

      const titleWrap = document.createElement('div');
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:13px;';
      title.textContent = 'Execution Attempts & Retry History';
      const note = document.createElement('div');
      note.className = 'cmd-note';
      note.style.margin = '2px 0 0 0';
      note.textContent = a.task?.title ? `Task: ${a.task.title}` : 'Recent execution attempts for this agent';
      titleWrap.append(title, note);

      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'code-btn';
      refreshBtn.textContent = '🔄 Refresh Attempts';
      refreshBtn.onclick = () => ccRenderAttempts(body, a);

      topRow.append(titleWrap, refreshBtn);
      body.appendChild(topRow);

      const placeholder = document.createElement('div');
      placeholder.className = 'empty-note';
      placeholder.textContent = 'Loading task attempts…';
      body.appendChild(placeholder);

      const taskId = a.task?.id || a.current_task;
      const fetchPromise = taskId
        ? fetch(`/api/tasks/${taskId}/attempts`).then(r => r.json())
        : fetch(`/api/agents/${a.id}/tasks?limit=10`).then(r => r.json()).then(async (tData) => {
            const firstTask = tData.tasks?.[0];
            if (!firstTask) return { ok: true, attempts: [] };
            note.textContent = `Task: ${firstTask.title || firstTask.id}`;
            const attRes = await fetch(`/api/tasks/${firstTask.id}/attempts`);
            return attRes.json();
          });

      fetchPromise
        .then((data) => {
          if (reqId !== _activeAttemptsReq) return;
          if (!data || !data.ok) {
            placeholder.textContent = `Could not load attempts (${data?.error || 'Unknown error'}).`;
            return;
          }
          const attempts = data.attempts ?? [];
          if (!attempts.length) {
            placeholder.textContent = 'No execution attempts recorded for this task yet.';
            return;
          }
          placeholder.remove();

          const list = document.createElement('div');
          list.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

          for (const att of attempts) {
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;';

            const cardHead = document.createElement('div');
            cardHead.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

            const numWrap = document.createElement('div');
            numWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
            const num = document.createElement('span');
            num.style.cssText = 'font-weight:700;font-size:14px;color:var(--text);';
            num.textContent = `Attempt #${att.attempt_number}`;
            numWrap.appendChild(num);

            const badge = document.createElement('span');
            badge.className = 'inspector-badge';
            const st = (att.state || 'running').toLowerCase();
            if (st === 'completed') {
              badge.textContent = '✓ Completed';
              badge.style.cssText = 'background:rgba(34,197,94,0.15);color:var(--st-working);border:1px solid rgba(34,197,94,0.3);';
            } else if (st === 'failed') {
              badge.textContent = '✕ Failed';
              badge.style.cssText = 'background:rgba(221,85,75,0.15);color:var(--st-fail);border:1px solid rgba(221,85,75,0.3);';
            } else if (st === 'timed_out') {
              badge.textContent = '⏱ Timed Out';
              badge.style.cssText = 'background:rgba(212,157,73,0.15);color:var(--st-blocked);border:1px solid rgba(212,157,73,0.3);';
            } else if (st === 'canceled') {
              badge.textContent = '⊘ Canceled';
              badge.style.cssText = 'background:rgba(148,163,184,0.15);color:var(--text-dim);border:1px solid rgba(148,163,184,0.3);';
            } else {
              badge.textContent = '● Running';
              badge.style.cssText = 'background:rgba(59,130,246,0.15);color:#60a5fa;border:1px solid rgba(59,130,246,0.3);';
            }
            cardHead.append(numWrap, badge);

            const metaGrid = document.createElement('div');
            metaGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px;font-size:11.5px;color:var(--text-faint);background:var(--surface-2);padding:9px 12px;border-radius:7px;border:1px solid var(--border-soft);';

            const startStr = att.started_at ? new Date(att.started_at).toLocaleTimeString() : '—';
            let durationStr = '—';
            if (att.started_at) {
              const startMs = new Date(att.started_at).getTime();
              const endMs = att.ended_at ? new Date(att.ended_at).getTime() : Date.now();
              const sec = Math.max(0, Math.floor((endMs - startMs) / 1000));
              durationStr = `${Math.floor(sec / 60)}m ${sec % 60}s`;
            }

            metaGrid.innerHTML = `
              <div><span style="color:var(--text-muted);">Started:</span> ${escapeHtml(startStr)}</div>
              <div><span style="color:var(--text-muted);">Duration:</span> ${escapeHtml(durationStr)}</div>
              <div><span style="color:var(--text-muted);">Exit Code:</span> ${att.exit_code != null ? att.exit_code : '—'}</div>
              <div><span style="color:var(--text-muted);">Cost:</span> $${(att.cost_usd || 0).toFixed(3)}</div>
            `;

            card.append(cardHead, metaGrid);

            if (att.error_message) {
              const errBox = document.createElement('div');
              errBox.style.cssText = 'font-family:\'IBM Plex Mono\',monospace;font-size:11px;background:rgba(221,85,75,0.08);border:1px solid rgba(221,85,75,0.25);border-radius:6px;padding:8px 10px;color:var(--st-fail);white-space:pre-wrap;word-break:break-all;';
              errBox.textContent = `Error: ${att.error_message}`;
              card.appendChild(errBox);
            }

            list.appendChild(card);
          }
          body.appendChild(list);
        })
        .catch((err) => {
          if (reqId !== _activeAttemptsReq) return;
          placeholder.textContent = `Failed loading attempts: ${err.message || err}`;
        });
    }

    let _activeGoalsReq = 0;
    function ccRenderGoals(body, a) {
      const curReq = ++_activeGoalsReq;
      const room = activeRoom();
      const prjId = room ? room.id : (a ? a.projectId : null);
      if (!prjId) {
        body.innerHTML = '<div class="empty-note">No active project room selected.</div>';
        return;
      }

      body.innerHTML = '';
      const topBar = document.createElement('div');
      topBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border-soft);';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:15px;color:var(--text);display:flex;align-items:center;gap:8px;';
      title.innerHTML = '<span>🎯</span> Autonomous Agent Teams & Planning Engine';

      const newGoalBtn = document.createElement('button');
      newGoalBtn.className = 'btn-primary';
      newGoalBtn.style.cssText = 'padding:6px 14px;font-size:12px;cursor:pointer;';
      newGoalBtn.textContent = '+ New Goal';
      newGoalBtn.onclick = () => window.promptCreateGoal(prjId);
      topBar.append(title, newGoalBtn);
      body.appendChild(topBar);

      fetch(`/api/projects/${prjId}/goals`)
        .then((r) => r.json())
        .then((data) => {
          if (curReq !== _activeGoalsReq) return;
          const goals = data.goals || [];
          if (goals.length === 0) {
            body.innerHTML += `
              <div style="background:var(--surface-1);border:1px dashed var(--border-soft);border-radius:10px;padding:32px 20px;text-align:center;">
                <div style="font-size:28px;margin-bottom:10px;">🎯</div>
                <div style="font-size:14px;font-weight:600;margin-bottom:6px;">No Execution Goals Yet</div>
                <div style="font-size:12px;color:var(--text-faint);max-width:440px;margin:0 auto 16px;line-height:1.45;">
                  Define a high-level product engineering goal. The autonomous planning engine will formulate a structured multi-role execution plan across parallel waves.
                </div>
                <button class="btn-primary" style="padding:6px 16px;font-size:12px;" onclick="window.promptCreateGoal('${escapeHtml(prjId)}')">+ Create First Goal</button>
              </div>`;
            return;
          }

          const gList = document.createElement('div');
          gList.style.cssText = 'display:flex;flex-direction:column;gap:16px;';

          for (const g of goals) {
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--surface-1);border:1px solid var(--border-soft);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;';

            const head = document.createElement('div');
            head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;';
            const hLeft = document.createElement('div');
            hLeft.style.cssText = 'display:flex;align-items:center;gap:10px;';

            const stPill = document.createElement('span');
            stPill.style.cssText = 'font-size:10.5px;font-weight:800;letter-spacing:.4px;padding:3px 9px;border-radius:12px;text-transform:uppercase;';
            if (g.state === 'executing' || g.state === 'approved') stPill.style.cssText += 'background:rgba(34,197,94,0.15);color:var(--st-working);border:1px solid rgba(34,197,94,0.3);';
            else if (g.state === 'awaiting_approval' || g.state === 'planning') stPill.style.cssText += 'background:rgba(212,157,73,0.15);color:var(--st-blocked);border:1px solid rgba(212,157,73,0.3);';
            else if (g.state === 'replanning') stPill.style.cssText += 'background:rgba(249,115,22,0.15);color:#fb923c;border:1px solid rgba(249,115,22,0.3);';
            else if (g.state === 'completed') stPill.style.cssText += 'background:rgba(93,179,192,0.15);color:var(--accent);border:1px solid rgba(93,179,192,0.3);';
            else stPill.style.cssText += 'background:rgba(221,85,75,0.15);color:var(--st-fail);border:1px solid rgba(221,85,75,0.3);';
            stPill.textContent = g.state;

            const gTitle = document.createElement('span');
            gTitle.style.cssText = 'font-weight:700;font-size:15px;color:var(--text);';
            gTitle.textContent = g.title;
            hLeft.append(stPill, gTitle);

            const hRight = document.createElement('div');
            hRight.style.cssText = 'display:flex;gap:6px;';

            if (g.state === 'draft') {
              const genBtn = document.createElement('button');
              genBtn.className = 'btn-primary';
              genBtn.style.cssText = 'padding:4px 10px;font-size:11.5px;';
              genBtn.textContent = '⚡ Generate Plan';
              genBtn.onclick = () => {
                fetch(`/api/goals/${g.id}/generate-plan`, { method: 'POST' }).then(() => renderCommandCenter());
              };
              hRight.appendChild(genBtn);
            } else if (g.state === 'awaiting_approval') {
              const appBtn = document.createElement('button');
              appBtn.className = 'btn-primary';
              appBtn.style.cssText = 'padding:4px 10px;font-size:11.5px;';
              appBtn.textContent = '🚀 Approve & Execute';
              appBtn.onclick = () => {
                fetch(`/api/goals/${g.id}/plan/approve`, { method: 'POST' }).then(() => renderCommandCenter());
              };
              hRight.appendChild(appBtn);
            } else if (g.state === 'executing') {
              const replanBtn = document.createElement('button');
              replanBtn.className = 'cc-tab';
              replanBtn.style.cssText = 'padding:4px 10px;font-size:11px;color:var(--accent);';
              replanBtn.textContent = '🔄 Dynamic Replan';
              replanBtn.onclick = () => window.promptDynamicReplan(g.id);
              hRight.appendChild(replanBtn);
            }

            head.append(hLeft, hRight);
            card.appendChild(head);

            if (g.description) {
              const desc = document.createElement('div');
              desc.style.cssText = 'font-size:12.5px;color:var(--text-muted);';
              desc.textContent = g.description;
              card.appendChild(desc);
            }

            const planDetails = document.createElement('div');
            planDetails.id = `goal-plan-${g.id}`;
            card.appendChild(planDetails);

            // Fetch goal plan details
            fetch(`/api/goals/${g.id}`)
              .then((r) => r.json())
              .then((gData) => {
                const plan = gData.plan;
                if (!plan || !plan.steps || plan.steps.length === 0) return;

                planDetails.innerHTML = '';
                const pBox = document.createElement('div');
                pBox.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px dashed var(--border-soft);';

                const pHead = document.createElement('div');
                pHead.style.cssText = 'font-size:12px;font-weight:700;color:var(--text);';
                pHead.textContent = `📋 Plan Revision #${plan.revisionNumber}: ${plan.summary || ''}`;
                pBox.appendChild(pHead);

                // Group steps by execution waves
                const waves = new Map();
                for (const s of plan.steps) {
                  const w = s.wave || 1;
                  if (!waves.has(w)) waves.set(w, []);
                  waves.get(w).push(s);
                }

                const waveGrid = document.createElement('div');
                waveGrid.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

                const sortedWaves = Array.from(waves.keys()).sort((a, b) => a - b);
                for (const wNum of sortedWaves) {
                  const wSteps = waves.get(wNum);
                  const wRow = document.createElement('div');
                  wRow.style.cssText = 'background:var(--surface-2);border-radius:8px;padding:8px 10px;border:1px solid var(--border-soft);';

                  const wTitle = document.createElement('div');
                  wTitle.style.cssText = 'font-size:11px;font-weight:800;letter-spacing:.3px;color:var(--accent);margin-bottom:6px;';
                  wTitle.textContent = `🌊 WAVE ${wNum} (${wSteps.length} Parallel Steps)`;
                  wRow.appendChild(wTitle);

                  const sList = document.createElement('div');
                  sList.style.cssText = 'display:flex;flex-direction:column;gap:5px;';
                  for (const s of wSteps) {
                    const sCard = document.createElement('div');
                    sCard.style.cssText = 'display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,0.15);padding:5px 8px;border-radius:5px;font-size:11.5px;';
                    const left = document.createElement('div');
                    left.innerHTML = `<strong>#${s.stepNumber}</strong> ${escapeHtml(s.title)} <span style="font-size:9.5px;padding:1px 5px;border-radius:8px;background:rgba(93,179,192,0.2);color:var(--accent);margin-left:6px;">${s.suggestedRole}</span>`;
                    const right = document.createElement('div');
                    right.style.cssText = 'font-size:10.5px;color:var(--text-faint);';
                    right.textContent = s.dependencies && s.dependencies.length > 0 ? `Deps: ${s.dependencies.join(', ')}` : 'Ready';
                    sCard.append(left, right);
                    sList.appendChild(sCard);
                  }
                  wRow.appendChild(sList);
                  waveGrid.appendChild(wRow);
                }
                pBox.appendChild(waveGrid);
                planDetails.appendChild(pBox);
              })
              .catch(() => {});

            gList.appendChild(card);
          }
          body.appendChild(gList);
        })
        .catch((err) => {
          body.innerHTML = `<div class="empty-note">Failed to load goals: ${err.message || err}</div>`;
        });
    }

    window.promptCreateGoal = function (prjId) {
      const title = prompt('Enter Goal Title (e.g. "Add Google OAuth authentication"):');
      if (!title || !title.trim()) return;
      const description = prompt('Enter detailed goal description / requirements:') || '';

      fetch(`/api/projects/${prjId}/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim(), creatorId: 'human' }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok && data.goalId) {
            fetch(`/api/goals/${data.goalId}/generate-plan`, { method: 'POST' }).then(() => renderCommandCenter());
          } else {
            renderCommandCenter();
          }
        })
        .catch((err) => alert(`Failed creating goal: ${err.message || err}`));
    };

    window.promptDynamicReplan = function (goalId) {
      fetch(`/api/goals/${goalId}/impact`)
        .then((r) => r.json())
        .then((impact) => {
          if (!impact.ok || !impact.options || impact.options.length === 0) {
            alert('No active impact/failure detected requiring replanning.');
            return;
          }
          const opt = impact.options[0];
          const confirmReplan = confirm(`Impact detected: ${impact.blockedTasks.length} downstream tasks blocked.\n\nRecommended Option: "${opt.title}"\n${opt.description}\n\nApply this revised plan?`);
          if (confirmReplan) {
            fetch(`/api/goals/${goalId}/replan`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ optionId: opt.optionId }),
            }).then(() => renderCommandCenter());
          }
        })
        .catch((err) => alert(`Replanning error: ${err.message || err}`));
    };
    let _activeApprovalsReq = 0;
    function ccRenderApprovals(body, a) {
      const curReq = ++_activeApprovalsReq;
      const room = activeRoom();
      const prjId = room ? room.id : (a ? a.projectId : null);
      if (!prjId) {
        body.innerHTML = '<div class="empty-note">No active project room selected.</div>';
        return;
      }

      body.innerHTML = '';
      const topBar = document.createElement('div');
      topBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border-soft);';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:15px;color:var(--text);display:flex;align-items:center;gap:8px;';
      title.innerHTML = '<span>🛡️</span> Human Governance, Approvals & Audit';

      const reqApprBtn = document.createElement('button');
      reqApprBtn.className = 'btn-primary';
      reqApprBtn.style.cssText = 'padding:6px 14px;font-size:12px;cursor:pointer;';
      reqApprBtn.textContent = '+ New Approval Request';
      reqApprBtn.onclick = () => window.promptCreateApproval(prjId);
      topBar.append(title, reqApprBtn);
      body.appendChild(topBar);

      // Fetch approvals, escalations, and audit logs in parallel
      Promise.all([
        fetch(`/api/projects/${prjId}/approvals`).then((r) => r.json()),
        fetch(`/api/projects/${prjId}/escalations`).then((r) => r.json()),
        fetch(`/api/projects/${prjId}/audit?limit=25`).then((r) => r.json()),
        fetch(`/api/projects/${prjId}/members`).then((r) => r.json()),
      ])
        .then(([apprData, escData, audData, memData]) => {
          if (curReq !== _activeApprovalsReq) return;
          const approvals = apprData.approvals || [];
          const escalations = escData.escalations || [];
          const auditLogs = audData.logs || [];
          const members = memData.members || [];

          // 1. Pending Approvals Section
          const apprSection = document.createElement('div');
          apprSection.style.cssText = 'margin-bottom:20px;';
          apprSection.innerHTML = '<div style="font-size:13px;font-weight:800;letter-spacing:.3px;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span>📋</span> PENDING HUMAN APPROVALS</div>';

          if (approvals.length === 0) {
            apprSection.innerHTML += '<div style="background:var(--surface-1);border:1px dashed var(--border-soft);border-radius:8px;padding:16px;font-size:12px;color:var(--text-faint);text-align:center;">No pending approval requests. Autonomous agents are authorized to operate.</div>';
          } else {
            const aList = document.createElement('div');
            aList.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

            for (const app of approvals) {
              const aCard = document.createElement('div');
              aCard.style.cssText = 'background:var(--surface-1);border:1px solid var(--border-soft);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;';

              const head = document.createElement('div');
              head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;';

              const left = document.createElement('div');
              left.style.cssText = 'display:flex;align-items:center;gap:8px;';

              const riskBadge = document.createElement('span');
              riskBadge.style.cssText = 'font-size:10px;font-weight:800;letter-spacing:.4px;padding:2px 7px;border-radius:10px;text-transform:uppercase;';
              if (app.riskLevel === 'critical') riskBadge.style.cssText += 'background:rgba(221,85,75,0.2);color:var(--st-fail);border:1px solid rgba(221,85,75,0.4);';
              else if (app.riskLevel === 'high') riskBadge.style.cssText += 'background:rgba(249,115,22,0.2);color:#fb923c;border:1px solid rgba(249,115,22,0.4);';
              else if (app.riskLevel === 'medium') riskBadge.style.cssText += 'background:rgba(212,157,73,0.2);color:var(--st-blocked);border:1px solid rgba(212,157,73,0.4);';
              else riskBadge.style.cssText += 'background:rgba(34,197,94,0.2);color:var(--st-working);border:1px solid rgba(34,197,94,0.4);';
              riskBadge.textContent = app.riskLevel;

              const titleEl = document.createElement('strong');
              titleEl.style.cssText = 'font-size:13px;color:var(--text);';
              titleEl.textContent = app.title;
              left.append(riskBadge, titleEl);

              const right = document.createElement('div');
              right.style.cssText = 'display:flex;gap:6px;';

              if (app.state === 'pending') {
                const approveBtn = document.createElement('button');
                approveBtn.className = 'btn-primary';
                approveBtn.style.cssText = 'padding:3px 10px;font-size:11px;background:#22c55e;border-color:#16a34a;';
                approveBtn.textContent = '✅ Approve';
                approveBtn.onclick = () => {
                  const comment = prompt('Approval comment / authorization note (optional):');
                  fetch(`/api/approvals/${app.id}/approve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: 'human', comment }),
                  }).then(() => renderCommandCenter());
                };

                const rejectBtn = document.createElement('button');
                rejectBtn.className = 'cc-tab';
                rejectBtn.style.cssText = 'padding:3px 10px;font-size:11px;color:var(--red);border-color:rgba(221,85,75,0.3);';
                rejectBtn.textContent = '❌ Reject';
                rejectBtn.onclick = () => {
                  const comment = prompt('Rejection reason (required):');
                  if (!comment) return;
                  fetch(`/api/approvals/${app.id}/reject`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: 'human', comment }),
                  }).then(() => renderCommandCenter());
                };

                right.append(approveBtn, rejectBtn);
              } else {
                const stSpan = document.createElement('span');
                stSpan.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;';
                stSpan.textContent = `${app.state} by ${app.resolvedBy || 'human'}`;
                right.appendChild(stSpan);
              }

              head.append(left, right);
              aCard.appendChild(head);

              const reasonBox = document.createElement('div');
              reasonBox.style.cssText = 'font-size:12px;color:var(--text-muted);background:rgba(0,0,0,0.15);padding:6px 10px;border-radius:6px;';
              reasonBox.innerHTML = `<strong>Reason:</strong> ${escapeHtml(app.reason)}`;
              aCard.appendChild(reasonBox);

              aList.appendChild(aCard);
            }
            apprSection.appendChild(aList);
          }
          body.appendChild(apprSection);

          // 2. Active Escalations Section
          if (escalations.length > 0) {
            const escSection = document.createElement('div');
            escSection.style.cssText = 'margin-bottom:20px;';
            escSection.innerHTML = '<div style="font-size:13px;font-weight:800;letter-spacing:.3px;margin-bottom:10px;color:var(--st-fail);display:flex;align-items:center;gap:6px;"><span>🚨</span> ACTIVE SUPERVISOR ESCALATIONS</div>';

            const eList = document.createElement('div');
            eList.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
            for (const esc of escalations) {
              const eCard = document.createElement('div');
              eCard.style.cssText = 'background:rgba(221,85,75,0.06);border:1px solid rgba(221,85,75,0.3);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;';
              const eLeft = document.createElement('div');
              eLeft.innerHTML = `<div style="font-weight:700;font-size:12.5px;color:var(--st-fail);">${escapeHtml(esc.title)}</div><div style="font-size:11.5px;color:var(--text-muted);">${escapeHtml(esc.reason)}</div>`;
              const resBtn = document.createElement('button');
              resBtn.className = 'btn-primary';
              resBtn.style.cssText = 'padding:3px 8px;font-size:11px;';
              resBtn.textContent = 'Resolve';
              resBtn.onclick = () => {
                const notes = prompt('Resolution notes:');
                fetch(`/api/escalations/${esc.id}/resolve`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId: 'human', notes }),
                }).then(() => renderCommandCenter());
              };
              eCard.append(eLeft, resBtn);
              eList.appendChild(eCard);
            }
            escSection.appendChild(eList);
            body.appendChild(escSection);
          }

          // 3. Project Audit Trail Section
          const audSection = document.createElement('div');
          audSection.style.cssText = 'margin-bottom:20px;';
          audSection.innerHTML = '<div style="font-size:13px;font-weight:800;letter-spacing:.3px;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span>📜</span> IMMUTABLE AUDIT TRAIL</div>';

          const audBox = document.createElement('div');
          audBox.style.cssText = 'background:var(--surface-1);border:1px solid var(--border-soft);border-radius:8px;padding:10px 12px;max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;font-family:monospace;font-size:11px;';

          if (auditLogs.length === 0) {
            audBox.innerHTML = '<div style="color:var(--text-faint);">No audit entries recorded yet.</div>';
          } else {
            for (const log of auditLogs) {
              const row = document.createElement('div');
              row.style.cssText = 'display:flex;gap:8px;align-items:center;border-bottom:1px solid rgba(255,255,255,0.03);padding-bottom:4px;';
              const time = new Date(log.timestamp).toLocaleTimeString();
              row.innerHTML = `<span style="color:var(--text-faint);">${time}</span> <span style="color:var(--accent);font-weight:700;">[${log.actorType}:${escapeHtml(log.actorId)}]</span> <span style="color:var(--text);">${escapeHtml(log.action)}</span> <span style="color:var(--text-muted);">(${escapeHtml(log.resourceType)}:${escapeHtml(log.resourceId.slice(0, 10))})</span>`;
              audBox.appendChild(row);
            }
          }
          audSection.appendChild(audBox);
          body.appendChild(audSection);

          // 4. Project Team & Roles Section
          const memSection = document.createElement('div');
          memSection.innerHTML = '<div style="font-size:13px;font-weight:800;letter-spacing:.3px;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span>👥</span> TEAM ROLES & ACCESS CONTROL (RBAC)</div>';
          const memList = document.createElement('div');
          memList.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
          for (const m of members) {
            const mBadge = document.createElement('div');
            mBadge.style.cssText = 'background:var(--surface-2);border:1px solid var(--border-soft);border-radius:6px;padding:6px 10px;font-size:11.5px;display:flex;align-items:center;gap:6px;';
            mBadge.innerHTML = `<strong>${escapeHtml(m.name || m.ghLogin)}</strong> <span style="font-size:9.5px;padding:1px 6px;border-radius:8px;background:rgba(93,179,192,0.2);color:var(--accent);font-weight:700;text-transform:uppercase;">${m.role}</span>`;
            memList.appendChild(mBadge);
          }
          memSection.appendChild(memList);
          body.appendChild(memSection);
        })
        .catch((err) => {
          body.innerHTML = `<div class="empty-note">Failed to load governance: ${err.message || err}</div>`;
        });
    }

    window.promptCreateApproval = function (prjId) {
      const title = prompt('Enter Approval Title (e.g. "Authorize Production Deployment"):');
      if (!title || !title.trim()) return;
      const reason = prompt('Enter reason approval is required:') || 'Manual governance gate';
      const riskLevel = prompt('Risk level (low, medium, high, critical):', 'medium') || 'medium';

      fetch(`/api/projects/${prjId}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          reason: reason.trim(),
          riskLevel: riskLevel.trim().toLowerCase(),
          approvalType: 'policy_exception',
          requesterId: 'human',
          requesterType: 'user',
        }),
      })
        .then(() => renderCommandCenter())
        .catch((err) => alert(`Failed creating approval request: ${err.message || err}`));
    };
    let _activeOpsReq = 0;
    function ccRenderOps(body, a) {
      const curReq = ++_activeOpsReq;
      const room = activeRoom();
      const prjId = room ? room.id : (a ? a.projectId : null);
      if (!prjId) {
        body.innerHTML = '<div class="empty-note">No active project room selected.</div>';
        return;
      }

      body.innerHTML = '';
      const topBar = document.createElement('div');
      topBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border-soft);';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:15px;color:var(--text);display:flex;align-items:center;gap:8px;';
      title.innerHTML = '<span>📊</span> Production Telemetry, Health & Dead Letter Queue';

      const opsActions = document.createElement('div');
      opsActions.style.cssText = 'display:flex;gap:8px;';

      const cleanBtn = document.createElement('button');
      cleanBtn.className = 'btn-primary';
      cleanBtn.style.cssText = 'padding:5px 12px;font-size:11.5px;';
      cleanBtn.textContent = '🧹 Run Retention Cleanup';
      cleanBtn.onclick = () => {
        if (confirm('Run safe retention cleanup for stale resolved records older than 30 days?')) {
          fetch('/api/system/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ daysToKeep: 30 }),
          })
            .then((r) => r.json())
            .then((res) => alert(`Cleanup complete: purged ${res.purgedApprovalsCount} approvals, ${res.purgedEscalationsCount} escalations.`));
        }
      };

      opsActions.appendChild(cleanBtn);
      topBar.append(title, opsActions);
      body.appendChild(topBar);

      // Fetch health, metrics, and dead letters
      Promise.all([
        fetch('/health/ready').then((r) => r.json()),
        fetch('/api/system/metrics').then((r) => r.json()),
        fetch(`/api/projects/${prjId}/dead-letter`).then((r) => r.json()),
      ])
        .then(([health, metrics, dlData]) => {
          if (curReq !== _activeOpsReq) return;
          const deadLetters = dlData.deadLetters || [];

          // 1. Health & Status Summary Cards
          const statGrid = document.createElement('div');
          statGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;margin-bottom:20px;';

          statGrid.innerHTML = `
            <div style="background:var(--surface-1);border:1px solid var(--border-soft);border-radius:8px;padding:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--text-faint);margin-bottom:4px;text-transform:uppercase;">System Health</div>
              <div style="font-size:18px;font-weight:800;color:${health.status === 'healthy' ? 'var(--st-working)' : 'var(--st-fail)'};">${escapeHtml(health.status.toUpperCase())}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Uptime: ${health.uptimeSeconds}s · Latency: ${health.checks?.database?.latencyMs ?? 0}ms</div>
            </div>
            <div style="background:var(--surface-1);border:1px solid var(--border-soft);border-radius:8px;padding:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--text-faint);margin-bottom:4px;text-transform:uppercase;">Tasks Pipeline</div>
              <div style="font-size:18px;font-weight:800;color:var(--accent);">${metrics.tasks?.total ?? 0} Total</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${metrics.tasks?.working ?? 0} active · ${metrics.tasks?.completed ?? 0} completed · ${metrics.tasks?.failed ?? 0} failed</div>
            </div>
            <div style="background:var(--surface-1);border:1px solid var(--border-soft);border-radius:8px;padding:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--text-faint);margin-bottom:4px;text-transform:uppercase;">Memory & Resources</div>
              <div style="font-size:18px;font-weight:800;color:var(--text);">${metrics.memory?.rssMb ?? 0} MB</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Heap: ${metrics.memory?.heapUsedMb ?? 0} MB / ${metrics.memory?.heapTotalMb ?? 0} MB</div>
            </div>
            <div style="background:var(--surface-1);border:1px solid var(--border-soft);border-radius:8px;padding:12px;">
              <div style="font-size:11px;font-weight:700;color:var(--text-faint);margin-bottom:4px;text-transform:uppercase;">Dead Letter Queue</div>
              <div style="font-size:18px;font-weight:800;color:${deadLetters.length > 0 ? 'var(--st-fail)' : 'var(--st-working)'};">${deadLetters.length} Blocked</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${deadLetters.filter((d) => d.status === 'pending').length} pending human review</div>
            </div>
          `;
          body.appendChild(statGrid);

          // 2. Dead Letter Queue Table
          const dlSection = document.createElement('div');
          dlSection.innerHTML = '<div style="font-size:13px;font-weight:800;letter-spacing:.3px;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span>☠️</span> DEAD LETTER QUEUE (UNRECOVERABLE TASKS)</div>';

          if (deadLetters.length === 0) {
            dlSection.innerHTML += '<div style="background:var(--surface-1);border:1px dashed var(--border-soft);border-radius:8px;padding:16px;font-size:12px;color:var(--text-faint);text-align:center;">No tasks in the Dead Letter Queue. All execution is healthy or self-recovering.</div>';
          } else {
            const dlList = document.createElement('div');
            dlList.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

            for (const dl of deadLetters) {
              const card = document.createElement('div');
              card.style.cssText = 'background:var(--surface-1);border:1px solid var(--border-soft);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;';

              const head = document.createElement('div');
              head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;';

              const left = document.createElement('div');
              left.style.cssText = 'display:flex;align-items:center;gap:8px;';

              const catBadge = document.createElement('span');
              catBadge.style.cssText = 'font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px;background:rgba(221,85,75,0.2);color:var(--st-fail);border:1px solid rgba(221,85,75,0.4);text-transform:uppercase;';
              catBadge.textContent = dl.failureCategory;

              const taskTitle = document.createElement('strong');
              taskTitle.style.cssText = 'font-size:13px;color:var(--text);';
              taskTitle.textContent = `Task ${dl.taskId} (${dl.retryAttempts} retries)`;
              left.append(catBadge, taskTitle);

              const right = document.createElement('div');
              right.style.cssText = 'display:flex;gap:6px;';

              if (dl.status === 'pending') {
                const retryBtn = document.createElement('button');
                retryBtn.className = 'btn-primary';
                retryBtn.style.cssText = 'padding:3px 10px;font-size:11px;';
                retryBtn.textContent = '🔄 Retry';
                retryBtn.onclick = () => {
                  fetch(`/api/dead-letter/${dl.id}/reprocess`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'RETRY' }),
                  }).then(() => renderCommandCenter());
                };

                const dismissBtn = document.createElement('button');
                dismissBtn.className = 'cc-tab';
                dismissBtn.style.cssText = 'padding:3px 10px;font-size:11px;';
                dismissBtn.textContent = 'Dismiss';
                dismissBtn.onclick = () => {
                  fetch(`/api/dead-letter/${dl.id}/reprocess`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'DISMISS' }),
                  }).then(() => renderCommandCenter());
                };

                right.append(retryBtn, dismissBtn);
              } else {
                const st = document.createElement('span');
                st.style.cssText = 'font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;';
                st.textContent = dl.status;
                right.appendChild(st);
              }

              head.append(left, right);
              card.appendChild(head);

              if (dl.lastError) {
                const errBox = document.createElement('div');
                errBox.style.cssText = 'font-size:11.5px;color:var(--st-fail);background:rgba(221,85,75,0.06);border:1px solid rgba(221,85,75,0.2);padding:6px 10px;border-radius:6px;';
                errBox.textContent = `Error: ${dl.lastError}`;
                card.appendChild(errBox);
              }

              dlList.appendChild(card);
            }
            dlSection.appendChild(dlList);
          }
          body.appendChild(dlSection);
        })
        .catch((err) => {
          body.innerHTML = `<div class="empty-note">Failed to load system ops: ${err.message || err}</div>`;
        });
    }

    let _activeSeqReq = 0;
    window._seqTaskFilter = 'all';
    window._seqPlaybackIndex = null;
    window._seqIsPlaying = false;
    window._seqPlayTimer = null;

    function ccRenderSequenceFlow(body, a) {
      const curReq = ++_activeSeqReq;
      const room = activeRoom();
      const prjId = room ? room.id : (a ? a.projectId : null);
      if (!prjId) {
        body.innerHTML = '<div class="empty-note">No active project room selected.</div>';
        return;
      }

      body.innerHTML = '';
      const topBar = document.createElement('div');
      topBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--border-soft);flex-wrap:wrap;gap:8px;';

      const titleWrap = document.createElement('div');
      titleWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:14px;color:var(--text);display:flex;align-items:center;gap:6px;';
      title.innerHTML = '<span>⚡</span> Agent Communication & Sequence Flow Inspector';
      const liveBadge = document.createElement('span');
      liveBadge.style.cssText = 'font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px;background:rgba(34,197,94,0.15);color:var(--st-working);border:1px solid rgba(34,197,94,0.3);';
      liveBadge.textContent = '● LIVE STREAMING';
      titleWrap.append(title, liveBadge);

      const controlsWrap = document.createElement('div');
      controlsWrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

      // Task filter select
      const taskSelect = document.createElement('select');
      taskSelect.className = 'mailbox-composer-input';
      taskSelect.style.cssText = 'font-size:11px;padding:3px 8px;max-width:180px;';
      taskSelect.innerHTML = '<option value="all">🔍 All Tasks</option>';
      const tasks = room?.tasks || [];
      tasks.forEach((t) => {
        const sel = window._seqTaskFilter === t.id ? ' selected' : '';
        taskSelect.innerHTML += `<option value="${escapeHtml(t.id)}"${sel}>${escapeHtml(t.title.slice(0, 24))}</option>`;
      });
      taskSelect.onchange = (e) => {
        window._seqTaskFilter = e.target.value;
        renderCommandCenter();
      };

      controlsWrap.append(taskSelect);
      topBar.append(titleWrap, controlsWrap);
      body.appendChild(topBar);

      // Fetch sequence events
      fetch(`/api/projects/${prjId}/sequence-events?limit=150`)
        .then((r) => r.json())
        .then((res) => {
          if (curReq !== _activeSeqReq) return;
          let allEvents = res.events || [];
          if (window._seqTaskFilter !== 'all') {
            allEvents = allEvents.filter((ev) => ev.taskId === window._seqTaskFilter);
          }

          if (allEvents.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'background:var(--surface-1);border:1px dashed var(--border-soft);border-radius:8px;padding:30px;font-size:12px;color:var(--text-faint);text-align:center;';
            empty.innerHTML = 'No communication events recorded yet. Assign a task or trigger Contract-Net bidding to watch real-time sequence lifelines!';
            body.appendChild(empty);
            return;
          }

          // Lifeline participants
          const participants = [
            { id: 'commander', label: '👑 Commander', color: 'var(--st-blocked)' },
            { id: 'developer', label: '💻 Developer', color: 'var(--st-reviewing)' },
            { id: 'reviewer', label: '🔍 Reviewer', color: 'var(--st-done)' },
            { id: 'qa', label: '🧪 QA / Spec', color: '#ec4899' },
            { id: 'artifact_store', label: '📦 Artifact Store', color: 'var(--st-working)' },
            { id: 'system', label: '⚙️ System', color: 'var(--text-dim)' },
          ];

          function getParticipantCol(actor) {
            if (!actor) return 0;
            const id = (actor.id || '').toLowerCase();
            const lbl = (actor.label || '').toLowerCase();
            const type = (actor.type || '').toUpperCase();
            if (type === 'ARTIFACT_STORE' || id.includes('artifact') || lbl.includes('artifact')) return 4;
            if (type === 'SYSTEM' || id.includes('system') || lbl.includes('system') || id.includes('engine')) return 5;
            if (id.includes('commander') || lbl.includes('commander') || id.includes('god') || id.includes('orchestrator')) return 0;
            if (id.includes('rev') || lbl.includes('reviewer') || lbl.includes('review')) return 2;
            if (id.includes('qa') || lbl.includes('qa') || lbl.includes('tester')) return 3;
            return 1; // developer
          }

          // Sequence Diagram Canvas Container
          const diagContainer = document.createElement('div');
          diagContainer.style.cssText = 'background:var(--surface-1);border:1px solid var(--border-soft);border-radius:8px;padding:16px;margin-bottom:16px;overflow-x:auto;';

          // Participant Lifeline Headers
          const headerGrid = document.createElement('div');
          headerGrid.style.cssText = 'display:grid;grid-template-columns:repeat(6, 1fr);gap:8px;margin-bottom:14px;min-width:650px;';

          participants.forEach((p) => {
            const badge = document.createElement('div');
            badge.style.cssText = `text-align:center;font-size:11px;font-weight:700;padding:6px 4px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid ${p.color}40;color:${p.color};`;
            badge.textContent = p.label;
            headerGrid.appendChild(badge);
          });
          diagContainer.appendChild(headerGrid);

          // Render Sequence Event Rows (Arrows & Labels)
          const eventsList = document.createElement('div');
          eventsList.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:650px;position:relative;';

          const maxEvents = allEvents.length;
          const displayEvents = allEvents;

          displayEvents.forEach((ev, idx) => {
            const fromCol = getParticipantCol(ev.source);
            const toCol = getParticipantCol(ev.target);

            const row = document.createElement('div');
            row.style.cssText = 'display:grid;grid-template-columns:repeat(6, 1fr);gap:8px;align-items:center;padding:4px 0;cursor:pointer;border-radius:4px;transition:background .15s;';
            row.onmouseenter = () => row.style.background = 'rgba(255,255,255,0.03)';
            row.onmouseleave = () => row.style.background = 'transparent';

            // Determine arrow direction and color
            let arrowColor = 'var(--st-reviewing)';
            if (ev.type.includes('CFP')) arrowColor = 'var(--st-blocked)';
            else if (ev.type.includes('PROPOSAL_ACCEPTED')) arrowColor = '#22c55e';
            else if (ev.type.includes('PROPOSAL_DECLINED')) arrowColor = '#64748b';
            else if (ev.type.includes('PROPOSAL')) arrowColor = 'var(--st-done)';
            else if (ev.type.includes('HANDOFF')) arrowColor = 'var(--accent)';
            else if (ev.type.includes('REVIEW_RESULT')) arrowColor = ev.metadata?.status === 'ACCEPT' ? '#22c55e' : '#f43f5e';
            else if (ev.type.includes('REWORK')) arrowColor = '#f97316';
            else if (ev.type.includes('COMPLETED')) arrowColor = '#22c55e';
            else if (ev.type.includes('ARTIFACT')) arrowColor = 'var(--st-working)';

            const start = Math.min(fromCol, toCol) + 1;
            const span = Math.abs(toCol - fromCol) || 1;
            const isLeftToRight = fromCol <= toCol;

            // Timeline slots
            for (let c = 0; c < 6; c++) {
              if (c === Math.min(fromCol, toCol)) {
                const msgBox = document.createElement('div');
                msgBox.style.cssText = `grid-column: span ${span};display:flex;align-items:center;gap:6px;background:${arrowColor}12;border:1px solid ${arrowColor}40;border-radius:6px;padding:5px 8px;`;

                const typePill = document.createElement('span');
                typePill.style.cssText = `font-size:9.5px;font-weight:800;color:${arrowColor};text-transform:uppercase;white-space:nowrap;`;
                typePill.textContent = ev.type.replace(/_/g, ' ');

                const arrowIcon = document.createElement('span');
                arrowIcon.style.cssText = `color:${arrowColor};font-size:11px;font-weight:bold;`;
                arrowIcon.textContent = isLeftToRight ? '──►' : '◄──';

                const summaryTxt = document.createElement('span');
                summaryTxt.style.cssText = 'font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
                summaryTxt.textContent = ev.summary;

                msgBox.append(typePill, arrowIcon, summaryTxt);
                row.appendChild(msgBox);
                c += span - 1;
              } else {
                const emptySlot = document.createElement('div');
                emptySlot.style.cssText = 'display:flex;justify-content:center;';
                emptySlot.innerHTML = '<div style="width:1px;height:24px;background:var(--border-soft);opacity:0.6;"></div>';
                row.appendChild(emptySlot);
              }
            }

            // Click row to show event details drawer
            row.onclick = () => showEventDetailsModal(ev);
            eventsList.appendChild(row);
          });

          diagContainer.appendChild(eventsList);
          body.appendChild(diagContainer);

          // Details Modal Helper
          function showEventDetailsModal(ev) {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
            overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };

            const modal = document.createElement('div');
            modal.style.cssText = 'background:var(--surface-0);border:1px solid var(--border-soft);border-radius:10px;width:100%;max-width:550px;padding:20px;box-shadow:0 20px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:12px;';

            const mHead = document.createElement('div');
            mHead.style.cssText = 'display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-soft);padding-bottom:10px;';
            mHead.innerHTML = `
              <div style="font-weight:800;font-size:14px;color:var(--accent);display:flex;align-items:center;gap:6px;">
                <span>⚡</span> ${escapeHtml(ev.type)}
              </div>
              <button class="btn-icon" style="font-size:14px;cursor:pointer;">✕</button>
            `;
            mHead.querySelector('button').onclick = () => document.body.removeChild(overlay);
            modal.appendChild(mHead);

            const mBody = document.createElement('div');
            mBody.style.cssText = 'display:flex;flex-direction:column;gap:8px;font-size:12px;';
            mBody.innerHTML = `
              <div><strong>Summary:</strong> <span style="color:var(--text);">${escapeHtml(ev.summary)}</span></div>
              <div><strong>Timestamp:</strong> <span style="color:var(--text-muted);">${escapeHtml(ev.timestamp)}</span></div>
              <div><strong>Source:</strong> <span style="color:var(--st-reviewing);">${escapeHtml(ev.source.label)} (${escapeHtml(ev.source.type)})</span></div>
              ${ev.target ? `<div><strong>Target:</strong> <span style="color:var(--st-done);">${escapeHtml(ev.target.label)} (${escapeHtml(ev.target.type)})</span></div>` : ''}
              ${ev.taskId ? `<div><strong>Task ID:</strong> <code>${escapeHtml(ev.taskId)}</code></div>` : ''}
              ${ev.correlationId ? `<div><strong>Correlation ID:</strong> <code>${escapeHtml(ev.correlationId)}</code></div>` : ''}
            `;

            if (ev.metadata) {
              const metaWrap = document.createElement('div');
              metaWrap.style.cssText = 'margin-top:6px;background:var(--surface-1);border:1px solid var(--border-soft);border-radius:6px;padding:10px;';
              metaWrap.innerHTML = `<strong>Structured Context / Metadata:</strong><pre style="margin:6px 0 0 0;font-size:11px;overflow-x:auto;color:var(--text-muted);">${escapeHtml(JSON.stringify(ev.metadata, null, 2))}</pre>`;
              mBody.appendChild(metaWrap);
            }

            modal.appendChild(mBody);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
          }
        })
        .catch((err) => {
          body.innerHTML = `<div class="empty-note">Failed to load sequence flow: ${err.message || err}</div>`;
        });
    }
    function ccRenderArtifacts(body, a) {
      body.innerHTML = '';
      const reqId = ++_activeArtifactsReq;

      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';

      const titleWrap = document.createElement('div');
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:13px;';
      title.textContent = 'Generated Artifacts & Outputs';
      const note = document.createElement('div');
      note.className = 'cmd-note';
      note.style.margin = '2px 0 0 0';
      note.textContent = a.task?.title ? `Task: ${a.task.title}` : 'Artifacts produced in this project';
      titleWrap.append(title, note);

      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'code-btn';
      refreshBtn.textContent = '🔄 Refresh Artifacts';
      refreshBtn.onclick = () => ccRenderArtifacts(body, a);

      topRow.append(titleWrap, refreshBtn);
      body.appendChild(topRow);

      const placeholder = document.createElement('div');
      placeholder.className = 'empty-note';
      placeholder.textContent = 'Loading artifacts…';
      body.appendChild(placeholder);

      const taskId = a.task?.id || a.current_task;
      const fetchPromise = taskId
        ? fetch(`/api/tasks/${taskId}/artifacts`).then(r => r.json())
        : (activeProjectId
            ? fetch(`/api/projects/${activeProjectId}/artifacts`).then(r => r.json())
            : Promise.resolve({ ok: true, artifacts: [] }));

      fetchPromise
        .then((data) => {
          if (reqId !== _activeArtifactsReq) return;
          if (!data || !data.ok) {
            placeholder.textContent = `Could not load artifacts (${data?.error || 'Unknown error'}).`;
            return;
          }
          const artifacts = data.artifacts ?? [];
          if (!artifacts.length) {
            placeholder.textContent = 'No artifacts attached to this task or project yet.';
            return;
          }
          placeholder.remove();

          const list = document.createElement('div');
          list.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

          for (const art of artifacts) {
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;';

            const head = document.createElement('div');
            head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;';

            const left = document.createElement('div');
            left.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

            const kindBadge = document.createElement('span');
            kindBadge.className = 'inspector-badge';
            const k = (art.kind || 'output').toLowerCase();
            if (k === 'diff') {
              kindBadge.textContent = '📄 DIFF';
              kindBadge.style.cssText = 'background:rgba(93,179,192,0.15);color:var(--accent);border:1px solid rgba(93,179,192,0.3);';
            } else if (k === 'test_report') {
              kindBadge.textContent = '🧪 TEST REPORT';
              kindBadge.style.cssText = 'background:rgba(34,197,94,0.15);color:var(--st-working);border:1px solid rgba(34,197,94,0.3);';
            } else if (k === 'review') {
              kindBadge.textContent = '🔍 REVIEW';
              kindBadge.style.cssText = 'background:rgba(162,141,211,0.15);color:var(--st-done);border:1px solid rgba(162,141,211,0.3);';
            } else {
              kindBadge.textContent = `📋 ${k.toUpperCase()}`;
              kindBadge.style.cssText = 'background:rgba(148,163,184,0.15);color:var(--text-dim);border:1px solid rgba(148,163,184,0.3);';
            }

            const artTitle = document.createElement('span');
            artTitle.style.cssText = 'font-weight:700;font-size:13.5px;color:var(--text);';
            artTitle.textContent = art.title;

            left.append(kindBadge, artTitle);

            const timeSpan = document.createElement('span');
            timeSpan.style.cssText = 'font-size:11px;color:var(--text-faint);';
            timeSpan.textContent = art.created_at ? relativeTime(art.created_at) : '';

            head.append(left, timeSpan);
            card.appendChild(head);

            if (art.summary) {
              const sumBox = document.createElement('div');
              sumBox.style.cssText = 'font-size:12.5px;color:var(--text-muted);line-height:1.45;background:var(--surface-2);padding:9px 12px;border-radius:7px;border:1px solid var(--border-soft);';
              sumBox.textContent = art.summary;
              card.appendChild(sumBox);
            }

            if (art.file_path) {
              const fileBox = document.createElement('div');
              fileBox.style.cssText = 'display:flex;align-items:center;gap:6px;font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--accent);background:rgba(93,179,192,0.06);border:1px solid rgba(93,179,192,0.2);border-radius:6px;padding:6px 10px;';
              fileBox.innerHTML = `<span>📁</span> <span style="word-break:break-all;">${escapeHtml(art.file_path)}</span>`;
              card.appendChild(fileBox);
            }

            list.appendChild(card);
          }
          body.appendChild(list);
        })
        .catch((err) => {
          if (reqId !== _activeArtifactsReq) return;
          placeholder.textContent = `Failed loading artifacts: ${err.message || err}`;
        });
    }

    let _activeWfReq = 0;
    function ccRenderWorkflows(body, a) {
      const curReq = ++_activeWfReq;
      const room = activeRoom();
      const prjId = room ? room.id : (a ? a.projectId : null);
      if (!prjId) {
        body.innerHTML = '<div class="empty-note">No active project room selected.</div>';
        return;
      }

      body.innerHTML = '';
      const topBar = document.createElement('div');
      topBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border-soft);';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:700;font-size:15px;color:var(--text);display:flex;align-items:center;gap:8px;';
      title.innerHTML = '<span>⚡</span> Multi-Agent Workflows & DAG Engine';

      const newWfBtn = document.createElement('button');
      newWfBtn.className = 'btn-primary';
      newWfBtn.style.cssText = 'padding:6px 14px;font-size:12px;cursor:pointer;';
      newWfBtn.textContent = '+ New Workflow';
      newWfBtn.onclick = () => promptCreateWorkflow(prjId);
      topBar.append(title, newWfBtn);
      body.appendChild(topBar);

      const placeholder = document.createElement('div');
      placeholder.className = 'empty-note';
      placeholder.textContent = 'Loading workflows\u2026';
      body.appendChild(placeholder);

      fetch(`/api/projects/${encodeURIComponent(prjId)}/workflows`)
        .then((r) => r.json())
        .then((data) => {
          if (curReq !== _activeWfReq) return;
          const workflows = data.workflows || [];
          placeholder.remove();

          if (workflows.length === 0) {
            body.innerHTML += `
              <div class="empty-note" style="padding:32px 0;">
                <div style="font-size:32px;margin-bottom:10px;">🕸️</div>
                <div style="font-weight:600;font-size:14px;color:var(--text);margin-bottom:4px;">No active workflows in this project</div>
                <div style="font-size:12px;color:var(--text-faint);max-width:360px;margin:0 auto 16px;">
                  Create a structured multi-agent workflow with task dependencies, automated handoffs, and review gates.
                </div>
                <button class="btn-primary" style="padding:6px 16px;font-size:12px;" onclick="window.promptCreateWorkflow('${escapeHtml(prjId)}')">+ Create First Workflow</button>
              </div>`;
            return;
          }

          const wfList = document.createElement('div');
          wfList.style.cssText = 'display:flex;flex-direction:column;gap:16px;';

          for (const wf of workflows) {
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--surface-1);border:1px solid var(--border-soft);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:12px;';

            const head = document.createElement('div');
            head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;';
            const hLeft = document.createElement('div');
            hLeft.style.cssText = 'display:flex;align-items:center;gap:10px;';

            const stPill = document.createElement('span');
            stPill.style.cssText = 'font-size:10.5px;font-weight:800;letter-spacing:.4px;padding:3px 9px;border-radius:12px;text-transform:uppercase;';
            if (wf.state === 'active') stPill.style.cssText += 'background:rgba(34,197,94,0.15);color:var(--st-working);border:1px solid rgba(34,197,94,0.3);';
            else if (wf.state === 'paused') stPill.style.cssText += 'background:rgba(212,157,73,0.15);color:var(--st-blocked);border:1px solid rgba(212,157,73,0.3);';
            else if (wf.state === 'completed') stPill.style.cssText += 'background:rgba(93,179,192,0.15);color:var(--accent);border:1px solid rgba(93,179,192,0.3);';
            else stPill.style.cssText += 'background:rgba(221,85,75,0.15);color:var(--st-fail);border:1px solid rgba(221,85,75,0.3);';
            stPill.textContent = wf.state;

            const healthPill = document.createElement('span');
            healthPill.id = `wf-health-${wf.id}`;
            healthPill.style.cssText = 'font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:var(--surface-2);color:var(--text-faint);';
            healthPill.textContent = '🏥 Checking health\u2026';

            const wfTitle = document.createElement('span');
            wfTitle.style.cssText = 'font-weight:700;font-size:15px;color:var(--text);';
            wfTitle.textContent = wf.title;

            hLeft.append(stPill, healthPill, wfTitle);

            const hRight = document.createElement('div');
            hRight.style.cssText = 'display:flex;gap:6px;';

            if (wf.state === 'active') {
              const pauseBtn = document.createElement('button');
              pauseBtn.className = 'btn-ghost';
              pauseBtn.style.cssText = 'padding:4px 8px;font-size:11px;';
              pauseBtn.textContent = '⏸ Pause';
              pauseBtn.onclick = () => {
                fetch(`/api/workflows/${wf.id}/pause`, { method: 'POST' }).then(() => renderCommandCenter());
              };
              hRight.appendChild(pauseBtn);
            } else if (wf.state === 'paused') {
              const resumeBtn = document.createElement('button');
              resumeBtn.className = 'btn-ghost';
              resumeBtn.style.cssText = 'padding:4px 8px;font-size:11px;';
              resumeBtn.textContent = '▶ Resume';
              resumeBtn.onclick = () => {
                fetch(`/api/workflows/${wf.id}/resume`, { method: 'POST' }).then(() => renderCommandCenter());
              };
              hRight.appendChild(resumeBtn);
            }

            if (wf.state === 'active' || wf.state === 'paused') {
              const cancelBtn = document.createElement('button');
              cancelBtn.className = 'btn-ghost';
              cancelBtn.style.cssText = 'padding:4px 8px;font-size:11px;color:var(--red);';
              cancelBtn.textContent = '✕ Cancel';
              cancelBtn.onclick = () => {
                if (confirm('Cancel this workflow and all pending steps?')) {
                  fetch(`/api/workflows/${wf.id}/cancel`, { method: 'POST' }).then(() => renderCommandCenter());
                }
              };
              hRight.appendChild(cancelBtn);
            }

            const addTaskBtn = document.createElement('button');
            addTaskBtn.className = 'btn-primary';
            addTaskBtn.style.cssText = 'padding:4px 10px;font-size:11px;';
            addTaskBtn.textContent = '+ Add Step';
            addTaskBtn.onclick = () => promptAddTaskToWorkflow(wf.id);
            hRight.appendChild(addTaskBtn);

            head.append(hLeft, hRight);
            card.appendChild(head);

            if (wf.description) {
              const desc = document.createElement('div');
              desc.style.cssText = 'font-size:12.5px;color:var(--text-muted);';
              desc.textContent = wf.description;
              card.appendChild(desc);
            }

            // Supervisor banner container
            const supervisorBanner = document.createElement('div');
            supervisorBanner.id = `wf-supervisor-${wf.id}`;
            supervisorBanner.style.display = 'none';
            card.appendChild(supervisorBanner);

            // Fetch supervisor health and diagnostics
            fetch(`/api/workflows/${wf.id}/health`)
              .then((r) => r.json())
              .then((rep) => {
                const hp = document.getElementById(`wf-health-${wf.id}`);
                if (hp) {
                  hp.textContent = `🏥 ${rep.health}`;
                  if (rep.health === 'HEALTHY' || rep.health === 'COMPLETED') hp.style.color = 'var(--st-working)';
                  else if (rep.health === 'DEGRADED') hp.style.color = 'var(--st-blocked)';
                  else hp.style.color = 'var(--st-fail)';
                }
                if (rep.recommendations && rep.recommendations.length > 0) {
                  supervisorBanner.style.display = 'flex';
                  supervisorBanner.style.cssText = 'background:rgba(93,179,192,0.08);border:1px solid rgba(93,179,192,0.25);border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;font-size:11.5px;';
                  const rec = rep.recommendations[0];
                  const recText = document.createElement('div');
                  recText.innerHTML = `<strong>Supervisor Diagnostic:</strong> ${escapeHtml(rec.reason)}`;
                  const recBtn = document.createElement('button');
                  recBtn.className = 'btn-primary';
                  recBtn.style.cssText = 'padding:3px 8px;font-size:11px;';
                  recBtn.textContent = `⚡ Apply: ${rec.action}`;
                  recBtn.onclick = () => {
                    fetch(`/api/workflows/${wf.id}/supervisor-action`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(rec),
                    }).then(() => renderCommandCenter());
                  };
                  supervisorBanner.append(recText, recBtn);
                }
              })
              .catch(() => {});

            // Load DAG graph for this workflow
            const dagContainer = document.createElement('div');
            dagContainer.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding-top:6px;border-top:1px dashed var(--border-soft);';
            dagContainer.innerHTML = '<div style="color:var(--text-faint);font-size:11px;">Loading steps\u2026</div>';
            card.appendChild(dagContainer);

            fetch(`/api/workflows/${wf.id}`)
              .then((r) => r.json())
              .then((graph) => {
                const tasks = graph.tasks || [];
                dagContainer.innerHTML = '';
                if (tasks.length === 0) {
                  dagContainer.innerHTML = '<div style="color:var(--text-faint);font-size:11.5px;padding:4px 0;">No tasks attached to this workflow yet. Click "+ Add Step" to create one.</div>';
                  return;
                }

                for (let i = 0; i < tasks.length; i++) {
                  const t = tasks[i];
                  const stepRow = document.createElement('div');
                  stepRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;background:var(--surface-2);padding:8px 12px;border-radius:7px;border:1px solid var(--border-soft);font-size:12px;gap:10px;';

                  const left = document.createElement('div');
                  left.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;overflow:hidden;';

                  const stepNum = document.createElement('span');
                  stepNum.style.cssText = 'font-weight:700;color:var(--text-faint);font-size:11px;';
                  stepNum.textContent = `#${i + 1}`;

                  const stBadge = document.createElement('span');
                  stBadge.style.cssText = 'font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;';
                  if (t.state === 'completed') {
                    stBadge.textContent = '✓ Done';
                    stBadge.style.cssText += 'background:rgba(34,197,94,0.15);color:var(--st-working);';
                  } else if (t.state === 'working') {
                    stBadge.textContent = '● Working';
                    stBadge.style.cssText += 'background:rgba(59,130,246,0.15);color:#60a5fa;';
                  } else if (t.derivedStatus === 'waiting') {
                    stBadge.textContent = '○ Waiting';
                    stBadge.style.cssText += 'background:rgba(212,157,73,0.15);color:var(--st-blocked);';
                  } else if (t.derivedStatus === 'blocked') {
                    stBadge.textContent = '⊘ Blocked';
                    stBadge.style.cssText += 'background:rgba(221,85,75,0.15);color:var(--st-fail);';
                  } else {
                    stBadge.textContent = '● Ready';
                    stBadge.style.cssText += 'background:rgba(148,163,184,0.15);color:var(--text-dim);';
                  }

                  const titleText = document.createElement('span');
                  titleText.style.cssText = 'font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                  titleText.textContent = t.title;

                  const agentBadge = document.createElement('span');
                  agentBadge.style.cssText = 'font-size:10.5px;color:var(--text-faint);background:var(--surface-1);padding:2px 6px;border-radius:4px;border:1px solid var(--border-soft);';
                  agentBadge.textContent = t.agent_name ? `🤖 ${t.agent_name}` : 'Unassigned';

                  left.append(stepNum, stBadge, titleText, agentBadge);

                  const right = document.createElement('div');
                  right.style.cssText = 'display:flex;gap:4px;align-items:center;';

                  if (t.dependencyStatus && t.dependencyStatus.totalDependencies > 0) {
                    const depBadge = document.createElement('span');
                    depBadge.style.cssText = 'font-size:10px;color:var(--text-faint);';
                    depBadge.textContent = `deps: ${t.dependencyStatus.completedCount}/${t.dependencyStatus.totalDependencies}`;
                    right.appendChild(depBadge);
                  }

                  const handoffBtn = document.createElement('button');
                  handoffBtn.className = 'btn-ghost';
                  handoffBtn.style.cssText = 'padding:2px 6px;font-size:10.5px;';
                  handoffBtn.textContent = '🤝 Handoff';
                  handoffBtn.onclick = () => promptHandoff(t.id, t.title);
                  right.appendChild(handoffBtn);

                  const reviewBtn = document.createElement('button');
                  reviewBtn.className = 'btn-ghost';
                  reviewBtn.style.cssText = 'padding:2px 6px;font-size:10.5px;';
                  reviewBtn.textContent = '🔍 Review';
                  reviewBtn.onclick = () => promptReview(t.id, t.title);
                  right.appendChild(reviewBtn);

                  stepRow.append(left, right);
                  dagContainer.appendChild(stepRow);
                }
              });

            wfList.appendChild(card);
          }
          body.appendChild(wfList);
        })
        .catch((err) => {
          if (curReq !== _activeWfReq) return;
          placeholder.textContent = `Failed loading workflows: ${err.message || err}`;
        });
    }

    window.promptCreateWorkflow = function (projectId) {
      const title = prompt('Enter Workflow Title (e.g. "OAuth 2.0 Integration"):');
      if (!title || !title.trim()) return;
      const description = prompt('Enter Workflow Description / Goal:') || '';
      fetch(`/api/projects/${encodeURIComponent(projectId)}/workflows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.ok) renderCommandCenter();
          else alert(`Error: ${res.error}`);
        })
        .catch((err) => alert(`Failed creating workflow: ${err.message}`));
    };

    window.promptAddTaskToWorkflow = function (workflowId) {
      const title = prompt('Enter Step Title (e.g. "Design DB Schema"):');
      if (!title || !title.trim()) return;
      const spec = prompt('Enter Task Spec / Requirements:') || '';
      fetch(`/api/workflows/${encodeURIComponent(workflowId)}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), spec: spec.trim() }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.ok) renderCommandCenter();
          else alert(`Error: ${res.error}`);
        })
        .catch((err) => alert(`Failed adding task: ${err.message}`));
    };

    window.promptHandoff = function (taskId, title) {
      const room = activeRoom();
      const agents = room ? room.agents || [] : [];
      if (agents.length === 0) {
        alert('No agents found in this project to hand off to.');
        return;
      }
      const agentNames = agents.map((a, i) => `${i + 1}. ${a.name} (${a.role})`).join('\n');
      const choice = prompt(`Select recipient agent for "${title}":\n\n${agentNames}\n\nEnter number (1-${agents.length}):`);
      const idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= agents.length) return;
      const toAgent = agents[idx];
      const meAgent = ccAgent();
      const fromAgentId = meAgent ? meAgent.id : (agents.find(a => a.id !== toAgent.id)?.id || toAgent.id);

      const summary = prompt(`Enter handoff instructions / context for ${toAgent.name}:`, 'Please proceed with this task.') || '';
      if (!summary.trim()) return;

      fetch(`/api/tasks/${encodeURIComponent(taskId)}/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromAgentId,
          toAgentId: toAgent.id,
          summary: summary.trim(),
        }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.ok) {
            alert(`Task successfully handed off to ${toAgent.name}!`);
            renderCommandCenter();
          } else {
            alert(`Handoff failed: ${res.error}`);
          }
        })
        .catch((err) => alert(`Handoff error: ${err.message}`));
    };

    window.promptReview = function (taskId, title) {
      const meAgent = ccAgent();
      const reviewerId = meAgent ? meAgent.id : 'reviewer';
      const verdictChoice = prompt(`Submit Code Review for "${title}":\n\nEnter 1 for "Approved"\nEnter 2 for "Changes Requested"`);
      if (verdictChoice !== '1' && verdictChoice !== '2') return;
      const verdict = verdictChoice === '1' ? 'approved' : 'changes_requested';
      const summary = prompt(verdict === 'approved' ? 'Enter approval comments:' : 'Enter requested changes:');
      if (!summary || !summary.trim()) return;

      fetch(`/api/tasks/${encodeURIComponent(taskId)}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewerId,
          verdict,
          summary: summary.trim(),
        }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.ok) {
            alert(`Review submitted (${verdict})!${res.reworkTaskId ? ` Spawned follow-up rework task #${res.reworkTaskId}` : ''}`);
            renderCommandCenter();
          } else {
            alert(`Review failed: ${res.error}`);
          }
        })
        .catch((err) => alert(`Review error: ${err.message}`));
    };

    function ccRenderSteer(body, a) {
      body.innerHTML = '';
      const isWorking = !!(a.task && a.task.title);

      const statusBox = document.createElement('div');
      statusBox.style.cssText = `
        padding:12px 16px;border-radius:10px;margin-bottom:14px;
        background:${isWorking ? 'rgba(93,179,192,0.1)' : 'rgba(255,255,255,0.03)'};
        border:1px solid ${isWorking ? 'rgba(93,179,192,0.3)' : 'var(--border)'};
        display:flex;align-items:center;gap:12px;
      `;
      statusBox.innerHTML = `
        <div style="font-size:24px;">${isWorking ? '🟢' : '⚪'}</div>
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--text);">
            ${isWorking ? `Live Task In Progress: "${escapeHtml(a.task.title)}"` : `Agent is Idle`}
          </div>
          <div style="font-size:11.5px;color:var(--text-dim);margin-top:2px;">
            ${isWorking ? 'Steering messages will be injected directly into the active run loop.' : 'Steering messages will be saved into agent memory and prepended to the next task.'}
          </div>
        </div>
      `;
      body.appendChild(statusBox);

      const note = document.createElement('div');
      note.className = 'cmd-note';
      note.textContent = 'Inject guidance, architectural constraints, or corrections. You can steer without stopping the agent.';
      body.appendChild(note);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;margin-top:12px';
      const inp = document.createElement('input');
      inp.placeholder = 'e.g. prefer pnpm, use Tailwind instead of raw CSS, check error boundaries';
      inp.style.cssText = 'flex:1;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;background:var(--surface-2);color:var(--text)';
      inp.id = 'cc-steer-input';
      if (window._ccSteerDraft?.agentId === a.id) inp.value = window._ccSteerDraft.text;
      inp.oninput = () => { window._ccSteerDraft = { agentId: a.id, text: inp.value }; };
      inp.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };

      const btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.textContent = isWorking ? '🧭 Inject Live Guidance' : '🧭 Steer Next Task';
      btn.style.cssText = 'padding:10px 18px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-weight:700;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;';
      const err = document.createElement('div');
      err.style.cssText = 'font-size:12px;margin-top:10px;display:none;padding:8px 12px;border-radius:6px;';

      btn.onclick = async () => {
        const text = inp.value.trim();
        if (!text) {
          err.textContent = 'Please enter a line of guidance.';
          err.style.display = 'block';
          err.style.background = 'rgba(221,85,75,0.1)';
          err.style.color = 'var(--red)';
          return;
        }
        err.style.display = 'none';
        btn.disabled = true;
        btn.textContent = 'Injecting…';
        try {
          const res = await fetch(`/api/agents/${a.id}/steer`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            const msg = data.error || `Steer failed (${res.status})`;
            err.textContent = msg;
            err.style.display = 'block';
            err.style.background = 'rgba(221,85,75,0.1)';
            err.style.color = 'var(--red)';
          } else {
            inp.value = '';
            window._ccSteerDraft = null;
            const modeText = data.mode === 'live' ? 'Injected directly into live running task!' : 'Saved for next task.';
            err.textContent = `✓ Guidance steered successfully: "${text}" (${modeText})`;
            err.style.display = 'block';
            err.style.background = 'rgba(116,175,125,0.12)';
            err.style.border = '1px solid rgba(116,175,125,0.3)';
            err.style.color = 'var(--green)';
            setTimeout(() => { err.style.display = 'none'; }, 4000);
          }
        } catch (e) {
          err.textContent = e.message || 'Could not reach server';
          err.style.display = 'block';
          err.style.background = 'rgba(221,85,75,0.1)';
          err.style.color = 'var(--red)';
        } finally {
          btn.disabled = false;
          btn.textContent = isWorking ? '🧭 Inject Live Guidance' : '🧭 Steer Next Task';
        }
      };

      row.append(inp, btn);
      body.append(row, err);
    }

    /** One card, icon header, rows inside. Shared by Traces, Git and Memory. */
    function ccPanel(body, iconPath, title, sub, tag) {
      const panel = document.createElement('div');
      panel.className = 'cc-panel';
      const head = document.createElement('div');
      head.className = 'cc-panel-head';
      const ic = document.createElement('div');
      ic.className = 'mon-icon';
      ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' + iconPath + '</svg>';
      const tw = document.createElement('div');
      const t = document.createElement('div'); t.className = 'cc-panel-title'; t.textContent = title;
      const s = document.createElement('div'); s.className = 'cc-panel-sub';   s.textContent = sub;
      tw.append(t, s);
      head.append(ic, tw);
      if (tag) {
        const g = document.createElement('span');
        g.className = 'cc-panel-tag';
        g.textContent = tag;
        head.appendChild(g);
      }
      panel.appendChild(head);
      body.appendChild(panel);
      return panel;
    }

    function ccRenderTraces(body, a) {
      body.innerHTML = '';
      const panel = ccPanel(body,
        '<path d="M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 1 5-5l2-2-2-2-2 2z"/>',
        'Traces', `${a.name}'s tool calls & step boundaries`);

      const placeholder = document.createElement('div');
      placeholder.className = 'empty-note';
      placeholder.textContent = 'Loading execution traces…';
      panel.appendChild(placeholder);

      fetch(`/api/agents/${a.id}/traces?limit=60`).then(async (res) => {
        if (!res.ok) {
          placeholder.textContent = `Could not load traces (${res.status}).`;
          return;
        }
        const data = await res.json().catch(() => ({}));
        const traces = data.traces ?? data.events ?? [];
        if (!traces.length) {
          placeholder.textContent = 'No execution traces recorded yet. Traces will appear in real time as the agent executes work.';
          return;
        }
        placeholder.remove();

        traces.forEach((ev, i) => {
          const k = (ev.kind || ev.type || '').toLowerCase();

          // A checkpoint is a boundary the agent declared, not a call it made —
          // it gets a rule across the panel rather than a row of its own.
          if (k.includes('checkpoint')) {
            const cp = document.createElement('div');
            cp.className = 'cc-checkpoint';
            cp.innerHTML =
              '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8">' +
              '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/></svg>' +
              '<span>— ' + esc(String(ev.summary || ev.text || 'CHECKPOINT').toUpperCase()) + ' —</span>';
            panel.appendChild(cp);
            return;
          }

          const row = document.createElement('div');
          row.className = 'cc-row';

          const icon = document.createElement('div');
          icon.className = 'cc-commit-dot';
          const isThought = k.includes('thought') || k.includes('reason');
          icon.innerHTML = isThought
            ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9.5 3A3.5 3.5 0 0 0 6 6.5v.6A3 3 0 0 0 6 13v3a3 3 0 0 0 6 0V6.5A3.5 3.5 0 0 0 9.5 3z"/><path d="M14.5 3A3.5 3.5 0 0 1 18 6.5v.6a3 3 0 0 1 0 5.9v3a3 3 0 0 1-6 0"/></svg>'
            : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 1 5-5l2-2-2-2-2 2z"/></svg>';
          icon.style.color = isThought ? 'var(--st-done)' : 'var(--text-faint)';

          const main = document.createElement('div');
          main.className = 'cc-row-main';

          const meta = document.createElement('div');
          meta.className = 'cc-row-meta';
          const idx = document.createElement('span');
          idx.className = 'cc-row-idx';
          idx.textContent = '#' + (ev.seq ?? i + 1);
          meta.appendChild(idx);
          // Only tool calls carry a tool name; a thought is not a tool.
          if (!isThought && (ev.tool || ev.kind || ev.type)) {
            const kind = document.createElement('span');
            kind.className = 'cc-kind';
            kind.textContent = ev.tool || ev.kind || ev.type;
            meta.appendChild(kind);
          }
          if (ev.ok !== undefined || ev.error !== undefined) {
            const st = document.createElement('span');
            const bad = ev.ok === false || !!ev.error;
            st.className = bad ? 'cc-bad' : 'cc-ok';
            st.innerHTML = bad
              ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>'
              : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>';
            meta.appendChild(st);
          }
          main.appendChild(meta);

          const sum = document.createElement('div');
          sum.className = 'cc-row-mono';
          if (ev.ok === false || ev.error) sum.style.color = 'var(--st-fail)';
          sum.textContent = ev.summary || ev.text || 'Action executed';
          main.appendChild(sum);

          const right = document.createElement('div');
          right.className = 'cc-row-right';
          const when = ev.ts ? relativeTime(ev.ts) : '';
          const dur = Number.isFinite(ev.durationMs) ? `${ev.durationMs}ms`
                    : Number.isFinite(ev.ms) ? `${ev.ms}ms` : '';
          right.innerHTML = esc(when) + (dur ? '<br>' + esc(dur) : '');

          row.append(icon, main, right);
          panel.appendChild(row);
        });
      }).catch((e) => {
        placeholder.textContent = 'Could not reach server for traces: ' + e.message;
      });
    }

    // A 2x2 card grid: context, budget, tool calls, engine. Every figure has
    // a real denominator the runner reports — none of these bars is a
    // progress bar, and none of them may be reused as one.
    function monCard(iconPath, title, sub) {
      const card = document.createElement('div');
      card.className = 'mon-card';
      const head = document.createElement('div');
      head.className = 'mon-head';
      const ic = document.createElement('div');
      ic.className = 'mon-icon';
      ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">' + iconPath + '</svg>';
      const tw = document.createElement('div');
      const t = document.createElement('div'); t.className = 'mon-title'; t.textContent = title;
      const s = document.createElement('div'); s.className = 'mon-sub';   s.textContent = sub;
      tw.append(t, s);
      head.append(ic, tw);
      card.appendChild(head);
      return card;
    }

    function ccRenderMonitor(body, a) {
      body.innerHTML = '';
      const room = activeRoom();
      const machine = room?.machines?.find((m) => m.id === a.machineId);
      const isOffline = !machine?.online;

      const grid = document.createElement('div');
      grid.className = 'mon-grid';
      body.appendChild(grid);

      // ---- 1. Context window ----
      const ctxCard = monCard(
        '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
        'Context window', 'Tokens used vs limit');
      const ctxVal = a.contextUsed ?? a.context?.used;
      const ctxLimit = a.contextLimit ?? a.context?.limit;
      if (isOffline) {
        ctxCard.insertAdjacentHTML('beforeend', '<div class="empty-note" style="padding:8px 0">Unknown — machine offline</div>');
      } else if (Number.isFinite(ctxVal) && Number.isFinite(ctxLimit) && ctxLimit > 0) {
        const pct = Math.min(100, Math.round((ctxVal / ctxLimit) * 100));
        const k = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
        ctxCard.insertAdjacentHTML('beforeend',
          `<div class="mon-figure"><span class="mon-big">${k(ctxVal)}</span><span class="mon-of">/ ${k(ctxLimit)}</span></div>` +
          `<div class="mon-bar"><i style="width:${pct}%"></i></div>` +
          `<div class="mon-foot">${pct}% full</div>`);
      } else {
        ctxCard.insertAdjacentHTML('beforeend', '<div class="empty-note" style="padding:8px 0">No context data yet — shows as work runs</div>');
      }
      grid.appendChild(ctxCard);

      // ---- 2. Budget spend ----
      const spendCard = monCard(
        '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
        'Budget spend', 'This session');
      const spent = a.task?.costUsd ?? a.costUsd;
      const cap = a.budgetUsd ?? a.task?.budgetUsd;
      if (Number.isFinite(spent)) {
        const hasCap = Number.isFinite(cap) && cap > 0;
        const pct = hasCap ? Math.min(100, Math.round((spent / cap) * 100)) : 0;
        spendCard.insertAdjacentHTML('beforeend',
          `<div class="mon-figure"><span class="mon-big">$${spent.toFixed(2)}</span>` +
          (hasCap ? `<span class="mon-of">/ $${cap.toFixed(2)} cap</span>` : '') + `</div>` +
          (hasCap
            ? `<div class="mon-bar is-spend"><i style="width:${pct}%"></i></div><div class="mon-foot">${pct}% of cap</div>`
            : `<div class="mon-foot">no cap set</div>`));
      } else {
        spendCard.insertAdjacentHTML('beforeend', '<div class="empty-note" style="padding:8px 0">Nothing spent yet this session</div>');
      }
      grid.appendChild(spendCard);

      // ---- 3. Tool calls ----
      const toolCalls = a.toolCalls ?? (a.task?.steps ?? null);
      const breakdown = a.toolBreakdown || a.tools || null;
      const toolCard = monCard(
        '<path d="M14.7 6.3a4 4 0 0 1-5 5L4 17v3h3l5.7-5.7a4 4 0 0 1 5-5l2-2-2-2-2 2z"/>',
        'Tool calls', isOffline ? 'Unknown — machine offline' : `${toolCalls ?? 0} total`);
      if (!isOffline && breakdown && Object.keys(breakdown).length) {
        const entries = Object.entries(breakdown).sort((x, y) => y[1] - x[1]).slice(0, 6);
        const max = entries[0][1] || 1;
        for (const [name, n] of entries) {
          const r = document.createElement('div');
          r.className = 'mon-tool';
          r.innerHTML =
            `<span class="mon-tool-name">${esc(name)}</span>` +
            `<span class="mon-tool-bar"><i style="width:${Math.round((n / max) * 100)}%"></i></span>` +
            `<span class="mon-tool-n">${n}</span>`;
          toolCard.appendChild(r);
        }
      } else if (!isOffline) {
        // The count is real; the per-tool split is only there once the
        // provider reports it. Saying so beats drawing an empty chart.
        toolCard.insertAdjacentHTML('beforeend',
          `<div class="mon-figure"><span class="mon-big">${toolCalls ?? 0}</span></div>` +
          `<div class="mon-foot">no per-tool breakdown reported</div>`);
      }
      grid.appendChild(toolCard);

      // ---- 4. Engine + live dispatch ----
      const engCard = monCard(
        '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>', 'Engine', 'Model & live dispatch');
      grid.appendChild(engCard);

      const dInp = document.createElement('input');
      dInp.placeholder = 'dispatch a one-off instruction…';
      const dBtn = document.createElement('button');
      dBtn.title = 'Dispatch';
      dBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
      const dErr = document.createElement('div');
      dErr.style.cssText = 'font-size:11px;color:var(--red);margin-top:8px;display:none';
      dBtn.onclick = async () => {
        const text = dInp.value.trim();
        if (!text) { dErr.textContent = 'Enter what to dispatch.'; dErr.style.display = 'block'; return; }
        dErr.style.display = 'none';
        dBtn.disabled = true;
        dBtn.textContent = 'Dispatching…';
        try {
          const res = await fetch('/debug/submit-task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: a.project_id ?? activeRoom()?.id, title: text, spec: text, requiredCapability: null }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error) {
            dErr.textContent = data.error || `dispatch failed (${res.status})`;
            dErr.style.display = 'block';
          } else {
            dInp.value = '';
            dErr.textContent = data.queued ? 'Queued — orchestrator will route it.' : `Dispatched to ${data.assignedTo ?? 'agent'}.`;
            dErr.style.display = 'block';
            dErr.style.color = 'var(--green)';
            setTimeout(() => { dErr.style.display = 'none'; dErr.style.color = 'var(--red)'; }, 2500);
          }
        } catch (e) {
          dErr.textContent = e.message || 'could not reach server';
          dErr.style.display = 'block';
        } finally {
          dBtn.disabled = false;
          dBtn.textContent = 'Dispatch';
        }
      };
      // Engine picker — warns about restart
      const eRow = document.createElement('div');
      eRow.className = 'mon-field';
      const eSel = document.createElement('select');
      eSel.className = 'mon-select';
      // Fill from room machines' providers — degrade to unknown when offline
      const providers = isOffline ? [] : (room?.machines?.find((m) => m.id === a.machineId)?.providers ?? []);
      if (!providers.length) {
        const o = document.createElement('option');
        o.textContent = isOffline ? 'Unknown — machine offline' : 'No providers reported';
        o.disabled = true;
        o.selected = true;
        eSel.appendChild(o);
        eSel.disabled = true;
      } else {
        for (const p of providers) {
          const o = document.createElement('option');
          o.value = p.id;
          o.textContent = p.label + (p.id === a.provider ? ' (current)' : '');
          if (p.id === a.provider) o.selected = true;
          eSel.appendChild(o);
        }
      }
      const eBtn = document.createElement('button');
      eBtn.className = 'cc-hbtn';
      eBtn.textContent = 'Change';
      eBtn.title = 'Changing provider or model restarts this agent’s harness — it will briefly go offline.';
      const eErr = document.createElement('div');
      eErr.style.cssText = 'font-size:11px;color:var(--red);margin-top:8px;display:none';
      eBtn.onclick = async () => {
        if (eSel.disabled) return;
        const provider = eSel.value;
        if (!provider) return;
        if (!confirm(`Change ${a.name}'s engine to ${provider}? This restarts its harness and it will briefly go offline.`)) return;
        eErr.style.display = 'none';
        eBtn.disabled = true;
        eBtn.textContent = 'Restarting…';
        try {
          const res = await fetch(`/api/agents/${a.id}/engine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            eErr.textContent = data.error || `engine change failed (${res.status})`;
            eErr.style.display = 'block';
            if (res.status === 404) eErr.textContent = 'Engine change not available yet — server has no engine endpoint.';
          } else {
            eErr.textContent = 'Restarting — engine will change on next heartbeat.';
            eErr.style.display = 'block';
            eErr.style.color = 'var(--green)';
            setTimeout(() => { eErr.style.display = 'none'; eErr.style.color = 'var(--red)'; }, 2500);
          }
        } catch (e) {
          eErr.textContent = e.message || 'could not reach server';
          eErr.style.display = 'block';
        } finally {
          eBtn.disabled = false;
          eBtn.textContent = 'Change engine';
        }
      };
      eRow.append(eSel, eBtn);

      // Everything the Engine card holds: the picker, then the live dispatch
      // box, which creates work through the same task path as Assign.
      const dLabel = document.createElement('div');
      dLabel.className = 'mon-dispatch-label';
      dLabel.textContent = 'LIVE DISPATCH';
      const dRow = document.createElement('div');
      dRow.className = 'mon-dispatch';
      dRow.append(dInp, dBtn);
      engCard.append(eRow, eErr, dLabel, dRow, dErr);
    }

    const GIT_ICON = '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="17" cy="9" r="2.5"/><path d="M6 8.5v7M17 11.5c0 3-3 4-6 4.5"/>';

    function ccRenderGit(body, a) {
      body.innerHTML = '';
      const room = activeRoom();
      const machine = room?.machines?.find((m) => m.id === a.machineId);
      const isOffline = !machine?.online;

      if (isOffline) {
        const p = ccPanel(body, GIT_ICON, 'Git', 'Machine offline');
        p.insertAdjacentHTML('beforeend',
          '<div class="empty-note">Unknown — machine offline. The agent is unreachable, so git state is not shown.</div>');
        return;
      }
      if (a.isolation === 'shared') {
        const p = ccPanel(body, GIT_ICON, 'Git', 'Shared checkout');
        p.insertAdjacentHTML('beforeend',
          '<div class="empty-note">Shared-isolation — this agent has no branch of its own; it works directly in the folder.</div>');
        return;
      }

      const panel = ccPanel(body, GIT_ICON, 'Git', 'Recent commits on this branch');
      const ph = document.createElement('div');
      ph.className = 'empty-note';
      ph.textContent = 'Loading git…';
      panel.appendChild(ph);
      fetch(`/api/agents/${a.id}/git`).then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) ph.textContent = 'Git not available yet — server has no git endpoint.';
          else ph.textContent = `Could not load git (${res.status}).`;
          return;
        }
        const data = await res.json().catch(() => ({}));
        // Expected shape: {branch, clean, ahead, behind, changedFiles:[], commits:[]}
        // Degrade if any field missing
        if (!data.branch && !data.commits) {
          ph.textContent = 'No git data — not a git repo or no commits yet.';
          return;
        }
        ph.remove();

        // Branch state as one summary row, then the commits as the list —
        // the reference leads with commits because that is the actual output.
        const sub = panel.querySelector('.cc-panel-sub');
        if (sub && data.branch) {
          const dirty = data.clean === false ? ' · dirty' : data.clean === true ? ' · clean' : '';
          const track = (Number.isFinite(data.ahead) || Number.isFinite(data.behind))
            ? ` · ↑${data.ahead ?? 0} ↓${data.behind ?? 0}` : '';
          sub.textContent = data.branch + dirty + track;
        }

        if (Array.isArray(data.changedFiles) && data.changedFiles.length) {
          const cf = document.createElement('div');
          cf.className = 'cc-row';
          cf.innerHTML =
            '<div class="cc-row-main"><div class="cc-row-meta"><span class="cc-kind">changed</span></div>' +
            data.changedFiles.map((f) => `<div class="cc-row-mono">${esc(String(f))}</div>`).join('') +
            '</div>';
          panel.appendChild(cf);
        }

        if (Array.isArray(data.commits) && data.commits.length) {
          for (const c of data.commits.slice(0, 8)) {
            const row = document.createElement('div');
            row.className = 'cc-row';
            const dot = document.createElement('div');
            dot.className = 'cc-commit-dot';
            dot.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v6.5M12 15.5V22"/></svg>';
            const main = document.createElement('div');
            main.className = 'cc-row-main';
            const msg = document.createElement('div');
            msg.style.cssText = 'font-size:13px;color:var(--text);';
            msg.textContent = c.message ?? '';
            const sha = document.createElement('div');
            sha.className = 'cc-row-idx';
            sha.style.marginTop = '3px';
            sha.textContent = (c.sha ?? '').slice(0, 8);
            main.append(msg, sha);
            const right = document.createElement('div');
            right.className = 'cc-row-right';
            right.textContent = c.at ? relativeTime(c.at) : '';
            row.append(dot, main, right);
            panel.appendChild(row);
          }
        } else {
          panel.insertAdjacentHTML('beforeend', '<div class="empty-note">No commits on this branch yet.</div>');
        }
      }).catch(() => { ph.textContent = 'Could not reach server for git.'; });
    }

    function getProviderTerminalConfig(a) {
      const p = (a?.provider || '').toLowerCase();
      if (p === 'claude' || p === 'claude-code' || (!p && !a?.role?.includes('opencode'))) {
        return {
          title: 'Claude Code',
          version: 'v2.1.241',
          modelText: (a?.model || 'Opus 4.8') + ' (' + (a?.contextLimit ? Math.round(a.contextLimit/1000) + 'k' : '1M') + ' context) with xhigh effort · Claude Max',
          badge: '• xhigh · /effort',
          accent: '#d97757',
          svg: `<svg viewBox="0 0 16 14" width="36" height="30" style="image-rendering:pixelated;flex:none;" fill="#d97757">
            <rect x="2" y="0" width="2" height="2"/>
            <rect x="12" y="0" width="2" height="2"/>
            <rect x="1" y="2" width="14" height="8"/>
            <rect x="3" y="4" width="2" height="2" fill="#faf8ee"/>
            <rect x="11" y="4" width="2" height="2" fill="#faf8ee"/>
            <rect x="1" y="10" width="2" height="3"/>
            <rect x="5" y="10" width="2" height="2"/>
            <rect x="9" y="10" width="2" height="2"/>
            <rect x="13" y="10" width="2" height="3"/>
          </svg>`
        };
      }
      if (p === 'opencode') {
        return {
          title: 'OpenCode',
          version: 'v1.0.8',
          modelText: (a?.model || 'Qwen 2.5 Coder 32B') + ' · Local Ollama/vLLM Harness',
          badge: '• fast · /opencode',
          accent: 'var(--st-working)',
          svg: `<svg viewBox="0 0 16 14" width="36" height="30" style="image-rendering:pixelated;flex:none;" fill="var(--st-working)">
            <rect x="1" y="1" width="14" height="12" rx="2" fill="#047857"/>
            <rect x="3" y="3" width="10" height="8" fill="#faf8ee"/>
            <rect x="4" y="4" width="2" height="6" fill="var(--st-working)"/>
            <rect x="6" y="6" width="3" height="2" fill="var(--st-working)"/>
            <rect x="9" y="8" width="3" height="2" fill="var(--st-working)"/>
          </svg>`
        };
      }
      if (p === 'gemini' || p === 'antigravity') {
        return {
          title: p === 'antigravity' ? 'Antigravity · Gemini' : 'Google Gemini CLI',
          version: 'v1.12.0',
          modelText: (a?.model || 'Gemini 2.5 Pro (2M context)') + ' · Thinking Budget 32k',
          badge: '• flash · /gemini',
          accent: '#3b82f6',
          svg: `<svg viewBox="0 0 16 16" width="34" height="32" style="image-rendering:pixelated;flex:none;" fill="#3b82f6">
            <rect x="7" y="1" width="2" height="14"/>
            <rect x="1" y="7" width="14" height="2"/>
            <rect x="5" y="4" width="6" height="8"/>
            <rect x="4" y="5" width="8" height="6"/>
            <rect x="6" y="3" width="4" height="10"/>
            <rect x="3" y="6" width="10" height="4"/>
            <circle cx="8" cy="8" r="2" fill="#faf8ee"/>
          </svg>`
        };
      }
      if (p === 'codex') {
        return {
          title: 'Codex · GPT',
          version: 'v0.9.4',
          modelText: (a?.model || 'GPT-4o (128k context)') + ' · OpenAI Native CLI',
          badge: '• exec · /codex',
          accent: '#10a37f',
          svg: `<svg viewBox="0 0 16 16" width="34" height="32" style="image-rendering:pixelated;flex:none;" fill="#10a37f">
            <rect x="4" y="2" width="8" height="2"/>
            <rect x="2" y="4" width="2" height="8"/>
            <rect x="12" y="4" width="2" height="8"/>
            <rect x="4" y="12" width="8" height="2"/>
            <rect x="5" y="5" width="6" height="6"/>
            <circle cx="8" cy="8" r="1.5" fill="#faf8ee"/>
          </svg>`
        };
      }
      const col = a?.color || '#5b5ef0';
      return {
        title: (a?.provider || a?.name || 'Agent') + ' CLI',
        version: 'v1.0.0',
        modelText: (a?.model || 'Autonomous Coding Agent') + ' · Standard Harness',
        badge: '• active · /cli',
        accent: col,
        svg: `<svg viewBox="0 0 16 14" width="36" height="30" style="image-rendering:pixelated;flex:none;" fill="${col}">
          <rect x="7" y="0" width="2" height="2"/>
          <rect x="2" y="2" width="12" height="9" rx="1"/>
          <rect x="4" y="4" width="2" height="3" fill="#faf8ee"/>
          <rect x="10" y="4" width="2" height="3" fill="#faf8ee"/>
          <rect x="5" y="8" width="6" height="1" fill="#faf8ee"/>
          <rect x="4" y="11" width="2" height="3"/>
          <rect x="10" y="11" width="2" height="3"/>
        </svg>`
      };
    }

    const XTERM_STUDIO_DARK_THEME = {
      background: '#090a0d',
      foreground: '#f4f4f6',
      cursor: '#f4f4f6',
      cursorAccent: '#090a0d',
      selectionBackground: 'rgba(255, 255, 255, 0.18)',
      selectionForeground: '#ffffff',
      black:        '#181a1f',
      red:          '#f43f5e',
      green:        'var(--st-working)',
      yellow:       'var(--st-blocked)',
      blue:         'var(--st-reviewing)',
      magenta:      'var(--st-done)',
      cyan:         '#2dd4bf',
      white:        '#f4f4f6',
      brightBlack:  '#52525b',
      brightRed:    '#fb7185',
      brightGreen:  'var(--st-working)',
      brightYellow: 'var(--st-blocked)',
      brightBlue:   '#60a5fa',
      brightMagenta:'#d8b4fe',
      brightCyan:   '#5eead4',
      brightWhite:  '#ffffff'
    };

    if (!window._terminalPool) window._terminalPool = new Map();

    function getOrCreateTerminalEntry(ptyId, a) {
      let entry = window._terminalPool.get(ptyId);
      if (entry) return entry;

      const host = document.createElement('div');
      host.className = 'xterm-host';
      host.style.cssText = 'width:100%;height:100%;min-height:280px;';

      let term = null;
      let fit = null;
      if (typeof Terminal !== 'undefined') {
        term = new Terminal({
          theme: XTERM_STUDIO_DARK_THEME,
          fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, monospace',
          fontSize: window._ccTermFontSize || 12,
          lineHeight: 1.15,
          cursorBlink: true,
          cursorStyle: 'block',
          scrollback: 50000,
        });

        if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
          fit = new FitAddon.FitAddon();
          term.loadAddon(fit);
        }
      }

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws = null;

      entry = { ptyId, host, term, fit, ws: null, opened: false };
      window._terminalPool.set(ptyId, entry);

      const connectWs = () => {
        try {
          // /pty-ws spawns a shell — it must carry the token or the server refuses
          // anything that is not loopback.
          ws = new WebSocket(`${proto}//${location.host}/pty-ws?token=${encodeURIComponent(localStorage.getItem('logbridge_auth_token') || '')}`);
          entry.ws = ws;
          ws.onopen = () => {
            ws.send(JSON.stringify({
              type: 'spawn',
              ptyId,
              agentId: a?.id || '',
              cols: (term && term.cols) ? term.cols : 100,
              rows: (term && term.rows) ? term.rows : 30
            }));
          };
          ws.onmessage = (ev) => {
            try {
              const m = JSON.parse(ev.data);
              if (m.type === 'data' && m.ptyId === ptyId && term) {
                term.write(m.data);
              }
            } catch {}
          };
          ws.onclose = () => {
            setTimeout(() => {
              if (host.isConnected && (!entry.ws || entry.ws.readyState === WebSocket.CLOSED)) {
                connectWs();
              }
            }, 3000);
          };
        } catch (e) {
          console.warn('PTY WebSocket connection error:', e);
        }
      };

      connectWs();

      if (term) {
        term.onData((data) => {
          if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(JSON.stringify({ type: 'data', ptyId, data }));
          }
        });
      }

      return entry;
    }

    function ccRenderCode(body, a) {
      body.innerHTML = '';
      if (!window._ccCodeFileMap) window._ccCodeFileMap = new Map();
      if (!window._ccCodeViewMode) window._ccCodeViewMode = 'split';

      const ptyName = 'pty-' + (a.name || 'agent').toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + (a.id || '000').slice(-8);

      const cwd = a.folder || a.cwd || '~/workspace';
      let activeFile = window._ccCodeFileMap.get(a.id) || null;

      const container = document.createElement('div');
      container.className = 'code-container';

      // Top bar
      const topbar = document.createElement('div');
      topbar.className = 'code-topbar';

      const topLeft = document.createElement('div');
      topLeft.className = 'code-topbar-left';
      topLeft.innerHTML = `<span class="code-cwd-tag">📁 ${esc(cwd)}</span> <span style="color:#858072;">·</span> <span id="code-active-title" style="font-weight:700;color:#1A1320;">${activeFile ? esc(activeFile) : 'Select a file'}</span>`;

      const topRight = document.createElement('div');
      topRight.className = 'code-topbar-right';

      const btnCodeOnly = document.createElement('button');
      btnCodeOnly.className = 'code-btn' + (window._ccCodeViewMode === 'code' ? ' active' : '');
      btnCodeOnly.textContent = '💻 Code';
      btnCodeOnly.title = 'Show code only';

      const btnSplit = document.createElement('button');
      btnSplit.className = 'code-btn' + (window._ccCodeViewMode === 'split' ? ' active' : '');
      btnSplit.textContent = '◫ Split';
      btnSplit.title = 'Show code and terminal together';

      const btnTermOnly = document.createElement('button');
      btnTermOnly.className = 'code-btn' + (window._ccCodeViewMode === 'terminal' ? ' active' : '');
      btnTermOnly.textContent = '>_ Terminal';
      btnTermOnly.title = 'Switch to terminal tab';

      btnCodeOnly.onclick = () => { window._ccCodeViewMode = 'code'; ccRenderCode(body, a); };
      btnSplit.onclick = () => { window._ccCodeViewMode = 'split'; ccRenderCode(body, a); };
      btnTermOnly.onclick = () => { ccTab = 'terminal'; renderCommandCenter(); };

      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'code-btn';
      refreshBtn.textContent = '↻';
      refreshBtn.title = 'Refresh files';

      const newFileBtn = document.createElement('button');
      newFileBtn.className = 'code-btn';
      newFileBtn.textContent = '+ File';
      newFileBtn.title = 'Create a new file in workspace';

      const saveBtn = document.createElement('button');
      saveBtn.className = 'code-btn';
      saveBtn.style.cssText = 'background:#16a34a;color:#fff;border-color:var(--st-working);font-weight:700;';
      saveBtn.textContent = 'Save';

      topRight.append(btnCodeOnly, btnSplit, btnTermOnly, refreshBtn, newFileBtn, saveBtn);
      topbar.append(topLeft, topRight);
      container.appendChild(topbar);

      // Main Code Split: File tree + Editor
      const mainSplit = document.createElement('div');
      mainSplit.className = 'code-main-split';

      // Left: File tree
      const treePane = document.createElement('div');
      treePane.className = 'code-tree-pane';
      treePane.innerHTML = `<div class="code-tree-head"><span>Workspace Files</span></div>`;
      const treeList = document.createElement('div');
      treeList.className = 'code-tree-list';
      treePane.appendChild(treeList);
      mainSplit.appendChild(treePane);

      // Right: Editor
      const editorPane = document.createElement('div');
      editorPane.className = 'code-editor-pane';

      const editorBar = document.createElement('div');
      editorBar.className = 'code-editor-bar';
      editorBar.innerHTML = `<span id="code-file-meta">No file open</span><span id="code-save-status">Saved</span>`;

      const editorArea = document.createElement('div');
      editorArea.className = 'code-editor-area';

      const gutter = document.createElement('div');
      gutter.className = 'code-gutter';
      gutter.textContent = '1';

      const textarea = document.createElement('textarea');
      textarea.className = 'code-input-area';
      textarea.placeholder = '// Select or create a file to view or edit code';
      textarea.spellcheck = false;

      editorArea.append(gutter, textarea);
      editorPane.append(editorBar, editorArea);
      mainSplit.appendChild(editorPane);

      container.appendChild(mainSplit);

      // Bottom Terminal (if in split mode)
      if (window._ccCodeViewMode === 'split') {
        const splitTermWrap = document.createElement('div');
        splitTermWrap.className = 'code-split-bottom-term';
        const splitTermHead = document.createElement('div');
        splitTermHead.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:#0f1116;border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text);';
        splitTermHead.innerHTML = `<span>>_ Live Terminal · ${esc(a.name)}</span><span style="font-weight:400;color:var(--text-dim);">Shell: zsh · Agent PTY</span>`;
        splitTermWrap.appendChild(splitTermHead);

        const termHostWrap = document.createElement('div');
        termHostWrap.style.cssText = 'flex:1;min-height:220px;background:#090a0d;padding:4px 8px;overflow:hidden;';

        const entry = getOrCreateTerminalEntry(ptyName, a);
        termHostWrap.appendChild(entry.host);
        splitTermWrap.appendChild(termHostWrap);
        container.appendChild(splitTermWrap);

        if (entry.term && !entry.opened) {
          entry.term.open(entry.host);
          entry.opened = true;
        }
        requestAnimationFrame(() => {
          try {
            if (entry.fit) entry.fit.fit();
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN && entry.term) {
              entry.ws.send(JSON.stringify({ type: 'resize', ptyId: ptyName, cols: entry.term.cols, rows: entry.term.rows }));
            }
          } catch {}
        });
      }

      body.appendChild(container);

      const updateLineNumbers = () => {
        const lines = (textarea.value || '').split('\n').length;
        let s = '';
        for (let i = 1; i <= Math.max(lines, 1); i++) s += i + '\n';
        gutter.textContent = s;
        const metaEl = document.getElementById('code-file-meta');
        if (metaEl) metaEl.textContent = `${lines} lines · ${(textarea.value || '').length} chars`;
      };

      textarea.addEventListener('input', () => {
        updateLineNumbers();
        const statEl = document.getElementById('code-save-status');
        if (statEl) {
          statEl.textContent = '● Unsaved changes';
          statEl.style.color = '#d97706';
        }
      });

      textarea.addEventListener('scroll', () => {
        gutter.scrollTop = textarea.scrollTop;
      });

      const saveCurrentFile = async () => {
        if (!activeFile) return;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          const r = await fetch(`/api/agents/${a.id}/file`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: activeFile, content: textarea.value })
          });
          const d = await r.json();
          const statEl = document.getElementById('code-save-status');
          if (d.ok) {
            if (statEl) {
              statEl.textContent = '✓ Saved';
              statEl.style.color = '#16a34a';
            }
          } else {
            alert('Failed to save: ' + (d.error || 'unknown error'));
          }
        } catch (e) {
          alert('Failed to save: ' + e.message);
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        }
      };

      saveBtn.onclick = saveCurrentFile;

      textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          saveCurrentFile();
        }
      });

      const openFile = async (rel) => {
        activeFile = rel;
        window._ccCodeFileMap.set(a.id, rel);
        const titleEl = document.getElementById('code-active-title');
        if (titleEl) titleEl.textContent = rel;
        document.querySelectorAll('.code-tree-item').forEach((el) => {
          el.classList.toggle('active', el.dataset.rel === rel);
        });
        const statEl = document.getElementById('code-save-status');
        if (statEl) statEl.textContent = 'Loading…';
        try {
          const res = await fetch(`/api/agents/${a.id}/file?path=${encodeURIComponent(rel)}`);
          const data = await res.json();
          if (data.ok) {
            textarea.value = data.content;
            if (statEl) {
              statEl.textContent = '✓ Saved';
              statEl.style.color = '#16a34a';
            }
          } else {
            textarea.value = '// Error loading file: ' + (data.error || 'not found');
          }
        } catch (e) {
          textarea.value = '// Error reading file: ' + e.message;
        }
        updateLineNumbers();
      };

      const loadFiles = async () => {
        treeList.innerHTML = '<div style="padding:10px;font-size:11px;color:#858072;">Loading files…</div>';
        try {
          const res = await fetch(`/api/agents/${a.id}/files`);
          const data = await res.json();
          treeList.innerHTML = '';
          const entries = data.entries || [];
          if (!entries.length) {
            treeList.innerHTML = '<div style="padding:10px;font-size:11px;color:#858072;">No files in workspace.<br>Click <b>+ File</b> to create one.</div>';
            return;
          }
          for (const ent of entries) {
            const item = document.createElement('div');
            item.className = 'code-tree-item' + (activeFile === ent.relPath ? ' active' : '');
            item.dataset.rel = ent.relPath;

            let icon = '📄';
            if (ent.isDir) icon = '📁';
            else if (ent.name.endsWith('.js') || ent.name.endsWith('.ts')) icon = '⚡';
            else if (ent.name.endsWith('.py')) icon = '🐍';
            else if (ent.name.endsWith('.json')) icon = '⚙️';
            else if (ent.name.endsWith('.md')) icon = '📝';

            item.innerHTML = `<span class="icon">${icon}</span> <span>${esc(ent.name)}</span>`;
            if (!ent.isDir) {
              item.onclick = () => openFile(ent.relPath);
            }
            treeList.appendChild(item);
          }

          if (!activeFile && entries.some((e) => !e.isDir)) {
            const firstFile = entries.find((e) => !e.isDir);
            if (firstFile) openFile(firstFile.relPath);
          } else if (activeFile) {
            openFile(activeFile);
          }
        } catch (e) {
          treeList.innerHTML = '<div style="padding:10px;font-size:11px;color:var(--st-fail);">Failed to load files.</div>';
        }
      };

      refreshBtn.onclick = loadFiles;

      newFileBtn.onclick = async () => {
        const name = prompt('Enter new file name (e.g. main.js, app.py, test.txt):');
        if (!name || !name.trim()) return;
        const filename = name.trim();
        await fetch(`/api/agents/${a.id}/file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filename, content: `// File: ${filename}\n// Agent: ${a.name}\n` })
        });
        await loadFiles();
        openFile(filename);
      };

      loadFiles();
    }

    function ccRenderTerminal(body, a) {
      body.innerHTML = '';
      if (!window._ccTermFontSize) window._ccTermFontSize = 12;

      const ptyName = 'pty-' + (a.name || 'agent').toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + (a.id || '000').slice(-8);

      const cfg = getProviderTerminalConfig(a);

      const room = activeRoom();
      const allTasks = room?.tasks ?? [];
      const agentTasks = allTasks.filter((t) => t.agentId === a.id || t.agentName === a.name);
      const queuedTasks = agentTasks.filter((t) => t.state === 'submitted');
      const currentTask = agentTasks.find((t) => t.state === 'working');

      let statusDesc = a.name + ' is on standby';
      if (currentTask) {
        statusDesc = a.name + ' is busy (' + (currentTask.title || 'working') + ') — ' + queuedTasks.length + ' queued';
      } else if (queuedTasks.length > 0) {
        statusDesc = queuedTasks.length + ' task' + (queuedTasks.length > 1 ? 's' : '') + ' queued for ' + a.name;
      }

      const container = document.createElement('div');
      container.className = 'term-container' + (window._ccTermFullscreen ? ' fullscreen' : '');

      // 1. Subhead
      const subhead = document.createElement('div');
      subhead.className = 'term-subhead';

      const liveTag = document.createElement('div');
      liveTag.className = 'term-live-tag';
      liveTag.innerHTML = '<span class="term-live-dot"></span><span>live · pty ' + esc(ptyName) + '</span>';

      const ctrls = document.createElement('div');
      ctrls.className = 'term-ctrls';

      const decBtn = document.createElement('button');
      decBtn.className = 'term-ctrl-btn';
      decBtn.textContent = '-';
      decBtn.title = 'Decrease font size';

      const fontLabel = document.createElement('span');
      fontLabel.className = 'term-font-val';
      fontLabel.textContent = window._ccTermFontSize + 'px';

      const incBtn = document.createElement('button');
      incBtn.className = 'term-ctrl-btn';
      incBtn.textContent = '+';
      incBtn.title = 'Increase font size';

      const expBtn = document.createElement('button');
      expBtn.className = 'term-ctrl-btn';
      expBtn.textContent = window._ccTermFullscreen ? '🗗' : '⛶';
      expBtn.title = 'Toggle Expand';

      const restartBtn = document.createElement('button');
      restartBtn.className = 'term-ctrl-btn';
      restartBtn.textContent = '↻';
      restartBtn.title = 'Restart CLI Session';
      restartBtn.onclick = () => {
        const entry = getOrCreateTerminalEntry(ptyName, a);
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          if (entry.term) entry.term.clear();
          entry.ws.send(JSON.stringify({
            type: 'restart',
            ptyId: ptyName,
            agentId: a.id,
            cols: entry.term ? entry.term.cols : 100,
            rows: entry.term ? entry.term.rows : 30
          }));
        }
      };

      const briefingBtn = document.createElement('button');
      briefingBtn.className = 'term-ctrl-btn';
      briefingBtn.style.cssText = 'padding:3px 8px;font-size:11px;font-weight:600;display:inline-flex;align-items:center;gap:4px;background:rgba(255,255,255,0.06);color:#f4f4f6;border:1px solid rgba(255,255,255,0.14);border-radius:5px;cursor:pointer;';
      briefingBtn.innerHTML = '<span>🧭</span> Send Briefing';
      briefingBtn.title = 'Send full Hive Protocol orientation prompt to terminal';
      briefingBtn.onclick = () => {
        const entry = getOrCreateTerminalEntry(ptyName, a);
        briefingBtn.innerHTML = '<span>⏳</span> Sending…';
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: 'reseed', ptyId: ptyName, agentId: a.id }));
        }
        setTimeout(() => {
          briefingBtn.innerHTML = '<span>✅</span> Sent';
          setTimeout(() => {
            briefingBtn.innerHTML = '<span>🧭</span> Send Briefing';
          }, 1500);
        }, 300);
      };

      ctrls.appendChild(briefingBtn);
      ctrls.appendChild(decBtn);
      ctrls.appendChild(fontLabel);
      ctrls.appendChild(incBtn);
      ctrls.appendChild(expBtn);
      ctrls.appendChild(restartBtn);

      subhead.appendChild(liveTag);
      subhead.appendChild(ctrls);
      container.appendChild(subhead);

      // 2. Real Xterm Terminal Viewport
      const termWrap = document.createElement('div');
      termWrap.className = 'term-xterm-wrap';
      termWrap.style.cssText = 'flex:1;min-height:320px;background:#090a0d;padding:6px 10px;overflow:hidden;position:relative;';

      const entry = getOrCreateTerminalEntry(ptyName, a);
      termWrap.appendChild(entry.host);

      container.appendChild(termWrap);

      // 3. Queue dock (MessageQueueComposer)
      const queueDock = document.createElement('div');
      queueDock.className = 'term-queue-dock';

      const queueHead = document.createElement('div');
      queueHead.className = 'term-queue-head';
      queueHead.innerHTML = `
        <div>
          <span class="term-queue-tag">QUEUE</span>
          <span style="font-weight:700;margin-right:6px;">${queuedTasks.length}</span>
          <span style="color:var(--text-dim);">${esc(statusDesc)}</span>
        </div>
      `;
      if (queuedTasks.length > 0) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'term-queue-clear';
        clearBtn.textContent = 'clear all';
        clearBtn.onclick = async () => {
          clearBtn.textContent = 'clearing…';
          for (const t of queuedTasks) {
            try {
              await fetch('/debug/stop-task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: t.id, reason: 'Queue cleared' })
              });
            } catch {}
          }
          renderCommandCenter();
        };
        queueHead.appendChild(clearBtn);
      }
      queueDock.appendChild(queueHead);

      if (queuedTasks.length > 0) {
        const qList = document.createElement('div');
        qList.className = 'term-queue-list';
        queuedTasks.forEach((t, i) => {
          const item = document.createElement('div');
          item.className = 'term-queue-item';

          const num = document.createElement('span');
          num.style.cssText = 'font-weight:700;color:var(--text-dim);margin-right:4px;';
          num.textContent = (i + 1) + '.';

          const txt = document.createElement('span');
          txt.className = 'term-queue-item-text';
          txt.textContent = t.spec || t.title || 'Untitled task';
          txt.style.cursor = 'pointer';
          txt.title = 'Click to send this task directly to the terminal now';
          txt.onclick = async () => {
            const val = t.spec || t.title;
            if (val && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
              entry.ws.send(JSON.stringify({ type: 'submitPrompt', ptyId: ptyName, text: val }));
            }
            try {
              await fetch('/debug/stop-task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: t.id, reason: 'Dispatched to terminal' })
              });
            } catch {}
            renderCommandCenter();
          };

          const del = document.createElement('button');
          del.className = 'term-queue-del';
          del.textContent = '✕';
          del.title = 'Remove task from queue';
          del.onclick = async () => {
            del.textContent = '…';
            try {
              await fetch('/debug/stop-task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: t.id, reason: 'Removed from queue by user' })
              });
            } catch {}
            renderCommandCenter();
          };

          item.appendChild(num);
          item.appendChild(txt);
          item.appendChild(del);
          qList.appendChild(item);
        });
        queueDock.appendChild(qList);
      }

      // Input wrap
      const inputWrap = document.createElement('div');
      inputWrap.className = 'term-queue-input-wrap';

      const textarea = document.createElement('textarea');
      textarea.className = 'term-queue-textarea';
      textarea.rows = 2;
      textarea.placeholder = currentTask
        ? (a.name + ' is busy — queue a message')
        : ('Message ' + a.name);

      const actionsRow = document.createElement('div');
      actionsRow.className = 'term-queue-actions';

      const actsLeft = document.createElement('div');
      actsLeft.className = 'term-action-left';

      const filesBtn = document.createElement('button');
      filesBtn.className = 'term-act-btn';
      filesBtn.textContent = '+ files';
      filesBtn.title = 'Insert file reference';
      filesBtn.onclick = () => {
        const fileRef = '# file: src/';
        textarea.value = textarea.value ? (textarea.value + ' ' + fileRef) : fileRef;
        textarea.focus();
      };

      const voiceBtn = document.createElement('button');
      voiceBtn.className = 'term-act-btn';
      voiceBtn.textContent = '🎤 voice';
      voiceBtn.title = 'Voice dictation';
      voiceBtn.onclick = () => {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
          alert('Speech recognition is not supported in this browser.');
          return;
        }
        try {
          const rec = new SpeechRec();
          voiceBtn.textContent = '🔴 listening…';
          rec.onresult = (e) => {
            const transcript = e.results[0][0].transcript;
            textarea.value = textarea.value ? (textarea.value + ' ' + transcript) : transcript;
            voiceBtn.textContent = '🎤 voice';
            textarea.focus();
          };
          rec.onerror = () => { voiceBtn.textContent = '🎤 voice'; };
          rec.onend = () => { voiceBtn.textContent = '🎤 voice'; };
          rec.start();
        } catch {
          voiceBtn.textContent = '🎤 voice';
        }
      };

      actsLeft.appendChild(filesBtn);
      actsLeft.appendChild(voiceBtn);

      const sendBtn = document.createElement('button');
      sendBtn.className = 'term-send-btn';
      sendBtn.textContent = 'send →';

      const doSend = async () => {
        const val = textarea.value.trim();
        if (!val) return;
        sendBtn.disabled = true;
        sendBtn.textContent = 'sending…';

        // 1. Send input directly to interactive PTY session via submitPrompt!
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify({ type: 'submitPrompt', ptyId: ptyName, text: val }));
        }

        // 2. Submit task into database / queue
        const projId = a.projectId || a.project_id || activeRoom()?.id || 'prj_demo';
        try {
          await fetch('/debug/submit-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId: projId,
              title: val,
              spec: val,
              agentId: a.id
            })
          });
          // Also post to room chat with @mention if chat websocket is open so agent reacts in Chat view too
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'chat', roomId: projId, text: '@' + a.name + ' ' + val }));
          }
          textarea.value = '';
          renderCommandCenter();
        } catch (e) {
          console.warn('Failed to send task:', e);
        } finally {
          sendBtn.disabled = false;
          sendBtn.textContent = 'send →';
        }
      };

      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSend();
        }
      });
      sendBtn.onclick = doSend;

      actionsRow.appendChild(actsLeft);
      actionsRow.appendChild(sendBtn);

      inputWrap.appendChild(textarea);
      inputWrap.appendChild(actionsRow);
      queueDock.appendChild(inputWrap);

      container.appendChild(queueDock);
      body.appendChild(container);

      // Now open and fit xterm
      if (entry.term && !entry.opened) {
        entry.term.open(entry.host);
        entry.opened = true;
      }

      const doFit = () => {
        if (entry.fit && entry.term && entry.host.isConnected && entry.host.clientWidth && entry.host.clientHeight) {
          try {
            entry.fit.fit();
            if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
              entry.ws.send(JSON.stringify({
                type: 'resize',
                ptyId: ptyName,
                cols: entry.term.cols,
                rows: entry.term.rows
              }));
            }
          } catch {}
        }
      };

      requestAnimationFrame(doFit);
      setTimeout(doFit, 100);

      decBtn.onclick = () => {
        if (window._ccTermFontSize > 10) {
          window._ccTermFontSize--;
          fontLabel.textContent = window._ccTermFontSize + 'px';
          if (entry.term) {
            entry.term.options.fontSize = window._ccTermFontSize;
            doFit();
          }
        }
      };

      incBtn.onclick = () => {
        if (window._ccTermFontSize < 20) {
          window._ccTermFontSize++;
          fontLabel.textContent = window._ccTermFontSize + 'px';
          if (entry.term) {
            entry.term.options.fontSize = window._ccTermFontSize;
            doFit();
          }
        }
      };

      expBtn.onclick = () => {
        window._ccTermFullscreen = !window._ccTermFullscreen;
        container.classList.toggle('fullscreen', window._ccTermFullscreen);
        expBtn.textContent = window._ccTermFullscreen ? '🗗' : '⛶';
        setTimeout(doFit, 50);
      };

      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => doFit());
        ro.observe(termWrap);
      }
    }

    function ccRenderOutput(body, a) {
      ccRenderTerminal(body, a);
    }

    function ccRenderGraph(body, a) {
      body.innerHTML = '';
      const note = document.createElement('div');
      note.className = 'cmd-note';
      note.textContent = 'Agents as nodes, messages as edges — delegation vs review vs chat, deterministic layout seeded from agent ids.';
      body.appendChild(note);

      const room = activeRoom();
      const agents = room?.agents ?? [];
      if (!agents.length) {
        body.innerHTML += '<div class="empty-note">No agents to graph.</div>';
        return;
      }
      // Try honest endpoint; Stream B Phase 8 will provide it
      const ph = document.createElement('div');
      ph.className = 'empty-note';
      ph.textContent = 'Loading graph…';
      body.appendChild(ph);
      fetch(`/api/graph?projectId=${room.id}`).then(async (res) => {
        let nodes = agents;
        let edges = [];
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          nodes = data.nodes ?? agents;
          edges = data.edges ?? [];
        } else {
          // Fallback: build edges from activity (delegation/review/chat) — honest, not a second store
          const act = room.activity ?? [];
          edges = act.filter((it) => it.type.startsWith('delegate') || it.type.startsWith('review') || it.type === 'chat').map((it) => ({
            from: it.actor ?? 'system',
            to: it.taskId ?? '',
            kind: it.type.includes('delegate') ? 'delegation' : it.type.includes('review') ? 'review' : 'chat',
          }));
          ph.textContent = res.status === 404 ? 'Graph not available yet — server has no graph endpoint. Showing activity-derived edges.' : `Could not load graph (${res.status}) — showing activity.`;
          if (res.status !== 404) return;
        }
        ph.remove();
        // Deterministic layout: circle, seeded from hashString(agent.id)
        const W = 320, H = 220, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 30;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;width:320px;height:220px;margin:12px auto;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);overflow:hidden';
        // Place nodes deterministically: sort by id, then angle by hash
        const sorted = [...nodes].sort((x, y) => x.id.localeCompare(y.id));
        const pos = new Map();
        for (let i = 0; i < sorted.length; i++) {
          const id = sorted[i].id ?? sorted[i].name;
          const h = hashString(String(id));
          const angle = (h % 360) * Math.PI / 180 + (i * 2 * Math.PI / sorted.length / 2);
          // Mix hash angle and index to avoid overlap while staying deterministic
          const r = R * (0.7 + (h % 30) / 100);
          const x = cx + r * Math.cos(angle);
          const y = cy + r * Math.sin(angle);
          pos.set(String(id), { x, y });
          // Also map name to same pos for actor lookup
          const name = sorted[i].name;
          if (name) pos.set(name, { x, y });
        }
        // Draw edges as thin lines, color by kind
        const colorFor = (k) => k === 'delegation' ? '#8b5cf6' : k === 'review' ? '#3b82f6' : '#22c55e';
        for (const e of edges.slice(0, 30)) {
          const from = pos.get(String(e.from)) ?? pos.get(String(e.fromAgent)) ?? { x: cx, y: cy };
          const to = pos.get(String(e.to)) ?? pos.get(String(e.toAgent)) ?? { x: cx + 20, y: cy + 20 };
          const line = document.createElement('div');
          line.style.cssText = `position:absolute;left:${from.x}px;top:${from.y}px;width:${Math.hypot(to.x - from.x, to.y - from.y)}px;height:2px;background:${colorFor(e.kind)};transform-origin:0 50%;transform:rotate(${Math.atan2(to.y - from.y, to.x - from.x)}rad);opacity:.7`;
          wrap.appendChild(line);
        }
        // Draw nodes
        for (const n of sorted) {
          const id = n.id ?? n.name;
          const p = pos.get(String(id)) || { x: cx, y: cy };
          const dot = document.createElement('div');
          dot.style.cssText = `position:absolute;left:${p.x - 14}px;top:${p.y - 14}px;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.2)`;
          dot.textContent = (n.name ?? id).slice(0, 2).toUpperCase();
          dot.title = n.name ?? id;
          dot.onclick = () => openCommandCenter(n.id ?? id);
          wrap.appendChild(dot);
        }
        // Legend
        const legend = document.createElement('div');
        legend.style.cssText = 'position:absolute;bottom:6px;left:6px;display:flex;gap:8px;font-size:10px;color:var(--text-faint)';
        legend.innerHTML = '<span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:2px;background:#8b5cf6;display:inline-block"></span>delegation</span><span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:2px;background:#3b82f6;display:inline-block"></span>review</span><span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:2px;background:#22c55e;display:inline-block"></span>chat</span>';
        wrap.appendChild(legend);
        body.appendChild(wrap);
      }).catch(() => { ph.textContent = 'Could not reach server for graph.'; });
    }

    function ccRenderMessages(body, a) {
      body.innerHTML = '';
      const wrapper = document.createElement('div');
      wrapper.className = 'mailbox-wrapper';

      const head = document.createElement('div');
      head.className = 'mailbox-head';

      const titleWrap = document.createElement('div');
      titleWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const title = document.createElement('span');
      title.style.cssText = 'font-weight:700;font-size:13px;';
      title.textContent = `Hive Mailbox: ${a.name}`;
      const note = document.createElement('span');
      note.style.cssText = 'font-size:11px;color:var(--text-faint);';
      note.textContent = 'FIPA-lite speech acts (inbox/ & outbox/)';
      titleWrap.append(title, note);

      const filterRow = document.createElement('div');
      filterRow.style.cssText = 'display:flex;gap:6px;';
      const filterAll = document.createElement('button');
      filterAll.className = 'code-btn' + (!window._ccMailFilter || window._ccMailFilter === 'all' ? ' active' : '');
      filterAll.textContent = 'All';
      filterAll.onclick = () => { window._ccMailFilter = 'all'; ccRenderMessages(body, a); };

      const filterIn = document.createElement('button');
      filterIn.className = 'code-btn' + (window._ccMailFilter === 'inbox' ? ' active' : '');
      filterIn.textContent = '📥 Inbox';
      filterIn.onclick = () => { window._ccMailFilter = 'inbox'; ccRenderMessages(body, a); };

      const filterOut = document.createElement('button');
      filterOut.className = 'code-btn' + (window._ccMailFilter === 'outbox' ? ' active' : '');
      filterOut.textContent = '📤 Outbox';
      filterOut.onclick = () => { window._ccMailFilter = 'outbox'; ccRenderMessages(body, a); };

      filterRow.append(filterAll, filterIn, filterOut);
      head.append(titleWrap, filterRow);
      wrapper.appendChild(head);

      const list = document.createElement('div');
      list.className = 'mailbox-list';
      wrapper.appendChild(list);

      // Composer at bottom
      const comp = document.createElement('div');
      comp.className = 'mailbox-composer';

      const row1 = document.createElement('div');
      row1.className = 'mailbox-composer-row';

      const toSelect = document.createElement('select');
      toSelect.className = 'mailbox-composer-input';
      toSelect.style.cssText = 'max-width:180px;';
      toSelect.innerHTML = `
        <option value="god">👑 Orchestrator (God)</option>
        <option value="broadcast">📢 Broadcast to All</option>
      `;
      const allAgents = activeRoom()?.agents || [];
      allAgents.filter((other) => other.id !== a.id).forEach((other) => {
        toSelect.innerHTML += `<option value="${esc(other.id)}">${esc(other.name || other.id)}</option>`;
      });

      const actSelect = document.createElement('select');
      actSelect.className = 'mailbox-composer-input';
      actSelect.style.cssText = 'max-width:140px;font-weight:700;';
      actSelect.innerHTML = `
        <option value="request">request</option>
        <option value="inform">inform</option>
        <option value="query">query</option>
        <option value="propose">propose</option>
        <option value="done">done</option>
      `;

      const subjInput = document.createElement('input');
      subjInput.className = 'mailbox-composer-input';
      subjInput.placeholder = 'Subject line (e.g. Review requirements)';

      row1.append(toSelect, actSelect, subjInput);

      const row2 = document.createElement('div');
      row2.style.cssText = 'display:flex;gap:8px;align-items:flex-end;';

      const bodyInput = document.createElement('textarea');
      bodyInput.className = 'mailbox-composer-input';
      bodyInput.style.cssText = 'height:54px;font-family:ui-monospace, monospace;resize:vertical;';
      bodyInput.placeholder = 'Message body or structured payload...';

      const sendBtn = document.createElement('button');
      sendBtn.className = 'code-btn';
      sendBtn.style.cssText = 'background:var(--accent);color:#fff;border-color:var(--accent);font-weight:700;height:36px;padding:0 16px;white-space:nowrap;';
      sendBtn.textContent = 'Send Message';
      sendBtn.onclick = async () => {
        const to = toSelect.value;
        const act = actSelect.value;
        const subject = subjInput.value.trim() || 'No subject';
        const bodyText = bodyInput.value.trim();
        if (!bodyText) return alert('Enter a message body');
        try {
          await fetch('/api/hive/messages', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              from: a.id,
              to,
              act,
              subject,
              body: bodyText,
            })
          });
          bodyInput.value = '';
          subjInput.value = '';
          loadMessages();
        } catch (e) {
          alert('Failed sending message: ' + e);
        }
      };

      row2.append(bodyInput, sendBtn);
      comp.append(row1, row2);
      wrapper.appendChild(comp);
      body.appendChild(wrapper);

      const loadMessages = async () => {
        try {
          const res = await fetch(`/api/hive/messages?agentId=${a.id}`);
          if (!res.ok) throw new Error('status ' + res.status);
          const data = await res.json();
          renderCards(data.inbox || [], data.outbox || []);
        } catch {
          list.innerHTML = '<div class="empty-note">No hive messages recorded yet. Send one below!</div>';
        }
      };

      const renderCards = (inbox, outbox) => {
        list.innerHTML = '';
        let items = [];
        if (!window._ccMailFilter || window._ccMailFilter === 'all') {
          items = [
            ...inbox.map((m) => ({ ...m, _dir: 'in' })),
            ...outbox.map((m) => ({ ...m, _dir: 'out' }))
          ];
        } else if (window._ccMailFilter === 'inbox') {
          items = inbox.map((m) => ({ ...m, _dir: 'in' }));
        } else {
          items = outbox.map((m) => ({ ...m, _dir: 'out' }));
        }

        items.sort((x, y) => (Date.parse(x.created_at || '') || 0) - (Date.parse(y.created_at || '') || 0));

        if (!items.length) {
          list.innerHTML = '<div class="empty-note">No messages match filter. Send a message to start communicating!</div>';
          return;
        }

        items.forEach((m) => {
          const card = document.createElement('div');
          card.className = 'mailbox-card';

          const cardHead = document.createElement('div');
          cardHead.className = 'mailbox-card-header';

          const left = document.createElement('div');
          left.style.cssText = 'display:flex;align-items:center;gap:7px;';

          const dirTag = document.createElement('span');
          dirTag.style.cssText = 'font-size:10px;font-weight:700;';
          dirTag.textContent = m._dir === 'in' ? `📥 from ${m.from}` : `📤 to ${m.to}`;

          const actTag = document.createElement('span');
          actTag.className = `mailbox-act-badge act-${m.act || 'inform'}`;
          actTag.textContent = m.act || 'inform';

          left.append(dirTag, actTag);

          const time = document.createElement('span');
          time.style.cssText = 'font-size:10.5px;color:var(--text-faint);';
          time.textContent = relativeTime(m.created_at);

          cardHead.append(left, time);

          const subj = document.createElement('div');
          subj.className = 'mailbox-subject';
          subj.textContent = m.subject;

          const bText = document.createElement('div');
          bText.className = 'mailbox-body';
          bText.textContent = m.body;

          card.append(cardHead, subj, bText);
          list.appendChild(card);
        });
        list.scrollTop = list.scrollHeight;
      };

      loadMessages();
    }

    // What this agent pulls in before it starts work, ranked.
    //
    // The badge and the placeholder both say "keyword", not "semantic",
    // because retrieval is SQLite FTS5/BM25 — there is no embedding model
    // wired in anywhere (DECISIONS.md D25). A search box that implied
    // semantic matching would be a stub wearing the word.
    function ccRenderMemory(body, a) {
      body.innerHTML = '';
      const panel = ccPanel(body,
        '<path d="M9.5 3A3.5 3.5 0 0 0 6 6.5v.6A3 3 0 0 0 6 13v3a3 3 0 0 0 6 0V6.5A3.5 3.5 0 0 0 9.5 3z"/><path d="M14.5 3A3.5 3.5 0 0 1 18 6.5v.6a3 3 0 0 1 0 5.9v3a3 3 0 0 1-6 0"/>',
        'Recall', 'What this agent pulls in before starting work', 'BM25 keyword');

      const all = (activeRoom()?.memories ?? []);

      const search = document.createElement('div');
      search.className = 'cc-search';
      search.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>';
      const input = document.createElement('input');
      input.placeholder = 'Keyword search (not semantic)…';
      search.appendChild(input);
      panel.appendChild(search);

      const rows = document.createElement('div');
      panel.appendChild(rows);

      const draw = (q) => {
        rows.innerHTML = '';
        const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
        // Rank the same way the server does in spirit: term matches first,
        // recency as the tiebreak. Shown as a score so the ordering is legible
        // rather than mysterious.
        const scored = all.map((m) => {
          const text = (m.text || '').toLowerCase();
          const hits = terms.length ? terms.filter((t) => text.includes(t)).length : 0;
          const ageH = Math.max(0, (Date.now() - Date.parse(m.createdAt || 0)) / 3.6e6);
          const recency = 1 / (1 + ageH / 24);
          const score = terms.length ? (hits / terms.length) * 0.8 + recency * 0.2 : recency;
          return { m, hits, score };
        }).filter((r) => !terms.length || r.hits > 0)
          .sort((x, y) => y.score - x.score);

        if (!scored.length) {
          rows.innerHTML = '<div class="empty-note">' +
            (terms.length ? 'No memory matches those keywords.' : 'Nothing recalled yet.') + '</div>';
          return;
        }
        for (const { m, score } of scored) {
          const row = document.createElement('div');
          row.className = 'cc-row';
          const rel = document.createElement('div');
          rel.className = 'cc-relevance';
          rel.textContent = Math.round(score * 100) + '%';
          const main = document.createElement('div');
          main.className = 'cc-row-main';
          const t = document.createElement('div');
          t.style.cssText = 'font-size:13px;color:var(--text);line-height:1.45;';
          t.textContent = m.text || '';
          const meta = document.createElement('div');
          meta.className = 'cc-row-idx';
          meta.style.marginTop = '4px';
          meta.innerHTML =
            esc(m.scope === 'agent' ? 'Agent' : 'Project') + ' · ' +
            '<span style="color:var(--st-reviewing)">' + esc(m.agentName || '—') + '</span> · ' +
            esc(m.createdAt ? relativeTime(m.createdAt) : '');
          main.append(t, meta);
          row.append(rel, main);
          rows.appendChild(row);
        }
      };
      draw('');
      input.oninput = () => draw(input.value);
    }

    // The split memory-file editor. No longer mounted as a tab (the reference
    // Memory tab is Recall); kept because it is the only writer for
    // /api/hive/memory/:agentId.
    function ccRenderMemoryEditor(body, a) {
      body.innerHTML = '';
      const split = document.createElement('div');
      split.className = 'hive-mem-split';

      // Left pane: Agent private memory
      const leftPane = document.createElement('div');
      leftPane.className = 'hive-mem-pane';

      const leftHead = document.createElement('div');
      leftHead.className = 'hive-mem-head';
      leftHead.innerHTML = `<span>Private Memory (agents/${esc(a.name)}/memory.md)</span>`;

      const saveLeftBtn = document.createElement('button');
      saveLeftBtn.className = 'code-btn';
      saveLeftBtn.style.cssText = 'background:#16a34a;color:#fff;border-color:var(--st-working);font-weight:700;';
      saveLeftBtn.textContent = 'Save Memory';

      leftHead.appendChild(saveLeftBtn);
      leftPane.appendChild(leftHead);

      const leftEditor = document.createElement('textarea');
      leftEditor.className = 'hive-mem-editor';
      leftEditor.placeholder = 'Agent long-term memory... (durable facts, key decisions)';
      leftPane.appendChild(leftEditor);

      saveLeftBtn.onclick = async () => {
        saveLeftBtn.disabled = true;
        saveLeftBtn.textContent = 'Saving…';
        try {
          await fetch(`/api/hive/memory/${a.id}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: leftEditor.value })
          });
          saveLeftBtn.textContent = 'Saved!';
          setTimeout(() => { saveLeftBtn.disabled = false; saveLeftBtn.textContent = 'Save Memory'; }, 1200);
        } catch (e) {
          alert('Failed saving memory: ' + e);
          saveLeftBtn.disabled = false;
          saveLeftBtn.textContent = 'Save Memory';
        }
      };

      // Right pane: Shared Blackboard
      const rightPane = document.createElement('div');
      rightPane.className = 'hive-mem-pane';

      const rightHead = document.createElement('div');
      rightHead.className = 'hive-mem-head';
      rightHead.innerHTML = `<span>Shared Blackboard (hive/board.md)</span>`;

      const saveRightBtn = document.createElement('button');
      saveRightBtn.className = 'code-btn';
      saveRightBtn.style.cssText = 'background:var(--accent);color:#fff;border-color:var(--accent);font-weight:700;';
      saveRightBtn.textContent = 'Save Blackboard';

      rightHead.appendChild(saveRightBtn);
      rightPane.appendChild(rightHead);

      const rightEditor = document.createElement('textarea');
      rightEditor.className = 'hive-mem-editor';
      rightEditor.placeholder = 'Shared plans, specifications, and objectives co-authored by agents...';
      rightPane.appendChild(rightEditor);

      saveRightBtn.onclick = async () => {
        saveRightBtn.disabled = true;
        saveRightBtn.textContent = 'Saving…';
        try {
          await fetch(`/api/hive/board`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: rightEditor.value, authorId: a.id })
          });
          saveRightBtn.textContent = 'Saved!';
          setTimeout(() => { saveRightBtn.disabled = false; saveRightBtn.textContent = 'Save Blackboard'; }, 1200);
        } catch (e) {
          alert('Failed saving blackboard: ' + e);
          saveRightBtn.disabled = false;
          saveRightBtn.textContent = 'Save Blackboard';
        }
      };

      split.append(leftPane, rightPane);
      body.appendChild(split);

      // Load initial contents
      fetch(`/api/hive/memory/${a.id}`).then((r) => r.json()).then((d) => {
        leftEditor.value = d.content || '';
      }).catch(() => {});

      fetch(`/api/hive/board`).then((r) => r.json()).then((d) => {
        rightEditor.value = d.content || '';
      }).catch(() => {});
    }

    // ---------------- Command Center: Triggers tab ----------------
    //
    // Standing rules that create tasks on a schedule or when an event lands.
    // The list is room-scoped (Room.triggers) but lives here because this is
    // the panel the design gives it. Everything that changes state goes over
    // HTTP and the server's broadcast re-renders the result — the browser
    // never edits its own copy of the list.
    //
    // Draft/focus survive between broadcasts for the same reason the memory
    // filter's do: this whole panel rebuilds mid-typing whenever any view
    // arrives, and a form that resets itself is a form nobody can fill in.
    let ccTrigDraft = {};
    let ccTrigFocus = null;
    let ccTrigError = '';
    let ccTrigConfirmId = null; // delete needs a second click; survives re-renders

    async function ccTrigPost(path, payload) {
      try {
        const r = await fetch('/api/triggers' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const d = await r.json().catch(() => null);
        if (d && typeof d.ok === 'boolean') return d;
        return { ok: false, error: `HTTP ${r.status} with an unreadable body` };
      } catch (e) {
        // The server said nothing — say so plainly rather than pretending
        // this is one of ITS errors.
        return { ok: false, error: `request failed before the server answered (${e?.message ?? e})` };
      }
    }

    function fmtNextFire(iso) {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return null;
      return ms - Date.now() < 86400_000
        ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : new Date(ms).toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }

    function ccRenderTriggers(body, a) {
      const room = activeRoom();
      const triggers = room?.triggers ?? [];

      const head = document.createElement('div');
      head.className = 'section-label';
      head.style.marginTop = '0';
      head.textContent = 'New trigger';
      body.appendChild(head);

      const FIELDS = [
        { key: 'name', ph: 'Name, e.g. Morning triage', type: 'text', col: '' },
        { key: 'kind', kind: 'segment', col: '' },
        { key: 'rule', ph: 'every day at 09:00', type: 'text', col: '' },
        { key: 'taskTitle', ph: 'Task title (defaults to the name)', type: 'text', col: 'wide' },
        { key: 'taskSpec', ph: 'Instructions for whoever picks it up (optional)', type: 'text', col: 'wide' },
        { key: 'taskCapability', ph: 'Required capability (optional)', type: 'text', col: '' },
        { key: 'budgetSeconds', ph: 'Budget seconds', type: 'number', col: '' },
        { key: 'budgetUsd', ph: 'Budget USD', type: 'number', col: '', step: '0.01' },
      ];

      const form = document.createElement('div');
      form.className = 'cc-trig-form';
      for (const f of FIELDS) {
        if (f.kind === 'segment') {
          // Two choices read better as visible buttons than as a dropdown,
          // and a button is clickable by anything that can click at all.
          const segs = document.createElement('div');
          segs.className = f.col || undefined;
          segs.style.cssText = 'display:flex;gap:4px;';
          const paintSegs = () => {
            for (const b of segs.children) {
              const on = (ccTrigDraft.kind ?? 'schedule') === b.dataset.kindValue;
              b.style.background = on ? 'var(--accent)' : 'var(--surface-2)';
              b.style.borderColor = on ? 'var(--accent)' : 'var(--border)';
              b.style.color = on ? '#fff' : 'var(--text-dim)';
              b.style.fontWeight = on ? '700' : '400';
            }
          };
          for (const [v, label] of [['schedule', 'Schedule'], ['event', 'Event']]) {
            const seg = document.createElement('button');
            seg.type = 'button';
            seg.textContent = label;
            seg.dataset.kindValue = v;
            seg.style.cssText = 'flex:1;font:inherit;font-size:12px;padding:8px 4px;border-radius:8px;cursor:pointer;' +
              'border:1px solid var(--border);background:var(--surface-2);color:var(--text-dim);';
            seg.onclick = () => { ccTrigDraft.kind = v; paintSegs(); drawRuleHint(); };
            segs.appendChild(seg);
          }
          paintSegs();
          form.appendChild(segs);
          continue;
        }
        const el = document.createElement('input');
        el.type = f.type;
        el.placeholder = f.ph;
        if (f.step) el.step = f.step;
        if (f.type === 'number') el.min = '0';
        el.dataset.ccTrig = f.key;
        el.value = ccTrigDraft[f.key] ?? '';
        el.addEventListener('focus', () => { ccTrigFocus = f.key; });
        el.addEventListener('blur', () => { if (ccTrigFocus === f.key) ccTrigFocus = null; });
        el.addEventListener('input', () => { ccTrigDraft[f.key] = el.value; });
        if (f.col) el.classList.add(f.col);
        form.appendChild(el);
      }
      body.appendChild(form);

      const hint = document.createElement('div');
      hint.className = 'cc-trig-hint';
      const drawRuleHint = () => {
        hint.innerHTML = '';
        if ((ccTrigDraft.kind ?? 'schedule') === 'event') {
          hint.textContent = 'The event type to react to as written in the event log, e.g. ';
          const c = document.createElement('code');
          c.textContent = 'task.result';
          hint.appendChild(c);
        } else {
          hint.append('Accepted forms: ');
          for (const ex of ['every day at HH:MM', 'every weekday at HH:MM', 'every <weekday> at HH:MM', 'every <n> minutes|hours']) {
            const c = document.createElement('code');
            c.textContent = ex;
            hint.appendChild(c);
            hint.append(' ');
          }
        }
      };
      drawRuleHint();
      body.appendChild(hint);

      const actions = document.createElement('div');
      actions.className = 'cc-trig-actions';
      const createBtn = document.createElement('button');
      createBtn.className = 'btn-primary';
      createBtn.textContent = 'Create trigger';
      createBtn.onclick = async () => {
        // Local emptiness checks are layout help, not validation policy —
        // everything real is decided server-side and shown verbatim below.
        if (!String(ccTrigDraft.name ?? '').trim()) { ccTrigError = 'Give the trigger a name.'; draw(); return; }
        if (!String(ccTrigDraft.rule ?? '').trim()) { ccTrigError = 'A trigger needs a rule — what should fire it?'; draw(); return; }
        const numOrNull = (v) => {
          const s = String(v ?? '').trim();
          if (!s) return null;
          const n = Number(s);
          return Number.isFinite(n) ? n : null;
        };
        createBtn.disabled = true;
        const res = await ccTrigPost('', {
          projectId: room.id,
          name: String(ccTrigDraft.name).trim(),
          kind: ccTrigDraft.kind === 'event' ? 'event' : 'schedule',
          rule: String(ccTrigDraft.rule).trim(),
          taskTitle: String(ccTrigDraft.taskTitle ?? '').trim() || null,
          taskSpec: String(ccTrigDraft.taskSpec ?? '').trim() || null,
          taskCapability: String(ccTrigDraft.taskCapability ?? '').trim() || null,
          budgetSeconds: numOrNull(ccTrigDraft.budgetSeconds),
          budgetUsd: numOrNull(ccTrigDraft.budgetUsd),
          tz: null, // server resolves its own zone — the browser never guesses one
        });
        createBtn.disabled = false;
        if (res.ok) {
          ccTrigDraft = {}; ccTrigError = '';
          // The create response carries no view — the broadcast re-renders the
          // LIST. The form however still shows what was typed until the next
          // broadcast, and a form that keeps its values after submitting reads
          // as "did that even work?", so rebuild the whole panel now.
          renderCommandCenter();
          return;
        } else {
          ccTrigError = res.error ?? 'unknown error';
        }
        draw();
      };
      const errLine = document.createElement('div');
      errLine.className = 'cc-trig-error';
      errLine.style.flex = '1';
      actions.append(createBtn, errLine);
      body.appendChild(actions);

      const listHead = document.createElement('div');
      listHead.className = 'section-label';
      listHead.textContent = 'Standing rules';
      body.appendChild(listHead);

      const list = document.createElement('div');

      const drawRow = (t) => {
        const row = document.createElement('div');
        row.className = 'trig-row' + (t.enabled ? '' : ' off');

        const main = document.createElement('div');
        main.className = 'trig-main';
        const nameLine = document.createElement('div');
        nameLine.className = 'trig-name-line';
        const name = document.createElement('span');
        name.className = 'trig-name';
        name.textContent = t.name;
        const pill = document.createElement('span');
        pill.className = 'mem-scope s-agent'; // reuse the plain pill styling
        pill.textContent = t.kind;
        nameLine.append(name, pill);
        const ruleEl = document.createElement('div');
        ruleEl.className = 'trig-rule';
        ruleEl.textContent = t.rule;
        ruleEl.title = t.tz ? `evaluated in ${t.tz}` : '';
        const subBits = [];
        if (t.taskTitle && t.taskTitle !== t.name) subBits.push(`creates “${t.taskTitle}”`);
        if (t.taskCapability) subBits.push(`needs ${t.taskCapability}`);
        if (t.budgetSeconds) subBits.push(`${t.budgetSeconds}s budget`);
        if (t.budgetUsd) subBits.push(`$${t.budgetUsd} budget`);
        const sub = document.createElement('div');
        sub.className = 'trig-sub';
        sub.textContent = subBits.join(' · ') || (t.taskSpec ? `creates “${t.taskTitle}”` : '');
        main.append(nameLine, ruleEl);
        if (sub.textContent) main.appendChild(sub);

        const when = document.createElement('div');
        when.className = 'trig-when';
        const next = document.createElement('div');
        next.className = 'trig-next';
        // A paused trigger has no honest "next" — its stored slot is stale.
        next.textContent = !t.enabled ? 'off'
          : t.kind === 'event' ? `armed for ${t.rule}`
          : (fmtNextFire(t.nextFireAt) ? `next ${fmtNextFire(t.nextFireAt)}` : '—');
        const last = document.createElement('div');
        last.className = 'trig-last';
        last.textContent = t.lastFiredAt ? `fired ${relativeTime(t.lastFiredAt)}` : 'never fired';
        when.append(next, last);

        const btns = document.createElement('div');
        btns.className = 'trig-btns';
        const toggle = document.createElement('button');
        toggle.className = 'trig-toggle' + (t.enabled ? '' : ' is-off');
        toggle.textContent = t.enabled ? 'ON' : 'OFF';
        toggle.onclick = async () => {
          toggle.disabled = true;
          const res = await ccTrigPost('/enable', { id: t.id, enabled: !t.enabled });
          toggle.disabled = false;
          if (!res.ok) { ccTrigError = `${t.name}: ${res.error ?? 'unknown error'}`; draw(); }
        };
        const del = document.createElement('button');
        del.className = 'trig-del' + (ccTrigConfirmId === t.id ? ' confirm' : '');
        del.textContent = ccTrigConfirmId === t.id ? 'really?' : 'Delete';
        del.onclick = async () => {
          if (ccTrigConfirmId !== t.id) { ccTrigConfirmId = t.id; draw(); return; }
          ccTrigConfirmId = null;
          del.disabled = true;
          const res = await ccTrigPost('/delete', { id: t.id });
          del.disabled = false;
          if (!res.ok) { ccTrigError = `${t.name}: ${res.error ?? 'unknown error'}`; draw(); }
        };
        btns.append(toggle, del);

        row.append(main, when, btns);
        return row;
      };

      const draw = () => {
        errLine.textContent = ccTrigError;
        list.innerHTML = '';
        if (!triggers.length) {
          const empty = document.createElement('div');
          empty.className = 'empty-note';
          // Also the honest reading when an older server ships no field at all.
          empty.textContent = 'No triggers yet — standing rules that create work on their own appear here.';
          list.appendChild(empty);
          return;
        }
        for (const t of triggers) list.appendChild(drawRow(t));
      };
      draw();

      body.appendChild(list);

      // Restore focus after a broadcast rebuild (same deal as the memory tab).
      if (ccTrigFocus) {
        const el = form.querySelector(`[data-cc-trig="${ccTrigFocus}"]`);
        if (el) {
          el.focus();
          if (typeof el.setSelectionRange === 'function') {
            const end = el.value.length;
            el.setSelectionRange(end, end);
          }
        }
      }
    }

    // ---------------- add-agent dialog ----------------
    // Everything this shows comes from the live view: which machines exist,
    // what they reported as installed, and which gates they have on. The UI
    // greys things out; the RUNNER is what actually refuses — these notes
    // predict its answer, they don't replace it.
    const aaModal = document.getElementById('add-agent-modal');

    function aaMachine() {
      const id = document.getElementById('aa-machine').value;
      return activeRoom()?.machines?.find((m) => m.id === id) ?? null;
    }

    function providerBlockedReason(machine, p) {
      if (!machine.allowUnsandboxed && p.policy === 'none') {
        return 'block|' + p.label + ' has no per-run tool policy on this machine, so allowTools/denyPaths cannot be enforced. ' +
               'The runner will refuse every task it is offered unless its owner starts it with --allow-unsandboxed.';
      }
      return null;
    }

    function aaPopulateProviders() {
      const machine = aaMachine();
      const sel = document.getElementById('aa-provider');
      const note = document.getElementById('aa-provider-note');
      sel.innerHTML = '';
      note.className = 'provider-note';
      note.textContent = '';

      if (!machine) {
        sel.innerHTML = '<option value="">—</option>';
        sel.disabled = true;
        return;
      }
      if (!machine.allowAgentCreation) {
        sel.disabled = true;
        sel.innerHTML = '<option value="">—</option>';
        note.className = 'provider-note block';
        note.textContent = machine.name + ' has not enabled agent creation. Start its runner with --allow-agent-creation to allow it.';
        return;
      }
      sel.disabled = false;

      // Keep the list honest: installed providers only, or standard local fallbacks
      let providers = machine.providers ?? [];
      if (!providers.length) {
        providers = [
          { id: 'claude', label: 'Claude Code', policy: 'claude-settings', verified: true, models: ['claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-opus-5'] },
          { id: 'opencode', label: 'OpenCode', policy: 'none', verified: true, models: [] },
          { id: 'gemini', label: 'Gemini CLI', policy: 'none', verified: false, models: [] },
          { id: 'codex', label: 'Codex · GPT', policy: 'none', verified: false, models: [] }
        ];
      }
      let firstEnabled = null;
      for (const p of providers) {
        const blocked = providerBlockedReason(machine, p);
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label + (p.verified ? '' : ' (unverified parser)');
        if (blocked) { opt.disabled = true; opt.textContent += ' — unavailable'; }
        else if (!firstEnabled) firstEnabled = p.id;
        sel.appendChild(opt);
      }
      if (!firstEnabled) {
        sel.value = '';
        note.className = 'provider-note block';
        note.textContent = 'Every installed provider on ' + machine.name + ' is unavailable (tool policy cannot be enforced).';
        return;
      }
      sel.value = firstEnabled;
      aaProviderChanged();
    }

    function aaProviderChanged() {
      const machine = aaMachine();
      const p = machine?.providers?.find((x) => x.id === document.getElementById('aa-provider').value);
      const note = document.getElementById('aa-provider-note');
      const modelSel = document.getElementById('aa-model');
      note.className = 'provider-note';
      note.textContent = '';
      modelSel.innerHTML = '';

      const models = p?.models ?? [];
      if (models.length) {
        for (const m of models) {
          const opt = document.createElement('option');
          opt.value = m; opt.textContent = m;
          modelSel.appendChild(opt);
        }
        const any = document.createElement('option');
        any.value = ''; any.textContent = "CLI's default";
        modelSel.appendChild(any);
      } else {
        const def = document.createElement('option');
        def.value = ''; def.textContent = "CLI's default (configured in the CLI itself)";
        modelSel.appendChild(def);
      }

      if (!p) return;
      if (!p.verified) {
        note.className = 'provider-note info';
        note.textContent = p.label + "'s output format hasn't been verified here — the agent runs and reports text/exit status, but tool calls won't show up.";
      } else if (p.policy === 'none') {
        note.className = 'provider-note warn';
        note.textContent = p.label + ' cannot enforce tool policy per run. This machine allows unsandboxed runs, so tasks will execute — with the CLI\'s own defaults, not the policy below.';
      }
      aaRenderCommand();
    }

    /**
     * The exact command this agent will run.
     *
     * Every string here comes from the machine (ProviderInfo.command), built
     * from the same buildArgs the harness spawns. The browser substitutes the
     * chosen model and appends the bypass flag — it never composes flags of
     * its own, because it cannot know them for a CLI it has never seen.
     */
    function aaRenderCommand() {
      const machine = aaMachine();
      const p = machine?.providers?.find((x) => x.id === document.getElementById('aa-provider').value);
      const pre = document.getElementById('aa-cmd');
      const mode = document.getElementById('aa-cmd-mode');
      const row = document.getElementById('aa-bypass-row');
      const box = document.getElementById('aa-bypass');
      const label = document.getElementById('aa-bypass-label');
      const bnote = document.getElementById('aa-bypass-note');

      if (!p || !p.command) {
        pre.textContent = '—';
        mode.textContent = '';
        row.style.display = 'none';
        return;
      }

      const model = document.getElementById('aa-model').value;
      let cmd = model ? p.command.withModel.replace('<model>', model) : p.command.noModel;

      // The bypass flag is offered ONLY when the CLI has one AND the machine
      // owner opted into unsandboxed runs. Without that opt-in the runner
      // refuses the task anyway (ptyHarness), so showing an armed toggle here
      // would promise something the machine will not honour.
      const canBypass = !!p.command.bypassFlag && !!machine.allowUnsandboxed;
      row.style.display = p.command.bypassFlag ? 'flex' : 'none';
      row.classList.toggle('disabled', !canBypass);
      box.disabled = !canBypass;
      if (!canBypass) box.checked = false;
      label.textContent = 'Skip this CLI\'s permission prompts';

      if (box.checked && canBypass) cmd += ' ' + p.command.bypassFlag;
      pre.textContent = cmd;
      mode.textContent = box.checked ? '(auto mode on — no permission prompts)' : '(auto mode on)';

      bnote.className = 'provider-note';
      bnote.textContent = '';
      if (p.command.bypassFlag && !machine.allowUnsandboxed) {
        bnote.className = 'provider-note info';
        bnote.textContent = machine.name + ' has not opted into unsandboxed runs, so this stays off. Start its runner with --allow-unsandboxed to allow it.';
      } else if (box.checked && canBypass) {
        bnote.className = 'provider-note warn';
        bnote.textContent = 'This turns off the only tool policy this project enforces. The agent may read, write and run anything its user can.';
      }
    }

    // ---- Add Agent wizard: steps, character, colour ----

    // The palette offered in the dialog. Stored as hex on the agent, so the
    // server carries a value rather than an index into a list only the
    // browser knows — a palette change must not silently recolour agents.
    const AGENT_COLORS = ['#c05d5d', '#5d9c6b', '#4f7ec9', '#c9a227', '#8a63c9', '#c07a4a'];

    let aaCharacter = null;   // null until the person picks; see aaDefaultChar
    let aaColor = null;

    const AA_STEP_ORDER = ['identity', 'workspace', 'engine', 'briefing'];
    function aaShowStep(step) {
      const at = AA_STEP_ORDER.indexOf(step);
      for (const b of document.querySelectorAll('.wiz-step')) {
        const i = AA_STEP_ORDER.indexOf(b.dataset.step);
        b.classList.toggle('active', b.dataset.step === step);
        // Steps behind the current one show a tick instead of their number.
        b.classList.toggle('done', at > -1 && i > -1 && i < at);
      }
      for (const p of document.querySelectorAll('.wiz-pane'))
        p.classList.toggle('active', p.dataset.pane === step);
    }

    /** A stable default so two people opening the dialog see the same thing,
     *  and so an agent always has *a* sprite even if nobody chooses one. */
    function aaDefaultChar() { return CHAR_NAMES[0]; }

    function aaBuildIdentityPickers() {
      const grid = document.getElementById('aa-char');
      grid.innerHTML = '';
      // Built from CHAR_NAMES, so dropping a new sprite sheet into
      // assets/characters and adding it there is the whole job.
      for (const name of CHAR_NAMES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'char-opt' + (name === aaCharacter ? ' sel' : '');
        b.title = name;
        // 32x48 frames drawn at 1.5x; frame 0 of every sheet is the idle pose.
        b.style.backgroundImage = `url(/assets/characters/${name}.png)`;
        b.style.backgroundSize = 'auto 72px';
        b.onclick = () => { aaCharacter = name; aaBuildIdentityPickers(); };
        grid.appendChild(b);
      }
      const sw = document.getElementById('aa-color');
      sw.innerHTML = '';
      for (const c of AGENT_COLORS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch' + (c === aaColor ? ' sel' : '');
        b.style.background = c;
        b.title = c;
        b.onclick = () => { aaColor = c; aaBuildIdentityPickers(); };
        sw.appendChild(b);
      }
    }

    function aaIsolationChanged() {
      const v = document.getElementById('aa-isolation').value;
      const note = document.getElementById('aa-isolation-note');
      // Say what each mode costs, not just what it does. "Worktree" sounds
      // free until it silently needs the folder to be a git repo.
      note.textContent =
        v === 'worktree' ? 'Needs the folder to be a git repository. Falls back to shared if it is not.'
        : v === 'copy'   ? 'Copies the folder once. Changes do not flow back on their own.'
        : 'Several agents in one folder share a git branch and index.';
    }

    function aaOpen() {
      const room = activeRoom();
      const machines = room?.machines ?? [];
      const mSel = document.getElementById('aa-machine');
      const pSel = document.getElementById('aa-project');
      mSel.innerHTML = '';
      pSel.innerHTML = '';
      for (const m of machines) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name + (m.online ? '' : ' (offline)') + (m.allowAgentCreation ? '' : ' — creation off');
        opt.disabled = !m.online || !m.allowAgentCreation;
        mSel.appendChild(opt);
      }
      if (!machines.some((m) => m.online && m.allowAgentCreation)) {
        document.getElementById('agent-create-error').style.display = 'block';
        document.getElementById('agent-create-error').textContent =
          'No machine currently accepts agent creation. A runner must be online AND started with --allow-agent-creation.';
      } else {
        document.getElementById('agent-create-error').style.display = 'none';
      }
      for (const r of latestView?.rooms ?? []) {
        const opt = document.createElement('option');
        opt.value = r.id; opt.textContent = r.name;
        pSel.appendChild(opt);
      }
      const currentProj = activeRoom();
      const commander = currentProj?.agents?.find((x) => x.role === 'planner' || x.role === 'orchestrator' || (x.name || '').includes('commander'));
      const defaultFolder = commander?.folder || (currentProj?.name ? `~/project_test/${currentProj.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '');
      document.getElementById('aa-name').value = '';
      document.getElementById('aa-caps').value = '';
      document.getElementById('aa-cwd').value = defaultFolder;
      document.getElementById('aa-allow').value = '';
      document.getElementById('aa-deny').value = '';
      document.getElementById('aa-folder').value = defaultFolder;
      document.getElementById('aa-isolation').value = 'shared';
      document.getElementById('aa-description').value = '';
      document.getElementById('aa-goal').value = '';
      aaCharacter = aaDefaultChar();
      aaColor = AGENT_COLORS[0];
      aaBuildIdentityPickers();
      aaIsolationChanged();
      aaShowStep('identity');   // always reopen at step 1
      aaPopulateProviders();
      aaImportNote('');         // a fresh dialog carries no previous import's notes
      aaModal.classList.add('open');
      setTimeout(() => document.getElementById('aa-name').focus(), 50);
    }

    function splitList(s) {
      return s.split(',').map((x) => x.trim()).filter(Boolean);
    }

    async function aaSubmit() {
      const errEl = document.getElementById('agent-create-error');
      errEl.style.display = 'none';
      const btn = document.getElementById('aa-submit');
      const body = {
        machineId: document.getElementById('aa-machine').value,
        projectId: document.getElementById('aa-project').value,
        name: document.getElementById('aa-name').value.trim(),
        role: document.getElementById('aa-role').value,
        provider: document.getElementById('aa-provider').value || null,
        model: document.getElementById('aa-model').value || null,
        capabilities: splitList(document.getElementById('aa-caps').value),
        cwd: document.getElementById('aa-cwd').value.trim() || null,
        allowTools: splitList(document.getElementById('aa-allow').value),
        denyPaths: splitList(document.getElementById('aa-deny').value),
        character: aaCharacter,
        color: aaColor,
        folder: document.getElementById('aa-folder').value.trim() || null,
        isolation: document.getElementById('aa-isolation').value,
        bypassPermissions: document.getElementById('aa-bypass').checked,
        description: document.getElementById('aa-description').value.trim() || null,
        goal: document.getElementById('aa-goal').value.trim() || null,
      };
      if (!body.name) {
        aaShowStep('identity');   // the empty field is on step 1, so go there
        errEl.textContent = 'Give the agent a name.';
        errEl.style.display = 'block';
        document.getElementById('aa-name').focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const res = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.ok) {
          aaModal.classList.remove('open');
        } else {
          errEl.textContent = data.error || 'The machine refused.';
          errEl.style.display = 'block';
        }
      } catch (e) {
        errEl.textContent = 'Could not reach the server: ' + e.message;
        errEl.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create agent';
      }
    }

    document.getElementById('open-add-agent').addEventListener('click', aaOpen);
    window.openAddAgent = aaOpen; // the sidebar "+" calls this
    document.getElementById('aa-cancel').addEventListener('click', () => aaModal.classList.remove('open'));

    // ---------------- import hire ----------------
    //
    // A manifest is UNTRUSTED input that happens to arrive as a file: it is
    // only ever a prefilled DRAFT of this dialog. Every field lands where a
    // human can change it, and the only path to a real agent is the same
    // Create button as always — import itself never talks to the server.
    // COMMAND-CENTER.md wants this validated with Zod in packages/protocol;
    // that file is another stream's, so the same checks live here for now.
    const AA_MANIFEST_STRINGS = ['name', 'machine', 'machineId', 'project', 'projectId',
      'character', 'color', 'folder', 'provider', 'model', 'cwd', 'description', 'goal'];
    const AA_MANIFEST_LISTS = ['capabilities', 'allowTools', 'denyPaths'];

    function aaValidateManifest(raw) {
      const problems = [];
      let obj;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        return { problems: [`This file is not valid JSON — the parser said: ${e.message}`] };
      }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return { problems: ['The file parses, but a hire manifest is a JSON object with fields like "name", "role" and "machine" — this is ' + (Array.isArray(obj) ? 'an array' : typeof obj) + '.'] };
      }
      const values = {};
      for (const k of AA_MANIFEST_STRINGS) {
        if (obj[k] === undefined || obj[k] === null) continue;
        if (typeof obj[k] !== 'string') { problems.push(`"${k}" should be text, but it is ${typeof obj[k]} (${JSON.stringify(obj[k])}).`); continue; }
        values[k] = obj[k];
      }
      for (const k of AA_MANIFEST_LISTS) {
        if (obj[k] === undefined || obj[k] === null) continue;
        if (Array.isArray(obj[k]) && obj[k].every((x) => typeof x === 'string')) { values[k] = obj[k]; continue; }
        // a hand-written manifest plausibly says "a, b" — take it, don't refuse it
        if (typeof obj[k] === 'string') { values[k] = obj[k].split(',').map((x) => x.trim()).filter(Boolean); continue; }
        problems.push(`"${k}" should be a list of strings, but it is ${Array.isArray(obj[k]) ? 'a list containing non-strings' : typeof obj[k]}.`);
      }
      if (obj.role !== undefined && obj.role !== null) {
        if (['developer', 'research', 'qa', 'review', 'docs', 'planner'].includes(obj.role)) values.role = obj.role;
        else problems.push(`"role" is "${obj.role}" — expected one of developer, research, qa, review, docs, planner.`);
      }
      if (obj.isolation !== undefined && obj.isolation !== null) {
        if (['shared', 'worktree', 'copy'].includes(obj.isolation)) values.isolation = obj.isolation;
        else problems.push(`"isolation" is "${obj.isolation}" — expected one of shared, worktree, copy.`);
      }
      if (obj.bypassPermissions !== undefined && obj.bypassPermissions !== null) {
        if (typeof obj.bypassPermissions === 'boolean') values.bypassPermissions = obj.bypassPermissions;
        else problems.push(`"bypassPermissions" should be true or false, but it is ${JSON.stringify(obj.bypassPermissions)}.`);
      }
      const known = new Set([...AA_MANIFEST_STRINGS, ...AA_MANIFEST_LISTS, 'role', 'isolation', 'bypassPermissions']);
      const ignored = Object.keys(obj).filter((k) => !known.has(k));
      return { values, problems, ignored };
    }

    function aaImportNote(html) {
      const el = document.getElementById('aa-import-note');
      el.innerHTML = html;   // built from literals + escaped values below, never raw manifest text
      el.style.display = html ? 'block' : 'none';
    }
    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    async function aaImportFile() {
      // The input is a persistent hidden element: clicking it opens the
      // picker, and its change event carries the chosen file.
      document.getElementById('aa-import-file').click();
    }
    document.getElementById('aa-import').addEventListener('click', aaImportFile);
    document.getElementById('aa-import-file').addEventListener('change', async (ev) => {
      const input = ev.target;
      const file = input.files?.[0];
      input.value = ''; // selecting the same file twice must still fire change
      if (!file) return;
        let raw;
        try { raw = await file.text(); }
        catch (e) { aaImportNote('Could not read the file: ' + esc(e.message)); return; }

        const { values, problems, ignored } = aaValidateManifest(raw);
        const errEl = document.getElementById('agent-create-error');
        if (problems.length) {
          // A rejected import must not touch the form — the person may have
          // half-filled it by hand before trying to import.
          errEl.innerHTML = '<b>Import failed — nothing was changed.</b><ul>' +
            problems.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>';
          errEl.style.display = 'block';
          aaImportNote('');
          return;
        }
        errEl.style.display = 'none';

        const notes = [];
        const room = activeRoom();
        const machines = room?.machines ?? [];

        // Identity
        if (values.name !== undefined) document.getElementById('aa-name').value = values.name;
        if (values.role !== undefined) document.getElementById('aa-role').value = values.role;
        if (values.character !== undefined) {
          if (CHAR_NAMES.includes(values.character)) { aaCharacter = values.character; }
          else { notes.push(`character "${esc(values.character)}" is not one this office can draw — pick a sprite`); }
        }
        if (values.color !== undefined) {
          const c = AGENT_COLORS.find((x) => x.toLowerCase() === values.color.toLowerCase());
          if (c) { aaColor = c; }
          else { notes.push(`colour ${esc(values.color)} is not in this office's palette — pick the closest`); }
        }
        aaBuildIdentityPickers();

        // Workspace
        if (values.folder !== undefined) document.getElementById('aa-folder').value = values.folder;
        if (values.isolation !== undefined) {
          document.getElementById('aa-isolation').value = values.isolation;
          aaIsolationChanged();
        }

        // Machine + project. A manifest from another context can name a
        // machine or project that isn't here — that is a review note, not a
        // refusal: the human picks one, nothing else about the import changes.
        const mSel = document.getElementById('aa-machine');
        const machineMatch = machines.find((m) => m.id === values.machineId) ??
          machines.find((m) => m.name === values.machine) ?? null;
        if (machineMatch) {
          mSel.value = machineMatch.id;
          aaPopulateProviders();
        } else if (values.machine || values.machineId) {
          notes.push(`machine ${esc(values.machine ?? values.machineId)} is not in this room right now — pick one`);
        }
        const pSel = document.getElementById('aa-project');
        const projectMatch = (latestView?.rooms ?? []).find((r) => r.id === values.projectId) ??
          (latestView?.rooms ?? []).find((r) => r.name === values.project) ?? null;
        if (projectMatch) pSel.value = projectMatch.id;
        else if (values.project || values.projectId) {
          notes.push(`project ${esc(values.project ?? values.projectId)} is not here — pick one`);
        }

        // Engine. The provider list belongs to the machine, so what the
        // manifest asks for is only a suggestion — the select offers what is
        // really installed, and anything else becomes a note.
        if (values.provider !== undefined && !mSel.disabled) {
          const pSel2 = document.getElementById('aa-provider');
          const has = [...pSel2.options].some((o) => o.value === values.provider && !o.disabled);
          if (has) {
            pSel2.value = values.provider;
            aaProviderChanged();
          } else {
            notes.push(`provider ${esc(values.provider)} is not available on this machine — pick one`);
          }
        }
        if (values.model !== undefined) {
          const modelSel = document.getElementById('aa-model');
          if ([...modelSel.options].some((o) => o.value === values.model)) {
            modelSel.value = values.model;
            aaRenderCommand();
          } else if (values.model) {
            notes.push(`model ${esc(values.model)} is not offered here — pick one`);
          }
        }
        if (values.bypassPermissions !== undefined) {
          document.getElementById('aa-bypass').checked = values.bypassPermissions;
          document.getElementById('aa-bypass').dispatchEvent(new Event('change'));
        }

        // Advanced + capabilities + briefing
        if (values.capabilities !== undefined) document.getElementById('aa-caps').value = values.capabilities.join(', ');
        if (values.cwd !== undefined) document.getElementById('aa-cwd').value = values.cwd;
        if (values.allowTools !== undefined) document.getElementById('aa-allow').value = values.allowTools.join(', ');
        if (values.denyPaths !== undefined) document.getElementById('aa-deny').value = values.denyPaths.join(', ');
        if (values.description !== undefined) document.getElementById('aa-description').value = values.description;
        if (values.goal !== undefined) document.getElementById('aa-goal').value = values.goal;

        if (ignored.length) notes.push(`ignored field${ignored.length > 1 ? 's' : ''} this version doesn't know: ${ignored.map(esc).join(', ')}`);
        aaShowStep('identity');
        aaImportNote(
          `<b>Imported ${esc(file.name)} — review every field.</b> Nothing is created until you press Create agent.` +
          (notes.length ? '<ul>' + notes.map((n) => '<li>' + n + '</li>').join('') + '</ul>' : ''));
    });
    document.getElementById('aa-machine').addEventListener('change', aaPopulateProviders);
    document.getElementById('aa-provider').addEventListener('change', aaProviderChanged);
    document.getElementById('aa-submit').addEventListener('click', aaSubmit);
    for (const b of document.querySelectorAll('.wiz-step'))
      b.addEventListener('click', () => aaShowStep(b.dataset.step));
    document.getElementById('aa-isolation').addEventListener('change', aaIsolationChanged);
    document.getElementById('aa-model').addEventListener('change', aaRenderCommand);
    document.getElementById('aa-bypass').addEventListener('change', aaRenderCommand);
    aaModal.addEventListener('click', (e) => { if (e.target === aaModal) aaModal.classList.remove('open'); });

    // ---------------- managing an agent (BROWSER2 Phase 1) ----------------
    // Edit, Note, Pause/Resume, Retire, Delete — all over HTTP, all re-rendered
    // from the server's broadcast. Draft state is kept across broadcasts so a
    // form that is being typed in does not lose focus when a view lands.
    const eaModal = document.getElementById('edit-agent-modal');
    const naModal = document.getElementById('note-agent-modal');
    let eaCharacter = null;
    let eaColor = null;

    function eaBuildPickers() {
      const grid = document.getElementById('ea-char');
      grid.innerHTML = '';
      for (const name of CHAR_NAMES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'char-opt' + (name === eaCharacter ? ' sel' : '');
        b.title = name;
        b.style.backgroundImage = `url(/assets/characters/${name}.png)`;
        b.style.backgroundSize = 'auto 72px';
        b.onclick = () => { eaCharacter = name; eaBuildPickers(); };
        grid.appendChild(b);
      }
      const sw = document.getElementById('ea-color');
      sw.innerHTML = '';
      for (const c of AGENT_COLORS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch' + (c === eaColor ? ' sel' : '');
        b.style.background = c;
        b.title = c;
        b.onclick = () => { eaColor = c; eaBuildPickers(); };
        sw.appendChild(b);
      }
    }

    window.openEditAgent = function () {
      const a = ccAgent();
      if (!a) return;
      document.getElementById('ea-name').value = a.name ?? '';
      document.getElementById('ea-role').value = a.role ?? 'developer';
      document.getElementById('ea-description').value = a.description ?? '';
      document.getElementById('ea-goal').value = a.goal ?? '';
      document.getElementById('ea-caps').value = (a.capabilities ?? []).join(', ');
      eaCharacter = a.character ?? CHAR_NAMES[0];
      eaColor = a.color ?? AGENT_COLORS[0];
      eaBuildPickers();
      document.getElementById('edit-agent-error').style.display = 'none';
      eaModal.classList.add('open');
    };

    window.openNoteDialog = function () {
      const a = ccAgent();
      if (!a) return;
      document.getElementById('na-note').value = a.note ?? '';
      document.getElementById('note-agent-error').style.display = 'none';
      naModal.classList.add('open');
      setTimeout(() => document.getElementById('na-note').focus(), 50);
    };

    async function postAgent(path, body, errEl) {
      errEl.style.display = 'none';
      try {
        const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          const msg = data.error || data.message || `request failed (${res.status})`;
          errEl.textContent = msg;
          errEl.style.display = 'block';
          return { ok: false };
        }
        return { ok: true, data };
      } catch (e) {
        errEl.textContent = e.message || 'could not reach server';
        errEl.style.display = 'block';
        return { ok: false };
      }
    }

    document.getElementById('ea-cancel')?.addEventListener('click', () => eaModal.classList.remove('open'));
    eaModal.addEventListener('click', (e) => { if (e.target === eaModal) eaModal.classList.remove('open'); });
    document.getElementById('ea-save')?.addEventListener('click', async () => {
      const a = ccAgent();
      if (!a) return;
      const errEl = document.getElementById('edit-agent-error');
      const caps = document.getElementById('ea-caps').value.split(',').map((s) => s.trim()).filter(Boolean);
      const body = {
        name: document.getElementById('ea-name').value.trim(),
        role: document.getElementById('ea-role').value,
        character: eaCharacter,
        color: eaColor,
        description: document.getElementById('ea-description').value.trim() || null,
        goal: document.getElementById('ea-goal').value.trim() || null,
        capabilities: caps,
      };
      if (!body.name) { errEl.textContent = 'Name is required.'; errEl.style.display = 'block'; return; }
      const res = await postAgent(`/api/agents/${a.id}/edit`, { agentId: a.id, ...body }, errEl);
      if (res.ok) eaModal.classList.remove('open');
    });

    document.getElementById('na-cancel')?.addEventListener('click', () => naModal.classList.remove('open'));
    naModal.addEventListener('click', (e) => { if (e.target === naModal) naModal.classList.remove('open'); });
    document.getElementById('na-save')?.addEventListener('click', async () => {
      const a = ccAgent();
      if (!a) return;
      const errEl = document.getElementById('note-agent-error');
      const note = document.getElementById('na-note').value;
      const res = await postAgent(`/api/agents/${a.id}/note`, { agentId: a.id, note }, errEl);
      if (res.ok) naModal.classList.remove('open');
    });

    window.togglePause = async function () {
      const a = ccAgent();
      if (!a) return;
      const errEl = document.getElementById('cc-manage-err');
      const isPaused = a.status === 'paused' || a.paused;
      const path = isPaused ? `/api/agents/${a.id}/resume` : `/api/agents/${a.id}/pause`;
      const res = await postAgent(path, { agentId: a.id }, errEl);
      if (!res.ok && errEl.textContent.includes('404')) {
        errEl.textContent = 'Pause not available yet — server has no pause endpoint.';
        errEl.style.display = 'block';
      }
    };

    window.retireAgent = async function () {
      const a = ccAgent();
      if (!a) return;
      const errEl = document.getElementById('cc-manage-err');
      const res = await postAgent(`/api/agents/${a.id}/retire`, { agentId: a.id }, errEl);
      if (!res.ok && errEl.textContent.includes('404')) {
        errEl.textContent = 'Retire not available yet.';
        errEl.style.display = 'block';
      }
    };

    window.deleteAgent = async function () {
      const a = ccAgent();
      if (!a) return;
      const errEl = document.getElementById('cc-manage-err');
      // Count memories for the confirm: whatever Stream B decided, say it
      const memCount = (latestView?.rooms?.[0]?.memories ?? []).filter((m) => m.agentName === a.name).length;
      const keep = true; // we don't know; say kept, and note the uncertainty
      const msg = `Delete ${a.name}? This agent's ${memCount} memories will be kept (server decides). This cannot be undone.`;
      if (!confirm(msg)) return;
      const res = await postAgent(`/api/agents/${a.id}/delete`, { agentId: a.id }, errEl);
      if (!res.ok && errEl.textContent.includes('404')) {
        errEl.textContent = 'Delete not available yet — server has no delete endpoint.';
        errEl.style.display = 'block';
      } else if (res.ok) {
        setView('agents');
      }
    };

    // Keep pause button label in sync with the broadcast
    const origRenderCC = renderCommandCenter;
    window.renderCommandCenter = function () {
      origRenderCC();
      const a = ccAgent();
      const btn = document.getElementById('cc-pause-btn');
      if (btn && a) {
        const isPaused = a.status === 'paused' || a.paused;
        btn.textContent = isPaused ? 'Resume' : 'Pause';
      }
    };

    // ---------------- bottom strip ----------------
    function renderCurrentTask(room) {
      const busy = room.agents.find((a) => a.task);
      document.getElementById('ct-empty').style.display = busy ? 'none' : 'block';
      document.getElementById('ct-body').style.display = busy ? 'block' : 'none';
      if (!busy) return;
      document.getElementById('ct-id').textContent = busy.task.id.slice(0, 10).toUpperCase();
      document.getElementById('ct-name').textContent = busy.task.title;
      document.getElementById('ct-agent').textContent = busy.name;
      document.getElementById('ct-elapsed').textContent = formatElapsed(busy.task.elapsedSec);

      // The agent's own last line, and the number of step boundaries its CLI
      // has reported. Both come from the server (invariant 2) — the browser
      // never infers what an agent is up to.
      const note = document.getElementById('ct-note');
      note.textContent = busy.task.note ?? '';
      note.style.display = busy.task.note ? 'block' : 'none';

      const steps = busy.task.steps ?? 0;
      document.getElementById('ct-steps').textContent = steps > 0 ? String(steps) : '—';

      // The bar is elapsed-vs-budget, NOT completion. Step count is a count
      // precisely because no provider reports a total, so there is still no
      // honest denominator to fill a bar with.
      const pct = Math.min(100, Math.round((busy.task.elapsedSec / 60) * 100));
      document.getElementById('ct-bar').style.width = pct + '%';
      const stepPart = steps > 0 ? ` · step ${steps}` : '';
      document.getElementById('ct-state').textContent =
        'Running' + stepPart + ' · ' + formatElapsed(busy.task.elapsedSec) + ' elapsed';
    }

    // The feed comes from room.activity — the server projects the event log
    // into wording (see activity.ts), so the browser only renders. Previously
    // this was inferred from recent tasks, which could only ever say "a task
    // changed state" and never "the lease expired" or "it learned something".
    const FEED_TINT = {
      'task.result': 'var(--blue)', 'task.assigned': 'var(--accent)',
      'task.accept': 'var(--green)', 'memory.write': 'var(--purple)',
      'lease.expired': 'var(--red)', 'task.late_result': 'var(--orange)',
      'human.answer': 'var(--accent)', 'task.cancel': 'var(--red)',
    };

    function renderFeed(room) {
      const el = document.getElementById('feed');
      el.innerHTML = '';
      const items = room.activity ?? [];
      if (!items.length) {
        el.innerHTML = '<div class="empty-note" style="padding:12px 0;">Nothing has happened yet.</div>';
        return;
      }
      for (const a of items.slice(0, 12)) {
        const row = document.createElement('div');
        row.className = 'feed-row';

        const av = document.createElement('div');
        av.className = 'av';
        av.style.background = FEED_TINT[a.type] ?? 'var(--gray)';
        av.style.fontSize = '11px';
        av.textContent = a.actor ? a.actor[0].toUpperCase() : '•';

        const main = document.createElement('div');
        main.className = 'feed-main';
        const who = document.createElement('div');
        who.className = 'feed-who';
        who.textContent = a.actor ?? 'System';
        const what = document.createElement('div');
        what.className = 'feed-what';
        what.textContent = a.summary;      // server-authored, still textContent
        main.append(who, what);

        const when = document.createElement('div');
        when.className = 'feed-when';
        when.textContent = relativeTime(a.ts);

        row.append(av, main, when);
        row.title = a.summary;
        el.appendChild(row);
      }
    }

    // ---------------- chat ----------------
    // History replays from the server on connect (last 50, prompt 8a);
    // anything older stays in the event log rather than the browser.
    const chatLog = [];
    let unreadChat = 0;
    const answeredChoice = new Map();

    function renderChat() {
      const log = document.getElementById('chat-log');
      log.innerHTML = '';
      if (!chatLog.length) {
        log.innerHTML = '<div class="empty-note">No messages yet. Say something, or @mention an agent.</div>';
        return;
      }
      for (const m of chatLog) {
        const wrap = document.createElement('div');
        wrap.className = 'chat-msg' + (m.ask ? ' ask' : '');
        const main = document.createElement('div');
        main.className = 'chat-main';
        const from = document.createElement('div');
        from.className = 'chat-from' + (m.from.kind === 'agent' ? ' agent' : '');
        from.textContent = m.from.name;
        const body = document.createElement('div');
        body.className = 'chat-body';
        body.textContent = m.text;              // never innerHTML
        main.append(from, body);
        wrap.append(avatarFor(m.from.name, m.from.kind === 'agent'), main);

        if (m.ask) {
          if (answeredChoice.has(m.ask.taskId)) {
            const d = document.createElement('div');
            d.className = 'chat-resolved';
            d.textContent = `You chose: ${answeredChoice.get(m.ask.taskId)}`;
            body.appendChild(d);
          } else {
            const acts = document.createElement('div');
            acts.className = 'chat-actions';
            for (const c of m.ask.options) {
              if (c === 'answer') {
                // A mid-task question wants WORDS, not a button — inline
                // reply field. Enter sends; the field disables on answer.
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;gap:8px;margin-top:10px;width:100%';
                const inp = document.createElement('input');
                inp.placeholder = 'Type your answer…';
                inp.style.cssText = 'flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:12.5px;background:var(--surface-2);color:var(--text)';
                const send = document.createElement('button');
                send.className = 'btn-approve';
                send.textContent = 'Reply';
                const go = () => {
                  if (!inp.value.trim()) return;
                  answerAsk(m.ask.taskId, 'answer', inp.value.trim());
                  inp.disabled = true; send.disabled = true;
                };
                send.onclick = go;
                inp.onkeydown = (e) => { if (e.key === 'Enter') go(); };
                row.append(inp, send);
                acts.appendChild(row);
              } else if (c === 'edit') {
                const b = document.createElement('button');
                b.className = 'btn-reject';
                b.textContent = '✎ Edit';
                b.onclick = () => {
                  // Swap the actions row for an inline editor pre-filled with
                  // the proposed text (the part after "Proposed: \"").
                  const current = (m.text.match(/Proposed: "(.*)"\.?/) || [])[1] ?? '';
                  acts.style.display = 'none';
                  const editor = document.createElement('div');
                  editor.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:10px;width:100%';
                  const inp = document.createElement('input');
                  inp.value = current;
                  inp.style.cssText = 'width:100%;padding:8px 12px;border:1px solid var(--accent);border-radius:8px;font-family:inherit;font-size:12.5px;background:var(--surface-2);color:var(--text);box-sizing:border-box';
                  const row = document.createElement('div');
                  row.style.cssText = 'display:flex;gap:8px';
                  const save = document.createElement('button');
                  save.className = 'btn-approve';
                  save.textContent = 'Save & re-propose';
                  save.onclick = () => {
                    if (!inp.value.trim()) return;
                    answerAsk(m.ask.taskId, 'edit', inp.value.trim());
                    editor.remove();
                    acts.style.display = '';
                  };
                  const cancelBtn = document.createElement('button');
                  cancelBtn.className = 'btn-reject';
                  cancelBtn.textContent = 'Cancel';
                  cancelBtn.onclick = () => { editor.remove(); acts.style.display = ''; };
                  row.append(save, cancelBtn);
                  editor.append(inp, row);
                  body.appendChild(editor);
                  inp.focus();
                };
                acts.appendChild(b);
              } else {
                const b = document.createElement('button');
                b.className = c === 'approve' ? 'btn-approve' : 'btn-reject';
                b.textContent = c === 'approve' ? '✓ Approve' : 'Reject';
                b.onclick = () => answerAsk(m.ask.taskId, c);
                acts.appendChild(b);
              }
            }
            body.appendChild(acts);
          }
        }
        log.appendChild(wrap);
      }
      log.scrollTop = log.scrollHeight;
    }

    function answerAsk(taskId, choice, text) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'answer', taskId, choice, ...(text ? { text } : {}) }));
      answeredChoice.set(taskId, choice + (text ? `: "${text}"` : ''));
      renderChat();
    }

    window.sendChat = function () {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      const room = activeRoom();
      if (!text || !room || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'chat', roomId: room.id, text }));
      input.value = '';
      closeMentionPopup();
    };

    // ---------------- @mention autocomplete ----------------
    // Typing "@" in the chat box, mid-word or at the start, pops a filtered
    // list of the room's agents and people — same idea as this app's own
    // "@" file/agent picker, just scoped to who's actually in the room.
    let mentionState = { open: false, items: [], activeIndex: 0, atIdx: -1 };

    function mentionCandidates(room, fragment) {
      if (!room) return [];
      const frag = fragment.toLowerCase();
      const agents = (room.agents || []).map((a) => ({
        id: a.id, name: a.name, bot: true, status: a.status,
        sub: a.status || a.role || '',
      }));
      const people = (room.humans || [])
        .filter((h) => h.id !== meId)
        .map((h) => ({ id: h.id, name: h.name, bot: false, status: 'online', sub: 'online' }));
      const all = [...agents, ...people];
      if (!frag) return all;
      // Prefix matches first (the common case — typing the start of a
      // name), then anywhere-in-the-name matches, so a fragment like
      // "fake" still finds "dev-fake" without prefix matches getting
      // buried under it.
      const starts = all.filter((c) => c.name.toLowerCase().startsWith(frag));
      const contains = all.filter((c) => !c.name.toLowerCase().startsWith(frag) && c.name.toLowerCase().includes(frag));
      return [...starts, ...contains];
    }

    /** Find the "@token" the caret is currently inside, if any. Only counts
     *  as a mention when the "@" starts a word (line start or preceded by
     *  whitespace) — "a@b" typing an email-shaped thing does not trigger
     *  it — and nothing after the "@" up to the caret is whitespace. */
    function activeMentionToken(value, caret) {
      let i = caret - 1;
      while (i >= 0 && !/\s/.test(value[i])) i--;
      const tokenStart = i + 1;
      if (value[tokenStart] !== '@') return null;
      if (tokenStart > 0 && !/\s/.test(value[tokenStart - 1])) return null;
      return { atIdx: tokenStart, fragment: value.slice(tokenStart + 1, caret) };
    }

    function updateMentionPopup() {
      const input = document.getElementById('chat-input');
      const token = activeMentionToken(input.value, input.selectionStart ?? input.value.length);
      if (!token) { closeMentionPopup(); return; }
      const items = mentionCandidates(activeRoom(), token.fragment).slice(0, 8);
      mentionState = { open: true, items, activeIndex: 0, atIdx: token.atIdx };
      renderMentionPopup();
    }

    function renderMentionPopup() {
      const pop = document.getElementById('chat-mention-popup');
      if (!mentionState.open) { pop.style.display = 'none'; return; }
      pop.innerHTML = '';
      if (!mentionState.items.length) {
        pop.innerHTML = '<div class="chat-mention-empty">No match</div>';
      } else {
        mentionState.items.forEach((it, idx) => {
          const row = document.createElement('div');
          row.className = 'chat-mention-item' + (idx === mentionState.activeIndex ? ' active' : '');
          const av = document.createElement('div');
          av.className = 'chat-mention-avatar';
          av.textContent = it.bot ? '🤖' : (it.name[0] ?? '?').toUpperCase();
          const name = document.createElement('div');
          name.className = 'chat-mention-name';
          name.textContent = it.name;
          const sub = document.createElement('div');
          // Tint the status the same way every other surface does.
          const TINT = { working: 's-working', reviewing: 's-reviewing', collaborating: 's-reviewing',
                         needs_input: 's-needs', blocked: 's-blocked', idle: 's-idle', done: 's-done' };
          sub.className = 'chat-mention-sub ' + (TINT[it.status] || '');
          sub.textContent = String(it.sub ?? '').replace(/_/g, ' ');
          row.append(av, name, sub);
          // mousedown, not click: fires before the input's blur, so the
          // selection lands before anything closes the popup out from
          // under it.
          row.onmousedown = (e) => { e.preventDefault(); selectMention(idx); };
          pop.appendChild(row);
        });
      }
      pop.style.display = 'block';
    }

    function selectMention(idx) {
      const input = document.getElementById('chat-input');
      const it = mentionState.items[idx];
      if (!it) return;
      const { atIdx } = mentionState;
      const before = input.value.slice(0, atIdx);
      const after = input.value.slice(input.selectionStart ?? input.value.length);
      const inserted = `@${it.name} `;
      input.value = before + inserted + after;
      const caret = (before + inserted).length;
      input.setSelectionRange(caret, caret);
      closeMentionPopup();
      input.focus();
    }

    function closeMentionPopup() {
      mentionState = { open: false, items: [], activeIndex: 0, atIdx: -1 };
      const pop = document.getElementById('chat-mention-popup');
      if (pop) pop.style.display = 'none';
    }

    /** Called from the global keydown handler for #chat-input, before Enter
     *  is allowed to fall through to sendChat. Returns true when it
     *  consumed the key (caller must preventDefault and stop there). */
    function handleMentionKeydown(e) {
      if (!mentionState.open) return false;
      const n = mentionState.items.length;
      if (e.key === 'ArrowDown') {
        if (n) mentionState.activeIndex = (mentionState.activeIndex + 1) % n;
        renderMentionPopup();
        return true;
      }
      if (e.key === 'ArrowUp') {
        if (n) mentionState.activeIndex = (mentionState.activeIndex - 1 + n) % n;
        renderMentionPopup();
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (n) selectMention(mentionState.activeIndex);
        else closeMentionPopup();
        return true;
      }
      if (e.key === 'Escape') { closeMentionPopup(); return true; }
      return false;
    }

    function onChatMessage(msg) {
      // The server scopes chat by room now (it tracks what we `join`ed), so
      // this is a backstop for an in-flight message that crosses a room
      // switch — not the mechanism.
      const room = activeRoom();
      if (room && msg.roomId && msg.roomId !== room.id) return;
      chatLog.push(msg);
      if (chatLog.length > 200) chatLog.shift();
      if (currentView === 'chat') { renderChat(); return; }
      unreadChat++;
      const c = document.getElementById('chat-count');
      c.textContent = unreadChat > 9 ? '9+' : String(unreadChat);
      c.classList.add('show');
    }

    // ---------------- Spatial Private Room Comms & WebRTC Voice (Gather.town style) ----------------
    let currentRoomZone = null;
    let lastChimeZone = null;

    const PRIVATE_ROOMS = {
      'cabin0': { name: '★ Boss Executive Cabin', icon: '👔', rect: () => zones.cabin[0] },
      'cabin1': { name: 'Senior Cabin 1', icon: '🔒', rect: () => zones.cabin[1] },
      'cabin2': { name: 'Senior Cabin 2', icon: '🔒', rect: () => zones.cabin[2] },
      'cabin3': { name: 'Senior Cabin 3', icon: '🔒', rect: () => zones.cabin[3] },
      'collaborating': { name: 'Executive Meeting Room', icon: '🤝', rect: () => zones.collaborating },
    };

    // WebRTC & Audio State
    let localAudioStream = null;
    let isMicLive = false;
    let localAudioContext = null;
    let localAnalyser = null;
    let isLocalSpeaking = false;
    const peerConnections = new Map(); // targetUserId -> RTCPeerConnection
    const peerAudioElements = new Map(); // targetUserId -> HTMLAudioElement
    const peerAnalysers = new Map(); // targetUserId -> { analyser, isSpeaking }

    const RTC_CONFIG = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };

    window.toggleRoomMic = async function () {
      if (!currentRoomZone) return;

      if (!localAudioStream) {
        try {
          localAudioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          setupLocalAudioAnalyser(localAudioStream);
        } catch (err) {
          console.warn("Microphone access failed/denied:", err);
          alert("Microphone permission required to speak. Please allow microphone access in your browser settings.");
          return;
        }
      }

      isMicLive = !isMicLive;
      localAudioStream.getAudioTracks().forEach((track) => {
        track.enabled = isMicLive;
      });

      updateMicUi();

      // Ensure local tracks are added to existing peer connections
      for (const [targetUserId, pc] of peerConnections) {
        const senders = pc.getSenders();
        const audioTrack = localAudioStream.getAudioTracks()[0];
        if (audioTrack) {
          const sender = senders.find((s) => s.track && s.track.kind === 'audio');
          if (sender) {
            sender.replaceTrack(audioTrack);
          } else {
            pc.addTrack(audioTrack, localAudioStream);
            renegotiatePeer(targetUserId, pc);
          }
        }
      }

      if (isMicLive) {
        syncRoomVoicePeers();
      }
    };

    function updateMicUi() {
      const btn = document.getElementById('btn-room-mic');
      const icon = document.getElementById('mic-status-icon');
      const label = document.getElementById('mic-status-label');
      const meter = document.getElementById('mic-level-meter');

      if (!btn) return;
      if (isMicLive) {
        btn.style.background = 'rgba(34, 197, 94, 0.22)';
        btn.style.borderColor = 'rgba(34, 197, 94, 0.55)';
        btn.style.color = 'var(--st-working)';
        if (icon) icon.textContent = '🎙️';
        if (label) label.textContent = 'Mic: Live';
        if (meter) meter.style.display = 'flex';
      } else {
        btn.style.background = 'rgba(221,85,75, 0.18)';
        btn.style.borderColor = 'rgba(221,85,75, 0.4)';
        btn.style.color = 'var(--st-fail)';
        if (icon) icon.textContent = '🔇';
        if (label) label.textContent = 'Mic: Muted';
        if (meter) meter.style.display = 'none';
      }
    }

    function setupLocalAudioAnalyser(stream) {
      try {
        localAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        const source = localAudioContext.createMediaStreamSource(stream);
        localAnalyser = localAudioContext.createAnalyser();
        localAnalyser.fftSize = 256;
        source.connect(localAnalyser);

        const dataArray = new Uint8Array(localAnalyser.frequencyBinCount);
        const checkVolume = () => {
          if (!currentRoomZone) {
            isLocalSpeaking = false;
            return;
          }
          if (isMicLive && localAnalyser) {
            localAnalyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            const avg = sum / dataArray.length;
            isLocalSpeaking = avg > 14;

            // Animate HUD bars
            const bars = document.querySelectorAll('.mic-bar');
            if (bars && bars.length === 3) {
              const h1 = Math.min(14, Math.max(3, (avg / 255) * 24));
              const h2 = Math.min(14, Math.max(3, (avg / 255) * 32));
              const h3 = Math.min(14, Math.max(3, (avg / 255) * 20));
              bars[0].style.height = `${h1}px`;
              bars[1].style.height = `${h2}px`;
              bars[2].style.height = `${h3}px`;
            }
          } else {
            isLocalSpeaking = false;
          }
          requestAnimationFrame(checkVolume);
        };
        requestAnimationFrame(checkVolume);
      } catch (e) {
        console.warn("Local audio context error:", e);
      }
    }

    function playRoomChime() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } catch {}
    }

    function showSpeechBubble(bubbleObj, text, durationMs = 6000) {
      if (!bubbleObj) return;
      const { container, bg, label } = bubbleObj;
      label.text = truncate(text, 50);
      label.style.fill = '#ffffff';
      label.style.fontSize = 10;
      label.style.fontWeight = '700';

      const padX = 10, padY = 5;
      const w = Math.max(label.width + padX * 2, 42);
      const h = label.height + padY * 2;
      const lift = 46;

      bg.clear();
      bg.beginFill(0x1e1b4b, 0.95);
      bg.lineStyle(1.5, 0x6366f1, 0.95);
      bg.drawRoundedRect(-w / 2, -lift - h / 2, w, h, 8);
      bg.moveTo(-4, -lift + h / 2);
      bg.lineTo(0, -lift + h / 2 + 5);
      bg.lineTo(4, -lift + h / 2);
      bg.endFill();

      label.x = 0;
      label.y = -lift;
      container.visible = true;

      if (bubbleObj._timer) clearTimeout(bubbleObj._timer);
      bubbleObj._timer = setTimeout(() => {
        container.visible = false;
      }, durationMs);
    }

    function getOccupantsInZone(zone) {
      const roomInfo = PRIVATE_ROOMS[zone];
      if (!roomInfo) return [];
      const rect = roomInfo.rect();
      const room = activeRoom();
      const occupants = [];
      if (rect && room?.humans) {
        for (const h of room.humans) {
          if (!h.position) continue;
          if (h.position.x >= rect.x && h.position.x < rect.x + rect.w &&
              h.position.y >= rect.y && h.position.y < rect.y + rect.h) {
            occupants.push(h);
          }
        }
      }
      return occupants;
    }

    function syncRoomVoicePeers() {
      if (!currentRoomZone || !ws || ws.readyState !== WebSocket.OPEN) return;
      const room = activeRoom();
      if (!room) return;

      const myId = currentUser?.id || meId || 'you';
      const occupants = getOccupantsInZone(currentRoomZone);
      const occupantIds = new Set(occupants.map((o) => o.id));

      // Close peers who stepped out
      for (const [targetUserId, pc] of peerConnections) {
        if (!occupantIds.has(targetUserId)) {
          pc.close();
          peerConnections.delete(targetUserId);
          const audioEl = peerAudioElements.get(targetUserId);
          if (audioEl) { audioEl.remove(); peerAudioElements.delete(targetUserId); }
          peerAnalysers.delete(targetUserId);
        }
      }

      // Connect to other occupants currently in the room
      for (const occ of occupants) {
        if (occ.id === myId) continue;
        if (!peerConnections.has(occ.id)) {
          const shouldCreateOffer = myId < occ.id;
          createPeerConnection(occ.id, shouldCreateOffer);
        }
      }
    }

    function createPeerConnection(targetUserId, shouldCreateOffer) {
      const room = activeRoom();
      if (!room) return;
      const myId = currentUser?.id || meId || 'you';

      const pc = new RTCPeerConnection(RTC_CONFIG);
      peerConnections.set(targetUserId, pc);

      if (localAudioStream) {
        for (const track of localAudioStream.getAudioTracks()) {
          pc.addTrack(track, localAudioStream);
        }
      }

      pc.onicecandidate = (e) => {
        if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'webrtc_signal',
            roomId: room.id,
            fromUserId: myId,
            targetUserId,
            signal: { candidate: e.candidate },
          }));
        }
      };

      pc.ontrack = (e) => {
        const remoteStream = e.streams[0];
        let audioEl = peerAudioElements.get(targetUserId);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          document.body.appendChild(audioEl);
          peerAudioElements.set(targetUserId, audioEl);
        }
        audioEl.srcObject = remoteStream;
        setupRemoteAudioAnalyser(targetUserId, remoteStream);
      };

      if (shouldCreateOffer) {
        renegotiatePeer(targetUserId, pc);
      }
    }

    async function renegotiatePeer(targetUserId, pc) {
      const room = activeRoom();
      if (!room) return;
      const myId = currentUser?.id || meId || 'you';
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'webrtc_signal',
            roomId: room.id,
            fromUserId: myId,
            targetUserId,
            signal: { sdp: pc.localDescription },
          }));
        }
      } catch (err) {
        console.warn("WebRTC renegotiation error:", err);
      }
    }

    window.handleWebRtcSignal = async function (msg) {
      const { fromUserId, signal } = msg;
      if (!currentRoomZone) return;
      const room = activeRoom();
      if (!room) return;
      const myId = currentUser?.id || meId || 'you';

      let pc = peerConnections.get(fromUserId);
      if (!pc) {
        createPeerConnection(fromUserId, false);
        pc = peerConnections.get(fromUserId);
      }
      if (!pc) return;

      try {
        if (signal.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          if (signal.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(JSON.stringify({
              type: 'webrtc_signal',
              roomId: room.id,
              fromUserId: myId,
              targetUserId: fromUserId,
              signal: { sdp: pc.localDescription },
            }));
          }
        } else if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (err) {
        console.warn("WebRTC signal processing error:", err);
      }
    };

    function setupRemoteAudioAnalyser(targetUserId, stream) {
      try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const state = { analyser, isSpeaking: false };
        peerAnalysers.set(targetUserId, state);

        const checkVolume = () => {
          if (!peerConnections.has(targetUserId)) return;
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          const avg = sum / dataArray.length;
          state.isSpeaking = avg > 14;
          requestAnimationFrame(checkVolume);
        };
        requestAnimationFrame(checkVolume);
      } catch (e) {
        console.warn("Remote audio analyser error:", e);
      }
    }

    function cleanupRoomVoice() {
      for (const [id, pc] of peerConnections) {
        pc.close();
      }
      peerConnections.clear();
      for (const [id, audioEl] of peerAudioElements) {
        audioEl.remove();
      }
      peerAudioElements.clear();
      peerAnalysers.clear();
      isLocalSpeaking = false;
      isMicLive = false;
      if (localAudioStream) {
        localAudioStream.getAudioTracks().forEach((track) => { track.enabled = false; });
      }
      updateMicUi();
    }

    function updateSpatialRoomComms() {
      if (typeof detectZoneName !== 'function') return;
      const zone = detectZoneName(player.x, player.y);
      const commsBar = document.getElementById('room-comms-bar');
      if (!commsBar) return;

      if (PRIVATE_ROOMS[zone]) {
        const roomInfo = PRIVATE_ROOMS[zone];
        currentRoomZone = zone;
        commsBar.style.display = 'flex';

        if (lastChimeZone !== zone) {
          lastChimeZone = zone;
          playRoomChime();
        }

        const iconEl = document.getElementById('room-comms-icon');
        const titleEl = document.getElementById('room-comms-title');
        if (iconEl) iconEl.textContent = roomInfo.icon;
        if (titleEl) titleEl.textContent = `${roomInfo.name} (Private Channel)`;

        const myName = currentUser?.name || 'You';
        const myId = currentUser?.id || meId || 'you';
        const occupants = getOccupantsInZone(zone);

        const occEl = document.getElementById('room-comms-occupants');
        if (occEl) {
          if (occupants.length > 1) {
            const occupantChips = occupants.map((h) => {
              const isSelf = h.id === myId;
              const isSpeaking = isSelf ? isLocalSpeaking : (peerAnalysers.get(h.id)?.isSpeaking ?? false);
              const name = isSelf ? 'You' : (h.name || 'Colleague');
              const micBadge = isSpeaking ? '🔊 <b style="color:var(--st-working);">(Speaking...)</b>' : (isSelf ? (isMicLive ? '🎙️' : '🔇') : '🎙️');
              return `${name} ${micBadge}`;
            });
            occEl.innerHTML = `<span style="color:var(--st-working);font-weight:600;">🟢 ${occupants.length} in Room:</span> ${occupantChips.join(', ')}`;
          } else {
            occEl.innerHTML = `<span style="color:var(--text-dim);">🟢 You are in this room.</span> Others who enter will connect to voice & chat automatically.`;
          }
        }

        // Sync mesh peer connections for voice
        syncRoomVoicePeers();
      } else {
        if (currentRoomZone) {
          cleanupRoomVoice();
        }
        currentRoomZone = null;
        lastChimeZone = null;
        commsBar.style.display = 'none';
      }
    }

    window.sendRoomMessage = function (e) {
      if (e) e.preventDefault();
      const input = document.getElementById('room-comms-input');
      const text = input?.value?.trim();
      if (!text || !currentRoomZone) return;
      input.value = '';

      const room = activeRoom();
      if (!room) return;

      const myId = currentUser?.id || meId || 'you';
      const myName = currentUser?.name || 'You';

      ws.send(JSON.stringify({
        type: 'room_chat',
        roomId: room.id,
        zone: currentRoomZone,
        text,
        from: {
          id: myId,
          name: myName,
        },
      }));

      if (playerBubble) showSpeechBubble(playerBubble, text);
      appendInRoomMessage(myName, text, true);
    };

    window.leavePrivateRoom = function () {
      player.x = 40 * TILE;
      player.y = 15 * TILE;
      sendPosition();
      cleanupRoomVoice();
      updateSpatialRoomComms();
    };

    function appendInRoomMessage(sender, text, isSelf = false) {
      const box = document.getElementById('room-comms-messages');
      if (!box) return;
      const line = document.createElement('div');
      line.style.cssText = 'padding:2px 0;line-height:1.4;';
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      line.innerHTML = `<span style="color:${isSelf ? 'var(--accent)' : 'var(--st-reviewing)'};font-weight:600;">${escapeHtml(sender)}</span> <span style="font-size:10px;color:#64748b;">${timeStr}</span>: <span>${escapeHtml(text)}</span>`;
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
    }

    function onRoomChatMessage(roomMsg) {
      if (currentRoomZone && currentRoomZone === roomMsg.zone) {
        appendInRoomMessage(roomMsg.from.name, roomMsg.text, roomMsg.from.id === (currentUser?.id || meId));
        playRoomChime();

        if (roomMsg.from.id === (currentUser?.id || meId)) {
          if (playerBubble) showSpeechBubble(playerBubble, roomMsg.text);
        } else {
          const entry = renderedHumans.get(roomMsg.from.id);
          if (entry && entry.bubble) {
            showSpeechBubble(entry.bubble, roomMsg.text);
          }
        }
      }
    }


    function makeNameTag(text, color) {
      const t = new PIXI.Text(text, {
        fontFamily: 'Outfit, sans-serif', fontSize: 9, fontWeight: '600', fill: color,
        dropShadow: true, dropShadowColor: 0x000000, dropShadowDistance: 1, dropShadowBlur: 2,
        // Text lives inside worldContainer, which zooms 0.6–2.5x. Rasterized
        // once at scale 1 it turns to mush the moment someone zooms in —
        // render the glyphs oversized instead and let the GPU downscale.
        resolution: 3,
      });
      t.anchor.set(0.5, 2.5);
      return t;
    }

    // Speech bubble above a working agent. Created once per agent, shown/
    // hidden as tasks come and go — never re-created per frame.
    function makeBubble() {
      const container = new PIXI.Container();
      const bg = new PIXI.Graphics();
      const label = new PIXI.Text('', {
        fontFamily: 'Outfit, sans-serif', fontSize: 9, fontWeight: '600',
        fill: 0xf0f4fc, wordWrap: false, resolution: 3,
      });
      label.anchor.set(0.5, 0.5);
      container.addChild(bg, label);
      container.visible = false;
      return { container, bg, label };
    }

    function truncate(s, n) {
      s = String(s ?? '');
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    // Agents clustered together (desk pods pack three per rect) would draw
    // their bubbles on top of each other. Assign each working agent a stack
    // LEVEL: how many already-levelled colleagues stand within ~1 tile of it.
    // Iterating in server-slot order makes the assignment stable across
    // updates — contract invariant #3, applied to bubbles. Levels raise the
    // bubble upward, so a pod reads as a little totem instead of a smear.
    function computeBubbleLevels(room) {
      const workers = room.agents.filter((a) => a.task);
      const positions = new Map(workers.map((a) => [a.id, positionForAgent(a)]));
      const levels = new Map();
      for (const a of workers) {
        const p = positions.get(a.id);
        let level = 0;
        for (const [otherId, q] of positions) {
          if (otherId === a.id) continue;
          const done = levels.get(otherId);
          if (done == null || done < level) continue;
          if (Math.abs(p.x - q.x) < TILE * 1.8 && Math.abs(p.y - q.y) < TILE * 1.8) level = done + 1;
        }
        levels.set(a.id, Math.min(level, 3));
      }
      return levels;
    }

    function createAgentSprite(a) {
      // The agent's chosen sprite, when it has one. The hash stays as the
      // fallback rather than a fixed default, so agents created before the
      // picker existed still look different from each other — and a name
      // whose sheet is missing falls back too, instead of rendering nothing.
      const chosen = a.character && charTextures[a.character] ? a.character : null;
      const charName = chosen ?? CHAR_NAMES[hashString(a.id) % CHAR_NAMES.length];
      const frames = charTextures[charName] || charTextures.nancy;
      const sprite = new PIXI.Sprite(frames[DIR_FRAMES.idle.down[0]]);
      sprite.anchor.set(0.5, 0.75);
      sprite.interactive = true;
      sprite.cursor = 'pointer';
      sprite.on('pointerdown', (e) => {
        // stopPropagation() only stops PIXI's OWN federated event — the DOM
        // pointerdown underneath keeps bubbling from the canvas to window,
        // where the outside-click handler would close the card this click
        // just opened. Marking the native event is what actually tells that
        // handler "this click was on an agent".
        e.stopPropagation();
        if (e.nativeEvent) e.nativeEvent.__agentSpriteClick = true;
        inspectAgent(a);
      });
      const tag = makeNameTag(a.name, 0x00e5ff);
      sprite.addChild(tag);
      const dot = new PIXI.Graphics();
      sprite.addChild(dot);
      const bubble = makeBubble();
      sprite.addChild(bubble.container);
      worldContainer.addChild(sprite);
      const entry = { sprite, tag, dot, bubble, char: charName, direction: 'down', animTimer: 0, frameIdx: 0 };
      renderedAgents.set(a.id, entry);
      return entry;
    }

    function createHumanSprite(h) {
      const charName = CHAR_NAMES[h.avatar % CHAR_NAMES.length];
      const frames = charTextures[charName] || charTextures.nancy;
      const sprite = new PIXI.Sprite(frames[DIR_FRAMES.idle.down[0]]);
      sprite.anchor.set(0.5, 0.75);
      const voiceRing = new PIXI.Graphics();
      sprite.addChild(voiceRing);
      const tag = makeNameTag(h.name, 0xffffff);
      sprite.addChild(tag);
      const bubble = makeBubble();
      sprite.addChild(bubble.container);
      worldContainer.addChild(sprite);
      const entry = { sprite, tag, bubble, voiceRing };
      renderedHumans.set(h.id, entry);
      return entry;
    }

    function updateAgentSprite(entry, a) {
      // Idle agents roam: deterministic waypoint inside the idle zone, derived
      // from (agentId, sharedClock). Non-idle agents are placed exactly on
      // their slot so work always wins over wandering.
      const pos = positionForAgentWithRoaming(a);
      entry.target = pos;
      entry.tag.text = a.name;
      entry.color = STATUS_COLOR[a.status] ?? 0x8a99b5;
      entry.dot.clear();
      entry.dot.beginFill(entry.color).drawCircle(10, -34, 3).endFill();
      drawBubble(entry, a);
      const wasIdle = entry.data?.zone === 'idle';
      const nowWorking = a.zone !== 'idle';
      entry.data = a;
      if (entry.sprite.x === 0 && entry.sprite.y === 0) { entry.sprite.x = pos.x; entry.sprite.y = pos.y; }
      // Spec: "an agent that stops being idle returns to its real placement
      // immediately". Don't ease a working agent out of the cafeteria — snap it
      // so the office never shows a working agent wandering in the idle zone.
      if (wasIdle && nowWorking) { entry.sprite.x = pos.x; entry.sprite.y = pos.y; }
    }

    // The bubble is what the agent is DOING right now — its task title, the
    // one field the server sends for exactly this purpose. No task, no
    // bubble: an idle agent says nothing, because it has nothing to say.
    function drawBubble(entry, a) {
      const { container, bg, label } = entry.bubble;
      if (!a.task || !a.task.title) {
        container.visible = false;
        return;
      }
      label.text = truncate(a.task.title, 26);
      const w = Math.max(label.width + 16, 40);
      const h = 16;
      const lift = 38 + (entry.bubbleLevel ?? 0) * (h + 6); // stacked pods climb
      bg.clear()
        .lineStyle(1, entry.color ?? 0x8a99b5, 0.85)
        .beginFill(0x10131f, 0.92)
        .drawRoundedRect(-w / 2, -lift - h, w, h, 7)
        .endFill()
        .lineStyle(0)
        .beginFill(0x10131f, 0.92)
        .moveTo(-4, -lift)
        .lineTo(4, -lift)
        .lineTo(0, -lift + 4)
        .closePath()
        .endFill();
      label.position.set(0, -lift - h / 2);
      container.visible = true;
    }

    function updateHumanSprite(entry, h) {
      const pos = positionForHuman(h);
      entry.target = pos;
      entry.tag.text = h.name;
      entry.data = h;
      if (entry.sprite.x === 0 && entry.sprite.y === 0) { entry.sprite.x = pos.x; entry.sprite.y = pos.y; }
    }

    function hashString(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return Math.abs(h);
    }

    // ---------------- Agent head popup (Phase 3): small card anchored above sprite ----------------
    // Glanceable, ~4 lines max, follows the sprite as it moves, never off-screen,
    // pointer-events none so it never blocks clicking the agent underneath.
    function clampPopupPosition(anchorX, anchorY, popupW, popupH, vpW, vpH, margin) {
      margin = margin ?? 8;
      // Center horizontally on anchor, clamp to viewport
      let x = anchorX - popupW / 2;
      let y = anchorY - popupH - 12; // 12px above head
      x = Math.max(margin, Math.min(x, vpW - popupW - margin));
      y = Math.max(margin, Math.min(y, vpH - popupH - margin));
      return { x, y };
    }

    function updateAgentPopupContent(a) {
      try {
        const nameEl = document.getElementById('ap-name');
        const statusEl = document.getElementById('ap-status');
        const taskEl = document.getElementById('ap-task');
        const noteEl = document.getElementById('ap-note');
        const btn = document.getElementById('ap-summon-btn');
        const err = document.getElementById('ap-summon-err');
        if (!nameEl || !statusEl) return;
        nameEl.textContent = a.name;

        // Portrait: same sprite the office draws, so the card and the floor
        // never disagree about who this is.
        const portrait = document.getElementById('ap-portrait');
        if (portrait) {
          const sprite = (a.character && CHAR_NAMES.includes(a.character))
            ? a.character
            : CHAR_NAMES[hashString(a.id) % CHAR_NAMES.length];
          portrait.style.backgroundImage = 'url(/assets/characters/' + sprite + '.png)';
        }

        const [label] = ZONE_BADGE[a.zone] ?? [a.status ?? 'unknown'];
        const text = (label || a.status || 'unknown').replace(/_/g, ' ');
        statusEl.textContent = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
        const TINT = { working: 's-working', reviewing: 's-reviewing', collaborating: 's-reviewing',
                       needs_input: 's-needs', needs_human: 's-needs', blocked: 's-blocked',
                       idle: 's-idle', done: 's-done', completed: 's-done' };
        statusEl.className = 'ap-status ' + (TINT[a.zone] || TINT[a.status] || 's-idle');
        // Task title when present, otherwise hidden — keeps the card to 2-3 lines
        if (a.task && a.task.title) {
          taskEl.textContent = a.task.title;
          taskEl.style.display = 'block';
        } else {
          taskEl.textContent = '';
          taskEl.style.display = 'none';
        }
        if (a.note) {
          noteEl.textContent = a.note;
          noteEl.style.display = 'block';
        } else {
          noteEl.textContent = '';
          noteEl.style.display = 'none';
        }
        // Summon: "Call here" normally, "Dismiss" once the agent has been
        // called. The button is always offered — whether a busy agent may be
        // summoned is the server's ruling, not the browser's guess.
        if (btn) {
          const isSummoned = !!(a.summonedPos && a.summonedPos.x != null);
          const lbl = document.getElementById('ap-summon-label');
          if (lbl) lbl.textContent = isSummoned ? 'Dismiss' : 'Call here';
          btn.classList.toggle('dismiss', isSummoned);
          btn.onclick = (e) => {
            e.stopPropagation();
            isSummoned ? doDismissSummon(a.id) : doSummon(a.id);
          };
          if (err) { err.textContent = ''; err.style.display = 'none'; }
        }
        const assignBtn = document.getElementById('ap-assign-btn');
        if (assignBtn) {
          assignBtn.onclick = (e) => { e.stopPropagation(); openDispatchTaskModal(a.id, a.name); };
        }
        updateInspector(a);
      } catch (e) { console.warn('popup content failed', e); }
    }

    function updateAgentPopupPosition() {
      try {
        const popup = document.getElementById('agent-popup');
        if (!popup || !popup.classList.contains('open') || !selectedAgentId) return;
        const entry = renderedAgents.get(selectedAgentId);
        if (!entry) { closeAgentPopup(); return; }
        // Use PIXI global position for correct screen mapping (accounts for zoom and camera)
        let globalPos;
        try {
          globalPos = entry.sprite.getGlobalPosition();
        } catch { return; }
        const officeCard = document.querySelector('.office-card');
        const canvas = document.getElementById('canvas');
        if (!officeCard || !canvas || !globalPos) return;
        const cardRect = officeCard.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        // getGlobalPosition() is already in CSS pixels of the stage: PIXI
        // applies `resolution` in the renderer's projection, NOT to the scene
        // graph, so the scene never sees device pixels. Dividing by it here
        // halved every coordinate and parked the card near the top-left
        // corner — which still TRACKED the agent, because halving preserves
        // relative motion, which is why it looked anchored while moving.
        let cssX, cssY;
        if (Number.isFinite(globalPos.x) && Number.isFinite(globalPos.y)) {
          cssX = globalPos.x + (canvasRect.left - cardRect.left);
          cssY = globalPos.y + (canvasRect.top - cardRect.top);
        } else {
          // Fallback via manual transform — also CSS pixels, no resolution.
          cssX = (entry.sprite.x * zoomLevel + worldContainer.x) + (canvasRect.left - cardRect.left);
          cssY = (entry.sprite.y * zoomLevel + worldContainer.y) + (canvasRect.top - cardRect.top);
        }
        // Head is ~36px above anchor (sprite height 48, anchor 0.75)
        const headY = cssY - 36 * zoomLevel;
        const popupW = popup.offsetWidth || 176;
        const popupH = popup.offsetHeight || 60;
        const pos = clampPopupPosition(cssX, headY, popupW, popupH, cardRect.width, cardRect.height);
        popup.style.left = pos.x + 'px';
        popup.style.top = pos.y + 'px';
      } catch (e) { console.warn('popup position failed', e); }
    }

    function openAgentPopup(a) {
      selectedAgentId = a.id;
      updateAgentPopupContent(a);
      const popup = document.getElementById('agent-popup');
      if (popup) {
        popup.classList.add('open');
        // Position immediately so it doesn't flash at old coords
        updateAgentPopupPosition();
      }
      // Keep inspector closed when the head card is open — they are separate
      // glimpses, not stacked panels.
      document.getElementById('inspector')?.classList.remove('open');
    }

    function closeAgentPopup() {
      selectedAgentId = null;
      const popup = document.getElementById('agent-popup');
      if (popup) popup.classList.remove('open');
    }
    window.closeAgentPopup = closeAgentPopup;

    // Phase 4: summon — real event through the server
    async function doSummon(agentId) {
      const errEl = document.getElementById('ap-summon-err');
      const ccErr = document.getElementById('cc-summon-err');
      const x = Math.floor(player.x / TILE);
      const y = Math.floor(player.y / TILE);
      try {
        const res = await fetch('/api/summon', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId, x, y }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          const msg = data.error || `summon failed (${res.status})`;
          if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
          if (ccErr) { ccErr.textContent = msg; ccErr.style.display = 'block'; }
          // Keep popup open so the error is visible
          return;
        }
        if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
        if (ccErr) { ccErr.textContent = ''; ccErr.style.display = 'none'; }
        // View will arrive via broadcast; no local tween
      } catch (e) {
        const msg = e.message || 'could not reach server';
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        if (ccErr) { ccErr.textContent = msg; ccErr.style.display = 'block'; }
      }
    }

    async function doDismissSummon(agentId) {
      const errEl = document.getElementById('ap-summon-err');
      const ccErr = document.getElementById('cc-summon-err');
      try {
        const res = await fetch('/api/summon/cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          const msg = data.error || `dismiss failed (${res.status})`;
          if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
          if (ccErr) { ccErr.textContent = msg; ccErr.style.display = 'block'; }
          return;
        }
        if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
        if (ccErr) { ccErr.textContent = ''; ccErr.style.display = 'none'; }
      } catch (e) {
        const msg = e.message || 'could not reach server';
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        if (ccErr) { ccErr.textContent = msg; ccErr.style.display = 'block'; }
      }
    }
    window.doSummon = doSummon;
    window.doDismissSummon = doDismissSummon;

    // ---------------- Inspector: shows the real agent record ----------------
    function inspectAgent(a) {
      // Phase 3: the head card is the primary glance; keep the old inspector
      // available but not as the click target (spec: this is a third thing).
      // For now clicking an agent opens the head card, not the large panel.
      openAgentPopup(a);
    }

    function updateInspector(a) {
      const insp = document.getElementById('inspector');
      if (!insp) return;
      const nameEl = document.getElementById('insp-name');
      if (nameEl) nameEl.textContent = a.name;
      const subEl = document.getElementById('insp-sub');
      if (subEl) subEl.textContent = a.role + ' · ' + (a.machineName || 'local');
      const badge = document.getElementById('insp-badge');
      if (badge) {
        badge.textContent = a.status;
        badge.className = 'inspector-badge badge-' + (a.status === 'working' ? 'working' : (a.status === 'blocked' ? 'blocked' : 'idle'));
      }
      
      const titleEl = document.getElementById('insp-task-title');
      const elapsedEl = document.getElementById('insp-elapsed');
      const costEl = document.getElementById('insp-cost');
      const controls = document.getElementById('insp-task-controls');
      const pauseBtn = document.getElementById('insp-pause-btn');
      const resumeBtn = document.getElementById('insp-resume-btn');
      
      if (a.task && a.task.title) {
        if (titleEl) titleEl.textContent = a.task.title;
        if (elapsedEl) elapsedEl.textContent = '⏱ ' + formatElapsed(a.task.elapsedSec || 0);
        if (costEl) costEl.textContent = '$' + (a.task.costUsd || 0).toFixed(3);
        if (controls) controls.style.display = 'flex';
        if (pauseBtn && resumeBtn) {
          if (a.status === 'waiting' || a.status === 'paused') {
            pauseBtn.style.display = 'none';
            resumeBtn.style.display = 'inline-block';
          } else {
            pauseBtn.style.display = 'inline-block';
            resumeBtn.style.display = 'none';
          }
        }
        renderInspectorSubsections(a);
      } else {
        if (titleEl) titleEl.textContent = 'No active task';
        if (elapsedEl) elapsedEl.textContent = '';
        if (costEl) costEl.textContent = '';
        if (controls) controls.style.display = 'none';
        const subWrap = document.getElementById('insp-task-subsections');
        if (subWrap) subWrap.style.display = 'none';
      }

      const descEl = document.getElementById('insp-desc');
      if (descEl) descEl.textContent = a.description || '';
      const moreBtn = document.getElementById('insp-more');
      if (moreBtn) {
        moreBtn.onclick = () => {
          setCCAgent(a.id);
          setView('agent');
          insp.classList.remove('open');
        };
      }
    }

    let _inspActiveSub = 'attempts';
    let _inspReqId = 0;
    function renderInspectorSubsections(a) {
      const subWrap = document.getElementById('insp-task-subsections');
      if (!subWrap) return;
      const taskId = a?.task?.id;
      if (!taskId) {
        subWrap.style.display = 'none';
        return;
      }
      subWrap.style.display = 'block';
      const curReq = ++_inspReqId;
      const contentEl = document.getElementById('insp-sub-content');
      if (contentEl) contentEl.innerHTML = '<div style="color:var(--text-faint);padding:6px 0;">Loading\u2026</div>';

      const attemptsBtn = document.getElementById('insp-sub-attempts-btn');
      const artifactsBtn = document.getElementById('insp-sub-artifacts-btn');
      const routingBtn = document.getElementById('insp-sub-routing-btn');
      const contextBtn = document.getElementById('insp-sub-context-btn');

      if (attemptsBtn) attemptsBtn.className = 'cc-tab' + (_inspActiveSub === 'attempts' ? ' active' : '');
      if (artifactsBtn) artifactsBtn.className = 'cc-tab' + (_inspActiveSub === 'artifacts' ? ' active' : '');
      if (routingBtn) routingBtn.className = 'cc-tab' + (_inspActiveSub === 'routing' ? ' active' : '');
      if (contextBtn) contextBtn.className = 'cc-tab' + (_inspActiveSub === 'context' ? ' active' : '');

      if (_inspActiveSub === 'routing') {
        fetch(`/api/tasks/${taskId}/routing-explanation`)
          .then(r => r.json())
          .then(data => {
            if (curReq !== _inspReqId || !contentEl) return;
            contentEl.innerHTML = `
              <div style="font-size:11px;line-height:1.45;">
                <div style="color:var(--accent);font-weight:700;margin-bottom:4px;">🎯 Routing Explanation</div>
                <div style="color:var(--text);margin-bottom:6px;">${escapeHtml(data.explanation || 'Deterministic selection')}</div>
                ${(data.candidates || []).map(c => `
                  <div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border-soft);font-size:10.5px;color:${c.eligible ? 'var(--text)' : 'var(--text-faint)'};">
                    <span>${c.eligible ? '✓' : '✕'} ${escapeHtml(c.agentName)}</span>
                    <span>Score: <strong>${c.score}</strong></span>
                  </div>
                `).join('')}
              </div>`;
          })
          .catch(() => { if (contentEl) contentEl.innerHTML = '<div style="color:var(--red);">Failed loading routing explanation.</div>'; });
        return;
      }

      if (_inspActiveSub === 'context') {
        fetch(`/api/tasks/${taskId}/context`)
          .then(r => r.json())
          .then(data => {
            if (curReq !== _inspReqId || !contentEl) return;
            contentEl.innerHTML = `
              <div style="font-size:10.5px;">
                <div style="color:var(--accent);font-weight:700;margin-bottom:4px;">📦 Assembled Context (${data.totalLength} chars)</div>
                <pre style="font-family:'IBM Plex Mono',monospace;font-size:10px;background:var(--surface-2);padding:6px;border-radius:5px;white-space:pre-wrap;max-height:120px;overflow-y:auto;color:var(--text-muted);">${escapeHtml(data.formattedContext || '')}</pre>
              </div>`;
          })
          .catch(() => { if (contentEl) contentEl.innerHTML = '<div style="color:var(--red);">Failed loading context.</div>'; });
        return;
      }

      Promise.all([
        fetch(`/api/tasks/${taskId}/attempts`).then(r => r.json()).catch(() => ({ attempts: [] })),
        fetch(`/api/tasks/${taskId}/artifacts`).then(r => r.json()).catch(() => ({ artifacts: [] })),
      ]).then(([attData, artData]) => {
        if (curReq !== _inspReqId) return;
        const attempts = attData.attempts || [];
        const artifacts = artData.artifacts || [];

        const attCountEl = document.getElementById('insp-attempts-count');
        const artCountEl = document.getElementById('insp-artifacts-count');
        if (attCountEl) attCountEl.textContent = attempts.length;
        if (artCountEl) artCountEl.textContent = artifacts.length;

        if (!contentEl) return;
        contentEl.innerHTML = '';

        if (_inspActiveSub === 'attempts') {
          if (!attempts.length) {
            contentEl.innerHTML = '<div style="color:var(--text-faint);padding:4px 0;">No attempts recorded yet.</div>';
            return;
          }
          for (const att of attempts) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border-soft);font-size:11px;';
            const left = document.createElement('span');
            left.textContent = `Attempt #${att.attempt_number} · ${att.state}`;
            left.style.fontWeight = '600';
            if (att.state === 'completed') left.style.color = 'var(--green)';
            else if (att.state === 'failed' || att.state === 'timed_out') left.style.color = 'var(--red)';
            else left.style.color = 'var(--accent)';
            const right = document.createElement('span');
            right.style.color = 'var(--text-faint)';
            right.textContent = att.cost_usd ? `$${att.cost_usd.toFixed(2)}` : '';
            row.append(left, right);
            contentEl.appendChild(row);
          }
        } else {
          if (!artifacts.length) {
            contentEl.innerHTML = '<div style="color:var(--text-faint);padding:4px 0;">No artifacts attached yet.</div>';
            return;
          }
          for (const art of artifacts) {
            const row = document.createElement('div');
            row.style.cssText = 'padding:5px 0;border-bottom:1px solid var(--border-soft);font-size:11px;';
            const top = document.createElement('div');
            top.style.cssText = 'display:flex;justify-content:space-between;';
            const k = document.createElement('span');
            k.style.fontWeight = '700';
            k.style.color = 'var(--accent)';
            k.textContent = `[${(art.kind || 'output').toUpperCase()}]`;
            const title = document.createElement('span');
            title.style.cssText = 'flex:1;margin-left:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            title.textContent = art.title;
            top.append(k, title);
            row.appendChild(top);
            if (art.summary) {
              const s = document.createElement('div');
              s.style.cssText = 'color:var(--text-faint);font-size:10.5px;margin-top:2px;';
              s.textContent = art.summary;
              row.appendChild(s);
            }
            contentEl.appendChild(row);
          }
        }
      }).catch(() => {
        if (curReq !== _inspReqId) return;
        if (contentEl) contentEl.innerHTML = '<div style="color:var(--red);padding:4px 0;">Failed to load data.</div>';
      });
    }

    window.switchInspSection = function (sec) {
      _inspActiveSub = sec;
      const a = ccAgent();
      renderInspectorSubsections(a);
    };

    window.closeInspector = function () {
      document.getElementById('inspector').classList.remove('open');
      closeAgentPopup();
    };

    function formatElapsed(sec) {
      const m = Math.floor(sec / 60), s = sec % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }

    // ---------------- Zoom ----------------
    window.adjustZoom = function (amount) {
      zoomLevel = Math.max(0.6, Math.min(2.5, zoomLevel + amount));
      worldContainer.scale.set(zoomLevel);
    };
    window.resetZoom = function () { zoomLevel = 1.0; worldContainer.scale.set(zoomLevel); };

    // ---------------- Init ----------------
    async function init() {
      PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.NEAREST;
      PIXI.settings.ROUND_PIXELS = true;

      app = new PIXI.Application({
        view: document.getElementById('canvas'),
        width: stageEl().clientWidth, height: stageEl().clientHeight,
        resolution: window.devicePixelRatio || 1, autoDensity: true,
        backgroundColor: 0x0d0f18, antialias: false,
      });

      worldContainer = new PIXI.Container();
      app.stage.addChild(worldContainer);

      // Real tiles: every floor, wall, glass and prop sprite is drawn from
      // office.json's own layer data and the actual tileset PNGs it references —
      // nothing here is a flattened screenshot. See loadMap() above.
      try {
        await loadMap();
      } catch (err) {
        console.error('failed to load office.json — map unavailable', err);
      }
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          if (x <= 1 || x >= 62 || y <= 1 || y >= 45) wallCollisionGrid[y * COLS + x] = 1;
        }
      }

      await loadCharacterSheets();
      createPlayer();

      setupInput();
      setupResize();
      initMinimap();
      initLegend();
      connect();

      app.ticker.add((delta) => update(delta));
    }

    async function loadCharacterSheets() {
      for (const name of CHAR_NAMES) {
        const tex = await PIXI.Texture.fromURL(`/assets/characters/${name}.png`);
        const frames = [];
        for (let f = 0; f < 52; f++) {
          frames.push(new PIXI.Texture(tex.baseTexture, new PIXI.Rectangle(f * 32, 0, 32, 48)));
        }
        charTextures[name] = frames;
      }
    }

    let playerBubble = null;
    let playerVoiceRing = null;
    function createPlayer() {
      const frames = charTextures[currentCharacter];
      playerSprite = new PIXI.Sprite(frames[18]);
      playerSprite.anchor.set(0.5, 0.75);
      playerSprite.x = player.x;
      playerSprite.y = player.y;
      playerSprite.zIndex = 1000;
      worldContainer.addChild(playerSprite);
      playerVoiceRing = new PIXI.Graphics();
      playerSprite.addChild(playerVoiceRing);
      playerSprite.addChild(makeNameTag(currentUser?.name || 'You', 0xffffff));
      playerBubble = makeBubble();
      playerSprite.addChild(playerBubble.container);
    }

    window.switchCharacter = function (name) {
      currentCharacter = name;
      document.querySelectorAll('.char-btn').forEach((btn) => btn.classList.toggle('active', btn.textContent.toLowerCase() === name));
      updatePlayerFrame();
    };

    function setupInput() {
      window.addEventListener('keydown', (e) => {
        // Tab flips between the two views of the same room.
        // Typing in the chat box must never walk the character around.
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
          // The mention popup gets first refusal on every key while it's
          // open — arrows navigate it, Enter/Tab pick from it, Escape
          // closes it. Only when it's not open (or doesn't want the key)
          // do Enter/Escape fall through to their normal chat-box jobs.
          if (e.target.id === 'chat-input' && handleMentionKeydown(e)) { e.preventDefault(); return; }
          if (e.key === 'Enter') window.sendChat();
          if (e.key === 'Escape') e.target.blur();
          return;
        }
        if (e.key === 'Escape' && selectedAgentId) { closeAgentPopup(); return; }
        if (e.key === 'Escape' && currentView !== 'office') { window.setView('office'); return; }
        if ((e.key === 'm' || e.key === 'M') && currentRoomZone) {
          window.toggleRoomMic();
          return;
        }
        if (e.key === 'c' || e.key === 'C') { window.setView('chat'); return; }
        if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') keys.w = keys.up = true;
        if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') keys.a = keys.left = true;
        if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') keys.s = keys.down = true;
        if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') keys.d = keys.right = true;
        if (e.key === 'Shift') keys.shift = true;
      });
      window.addEventListener('keyup', (e) => {
        if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') keys.w = keys.up = false;
        if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') keys.a = keys.left = false;
        if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') keys.s = keys.down = false;
        if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') keys.d = keys.right = false;
        if (e.key === 'Shift') keys.shift = false;
      });
      window.addEventListener('wheel', (e) => {
        if (currentView !== 'office') return; // other views scroll normally
        e.preventDefault();
        adjustZoom(e.deltaY < 0 ? 0.08 : -0.08);
      }, { passive: false });

      // Clicking anywhere outside an agent closes the head card.
      window.addEventListener('pointerdown', (e) => {
        // A click ON an agent reaches here too: PIXI's stopPropagation does
        // not stop the DOM event, so without this the card opened and closed
        // on the same click and clicking an agent appeared to do nothing.
        if (e.__agentSpriteClick) return;
        if (!selectedAgentId) return;
        const popup = document.getElementById('agent-popup');
        if (popup && popup.contains(e.target)) return;
        // Inspector's close button is inside #inspector, not the popup
        const insp = document.getElementById('inspector');
        if (insp && insp.contains(e.target)) return;
        closeAgentPopup();
      });

      const chatInput = document.getElementById('chat-input');
      if (chatInput) {
        chatInput.addEventListener('input', updateMentionPopup);
        // click/keyup too: caret can move without an `input` event (e.g.
        // clicking mid-text, or pressing an arrow key inside the token),
        // and the popup's candidate list depends on caret position.
        chatInput.addEventListener('click', updateMentionPopup);
        chatInput.addEventListener('keyup', (e) => {
          // ArrowUp/Down are excluded: those navigate the popup's own
          // selection (handleMentionKeydown, on keydown) and are
          // preventDefault'd so the caret never actually moves — recomputing
          // candidates here would reset activeIndex back to 0 on every
          // press and the highlight would never appear to move.
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') updateMentionPopup();
        });
        chatInput.addEventListener('blur', () => closeMentionPopup());
      }
    }

    function setupResize() {
      const fit = () => app.renderer.resize(stageEl().clientWidth, stageEl().clientHeight);
      window.addEventListener('resize', fit);
      // The dock opening/closing changes the stage width without a window
      // resize event, so watch the element itself.
      if (window.ResizeObserver) new ResizeObserver(fit).observe(stageEl());
    }

    function checkCollision(targetX, targetY) {
      const radius = 8;
      const points = [
        { x: targetX - radius, y: targetY - radius }, { x: targetX + radius, y: targetY - radius },
        { x: targetX - radius, y: targetY + radius }, { x: targetX + radius, y: targetY + radius },
      ];
      for (const p of points) {
        const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
        if (tx < 0 || tx >= COLS || ty < 0 || ty >= ROWS) return true;
        if (wallCollisionGrid[ty * COLS + tx] === 1) return true;
      }
      return false;
    }

    function detectZoneName(x, y) {
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      for (const [name, rect] of [['cabin0', zones.cabin[0]], ['cabin1', zones.cabin[1]], ['cabin2', zones.cabin[2]], ['cabin3', zones.cabin[3]],
                                    ...zones.working.map((r, i) => [`working${i}`, r]),
                                    ['blocked', zones.blocked], ['reviewing', zones.reviewing],
                                    ['collaborating', zones.collaborating], ['idle', zones.idle], ['done', zones.done]]) {
        if (!rect) continue;
        if (tx >= rect.x && tx < rect.x + rect.w && ty >= rect.y && ty < rect.y + rect.h) return name;
      }
      return 'corridor';
    }

    function updatePlayerFrame() {
      const frames = charTextures[currentCharacter];
      if (!frames) return;
      const action = player.isMoving ? 'run' : 'idle';
      const frameList = DIR_FRAMES[action][player.direction];
      playerSprite.texture = frames[frameList[player.frameIdx % frameList.length]];
    }

    let lastFpsUpdate = 0;
    function update(delta) {
      const dt = delta / 60;

      let vx = 0, vy = 0;
      if (keys.w || keys.up) vy -= 1;
      if (keys.s || keys.down) vy += 1;
      if (keys.a || keys.left) vx -= 1;
      if (keys.d || keys.right) vx += 1;
      if (vx !== 0 && vy !== 0) { vx *= 0.7071; vy *= 0.7071; }

      player.isMoving = (vx !== 0 || vy !== 0);
      const speed = (player.speed * (keys.shift ? 1.75 : 1.0)) * dt;

      if (player.isMoving) {
        player.direction = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 'right' : 'left') : (vy > 0 ? 'down' : 'up');
        const newX = player.x + vx * speed;
        if (!checkCollision(newX, player.y)) player.x = newX;
        const newY = player.y + vy * speed;
        if (!checkCollision(player.x, newY)) player.y = newY;

        player.animTimer += dt;
        const animStep = keys.shift ? 0.05 : (player.speed >= 450 ? 0.055 : (player.speed >= 300 ? 0.07 : 0.09));
        if (player.animTimer >= animStep) { player.animTimer = 0; player.frameIdx = (player.frameIdx + 1) % 6; updatePlayerFrame(); }
      } else {
        player.animTimer += dt;
        if (player.animTimer >= 0.22) { player.animTimer = 0; player.frameIdx = (player.frameIdx + 1) % 6; updatePlayerFrame(); }
      }

      playerSprite.x = player.x;
      playerSprite.y = player.y;

      // throttled position push — only when the tile actually changed (CONTRACT.md: "at most 5/sec, only on change")
      posSendTimer += dt;
      if (posSendTimer >= 0.2) { posSendTimer = 0; sendPosition(); }
      updateSpatialRoomComms();

      // Render real-time avatar speaking rings
      if (playerVoiceRing) {
        if (isLocalSpeaking) {
          playerVoiceRing.clear();
          playerVoiceRing.lineStyle(2.5, 0x22c55e, 0.9);
          playerVoiceRing.drawCircle(0, -14, 18);
        } else {
          playerVoiceRing.clear();
        }
      }
      for (const [uid, entry] of renderedHumans) {
        if (entry.voiceRing) {
          const peerState = peerAnalysers.get(uid);
          if (peerState && peerState.isSpeaking) {
            entry.voiceRing.clear();
            entry.voiceRing.lineStyle(2.5, 0x22c55e, 0.9);
            entry.voiceRing.drawCircle(0, -14, 18);
          } else {
            entry.voiceRing.clear();
          }
        }
      }

      // Idle roaming: recompute the wandering waypoint each frame from the
      // shared clock so every browser drifts the same way. Non-idle agents keep
      // their server-assigned slot — work always wins. No Math.random() here.
      if (latestView) {
        const now = sharedNowMs();
        for (const entry of renderedAgents.values()) {
          if (!entry.data) continue;
          if (entry.data.zone === 'idle') {
            entry.target = positionForAgentWithRoaming(entry.data, now);
          }
        }
      }

      // ease other sprites toward their server-assigned target (never invents motion, only smooths it)
      const ease = 1 - Math.pow(0.001, dt);
      for (const entry of renderedAgents.values()) {
        if (!entry.target) continue;
        entry.sprite.x += (entry.target.x - entry.sprite.x) * ease;
        entry.sprite.y += (entry.target.y - entry.sprite.y) * ease;
      }
      for (const entry of renderedHumans.values()) {
        if (!entry.target) continue;
        entry.sprite.x += (entry.target.x - entry.sprite.x) * ease;
        entry.sprite.y += (entry.target.y - entry.sprite.y) * ease;
      }

      // Running animation & facing: describes motion the ease loop already
      // performs. Applies to all movement (roaming, zone changes, summoning).
      // Stationary agents hold a still idle frame — no running-on-the-spot.
      for (const entry of renderedAgents.values()) {
        updateAgentFrame(entry, dt);
      }

      // Head popup tracks its agent every frame, clamped so it never leaves the card
      if (selectedAgentId) updateAgentPopupPosition();

      // Follow the player, but never past the edge of the building — an
      // unclamped camera shows empty void beside the map, which got obvious
      // once the office grew to fill the whole stage. When the map is
      // narrower than the viewport (zoomed out, or a very wide window) it
      // is centred instead, because there is no scrolling left to do.
      const viewW = stageEl().clientWidth, viewH = stageEl().clientHeight;
      const worldW = MAP_WIDTH * zoomLevel, worldH = MAP_HEIGHT * zoomLevel;
      const clampAxis = (view, world, desired) =>
        world <= view ? (view - world) / 2 : Math.min(0, Math.max(view - world, desired));

      const targetCamX = clampAxis(viewW, worldW, viewW / 2 - player.x * zoomLevel);
      const targetCamY = clampAxis(viewH, worldH, viewH / 2 - player.y * zoomLevel);
      worldContainer.x += (targetCamX - worldContainer.x) * 0.1;
      worldContainer.y += (targetCamY - worldContainer.y) * 0.1;

      const zoneName = detectZoneName(player.x, player.y);
      document.getElementById('current-zone-name').textContent = zoneName;
      // The HUD reads "Floor 1 / <where you are>" — the zone is the subtitle,
      // which is what makes the island say something as you walk.
      document.getElementById('zone-stat').textContent = zoneName;
      document.getElementById('pos-stat').textContent = `X: ${Math.round(player.x)}, Y: ${Math.round(player.y)}`;
      document.getElementById('coord-display').textContent = `${Math.floor(player.x / TILE)}, ${Math.floor(player.y / TILE)}`;

      const miniPlayer = document.getElementById('minimap-player');
      miniPlayer.style.left = `${(player.x / MAP_WIDTH) * 100}%`;
      miniPlayer.style.top = `${(player.y / MAP_HEIGHT) * 100}%`;

      if (Date.now() - lastFpsUpdate > 500) { lastFpsUpdate = Date.now(); document.getElementById('fps-stat').textContent = Math.round(app.ticker.FPS); }
    }

    function initMinimap() {
      // Deliberate exception: the main scene is real tiles (loadMap), but a
      // 240x140 thumbnail gains nothing from per-tile fidelity — the flattened
      // composite is correct here and cheaper than re-drawing thousands of
      // sprites at minimap scale.
      const mc = document.getElementById('minimap-canvas');
      const ctx = mc.getContext('2d');
      mc.width = 240; mc.height = 140;
      const img = new Image();
      img.src = '/assets/preview.png';
      img.onload = () => ctx.drawImage(img, 0, 0, mc.width, mc.height);
    }

    window.addEventListener('DOMContentLoaded', init);
