// Prohuman Scanner — Netlify API (v2 function)
//
// ── MIÉRT NÉZ KI ÍGY ──────────────────────────────────────────────────
//
// 1) PERZISZTENCIA — Netlify Blobs.
//    A Netlify Functions fájlrendszere READ-ONLY (a /tmp kivételével), és
//    minden hívás más konténerben futhat. A korábbi `fs.writeFile()` EROFS-szal
//    elszállt, a memóriában tartott adat pedig a konténerrel együtt eltűnt.
//    Ezért a Blobs (hivatalos, perzisztens kulcs-érték tár). Ha valamiért nem
//    érhető el, memóriára esik vissza — de ezt a válasz `storage` mezője
//    MEGMONDJA, nem hazudik sikert némán.
//
// 2) HITELESÍTÉS — kötelező, MINDEN adatvégponton, olvasásra is.
//    Korábban NEM volt semmilyen hitelesítés, `Access-Control-Allow-Origin: *`
//    mellett. Bárki a nyílt internetről egyetlen `curl`-lel kiolvashatta az
//    összes előzményt — bennük valódi SZEMÉLYNEVEKKEL és dokumentumtípussal
//    (pl. "tp" = táppénz, ami a GDPR 9. cikke szerint különleges kategóriájú
//    EGÉSZSÉGÜGYI adat). Ez adatvédelmi incidens volt, nem elméleti kockázat.
//    Mostantól minden kérés `X-Api-Key` fejlécet igényel.
//
// 3) FAIL-CLOSED.
//    Ha a PROSCANNER_API_KEY környezeti változó nincs beállítva, a végpontok
//    503-at adnak. Így egy hiányos deploy NEM nyitja vissza csendben a lyukat.
//
// 4) A KLIENS ÁLTAL KÜLDÖTT `id`-t ELDOBJUK.
//    A korábbi kód megtartotta (`if (!entry.id) entry.id = ...`), a frontend
//    pedig escape nélkül írta be egy inline onclick attribútumba — ez tárolt
//    XSS volt. Az id-t mostantól KIZÁRÓLAG a szerver állítja elő.

import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const STORE_NAME = "proscanner";
const K_TYPES = "types";
const K_HISTORY = "history";

const MAX_HISTORY = 500;
const MAX_TYPES = 200;
const MAX_TYPE_LEN = 80;
const MAX_PATHS_PER_TYPE = 50;
const MAX_PATH_LEN = 400;
const MAX_FIELD_LEN = 300;
const MAX_BODY_BYTES = 128 * 1024;

const DEFAULT_TYPES = {
  docTypes: [
    "munkába járás",
    "tp",
    "pótszabi",
    "szerződés csomag",
    "országbérlet",
    "vármegyebérlet",
    "adóelőleg",
    "összevont adóelőleg",
  ],
  pathSuggestions: {},
};

// Memória-fallback (csak ha a Blobs nem érhető el)
let memTypes = null;
let memHistory = null;

