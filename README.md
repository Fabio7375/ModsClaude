# usage-band

Mod per Claude Code che mostra, in una banda sopra il prompt, lo stato d'uso della sessione:

- **Contesto**: quanta parte della finestra di contesto è occupata (giallo dal 60%, rosso dall'85%).
- **Cache**: tempo residuo prima che scada la prompt cache.
- **Limiti**: utilizzo del limite a 5 ore e di quello settimanale.
- **Costo** stimato della sessione.

Funzioni aggiuntive:

- `/uso` apre il pannello **Dettagli**: contesto, cache, token, limiti e costo.
- `/handoff` riassume la sessione in un prompt di passaggio di consegne e riparte da una sessione pulita. Il testo viene messo nel prompt: lo rivedi e premi Invio.
- Quando il contesto supera il 50%, la banda propone il passaggio a una sessione nuova.
- Nelle sessioni lunghe suggerisce fino a tre richieste successive, pronte da inviare.

## Installazione

Al prompt di una sessione Claude Code nel terminale:

```
/plugin install usage-band --marketplace <utente>/usage-band
```

Rispondi `y` per aggiungere il marketplace, poi scegli l'ambito di installazione.

Da shell:

```bash
claude plugin install usage-band --marketplace <utente>/usage-band
```

## Requisiti

Una versione di Claude Code che supporti i mod (plugin con modulo di hook). Nell'app desktop o in una sessione SDK il mod si può caricare anche indicando la cartella in `CLAUDE_CODE_PLUGIN_DIRS`.

## Autore

Fabio Zambelli
