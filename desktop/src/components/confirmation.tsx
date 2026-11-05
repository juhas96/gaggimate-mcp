import { useEffect, useRef, useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

export function useConfirmation() {
  const [message, setMessage] = useState<string | null>(null)
  const pending = useRef<((approved: boolean) => void) | undefined>(undefined)
  useEffect(() => () => pending.current?.(false), [])
  function resolve(approved: boolean) { pending.current?.(approved); pending.current = undefined; setMessage(null) }
  function confirm(text: string) {
    pending.current?.(false)
    const result = Promise.withResolvers<boolean>()
    pending.current = result.resolve; setMessage(text)
    return result.promise
  }
  const dialog = <AlertDialog open={message !== null} onOpenChange={open => { if (!open) resolve(false) }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Confirm this change</AlertDialogTitle><AlertDialogDescription className="whitespace-pre-wrap max-h-72 overflow-auto">{message}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel onClick={() => resolve(false)}>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => resolve(true)}>Confirm change</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  return { confirm, dialog }
}
