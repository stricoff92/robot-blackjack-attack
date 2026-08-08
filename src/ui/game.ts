import './game.css'

import type { Card, Suit } from '../game/deck'
import { evaluateHand } from '../game/hand'
import { POWERUPS } from '../game/powerups'
import { canDouble, canSplit, payout, type Round } from '../game/round'
import { isLastCall, nextBet } from '../game/run'
import { Session, type SessionState } from '../game/session'

const SUIT_SYMBOLS: Record<Suit, string> = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
}

export function mountGame(root: HTMLElement): void {
  new GameUI(root).start()
}

class GameUI {
  private readonly root: HTMLElement
  private readonly session: Session
  private state: SessionState

  private status!: HTMLElement
  private healthFill!: HTMLElement
  private healthLabel!: HTMLElement
  private dealerHand!: HTMLElement
  private dealerTotal!: HTMLElement
  private playerHands!: HTMLElement
  private message!: HTMLElement
  private bettingGroup!: HTMLElement
  private betHint!: HTMLElement
  private actionsGroup!: HTMLElement
  private doubleButton!: HTMLButtonElement
  private splitButton!: HTMLButtonElement
  private powerupsGroup!: HTMLElement
  private peekButton!: HTMLButtonElement
  private lateDoubleButton!: HTMLButtonElement
  private secondChanceButton!: HTMLButtonElement
  private powerupHint!: HTMLElement
  private continueGroup!: HTMLElement
  private gameoverGroup!: HTMLElement
  private resume!: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    this.session = new Session(generateSeed())
    this.state = this.session.snapshot()
  }

  start(): void {
    this.build()
    this.render()
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="game">
        <div class="status" id="status"></div>
        <div class="gauges">
          <div class="gauge gauge--health">
            <span class="gauge__label" id="health-label"></span>
            <div class="gauge__track"><div class="gauge__fill" id="health-fill"></div></div>
          </div>
        </div>
        <div class="seat">
          <div class="label">Dealer <span id="dealer-total"></span></div>
          <div class="hand" id="dealer-hand"></div>
        </div>
        <div class="seat">
          <div class="label">You</div>
          <div id="player-hands"></div>
        </div>
        <div class="message" id="message"></div>
        <div class="controls">
          <div class="group" id="betting">
            <span class="hint" id="bet-hint"></span>
            <button id="deal">Deal</button>
          </div>
          <div class="group" id="actions">
            <button id="hit">Hit</button>
            <button id="stand">Stand</button>
            <button id="double">Double</button>
            <button id="split">Split</button>
          </div>
          <div class="group" id="powerups">
            <button id="pw-peek"></button>
            <button id="pw-late-double"></button>
            <button id="pw-second-chance"></button>
            <span class="hint" id="powerup-hint"></span>
          </div>
          <div class="group" id="continue">
            <button id="next">Next hand</button>
          </div>
          <div class="group group--column" id="gameover">
            <div class="resume" id="resume"></div>
            <button id="restart">New run</button>
          </div>
        </div>
      </div>
    `

    this.status = this.select('#status')
    this.healthFill = this.select('#health-fill')
    this.healthLabel = this.select('#health-label')
    this.dealerHand = this.select('#dealer-hand')
    this.dealerTotal = this.select('#dealer-total')
    this.playerHands = this.select('#player-hands')
    this.message = this.select('#message')
    this.bettingGroup = this.select('#betting')
    this.betHint = this.select('#bet-hint')
    this.actionsGroup = this.select('#actions')
    this.doubleButton = this.select('#double')
    this.splitButton = this.select('#split')
    this.powerupsGroup = this.select('#powerups')
    this.peekButton = this.select('#pw-peek')
    this.lateDoubleButton = this.select('#pw-late-double')
    this.secondChanceButton = this.select('#pw-second-chance')
    this.powerupHint = this.select('#powerup-hint')
    this.continueGroup = this.select('#continue')
    this.gameoverGroup = this.select('#gameover')
    this.resume = this.select('#resume')

    this.peekButton.textContent = `Dealer Peek (${POWERUPS.peek.cost})`
    this.lateDoubleButton.textContent = `Late double (${POWERUPS['late-double'].cost})`
    this.secondChanceButton.textContent = `Bust Block (${POWERUPS['second-chance'].cost})`

    this.select<HTMLButtonElement>('#deal').addEventListener('click', () => this.dispatch(() => this.session.deal()))
    this.select<HTMLButtonElement>('#hit').addEventListener('click', () => this.dispatch(() => this.session.hit()))
    this.select<HTMLButtonElement>('#stand').addEventListener('click', () => this.dispatch(() => this.session.stand()))
    this.doubleButton.addEventListener('click', () => this.dispatch(() => this.session.double()))
    this.splitButton.addEventListener('click', () => this.dispatch(() => this.session.split()))
    this.peekButton.addEventListener('click', () => this.dispatch(() => this.session.buyPeek()))
    this.lateDoubleButton.addEventListener('click', () => this.dispatch(() => this.session.buyLateDouble()))
    this.secondChanceButton.addEventListener('click', () => this.dispatch(() => this.session.buySecondChance()))
    this.select<HTMLButtonElement>('#next').addEventListener('click', () => this.dispatch(() => this.session.nextHand()))
    this.select<HTMLButtonElement>('#restart').addEventListener('click', () => this.dispatch(() => this.session.restart()))
  }

  private dispatch(action: () => void): void {
    action()
    this.render()
  }

  private render(): void {
    this.state = this.session.snapshot()
    const run = this.state.run
    this.status.textContent =
      `Dealer ${run.shiftIndex}` +
      ` · Chips ${run.chips} · Score ${run.score} · Tokens ${run.tokens}`

    this.healthFill.style.width = `${Math.max(0, run.integrity)}%`
    this.healthLabel.textContent = `Dealer ${run.shiftIndex} health ${Math.max(0, run.integrity)}%`

    this.renderTable()
    this.message.textContent = this.buildMessage()

    setVisible(this.bettingGroup, this.state.phase === 'betting')
    setVisible(this.actionsGroup, this.state.phase === 'playing')
    setVisible(this.powerupsGroup, this.state.phase === 'playing')
    setVisible(this.continueGroup, this.state.phase === 'resolved')
    setVisible(this.gameoverGroup, this.state.phase === 'over')

    if (this.state.phase === 'betting') {
      this.updateBetControls()
    }
    if (this.state.phase === 'playing') {
      this.updateActions()
    }
    if (this.state.phase === 'over') {
      this.renderResume()
    }
  }

  private renderTable(): void {
    const round = this.state.round
    if (!round) {
      this.dealerHand.replaceChildren()
      this.dealerTotal.textContent = ''
      this.playerHands.replaceChildren()
      return
    }
    const reveal = this.state.phase !== 'playing' || this.state.peeked
    renderCards(this.dealerHand, round.dealer, reveal ? -1 : 1)
    this.dealerTotal.textContent = reveal ? String(evaluateHand(round.dealer).total) : ''
    this.renderPlayerHands(round)
  }

  private renderPlayerHands(round: Round): void {
    this.playerHands.replaceChildren()
    round.hands.forEach((hand, index) => {
      const wrap = document.createElement('div')
      wrap.className = 'phand'
      if (this.state.phase === 'playing' && index === round.activeIndex && !hand.finished) {
        wrap.classList.add('phand--active')
      }
      const meta = document.createElement('div')
      meta.className = 'phand__meta'
      const outcome = hand.outcome ? ` · ${hand.outcome}` : ''
      meta.textContent = `Bet ${hand.bet} · ${evaluateHand(hand.cards).total}${outcome}`
      const cards = document.createElement('div')
      cards.className = 'hand'
      renderCards(cards, hand.cards, -1)
      wrap.append(meta, cards)
      this.playerHands.appendChild(wrap)
    })
  }

  private updateBetControls(): void {
    const run = this.state.run
    const bet = nextBet(run)
    this.betHint.textContent = isLastCall(run) ? `Last call — all in (${bet})` : `Bet ${bet}`
  }

  private updateActions(): void {
    const round = this.state.round
    if (!round) {
      return
    }
    const run = this.state.run
    const exposure = round.hands.reduce((total, hand) => total + hand.bet, 0)
    const activeBet = round.hands[round.activeIndex].bet
    const canAffordExtra = run.chips >= exposure + activeBet

    this.doubleButton.disabled = !(canDouble(round) && canAffordExtra)
    this.splitButton.disabled = !(canSplit(round) && canAffordExtra)
    this.peekButton.disabled = !(run.tokens >= POWERUPS.peek.cost && !this.state.peeked)
    this.lateDoubleButton.disabled = !(run.tokens >= POWERUPS['late-double'].cost && canAffordExtra)
    this.secondChanceButton.disabled = !(run.tokens >= POWERUPS['second-chance'].cost && !round.secondChanceArmed)
    this.powerupHint.textContent = this.powerupHintText(round)
  }

  private powerupHintText(round: Round): string {
    const parts: string[] = []
    if (round.secondChanceArmed) {
      parts.push('Shield armed')
    }
    if (round.burned) {
      parts.push(`Burned: ${cardLabel(round.burned)}`)
    }
    return parts.join(' · ')
  }

  private renderResume(): void {
    const run = this.state.run
    this.resume.replaceChildren()
    const title = document.createElement('div')
    title.className = 'resume__title'
    title.textContent = run.won
      ? `You dismantled every dealer — final score ${run.score}`
      : `The house shuts you down — final score ${run.score}`
    this.resume.appendChild(title)
    run.kills.forEach((dealerIndex) => {
      const row = document.createElement('div')
      row.className = 'resume__row'
      row.textContent = `💥 destroyed — Dealer ${dealerIndex}`
      this.resume.appendChild(row)
    })
    if (!run.won) {
      const fell = document.createElement('div')
      fell.className = 'resume__row'
      fell.textContent = `☠️ fell to — Dealer ${run.shiftIndex}`
      this.resume.appendChild(fell)
    }
  }

  private buildMessage(): string {
    const round = this.state.round
    if (this.state.phase === 'betting') {
      return isLastCall(this.state.run) ? 'Last call — bet everything.' : 'Place your bet.'
    }
    if (this.state.phase === 'resolved' && round) {
      const net = payout(round)
      const label = net > 0 ? 'Win' : net < 0 ? 'Loss' : 'Push'
      return `${label} · ${net >= 0 ? '+' : ''}${net} chips`
    }
    return ''
  }

  private select<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector)
    if (!element) {
      throw new Error(`missing element ${selector}`)
    }
    return element
  }
}

function renderCards(container: HTMLElement, cards: Card[], hiddenIndex: number): void {
  container.replaceChildren()
  cards.forEach((card, index) => {
    container.appendChild(index === hiddenIndex ? hiddenCardElement() : cardElement(card))
  })
}

function cardElement(card: Card): HTMLElement {
  const element = document.createElement('span')
  element.className = 'card'
  element.textContent = cardLabel(card)
  if (card.suit === 'hearts' || card.suit === 'diamonds') {
    element.classList.add('card--red')
  }
  return element
}

function hiddenCardElement(): HTMLElement {
  const element = document.createElement('span')
  element.className = 'card card--hidden'
  element.textContent = '?'
  return element
}

function cardLabel(card: Card): string {
  return `${card.rank}${SUIT_SYMBOLS[card.suit]}`
}

function setVisible(group: HTMLElement, visible: boolean): void {
  group.style.display = visible ? 'flex' : 'none'
}

function generateSeed(): number {
  return Math.floor(Math.random() * 0x100000000)
}
