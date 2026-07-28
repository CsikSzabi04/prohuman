// Prohuman Scanner — helyi fejlesztői backend
//
// A Netlify függvénnyel AZONOS szabályokat érvényesíti, hogy a lokális és az
// éles működés ne térjen el. A korábbi verzióhoz képest a lényeges változások:
//
//  1) HITELESÍTÉS minden adatvégponton (X-Api-Key), fail-closed indulással.
//  2) CSAK a loopback interfészen figyel. Korábban az Express alapértelmezése
//     szerint MINDEN interfészen (0.0.0.0), nyitott CORS mellett — vagyis a
//     céges wifin bárki lekérhette a teljes előzményt, benne a személynevekkel.
//  3) A kliens által küldött `id`-t eldobjuk (a frontendben ez tárolt XSS volt).
//  4) Bemenet-fehérlista és hosszkorlátok.
//  5) ATOMI írás + soros végrehajtás. Korábban két egyszerre érkező kérés
//     olvasás-módosítás-írás versenyt futott (elveszett bejegyzés), és egy
//     félbeszakadt írás csonka, olvashatatlan JSON-t hagyott a lemezen.
//  6) A normPath a frontenddel MEGEGYEZŐEN a `\` ismétlődéseket is összevonja
//     (korábban csak a `/`-t, ezért ugyanaz az útvonal kétszer került be).

import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));

const workDir = process.cwd();
const HISTORY_FILE = path.join(workDir, "history_api.json");
const TYPES_FILE = path.join(workDir, "types_api.json");

const MAX_HISTORY = 500;
const MAX_TYPES = 200;
const MAX_TYPE_LEN = 80;
const MAX_PATHS_PER_TYPE = 50;
const MAX_PATH_LEN = 400;
const MAX_FIELD_LEN = 300;

const API_KEY = (process.env.PROSCANNER_API_KEY || "").trim();
const PORT = process.env.PORT || 8788;
const HOST = process.env.HOST || "127.0.0.1";

// ---- CORS ---------------------------------------------------------------
// Allowlist, nem csillag. A `null` a file:// protokollról megnyitott
// index.html miatt kell (a böngésző ilyenkor "null" origint küld).
const ALLOWED_ORIGINS = (process.env.PROSCANNER_ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                       // curl, azonos origin
    if (ALLOWED_ORIGINS.length) return cb(null, ALLOWED_ORIGINS.includes(origin));
    return cb(null, origin === "null" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Api-Key"],
  maxAge: 86400,
}));

app.use((req, resp, next) => {
  resp.set("Cache-Control", "no-store");
  resp.set("X-Content-Type-Options", "nosniff");
  resp.set("Referrer-Policy", "no-referrer");
  next();
});

// ---- Hitelesítés --------------------------------------------------------

/** Konstans idejű összehasonlítás — a naiv `===` időzítésből kiadná a kulcsot. */
function keyMatches(provided, expected) {
  if (typeof provided !== "string" || !provided) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, resp, next) {
  if (!API_KEY) {
    return resp.status(503).send({
      error: "A kiszolgálón nincs beállítva a PROSCANNER_API_KEY környezeti változó. " +
             "Amíg nincs, a backend biztonsági okból nem szolgál ki adatot.",
      code: "SERVER_KEY_MISSING",
    });
  }
  if (!keyMatches(req.get("x-api-key"), API_KEY)) {
    return resp.status(401).send({ error: "Érvénytelen vagy hiányzó X-Api-Key fejléc.", code: "UNAUTHORIZED" });
  }
  next();
}

// ---- Fájl I/O -----------------------------------------------------------

async function readJsonFile(filePath, defaultData) {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return structuredClone(defaultData);
  }
}

/**
 * ATOMI írás: előbb ideiglenes fájlba írunk, majd átnevezzük. A rename az
 * azonos köteten atomi művelet, így olvasó soha nem láthat félkész JSON-t —
 * a korábbi közvetlen writeFile egy megszakadt írásnál csonka fájlt hagyott,
 * amit utána a readJsonFile csendben üres listának olvasott (= adatvesztés).
 */
async function writeJsonFile(filePath, data) {
  const tmp = filePath + "." + process.pid + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, filePath);
}

/**
 * Soros végrehajtás. Minden végpont olvas-módosít-ír; két párhuzamos kérés
 * esetén a második felülírná az elsőt (elveszett bejegyzés). Ez a lánc
 * garantálja, hogy egyszerre csak egy művelet fusson.
 */
let ioChain = Promise.resolve();
function withLock(fn) {
  const run = ioChain.then(fn, fn);
  ioChain = run.then(() => {}, () => {});
  return run;
}

// ---- Bemenet-ellenőrzés -------------------------------------------------