function blobStore() {
  // `consistency: "strong"` – e nélkül a mentés utáni azonnali olvasás régi
  // adatot adhatna vissza (eventual consistency), és a felhasználó azt látná,
  // hogy "nem mentődött el".
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

async function loadJson(key, fallback) {
  try {
    const data = await blobStore().get(key, { type: "json" });
    return { data: data == null ? structuredClone(fallback) : data, storage: "blobs" };
  } catch (err) {
    console.log("[blobs] read failed:", err && err.message);
    if (key === K_TYPES) memTypes = memTypes || structuredClone(fallback);
    if (key === K_HISTORY) memHistory = memHistory || structuredClone(fallback);
    return { data: key === K_TYPES ? memTypes : memHistory, storage: "memory" };
  }
}

async function saveJson(key, value) {
  try {
    await blobStore().setJSON(key, value);
    return "blobs";
  } catch (err) {
    console.log("[blobs] write failed:", err && err.message);
    if (key === K_TYPES) memTypes = value;
    if (key === K_HISTORY) memHistory = value;
    return "memory";
  }
}

// ---- HITELESÍTÉS --------------------------------------------------------

/**
 * Konstans idejű kulcs-összehasonlítás.
 * A naiv `a === b` a nem egyező karakternél azonnal kilép, így a válaszidőből
 * karakterenként ki lehetne találni a kulcsot. Előbb SHA-256-ozunk (így a két
 * puffer hossza mindig egyezik, amit a timingSafeEqual megkövetel).
 */
function keyMatches(provided, expected) {
  if (typeof provided !== "string" || !provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** null = rendben; egyébként a visszaadandó hibaválasz. */
function authError(req, origin) {
  const expected = process.env.PROSCANNER_API_KEY;
  if (!expected || !expected.trim()) {
    return json(
      {
        error: "A kiszolgálón nincs beállítva a PROSCANNER_API_KEY környezeti változó. " +
               "Amíg nincs, az API biztonsági okból nem szolgál ki adatot.",
        code: "SERVER_KEY_MISSING",
      },
      503,
      origin
    );
  }
  if (!keyMatches(req.headers.get("x-api-key"), expected.trim())) {
    return json({ error: "Érvénytelen vagy hiányzó X-Api-Key fejléc.", code: "UNAUTHORIZED" }, 401, origin);
  }
  return null;
}

// ---- CORS ---------------------------------------------------------------
//
// A korábbi `Access-Control-Allow-Origin: *` bármelyik weboldalnak engedte,
// hogy a látogató böngészőjéből hívja ezt az API-t. Most allowlist van.
// A `null` origin a `file://` protokollról megnyitott index.html miatt kell.

function allowedOrigins() {
  const fromEnv = (process.env.PROSCANNER_ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : ["null", "http://localhost:8888", "http://127.0.0.1:8888"];
}

function corsHeaders(origin) {
  const list = allowedOrigins();
  const ok = origin && (list.includes("*") || list.includes(origin));
  const h = {
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  // Azonos originről (a saját deploy) nincs Origin fejléc — az mindig mehet.
  if (ok) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body, status = 200, origin = null) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

/** A hívott végpont a redirect miatt többféle prefixszel érkezhet. */
function routeOf(url) {
  let p = new URL(url).pathname;
  p = p.replace(/^\/\.netlify\/functions\/api/, "");
  p = p.replace(/^\/api/, "");
  p = p.replace(/\/+$/, "");
  return p || "/";
}

// ---- BEMENET-ELLENŐRZÉS -------------------------------------------------

/**
 * Útvonal-normalizálás — az index.html normAbs-ával és a backend.js-szel
 * BÁJTRA AZONOS. Két esetet külön kell kezelni, különben a normalizálás
 * elrontja őket:
 *  · UNC (\\fileserver\HR\tp): a vezető két elválasztó egyre olvadna, és az
 *    isAbsPath már nem ismerné fel → a szerver csendben eldobná. Céges
 *    környezetben ez a leggyakoribb útvonalforma.
 *  · POSIX abszolút (/mnt/share/tp): a `/`-ek `\`-re váltanának, amitől szintén
 *    elbukna az abszolút-teszten — noha a kód elvileg támogatja.
 */
function normPath(p) {
  let s = String(p == null ? "" : p).trim();
  if (!s) return "";
  if (s.startsWith("/") && !s.startsWith("//")) {
    return s.replace(/\/+/g, "/").replace(/(.)\/+$/, "$1");
  }
  const unc = /^[\\/]{2}/.test(s);
  s = s.replace(/[\\/]+/g, "\\").replace(/\\+$/, "");
  if (unc) s = "\\" + s;
  return s;
}

/** Teljes útvonal-e? `D:\...`, `\\szerver\...` vagy `/home/...` */
function isAbsPath(p) {
  const s = String(p == null ? "" : p).trim();
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\//.test(s);
}

/** Vezérlőkarakter-mentes, hosszkorlátos szöveg. */
function str(v, max = MAX_FIELD_LEN) {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max);
}

/**
 * Előzmény-bejegyzés szigorú fehérlistája. Csak ezek a mezők maradnak meg,
 * mindegyik szövegre kényszerítve és hosszkorlátozva. Így nem lehet a
 * tárolóba tetszőleges (akár beágyazott, akár óriási) objektumot tolni.
 */
function sanitizeHistoryEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const now = new Date();
  return {
    // Az id-t KIZÁRÓLAG a szerver adja — a kliensét szándékosan eldobjuk.
    id: "hist_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9),
    origName: str(raw.origName),
    newName: str(raw.newName),
    personName: str(raw.personName, 120),
    type: str(raw.type, MAX_TYPE_LEN),
    validity: str(raw.validity, 60),
    year: str(raw.year, 8),
    targetPath: str(raw.targetPath, MAX_PATH_LEN),
    isoDate: now.toISOString(),
    date: str(raw.date, 40) || now.toLocaleDateString("hu-HU"),
    time: str(raw.time, 40) || now.toLocaleTimeString("hu-HU"),
  };
}

async function readBody(req) {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) throw new Error("A kérés törzse túl nagy.");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("Érvénytelen JSON."); }
}

// ---- KÉRÉSKEZELŐ --------------------------------------------------------

export default async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("", { status: 204, headers: corsHeaders(origin) });
  }

  const route = routeOf(req.url);

  // A gyökér a hitelesítés ELŐTT válaszol, hogy az elérhetőség
  // kulcs nélkül is ellenőrizhető legyen. Adatot NEM ad vissza.
  if (route === "/" || route === "") {
    return json(
      {
        name: "Prohuman Scanner API",
        version: "3.0.0",
        auth: "X-Api-Key kötelező minden /api/types és /api/history híváshoz",
        configured: !!(process.env.PROSCANNER_API_KEY || "").trim(),
        endpoints: ["/api/types", "/api/history"],
      },
      200,
      origin
    );
  }

  // Innentől MINDEN végpont hitelesítést igényel — az olvasás is.
  const denied = authError(req, origin);
  if (denied) return denied;

  try {
    // ---- TÍPUSOK & ÚTVONALAK ------------------------------------------
    if (route === "/types") {
      if (req.method === "GET") {
        const { data, storage } = await loadJson(K_TYPES, DEFAULT_TYPES);
        if (!Array.isArray(data.docTypes) || data.docTypes.length === 0) {
          data.docTypes = [...DEFAULT_TYPES.docTypes];
        }
        data.pathSuggestions = data.pathSuggestions || {};
        return json({ ...data, storage }, 200, origin);
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        const { data: cur } = await loadJson(K_TYPES, DEFAULT_TYPES);
        cur.docTypes = Array.isArray(cur.docTypes) && cur.docTypes.length ? cur.docTypes : [...DEFAULT_TYPES.docTypes];
        cur.pathSuggestions = cur.pathSuggestions || {};

        if (Array.isArray(body.docTypes)) {
          for (const t of body.docTypes.slice(0, MAX_TYPES)) {
            const v = str(t, MAX_TYPE_LEN);
            if (v && cur.docTypes.length < MAX_TYPES && !cur.docTypes.includes(v)) cur.docTypes.push(v);
          }
        }

        const added = [];
        const rejected = [];
        if (body.pathSuggestions && typeof body.pathSuggestions === "object") {
          for (const rawType of Object.keys(body.pathSuggestions).slice(0, MAX_TYPES)) {
            const t = str(rawType, MAX_TYPE_LEN);
            if (!t) continue;
            const list = body.pathSuggestions[rawType];
            if (!Array.isArray(list)) continue;
            if (!Array.isArray(cur.pathSuggestions[t])) cur.pathSuggestions[t] = [];
            for (const raw of list.slice(0, MAX_PATHS_PER_TYPE)) {
              const p = normPath(str(raw, MAX_PATH_LEN));
              // CSAK TELJES ÚTVONALAT tárolunk (pl. D:\CsSzabj\PROHUMAN\tp).
              // A puszta mappanév ("tp") használhatatlan javaslatként.
              if (!p || p.length < 3 || !isAbsPath(p)) { rejected.push(raw); continue; }
              if (cur.pathSuggestions[t].length >= MAX_PATHS_PER_TYPE) { rejected.push(raw); continue; }
              if (!cur.pathSuggestions[t].includes(p)) { cur.pathSuggestions[t].push(p); added.push(p); }
            }
          }
        }

        const storage = await saveJson(K_TYPES, cur);
        return json({ success: true, storage, added, rejected, ...cur }, 200, origin);
      }

      if (req.method === "DELETE") {
        // Elgépelt/rossz útvonal eltávolítása: /api/types?type=tp&path=D:\...
        const u = new URL(req.url);
        const t = str(u.searchParams.get("type"), MAX_TYPE_LEN);
        const p = normPath(u.searchParams.get("path"));
        const { data: cur } = await loadJson(K_TYPES, DEFAULT_TYPES);
        cur.pathSuggestions = cur.pathSuggestions || {};
        if (t && Array.isArray(cur.pathSuggestions[t])) {
          cur.pathSuggestions[t] = p ? cur.pathSuggestions[t].filter((x) => normPath(x) !== p) : [];
        }
        const storage = await saveJson(K_TYPES, cur);
        return json({ success: true, storage, ...cur }, 200, origin);
      }
    }

    // ---- ELŐZMÉNYEK ---------------------------------------------------
    if (route === "/history" || route.startsWith("/history/")) {
      if (req.method === "GET") {
        const { data } = await loadJson(K_HISTORY, []);
        return json(Array.isArray(data) ? data : [], 200, origin);
      }

      if (req.method === "POST") {
        const entry = sanitizeHistoryEntry(await readBody(req));
        if (!entry) return json({ error: "Érvénytelen adat." }, 400, origin);
        const { data } = await loadJson(K_HISTORY, []);
        const list = Array.isArray(data) ? data : [];
        list.unshift(entry);
        const storage = await saveJson(K_HISTORY, list.slice(0, MAX_HISTORY));
        return json({ success: true, storage, item: entry }, 201, origin);
      }

      if (req.method === "DELETE") {
        const id = route.startsWith("/history/") ? decodeURIComponent(route.slice("/history/".length)) : "";
        const { data } = await loadJson(K_HISTORY, []);
        const list = Array.isArray(data) ? data : [];
        const next = id ? list.filter((x) => x.id !== id) : [];
        const storage = await saveJson(K_HISTORY, next);
        return json({ success: true, storage, message: id ? `Törölve: ${id}` : "Összes előzmény törölve." }, 200, origin);
      }
    }

    return json({ error: "Ismeretlen végpont: " + route }, 404, origin);
  } catch (err) {
    return json({ error: err && err.message ? err.message : String(err) }, 500, origin);
  }
};
