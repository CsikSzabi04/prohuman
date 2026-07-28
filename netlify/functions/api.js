import express from "express";
import cors from "cors";
import serverless from "serverless-http";
import fs from "fs/promises";
import path from "path";

const app = express();
app.use(express.json());
app.use(cors());

const workDir = process.cwd();
const HISTORY_FILE = path.join(workDir, "history_api.json");
const TYPES_FILE = path.join(workDir, "types_api.json");

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

// ---- ELŐZMÉNYEK API -----------------------------------------------
app.get("/api/history", async (req, resp) => {
  try {
    const historyFromFile = await readJsonFile(HISTORY_FILE, null);
    if (historyFromFile !== null) {
      memoryHistory = historyFromFile;
      return resp.json(historyFromFile);
    }
    resp.json(memoryHistory);
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
    const typesFromFile = await readJsonFile(TYPES_FILE, null);
    if (typesFromFile !== null) {
      memoryTypes = typesFromFile;
      return resp.json(typesFromFile);
    }
    resp.json(memoryTypes);
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
            if (p && p.trim().length > 1 && !memoryTypes.pathSuggestions[t].includes(p.trim())) {
              memoryTypes.pathSuggestions[t].push(p.trim());
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
