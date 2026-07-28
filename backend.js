import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json());
app.use(cors());

const workDir = process.cwd();
const HISTORY_FILE = path.join(workDir, "history_api.json");
const TYPES_FILE = path.join(workDir, "types_api.json");

// Segédfüggvények JSON fájlok olvasásához és írásához
async function readJsonFile(filePath, defaultData = []) {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return defaultData;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ---- ELŐZMÉNYEK API (HISTORY) -----------------------------------

// 1. Összes előzmény lekérése
async function getHistory(req, resp) {
  try {
    const history = await readJsonFile(HISTORY_FILE, []);
    resp.send(history);
  } catch (err) {
    resp.status(500).send({ error: err.message });
  }
}

// 2. Új előzmény hozzáadása és mentése history_api.json-ba
async function postHistory(req, resp) {
  try {
    const newEntry = req.body;
    if (!newEntry || typeof newEntry !== "object") {
      return resp.status(400).send({ error: "Érvénytelen adat formátum." });
    }

    const history = await readJsonFile(HISTORY_FILE, []);

    // Ha nincs ID, generálunk egyet
    if (!newEntry.id) {
      newEntry.id = "hist_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
    }

    // Új elem mentése a lista elejére
    history.unshift(newEntry);

    // Max 500 elem tartása
    const trimmedHistory = history.slice(0, 500);

    await writeJsonFile(HISTORY_FILE, trimmedHistory);
    resp.status(201).send({ success: true, item: newEntry });
  } catch (err) {
    resp.status(400).send({ error: err.message });
  }
}

// 3. Előzmények törlése
async function delHistory(req, resp) {
  try {
    const { id } = req.params;
    if (id) {
      let history = await readJsonFile(HISTORY_FILE, []);
      history = history.filter(item => item.id !== id);
      await writeJsonFile(HISTORY_FILE, history);
      resp.send({ success: true, message: `Előzmény törölve: ${id}` });
    } else {
      await writeJsonFile(HISTORY_FILE, []);
      resp.send({ success: true, message: "Összes előzmény törölve." });
    }
  } catch (err) {
    resp.status(400).send({ error: err.message });
  }
}

// ---- DOKUMENTUM TÍPUSOK ÉS ÚTVONALAK API (TYPES & PATHS) ---------

// 1. Típusok és útvonal-javaslatok lekérése
async function getTypes(req, resp) {
  try {
    const typesData = await readJsonFile(TYPES_FILE, { docTypes: [], pathSuggestions: {} });
    resp.send(typesData);
  } catch (err) {
    resp.status(500).send({ error: err.message });
  }
}

// 2. Típusok és útvonal-javaslatok mentése / frissítése
async function postTypes(req, resp) {
  try {
    const { docTypes, pathSuggestions } = req.body;
    const currentData = await readJsonFile(TYPES_FILE, { docTypes: [], pathSuggestions: {} });

    if (Array.isArray(docTypes)) {
      currentData.docTypes = docTypes;
    }

    if (pathSuggestions && typeof pathSuggestions === "object") {
      currentData.pathSuggestions = currentData.pathSuggestions || {};
      Object.keys(pathSuggestions).forEach(t => {
        if (!currentData.pathSuggestions[t]) currentData.pathSuggestions[t] = [];
        const newPaths = pathSuggestions[t];
        if (Array.isArray(newPaths)) {
          newPaths.forEach(p => {
            if (!currentData.pathSuggestions[t].includes(p)) {
              currentData.pathSuggestions[t].push(p);
            }
          });
        }
      });
    }

    await writeJsonFile(TYPES_FILE, currentData);
    resp.send({ success: true, data: currentData });
  } catch (err) {
    resp.status(400).send({ error: err.message });
  }
}

// ---- ROUTE INICIALIZÁLÁS -----------------------------------------

app.get("/", (req, resp) => resp.send("<h1>Prohuman Scanner Backend v1.0.0</h1>"));

// Előzmények API végpontok
app.get("/api/history", getHistory);
app.post("/api/history", postHistory);
app.delete("/api/history/:id?", delHistory);

// Típusok & Útvonalak API végpontok
app.get("/api/types", getTypes);
app.post("/api/types", postTypes);

const PORT = process.env.PORT || 88;
app.listen(PORT, (err) => {
  if (err) console.log("Hiba a szerver indításakor:", err);
  else console.log(`🚀 Prohuman Scanner Backend fut a porton: http://localhost:${PORT}`);
});
