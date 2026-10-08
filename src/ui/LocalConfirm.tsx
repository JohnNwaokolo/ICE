import { useEffect, useRef, useState } from 'react'

type Request = {text: string; resolve: (approved: boolean) => void}
// Private dialog returned by the hook; this module intentionally exports only the hook.
// oxlint-disable-next-line react/only-export-components
function Prompt({request, answer}: {request: Request; answer: (approved: boolean) => void}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {dialog.current?.showModal()}, [])
  return <dialog ref={dialog} className="confirmation-card" onCancel={e => {e.preventDefault(); answer(false)}} aria-labelledby="local-confirm-title">
    <h2 id="local-confirm-title">Confirm this action</h2>
    <p style={{whiteSpace:'pre-wrap'}}>{request.text}</p>
    <div className="button-row"><button autoFocus onClick={() => answer(false)}>Cancel</button><button onClick={() => answer(true)}>Confirm</button></div>
  </dialog>
}
export function useLocalConfirm() {
  const [request, setRequest] = useState<Request | null>(null)
  const pending = useRef<Request | null>(null)
  useEffect(() => () => {pending.current?.resolve(false)}, [])
  const confirm = (text: string) => new Promise<boolean>(resolve => {
    pending.current?.resolve(false)
    const next = {text, resolve}; pending.current = next; setRequest(next)
  })
  const answer = (approved: boolean) => {pending.current?.resolve(approved); pending.current = null; setRequest(null)}
  return {confirm, confirmation: request ? <Prompt request={request} answer={answer} /> : null}
}
