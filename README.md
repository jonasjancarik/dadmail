# DadMail

Jednoduchý emailový klient pro Seznam.cz.

Aplikace existuje ve dvou verzích se stejným uživatelským rozhraním (`src/renderer`):
Electron (`src/main`) a Tauri (`src-tauri`, backend v Rustu). Verze pro Tauri je menší
a méně náročná na paměť. Rozhraní volá backend přes `src/renderer/api.js`, který
funguje v obou verzích.

## Instalace

```bash
npm install
```

## Vývoj

```bash
npm run dev
```

## Sestavení

Sestavení vyžaduje Node 22 (verze je v `.nvmrc`). S Node 26 se `npm run build` zastaví u kroku „Finalizing package“ bez chybové hlášky a nevytvoří složku `out/`.

```bash
nvm use
npm run build
```

Pro Windows:
```bash
npm run make -- --platform=win32
```

Zabalená verze Electron zatím nefunguje: balíček neobsahuje knihovny ze složky
`node_modules` (např. `better-sqlite3`), takže aplikace po spuštění skončí chybou.

## Tauri

Vyžaduje Rust (rustup) a Node 22. Na Windows navíc Microsoft C++ Build Tools;
WebView2 je ve Windows 10 a 11 předinstalovaný.

```bash
nvm use
npm run tauri:dev
npm run tauri:build
```

Instalátor pro Windows (`nsis`) je potřeba sestavit přímo na Windows.
Data verze Tauri jsou ve složce aplikace `com.github.jonasjancarik.dadmail`,
odděleně od dat verze Electron.

## Použití

1. Při prvním spuštění zadejte vaše Seznam.cz přihlašovací údaje
2. Aplikace automaticky synchronizuje emaily každých 30 sekund
3. Klikněte na email pro zobrazení
4. Použijte "Napsat nový email" nebo "Odpovědět" pro odesílání


