# DadMail – hlášení o chybách

Malý Cloudflare Worker, kam DadMail posílá hlášení, když se něco pokazí.
Běží na osobním účtu Cloudflare (`Jonas.jancarik@gmail.com's Account`) a data ukládá do D1
databáze `dadmail-telemetry` (region EEUR).

- Hlášení: https://dadmail-telemetry.jonas-jancarik.workers.dev (heslo je v
  `~/.config/dadmail/telemetry-view-password`, uživatelské jméno je libovolné)
- Příjem: `POST /report`

## Co hlášení obsahuje

Druh chyby (`sync`, `send`, `crash`, `ui`, `update`, `other`), text chyby, verzi aplikace,
systém a náhodné ID instalace. Nikdy obsah emailů ani adresy: aplikace z textu odstraní
emailové adresy a jména uživatelů v cestách k souborům (`src-tauri/src/telemetry.rs`)
a Worker adresy odstraňuje ještě jednou.

Aplikace stejnou chybu pošle nejvýš jednou za 6 hodin (s počtem opakování), nejvýš 30 hlášení
za spuštění, a neposílá chyby kvůli výpadku internetu. Worker přijme nejvýš 60 hlášení za hodinu
z jedné instalace a 2000 celkem. Hlášení starší než 90 dní každou noc maže.

Posílání jde vypnout v Nastavení → Pro pokročilé → Posílat hlášení o chybách.

## Nasazení

Vyžaduje Node 22.18 nebo novější a `cf` CLI (`npm install --global cf`, `cf auth login`).

```bash
npm install
npm run typecheck
cf deploy
```

Tabulka: `cf d1 raw 6db4efc3-be81-46b4-8da8-5def48336566 --sql "$(grep -v '^--' schema.sql)"`
(s `CLOUDFLARE_ACCOUNT_ID=7756b12931ecfb3900a31049e157d706`).

Nové heslo ke stránce: uložte ho do souboru JSON `{"VIEW_PASSWORD": "…"}` a nasaďte s
`cf deploy --secrets-file <soubor>`.
