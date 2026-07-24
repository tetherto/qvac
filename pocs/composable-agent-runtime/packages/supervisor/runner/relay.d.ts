import type { StowRunner } from '../stow.js'

// the app worklet's stow control sideband: named JSON messages, disambiguated per child by id
export interface RelayControl {
  send(type: string, payload: object): unknown
  on(type: string, listener: (message: { id: number; [key: string]: unknown }) => void): unknown
  off(type: string, listener: (message: { id: number; [key: string]: unknown }) => void): unknown
}

declare function relayRunner(control: RelayControl): StowRunner
export default relayRunner
