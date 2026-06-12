import { type ReactNode, useState, useRef, useEffect } from 'react'
import { cn } from '@shared/utils'
export { Modal, ConfirmModal } from './Modal'
export { Card, CardHeader, CardTitle, CardContent, StatCard } from './Card'

interface BadgeProps {
  children: ReactNode; variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple'
  size?: 'sm' | 'md'; className?: string
}
export function Badge({ children, variant = 'default', size = 'sm', className }: BadgeProps) {
  const v = {
    default: 'bg-slate-100 text-slate-600', success: 'bg-emerald-100 text-emerald-700',
    warning: 'bg-amber-100 text-amber-700', danger: 'bg-red-100 text-red-700',
    info: 'bg-blue-100 text-blue-700', purple: 'bg-violet-100 text-violet-700',
  }
  const s = { sm: 'px-2 py-0.5 text-xs', md: 'px-2.5 py-1 text-sm' }
  return <span className={cn('inline-flex items-center rounded-full font-medium', v[variant], s[size], className)}>{children}</span>
}

interface Toast { id: string; type: 'success' | 'error' | 'info'; message: string }
let _addToast: ((t: Toast) => void) | null = null
export function toast(type: Toast['type'], message: string) {
  _addToast?.({ id: crypto.randomUUID(), type, message })
}
export function ToastProvider() {
  const [toasts, setToasts] = useState<Toast[]>([])
  useEffect(() => {
    _addToast = (t) => { setToasts(p => [...p, t]); setTimeout(() => setToasts(p => p.filter(x => x.id !== t.id)), 3500) }
    return () => { _addToast = null }
  }, [])
  const colors = { success: 'bg-emerald-600', error: 'bg-red-600', info: 'bg-blue-600' }
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(t => (
        <div key={t.id} className={cn('flex items-center gap-3 px-4 py-3 rounded-lg text-white text-sm shadow-lg animate-slide-up', colors[t.type])}>
          <span>{t.message}</span>
          <button onClick={() => setToasts(p => p.filter(x => x.id !== t.id))} className="opacity-70 hover:opacity-100 ml-1">×</button>
        </div>
      ))}
    </div>
  )
}

export function Dropdown({ trigger, children, align = 'right' }: { trigger: ReactNode; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(v => !v)}>{trigger}</div>
      {open && (
        <div className={cn('absolute top-full mt-1 z-40 bg-white rounded-xl border border-slate-200 shadow-lg py-1 min-w-[160px]', align === 'right' ? 'right-0' : 'left-0')}
          onClick={() => setOpen(false)}>{children}</div>
      )}
    </div>
  )
}

export function DropdownItem({ children, onClick, danger }: { children: ReactNode; onClick?: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn('w-full text-left px-4 py-2 text-sm transition-colors hover:bg-slate-50', danger ? 'text-red-600' : 'text-slate-700')}>
      {children}
    </button>
  )
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <span style={{ width: size, height: size }} className="border-2 border-slate-200 border-t-blue-600 rounded-full animate-spin inline-block" />
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mb-4"><span className="text-xl">💭</span></div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {description && <p className="text-sm text-slate-500 mt-1 max-w-xs">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
