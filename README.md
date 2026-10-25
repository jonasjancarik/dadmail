# DadMail

Jednoduchý emailový klient pro Seznam.cz postavený na Tauri: uživatelské rozhraní
v Reactu (`src/renderer`), backend v Rustu (`src-tauri`).

## Instalace

Vyžaduje Node 22 (verze je v `.nvmrc`) a Rust (rustup). Na Windows navíc
Microsoft C++ Build Tools; WebView2 je ve Windows 10 a 11 předinstalovaný.

```bash
nvm use
npm install
```

## Vývoj

```bash
npm run dev
```

Na macOS se nepodepsaná vývojová sestavení po každé změně znovu ptají na přístup do Klíčenky.
Vývojové sestavení proto umí vzít heslo z proměnné `DADMAIL_PASSWORD`
(např. `DADMAIL_PASSWORD="$(security find-generic-password -s DadMail -w)" npm run dev`);
vydaná aplikace ji nečte.

Vzhled lze ladit i v běžném prohlížeči s ukázkovými emaily, bez aplikace a bez
skutečné schránky: `npm run preview:ui` a otevřít http://localhost:1420
(`src/renderer/previewApi.js`; do sestavené aplikace se nedostane).

## Sestavení

```bash
npm run build
```

Sestavení podepisuje aktualizace, takže potřebuje soukromý klíč
(vytvořený příkazem `npx tauri signer generate`, uložený v `~/.tauri/dadmail-updater.key`):

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/dadmail-updater.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run build
```

Instalátor pro Windows (`nsis`) je potřeba sestavit přímo na Windows. To dělá GitHub Actions
(`.github/workflows/build.yml`) při každém pushi; instalátor je ke stažení u běhu workflow.
Workflow potřebuje secret `TAURI_SIGNING_PRIVATE_KEY` s obsahem souboru s klíčem.

## Vydání nové verze

1. Zvyšte verzi v `package.json` (aplikace ji přebírá) a v `src-tauri/Cargo.toml`.
2. Commitněte a pushněte tag, např. `git tag v0.2.0 && git push origin v0.2.0`.
3. Workflow vytvoří GitHub release s instalátorem a souborem `latest.json`.
   Nainstalovaná aplikace novou verzi najde po spuštění a nabídne „Aktualizovat“.

Data aplikace jsou ve složce `com.github.jonasjancarik.dadmail`
(na macOS v `~/Library/Application Support`, na Windows v `%APPDATA%`).

## Použití

1. Při prvním spuštění zadejte vaše Seznam.cz přihlašovací údaje. Heslo se uloží do
   systémového úložiště hesel (Správce přihlašovacích údajů ve Windows, Klíčenka na macOS),
   ne do databáze aplikace.
2. Aplikace automaticky synchronizuje emaily každých 30 sekund. Přečtení a smazání emailu
   se projeví i na serveru: smazaný email se přesune do koše, takže ho lze obnovit
   ve webové poště Seznamu.
3. Klikněte na email pro zobrazení. Odkazy se otevírají v prohlížeči a obrázky z internetu
   se načtou až po kliknutí na „Zobrazit obrázky“.
4. Přílohy lze otevřít nebo uložit do složky Stažené soubory. Přílohy, které by mohly
   spustit program (např. `.exe`), aplikace neotevře, jen je uloží.
5. Použijte "Napsat nový email" nebo "Odpovědět" pro odesílání. Odeslané emaily se ukládají
   do složky Odeslané na serveru.
