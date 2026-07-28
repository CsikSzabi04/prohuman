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

**Az alkalmazás semmilyen adatot nem küld ki a gépről.** Nincs bejelentkezés,
nincs jelszó, nincs szerver — a dokumentumok és a személyes adatok végig helyben
maradnak.

---

## Tartalomjegyzék

1. [Gyorsindítás](#1-gyorsindítás)
2. [⚠️ Egyszeri teendő a régi telepítés miatt](#2-️-egyszeri-teendő-a-régi-telepítés-miatt)
3. [Fájlhierarchia](#3-fájlhierarchia)
4. [Architektúra](#4-architektúra)
5. [Technológiák — mit mire használunk és miért](#5-technológiák--mit-mire-használunk-és-miért)
6. [Adatfolyam](#6-adatfolyam)
7. [Fájlnév-szabályok](#7-fájlnév-szabályok)
8. [Célmappa-feloldás](#8-célmappa-feloldás)
9. [Biztonsági modell](#9-biztonsági-modell)
10. [Adatvédelem / GDPR](#10-adatvédelem--gdpr)
11. [Tesztelés és ellenőrzés](#11-tesztelés-és-ellenőrzés)
12. [Hibaelhárítás](#12-hibaelhárítás)
13. [Karbantartás](#13-karbantartás)
14. [Ismert korlátok](#14-ismert-korlátok)

---

## 1. Gyorsindítás

Nyisd meg az `index.html`-t **Chrome** vagy **Edge** böngészőben. Ennyi.

Nincs telepítés, nincs `npm install`, nincs szerver, nincs jelszó.

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

Mindez **böngészőnként és felhasználói profilonként külön** van. Másik gépre
átvinni az Előzmény ablak **JSON Export** / **JSON Import** gombjaival lehet.

### Ha törölni akarod az adatokat

| Mit | Hogyan |
|---|---|
| Csak az előzményt | Előzmény ablak → **Törlés** |
| Mindent | Böngésző → `F12` → Application → Storage → **Clear site data** |

---

## 2. ⚠️ Egyszeri teendő a régi telepítés miatt

A mostani kliens nem használ API-t. **De a Netlifyre korábban feltöltött
függvény még élhet, és a régi adat még benne lehet.**

Ez ellenőrzött, nem elméleti probléma volt: a `GET /api/history` végpont
hitelesítés nélkül, a nyílt internetről kiadta a teljes előzményt — benne
valódi **személynevekkel**, dokumentumtípussal és a belső mappaszerkezettel.
A `tp` = **táppénz**, azaz egészségügyi adat, amit a GDPR 9. cikke
**különleges kategóriaként** kezel.

> A konkrét kiszivárgott rekordot itt szándékosan nem közöljük — ez a fájl
> nyilvános repóban van.

### A lezárás sorrendje — ez a sorrend számít

**1. Előbb töröld a kint lévő adatot.** A jelenleg élő függvény még
hitelesítés nélkül fogadja a kérést, tehát ez most még működik:

```bash
curl -X DELETE https://proscanner.netlify.app/api/history
curl -X DELETE "https://proscanner.netlify.app/api/types?type=tp"
```

Ellenőrzés — üres tömböt kell kapnod:

```bash
curl https://proscanner.netlify.app/api/history
```

**2. Utána zárd le a végpontot.** Két lehetőség:

| Megoldás | Hogyan | Eredmény |
|---|---|---|
| **Ajánlott: teljes eltávolítás** | Töröld a `netlify/` mappát és a `netlify.toml`-ból az `/api/*` átirányítást, majd deploy | A végpont `404` |
| Meghagyás, zárva | Csak deploy-old a mostani kódot, és **ne** állítsd be a `PROSCANNER_API_KEY`-t | A végpont `503`, adatot nem ad |

> **Fordított sorrendben ne csináld.** Ha előbb deploy-olsz, a végpont
> lezárul, és utána a régi rekordot már nem tudod az API-n keresztül törölni —
> csak a Netlify felületén, a Blobs tároló kézi ürítésével.

### Bejelentés

Ha valódi személyek adatai kikerültek, az adatvédelmi tisztviselővel egyeztetni
kell a bejelentési kötelezettségről — GDPR 33. cikk: az incidens tudomásra
jutásától számított **72 óra**.

---

## 3. Fájlhierarchia

```
prohuman-scanner/
│
├── index.html                  ← A TELJES ALKALMAZÁS (~2500 sor, nulla függőség)
│   ├── <style>                    CSS: rács-elrendezés, modálok, töréspontok
│   ├── <body>                     Háromhasábos felület + 2 modális ablak
│   └── <script>                   Az összes logika egyetlen IIFE-ben:
│       ├── Konfiguráció           dokumentumtípusok, időcsoportok, kiterjesztések
│       ├── Helyi tárolás          localStorage + IndexedDB (nincs hálózat)
│       ├── Típus-sorok            célmappák, drag&drop sorrend, javaslat-legördülő
│       ├── Mappa & fájllista      File System Access API, mtime szerinti csoportosítás
│       ├── Előnézet               PDF/PSD/TIFF/kép renderelés, nagyítás, pásztázás
│       ├── OCR                    Tesseract worker, szöveg → űrlapmezők
│       ├── Névépítés              tisztítás, ütközéskezelés
│       ├── Áthelyezés             doFinish() — a fő munkafolyamat
│       ├── Előzmény               DOM-alapú lista, JSON export/import
│       └── IndexedDB              mappa-engedélyek megőrzése újraindítás után
│
│   ── AZ ALÁBBIAKAT A KLIENS MÁR NEM HASZNÁLJA ──────────────────────
│      Megmaradtak arra az esetre, ha később mégis kellene gépek közötti
│      szinkron. Mindkettő hitelesítést követel és kulcs nélkül 503-at ad,
│      így önmagukban nem jelentenek kockázatot.
│
├── backend.js                  ← Helyi API (Express, csak 127.0.0.1)
├── netlify/functions/api.js    ← Netlify Function v2 + Blobs
├── netlify.toml                ← Build, átirányítás, biztonsági fejlécek
├── package.json                ← Csak a fenti kettőhöz kell
├── package-lock.json
├── types_api.json              ← A helyi backend adatfájlja
├── history_api.json            ← A helyi backend adatfájlja (git-ignorált!)
│
├── .gitignore
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

## 4. Architektúra

```
┌────────────────────────────────────────────────────────────────┐
│  BÖNGÉSZŐ  (Chrome / Edge)                                     │
│                                                                │
│  index.html                                                    │
│      │                                                         │
│      ├── File System Access API ──────► a felhasználó lemeze   │
│      │      showDirectoryPicker()          olvasás + írás      │
│      │      getDirectoryHandle()           mappa létrehozás    │
│      │      FileSystemFileHandle.move()    átnevezés+áthelyezés│
│      │                                                         │
│      ├── IndexedDB ("scanRenamer") ──► mappa-ENGEDÉLYEK        │
│      │      docDir_<típus>                 tartós hozzáférés   │
│      │      lastDir                        folytatás           │
│      │                                                         │
│      └── localStorage ────────────────► minden más adat        │
│             docTypes · docPaths · year · rootAbsPath           │
│             history · typesApiData                             │
│                                                                │
│  ✗ NINCS fetch · NINCS XHR · NINCS WebSocket · NINCS beacon    │
└────────────────────────────────────────────────────────────────┘
                             │
                             │  csak KÓD letöltése (SRI-védve),
                             ▼  adat SOHA nem megy kifelé
              tesseract.js · pdf.js · ag-psd · UTIF
```

A kliensben **egyetlen kimenő adatkapcsolat sincs**. A négy CDN-hivatkozás
kizárólag a könyvtárak kódját tölti le, és mindegyik SHA-384 integritás-hash-sel
védett.

---

## 5. Technológiák — mit mire használunk és miért

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

### Szerveroldal (megmaradt, de a kliens nem hívja)

| Technológia | Verzió | Szerep |
|---|---|---|
| **Netlify Functions v2** | platform | Szerver nélküli API. A v2 a szabványos `Request`/`Response` objektumokat használja, nem a régi `event`/`context` párost. |
| **Netlify Blobs** | 10.7.10 | Perzisztens tárolás. **Ez nem stílusdöntés volt:** a Functions fájlrendszere a `/tmp`-n kívül írásvédett, és minden hívás más konténerben futhat. A korábbi `fs.writeFile()` `EROFS`-szal elszállt, a memóriában tartott adat pedig a konténerrel együtt eltűnt — ezért adott a `GET /api/types` mindig üres eredményt. |
| **Express** | 4.19.2 | Helyi API. Csak a `127.0.0.1`-en figyel. |
| **node:crypto** | Node 18+ | `timingSafeEqual` konstans idejű kulcs-összehasonlítás. |

### Ami tudatosan **nincs**

- **Nincs build-lépés** — se webpack, se Vite, se TypeScript-fordítás.
- **Nincs kliensoldali keretrendszer** — se React, se Vue. A dinamikus rész
  (típus-sorok, előzmény) sima DOM API-val épül.
- **Nincs adatbázis** — a böngésző tárolói elegendők.
- **Nincs telemetria, nincs analitika, nincs hibajelentő szolgáltatás.**

---

## 6. Adatfolyam

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
      ├── getTargetDirectoryHandle()   ← lásd 8. fejezet
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

## 7. Fájlnév-szabályok

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

## 8. Célmappa-feloldás

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

## 9. Biztonsági modell

### A legfontosabb: nincs kimenő adatkapcsolat

A kliensben **nulla** `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket` és
`EventSource` hívás van. Ez ellenőrizhető:

```bash
grep -c "fetch(\|XMLHttpRequest\|sendBeacon\|WebSocket" index.html   # → 0
```

Ez a legerősebb garancia, ami egy ilyen alkalmazásban adható: nem a
hozzáférést szabályozzuk, hanem **nincs mit szabályozni**.

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

### A megmaradt szerverkód

A `backend.js` és a `netlify/functions/api.js` már nem része a működésnek, de
ha valaki elindítja vagy deploy-olja őket, akkor is védettek:

- **Fail-closed:** `PROSCANNER_API_KEY` nélkül minden adatvégpont `503`-at ad.
- **Hitelesítés minden végponton**, az olvasáson is, `X-Api-Key` fejléccel.
- **Konstans idejű kulcs-összehasonlítás** (SHA-256 + `timingSafeEqual`) —
  a naiv `===` az első eltérő karakternél kilép, így a válaszidőből
  karakterenként ki lehetne találni a kulcsot.
- **CORS allowlist**, nem `*`.
- **A kliens `id`-jét eldobja**, sajátot generál — az XSS forrásánál elvágva.
- **Bemenet-fehérlista** és mennyiségi limitek.
- **A helyi backend csak a `127.0.0.1`-en figyel.** Korábban minden hálózati
  interfészen, nyitott CORS mellett — vagyis a céges wifin bárki lekérhette a
  teljes előzményt.
- **Atomi fájlírás** (ideiglenes fájl + `rename`) és **soros végrehajtás**
  (`withLock`) az olvasás-módosítás-írás verseny ellen.
- **Nincs stack trace a hibaválaszokban.**

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

A `publish = "."` a repó gyökerét tenné közzé, ezért a `netlify.toml`
`force = true` átirányításai `404`-re állítják a `backend.js`, `package.json`,
`history_api.json`, `types_api.json` és `netlify/*` útvonalakat.

---

## 10. Adatvédelem / GDPR

### Milyen személyes adatot kezel

| Adat | Hol | Hova jut |
|---|---|---|
| **Személynév** | űrlap, fájlnév, előzmény | **csak a böngészőben** |
| **Dokumentumtípus** | előzmény | csak a böngészőben |
| **Érvényességi időszak** | előzmény | csak a böngészőben |
| **Fájlnevek** | előzmény | csak a böngészőben |
| **Lemezes útvonalak** | javaslatok | csak a böngészőben |
| **A dokumentum tartalma** | csak a memóriában | **sehova** — sem az OCR, sem az előnézet nem tölt fel semmit |

### Amit tudni kell

- A `tp` (táppénz) típus **egészségügyi adat** → GDPR 9. cikk, különleges
  kategória, szigorúbb szabályokkal.
- **Az adat nem hagyja el a gépet.** Nincs adatfeldolgozó, nincs felhő, nincs
  külső szolgáltató — így adatfeldolgozói szerződés sem szükséges.
- **Az előzményt bárki elolvashatja, aki a géphez hozzáfér.** A `localStorage`
  nincs titkosítva. Ha ez kockázat, a munkaállomást kell védeni
  (képernyőzár, külön Windows-felhasználó), nem az alkalmazást.
- A `history_api.json` `.gitignore`-ban van, mert a helyi backend személyes
  adatot írna bele. Verziókövetésbe kerülve visszavonhatatlanul bekerülne a
  git-történetbe.

> A fájl jelenleg még **követve van** a gitben (üres tartalommal). Ha ki
> akarod venni a követésből — a lemezen meghagyva —:
> ```bash
> git rm --cached history_api.json
> ```

---

## 11. Tesztelés és ellenőrzés

### Az alapállítás ellenőrzése: nem megy ki adat

```bash
# Mindegyiknek 0-t kell adnia
grep -c "fetch(" index.html
grep -c "XMLHttpRequest" index.html
grep -c "sendBeacon" index.html
grep -c "WebSocket" index.html

# A HTML-ben csak a 4 SRI-védett könyvtár lehet külső hivatkozás
grep -o 'src="https\?://[^"]*"' index.html
```

Futásidőben: `F12` → **Network** fül → dolgozz végig néhány fájlt.
A CDN-ek betöltésén (és az OCR nyelvi modelljén) kívül **nem szabad**
kimenő kérésnek megjelennie.

### Szintaxis-ellenőrzés

```bash
npm run check      # backend.js + netlify/functions/api.js
```

### A régi telepítés lezárásának ellenőrzése

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://proscanner.netlify.app/api/history
# Elvárt: 404 (törölt függvény) vagy 503 (kulcs nélküli deploy)
# HIBÁS:  200 — ilyenkor a régi, nyitott függvény fut még

for f in backend.js package.json history_api.json types_api.json; do
  echo "$f → $(curl -s -o /dev/null -w '%{http_code}' https://proscanner.netlify.app/$f)"
done
# Elvárt: mind 404
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

## 12. Hibaelhárítás

| Tünet | Ok | Megoldás |
|---|---|---|
| „Ez a böngésző nem támogatja a mappa-elérést" | Firefox / Safari | Chrome vagy Edge |
| Az OCR nem indul | CDN-blokk vagy hálózati hiba | Konzol: SRI-hiba? Lásd [13. Karbantartás](#13-karbantartás) |
| Az OCR lassú az első futáskor | A nyelvi modell letöltése (~15 MB) | Egyszeri, utána gyorsítótárazott |
| A fájl rossz mappába került | **Javítva** — régi verzió | Frissítsd az `index.html`-t |
| „Nem érhető el a célmappa" | Lejárt mappa-engedély | „Mappa…" gomb újbóli használata |
| Eltűnt az előzmény | Böngésző-adatok törlése, más profil, inkognitó | A `localStorage` profilonként külön; JSON Exporttal menthető |
| „Az útvonalat nem sikerült megjegyezni" | Tele a `localStorage` | Előzmény ablak → Törlés, vagy régi bejegyzések exportálása |

---

## 13. Karbantartás

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

### Ha később mégis kellene gépek közötti szinkron

A szerverkód készen áll (`backend.js`, `netlify/functions/api.js`), de a
kliensből az API-hívások ki lettek véve. Visszakötés esetén **kötelező**:

1. `PROSCANNER_API_KEY` beállítása a kiszolgálón (enélkül `503`).
2. A kliensből `X-Api-Key` fejléc küldése minden kérésnél.
3. Annak tudomásulvétele, hogy a személyes adat ettől kezdve **külső
   adatfeldolgozóhoz** kerül — ehhez DPA és adatkezelési nyilvántartás kell.

Alternatíva, ami nem jár adatkivitellel: JSON Export egy közös hálózati
meghajtóra, és Import a másik gépen.

---

## 14. Ismert korlátok

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
