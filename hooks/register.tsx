import { atom, read, update } from 'claude-code'
import type { HookOf, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { Handoff, Totals, TurnRow, View } from '../types'

type Dollar = Parameters<HookOf<'ui.render'>>[0]

// Durata della prompt cache dall'ultima richiesta della conversazione principale
const TTL_MS = 60 * 60 * 1000
// Ogni quanto la banda si ridisegna da sola (conto alla rovescia della cache)
const TICK_MS = 30 * 1000
// Soglie di saturazione del contesto: giallo "pensa a compattare", rosso "compatta ora"
const CTX_WARN = 60
const CTX_HOT = 85
// Il contesto da cui conviene ripartire con una sessione nuova (context rot)
const HANDOFF_AT = 50
// Sotto questa soglia i suggerimenti "next" non servono: la sessione è ancora corta
const NEXT_MIN = 25
const NEXT_MAX_ITEMS = 3
const KEEP_TURNS = 12
const BAR = 12
const PANE = 'usage-band'

const WINDOW_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7g', spend_limit: 'spesa' }
const WINDOW_LONG: Record<string, string> = { five_hour: '5h', seven_day: 'settimana', spend_limit: 'spesa' }
const WINDOW_TITLE: Record<string, string> = { five_hour: 'Limite 5 ore', seven_day: 'Limite settimanale', spend_limit: 'Limite di spesa' }

const HANDOFF_PROMPT = [
  'Scrivi un prompt di passaggio di consegne (handoff) che permetta a una sessione nuova, senza alcun contesto precedente, di proseguire questo lavoro da dove siamo.',
  'Usa queste sezioni, in italiano: Dove eravamo (obiettivo e stato) · Decisioni prese (con il motivo) · File e risorse toccati (percorsi esatti) · Vincoli e preferenze dell’utente · Prossimi passi (numerati) · Come ripartire (la prima azione da fare).',
  'Massimo 600 parole. Solo fatti verificati in questa conversazione, nessuna invenzione; se qualcosa non è stato verificato scrivilo. Scrivilo come istruzione rivolta alla sessione nuova.',
  'Rispondi solo con il prompt, senza introduzione.',
].join('\n\n')

const NEXT_PROMPT = (tail: string) =>
  [
    'Sei l\'assistente di una lunga sessione di lavoro. Dalla conversazione qui sotto proponi i prossimi passi concreti che l\'utente potrebbe chiedere ora.',
    `Regole: massimo ${NEXT_MAX_ITEMS} voci, una per riga, senza numeri né elenchi puntati, ciascuna una richiesta pronta da inviare (imperativo, in italiano, al massimo 100 caratteri), in ordine di priorità. Niente commenti, niente introduzione. Se il lavoro sembra concluso rispondi con la sola parola FINE.`,
    '--- CONVERSAZIONE (ultimi messaggi) ---',
    tail,
  ].join('\n\n')

const hand = (phase: Handoff['phase'], prompt = '', error?: string): Handoff => (error ? { phase, prompt, error } : { phase, prompt })

const turnsA = atom({ plugin: 'usage-band', key: 'turns' } as const, [])
const totalsA = atom({ plugin: 'usage-band', key: 'totals' } as const, { input: 0, read: 0, write: 0, output: 0 })
const lastAtA = atom({ plugin: 'usage-band', key: 'lastAt' } as const, null)
const modelA = atom({ plugin: 'usage-band', key: 'model' } as const, '')
const startedAtA = atom({ plugin: 'usage-band', key: 'startedAt' } as const, 0)
const costMarkA = atom({ plugin: 'usage-band', key: 'costMark' } as const, 0)
const nextA = atom({ plugin: 'usage-band', key: 'next' } as const, [])
const handoffA = atom({ plugin: 'usage-band', key: 'handoff' } as const, hand('idle'))
const viewA = atom({ plugin: 'usage-band', key: 'view' } as const, 'band' as View)

// ── Funzioni pure (provate in register.test.ts) ──────────────────────────────

export function levelColor(percent: number): 'green' | 'yellow' | 'red' {
  return percent >= CTX_HOT ? 'red' : percent >= CTX_WARN ? 'yellow' : 'green'
}

export function cacheColor(minutes: number): 'green' | 'yellow' | 'red' {
  return minutes > 20 ? 'green' : minutes > 5 ? 'yellow' : 'red'
}

export function bar(percent: number, width = BAR): { full: string; empty: string } {
  const filled = Math.max(0, Math.min(width, Math.round((percent * width) / 100)))
  return { full: '━'.repeat(filled), empty: '─'.repeat(width - filled) }
}

export function untilReset(resetsAt: string | undefined, nowMs: number): string {
  if (!resetsAt) return ''
  const left = Date.parse(resetsAt) - nowMs
  if (!(left > 0)) return ''
  const minutes = Math.round(left / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h${String(minutes % 60).padStart(2, '0')}` : `${Math.round(hours / 24)}g`
}

export function windowLabel(w: SessionRateLimit): string {
  return WINDOW_LABEL[w.kind] ?? w.kind
}

// 840 → 840 · 1.534 → 1,5k · 142.300 → 142k · 2.800.000 → 2,8M
export function fmtTok(n: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, '').replace('.', ',')
  if (n < 1000) return String(Math.round(n))
  if (n < 10000) return trim(n / 1000) + 'k'
  if (n < 1e6) return Math.round(n / 1000) + 'k'
  return trim(n / 1e6) + 'M'
}

export function fmtUsd(x: number): string {
  if (x > 0 && x < 0.01) return '<$0,01'
  return '$' + (x < 10 ? x.toFixed(2) : x.toFixed(1)).replace('.', ',')
}

// Quota di token d'ingresso serviti dalla cache (0–100); null senza dati
export function cacheShare(t: Totals): number | null {
  const inputs = t.input + t.read + t.write
  return inputs > 0 ? Math.round((t.read * 100) / inputs) : null
}

export function turnTokens(r: Pick<TurnRow, 'input' | 'read' | 'write' | 'output'>): number {
  return r.input + r.read + r.write + r.output
}

// Risposta del modello → al massimo NEXT_MAX_ITEMS richieste pulite
export function parseNext(text: string): string[] {
  if (/^\s*fine\b/i.test(text)) return []
  return text
    .split('\n')
    .map(l => l.replace(/^\s*(?:[-*•▸>]|\d+[.)])\s*/, '').replace(/^["«]|["»]$/g, '').trim())
    .filter(l => l.length > 3)
    .slice(0, NEXT_MAX_ITEMS)
    .map(l => (l.length > 110 ? l.slice(0, 107) + '…' : l))
}

// Cosa fare del handoff dato il contesto: proporre, rimettere a riposo, o lasciare com'è
export function nextHandoffPhase(phase: Handoff['phase'], percent: number | undefined): Handoff['phase'] {
  if (percent === undefined) return phase
  if (percent < HANDOFF_AT - 10 && (phase === 'proposed' || phase === 'dismissed')) return 'idle'
  if (percent >= HANDOFF_AT && phase === 'idle') return 'proposed'
  return phase
}

export function shouldSuggestNext(percent: number | undefined): boolean {
  return (percent ?? 0) >= NEXT_MIN
}

// ── Raccolta dati ────────────────────────────────────────────────────────────

// Una sessione nuova (/clear) riparte da zero; il handoff in corso non si tocca
async function syncSession($: Dollar, usage: SessionUsage) {
  const known = await read($, startedAtA)
  if (usage.startedAt === known) return
  await update($, startedAtA, () => usage.startedAt)
  await update($, turnsA, () => [])
  await update($, totalsA, () => ({ input: 0, read: 0, write: 0, output: 0 }))
  await update($, lastAtA, () => null)
  await update($, nextA, () => [])
  await update($, costMarkA, () => usage.cost?.usd ?? 0)
  await update($, handoffA, h => (h.phase === 'applying' ? h : hand('idle')))
}

async function recordStep($: Dollar, turnId: string, model: string, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) {
  const usage = await $.session.usage()
  await syncSession($, usage)
  const now = await $.clock.now()
  const cost = usage.cost?.usd ?? 0
  const mark = await read($, costMarkA)
  await update($, lastAtA, () => now)
  await update($, modelA, () => model)
  await update($, totalsA, t => ({
    input: t.input + u.input_tokens,
    read: t.read + u.cache_read_input_tokens,
    write: t.write + u.cache_creation_input_tokens,
    output: t.output + u.output_tokens,
  }))
  await update($, turnsA, rows => {
    const i = rows.findIndex(r => r.id === turnId)
    const add = { input: u.input_tokens, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, output: u.output_tokens }
    if (i === -1) {
      const n = (rows[rows.length - 1]?.n ?? 0) + 1
      return [...rows, { id: turnId, n, at: now, model, ...add, usd: Math.max(0, cost - mark) }].slice(-KEEP_TURNS)
    }
    return rows.map((r, k) =>
      k === i ? { ...r, model, input: r.input + add.input, read: r.read + add.read, write: r.write + add.write, output: r.output + add.output, usd: Math.max(0, cost - mark) } : r,
    )
  })
}

// ── Next: prossimi passi, solo dopo NEXT_MIN % di contesto ───────────────────

async function refreshNext($: Dollar) {
  const usage = await $.session.usage()
  if (!shouldSuggestNext(usage.context.percent)) {
    await update($, nextA, () => [])
    return
  }
  const messages = await $.session.messages()
  const tail = messages
    .slice(-8)
    .filter(m => m.text.trim())
    .map(m => `${m.role === 'user' ? 'UTENTE' : 'ASSISTENTE'}: ${m.text.slice(0, 1200)}`)
    .join('\n\n')
  if (!tail) return
  const r = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 300, timeoutMs: 20000, prompt: NEXT_PROMPT(tail) })
  if (!r.isAnswered) return
  await update($, nextA, () => parseNext(r.text))
}

async function pickNext($: Dollar, i: number) {
  const items = await read($, nextA)
  const text = items[i]
  if (!text) return
  // Il testo va nel prompt, non parte da solo: l'utente lo rivede e preme Invio
  await $.prompt.fill({ text, mode: 'replace' })
  await update($, nextA, () => [])
}

// ── Handoff: riassunto con tutta la conversazione → /clear → nuova sessione ──

async function startHandoff($: Dollar) {
  await update($, handoffA, () => hand('working'))
  await update($, viewA, () => 'handoff')
  await $.ui.open({ id: PANE, title: 'Handoff', focus: true })
  // fork: legge la conversazione intera dalla cache del prompt, senza strumenti
  const r = await $.model.fork({ prompt: HANDOFF_PROMPT })
  if (r.isAnswered) {
    await update($, handoffA, () => hand('ready', r.text.trim()))
  } else {
    const why = r.reason === 'nothing-to-fork' ? 'conversazione ancora vuota' : `riassunto non riuscito (${r.reason})`
    await update($, handoffA, () => hand('error', '', why))
  }
}

async function applyHandoff($: Dollar) {
  const h = await read($, handoffA)
  if (h.phase !== 'ready' || !h.prompt) return
  await update($, handoffA, x => hand('applying', x.prompt, x.error))
  try {
    await $.command.run({ command: 'clear' })
    await $.prompt.submit({ text: `Riprendi il lavoro da questo handoff (sessione precedente chiusa per ridurre il context rot).\n\n${h.prompt}` })
    await update($, handoffA, () => hand('idle'))
    await update($, viewA, () => 'band')
    $.ui.toast('Handoff inviato: nuova sessione avviata')
  } catch (err) {
    // Il prompt resta salvato: si può riprovare o copiare a mano
    await update($, handoffA, () => hand('ready', h.prompt, String(err instanceof Error ? err.message : err)))
  }
}

async function cancelHandoff($: Dollar) {
  await update($, handoffA, () => hand('dismissed'))
  await update($, viewA, () => 'band')
}

// Alternativa che resta nella stessa sessione: la compattazione di Jev poda i risultati degli strumenti
async function compactHere($: Dollar) {
  await update($, viewA, () => 'band')
  const r = await $.session.compact()
  $.ui.toast(r.skip ? `Compattazione saltata: ${r.skip}` : 'Compattazione eseguita')
}

async function openDetails($: Dollar) {
  await update($, viewA, () => 'details')
  await $.ui.open({ id: PANE, title: 'Dettagli' })
}

// ── Disegno ──────────────────────────────────────────────────────────────────

type Snap = {
  usage: SessionUsage
  clock: number
  lastAt: number | null
  turns: TurnRow[]
  totals: Totals
  model: string
  next: string[]
  handoff: Handoff
}

async function snapshot($: Dollar): Promise<Snap> {
  const [usage, clock, lastAt, turns, totals, model, next, handoff] = await Promise.all([
    $.session.usage(),
    $.clock.now(),
    read($, lastAtA),
    read($, turnsA),
    read($, totalsA),
    read($, modelA),
    read($, nextA),
    read($, handoffA),
  ])
  return { usage, clock, lastAt, turns, totals, model, next, handoff }
}

function cacheLeft(s: Snap): number | null {
  return s.lastAt === null ? null : Math.max(0, TTL_MS - (s.clock - s.lastAt))
}

// Linea sottile: la parte piena cambia colore con la saturazione (verde, giallo, rosso)
function meter(Text: any, percent: number, width = BAR, native = false) {
  const b = bar(percent, width)
  return (
    <Text>
      <Text color={levelColor(percent)}>{b.full}</Text>
      <Text {...dim(native)}>{b.empty}</Text>
    </Text>
  )
}

const FRAME = '#4b5563'
const EDGE = '#e5e7eb'
const AMBER = '#f59e0b'
// Scheda nativa: colori del tema dell'app, così testo e pulsanti nativi restano leggibili in chiaro e in scuro
const LIGHT = 'text'
const MUTED = 'inactive'

// Testo secondario: grigio chiaro sulla scheda nativa scura, dimColor nel terminale
function dim(native: boolean): { color?: string; dimColor?: boolean } {
  return native ? { color: MUTED } : { dimColor: true }
}

export function edgeColor(tone: 'white' | 'amber' = 'white'): string {
  return tone === 'amber' ? AMBER : EDGE
}

type ActionOpts = { key: string; label: string; hotkey?: string; tone?: 'white' | 'amber'; onPress: () => void }

// Terminale: pulsante con bordo arrotondato (il colore dell'etichetta non è impostabile); altre superfici: pulsante nativo
function action($: Dollar, e: any, o: ActionOpts) {
  const { Box, Button } = $.ui.resolve(e)
  if (e.surface === 'terminal') {
    const edge = edgeColor(o.tone)
    return (
      <Box key={'box-' + o.key} borderStyle="round" borderColor={edge} paddingX={1} hover={{ borderColor: '#ffffff' }}>
        <Button key={o.key} label={o.label} hotkey={o.hotkey} plain hover={{ bold: true }} onPress={o.onPress} />
      </Box>
    )
  }
  const { Text } = $.ui.resolve(e)
  return (
    <Button key={o.key} label={o.label} hotkey={o.hotkey} variant={o.tone === 'amber' ? 'primary' : 'secondary'} onPress={o.onPress}>
      <Text color={o.tone === 'amber' ? AMBER : LIGHT}>{o.label}</Text>
    </Button>
  )
}

function cachePiece($: Dollar, e: any, s: Snap) {
  const { Text } = $.ui.resolve(e)
  const native = e.surface !== 'terminal'
  const left = cacheLeft(s)
  if (left === null) return <Text key="cache" {...dim(native)}>● cache —</Text>
  if (left === 0) {
    return (
      <Text key="cache">
        <Text color="red">● cache scaduta</Text>
      </Text>
    )
  }
  const minutes = Math.ceil(left / 60000)
  const c = cacheColor(minutes)
  return (
    <Text key="cache">
      <Text color={c}>● </Text>
      <Text {...dim(native)}>cache </Text>
      <Text color={c} bold>{minutes}m</Text>
    </Text>
  )
}

function gauge($: Dollar, e: any, key: string, label: string, percent: number | undefined, width: number, extra: string, native = false) {
  const { Text } = $.ui.resolve(e)
  const onDark = e.surface !== 'terminal'
  if (percent === undefined) return <Text key={key} {...dim(onDark)}>{label} —</Text>
  const c = levelColor(percent)
  if (native) {
    return (
      <Text key={key}>
        <Text {...dim(onDark)}>{label} </Text>
        {extra ? <Text color={LIGHT}>{extra} </Text> : null}
        <Text color={c} bold>{Math.round(percent)}% </Text>
        {meter(Text, percent, width, onDark)}
      </Text>
    )
  }
  return (
    <Text key={key}>
      <Text {...dim(onDark)}>{label} </Text>
      {meter(Text, percent, width, onDark)}
      <Text color={c} bold> {Math.round(percent)}%</Text>
      {extra ? <Text {...dim(onDark)}> {extra}</Text> : null}
    </Text>
  )
}

function gauges($: Dollar, e: any, s: Snap, width: number, wide: boolean, native = false): JSX.Element[] {
  const ctx = s.usage.context
  const tokens = ctx.tokens !== undefined ? fmtTok(ctx.tokens) : ''
  const out = [gauge($, e, 'ctx', native ? 'contesto' : 'ctx', ctx.percent, width, tokens, native)]
  for (const w of s.usage.rateLimits) {
    const reset = untilReset(w.resetsAt, s.clock)
    const label = native ? (WINDOW_LONG[w.kind] ?? w.kind) : windowLabel(w)
    out.push(gauge($, e, w.kind, label, w.percentUsed, width, wide && reset ? `reset ${reset}` : '', false))
  }
  return out
}

function nextList($: Dollar, e: any, s: Snap): JSX.Element | null {
  const native = e.surface !== 'terminal'
  if (s.next.length === 0) return null
  const { Box, Button, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" marginTop={0}>
      <Text color={native ? MUTED : FRAME}>{native ? 'next:' : '─ next'}</Text>
      {s.next.map((t, i) =>
        native ? (
          <Button key={'next' + i} label={t} hotkey={String(i + 1)} plain onPress={() => pickNext($, i)}>
            <Text color={LIGHT}>{t}</Text>
          </Button>
        ) : (
          <Button key={'next' + i} label={t} hotkey={String(i + 1)} plain onPress={() => pickNext($, i)} />
        ),
      )}
      {native ? (
        <Button key="next0" label="dismiss" hotkey="0" plain onPress={() => update($, nextA, () => [])}>
          <Text color={MUTED}>dismiss</Text>
        </Button>
      ) : (
        <Button key="next0" label="dismiss" hotkey="0" plain dimColor onPress={() => update($, nextA, () => [])} />
      )}
    </Box>
  )
}

// Superfici native (Desktop, VS Code): scheda piena, una riga di dati separati da |, pulsanti impilati a destra
function nativeCard($: Dollar, e: any, s: Snap, margin: boolean) {
  const { Box, Text } = $.ui.resolve(e)
  const advise = s.handoff.phase === 'proposed'
  const all = gauges($, e, s, 6, true, true)
  const items = [cachePiece($, e, s), ...all, ...(s.usage.cost ? [<Text key="cost" color={MUTED}>costo API <Text color={LIGHT}>{fmtUsd(s.usage.cost.usd)}</Text></Text>] : [])]
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={2} paddingY={0} marginTop={margin ? 1 : 0}>
      {/* Una sola riga che va a capo: dati, spaziatore che cresce, due pulsanti in fila a destra */}
      <Box flexDirection="row" flexWrap="wrap" alignItems="center">
        {items.flatMap((p, i) => (i === 0 ? [p] : [<Text key={'sep' + i} color={MUTED}>{' | '}</Text>, p]))}
        <Box key="spacer" flexGrow={1} />
        <Box key="buttons" flexDirection="row" flexShrink={0} marginLeft={2}>
          {action($, e, { key: 'handoff', label: 'handoff', hotkey: 'h', tone: advise ? 'amber' : 'white', onPress: () => startHandoff($) })}
          <Box key="gap1" marginLeft={1}>
            {action($, e, { key: 'details', label: 'dettagli', hotkey: 'd', onPress: () => openDetails($) })}
          </Box>
        </Box>
      </Box>
      {nextList($, e, s)}
    </Box>
  )
}

// La scheda: cornice arrotondata, barre di saturazione a sinistra, pulsanti a destra
function card($: Dollar, e: any, s: Snap, margin: boolean) {
  if (e.surface !== 'terminal') return nativeCard($, e, s, margin)
  const { Box, Text } = $.ui.resolve(e)
  const cols = e.props?.bodyColumns ?? 80
  const wide = cols >= 100
  const width = wide ? 14 : 8
  const pct = s.usage.context.percent
  const advise = s.handoff.phase === 'proposed'
  const all = gauges($, e, s, width, wide)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={FRAME} paddingX={1} marginTop={margin ? 1 : 0}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={3}>
            {all[0]}
            {cachePiece($, e, s)}
            {s.usage.cost ? <Text dimColor>{fmtUsd(s.usage.cost.usd)} API</Text> : null}
          </Box>
          <Box flexDirection="row" columnGap={3}>
            {all.slice(1)}
            {advise ? <Text color="yellow">handoff consigliato</Text> : null}
            {!advise && pct !== undefined && pct >= HANDOFF_AT && s.handoff.phase === 'dismissed' ? <Text dimColor>ctx alto</Text> : null}
          </Box>
        </Box>
        <Box flexDirection="row" columnGap={1}>
          {action($, e, { key: 'handoff', label: 'handoff', tone: advise ? 'amber' : 'white', onPress: () => startHandoff($) })}
          {action($, e, { key: 'details', label: 'dettagli', onPress: () => openDetails($) })}
        </Box>
      </Box>
      {nextList($, e, s)}
    </Box>
  )
}

async function drawBand($: Dollar, e: any) {
  return card($, e, await snapshot($), true)
}

// Pannello fisso di VS Code: la stessa scheda
function paneBand($: Dollar, e: any, s: Snap) {
  return card($, e, s, false)
}

function line($: Dollar, e: any, label: string, value: JSX.Element | string, key: string) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key={key} flexDirection="row">
      <Text dimColor>{label.padEnd(20)}</Text>
      {typeof value === 'string' ? <Text>{value}</Text> : value}
    </Box>
  )
}

// "Consumi della sessione": modello, contesto, cache, token, costo, limiti, ultimi turni
function paneDetails($: Dollar, e: any, s: Snap, isVscode: boolean) {
  const { Box, Text } = $.ui.resolve(e)
  const u = s.usage
  const left = cacheLeft(s)
  const share = cacheShare(s.totals)
  const total = s.totals.input + s.totals.read + s.totals.write + s.totals.output
  const rows: JSX.Element[] = []

  rows.push(line($, e, 'Modello', s.model || '—', 'model'))
  const pct = u.context.percent
  rows.push(
    line(
      $,
      e,
      'Contesto',
      pct === undefined ? (
        '—'
      ) : (
        <Text>
          <Text>{u.context.tokens !== undefined ? fmtTok(u.context.tokens) : '—'} / {fmtTok(u.context.window)}  </Text>
          {meter(Text, pct)}
          <Text color={levelColor(pct)}> {pct}%</Text>
        </Text>
      ),
      'ctx',
    ),
  )
  rows.push(
    line(
      $,
      e,
      'Cache',
      left === null ? (
        <Text dimColor>nessuna richiesta ancora</Text>
      ) : left === 0 ? (
        <Text color="red">● scaduta · la prossima richiesta la riscrive</Text>
      ) : (
        <Text color={cacheColor(Math.ceil(left / 60000))}>● calda · scade tra {Math.ceil(left / 60000)} min</Text>
      ),
      'cache',
    ),
  )
  rows.push(
    line($, e, 'Sessione', total === 0 ? '—' : `${fmtTok(total)} token${share === null ? '' : ` · ${share}% da cache`}`, 'tot'),
  )
  if (total > 0) {
    rows.push(line($, e, '  input', fmtTok(s.totals.input), 't1'))
    rows.push(line($, e, '  letti da cache', fmtTok(s.totals.read), 't2'))
    rows.push(line($, e, '  scritti in cache', fmtTok(s.totals.write), 't3'))
    rows.push(line($, e, '  output', fmtTok(s.totals.output), 't4'))
  }
  rows.push(line($, e, 'Costo a prezzi API', u.cost ? fmtUsd(u.cost.usd) : '—', 'cost'))
  for (const w of u.rateLimits) {
    const reset = untilReset(w.resetsAt, s.clock)
    rows.push(
      line(
        $,
        e,
        WINDOW_TITLE[w.kind] ?? w.kind,
        <Text>
          {meter(Text, w.percentUsed)}
          <Text color={levelColor(w.percentUsed)}> {Math.round(w.percentUsed)}%</Text>
          {reset ? <Text dimColor> · reset tra {reset}</Text> : null}
        </Text>,
        w.kind,
      ),
    )
  }

  // Ultimi turni: barre in proporzione al turno più pesante tra quelli mostrati
  const room = Math.max(3, Math.min(KEEP_TURNS, (e.viewport?.rows ?? 30) - rows.length - 6))
  const shown = s.turns.slice(-room)
  const max = Math.max(1, ...shown.map(turnTokens))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text bold>Consumi della sessione  </Text>
        {action($, e, {
          key: 'back',
          label: isVscode ? 'indietro' : 'chiudi',
          hotkey: 'x',
          onPress: () => (isVscode ? update($, viewA, () => 'band') : $.ui.close({ id: PANE })),
        })}
      </Box>
      {rows}
      <Text bold>Ultimi turni · token e costo API</Text>
      {shown.length === 0 ? <Text dimColor>nessun turno ancora</Text> : null}
      {shown.map(r => (
        <Box key={r.id} flexDirection="row">
          <Text dimColor>{('#' + r.n).padEnd(5)}</Text>
          {meter(Text, (turnTokens(r) * 100) / max, 14)}
          <Text>{'  ' + fmtTok(turnTokens(r)).padStart(6)}</Text>
          <Text dimColor>{'  ' + fmtUsd(r.usd)}</Text>
        </Box>
      ))}
    </Box>
  )
}

// Attenzione: nelle funzioni che disegnano JSX non chiamare nessuna variabile `h`: oscura il factory JSX (`h is not a function`)
function paneHandoff($: Dollar, e: any, s: Snap) {
  const { Box, Text } = $.ui.resolve(e)
  const hf = s.handoff
  const room = Math.max(6, (e.viewport?.rows ?? 30) - 10)
  const lines = hf.prompt.split('\n')
  const body = lines.slice(0, room).join('\n')
  const hidden = lines.length - room

  return (
    <Box flexDirection="column">
      <Text bold>Handoff · nuova sessione</Text>
      {hf.phase === 'working' ? <Text dimColor>Riassunto in corso…</Text> : null}
      {hf.phase === 'applying' ? <Text dimColor>/clear e invio del prompt…</Text> : null}
      {hf.phase === 'error' ? <Text color="red">{hf.error ?? 'errore'}</Text> : null}
      {hf.phase === 'ready' || hf.phase === 'applying' ? (
        <Box flexDirection="column">
          {hf.error ? <Text color="red">Invio non riuscito: {hf.error}</Text> : null}
          <Text>{body}</Text>
          {hidden > 0 ? <Text dimColor>… altre {hidden} righe (partono comunque)</Text> : null}
        </Box>
      ) : null}
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        {hf.phase === 'ready' ? action($, e, { key: 'go', label: 'avvia nuova sessione', hotkey: 's', tone: 'amber', onPress: () => applyHandoff($) }) : null}
        {hf.phase === 'ready' ? action($, e, { key: 'jev', label: 'compatta qui (Jev)', hotkey: 'j', onPress: () => compactHere($) }) : null}
        {hf.phase === 'error' ? action($, e, { key: 'retry', label: 'riprova', hotkey: 'r', onPress: () => startHandoff($) }) : null}
        {action($, e, { key: 'cancel', label: 'annulla', hotkey: 'x', onPress: () => cancelHandoff($) })}
      </Box>
    </Box>
  )
}

// Riga di stato compatta: fallback dove la banda sopra il prompt non si disegna (VS Code)
async function pushStatus($: Dollar) {
  const s = await snapshot($)
  const bits: string[] = []
  const left = cacheLeft(s)
  bits.push(left === null ? '● cache —' : left === 0 ? '● cache scaduta' : `● cache ${Math.ceil(left / 60000)}m`)
  const pct = s.usage.context.percent
  bits.push(pct === undefined ? 'ctx —' : `ctx ${pct}%${s.handoff.phase === 'proposed' ? ' · handoff consigliato' : ''}`)
  for (const w of s.usage.rateLimits) bits.push(`${windowLabel(w)} ${Math.round(w.percentUsed)}%`)
  if (s.usage.cost) bits.push(fmtUsd(s.usage.cost.usd))
  $.ui.status(bits.join(' · '))
}

export const register: Register = on => {
  let ticking: unknown = null
  let isVscode = false
  let busyNext = false

  // Una richiesta al modello rinnova la cache (i subagent ne hanno una loro, non contano)
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result.usage) {
      await recordStep($, e.turnId, result.usage.model || e.model, result.usage)
      ticking ??= $.clock.every(TICK_MS, async () => {
        $.ui.invalidate('ui.render')
        if (isVscode) await pushStatus($)
      })
      if (isVscode) await pushStatus($)
    }
    return result
  })

  // Fine turno: chiude il conto del costo, propone il handoff, aggiorna i next
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    const usage = await $.session.usage()
    await update($, costMarkA, () => usage.cost?.usd ?? 0)
    const h = await read($, handoffA)
    const phase = nextHandoffPhase(h.phase, usage.context.percent)
    if (phase !== h.phase) {
      await update($, handoffA, x => ({ ...x, phase }))
      if (phase === 'proposed') $.ui.toast(`Contesto al ${usage.context.percent}%: handoff consigliato (tasto h)`)
    }
    if (!busyNext) {
      busyNext = true
      // Non blocca la chiusura del turno; un errore del modello lascia i next com'erano
      void refreshNext($)
        .catch(() => {})
        .finally(() => {
          busyNext = false
        })
    }
    if (isVscode) await pushStatus($)
    return done
  })

  // Un nuovo prompt rende vecchi i suggerimenti
  on('prompt.submit', async ($, e, next) => {
    await update($, nextA, () => [])
    return next(e)
  }).catch(($, e, next) => next(e))

  // Contesto, limiti o costo cambiati: ridisegna
  on('session.measure', async ($, e, next) => {
    $.ui.invalidate('ui.render')
    if (isVscode) await pushStatus($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props?.hasSurvey) return next(e)
    // Quello che disegnano le altre mod nella banda resta sotto la nostra riga
    const theirs = await next(e)
    const { Box } = $.ui.resolve(e)
    const mine = await drawBand($, e)
    return theirs ? (
      <Box flexDirection="column">
        {mine}
        {theirs}
      </Box>
    ) : (
      mine
    )
  })

  // Un solo pannello, tre viste: stato (VS Code), dettagli, handoff
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await snapshot($)
    const view = await read($, viewA)
    if (view === 'details') return paneDetails($, e, s, isVscode)
    if (view === 'handoff') return paneHandoff($, e, s)
    return paneBand($, e, s)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'uso', description: 'Apre il pannello Dettagli: contesto, cache, token, limiti e costo' })
    await $.command.register({ name: 'handoff', description: 'Riassume la sessione, fa /clear e riparte in una sessione nuova' })
    const surfaces = await $.session.surfaces()
    if (e.surface === 'vscode' || surfaces.includes('vscode')) {
      isVscode = true
      await update($, viewA, () => 'band')
      void $.ui.open({ id: PANE, title: 'Uso' })
      await pushStatus($)
    }
    return next(e)
  })

  on('command.run', { command: 'uso' }, async $ => {
    await openDetails($)
    if (isVscode) await pushStatus($)
    return { text: 'Pannello dettagli aperto.' }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    void startHandoff($)
    return { text: 'Handoff avviato: rivedi il prompt nel pannello e premi s per ripartire.' }
  })
}
