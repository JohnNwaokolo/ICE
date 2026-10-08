/** Every request stays on the authenticated local bridge. There is no paid fallback. */
export { ask, cancel, cancel as interrupt, connect as warm, watchConnection, watchConfirmation, answerConfirmation, isConnected } from './bridge'
export type { AskHandlers, Msg } from './anthropic'
export const usingBridge = true