/**
 * Útvonal-normalizálás — az index.html normAbs-ával és a netlify függvénnyel
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

function str(v, max = MAX_FIELD_LEN) {
  if (typeof v !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, max);
}

function sanitizeHistoryEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const now = new Date();
  return {
    // Az id-t KIZÁRÓLAG a szerver adja — a kliensét szándékosan eldobjuk,
    // mert a frontend korábban escape nélkül írta HTML-attribútumba.
    id: "hist_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"),
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

// ---- ELŐZMÉNYEK API -----------------------------------------------------

async function getHistory(req, resp) {
  try {
    resp.send(await withLock(() => readJsonFile(HISTORY_FILE, [])));
  } catch (err) {
    resp.status(500).send({ error: err.message });
  }
}

async function postHistory(req, resp) {
  try {
    const newEntry = sanitizeHistoryEntry(req.body);
    if (!newEntry) return resp.status(400).send({ error: "Érvénytelen adat formátum." });

    await withLock(async () => {
      const history = await readJsonFile(HISTORY_FILE, []);
      const list = Array.isArray(history) ? history : [];
      list.unshift(newEntry);
      await writeJsonFile(HISTORY_FILE, list.slice(0, MAX_HISTORY));
    });

    resp.status(201).send({ success: true, storage: "file", item: newEntry });
  } catch (err) {
    resp.status(400).send({ error: err.message });
  }
}

async function delHistory(req, resp) {
  try {
    const { id } = req.params;
    await withLock(async () => {
      const history = await readJsonFile(HISTORY_FILE, []);
      const list = Array.isArray(history) ? history : [];
      await writeJsonFile(HISTORY_FILE, id ? list.filter((item) => item.id !== id) : []);
    });
    resp.send({ success: true, message: id ? `Előzmény törölve: ${id}` : "Összes előzmény törölve." });
  } catch (err) {
    resp.status(400).send({ error: err.message });
  }
}

// ---- TÍPUSOK ÉS ÚTVONALAK API -------------------------------------------

const DEFAULT_TYPES_DATA = { docTypes: [], pathSuggestions: {} };

async function getTypes(req, resp) {
  try {
    resp.send(await withLock(() => readJsonFile(TYPES_FILE, DEFAULT_TYPES_DATA)));
  } catch (err) {
    resp.status(500).send({ error: err.message });
  }
}

async function postTypes(req, resp) {
  try {
    const { docTypes, pathSuggestions } = req.body || {};
    const added = [], rejected = [];

    const currentData = await withLock(async () => {
      const cur = await readJsonFile(TYPES_FILE, DEFAULT_TYPES_DATA);
      cur.docTypes = Array.isArray(cur.docTypes) ? cur.docTypes : [];
      cur.pathSuggestions = cur.pathSuggestions || {};

      if (Array.isArray(docTypes)) {
        for (const t of docTypes.slice(0, MAX_TYPES)) {
          const v = str(t, MAX_TYPE_LEN);
          if (v && cur.docTypes.length < MAX_TYPES && !cur.docTypes.includes(v)) cur.docTypes.push(v);
        }
      }

      // A Netlify-függvénnyel AZONOS szabály: csak TELJES útvonalat tárolunk
      // (pl. D:\CsSzabj\PROHUMAN\összevont adóelőleg) — a puszta mappanév
      // ("tp") javaslatként használhatatlan.
      if (pathSuggestions && typeof pathSuggestions === "object") {
        for (const rawType of Object.keys(pathSuggestions).slice(0, MAX_TYPES)) {
          const t = str(rawType, MAX_TYPE_LEN);
          if (!t) continue;
          const list = pathSuggestions[rawType];
          if (!Array.isArray(list)) continue;
          if (!Array.isArray(cur.pathSuggestions[t])) cur.pathSuggestions[t] = [];
          for (const raw of list.slice(0, MAX_PATHS_PER_TYPE)) {
            const p = normPath(str(raw, MAX_PATH_LEN));
            if (!p || p.length < 3 || !isAbsPath(p)) { rejected.push(raw); continue; }
            if (cur.pathSuggestions[t].length >= MAX_PATHS_PER_TYPE) { rejected.push(raw); continue; }
            if (!cur.pathSuggestions[t].includes(p)) { cur.pathSuggestions[t].push(p); added.push(p); }
          }
        }
      }

      await writeJsonFile(TYPES_FILE, cur);
      return cur;
    });

    resp.send({ success: true, storage: "file", added, rejected, ...currentData });
  } catch (err) {
    resp.status(400).send({ error: err.message });
  }
}

// ---- ROUTE-OK -----------------------------------------------------------

// Állapotjelző — hitelesítés nélkül elérhető, de adatot NEM ad vissza.
app.get("/", (req, resp) => resp.type("text/plain").send(
  "Prohuman Scanner Backend v2.0.0\n" +
  "Hitelesítés: X-Api-Key kötelező\n" +
  "PROSCANNER_API_KEY beállítva: " + (API_KEY ? "igen" : "NEM — az API 503-at ad")
));

app.get("/api/history", requireAuth, getHistory);
app.post("/api/history", requireAuth, postHistory);
app.delete("/api/history/:id?", requireAuth, delHistory);

app.get("/api/types", requireAuth, getTypes);
app.post("/api/types", requireAuth, postTypes);

// Egységes hibakezelő — a stack trace SOHA nem megy ki a válaszba.
// A hibás kérés-törzs a KLIENS hibája (400), nem a szerveré (500): az
// express.json() SyntaxError-t dob, ami e nélkül 500-ként jelenne meg.
// eslint-disable-next-line no-unused-vars
app.use((err, req, resp, next) => {
  const clientFault =
    err instanceof SyntaxError || err.type === "entity.parse.failed" || err.type === "entity.too.large";
  if (clientFault) {
    const tooLarge = err.type === "entity.too.large";
    return resp.status(tooLarge ? 413 : 400).send({
      error: tooLarge ? "A kérés törzse túl nagy (max. 128 kB)." : "Érvénytelen JSON a kérés törzsében.",
    });
  }
  console.error("Kezeletlen hiba:", err && err.message);
  resp.status(500).send({ error: "Belső szerverhiba." });
});

// Csak a loopbacken figyelünk: a helyi backend nem szolgálhat ki személyes
// adatot a hálózat többi gépének.
app.listen(PORT, HOST, () => {
  console.log(`🚀 Prohuman Scanner Backend: http://${HOST}:${PORT}`);
  if (!API_KEY) {
    console.warn("⚠  PROSCANNER_API_KEY nincs beállítva — minden adatvégpont 503-at ad.");
    console.warn("   Indítás kulccsal (PowerShell):  $env:PROSCANNER_API_KEY='titok'; npm start");
  }
});
