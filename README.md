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

## Sestavení

```bash
npm run build
```

Instalátor pro Windows (`nsis`) je potřeba sestavit přímo na Windows.

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
