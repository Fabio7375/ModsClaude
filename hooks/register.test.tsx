import { describe, expect, test } from 'claude-code/testing'

import { bar, edgeColor, cacheColor, cacheShare, fmtTok, fmtUsd, levelColor, nextHandoffPhase, parseNext, shouldSuggestNext, turnTokens, untilReset } from './register'

describe('usage-band', () => {
  test('colori del contesto', () => {
    expect(levelColor(10)).toBe('green')
    expect(levelColor(60)).toBe('yellow')
    expect(levelColor(85)).toBe('red')
  })

  test('colori della cache', () => {
    expect(cacheColor(30)).toBe('green')
    expect(cacheColor(10)).toBe('yellow')
    expect(cacheColor(3)).toBe('red')
  })

  test('barra piena in proporzione', () => {
    expect(bar(50, 10)).toEqual({ full: '━━━━━', empty: '─────' })
    expect(bar(150).empty).toBe('')
  })

  test('tempo al reset', () => {
    const now = Date.parse('2026-10-09T10:00:00Z')
    expect(untilReset('2026-10-09T12:10:00Z', now)).toBe('2h10')
    expect(untilReset('2026-10-09T10:20:00Z', now)).toBe('20m')
    expect(untilReset(undefined, now)).toBe('')
  })

  test('colore bordo dei pulsanti', () => {
    expect(edgeColor()).toBe('#e5e7eb')
    expect(edgeColor('amber')).toBe('#f59e0b')
  })

  test('token e dollari leggibili', () => {
    expect(fmtTok(840)).toBe('840')
    expect(fmtTok(1534)).toBe('1,5k')
    expect(fmtTok(142300)).toBe('142k')
    expect(fmtTok(2800000)).toBe('2,8M')
    expect(fmtUsd(4.213)).toBe('$4,21')
    expect(fmtUsd(0.004)).toBe('<$0,01')
    expect(fmtUsd(23.46)).toBe('$23,5')
  })

  test('quota da cache e token del turno', () => {
    expect(cacheShare({ input: 10, read: 80, write: 10, output: 999 })).toBe(80)
    expect(cacheShare({ input: 0, read: 0, write: 0, output: 5 })).toBe(null)
    expect(turnTokens({ input: 1, read: 2, write: 3, output: 4 })).toBe(10)
  })

  test('next: pulisce elenchi e limita a tre', () => {
    const raw = '1. Esegui i test\n- Rifattorizza il modulo\n* "Aggiorna la wiki"\n4) Scrivi il changelog\n\n'
    expect(parseNext(raw)).toEqual(['Esegui i test', 'Rifattorizza il modulo', 'Aggiorna la wiki'])
    expect(parseNext('FINE')).toEqual([])
    expect(parseNext('x'.repeat(200))[0].length).toBe(108)
  })

  test('next solo dopo il 25% di contesto', () => {
    expect(shouldSuggestNext(24)).toBe(false)
    expect(shouldSuggestNext(25)).toBe(true)
    expect(shouldSuggestNext(undefined)).toBe(false)
  })

  test('handoff: propone al 50%, si ripropone solo dopo essere sceso', () => {
    expect(nextHandoffPhase('idle', 49)).toBe('idle')
    expect(nextHandoffPhase('idle', 50)).toBe('proposed')
    expect(nextHandoffPhase('dismissed', 70)).toBe('dismissed')
    expect(nextHandoffPhase('dismissed', 30)).toBe('idle')
    expect(nextHandoffPhase('proposed', 20)).toBe('idle')
    expect(nextHandoffPhase('working', 20)).toBe('working')
    expect(nextHandoffPhase('applying', undefined)).toBe('applying')
  })

  test('la banda mostra cache, contesto e i tasti handoff/dettagli', async ($, on) => {
    const now = Date.parse('2026-10-13T10:00:00Z')
    on('clock.now', () => ({ value: now }))
    on('session.usage', () => ({
      value: {
      startedAt: now - 3600_000,
      context: { tokens: 142000, window: 1000000, percent: 14 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-13T12:10:00Z' },
        { kind: 'seven_day', percentUsed: 8, resetsAt: '2026-10-16T10:00:00Z' },
      ],
      cost: { usd: 4.21 },
      },
    }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>motore</Text>
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} } })
      expect(await ui.find({ key: 'handoff' })).toBeDefined()
      expect(await ui.find({ key: 'details' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /cache/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('il pannello di VS Code mostra stato e tasti', async ($, on) => {
    const now = Date.parse('2026-10-13T10:00:00Z')
    on('clock.now', () => ({ value: now }))
    on('session.usage', () => ({
      value: { startedAt: now - 1000, context: { tokens: 600000, window: 1000000, percent: 60 }, rateLimits: [], cost: { usd: 1.5 } },
    }))
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>motore</Text>
    })
    const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'vscode', component: 'Pane', requestId: 'usage-band', props: { title: 'Uso', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    expect(await ui.find({ key: 'details' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /contesto/ })).toBeDefined()
    await ui.unmount()
  })
})
