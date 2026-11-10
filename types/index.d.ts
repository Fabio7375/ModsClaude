// Un turno = una richiesta dell'utente con tutti i passi del modello che ne seguono
export type TurnRow = {
  id: string
  n: number
  at: number
  model: string
  input: number
  read: number
  write: number
  output: number
  usd: number
}

export type Totals = { input: number; read: number; write: number; output: number }

// idle: nulla · proposed: contesto oltre soglia, in attesa del tasto · working: riassunto in corso
// ready: prompt pronto da rivedere · applying: /clear e nuova sessione in corso
// dismissed: rifiutato, non riproporre finché il contesto non scende · error: riassunto fallito
export type Handoff = {
  phase: 'idle' | 'proposed' | 'working' | 'ready' | 'applying' | 'dismissed' | 'error'
  prompt: string
  error?: string
}

// band: stato sintetico (pannello fisso di VS Code) · details: Consumi della sessione · handoff: anteprima
export type View = 'band' | 'details' | 'handoff'

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      turns: TurnRow[]
      totals: Totals
      lastAt: number | null
      model: string
      startedAt: number
      costMark: number
      next: string[]
      handoff: Handoff
      view: View
    }
  }
}
