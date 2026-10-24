# DadMail

Jednoduchý emailový klient pro Seznam.cz postavený na Electronu.

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

## Použití

1. Při prvním spuštění zadejte vaše Seznam.cz přihlašovací údaje
2. Aplikace automaticky synchronizuje emaily každých 30 sekund
3. Klikněte na email pro zobrazení
4. Použijte "Napsat nový email" nebo "Odpovědět" pro odesílání


