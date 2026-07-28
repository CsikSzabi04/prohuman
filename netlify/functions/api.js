// Prohuman Scanner — Netlify API (v2 function)
//
// MIÉRT ÍRÓDOTT ÚJRA:
// A korábbi verzió `fs.writeFile()`-lal próbálta menteni a types_api.json-t.
// A Netlify Functions fájlrendszere READ-ONLY (a /tmp kivételével), és minden
// hívás új/másik konténerben futhat → az írás EROFS-szal elszállt (a catch
// elnyelte), a `memoryTypes` pedig a konténerrel együtt eltűnt. Ezért adott a
// GET /api/types mindig `"pathSuggestions": {}`-t.
//
// MEGOLDÁS: Netlify Blobs = a Netlify hivatalos, PERZISZTENS kulcs-érték tára.
// Nulla konfiguráció, a deploy után azonnal él. Ha valamiért nem elérhető
// (pl. linkeletlen lokális `netlify dev`), memóriára esik vissza, DE ezt a
// válasz `storage` mezője MEGMONDJA – nem hazudik sikert némán.

import { getStore } from "@netlify/blobs";

const STORE_NAME = "proscanner";
const K_TYPES = "types";
const K_HISTORY = "history";

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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
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

/** Útvonal-normalizálás: mindig `\` elválasztó, záró `\` nélkül. */
function normPath(p) {
  return String(p == null ? "" : p).trim().replace(/[/]+/g, "\\").replace(/\\+$/, "");
}

/** Teljes útvonal-e? `D:\...`, `\\szerver\...` vagy `/home/...` */
function isAbsPath(p) {
  const s = String(p == null ? "" : p).trim();
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\//.test(s);
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const route = routeOf(req.url);

  try {
    // ---- TÍPUSOK & ÚTVONALAK ------------------------------------------
    if (route === "/types") {
      if (req.method === "GET") {
        const { data, storage } = await loadJson(K_TYPES, DEFAULT_TYPES);
        if (!Array.isArray(data.docTypes) || data.docTypes.length === 0) {
          data.docTypes = [...DEFAULT_TYPES.docTypes];
        }
        data.pathSuggestions = data.pathSuggestions || {};
        return json({ ...data, storage });
      }

      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const { data: cur } = await loadJson(K_TYPES, DEFAULT_TYPES);
        cur.docTypes = Array.isArray(cur.docTypes) && cur.docTypes.length ? cur.docTypes : [...DEFAULT_TYPES.docTypes];
        cur.pathSuggestions = cur.pathSuggestions || {};

        if (Array.isArray(body.docTypes)) {
          body.docTypes.forEach((t) => {
            if (typeof t === "string" && t.trim() && !cur.docTypes.includes(t.trim())) cur.docTypes.push(t.trim());
          });
        }

        const added = [];
        const rejected = [];
        if (body.pathSuggestions && typeof body.pathSuggestions === "object") {
          for (const t of Object.keys(body.pathSuggestions)) {
            const list = body.pathSuggestions[t];
            if (!Array.isArray(list)) continue;
            if (!Array.isArray(cur.pathSuggestions[t])) cur.pathSuggestions[t] = [];
            for (const raw of list) {
              const p = normPath(raw);
              // CSAK TELJES ÚTVONALAT tárolunk (pl. D:\CsSzabj\PROHUMAN\összevont adóelőleg).
              // A puszta mappanév ("tp") használhatatlan javaslatként.
              if (!p || p.length < 3 || !isAbsPath(p)) { rejected.push(raw); continue; }
              if (!cur.pathSuggestions[t].includes(p)) { cur.pathSuggestions[t].push(p); added.push(p); }
            }
          }
        }

        const storage = await saveJson(K_TYPES, cur);
        return json({ success: true, storage, added, rejected, ...cur });
      }

      if (req.method === "DELETE") {
        // Elgépelt/rossz útvonal eltávolítása: /api/types?type=tp&path=D:\...
        const u = new URL(req.url);
        const t = u.searchParams.get("type");
        const p = normPath(u.searchParams.get("path"));
        const { data: cur } = await loadJson(K_TYPES, DEFAULT_TYPES);
        cur.pathSuggestions = cur.pathSuggestions || {};
        if (t && Array.isArray(cur.pathSuggestions[t])) {
          cur.pathSuggestions[t] = p ? cur.pathSuggestions[t].filter((x) => normPath(x) !== p) : [];
        }
        const storage = await saveJson(K_TYPES, cur);
        return json({ success: true, storage, ...cur });
      }
    }

    // ---- ELŐZMÉNYEK ---------------------------------------------------
    if (route === "/history" || route.startsWith("/history/")) {
      if (req.method === "GET") {
        const { data } = await loadJson(K_HISTORY, []);
        return json(Array.isArray(data) ? data : []);
      }

      if (req.method === "POST") {
        const entry = await req.json().catch(() => null);
        if (!entry || typeof entry !== "object") return json({ error: "Érvénytelen adat." }, 400);
        if (!entry.id) entry.id = "hist_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
        const { data } = await loadJson(K_HISTORY, []);
        const list = Array.isArray(data) ? data : [];
        list.unshift(entry);
        const storage = await saveJson(K_HISTORY, list.slice(0, 500));
        return json({ success: true, storage, item: entry }, 201);
      }

      if (req.method === "DELETE") {
        const id = route.startsWith("/history/") ? decodeURIComponent(route.slice("/history/".length)) : "";
        const { data } = await loadJson(K_HISTORY, []);
        const list = Array.isArray(data) ? data : [];
        const next = id ? list.filter((x) => x.id !== id) : [];
        const storage = await saveJson(K_HISTORY, next);
        return json({ success: true, storage, message: id ? `Törölve: ${id}` : "Összes előzmény törölve." });
      }
    }

    if (route === "/" || route === "") {
      return json({ name: "Prohuman Scanner API", version: "2.0.0", endpoints: ["/api/types", "/api/history"] });
    }

    return json({ error: "Ismeretlen végpont: " + route }, 404);
  } catch (err) {
    return json({ error: err && err.message ? err.message : String(err) }, 500);
  }
};
