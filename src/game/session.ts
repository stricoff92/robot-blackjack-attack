import { createShoe, shuffle, type Card } from './deck'
import { POWERUPS, type PowerupId } from './powerups'
import { createRng, type Rng } from './random'
import {
  activeHand,
  armSecondChance,
  DEFAULT_ROUND_RULES,
  doubleDown,
  hit,
  lateDouble,
  split,
  stand,
  startRound,
  type Round,
} from './round'
import { addTokens, applyRound, HIT_TOKEN, nextBet, spendTokens, startRun, type RunState } from './run'

const SHOE_DECKS = 6

export type Phase = 'betting' | 'playing' | 'resolved' | 'over'

export interface SessionState {
  run: RunState
  round: Round | null
  phase: Phase
  peeked: boolean
  foresightCard: Card | null
}

export class Session {
  private nextRandom: Rng
  private run: RunState
  private round: Round | null = null
  private phase: Phase = 'betting'
  private peeked = false
  private foresightCard: Card | null = null

  constructor(seed: number) {
    this.nextRandom = createRng(seed)
    this.run = startRun(seed)
  }

  snapshot(): SessionState {
    return {
      run: this.run,
      round: this.round,
      phase: this.phase,
      peeked: this.peeked,
      foresightCard: this.foresightCard,
    }
  }

  deal(): void {
    if (this.phase !== 'betting') {
      return
    }
    const bet = nextBet(this.run)
    const shoe = shuffle(createShoe(SHOE_DECKS), this.nextRandom)
    this.peeked = false
    this.foresightCard = null
    this.round = startRound(shoe, bet, DEFAULT_ROUND_RULES)
    if (this.round.status === 'resolved') {
      this.settle()
    } else {
      this.phase = 'playing'
    }
  }

  hit(): void {
    if (this.phase !== 'playing') {
      return
    }
    this.run = addTokens(this.run, HIT_TOKEN)
    this.act(() => hit(this.requireRound()))
  }

  stand(): void {
    this.act(() => stand(this.requireRound()))
  }

  double(): void {
    this.act(() => doubleDown(this.requireRound()))
  }

  split(): void {
    this.act(() => split(this.requireRound()))
  }

  buyPeek(): void {
    if (!this.canBuy('peek')) {
      return
    }
    this.run = spendTokens(this.run, POWERUPS.peek.cost)
    this.peeked = true
  }

  buyForesight(): void {
    if (!this.canBuy('foresight')) {
      return
    }
    const round = this.requireRound()
    this.run = spendTokens(this.run, POWERUPS.foresight.cost)
    this.foresightCard = round.shoe[round.drawIndex]
  }

  buyLateDouble(): void {
    if (!this.canBuy('late-double') || !this.canAffordLateDouble()) {
      return
    }
    this.run = spendTokens(this.run, POWERUPS['late-double'].cost)
    this.act(() => lateDouble(this.requireRound()))
  }

  buySecondChance(): void {
    if (!this.canBuy('second-chance')) {
      return
    }
    this.run = spendTokens(this.run, POWERUPS['second-chance'].cost)
    this.round = armSecondChance(this.requireRound())
  }

  nextHand(): void {
    if (this.phase !== 'resolved') {
      return
    }
    this.round = null
    this.phase = 'betting'
  }

  restart(): void {
    const seed = generateSeed()
    this.nextRandom = createRng(seed)
    this.run = startRun(seed)
    this.round = null
    this.peeked = false
    this.foresightCard = null
    this.phase = 'betting'
  }

  private act(transition: () => Round): void {
    if (this.phase !== 'playing') {
      return
    }
    this.foresightCard = null
    this.round = transition()
    if (this.requireRound().status === 'resolved') {
      this.settle()
    }
  }

  private settle(): void {
    this.run = applyRound(this.run, this.requireRound())
    this.phase = this.run.over ? 'over' : 'resolved'
  }

  private canBuy(id: PowerupId): boolean {
    return this.phase === 'playing' && this.round !== null && this.run.tokens >= POWERUPS[id].cost
  }

  private canAffordLateDouble(): boolean {
    const round = this.requireRound()
    const exposure = round.hands.reduce((total, hand) => total + hand.bet, 0)
    return this.run.chips >= exposure + activeHand(round).bet
  }

  private requireRound(): Round {
    if (!this.round) {
      throw new Error('no active round')
    }
    return this.round
  }
}

function generateSeed(): number {
  return Math.floor(Math.random() * 0x100000000)
}
