/** Upstream compatibility types. Direct cloud access is intentionally disabled. */
export type Msg = { role: 'user' | 'assistant'; content: string }
export type AskHandlers = { onText: (delta: string) => void; onTool: (name: string) => void }
export async function ask(): Promise<never> {
  throw new Error('Cloud providers are disabled. Start the local Ollama bridge.')
}
export function cancel() {}
export function connectedLabels(): string[] { return [] }
