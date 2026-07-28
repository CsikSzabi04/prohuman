import express from "express";
import cors from "cors";
import serverless from "serverless-http";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

const rootDir = path.resolve(__dirname, "../../");
const HISTORY_FILE = path.join(rootDir, "history_api.json");
const TYPES_FILE = path.join(rootDir, "types_api.json");

let memoryHistory = [];
let memoryTypes = { docTypes: [], pathSuggestions: {} };

async function readJsonFile(filePath, defaultData = []) {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    return defaultData;
  }
}

async function writeJsonFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.log("File write info:", err);
  }
}

// Pre-load from disk if available
readJsonFile(HISTORY_FILE, []).then(d => { memoryHistory = d; });
readJsonFile(TYPES_FILE, { docTypes: [], pathSuggestions: {} }).then(d => { memoryTypes = d; });

// ---- ELŐZMÉNYEK API -----------------------------------------------
app.get("/api/history", async (req, resp) => {
  try {
    const history = memoryHistory.length ? memoryHistory : await readJsonFile(HISTORY_FILE, []);
    resp.json(history);
  } catch (err) {
    resp.status(500).json({ error: err.message });
  }
});

app.post("/api/history", async (req, resp) => {
  try {
    const newEntry = req.body;
    if (!newEntry || typeof newEntry !== "object") {
      return resp.status(400).json({ error: "Érvénytelen adat." });
    }

    if (!newEntry.id) {
      newEntry.id = "hist_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
    }

    memoryHistory.unshift(newEntry);
    if (memoryHistory.length > 500) memoryHistory = memoryHistory.slice(0, 500);

    await writeJsonFile(HISTORY_FILE, memoryHistory);
    resp.status(201).json({ success: true, item: newEntry });
  } catch (err) {
    resp.status(400).json({ error: err.message });
  }
});

app.delete("/api/history/:id?", async (req, resp) => {
  try {
    const { id } = req.params;
    if (id) {
      memoryHistory = memoryHistory.filter(item => item.id !== id);
    } else {
      memoryHistory = [];
    }
    await writeJsonFile(HISTORY_FILE, memoryHistory);
    resp.json({ success: true, message: "Sikeres törlés" });
  } catch (err) {
    resp.status(400).json({ error: err.message });
  }
});

// ---- DOKUMENTUM TÍPUSOK & ÚTVONALAK API ---------------------------
app.get("/api/types", async (req, resp) => {
  try {
    const typesData = memoryTypes.docTypes && memoryTypes.docTypes.length
      ? memoryTypes
      : await readJsonFile(TYPES_FILE, { docTypes: [], pathSuggestions: {} });
    resp.json(typesData);
  } catch (err) {
    resp.status(500).json({ error: err.message });
  }
});

app.post("/api/types", async (req, resp) => {
  try {
    const { docTypes, pathSuggestions } = req.body;
    if (Array.isArray(docTypes)) {
      memoryTypes.docTypes = docTypes;
    }
    if (pathSuggestions && typeof pathSuggestions === "object") {
      memoryTypes.pathSuggestions = memoryTypes.pathSuggestions || {};
      Object.keys(pathSuggestions).forEach(t => {
        if (!memoryTypes.pathSuggestions[t]) memoryTypes.pathSuggestions[t] = [];
        const newPaths = pathSuggestions[t];
        if (Array.isArray(newPaths)) {
          newPaths.forEach(p => {
            if (!memoryTypes.pathSuggestions[t].includes(p)) {
              memoryTypes.pathSuggestions[t].push(p);
            }
          });
        }
      });
    }
    await writeJsonFile(TYPES_FILE, memoryTypes);
    resp.json({ success: true, data: memoryTypes });
  } catch (err) {
    resp.status(400).json({ error: err.message });
  }
});

app.get("/", (req, resp) => resp.send("<h1>Prohuman Scanner Netlify API v1.0.0</h1>"));

export const handler = serverless(app);
