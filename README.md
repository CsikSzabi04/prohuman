# Prohuman Scanner — szkennelt dokumentum átnevező és áthelyező

Böngészőben futó munkaeszköz szkennelt HR-dokumentumok tömeges rendszerezéséhez.
Megnyit egy mappát, sorra veszi a beszkennelt fájlokat, OCR-rel kiolvassa belőlük
a nevet és az érvényességet, majd egységes névre átnevezve átmozgatja őket a
dokumentumtípushoz tartozó célmappába.

```
uj-táppénzes-igazolás-202102-minta másolata (19) másolata.psd
        ↓  OCR + űrlap + típusválasztás
Kovács János tp 2026.06.20-06.28.psd   →   D:\CsSzabj\PROHUMAN\tp\
```

**A beszkennelt dokumentum tartalma soha nem hagyja el a gépet** — az OCR és az
előnézet is helyben fut. Az *előzmény* és az *útvonal-javaslatok* viszont egy
közös API-ba is mentődnek, hogy több gép ugyanazt lássa.

---

## Tartalomjegyzék

1. [Gyorsindítás](#1-gyorsindítás)
2. [Fájlhierarchia](#2-fájlhierarchia)
3. [Architektúra](#3-architektúra)
4. [Technológiák — mit mire használunk és miért](#4-technológiák-mit-mire-használunk-és-miért)
5. [Adatfolyam](#5-adatfolyam)
6. [Fájlnév-szabályok](#6-fájlnév-szabályok)
7. [Célmappa-feloldás](#7-célmappa-feloldás)
8. [Biztonsági modell](#8-biztonsági-modell)
9. [Adatvédelem / GDPR](#9-adatvédelem-gdpr)
10. [Tesztelés és ellenőrzés](#10-tesztelés-és-ellenőrzés)
11. [Hibaelhárítás](#11-hibaelhárítás)
12. [Karbantartás](#12-karbantartás)
13. [Ismert korlátok](#13-ismert-korlátok)

---

## 1. Gyorsindítás

Nyisd meg az `index.html`-t **Chrome** vagy **Edge** böngészőben. Ennyi.

Nincs telepítés, nincs bejelentkezés, nincs jelszó. Az átnevezés és áthelyezés
azonnal működik; az előzmény a közös API-val is szinkronizálódik.

> A Firefox és a Safari **nem** támogatja a File System Access API-t,
> így ott az alkalmazás nem tud fájlt mozgatni.

### Hol tárolódnak az adatok

| Adat | Hol | Megjegyzés |
|---|---|---|
| Előzmény | `localStorage` | max. 500 bejegyzés |
| Dokumentumtípusok és sorrendjük | `localStorage` | |
| Útvonal-javaslatok | `localStorage` | csak bizonyítottan működő útvonal kerül be |
| A megnyitott mappa gyökér-útvonala | `localStorage` | egyszer kérdezi meg |
| Célmappa-engedélyek | `IndexedDB` | ez őrzi meg a hozzáférést újraindítás után |

A böngészőben tárolt adat **profilonként külön** van. Az előzmény és az
útvonal-javaslatok ezen felül a közös API-ba is felkerülnek — így egy másik
gépen ugyanazok jelennek meg. Kézi átvitelhez az Előzmény ablak
**JSON Export** / **JSON Import** gombjai is használhatók.

### Ha törölni akarod az adatokat

| Mit | Hogyan |
|---|---|
| Csak az előzményt | Előzmény ablak → **Törlés** |
| Mindent | Böngésző → `F12` → Application → Storage → **Clear site data** |

---

## 2. Fájlhierarchia

```
prohuman-scanner/
│
├── index.html                  ← A TELJES KLIENS (~2450 sor, nulla build-lépés)
│   ├── <style>                    CSS: rács-elrendezés, modálok, töréspontok
│   ├── <body>                     Háromhasábos felület + 2 modális ablak
│   └── <script>                   Az összes logika egyetlen IIFE-ben:
│       ├── Konfiguráció           dokumentumtípusok, időcsoportok, kiterjesztések
│       ├── API-réteg              apiFetch — PONTOSAN egy végpont
│       ├── Típus-sorok            célmappák, drag&drop sorrend, javaslat-legördülő
│       ├── Mappa & fájllista      File System Access API, mtime szerinti csoportosítás
│       ├── Előnézet               PDF/PSD/TIFF/kép renderelés, nagyítás, pásztázás
│       ├── OCR                    Tesseract worker, szöveg → űrlapmezők
│       ├── Névépítés              tisztítás, ütközéskezelés
│       ├── Áthelyezés             doFinish() — a fő munkafolyamat
│       ├── Előzmény               DOM-alapú lista, JSON export/import
│       └── IndexedDB              mappa-engedélyek megőrzése újraindítás után
│
├── backend.js                  ← Helyi API (Express, CSAK 127.0.0.1)
├── netlify/functions/api.js    ← Éles API (Netlify Function v2 + Blobs)
├── netlify.toml                ← Build, /api/* átirányítás, biztonsági fejlécek
├── package.json                ← Csak a backendhez (a kliensnek nulla függősége van)
├── package-lock.json
├── types_api.json              ← A helyi backend adatfájlja
│
├── .gitignore                  ← history_api.json KI van zárva (személyes adat!)
└── README.md                   ← Ez a fájl
```

### Miért egyetlen `index.html`?

A teljes alkalmazás **egy fájl, nulla build-lépés**. Ez tudatos döntés:

- **Hordozható** — átmásolható USB-re, hálózati meghajtóra, e-mailben küldhető.
- **Nincs mitől elavulni** — nincs bundler, nincs `node_modules`, ami fél év
  múlva nem fordul le.
- **Ellenőrizhető** — az egész alkalmazás egyetlen fájlban elolvasható.
- **Offline is teljes értékű** — csak az OCR nyelvi modell igényel netet, azt
  is csak az első futáskor.

---

## 3. Architektúra

```
┌────────────────────────────────────────────────────────────────┐
│  BÖNGÉSZŐ  (Chrome / Edge)                                     │
│                                                                │
│      ├── File System Access API ──────► a felhasználó lemeze   │
│      │      showDirectoryPicker() · getDirectoryHandle()       │
│      │      FileSystemFileHandle.move()                        │
│      │                                                         │
│      ├── IndexedDB ("scanRenamer") ──► mappa-ENGEDÉLYEK        │
│      │      docDir_<típus> · lastDir                           │
│      │                                                         │
│      ├── localStorage ────────────────► helyi másolat          │
│      │      docTypes · docPaths · year · rootAbsPath · history │
│      │                                                         │
│      └── apiFetch() ──────────────────► /api/types             │
│             PONTOSAN EGY végpont         /api/history          │
└────────────────────────────────────────────┼───────────────────┘
                                             │
                  ┌──────────────────────────┴──────────────────────┐
        ┌─────────▼──────────┐                        ┌─────────────▼────────────┐
        │  ÉLES              │                        │  HELYI FEJLESZTÉS        │
        │  Netlify Function  │                        │  backend.js (Express)    │
        │        │           │                        │  csak 127.0.0.1:8788     │
        │  Netlify Blobs     │                        │  *.json (atomi írás)     │
        └────────────────────┘                        └──────────────────────────┘
```

**Két backend, azonos szerződéssel.** A validáló szabályaik (`normPath`,
`isAbsPath`, mezőfehérlista, limitek) **szándékosan azonosak** — különben a
helyben működő dolog éles környezetben elszállna.

A **dokumentum tartalma** soha nem megy ki: az OCR (Tesseract WASM) és az
előnézet (pdf.js, ag-psd, UTIF) is a böngészőben fut.

---

## 4. Technológiák — mit mire használunk és miért

### Kliensoldal (ez fut ténylegesen)

| Technológia | Verzió | Mire használjuk | Miért ez |
|---|---|---|---|
| **File System Access API** | böngésző natív | Mappák olvasása, fájlok átnevezése és áthelyezése | Az egyetlen webes szabvány, amivel a böngésző **helyben** tud fájlt mozgatni. Nincs feltöltés, a dokumentum el sem hagyja a gépet. |
| **Tesseract.js** | 5.1.0 | OCR — `hun+eng` nyelvi modellel | WASM-ra fordított Tesseract, ami a böngészőben fut. A szkennelt kép **nem megy fel semmilyen szerverre** — HR-dokumentumoknál ez alapkövetelmény. |
| **pdf.js** | 3.11.174 | PDF első oldalának canvas-ra renderelése | A Mozilla referencia-implementációja; a böngésző beépített PDF-nézete is ezt használja. Canvas-kimenetet ad, amit az OCR közvetlenül feldolgoz. |
| **ag-psd** | 31.0.2 | Photoshop `.psd` beágyazott előnézet kiolvasása | Sok szkenner PSD-t készít. A `skipLayerImageData` opcióval csak az összeolvasztott képet olvassa — nagyságrendekkel gyorsabb. |
| **UTIF.js** | 3.1.0 | TIFF dekódolás | A TIFF a szkennerek másik gyakori kimenete, és a böngészők natívan **nem** támogatják. |
| **IndexedDB** | böngésző natív | `FileSystemDirectoryHandle` objektumok tárolása | A `localStorage` csak szöveget tud. A mappa-engedélyt hordozó handle strukturált objektum — csak IndexedDB képes megőrizni újraindítás után. |
| **localStorage** | böngésző natív | Előzmény, típusok, útvonalak, beállítások | Egyszerű kulcs-érték adatokhoz elegendő, szinkron elérésű. |
| **Intl.Collator** | böngésző natív | Magyar ábécé szerinti, számérzékeny rendezés | `{ numeric: true }` mellett a `kép2` a `kép10` elé kerül — a naiv szövegrendezés fordítva tenné. |

### Szerveroldal

| Technológia | Verzió | Szerep | Miért ez |
|---|---|---|---|
| **Netlify Functions v2** | platform | Éles API | Szerver nélküli üzemeltetés. A v2 a szabványos `Request`/`Response` objektumokat használja, nem a régi `event`/`context` párost. |
| **Netlify Blobs** | 10.7.10 | Perzisztens tárolás | **Ez nem stílusdöntés volt:** a Functions fájlrendszere a `/tmp`-n kívül írásvédett, és minden hívás más konténerben futhat. A korábbi `fs.writeFile()` `EROFS`-szal elszállt, a memóriában tartott adat pedig a konténerrel együtt eltűnt — ezért adott a `GET /api/types` mindig üres eredményt. A válasz `storage` mezője megmondja, hova került az adat: nem hazudik sikert némán. |
| **Express** | 4.19.2 | Helyi API | Ismert, stabil, minimális kód. Csak a `127.0.0.1`-en figyel. |
| **cors** | 2.8.5 | CORS-fejlécek allowlisttel | Kézi fejléckezelés helyett bevált megoldás, preflight-kezeléssel. |

### Ami tudatosan **nincs**

- **Nincs build-lépés** — se webpack, se Vite, se TypeScript-fordítás.
- **Nincs kliensoldali keretrendszer** — se React, se Vue. A dinamikus rész
  (típus-sorok, előzmény) sima DOM API-val épül.
- **Nincs adatbázis** — a Netlify Blobs, illetve JSON-fájlok elegendők ehhez a mérethez.
- **Nincs telemetria, nincs analitika, nincs hibajelentő szolgáltatás.**
- **Nincs `serverless-http`** — a v2-es függvény nem használja (felesleges
  függőség = felesleges támadási felület).

---

## 5. Adatfolyam

Egy dokumentum teljes útja:

```
1.  Mappa kiválasztása
      showDirectoryPicker({mode:"readwrite"})
      → engedélykérés
      → idbSet("lastDir", handle)         [folytatáshoz]
      → askRootAbsPath()                  [a gyökér teljes útvonala, egyszer]
      → listFiles()

2.  Fájlok beolvasása
      Ha van "scan" almappa → abból olvas, különben a gyökérből
      Szűrés: csak támogatott kiterjesztések
      Csoportosítás lastModified szerint (30 perc … 3 napnál régebbi)
      Rendezés: csoport, majd magyar természetes sorrend

3.  Fájl kiválasztása
      selectToken++ ─── versenyvédelem
      Kiterjesztés szerint: pdf.js / ag-psd / UTIF / <img>
      → canvas vagy blob-URL → nagyítható előnézet

4.  OCR (opcionális)
      Tesseract worker (újrahasznosított, nem indul újra fájlonként)
      → guessName()     "Név: Kovács János" minta, majd nagybetűs sorpár
      → findValidity()  dátumtartomány felismerése
      → csak ÜRES mezőt tölt ki, a kézi bevitelt nem írja felül

5.  Kitöltés
      Név  +  Típus (célmappával)  +  Érvényesség
      Élő előnézet: az új fájlnév és a célmappa

6.  Kész  →  doFinish()
      isFinishing zár ────────── dupla végrehajtás ellen
      ├── kötelező mezők ellenőrzése (piros kiemelés)
      ├── getTargetDirectoryHandle()   ← lásd 7. fejezet
      ├── uniqueNameInDir()            ← ütközés esetén " (2)", " (3)" …
      ├── moveFileToDirectory()        ← handle.move(), fallback: másolás+törlés
      │
      │   ═══ A FÁJL EKKOR MÁR A HELYÉN VAN ═══
      │
      ├── absPathForTarget()           ← a valódi teljes útvonal kiszámítása
      ├── savePathSuggestionForType()  ← CSAK MOST jegyezzük meg (localStorage)
      ├── addHistoryEntry()            ← localStorage
      └── goNext()
```

**Miért csak a sikeres áthelyezés után jegyezzük meg az útvonalat?** Mert egy
javaslat csak akkor ér valamit, ha bizonyítottan működik. A korábbi verziók
blur/paste eseményre is mentettek — így elgépelt, sosem létező útvonalak
kerültek be a javaslatok közé, és onnan már nem lehetett kiszedni őket.

---

## 6. Fájlnév-szabályok

```
{Név} {Típus} {Érvényesség}.{eredeti kiterjesztés}
```

Például: `Kovács János tp 2026.06.20-06.28.psd`

Az „Egyben" mező felülír mindent — ha kitöltöd, a fájlnév pontosan az lesz.

### Tisztítás

| Szabály | Példa |
|---|---|
| Windows tiltott karakterek eltávolítása | `Kovács: tp?` → `Kovács tp` |
| Vezérlőkarakterek (`0x00–0x1F`, `0x7F`) | OCR-hulladék kiszűrése |
| Többszörös szóköz összevonása | `Kovács␣␣␣János` → `Kovács János` |
| Záró pont **és szóköz** levágása | `Kovács tp...` → `Kovács tp` |
| Windows fenntartott nevek | `CON` → `_CON` (`PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) |
| Hosszkorlát | 180 karakter (marad hely a kiterjesztésnek és az ütközés-utótagnak) |

A **záró szóköz** és a **fenntartott nevek** kezelése nem elméleti: az NTFS a
záró szóközt csendben levágja, ezért a duplikátum-ellenőrzés más nevet látna,
mint ami a lemezre kerül. `CON.pdf` nevű fájlt pedig a Windows egyszerűen
nem enged létrehozni.

### Ütközéskezelés

Ha a célmappában már létezik a név, `" (2)"`, `" (3)"` … utótag kerül rá.
Ha viszont a talált fájl **maga a most mozgatott fájl** (`isSameEntry`),
akkor nincs utótag — így az újra-átnevezés nem hoz létre duplikátumot.

---

## 7. Célmappa-feloldás

Ez a projekt legkényesebb pontja. A böngésző **biztonsági okból nem adja meg**
a kiválasztott mappa abszolút útvonalát — csak a nevét (`"tp"`). Ezért egyszer
megkérdezzük a gyökér teljes útvonalát, és onnantól számoljuk.

A `getTargetDirectoryHandle()` sorrendje:

```
1.  Van mentett mappa-engedély a típushoz?   idbGet("docDir_<típus>")
        ↓ nincs
2.  A megadott útvonal feloldható a gyökér alól?
        pathSegmentsUnderRoot()
        ├── relatív ("tp")                        → ["tp"]
        ├── abszolút, a gyökér ALATT              → a gyökér utáni szegmensek
        └── abszolút, MÁSHOL                      → null  ⇒ rákérdezünk
        ↓ feloldható
    resolveDirPath() — MINDEN szegmenst végigjár, létrehozva
        ↓ nem oldható fel
3.  Nincs útvonal → a típus nevű almappa
        ↓
4.  pickTargetDir() — explicit mappaválasztás, majd elmentjük a típushoz
```

### A javított hiba

A korábbi kód így dolgozott:

```js
const parts = clean.split("/").filter(p => p && !p.includes(":") && p !== ".");
let targetFolderName = parts[parts.length - 1];              // ← CSAK AZ UTOLSÓ!
return await dirHandle.getDirectoryHandle(targetFolderName, { create: true });
```

Vagyis ha megnyitottad a `D:\szkennelt` mappát, és célnak beírtad, hogy
`D:\CsSzabj\PROHUMAN\tp`, a kód ebből **csak a `tp`-t** vette, és létrehozott
egy új mappát: `D:\szkennelt\tp`. A dokumentum oda került — miközben a felület
és az előzmény is azt írta ki, hogy `D:\CsSzabj\PROHUMAN\tp`.

Az új változat a **teljes útvonalat** végigjárja, és ha az nem a megnyitott
gyökér alatt van, **nem tippel** — megkérdezi a felhasználót.

### Útvonal-normalizálás

Két esetet külön kell kezelni, különben a normalizálás elrontja őket:

| Bemenet | Naiv normalizálás | Helyes | Miért számít |
|---|---|---|---|
| `\\fileserver\HR\tp` | `\fileserver\HR\tp` ✗ | `\\fileserver\HR\tp` | A vezető **két** elválasztó egyre olvadt, így az `isAbsPath` nem ismerte fel. Céges környezetben ez a leggyakoribb útvonalforma. |
| `/mnt/share/tp` | `\mnt\share\tp` ✗ | `/mnt/share/tp` | A `/` → `\` csere után elbukott az abszolút-teszten, noha a kód elvileg támogatja a POSIX utakat. |

---

## 8. Biztonsági modell

### ⚠️ Az API nyilvános és nem kér hitelesítést

Ez tudatos, üzemeltetői döntés — a napi használatot nem akadályozza jelszó.
Amit viszont **tudni kell**, mert a következménye valós:

```console
$ curl https://proscanner.netlify.app/api/history
[{ "personName": "...", "type": "tp", "targetPath": "D:\...\tp" }, ...]
```

Aki ismeri a végpont címét, **hitelesítés nélkül elolvashatja az előzményt** —
benne a személynevekkel, a dokumentumtípussal és a belső mappaszerkezettel.
A `tp` (táppénz) egészségügyi adat, amit a GDPR 9. cikke **különleges
kategóriaként** kezel.

**Ha ez nem vállalható, három út van:**

| Megoldás | Mit kell tenni | Hatás |
|---|---|---|
| Ne menjen ki személynév | A `doFinish`-ben ne kerüljön `personName` az `addHistoryEntry` hívásba | Az útvonal-szinkron megmarad, a név nem megy ki |
| Csak helyi működés | Az `apiFetch` hívások eltávolítása; marad a JSON Export/Import | Semmi nem hagyja el a gépet |
| Hitelesítés | Megosztott kulcs vagy SSO a végpontokon | Napi használatnál plusz lépés |

A projekt korábbi verziójában ez **ellenőrzött incidens** volt: valódi
személy táppénz-adata volt publikusan olvasható. A rekordot töröltük, de a
végpont továbbra is nyitott.

### A dokumentum tartalma soha nem megy ki

Az OCR (Tesseract WASM), a PDF/PSD/TIFF renderelés és az előnézet **teljes
egészében a böngészőben** fut. A beszkennelt kép nem kerül fel semmilyen
szerverre — HR-dokumentumoknál ez alapkövetelmény.

Csak strukturált **metaadat** megy az API-ba: fájlnevek, személynév, típus,
érvényesség, célmappa.

### Tárolt XSS lezárása

Az eredeti hiba: az `item.id` escape nélkül került egy inline attribútumba
(`onclick="copyPathForHistory('${item.id}')"`), miközben az `id` jöhetett
JSON-importból vagy az API-ból is. Egy `{"id": "');alert(1);//"}` bejegyzés
tetszőleges kódot futtatott mindenkinél, aki megnyitotta az előzményeket —
egy olyan oldalon, aminek **írási hozzáférése van a fájlrendszerhez**.

A javítás: az előzménylista `createElement` + `textContent` alapon épül.
Nincs HTML-összefűzés, nincs `innerHTML`, nincs inline `onclick`. A gombok
closure-ön keresztül kapják meg az objektumot, így az `id` soha nem kerül
értelmezhető kontextusba. Ellenőrzés:

```bash
grep -cE '<[^>]*onclick=' index.html   # → 0  (nincs HTML-attribútum kezelő)
grep -c 'window\.[a-zA-Z]* *=' index.html  # → 0  (nincs globális, minden IIFE-ben)
```

> A sima `grep -c 'onclick="'` egyet talál — az a javítást magyarázó
> **komment**, nem működő kód. Ezért kell a tagen belüli előfordulásra szűrni.

Ezen felül minden kívülről érkező előzmény (JSON-import) áthalad a
`sanitizeHistoryItem` fehérlistán: csak az ismert mezők maradnak, szövegre
kényszerítve, hosszkorláttal, vezérlőkarakterek nélkül.

### Ellátási lánc (supply chain)

Mind a négy CDN-szkript **verzióra pinelve** és **SHA-384 SRI hash-sel** védve:

```html
<script src="https://cdn.jsdelivr.net/npm/ag-psd@31.0.2/dist/bundle.js"
        integrity="sha384-9dhx2Gx3cKvCuBJwLZxPUmqz77LqKJIAzYABzUhCaCPDK5Rz+CFt6/jeKu84tBA6"
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
```

Az `ag-psd` korábban **verzió nélkül** (`npm/ag-psd`) töltődött, tehát mindig a
legfrissebbet kapta — ami bármikor, figyelmeztetés nélkül megváltozhatott.
Egy fájlrendszer-jogosultságú oldalon ez nem apróság: egyetlen kompromittált
CDN-csomag teljes lemez-hozzáférést jelentene. Az `integrity` miatt a böngésző
eldobja a szkriptet, ha akár egyetlen bájt is más.

### A szerveroldal megerősítései

Hitelesítés nincs, de minden más védelem a helyén van:

- **A kliens `id`-jét eldobjuk**, a szerver generál sajátot — ez vágta el a
  tárolt XSS forrását.
- **Bemenet-fehérlista**: csak az ismert mezők maradnak meg, szövegre
  kényszerítve, hosszkorláttal, vezérlőkarakterek nélkül.
- **Mennyiségi limitek**: 500 előzmény, 200 típus, 50 útvonal/típus,
  128 kB kérés-törzs.
- **Csak abszolút útvonal tárolható** — a puszta mappanév használhatatlan.
- **CORS allowlist**, nem `*`.
- **A helyi backend csak a `127.0.0.1`-en figyel.** Korábban minden hálózati
  interfészen, nyitott CORS mellett — vagyis a céges wifin bárki lekérhette a
  teljes előzményt.
- **Atomi fájlírás** (ideiglenes fájl + `rename`) és **soros végrehajtás**
  (`withLock`): két párhuzamos kérés nem írja felül egymást, és egy megszakadt
  írás sem hagy csonka JSON-t.
- **Nincs stack trace a hibaválaszokban.** A kliens hibája `400`/`413`,
  a szerveré általános `500`.

Ellenőrizve, 25 párhuzamos íráson: **25/25 bejegyzés megmaradt**.

### Forrásfájlok elzárása

A `publish = "."` a repó gyökerét tenné közzé, ezért a `netlify.toml`
`force = true` átirányításai `404`-re állítják a `backend.js`,
`package.json`, `types_api.json` és `netlify/*` útvonalakat.

> **A GitHub Pages ezt nem tudja.** Ha a repót onnan is kiszolgálod, ott
> minden fájl letölthető. Ezért van a `history_api.json` a `.gitignore`-ban:
> személyes adatot tartalmazna, és verziókövetésbe kerülve visszavonhatatlanul
> bekerülne a git-történetbe.

### HTTP biztonsági fejlécek (`netlify.toml`)

Csak akkor érvényesek, ha az oldalt a Netlifyről szolgálják ki — `file://`
megnyitásnál nincs HTTP-válasz, tehát CSP sincs.

| Fejléc | Szerep |
|---|---|
| `Content-Security-Policy` | Fehérlista a betölthető erőforrásokra |
| `X-Frame-Options: DENY` | Clickjacking elleni védelem |
| `X-Content-Type-Options: nosniff` | A böngésző ne találgassa a tartalomtípust |
| `Referrer-Policy: no-referrer` | Fájlnevek/útvonalak ne szivárogjanak |
| `Permissions-Policy` | Kamera, mikrofon, helyadat kikapcsolva |

Az `/api/*` válaszokra külön `Cache-Control: no-store` szabály vonatkozik —
személyes adat soha ne kerüljön köztes gyorsítótárba.

---

## 9. Adatvédelem / GDPR

### Milyen személyes adatot kezel

| Adat | Hol | Hova jut |
|---|---|---|
| **Személynév** | űrlap, fájlnév, előzmény | localStorage **+ a közös API** |
| **Dokumentumtípus** | előzmény | ugyanoda |
| **Érvényességi időszak** | előzmény | ugyanoda |
| **Fájlnevek** | előzmény | ugyanoda |
| **Lemezes útvonalak** | javaslatok | ugyanoda |
| **A dokumentum tartalma** | csak a memóriában | **sehova** — sem az OCR, sem az előnézet nem tölt fel semmit |

### Amit tudni kell

- A `tp` (táppénz) típus **egészségügyi adat** → GDPR 9. cikk, különleges
  kategória, szigorúbb szabályokkal.
- **A metaadat külső adatfeldolgozóhoz kerül** (Netlify Blobs). Ehhez
  adatfeldolgozói szerződés (DPA) és az adatkezelési nyilvántartásban való
  feltüntetés szükséges.
- **A végpont hitelesítés nélkül olvasható** — lásd
  [8. Biztonsági modell](#8-biztonsági-modell). Ez a legfontosabb nyitott
  kockázat; a mérlegelés az adatkezelő felelőssége.
- **Az előzményt bárki elolvashatja, aki a géphez hozzáfér.** A `localStorage`
  nincs titkosítva.
- A `history_api.json` `.gitignore`-ban van, mert a helyi backend személyes
  adatot írna bele. Verziókövetésbe kerülve visszavonhatatlanul bekerülne a
  git-történetbe.


---

## 10. Tesztelés és ellenőrzés

### Szintaxis-ellenőrzés

```bash
npm run check      # backend.js + netlify/functions/api.js
```

### A szerveroldali védelmek ellenőrzése

Indítsd a backendet (`npm start`), majd:

```bash
B=http://127.0.0.1:8788

# A kliens által küldött id-t el kell dobni (ez volt a tárolt XSS forrása)
curl -s -X POST -H 'Content-Type: application/json'      -d '{"id":"<img src=x onerror=alert(1)>","personName":"Teszt"}' $B/api/history
# Az item.id-nek szerver által generált hist_<idő>_<hex> értéknek kell lennie

# Ismeretlen mezőt el kell dobni
curl -s -X POST -H 'Content-Type: application/json'      -d '{"gonoszMezo":"x","personName":"Teszt"}' $B/api/history

# Csak abszolút útvonal tárolható
curl -s -X POST -H 'Content-Type: application/json'      -d '{"pathSuggestions":{"x":["tp","D:\\A\\B"]}}' $B/api/types
# added: ["D:\A\B"]   rejected: ["tp"]

# Hibás JSON → 400, stack trace nélkül
curl -s -o /dev/null -w '%{http_code}
' -X POST      -H 'Content-Type: application/json' -d '{ rossz' $B/api/history
```

### A CDN-ek sértetlensége

```bash
grep -c 'integrity="sha384-' index.html     # → 4
grep -cE '<[^>]*onclick=' index.html        # → 0  (nincs inline kezelő)
grep -c 'window.[a-zA-Z]* *=' index.html   # → 0  (nincs globális)
```

### Kézi teszt-forgatókönyvek

| Mit | Elvárt eredmény |
|---|---|
| Mappaválasztás | Betöltődik a fájllista, nincs hibasáv |
| Gyors kattintás két fájl között | Mindig a **kijelölt** fájl előnézete látszik |
| Kétszeri gyors Enter a Kész gombon | Egyetlen áthelyezés, egyetlen előzmény-bejegyzés |
| Teljes útvonal beírása, ami a nyitott mappán kívül van | Mappaválasztó nyílik, **nem** hoz létre almappát |
| Típus átnevezése | A hozzárendelt célmappa megmarad |
| Több száz kép végignézése | A memóriahasználat nem nő monoton |
| `CON` név megadása | `_CON` lesz belőle, a mentés nem száll el |

---

## 11. Hibaelhárítás

| Tünet | Ok | Megoldás |
|---|---|---|
| „Ez a böngésző nem támogatja a mappa-elérést" | Firefox / Safari | Chrome vagy Edge |
| Az OCR nem indul | CDN-blokk vagy hálózati hiba | Konzol: SRI-hiba? Lásd [13. Karbantartás](#12-karbantartás) |
| Az OCR lassú az első futáskor | A nyelvi modell letöltése (~15 MB) | Egyszeri, utána gyorsítótárazott |
| A fájl rossz mappába került | **Javítva** — régi verzió | Frissítsd az `index.html`-t |
| „Nem érhető el a célmappa" | Lejárt mappa-engedély | „Mappa…" gomb újbóli használata |
| Eltűnt az előzmény | Böngésző-adatok törlése, más profil, inkognitó | A `localStorage` profilonként külön; JSON Exporttal menthető |
| „Az útvonalat nem sikerült megjegyezni" | Tele a `localStorage` | Előzmény ablak → Törlés, vagy régi bejegyzések exportálása |

---

## 12. Karbantartás

### CDN-verzió frissítése

Az SRI hash a fájl tartalmához kötött — **verzióváltáskor újra kell számolni**,
különben a böngésző (helyesen) megtagadja a betöltést.

```bash
curl -sL "https://cdn.jsdelivr.net/npm/ag-psd@31.0.2/dist/bundle.js" \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

Az eredményt `sha384-` előtaggal írd az `integrity` attribútumba.

### Új dokumentumtípus

A felületről: **+** gomb. Kódból: `DEFAULT_TYPES` az `index.html`-ben.

Ha az új típushoz **kötelező** az érvényesség, vedd fel a
`VALIDITY_REQUIRED_TYPES` tömbbe is.

## 13. Ismert korlátok

| Korlát | Részletek |
|---|---|
| **Csak Chromium** | A File System Access API-t a Firefox és a Safari nem támogatja. |
| **Windows-központú** | A tisztítás a Windows tiltólistáját és fenntartott neveit követi; az útvonalak `\` elválasztóval normalizálódnak. POSIX abszolút út kezelve, de nem ez az elsődleges eset. |
| **Az előzmény nincs titkosítva** | Aki a géphez hozzáfér, elolvashatja. A munkaállomás védelme a megoldás. |
| **Gépenként külön előzmény** | Nincs automatikus szinkron; JSON Export/Import a kézi út. |
| **A böngésző adattörlése mindent visz** | Beleértve az előzményt és a mappa-engedélyeket. Rendszeres JSON Export ajánlott. |
| **A gyökér útvonalát kézzel kell megadni** | A böngésző nem adja ki; `prompt()`-tal kérdezzük meg, egyszer. |
| **Nincs visszavonás** | Az áthelyezés végleges. Az előzmény rögzíti, hova került a fájl, de nem tudja visszamozgatni. |
| **Az OCR internetet igényel** | A Tesseract nyelvi modellje CDN-ről töltődik (első futáskor). A fájlkezelés enélkül is teljes értékű. |
